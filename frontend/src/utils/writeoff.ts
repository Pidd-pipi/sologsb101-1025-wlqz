/**
 * 锅次核销与方案占用的纯逻辑（不触碰 Dexie）。
 * 被 utils/db.ts 的迁移与动作函数、writeoffSlice 的派生选择器共同消费。
 *
 * 占用账规则：
 * - 每个锅次可占用剩余量 = 成品 - 留样 - 该锅次「占用中」累计；
 * - 方案成分按 ratioPct × batchG 切分计划产量；
 * - 杯测不过 / 锅次未核销或报废 / 无杯测 → 占用失效或待核销，不能占账；
 * - 杯测分数在认领之后被改动（cupping.updatedAt 晚于认领快照）→ 占用失效，需重新认领；
 * - 方案按创建时间先到先得，同方案对同一锅次的多行需求合并扣账，累计不超过剩余量。
 */
import type { Blend } from '../types/blend';
import type { GreenBean } from '../types/greenbean';
import type { RoastProfile } from '../types/roastprofile';
import type { Cupping } from '../types/cupping';
import {
  DEFAULT_BLEND_BATCH_G,
  occupiedWeightOf,
  roundGram,
  type OccupationState,
  type PotOccupation,
  type PotSettlement,
} from '../types/writeoff';

/** 失效 / 待核销原因集中维护，供页面提示复用 */
export const OCCUPATION_REASON = {
  NONE: '',
  SETTLEMENT_PENDING: '锅次尚未核销，先去登记成品/留样/损耗',
  SETTLEMENT_SCRAPPED: '锅次已报废，占用随之释放',
  SETTLEMENT_MISSING: '找不到锅次核销记录，停在待核销',
  NO_CUPPING: '该锅次还没有杯测记录，杯测通过后才能占用',
  CUPPING_FAILED: '杯测未通过（低于 80 分），不能占用',
  CUPPING_CHANGED: '杯测分数在认领后被改动，请重新确认认领',
  CAPACITY_EXCEEDED: '锅次剩余成品不足，累计占用已超剩余量',
  PROFILE_MISSING: '配方引用的烘焙记录已删除',
  BACKFILL_UNMATCHED: '旧数据补认：按豆源/机台/日期未能唯一认出锅次',
  BLEND_RETIRED: '方案已停用，占用释放',
} as const;

export interface WriteoffContext {
  blends: Blend[];
  profiles: RoastProfile[];
  beans: GreenBean[];
  cuppings: Cupping[];
  settlements: PotSettlement[];
}

/** 方案计划产量：未填或非法时取默认一锅 */
export function blendBatchOf(blend: Blend): number {
  return typeof blend.batchG === 'number' && Number.isFinite(blend.batchG) && blend.batchG > 0
    ? blend.batchG
    : DEFAULT_BLEND_BATCH_G;
}

/** 某锅次最新一笔杯测（按 updatedAt，其次 createdAt） */
export function latestCuppingOf(cuppings: Cupping[], profileId: string): Cupping | null {
  const related = cuppings.filter((cupping) => cupping.profileId === profileId);
  if (related.length === 0) return null;
  return related.reduce((acc, item) =>
    (item.updatedAt || item.createdAt) > (acc.updatedAt || acc.createdAt) ? item : acc,
  );
}

/**
 * 旧数据补认：按豆源 + 机台 + 日期（配方成分缺 profileId 时）。
 * - profileId 已填：直接按 id 找（找不到返回 null，调用方按「记录已删除」处理）；
 * - profileId 为空：豆源唯一命中（可叠加机台/日期线索）一条非作废锅次才认；
 * - 多条候选认不出，返回 null，停在待核销由人工指定。
 */
export function backfillProfileForItem(
  item: { greenBeanId: string; profileId: string },
  hint: { machineModel?: string; roastedAt?: string },
  profiles: RoastProfile[],
): RoastProfile | null {
  if (item.profileId) {
    return profiles.find((profile) => profile.id === item.profileId) ?? null;
  }
  const candidates = profiles.filter(
    (profile) =>
      profile.state !== 'void' &&
      profile.greenBeanId === item.greenBeanId &&
      (!hint.machineModel || profile.machineModel === hint.machineModel) &&
      (!hint.roastedAt || profile.roastedAt === hint.roastedAt),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

export interface OccupationEval {
  state: OccupationState;
  reason: string;
  cupCheckedAt: string | null;
  /** true：本行应参与锅次剩余量扣账 */
  holds: boolean;
  /** 扣账后该锅次剩余（克）；未扣账时为扣账前剩余 */
  remainingG: number;
  settlement?: PotSettlement;
}

export interface ClaimInput {
  blend: Blend;
  profileId: string;
  /** 该方案对该锅次的合并需求（克） */
  needG: number;
  /** 判定前锅次还剩多少可占用成品（克） */
  remainingBeforeG: number;
}

/**
 * 评估一个方案对单个锅次的合并需求能否占用。
 * @param prevHeld 上一轮账里该方案对该锅次的占用行（用于识别「杯测认领后被改动」）。
 */
export function evaluateProfileClaim(
  input: ClaimInput,
  context: Pick<WriteoffContext, 'profiles' | 'cuppings' | 'settlements'>,
  prevHeld?: PotOccupation,
): OccupationEval {
  const { blend, profileId, needG, remainingBeforeG } = input;
  const remaining = roundGram(remainingBeforeG);
  if (blend.state === 'retired') {
    return { state: 'released', reason: OCCUPATION_REASON.BLEND_RETIRED, cupCheckedAt: null, holds: false, remainingG: remaining };
  }
  const profile = context.profiles.find((item) => item.id === profileId);
  if (!profile) {
    return { state: 'pending', reason: OCCUPATION_REASON.PROFILE_MISSING, cupCheckedAt: null, holds: false, remainingG: remaining };
  }
  const settlement = context.settlements.find((item) => item.profileId === profileId);
  if (!settlement) {
    return { state: 'pending', reason: OCCUPATION_REASON.SETTLEMENT_MISSING, cupCheckedAt: null, holds: false, remainingG: remaining };
  }
  if (settlement.state === 'scrapped') {
    return { state: 'invalid', reason: OCCUPATION_REASON.SETTLEMENT_SCRAPPED, cupCheckedAt: null, holds: false, remainingG: remaining };
  }
  if (settlement.state !== 'verified') {
    return { state: 'pending', reason: OCCUPATION_REASON.SETTLEMENT_PENDING, cupCheckedAt: null, holds: false, remainingG: remaining };
  }

  const latest = latestCuppingOf(context.cuppings, profileId);
  if (!latest) {
    return { state: 'invalid', reason: OCCUPATION_REASON.NO_CUPPING, cupCheckedAt: null, holds: false, remainingG: remaining, settlement };
  }
  if (latest.totalScore < 80) {
    return { state: 'invalid', reason: OCCUPATION_REASON.CUPPING_FAILED, cupCheckedAt: null, holds: false, remainingG: remaining, settlement };
  }
  if (prevHeld && prevHeld.cupCheckedAt && latest.updatedAt > prevHeld.cupCheckedAt) {
    return {
      state: 'invalid',
      reason: OCCUPATION_REASON.CUPPING_CHANGED,
      cupCheckedAt: prevHeld.cupCheckedAt,
      holds: false,
      remainingG: remaining,
      settlement,
    };
  }
  if (remaining + 0.5 < needG) {
    return {
      state: 'invalid',
      reason: OCCUPATION_REASON.CAPACITY_EXCEEDED,
      cupCheckedAt: latest.updatedAt,
      holds: false,
      remainingG: remaining,
      settlement,
    };
  }
  return {
    state: 'held',
    reason: OCCUPATION_REASON.NONE,
    cupCheckedAt: latest.updatedAt,
    holds: true,
    remainingG: roundGram(remaining - needG),
    settlement,
  };
}

/** 占用行 id：方案 + 锅次 + 成分序号（保证重算幂等） */
export function occupationRowId(blendId: string, profileId: string, index: number): string {
  return `occ-${blendId}-${profileId || 'unknown'}-${index}`;
}

export interface RebuildOccupationResult {
  occupations: PotOccupation[];
  /** 因占用失效需要转为「待替换」的试配方案 id */
  pendingBlendIds: string[];
}

/**
 * 全量重算方案占用账。
 * 方案按 createdAt 先到先得；每个方案先按锅次合并需求，再逐锅判定，
 * held 的方案从该锅次剩余量中扣减；定版/停用方案状态不在此改动（定版只在页面提醒）。
 */
export function rebuildOccupations(ctx: WriteoffContext, previous: PotOccupation[] = []): RebuildOccupationResult {
  const now = new Date().toISOString();
  const pendingBlendIds: string[] = [];
  const rows: PotOccupation[] = [];

  // 每个锅次的剩余量账：成品 - 留样（初始），held 放行后逐笔扣减
  const remainingByProfile = new Map<string, number>();
  ctx.settlements.forEach((settlement) => {
    if (settlement.state === 'verified') {
      remainingByProfile.set(settlement.profileId, roundGram(settlement.productG - settlement.sampleG));
    }
  });

  const prevHeldOf = (blendId: string, profileId: string): PotOccupation | undefined =>
    previous.find((row) => row.blendId === blendId && row.profileId === profileId && row.state === 'held');

  ctx.blends
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .forEach((blend) => {
      // 先从有来源的成分收集同豆源的机台 / 日期补认线索
      const machineHints = new Map<string, Set<string>>();
      const dateHints = new Map<string, Set<string>>();
      blend.items.forEach((item) => {
        if (!item.profileId) return;
        const profile = ctx.profiles.find((row) => row.id === item.profileId);
        if (!profile) return;
        const machines = machineHints.get(item.greenBeanId) ?? new Set<string>();
        machines.add(profile.machineModel);
        machineHints.set(item.greenBeanId, machines);
        const dates = dateHints.get(item.greenBeanId) ?? new Set<string>();
        dates.add(profile.roastedAt);
        dateHints.set(item.greenBeanId, dates);
      });

      // 先补认每条成分的锅次，再按锅次合并需求
      const resolved = blend.items.map((item, index) => {
        let profile: RoastProfile | null;
        if (item.profileId) {
          profile = backfillProfileForItem(item, {}, ctx.profiles);
        } else {
          const machines = machineHints.get(item.greenBeanId);
          const dates = dateHints.get(item.greenBeanId);
          const hint: { machineModel?: string; roastedAt?: string } = {
            machineModel: machines && machines.size === 1 ? Array.from(machines)[0] : undefined,
            roastedAt: dates && dates.size === 1 ? Array.from(dates)[0] : undefined,
          };
          profile = backfillProfileForItem(item, hint, ctx.profiles);
        }
        return {
          item,
          index,
          needG: occupiedWeightOf(item.ratioPct, blendBatchOf(blend)),
          profileId: profile ? profile.id : '',
          profileMissing: Boolean(item.profileId) && !profile,
        };
      });
      const needByProfile = new Map<string, number>();
      resolved.forEach((entry) => {
        if (!entry.profileId) return;
        needByProfile.set(entry.profileId, roundGram((needByProfile.get(entry.profileId) ?? 0) + entry.needG));
      });

      const evalByProfile = new Map<string, OccupationEval>();
      needByProfile.forEach((needG, profileId) => {
        const decision = evaluateProfileClaim(
          { blend, profileId, needG, remainingBeforeG: remainingByProfile.get(profileId) ?? 0 },
          ctx,
          prevHeldOf(blend.id, profileId),
        );
        evalByProfile.set(profileId, decision);
        if (decision.holds) remainingByProfile.set(profileId, decision.remainingG);
      });

      let blendHasInvalid = false;
      resolved.forEach(({ item, index, needG, profileId, profileMissing }) => {
        const decision = profileId ? evalByProfile.get(profileId) : undefined;
        const profile = ctx.profiles.find((row) => row.id === profileId);
        const prev = previous.find((row) => row.id === occupationRowId(blend.id, profileId, index));
        let state: OccupationState;
        let reason: string;
        let cupCheckedAt: string | null = null;
        let holds = false;
        if (blend.state === 'retired') {
          state = 'released';
          reason = OCCUPATION_REASON.BLEND_RETIRED;
        } else if (decision) {
          state = decision.state;
          reason = decision.reason;
          cupCheckedAt = decision.cupCheckedAt;
          holds = decision.holds;
        } else if (profileMissing) {
          state = 'pending';
          reason = OCCUPATION_REASON.PROFILE_MISSING;
        } else {
          state = 'pending';
          reason = OCCUPATION_REASON.BACKFILL_UNMATCHED;
        }
        if (state === 'invalid') blendHasInvalid = true;
        rows.push({
          id: occupationRowId(blend.id, profileId, index),
          blendId: blend.id,
          blendName: blend.name,
          profileId,
          greenBeanId: item.greenBeanId,
          machineModel: profile?.machineModel ?? '',
          roastedAt: profile?.roastedAt ?? blend.createdAt,
          ratioPct: item.ratioPct,
          batchG: blendBatchOf(blend),
          occupiedG: holds ? needG : 0,
          state,
          reason,
          cupCheckedAt,
          backfilled: prev?.backfilled ?? (!item.profileId && Boolean(profileId)),
          createdAt: prev?.createdAt ?? now,
          updatedAt: now,
        });
      });

      // 试配方案只要有失效占用 → 转待替换；定版只在页面给提醒，不自动改状态
      if (blendHasInvalid && blend.state === 'trial' && !pendingBlendIds.includes(blend.id)) {
        pendingBlendIds.push(blend.id);
      }
    });

  return { occupations: rows, pendingBlendIds };
}

/**
 * 定版闸门：方案是否只用「已核销 + 杯测通过」的锅次，且全部占用在账、无超卖。
 * 返回阻塞原因列表（空数组即可定版）。
 */
export function finalizationBlockers(
  blend: Blend,
  occupations: PotOccupation[],
  cuppings: Cupping[],
): string[] {
  const blockers: string[] = [];
  const mine = occupations.filter((occupation) => occupation.blendId === blend.id);
  blend.items.forEach((item, index) => {
    const row =
      mine.find((occupation) => occupation.profileId === item.profileId) ?? mine[index];
    const latest = latestCuppingOf(cuppings, item.profileId);
    if (!latest) {
      blockers.push(`第 ${index + 1} 项成分的锅次还没有杯测记录`);
      return;
    }
    if (latest.totalScore < 80) {
      blockers.push(`第 ${index + 1} 项成分的锅次杯测 ${latest.totalScore} 分，未达 80 分通过线`);
    }
    if (!row || row.state !== 'held') {
      blockers.push(`第 ${index + 1} 项成分的锅次未完成核销占用（${row?.reason ?? OCCUPATION_REASON.SETTLEMENT_MISSING}）`);
    }
  });
  return blockers;
}
