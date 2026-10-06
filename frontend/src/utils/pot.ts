/**
 * 锅次核销 / 成品占用的纯领域逻辑（不碰 Dexie / Redux，可单测、可被迁移与各 thunk 复用）。
 *
 * 核心不变量：
 * 1. 只有「已核销（verified）且杯测通过（最新杯测 ≥ CUPPING_PASS_SCORE）」的锅次才能被方案生效占用；
 * 2. 同一口锅的生效占用累计 = 各方案按占比折算重量之和，不得超过「成品 - 留样」；
 * 3. 杯测分数改动 / 锅次报废后，试配方案占用失效（stale）并转「待替换」，已定版方案只保留提醒；
 * 4. 停用（retired）方案释放占用；定版方案优先占位，试配方案按创建时间先到先得。
 */
import type { Blend, BlendItem } from '../types/blend';
import { DEFAULT_TARGET_BATCH_KG, occupyKgOfItem } from '../types/blend';
import type { Cupping } from '../types/cupping';
import { CUPPING_PASS_SCORE, cuppingSignatureOf, isCuppingPassed, latestCuppingOf } from '../types/cupping';import type { RoastPot, PotAllocation } from '../types/pot';
import { activeAllocations, checkAllocationCapacity, roundKg3 } from '../types/pot';
import type { RoastProfile } from '../types/roastprofile';
import { isWithinDailyCapacity } from '../types/roastprofile';

/** 单个配方成分的占用评估结果 */
export interface ItemAllocationReport {
  greenBeanId: string;
  profileId: string;
  ratioPct: number;
  /** 折算占用重量（kg） */
  occupyKg: number;
  /** active：已生效占用；stale：失效待重认；none：还没能占用 */
  state: 'active' | 'stale' | 'none';
  reason: string;
  potStatus: RoastPot['status'] | 'missing';
  /** 该锅当前可占用剩余（kg，无锅次为 null） */
  availableKg: number | null;
  lastScore: number | null;
}

export interface BlendRebuildReport {
  blendId: string;
  state: Blend['state'];
  pendingReplace: boolean;
  /** 已定版方案的保留提醒（杯测改动 / 锅次异常），不改变定版状态 */
  reminders: string[];
  items: ItemAllocationReport[];
}

export interface RebuildResult {
  pots: RoastPot[];
  blends: Blend[];
  reports: Map<string, BlendRebuildReport>;
}

interface PotEvaluation {
  usable: boolean;
  reason: string;
  signatureChanged: boolean;
  lastScore: number | null;
  passed: boolean;
}

/** 某口锅当前是否可被生效占用，以及不可占用的原因 */
function evaluatePot(input: {
  pot: RoastPot | undefined;
  profile: RoastProfile | undefined;
  cuppings: Cupping[];
}): PotEvaluation {
  const { pot, profile, cuppings } = input;
  const latest = latestCuppingOf(cuppings);
  const lastScore = latest ? latest.totalScore : null;
  const passed = latest ? isCuppingPassed(latest.totalScore) : false;
  const currentSignature = cuppingSignatureOf(cuppings);
  const signatureChanged = !!pot && pot.cuppingSignature !== '' && pot.cuppingSignature !== currentSignature;

  if (!pot) {
    return { usable: false, reason: '没有锅次台账，请先完成烘焙并登记核销', signatureChanged: false, lastScore, passed };
  }
  if (!profile) {
    return { usable: false, reason: '关联烘焙记录已删除', signatureChanged, lastScore, passed };
  }
  if (profile.state === 'void' || pot.status === 'void') {
    return { usable: false, reason: '锅次已报废，旧占用失效', signatureChanged, lastScore, passed };
  }
  if (profile.state === 'recording') {
    return { usable: false, reason: '该锅次还在烘焙中，尚未下豆完成', signatureChanged, lastScore, passed };
  }
  if (pot.status === 'pending') {
    return { usable: false, reason: '锅次待核销：请先登记成品 / 留样 / 损耗', signatureChanged, lastScore, passed };
  }
  if (!latest) {
    return { usable: false, reason: '杯测未录入：杯测通过后占用才会生效', signatureChanged, lastScore, passed: false };
  }
  if (!passed) {
    return {
      usable: false,
      reason: signatureChanged
        ? `杯测分数改动为 ${lastScore} 分，未达通过线 ${CUPPING_PASS_SCORE} 分，旧占用失效`
        : `杯测 ${lastScore} 分未通过（需 ≥ ${CUPPING_PASS_SCORE} 分）`,
      signatureChanged,
      lastScore,
      passed,
    };
  }
  if (signatureChanged) {
    // 分数改动后即使仍通过，也要求占用失效重认（重认通过即恢复生效、不挂待替换）
    return {
      usable: true,
      reason: `杯测分数已改动（当前 ${lastScore} 分），占用已重新认领`,
      signatureChanged: true,
      lastScore,
      passed: true,
    };
  }
  return { usable: true, reason: '', signatureChanged, lastScore, passed: true };
}

function desireOf(blend: Blend): Array<{ item: BlendItem; occupyKg: number }> {
  const batch = Number.isFinite(blend.targetBatchKg) && blend.targetBatchKg > 0 ? blend.targetBatchKg : DEFAULT_TARGET_BATCH_KG;
  return blend.items.map((item) => ({ item, occupyKg: roundKg3(occupyKgOfItem(item, batch)) }));
}

/** 该锅除指定方案外的生效占用合计 */
function occupiedByOthers(pot: RoastPot, blendId: string): number {
  return roundKg3(
    activeAllocations(pot)
      .filter((allocation) => allocation.blendId !== blendId)
      .reduce((acc, allocation) => acc + allocation.occupyKg, 0),
  );
}

function potCapacity(pot: RoastPot): number {
  return roundKg3((pot.productKg || 0) - (pot.sampleKg || 0));
}

interface UpsertAllocationInput {
  pot: RoastPot;
  blend: Blend;
  item: BlendItem;
  occupyKg: number;
  state: PotAllocation['state'];
  reason: string;
  stamp: string;
}

function upsertAllocation(input: UpsertAllocationInput): void {
  const { pot, blend, item, occupyKg, state, reason, stamp } = input;
  const existing = pot.allocations.find(
    (allocation) => allocation.blendId === blend.id && allocation.profileId === item.profileId,
  );
  if (existing) {
    existing.occupyKg = occupyKg;
    existing.state = state;
    existing.staleReason = reason;
    existing.blendName = blend.name;
    existing.updatedAt = stamp;
    return;
  }
  pot.allocations.push({
    id: `pa-${blend.id}-${item.profileId}`,
    blendId: blend.id,
    blendName: blend.name,
    profileId: item.profileId,
    occupyKg,
    createdAt: stamp,
    updatedAt: stamp,
    state,
    staleReason: reason,
  });
}

/**
 * 依据当前 blends / pots / profiles / cuppings 全量重算占用。
 * 任何触发点（核销登记、杯测增删改、方案保存、状态流转、数据迁移）后调用，结果整体写回。
 */
export function rebuildAllocations(input: {
  blends: Blend[];
  pots: RoastPot[];
  profiles: RoastProfile[];
  cuppings: Cupping[];
  now?: string;
}): RebuildResult {
  const stamp = input.now ?? new Date().toISOString();
  const potMap = new Map<string, RoastPot>(input.pots.map((pot) => structuredClone(pot)).map((pot) => [pot.profileId, pot]));
  const profileMap = new Map(input.profiles.map((profile) => [profile.id, profile]));
  const cuppingsByProfile = new Map<string, Cupping[]>();
  input.cuppings.forEach((cupping) => {
    const list = cuppingsByProfile.get(cupping.profileId) ?? [];
    list.push(cupping);
    cuppingsByProfile.set(cupping.profileId, list);
  });

  const evaluationCache = new Map<string, PotEvaluation>();
  const evalOf = (profileId: string): PotEvaluation => {
    const cached = evaluationCache.get(profileId);
    if (cached) return cached;
    const evalResult = evaluatePot({
      pot: potMap.get(profileId),
      profile: profileMap.get(profileId),
      cuppings: cuppingsByProfile.get(profileId) ?? [],
    });
    evaluationCache.set(profileId, evalResult);
    return evalResult;
  };

  const blends = input.blends.map((blend) => ({ ...blend, items: blend.items.map((item) => ({ ...item })) }));
  const reports = new Map<string, BlendRebuildReport>();

  // 1) 停用方案：释放全部占用；已删除方案的残留占用一并清掉
  const liveBlendIds = new Set(blends.map((blend) => blend.id));
  potMap.forEach((pot) => {
    pot.allocations = pot.allocations.filter((allocation) => liveBlendIds.has(allocation.blendId));
  });
  blends
    .filter((blend) => blend.state === 'retired')
    .forEach((blend) => {
      potMap.forEach((pot) => {
        pot.allocations = pot.allocations.filter((allocation) => allocation.blendId !== blend.id);
      });
      reports.set(blend.id, {
        blendId: blend.id,
        state: blend.state,
        pendingReplace: false,
        reminders: [],
        items: [],
      });
    });

  const settleBlend = (blend: Blend, options: { finalized: boolean }): void => {
    const desired = desireOf(blend);
    const desiredProfileIds = new Set(desired.map(({ item }) => item.profileId));
    // 配方里已删除的成分：清理旧占用
    potMap.forEach((pot) => {
      if (desiredProfileIds.size === 0) {
        pot.allocations = pot.allocations.filter((allocation) => allocation.blendId !== blend.id);
        return;
      }
      pot.allocations = pot.allocations.filter(
        (allocation) => allocation.blendId !== blend.id || desiredProfileIds.has(allocation.profileId),
      );
    });

    const itemReports: ItemAllocationReport[] = [];
    const reminders: string[] = [];
    let pendingReplace = false;

    desired.forEach(({ item, occupyKg }) => {
      const pot = potMap.get(item.profileId);
      const evaluation = evalOf(item.profileId);

      if (evaluation.usable && pot) {
        const others = occupiedByOthers(pot, blend.id);
        const capacity = roundKg3(potCapacity(pot) - others);
        // 杯测分数改动后：试配方案先挂失效待重认（转待替换），需人工重新认领；定版方案只留提醒
        if (!options.finalized && evaluation.signatureChanged) {
          upsertAllocation({
            pot,
            blend,
            item,
            occupyKg,
            state: 'stale',
            reason: evaluation.reason || '杯测分数已改动，占用失效待重认',
            stamp,
          });
          pendingReplace = true;
          itemReports.push({
            ...item,
            occupyKg,
            state: 'stale',
            reason: evaluation.reason || '杯测分数已改动，占用失效待重认',
            potStatus: pot.status,
            availableKg: roundKg3(capacity),
            lastScore: evaluation.lastScore,
          });
          return;
        }
        if (occupyKg <= capacity + 1e-6) {
          upsertAllocation({ pot, blend, item, occupyKg, state: 'active', reason: '', stamp });
          itemReports.push({
            ...item,
            occupyKg,
            state: 'active',
            reason: '',
            potStatus: pot.status,
            availableKg: roundKg3(capacity - occupyKg),
            lastScore: evaluation.lastScore,
          });
          if (options.finalized && evaluation.signatureChanged) {
            reminders.push(`成分锅次（${item.profileId}）杯测分数已改动，当前 ${evaluation.lastScore} 分仍通过，请复核定版风味`);
          }
          return;
        }
        // 容量不足
        const reason = `成品剩余不足：本成分需 ${occupyKg}kg，该锅仅剩 ${Math.max(capacity, 0)}kg`;
        if (options.finalized) {
          // 定版方案历史占用保留并提醒（不强制下线）
          upsertAllocation({ pot, blend, item, occupyKg, state: 'active', reason: `提醒：${reason}`, stamp });
          reminders.push(reason);
          itemReports.push({
            ...item,
            occupyKg,
            state: 'active',
            reason: `提醒：${reason}`,
            potStatus: pot.status,
            availableKg: Math.max(capacity, 0),
            lastScore: evaluation.lastScore,
          });
          return;
        }
        upsertAllocation({ pot, blend, item, occupyKg, state: 'stale', reason, stamp });
        pendingReplace = true;
        itemReports.push({
          ...item,
          occupyKg,
          state: 'stale',
          reason,
          potStatus: pot.status,
          availableKg: Math.max(capacity, 0),
          lastScore: evaluation.lastScore,
        });
        return;
      }

      // 锅次不可用
      const reason = evaluation.reason;
      if (pot) {
        upsertAllocation({ pot, blend, item, occupyKg, state: 'stale', reason: options.finalized ? `提醒：${reason}` : reason, stamp });
      }
      if (options.finalized) {
        reminders.push(reason);
        itemReports.push({
          ...item,
          occupyKg,
          state: pot ? 'stale' : 'none',
          reason: `提醒：${reason}`,
          potStatus: pot?.status ?? 'missing',
          availableKg: pot ? roundKg3(Math.max(potCapacity(pot) - occupiedByOthers(pot, blend.id), 0)) : null,
          lastScore: evaluation.lastScore,
        });
      } else {
        pendingReplace = true;
        itemReports.push({
          ...item,
          occupyKg,
          state: pot ? 'stale' : 'none',
          reason,
          potStatus: pot?.status ?? 'missing',
          availableKg: pot ? roundKg3(Math.max(potCapacity(pot) - occupiedByOthers(pot, blend.id), 0)) : null,
          lastScore: evaluation.lastScore,
        });
      }
    });

    // 试配方案：任一成分未生效即「待替换」；全部生效则解除。已定版方案不挂待替换，只留提醒。
    blend.pendingReplace = options.finalized ? false : pendingReplace;
    reports.set(blend.id, {
      blendId: blend.id,
      state: blend.state,
      pendingReplace: blend.pendingReplace,
      reminders,
      items: itemReports,
    });
  };

  // 2) 已定版方案优先占位（历史定版不因后续争抢被挤掉，只给提醒）
  blends
    .filter((blend) => blend.state === 'final')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .forEach((blend) => settleBlend(blend, { finalized: true }));

  // 3) 试配方案按创建时间先到先得
  blends
    .filter((blend) => blend.state === 'trial')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .forEach((blend) => settleBlend(blend, { finalized: false }));

  // 4) 回写每口锅的杯测签名与最新分（下一轮据此识别「分数改动」）
  potMap.forEach((pot) => {
    const cuppings = cuppingsByProfile.get(pot.profileId) ?? [];
    pot.cuppingSignature = cuppingSignatureOf(cuppings);
    const latest = latestCuppingOf(cuppings);
    pot.lastScore = latest ? latest.totalScore : null;
    pot.allocations.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    pot.updatedAt = stamp;
  });

  return { pots: Array.from(potMap.values()), blends, reports };
}

/* ------------------------------ 定版校验 ------------------------------ */

export interface FinalizeCheckResult {
  ok: boolean;
  messages: string[];
}

/**
 * 定版门槛：每个配方成分都必须存在
 * 「已核销 + 杯测通过（≥ CUPPING_PASS_SCORE）」的锅次，且该成分占用在该锅生效中。
 */
export function checkBlendFinalizable(input: {
  blend: Blend;
  pots: RoastPot[];
  profiles: RoastProfile[];
  cuppings: Cupping[];
}): FinalizeCheckResult {
  const { blend, pots, profiles, cuppings } = input;
  const rebuild = rebuildAllocations({ blends: [blend], pots, profiles, cuppings, now: ':check:' });
  const report = rebuild.reports.get(blend.id);
  const messages: string[] = [];
  if (!report || report.items.length === 0) {
    return { ok: false, messages: ['方案没有配方成分，无法定版'] };
  }
  report.items.forEach((item, index) => {
    if (item.state !== 'active') {
      messages.push(`第 ${index + 1} 项（占比 ${item.ratioPct}%）：${item.reason || '锅次占用未生效'}`);
    }
  });
  return { ok: messages.length === 0, messages };
}

/* --------------------------- 旧数据锅次补认 --------------------------- */

export interface RecognizeResult {
  /** 补认后（可能改写了 profileId）的方案 */
  blends: Blend[];
  /** 每个方案的补认说明 */
  notes: Map<string, string[]>;
}

/**
 * 旧数据里「无锅次来源」的配方成分（profileId 在烘焙记录中不存在），
 * 按豆源 + 烘焙日期（同一豆源同一天只有一机台一锅时唯一命中）补认；
 * 认不出来（0 锅 / 同豆源同日多机台多锅）保持原样，留给待核销 / 待替换流程。
 */
export function recognizeLegacyBlendItems(input: { blends: Blend[]; profiles: RoastProfile[] }): RecognizeResult {
  const { blends, profiles } = input;
  const notes = new Map<string, string[]>();
  const next = blends.map((blend) => {
    const blendNotes: string[] = [];
    const items = blend.items.map((item) => {
      if (item.profileId && profiles.some((profile) => profile.id === item.profileId)) return item;
      const candidates = profiles.filter(
        (profile) => profile.greenBeanId === item.greenBeanId && profile.roastedAt === blend.createdAt,
      );
      if (candidates.length === 1) {
        const recognized = candidates[0];
        blendNotes.push(
          `成分（占比 ${item.ratioPct}%）已按豆源 + 日期补认到 ${recognized.roastedAt} · ${recognized.machineModel} 锅次`,
        );
        return { ...item, profileId: recognized.id };
      }
      if (candidates.length === 0) {
        blendNotes.push(`成分（占比 ${item.ratioPct}%）按豆源 + 日期找不到任何锅次，先停在待核销流程人工确认`);
      } else {
        blendNotes.push(
          `成分（占比 ${item.ratioPct}%）同豆源同日期命中 ${candidates.length} 口锅（机台不唯一），无法自动补认`,
        );
      }
      return item;
    });
    if (blendNotes.length > 0) notes.set(blend.id, blendNotes);
    return { ...blend, items };
  });
  return { blends: next, notes };
}

/* --------------------------- 占用失效后重新认领 --------------------------- */

export interface ReconfirmResult {
  ok: boolean;
  messages: string[];
}

/**
 * 杯测分数改动 / 锅次异常导致占用失效后，试配方案显式「重新认领」：
 * 逐项检查锅次已核销、杯测通过且容量足够，全部满足才把 stale 占用恢复为 active、
 * 解除待替换；任一项不满足则整体不恢复并返回原因。
 */
export function reconfirmBlendAllocations(input: {
  blend: Blend;
  pots: RoastPot[];
  profiles: RoastProfile[];
  cuppings: Cupping[];
  now?: string;
}): { blend: Blend; pots: RoastPot[]; result: ReconfirmResult } {
  const stamp = input.now ?? new Date().toISOString();
  const potMap = new Map<string, RoastPot>(input.pots.map((pot) => structuredClone(pot)).map((pot) => [pot.profileId, pot]));
  const profileMap = new Map(input.profiles.map((profile) => [profile.id, profile]));
  const cuppingsByProfile = new Map<string, Cupping[]>();
  input.cuppings.forEach((cupping) => {
    const list = cuppingsByProfile.get(cupping.profileId) ?? [];
    list.push(cupping);
    cuppingsByProfile.set(cupping.profileId, list);
  });

  const blend: Blend = { ...input.blend, items: input.blend.items.map((item) => ({ ...item })) };
  const desired = desireOf(blend);
  const messages: string[] = [];

  desired.forEach(({ item, occupyKg }, index) => {
    const pot = potMap.get(item.profileId);
    const evaluation = evaluatePot({
      pot,
      profile: profileMap.get(item.profileId),
      cuppings: cuppingsByProfile.get(item.profileId) ?? [],
    });
    if (!pot || !evaluation.usable) {
      messages.push(`第 ${index + 1} 项（占比 ${item.ratioPct}%）：${evaluation.reason || '锅次不可用'}`);
      return;
    }
    // 容量按「除本方案外的生效占用」计算，复用统一的占用上限校验
    const capacityCheck = checkAllocationCapacity(pot, occupyKg, blend.id);
    if (!capacityCheck.ok) {
      messages.push(`第 ${index + 1} 项（占比 ${item.ratioPct}%）：${capacityCheck.message}`);
    }
  });

  if (messages.length > 0) {
    return { blend, pots: Array.from(potMap.values()), result: { ok: false, messages } };
  }

  // 全部通过：恢复本方案的失效占用为生效，并把锅次杯测签名刷新到当前值
  // （否则下轮对账会把旧签名再次判定为「杯测已改动」）
  desired.forEach(({ item, occupyKg }) => {
    const pot = potMap.get(item.profileId);
    if (!pot) return;
    const existing = pot.allocations.find((allocation) => allocation.blendId === blend.id);
    if (existing) {
      existing.state = 'active';
      existing.occupyKg = occupyKg;
      existing.staleReason = '';
      existing.updatedAt = stamp;
    } else {
      pot.allocations.push({
        id: `pa-${blend.id}-${item.profileId}`,
        blendId: blend.id,
        blendName: blend.name,
        profileId: item.profileId,
        occupyKg,
        createdAt: stamp,
        updatedAt: stamp,
        state: 'active',
        staleReason: '',
      });
    }
    const potCuppings = cuppingsByProfile.get(item.profileId) ?? [];
    pot.cuppingSignature = cuppingSignatureOf(potCuppings);
    pot.lastScore = latestCuppingOf(potCuppings)?.totalScore ?? null;
    pot.updatedAt = stamp;
  });
  blend.pendingReplace = false;
  return { blend, pots: Array.from(potMap.values()), result: { ok: true, messages: [] } };
}

/* ------------------------------ 容量统计 ------------------------------ */

/** 某机台某天已排产（scheduled 且未作废）载量合计（克） */
export function scheduledChargeOfDay(profiles: RoastProfile[], machineModel: string, roastedAt: string): number {
  return profiles
    .filter(
      (profile) =>
        profile.machineModel === machineModel &&
        profile.roastedAt === roastedAt &&
        profile.scheduleStatus === 'scheduled' &&
        profile.state !== 'void',
    )
    .reduce((acc, profile) => acc + profile.chargeG, 0);
}

/**
 * 机台当天容量不足时给新批次排队：返回 scheduleStatus 与 queueOrder。
 * capacityG 为空 / 0 表示不限量。
 */
export function decideSchedule(input: {
  profiles: RoastProfile[];
  machineModel: string;
  roastedAt: string;
  chargeG: number;
  capacityG: number | null | undefined;
  selfId?: string;
}): { scheduleStatus: 'scheduled' | 'queued'; queueOrder: number; remainingG: number | null } {
  const capacity = input.capacityG ?? 0;
  const total = scheduledChargeOfDay(
    input.profiles.filter((profile) => profile.id !== input.selfId),
    input.machineModel,
    input.roastedAt,
  );
  if (!Number.isFinite(capacity) || capacity <= 0) {
    return { scheduleStatus: 'scheduled', queueOrder: 0, remainingG: null };
  }
  if (
    isWithinDailyCapacity({
      dailyCapacityG: capacity,
      scheduledChargeTotalG: total,
      additionalG: input.chargeG,
    })
  ) {
    return { scheduleStatus: 'scheduled', queueOrder: 0, remainingG: Math.round((capacity - total - input.chargeG) * 100) / 100 };
  }
  const order =
    input.profiles
      .filter((profile) => profile.machineModel === input.machineModel && profile.roastedAt === input.roastedAt)
      .reduce((max, profile) => Math.max(max, profile.queueOrder || 0), 0) + 1;
  return { scheduleStatus: 'queued', queueOrder: order, remainingG: Math.max(0, capacity - total) };
}

/**
 * 容量释放后按排队顺序递补：返回应转为 scheduled 的排队记录（载量能装下才递补，装不下继续等）。
 */
export function admitQueuedProfiles(input: {
  profiles: RoastProfile[];
  capacityByModel: Map<string, number | null>;
}): Array<{ id: string; machineModel: string; roastedAt: string }> {
  const groups = new Map<string, RoastProfile[]>();
  input.profiles
    .filter((profile) => profile.scheduleStatus === 'queued' && profile.state !== 'void')
    .sort((a, b) => (a.queueOrder || 0) - (b.queueOrder || 0) || a.createdAt.localeCompare(b.createdAt))
    .forEach((profile) => {
      const key = `${profile.machineModel}@${profile.roastedAt}`;
      const list = groups.get(key) ?? [];
      list.push(profile);
      groups.set(key, list);
    });

  const admitted: Array<{ id: string; machineModel: string; roastedAt: string }> = [];
  groups.forEach((queued, key) => {
    const [machineModel, roastedAt] = key.split('@');
    const capacity = input.capacityByModel.get(machineModel) ?? null;
    if (capacity === null || !(capacity > 0)) {
      queued.forEach((profile) => admitted.push({ id: profile.id, machineModel, roastedAt }));
      return;
    }
    let used = scheduledChargeOfDay(
      input.profiles.filter((profile) => !admitted.some((item) => item.id === profile.id)),
      machineModel,
      roastedAt,
    );
    queued.forEach((profile) => {
      if (used + profile.chargeG <= capacity + 1e-6) {
        admitted.push({ id: profile.id, machineModel, roastedAt });
        used += profile.chargeG;
      }
    });
  });
  return admitted;
}
