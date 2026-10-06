/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbroastlog，数据结构版本号 DB_VERSION = 3
 *   （v1 初版 / v2 时间戳与模板迁移 / v3 锅次核销、成品占用与机台日容量排队）
 * - 生豆 / 烘焙记录 / 曲线事件 / 杯测 / 拼配方案 / 锅次台账 / 载量模板 分表存储
 * - 首屏自动播种演示数据（父→子→孙三层贯通，幂等）
 * - 整库快照导出导入、级联删除、下豆扣减生豆在库重量
 * 纯前端应用：不依赖任何后端或数据库服务。
 */
import Dexie, { type Table } from 'dexie';
import type { GreenBean } from '../types/greenbean';
import { LOW_STOCK_KG } from '../types/greenbean';
import type { MachineTemplate, RoastProfile, RoastState, ScheduleStatus } from '../types/roastprofile';
import { ROAST_STATE_LABEL } from '../types/roastprofile';
import type { RoastEvent } from '../types/event';
import type { Cupping } from '../types/cupping';
import { cuppingSignatureOf, latestCuppingOf, weightedTotalScore } from '../types/cupping';
import type { Blend } from '../types/blend';
import { DEFAULT_TARGET_BATCH_KG } from '../types/blend';
import type { RoastPot } from '../types/pot';
import { checkPotWeights } from '../types/pot';
import { rorPerMinBetween } from './curve';
import {
  admitQueuedProfiles,
  decideSchedule,
  rebuildAllocations,
  recognizeLegacyBlendItems,
  reconfirmBlendAllocations,
} from './pot';

/** 数据库名（= 项目英文短名） */
export const DB_NAME = 'gbroastlog';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_VERSION = 3;

class RoastLogDatabase extends Dexie {
  greenBeans!: Table<GreenBean, string>;
  roastProfiles!: Table<RoastProfile, string>;
  events!: Table<RoastEvent, string>;
  cuppings!: Table<Cupping, string>;
  blends!: Table<Blend, string>;
  machineTemplates!: Table<MachineTemplate, string>;
  roastPots!: Table<RoastPot, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（仅业务字段，保留历史数据）
    this.version(1).stores({
      greenBeans: 'id, origin, process, arrivedAt, createdAt',
      roastProfiles: 'id, greenBeanId, machineModel, roastedAt, state',
      events: 'id, profileId, type, atSec',
      cuppings: 'id, profileId, cuppedAt',
      blends: 'id, name, state, createdAt',
    });

    // v2：补齐 createdAt/updatedAt 索引；新增载量模板表；按时间顺序补算历史 RoR 与杯测总分
    this.version(2)
      .stores({
        greenBeans: 'id, origin, process, arrivedAt, createdAt, updatedAt',
        roastProfiles: 'id, greenBeanId, machineModel, roastedAt, state, updatedAt',
        events: 'id, profileId, type, atSec, createdAt, updatedAt',
        cuppings: 'id, profileId, cuppedAt, totalScore, updatedAt',
        blends: 'id, name, state, createdAt, updatedAt',
        machineTemplates: 'id, model, chargeG, gasLevel',
      })
      .upgrade(async (tx) => {
        const stamp = nowIso();

        // 1) 全部表补齐 createdAt / updatedAt（v1 只写了业务字段）
        const tables: Array<Table<Record<string, unknown>, string>> = [
          tx.table('greenBeans'),
          tx.table('roastProfiles'),
          tx.table('events'),
          tx.table('cuppings'),
          tx.table('blends'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            if (typeof row.createdAt !== 'string' || row.createdAt === '') row.createdAt = stamp;
            if (typeof row.updatedAt !== 'string' || row.updatedAt === '') row.updatedAt = row.createdAt;
          });
        }

        // 2) 生豆：兜底处理法、含水率与在库重量
        await tx.table('greenBeans').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.process !== 'string') row.process = 'washed';
          if (typeof row.moisturePct !== 'number') row.moisturePct = 11;
          if (typeof row.stockKg !== 'number' || !Number.isFinite(row.stockKg)) row.stockKg = 0;
        });

        // 3) 烘焙记录：兜底状态、风门与火力档
        await tx.table('roastProfiles').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.state !== 'string') row.state = 'recording';
          if (typeof row.airflow !== 'string') row.airflow = 'half';
          if (typeof row.gasLevel !== 'number') row.gasLevel = 3;
        });

        // 4) 曲线事件：按 profileId 分组、按时间升序补算缺失的 RoR，并补齐备注
        const eventRows = (await tx.table('events').toArray()) as Array<Record<string, unknown>>;
        const grouped = new Map<string, Array<Record<string, unknown>>>();
        eventRows.forEach((row) => {
          const profileId = typeof row.profileId === 'string' ? row.profileId : '';
          const list = grouped.get(profileId) ?? [];
          list.push(row);
          grouped.set(profileId, list);
        });
        const migratedEvents: Array<Record<string, unknown>> = [];
        grouped.forEach((list) => {
          list.sort((a, b) => Number(a.atSec ?? 0) - Number(b.atSec ?? 0));
          list.forEach((row, index) => {
            const prev = list[index - 1];
            if ((typeof row.rorPerMin !== 'number' || row.rorPerMin === 0) && prev) {
              row.rorPerMin = rorPerMinBetween(
                Number(prev.atSec ?? 0),
                Number(prev.beanTempC ?? 0),
                Number(row.atSec ?? 0),
                Number(row.beanTempC ?? 0),
              );
            }
            if (typeof row.rorPerMin !== 'number') row.rorPerMin = 0;
            if (typeof row.note !== 'string') row.note = '';
            migratedEvents.push(row);
          });
        });
        if (migratedEvents.length > 0) {
          await tx.table('events').bulkPut(migratedEvents);
        }

        // 5) 杯测：按分项加权补算历史总分
        await tx.table('cuppings').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.totalScore !== 'number' || row.totalScore <= 0) {
            row.totalScore = weightedTotalScore({
              dryAroma: Number(row.dryAroma ?? 0),
              wetAroma: Number(row.wetAroma ?? 0),
              acidity: Number(row.acidity ?? 0),
              sweetness: Number(row.sweetness ?? 0),
              aftertaste: Number(row.aftertaste ?? 0),
            });
          }
        });

        // 6) 拼配方案：兜底配方明细与状态
        await tx.table('blends').toCollection().modify((row: Record<string, unknown>) => {
          if (!Array.isArray(row.items)) row.items = [];
          if (typeof row.state !== 'string') row.state = 'trial';
          if (typeof row.targetFlavor !== 'string') row.targetFlavor = '';
        });
      });

    // v3：锅次核销台账 roastPots；烘焙记录补排产字段、载量模板补当天容量、拼配方案补目标批量/待替换；
    // 旧锅次按已完成烘焙记录补建（待核销），旧方案无锅次来源时按豆源+日期补认
    this.version(DB_VERSION)
      .stores({
        greenBeans: 'id, origin, process, arrivedAt, createdAt, updatedAt',
        roastProfiles: 'id, greenBeanId, machineModel, roastedAt, state, scheduleStatus, updatedAt',
        events: 'id, profileId, type, atSec, createdAt, updatedAt',
        cuppings: 'id, profileId, cuppedAt, totalScore, updatedAt',
        blends: 'id, name, state, createdAt, updatedAt',
        machineTemplates: 'id, model, chargeG, gasLevel',
        roastPots: 'id, profileId, greenBeanId, machineModel, roastedAt, status',
      })
      .upgrade(async (tx) => {
        const stamp = nowIso();

        // 1) 烘焙记录补排产字段；载量模板补当天容量
        await tx.table('roastProfiles').toCollection().modify((row: Record<string, unknown>) => {
          if (row.scheduleStatus !== 'scheduled' && row.scheduleStatus !== 'queued') row.scheduleStatus = 'scheduled';
          if (typeof row.queueOrder !== 'number') row.queueOrder = 0;
        });
        await tx.table('machineTemplates').toCollection().modify((row: Record<string, unknown>) => {
          if (row.dailyCapacityG === undefined) row.dailyCapacityG = null;
        });

        // 2) 拼配方案补目标批量 / 待替换标记
        await tx.table('blends').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.targetBatchKg !== 'number' || !Number.isFinite(row.targetBatchKg) || row.targetBatchKg <= 0) {
            row.targetBatchKg = DEFAULT_TARGET_BATCH_KG;
          }
          if (typeof row.pendingReplace !== 'boolean') row.pendingReplace = false;
        });

        const profiles = (await tx.table('roastProfiles').toArray()) as unknown as RoastProfile[];
        const cuppings = (await tx.table('cuppings').toArray()) as unknown as Cupping[];
        const cuppingsByProfile = new Map<string, Cupping[]>();
        cuppings.forEach((cupping) => {
          const list = cuppingsByProfile.get(cupping.profileId) ?? [];
          list.push(cupping);
          cuppingsByProfile.set(cupping.profileId, list);
        });

        // 3) 已完成 / 作废的历史烘焙记录补建锅次台账（默认待核销；作废记录直接报废）
        const existingPots = new Set(
          ((await tx.table('roastPots').toArray()) as Array<{ profileId?: string }>).map((pot) => pot.profileId),
        );
        const legacyPots: RoastPot[] = [];
        profiles.forEach((profile) => {
          if (existingPots.has(profile.id)) return;
          if (profile.state === 'recording') return;
          const potCuppings = cuppingsByProfile.get(profile.id) ?? [];
          const isVoid = profile.state === 'void';
          legacyPots.push({
            id: `pot-${profile.id}`,
            profileId: profile.id,
            greenBeanId: profile.greenBeanId,
            machineModel: profile.machineModel,
            roastedAt: profile.roastedAt,
            chargeKg: roundKg(profile.chargeG / 1000),
            productKg: 0,
            sampleKg: 0,
            lossKg: 0,
            status: isVoid ? 'void' : 'pending',
            allocations: [],
            cuppingSignature: cuppingSignatureOf(potCuppings),
            lastScore: (latestCuppingOf(potCuppings)?.totalScore as number | undefined) ?? null,
            note: isVoid ? '历史作废锅次，迁移时补建' : '历史锅次迁移补建，待登记成品/留样/损耗',
            createdAt: stamp,
            updatedAt: stamp,
          });
        });
        if (legacyPots.length > 0) await tx.table('roastPots').bulkPut(legacyPots);

        // 4) 旧数据：配方成分缺锅次来源时，按豆源 + 烘焙日期补认（认不出先停在待核销）
        const legacyBlends = (await tx.table('blends').toArray()) as unknown as Blend[];
        const recognized = recognizeLegacyBlendItems({ blends: legacyBlends, profiles });
        const touched = recognized.blends.filter((blend, index) => blend !== legacyBlends[index]);
        if (touched.length > 0) await tx.table('blends').bulkPut(touched);

        // 5) 按当前数据重算一次占用（旧方案没有历史占用，不满足条件的试配方案转待替换）
        const pots = (await tx.table('roastPots').toArray()) as unknown as RoastPot[];
        const rebuild = rebuildAllocations({ blends: recognized.blends, pots, profiles, cuppings, now: stamp });
        await tx.table('roastPots').bulkPut(rebuild.pots);
        await tx.table('blends').bulkPut(rebuild.blends);
      });
  }
}

export const db = new RoastLogDatabase();

/* ------------------------------ 通用工具 ------------------------------ */

/** 生成带前缀的主键 id */
export function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 当前时间 ISO 字符串 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 保留三位小数的重量换算 */
export function roundKg(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/* --------------------------- 生豆 GreenBean --------------------------- */

export async function listGreenBeans(): Promise<GreenBean[]> {
  const rows = await db.greenBeans.toArray();
  return rows.sort((a, b) => b.arrivedAt.localeCompare(a.arrivedAt) || a.origin.localeCompare(b.origin, 'zh-Hans-CN'));
}

export async function getGreenBean(id: string): Promise<GreenBean | undefined> {
  return db.greenBeans.get(id);
}

export async function putGreenBean(row: GreenBean): Promise<void> {
  await db.greenBeans.put(row);
}

/** 删除生豆：级联删除其烘焙记录、曲线事件、杯测，并从拼配配方中摘除相关成分 */
export async function removeGreenBean(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.greenBeans, db.roastProfiles, db.events, db.cuppings, db.blends, db.roastPots],
    async () => {
      const profiles = await db.roastProfiles.where('greenBeanId').equals(id).toArray();
      const profileIds = profiles.map((profile) => profile.id);
      if (profileIds.length > 0) {
        await db.events.where('profileId').anyOf(profileIds).delete();
        await db.cuppings.where('profileId').anyOf(profileIds).delete();
        await db.roastProfiles.bulkDelete(profileIds);
        // 锅次台账保留（标记报废，占用后续对账失效），留下豆源/机台/日期痕迹
        const pots = await db.roastPots.where('profileId').anyOf(profileIds).toArray();
        const stamp = nowIso();
        await db.roastPots.bulkPut(
          pots.map((pot) => ({
            ...pot,
            status: 'void',
            note: `关联生豆已删除：${pot.greenBeanId}`,
            updatedAt: stamp,
          })),
        );
      }
      const blends = await db.blends.toArray();
      const stamp = nowIso();
      const affected = blends
        .map((blend) => {
          const items = blend.items.filter((item) => item.greenBeanId !== id && !profileIds.includes(item.profileId));
          return items.length === blend.items.length ? null : { ...blend, items, updatedAt: stamp };
        })
        .filter((blend): blend is Blend => blend !== null);
      if (affected.length > 0) await db.blends.bulkPut(affected);
      await db.greenBeans.delete(id);
    },
  );
  await reconcileAllocationsNow();
}

/* ------------------------ 烘焙记录 RoastProfile ------------------------ */

export async function listRoastProfiles(): Promise<RoastProfile[]> {
  const rows = await db.roastProfiles.toArray();
  return rows.sort((a, b) => b.roastedAt.localeCompare(a.roastedAt));
}

export async function getRoastProfile(id: string): Promise<RoastProfile | undefined> {
  return db.roastProfiles.get(id);
}

export async function putRoastProfile(row: RoastProfile): Promise<void> {
  await db.roastProfiles.put(row);
}

/** 删除烘焙记录：级联删除曲线事件与杯测，并从拼配配方中摘除相关成分 */
export async function removeRoastProfile(id: string): Promise<void> {
  await db.transaction('rw', db.roastProfiles, db.events, db.cuppings, db.blends, db.roastPots, async () => {
    await db.events.where('profileId').equals(id).delete();
    await db.cuppings.where('profileId').equals(id).delete();
    const pot = await db.roastPots.where('profileId').equals(id).first();
    if (pot) {
      await db.roastPots.put({
        ...pot,
        status: 'void',
        note: '烘焙记录已删除，锅次报废',
        updatedAt: nowIso(),
      });
    }
    const blends = await db.blends.toArray();
    const stamp = nowIso();
    const affected = blends
      .map((blend) => {
        const items = blend.items.filter((item) => item.profileId !== id);
        return items.length === blend.items.length ? null : { ...blend, items, updatedAt: stamp };
      })
      .filter((blend): blend is Blend => blend !== null);
    if (affected.length > 0) await db.blends.bulkPut(affected);
    await db.roastProfiles.delete(id);
  });
  await reconcileAllocationsNow();
}

/**
 * 状态流转：记录中 → 已完成 / 作废（作废可恢复）。
 * 作废时锅次台账标记报废、占用失效；恢复记录中时锅次回到待核销。
 * 排队中的记录不允许直接完成（需先递补排产）。
 */
export async function updateRoastState(id: string, state: RoastState): Promise<void> {
  await db.transaction('rw', db.roastProfiles, db.roastPots, db.blends, db.cuppings, async () => {
    const profile = await db.roastProfiles.get(id);
    if (!profile) return;
    if (state === 'done' && profile.scheduleStatus === 'queued') {
      throw new Error('该批次还在排队中，请先在机台容量释放后递补为「已排产」');
    }
    await db.roastProfiles.update(id, { state, updatedAt: nowIso() });
    const pot = await db.roastPots.where('profileId').equals(id).first();
    const stamp = nowIso();
    if (state === 'void') {
      if (pot) {
        await db.roastPots.put({ ...pot, status: 'void', note: '锅次随烘焙记录作废', updatedAt: stamp });
      }
    } else if (state === 'recording') {
      // 恢复记录中：锅次回到待核销（清空已登记重量），等待重新下豆
      if (pot) {
        await db.roastPots.put({
          ...pot,
          status: 'pending',
          productKg: 0,
          sampleKg: 0,
          lossKg: 0,
          note: '烘焙记录恢复为记录中，待重新下豆核销',
          updatedAt: stamp,
        });
      }
    }
  });
  await reconcileAllocationsNow();
  await admitQueuedNow();
}

/* --------------------------- 曲线事件 RoastEvent --------------------------- */

export async function listEvents(profileId?: string): Promise<RoastEvent[]> {
  const rows = profileId
    ? await db.events.where('profileId').equals(profileId).toArray()
    : await db.events.toArray();
  return rows.sort((a, b) => a.atSec - b.atSec);
}

export async function listAllEvents(): Promise<RoastEvent[]> {
  return db.events.toArray();
}

export async function putEvent(row: RoastEvent): Promise<void> {
  await db.events.put(row);
}

export async function putEvents(rows: RoastEvent[]): Promise<void> {
  await db.events.bulkPut(rows);
}

export async function removeEvent(id: string): Promise<void> {
  await db.events.delete(id);
}

/* ----------------------------- 杯测 Cupping ----------------------------- */

export async function listCuppings(): Promise<Cupping[]> {
  const rows = await db.cuppings.toArray();
  return rows.sort((a, b) => b.cuppedAt.localeCompare(a.cuppedAt));
}

export async function putCupping(row: Cupping): Promise<void> {
  await db.cuppings.put(row);
  // 杯测分数改动（新增 / 编辑）后：占用失效重认（试配转待替换，定版只留提醒）
  await reconcileAllocationsNow();
}

export async function removeCupping(id: string): Promise<void> {
  await db.cuppings.delete(id);
  await reconcileAllocationsNow();
}

/* ------------------------------ 拼配 Blend ------------------------------ */

export async function listBlends(): Promise<Blend[]> {
  const rows = await db.blends.toArray();
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function putBlend(row: Blend): Promise<void> {
  await db.blends.put(row);
}

export async function removeBlend(id: string): Promise<void> {
  await db.blends.delete(id);
}

/* -------------------------- 载量模板 MachineTemplate -------------------------- */

export async function listMachineTemplates(): Promise<MachineTemplate[]> {
  const rows = await db.machineTemplates.toArray();
  return rows.sort((a, b) => a.model.localeCompare(b.model, 'zh-Hans-CN') || a.chargeG - b.chargeG);
}

export async function putMachineTemplate(row: MachineTemplate): Promise<void> {
  await db.machineTemplates.put(row);
}

export async function removeMachineTemplate(id: string): Promise<void> {
  await db.machineTemplates.delete(id);
}

/* ----------------------------- 锅次 RoastPot ----------------------------- */

export async function listRoastPots(): Promise<RoastPot[]> {
  const rows = await db.roastPots.toArray();
  return rows.sort((a, b) => b.roastedAt.localeCompare(a.roastedAt) || a.machineModel.localeCompare(b.machineModel, 'zh-Hans-CN'));
}

export async function getRoastPotByProfile(profileId: string): Promise<RoastPot | undefined> {
  return db.roastPots.where('profileId').equals(profileId).first();
}

export async function putRoastPot(row: RoastPot): Promise<void> {
  await db.roastPots.put(row);
}

export async function removeRoastPot(id: string): Promise<void> {
  await db.roastPots.delete(id);
  await reconcileAllocationsNow();
}

export interface PotVerifyInput {
  productKg: number;
  sampleKg: number;
  lossKg: number;
  note?: string;
}

export interface PotVerifyResult {
  ok: boolean;
  message: string;
  pot?: RoastPot;
}

/**
 * 锅次核销：登记成品 / 留样 / 损耗，校验合计不超过投豆量，写入后全量重算占用。
 * 只有已完成烘焙、且已有通过杯测的锅次，占用才会真正生效。
 */
export async function verifyRoastPot(profileId: string, input: PotVerifyInput): Promise<PotVerifyResult> {
  const result = await db.transaction(
    'rw',
    db.roastPots,
    db.roastProfiles,
    db.cuppings,
    db.blends,
    async () => {
      const profile = await db.roastProfiles.get(profileId);
      if (!profile) return { ok: false as const, message: '烘焙记录不存在，无法核销' };
      if (profile.state === 'void') return { ok: false as const, message: '该烘焙记录已作废，不能核销' };
      if (profile.state === 'recording') return { ok: false as const, message: '该锅次还在记录中，请先下豆完成' };
      if (profile.scheduleStatus === 'queued') return { ok: false as const, message: '该批次还在排队中，不能核销' };

      const chargeKg = roundKg(profile.chargeG / 1000);
      const check = checkPotWeights({
        chargeKg,
        productKg: input.productKg,
        sampleKg: input.sampleKg,
        lossKg: input.lossKg,
      });
      if (!check.ok) return { ok: false as const, message: check.message };

      const stamp = nowIso();
      const existing = await db.roastPots.where('profileId').equals(profileId).first();
      const potCuppings = await db.cuppings.where('profileId').equals(profileId).toArray();
      const pot: RoastPot = {
        id: existing?.id ?? `pot-${profileId}`,
        profileId,
        greenBeanId: profile.greenBeanId,
        machineModel: profile.machineModel,
        roastedAt: profile.roastedAt,
        chargeKg,
        productKg: roundKg(input.productKg),
        sampleKg: roundKg(input.sampleKg),
        lossKg: roundKg(input.lossKg),
        status: 'verified',
        allocations: existing?.allocations ?? [],
        cuppingSignature: cuppingSignatureOf(potCuppings),
        lastScore: latestCuppingOf(potCuppings)?.totalScore ?? null,
        note: input.note?.trim() ?? existing?.note ?? '',
        createdAt: existing?.createdAt ?? stamp,
        updatedAt: stamp,
      };
      await db.roastPots.put(pot);
      return { ok: true as const, message: '锅次已核销', pot };
    },
  );
  if (!result.ok) return { ok: false, message: result.message };
  await reconcileAllocationsNow();
  return { ok: true, message: result.message, pot: result.pot };
}

/** 锅次报废：占用全部失效（试配方案转待替换，已定版只留提醒） */
export async function voidRoastPot(profileId: string, reason?: string): Promise<{ ok: boolean; message: string }> {
  const out = await db.transaction('rw', db.roastPots, db.roastProfiles, async () => {
    const pot = await db.roastPots.where('profileId').equals(profileId).first();
    if (!pot) return { ok: false as const, message: '锅次台账不存在' };
    await db.roastPots.put({
      ...pot,
      status: 'void',
      note: reason?.trim() || '人工标记锅次报废',
      updatedAt: nowIso(),
    });
    const profile = await db.roastProfiles.get(profileId);
    if (profile && profile.state !== 'void') {
      await db.roastProfiles.put({ ...profile, state: 'void', updatedAt: nowIso() });
    }
    return { ok: true as const, message: '锅次已报废，相关方案占用已失效' };
  });
  if (out.ok) await reconcileAllocationsNow();
  return out;
}

/**
 * 全量重算成品占用：任何写入动作（核销、杯测、方案、状态流转、迁移）后调用。
 * 试配方案占用失效会转「待替换」；已定版方案只保留提醒、不改变状态。
 */
export async function reconcileAllocationsNow(): Promise<void> {
  await db.transaction('rw', db.roastPots, db.blends, db.roastProfiles, db.cuppings, async () => {
    const [blends, pots, profiles, cuppings] = await Promise.all([
      db.blends.toArray(),
      db.roastPots.toArray(),
      db.roastProfiles.toArray(),
      db.cuppings.toArray(),
    ]);
    const result = rebuildAllocations({ blends, pots, profiles, cuppings });
    await db.roastPots.bulkPut(result.pots);
    await db.blends.bulkPut(result.blends);
  });
  // 占用变化可能释放容量，顺手尝试递补排队批次
  await admitQueuedNow();
}

/** 旧数据补认：无锅次来源的配方成分按豆源 + 日期补认，随后重算占用 */
export async function recognizeLegacyBlendsNow(): Promise<{ recognized: number; notes: Map<string, string[]> }> {  return db.transaction('rw', db.blends, db.roastProfiles, db.roastPots, db.cuppings, async () => {
    const [blends, profiles, pots, cuppings] = await Promise.all([
      db.blends.toArray(),
      db.roastProfiles.toArray(),
      db.roastPots.toArray(),
      db.cuppings.toArray(),
    ]);
    const recognized = recognizeLegacyBlendItems({ blends, profiles });
    const changedCount = recognized.blends.reduce(
      (acc, blend, index) => acc + (blend !== blends[index] ? 1 : 0),
      0,
    );
    if (changedCount > 0) await db.blends.bulkPut(recognized.blends);
    const result = rebuildAllocations({ blends: recognized.blends, pots, profiles, cuppings });
    await db.roastPots.bulkPut(result.pots);
    await db.blends.bulkPut(result.blends);
    return { recognized: changedCount, notes: recognized.notes };
  });
}

/** 试配方案在杯测改动 / 锅次异常后的「重新认领」：全部成分通过则恢复生效、解除待替换 */
export async function reconfirmBlendNow(
  blendId: string,
): Promise<{ ok: boolean; messages: string[] }> {
  return db.transaction('rw', db.blends, db.roastPots, db.roastProfiles, db.cuppings, async () => {
    const blend = await db.blends.get(blendId);
    if (!blend) return { ok: false, messages: ['方案不存在'] };
    const [pots, profiles, cuppings] = await Promise.all([
      db.roastPots.toArray(),
      db.roastProfiles.toArray(),
      db.cuppings.toArray(),
    ]);
    const outcome = reconfirmBlendAllocations({ blend, pots, profiles, cuppings });
    if (!outcome.result.ok) return outcome.result;
    await db.roastPots.bulkPut(outcome.pots);
    await db.blends.put({ ...outcome.blend, updatedAt: nowIso() });
    return { ok: true, messages: [] };
  });
}

/* --------------------------- 机台日容量 / 排队 --------------------------- */

/** 读取机型的当天容量（取该机型载量模板里的配置；未配置 / 0 表示不限量） */
export async function capacityByModel(): Promise<Map<string, number | null>> {
  const templates = await db.machineTemplates.toArray();
  const map = new Map<string, number | null>();
  templates.forEach((template) => {
    const raw = template.dailyCapacityG;
    const value: number | null = Number.isFinite(raw) && (raw ?? 0) > 0 ? (raw as number) : null;
    // 多个模板时取最严格（最小）的容量
    const prev = map.get(template.model);
    map.set(template.model, prev === undefined ? value : prev === null ? value : value === null ? prev : Math.min(prev, value));
  });
  return map;
}

/**
 * 新建 / 编辑烘焙记录时按机台当天容量决定排产：
 * 容量不足则进入排队（不占容量、不允许完成核销）。
 */
export async function applyScheduleForProfile(profile: RoastProfile): Promise<ScheduleStatus> {
  const [profiles, capacityMap] = await Promise.all([db.roastProfiles.toArray(), capacityByModel()]);
  const decision = decideSchedule({
    profiles,
    machineModel: profile.machineModel,
    roastedAt: profile.roastedAt,
    chargeG: profile.chargeG,
    capacityG: capacityMap.get(profile.machineModel),
    selfId: profile.id,
  });
  if (profile.scheduleStatus !== decision.scheduleStatus || profile.queueOrder !== decision.queueOrder) {
    await db.roastProfiles.put({
      ...profile,
      scheduleStatus: decision.scheduleStatus,
      queueOrder: decision.queueOrder,
      updatedAt: nowIso(),
    });
  }
  return decision.scheduleStatus;
}

/** 容量释放后按排队顺序递补当天排队批次 */
export async function admitQueuedNow(): Promise<string[]> {
  return db.transaction('rw', db.roastProfiles, db.machineTemplates, async () => {
    const [profiles, capacityMap] = await Promise.all([db.roastProfiles.toArray(), capacityByModel()]);
    const admitted = admitQueuedProfiles({ profiles, capacityByModel: capacityMap });
    if (admitted.length > 0) {
      const stamp = nowIso();
      const ids = new Set(admitted.map((item) => item.id));
      await db.roastProfiles.bulkPut(
        profiles
          .filter((profile) => ids.has(profile.id))
          .map((profile) => ({ ...profile, scheduleStatus: 'scheduled' as ScheduleStatus, queueOrder: 0, updatedAt: stamp })),
      );
    }
    return admitted.map((item) => item.id);
  });
}

/** 手动把某批次改为排队 / 提前递补 */
export async function setProfileSchedule(id: string, status: ScheduleStatus): Promise<void> {
  await db.transaction('rw', db.roastProfiles, async () => {
    const profile = await db.roastProfiles.get(id);
    if (!profile) return;
    if (status === 'queued') {
      const order =
        (await db.roastProfiles
          .where('machineModel')
          .equals(profile.machineModel)
          .toArray())
          .filter((item) => item.roastedAt === profile.roastedAt)
          .reduce((max, item) => Math.max(max, item.queueOrder || 0), 0) + 1;
      await db.roastProfiles.put({ ...profile, scheduleStatus: 'queued', queueOrder: order, updatedAt: nowIso() });
    } else {
      await db.roastProfiles.put({ ...profile, scheduleStatus: 'scheduled', queueOrder: 0, updatedAt: nowIso() });
    }
  });
  await admitQueuedNow();
}

/* --------------------------- 下豆扣减在库重量 --------------------------- */

export interface StockConsumeResult {
  ok: boolean;
  message: string;
  /** 本次扣减重量（kg） */
  deductedKg: number;
  /** 扣减后余量（kg） */
  remainingKg: number;
  /** 余量是否低于警戒线 */
  warning: boolean;
  bean?: GreenBean;
  profile?: RoastProfile;
}

/**
 * 烘焙下豆后按载量自动扣减生豆在库重量，并把记录状态推进为「已完成」。
 * 只有「记录中」的记录允许扣减，避免重复扣减；余量不足时直接拒绝。
 */
export async function consumeStockForProfile(profileId: string): Promise<StockConsumeResult> {
  return db.transaction('rw', db.greenBeans, db.roastProfiles, db.roastPots, db.cuppings, async () => {
    const profile = await db.roastProfiles.get(profileId);
    if (!profile) {
      return { ok: false, message: '烘焙记录不存在', deductedKg: 0, remainingKg: 0, warning: false };
    }
    const bean = await db.greenBeans.get(profile.greenBeanId);
    if (!bean) {
      return { ok: false, message: '该烘焙记录关联的生豆已不存在', deductedKg: 0, remainingKg: 0, warning: false };
    }
    const deductedKg = roundKg(profile.chargeG / 1000);
    if (profile.scheduleStatus === 'queued') {
      return {
        ok: false,
        message: '该批次机台当天容量不足，还在排队中，暂不能下豆；容量释放递补后再操作',
        deductedKg: 0,
        remainingKg: bean.stockKg,
        warning: false,
        bean,
        profile,
      };
    }
    if (profile.state !== 'recording') {
      return {
        ok: false,
        message: `该记录当前为「${ROAST_STATE_LABEL[profile.state]}」，无需重复扣减`,
        deductedKg: 0,
        remainingKg: bean.stockKg,
        warning: bean.stockKg < LOW_STOCK_KG,
        bean,
        profile,
      };
    }
    if (bean.stockKg + 1e-6 < deductedKg) {
      return {
        ok: false,
        message: `生豆余量不足：在库 ${bean.stockKg}kg < 本次载量 ${deductedKg}kg，请先补货或下调载量`,
        deductedKg: 0,
        remainingKg: bean.stockKg,
        warning: true,
        bean,
        profile,
      };
    }
    const stamp = nowIso();
    const remainingKg = roundKg(bean.stockKg - deductedKg);
    const nextBean: GreenBean = { ...bean, stockKg: remainingKg, updatedAt: stamp };
    const nextProfile: RoastProfile = { ...profile, state: 'done', updatedAt: stamp };
    await db.greenBeans.put(nextBean);
    await db.roastProfiles.put(nextProfile);
    // 下豆完成：自动建锅次台账（待核销），登记成品/留样/损耗后才可被方案占用
    const pot = await db.roastPots.where('profileId').equals(profileId).first();
    if (!pot) {
      const potCuppings = await db.cuppings.where('profileId').equals(profileId).toArray();
      await db.roastPots.put({
        id: `pot-${profileId}`,
        profileId,
        greenBeanId: profile.greenBeanId,
        machineModel: profile.machineModel,
        roastedAt: profile.roastedAt,
        chargeKg: deductedKg,
        productKg: 0,
        sampleKg: 0,
        lossKg: 0,
        status: 'pending',
        allocations: [],
        cuppingSignature: cuppingSignatureOf(potCuppings),
        lastScore: latestCuppingOf(potCuppings)?.totalScore ?? null,
        note: '下豆自动建锅，待核销登记',
        createdAt: stamp,
        updatedAt: stamp,
      });
    } else if (pot.status === 'void') {
      await db.roastPots.put({ ...pot, status: 'pending', note: '重新下豆，待核销登记', updatedAt: stamp });
    }
    const warning = remainingKg < LOW_STOCK_KG;
    return {
      ok: true,
      message: `已按载量扣减 ${deductedKg}kg，${bean.farm || bean.origin} 余量 ${remainingKg}kg${
        warning ? '（余量偏低，请及时补货）' : ''
      }`,
      deductedKg,
      remainingKg,
      warning,
      bean: nextBean,
      profile: nextProfile,
    };
  });
}

/* ----------------------------- 整库导入导出 ----------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  greenBeans: GreenBean[];
  roastProfiles: RoastProfile[];
  events: RoastEvent[];
  cuppings: Cupping[];
  blends: Blend[];
  machineTemplates: MachineTemplate[];
  roastPots: RoastPot[];
}

/** 结构校验：判断任意对象是否为可导入的快照 */
export function isDatabaseSnapshot(value: unknown): value is DatabaseSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const keys: Array<keyof DatabaseSnapshot> = [
    'greenBeans',
    'roastProfiles',
    'events',
    'cuppings',
    'blends',
  ];
  return keys.every((key) => Array.isArray(candidate[key]));
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [greenBeans, roastProfiles, events, cuppings, blends, machineTemplates, roastPots] = await Promise.all([
    db.greenBeans.toArray(),
    db.roastProfiles.toArray(),
    db.events.toArray(),
    db.cuppings.toArray(),
    db.blends.toArray(),
    db.machineTemplates.toArray(),
    db.roastPots.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_VERSION,
    exportedAt: nowIso(),
    greenBeans,
    roastProfiles,
    events,
    cuppings,
    blends,
    machineTemplates,
    roastPots,
  };
}

/** 用快照覆盖整库（导入档案）；旧档案缺锅次 / 排产字段时按当前结构兜底，并重算占用 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  if (!isDatabaseSnapshot(snapshot)) {
    throw new Error('档案结构不合法：缺少 greenBeans / roastProfiles / events / cuppings / blends 数组字段');
  }
  const normalizedProfiles = snapshot.roastProfiles.map((profile) => ({
    ...profile,
    scheduleStatus: profile.scheduleStatus === 'queued' ? 'queued' : 'scheduled',
    queueOrder: typeof profile.queueOrder === 'number' ? profile.queueOrder : 0,
  })) as RoastProfile[];
  const normalizedTemplates: MachineTemplate[] = (snapshot.machineTemplates ?? []).map((template) => ({
    ...template,
    dailyCapacityG:
      typeof template.dailyCapacityG === 'number' && Number.isFinite(template.dailyCapacityG)
        ? template.dailyCapacityG
        : null,
  }));
  const normalizedBlends: Blend[] = snapshot.blends.map((blend) => ({
    ...blend,
    targetBatchKg:
      typeof blend.targetBatchKg === 'number' && blend.targetBatchKg > 0 ? blend.targetBatchKg : DEFAULT_TARGET_BATCH_KG,
    pendingReplace: typeof blend.pendingReplace === 'boolean' ? blend.pendingReplace : false,
  }));
  await db.transaction(
    'rw',
    [db.greenBeans, db.roastProfiles, db.events, db.cuppings, db.blends, db.machineTemplates, db.roastPots],
    async () => {
      await Promise.all([
        db.greenBeans.clear(),
        db.roastProfiles.clear(),
        db.events.clear(),
        db.cuppings.clear(),
        db.blends.clear(),
        db.machineTemplates.clear(),
        db.roastPots.clear(),
      ]);
      await db.greenBeans.bulkPut(snapshot.greenBeans);
      await db.roastProfiles.bulkPut(normalizedProfiles);
      await db.events.bulkPut(snapshot.events);
      await db.cuppings.bulkPut(snapshot.cuppings);
      await db.machineTemplates.bulkPut(normalizedTemplates);
      await db.blends.bulkPut(normalizedBlends);
      await db.roastPots.bulkPut(snapshot.roastPots ?? []);
    },
  );
  // 旧档案没有锅次台账：为已完成记录补建待核销锅次，并对无锅次来源方案做补认
  const profiles = await db.roastProfiles.toArray();
  if ((await db.roastPots.count()) === 0) {
    const stamp = nowIso();
    const cuppings = await db.cuppings.toArray();
    const byProfile = new Map<string, Cupping[]>();
    cuppings.forEach((cupping) => {
      const list = byProfile.get(cupping.profileId) ?? [];
      list.push(cupping);
      byProfile.set(cupping.profileId, list);
    });
    const pots: RoastPot[] = profiles
      .filter((profile) => profile.state !== 'recording')
      .map((profile) => {
        const potCuppings = byProfile.get(profile.id) ?? [];
        return {
          id: `pot-${profile.id}`,
          profileId: profile.id,
          greenBeanId: profile.greenBeanId,
          machineModel: profile.machineModel,
          roastedAt: profile.roastedAt,
          chargeKg: roundKg(profile.chargeG / 1000),
          productKg: 0,
          sampleKg: 0,
          lossKg: 0,
          status: profile.state === 'void' ? ('void' as const) : ('pending' as const),
          allocations: [],
          cuppingSignature: cuppingSignatureOf(potCuppings),
          lastScore: latestCuppingOf(potCuppings)?.totalScore ?? null,
          note: '旧档案导入补建，待核销',
          createdAt: stamp,
          updatedAt: stamp,
        };
      });
    await db.roastPots.bulkPut(pots);
  }
  await recognizeLegacyBlendsNow();
  await reconcileAllocationsNow();
}

/** 清空全部表 */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.greenBeans, db.roastProfiles, db.events, db.cuppings, db.blends, db.machineTemplates, db.roastPots],
    async () => {
      await Promise.all([
        db.greenBeans.clear(),
        db.roastProfiles.clear(),
        db.events.clear(),
        db.cuppings.clear(),
        db.blends.clear(),
        db.machineTemplates.clear(),
        db.roastPots.clear(),
      ]);
    },
  );
}

/** 重置为演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [greenBeans, roastProfiles, events, cuppings, blends, machineTemplates, roastPots] = await Promise.all([
    db.greenBeans.count(),
    db.roastProfiles.count(),
    db.events.count(),
    db.cuppings.count(),
    db.blends.count(),
    db.machineTemplates.count(),
    db.roastPots.count(),
  ]);
  return { greenBeans, roastProfiles, events, cuppings, blends, machineTemplates, roastPots };
}

/* ------------------------------ 首屏初始化 ------------------------------ */

/** 打开数据库：空库时自动播种演示数据，保证每个页面开箱即有内容 */
export async function initDatabase(): Promise<void> {
  await db.open();
  if ((await db.greenBeans.count()) === 0) {
    await seedDatabase();
  }
  // 兜底对账：保证占用、待替换标记与排队递补和当前数据一致
  await reconcileAllocationsNow();
}

/**
 * 播种演示数据（幂等：固定 id + bulkPut）。
 * 层次：生豆 → 烘焙记录 → 曲线事件 / 杯测 → 拼配方案（→ 表示父引用子）。
 */
export async function seedDatabase(): Promise<void> {
  const existing = await db.greenBeans.count();
  if (existing > 0) return;

  const stamp = nowIso();
  const day = (offset: number): string => {
    const base = new Date('2025-01-10T08:00:00.000Z');
    base.setUTCDate(base.getUTCDate() + offset);
    return base.toISOString().slice(0, 10);
  };

  const greenBeans: GreenBean[] = [
    {
      id: 'gb-guji-washed',
      origin: '埃塞俄比亚 古吉',
      farm: '乌拉嘎水洗站',
      process: 'washed',
      altitudeM: 2050,
      moisturePct: 10.8,
      stockKg: 12.5,
      arrivedAt: day(-52),
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'gb-huila-honey',
      origin: '哥伦比亚 惠兰',
      farm: '圣安东尼奥庄园',
      process: 'honey',
      altitudeM: 1750,
      moisturePct: 11.2,
      stockKg: 1.4,
      arrivedAt: day(-38),
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'gb-cerrado-natural',
      origin: '巴西 喜拉多',
      farm: '圣伊莎贝尔庄园',
      process: 'natural',
      altitudeM: 1150,
      moisturePct: 11.6,
      stockKg: 20,
      arrivedAt: day(-22),
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'gb-nyeri-washed',
      origin: '肯尼亚 涅里',
      farm: '加图吉处理厂',
      process: 'washed',
      altitudeM: 1850,
      moisturePct: 10.4,
      stockKg: 6.4,
      arrivedAt: day(-10),
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];

  const roastProfiles: RoastProfile[] = [
    {
      id: 'rp-guji-500',
      greenBeanId: 'gb-guji-washed',
      machineModel: 'HB-M6',
      chargeG: 500,
      chargeTempC: 198,
      airflow: 'half',
      gasLevel: 4,
      roastedAt: day(2),
      state: 'done',
      scheduleStatus: 'scheduled',
      queueOrder: 0,
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'rp-huila-800',
      greenBeanId: 'gb-huila-honey',
      machineModel: 'Giesen W6A',
      chargeG: 800,
      chargeTempC: 205,
      airflow: 'open',
      gasLevel: 5,
      roastedAt: day(6),
      state: 'recording',
      scheduleStatus: 'scheduled',
      queueOrder: 0,
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'rp-cerrado-1200',
      greenBeanId: 'gb-cerrado-natural',
      machineModel: 'Probat P12',
      chargeG: 1200,
      chargeTempC: 195,
      airflow: 'half',
      gasLevel: 6,
      roastedAt: day(10),
      state: 'done',
      scheduleStatus: 'scheduled',
      queueOrder: 0,
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'rp-nyeri-400',
      greenBeanId: 'gb-nyeri-washed',
      machineModel: 'Mill City 500g',
      chargeG: 400,
      chargeTempC: 200,
      airflow: 'closed',
      gasLevel: 3,
      roastedAt: day(12),
      state: 'void',
      scheduleStatus: 'scheduled',
      queueOrder: 0,
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'rp-guji-queued-450',
      greenBeanId: 'gb-guji-washed',
      machineModel: 'HB-M6',
      chargeG: 450,
      chargeTempC: 196,
      airflow: 'half',
      gasLevel: 4,
      roastedAt: day(2),
      state: 'recording',
      // HB-M6 当天容量 1000g：已有 500g 排产，本锅 450g 超出，排队等下批
      scheduleStatus: 'queued',
      queueOrder: 1,
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];

  const eventSeed: Array<[string, string, RoastEvent['type'], number, number, string]> = [
    ['ev-guji-1', 'rp-guji-500', 'turning', 95, 118.2, '回温点，火力保持 4 档'],
    ['ev-guji-2', 'rp-guji-500', 'dryEnd', 288, 152.6, '脱水结束转黄，风门调半开'],
    ['ev-guji-3', 'rp-guji-500', 'firstCrack', 462, 196.4, '一爆密集，火力回调至 3 档'],
    ['ev-guji-4', 'rp-guji-500', 'secondCrack', 640, 214.2, '二爆初起，准备下豆'],
    ['ev-guji-5', 'rp-guji-500', 'drop', 700, 219.5, '下豆冷却，发展率 34%'],
    ['ev-huila-1', 'rp-huila-800', 'turning', 102, 121, '回温偏晚，火力 5 档'],
    ['ev-huila-2', 'rp-huila-800', 'dryEnd', 305, 149.8, '蜜处理脱水稍慢'],
    ['ev-huila-3', 'rp-huila-800', 'firstCrack', 496, 193.5, '一爆清晰，待补录二爆与下豆'],
    ['ev-cerrado-1', 'rp-cerrado-1200', 'turning', 110, 116.4, '满锅载量，回温 110 秒'],
    ['ev-cerrado-2', 'rp-cerrado-1200', 'dryEnd', 330, 150.2, '脱水结束，火力维持 6 档'],
    ['ev-cerrado-3', 'rp-cerrado-1200', 'firstCrack', 540, 194.8, '一爆均匀'],
    ['ev-cerrado-4', 'rp-cerrado-1200', 'secondCrack', 720, 212.6, '二爆，风门半开'],
    ['ev-cerrado-5', 'rp-cerrado-1200', 'drop', 780, 217.2, '下豆，发展率 30.8%'],
    ['ev-nyeri-1', 'rp-nyeri-400', 'turning', 118, 114.5, '风门关，回温慢'],
    ['ev-nyeri-2', 'rp-nyeri-400', 'dryEnd', 372, 131.8, '脱水期过长、RoR 偏低，判定作废重烘'],
  ];

  const events: RoastEvent[] = eventSeed.map(([id, profileId, type, atSec, beanTempC, note]) => ({
    id,
    profileId,
    type,
    atSec,
    beanTempC,
    rorPerMin: 0,
    note,
    createdAt: stamp,
    updatedAt: stamp,
  }));
  // 按时间顺序补算 RoR（播种后就带上真实速率，页面直接可用）
  const grouped = new Map<string, RoastEvent[]>();
  events.forEach((event) => {
    const list = grouped.get(event.profileId) ?? [];
    list.push(event);
    grouped.set(event.profileId, list);
  });
  grouped.forEach((list) => {
    list.sort((a, b) => a.atSec - b.atSec);
    list.forEach((event, index) => {
      const prev = list[index - 1];
      event.rorPerMin = prev
        ? rorPerMinBetween(prev.atSec, prev.beanTempC, event.atSec, event.beanTempC)
        : 0;
    });
  });

  const buildCupping = (
    id: string,
    profileId: string,
    cuppedAt: string,
    dryAroma: number,
    wetAroma: number,
    acidity: number,
    sweetness: number,
    aftertaste: number,
  ): Cupping => ({
    id,
    profileId,
    cuppedAt,
    dryAroma,
    wetAroma,
    acidity,
    sweetness,
    aftertaste,
    totalScore: weightedTotalScore({ dryAroma, wetAroma, acidity, sweetness, aftertaste }),
    createdAt: stamp,
    updatedAt: stamp,
  });

  const cuppings: Cupping[] = [
    buildCupping('cp-guji-01', 'rp-guji-500', day(4), 8.5, 8.8, 8.6, 8.9, 8.4),
    buildCupping('cp-cerrado-01', 'rp-cerrado-1200', day(12), 8.2, 8.4, 7.8, 8.8, 8.6),
    buildCupping('cp-huila-01', 'rp-huila-800', day(9), 7.9, 8.1, 7.4, 8.2, 7.8),
  ];

  const blends: Blend[] = [
    {
      id: 'bl-house-01',
      name: '晨光拼配 House Blend',
      items: [
        { greenBeanId: 'gb-guji-washed', profileId: 'rp-guji-500', ratioPct: 30 },
        { greenBeanId: 'gb-cerrado-natural', profileId: 'rp-cerrado-1200', ratioPct: 70 },
      ],
      targetFlavor: '柑橘果酸、坚果可可',
      targetBatchKg: 1,
      pendingReplace: false,
      createdAt: day(15),
      state: 'final',
      updatedAt: stamp,
    },
    {
      id: 'bl-espresso-02',
      name: '深烘意式 Espresso Base',
      items: [
        { greenBeanId: 'gb-cerrado-natural', profileId: 'rp-cerrado-1200', ratioPct: 70 },
        { greenBeanId: 'gb-nyeri-washed', profileId: 'rp-nyeri-400', ratioPct: 30 },
      ],
      targetFlavor: '坚果可可、焦糖甜感',
      targetBatchKg: 0.2,
      pendingReplace: false,
      createdAt: day(23),
      state: 'trial',
      updatedAt: stamp,
    },
    {
      id: 'bl-draft-03',
      name: '实验批次（占比待调平）',
      items: [
        { greenBeanId: 'gb-guji-washed', profileId: 'rp-guji-500', ratioPct: 70 },
        { greenBeanId: 'gb-huila-honey', profileId: 'rp-huila-800', ratioPct: 30 },
      ],
      targetFlavor: '花香、莓果',
      targetBatchKg: 0.2,
      pendingReplace: false,
      createdAt: day(27),
      state: 'trial',
      updatedAt: stamp,
    },
    {
      id: 'bl-soe-04',
      name: '暖阳 SOE 小样（已占锅）',
      items: [{ greenBeanId: 'gb-guji-washed', profileId: 'rp-guji-500', ratioPct: 100 }],
      targetFlavor: '柑橘果酸、均衡醇厚',
      targetBatchKg: 0.05,
      pendingReplace: false,
      createdAt: day(28),
      state: 'trial',
      updatedAt: stamp,
    },
  ];

  const machineTemplates: MachineTemplate[] = [
    {
      id: 'mt-hb-m6',
      model: 'HB-M6',
      airflow: 'half',
      gasLevel: 4,
      chargeG: 500,
      dailyCapacityG: 1000,
      note: '常规出品载量，当天容量 1kg',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'mt-giesen-w6a',
      model: 'Giesen W6A',
      airflow: 'open',
      gasLevel: 5,
      chargeG: 800,
      dailyCapacityG: null,
      note: '满锅载量，适合日晒豆',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'mt-probat-p12',
      model: 'Probat P12',
      airflow: 'half',
      gasLevel: 6,
      chargeG: 1200,
      dailyCapacityG: null,
      note: '批量生产档',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'mt-millcity-500',
      model: 'Mill City 500g',
      airflow: 'closed',
      gasLevel: 3,
      chargeG: 400,
      dailyCapacityG: null,
      note: '样品烘焙，风门关',
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];

  // 锅次台账：已完成的两锅已核销（成品/留样/损耗合计 = 投豆量），作废锅直接报废
  const roastPots: RoastPot[] = [
    {
      id: 'pot-rp-guji-500',
      profileId: 'rp-guji-500',
      greenBeanId: 'gb-guji-washed',
      machineModel: 'HB-M6',
      roastedAt: day(2),
      chargeKg: 0.5,
      productKg: 0.42,
      sampleKg: 0.03,
      lossKg: 0.05,
      status: 'verified',
      allocations: [],
      cuppingSignature: cuppingSignatureOf(cuppings.filter((item) => item.profileId === 'rp-guji-500')),
      lastScore: latestCuppingOf(cuppings.filter((item) => item.profileId === 'rp-guji-500'))?.totalScore ?? null,
      note: '成品率 84%，留样 30g',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'pot-rp-cerrado-1200',
      profileId: 'rp-cerrado-1200',
      greenBeanId: 'gb-cerrado-natural',
      machineModel: 'Probat P12',
      roastedAt: day(10),
      chargeKg: 1.2,
      productKg: 1.02,
      sampleKg: 0.06,
      lossKg: 0.12,
      status: 'verified',
      allocations: [],
      cuppingSignature: cuppingSignatureOf(cuppings.filter((item) => item.profileId === 'rp-cerrado-1200')),
      lastScore: latestCuppingOf(cuppings.filter((item) => item.profileId === 'rp-cerrado-1200'))?.totalScore ?? null,
      note: '满锅出品，留样 60g',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'pot-rp-nyeri-400',
      profileId: 'rp-nyeri-400',
      greenBeanId: 'gb-nyeri-washed',
      machineModel: 'Mill City 500g',
      roastedAt: day(12),
      chargeKg: 0.4,
      productKg: 0,
      sampleKg: 0,
      lossKg: 0.4,
      status: 'void',
      allocations: [],
      cuppingSignature: '',
      lastScore: null,
      note: '脱水期过长，整锅报废',
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];

  await db.transaction(
    'rw',
    [
      db.greenBeans,
      db.roastProfiles,
      db.events,
      db.cuppings,
      db.blends,
      db.machineTemplates,
      db.roastPots,
    ],
    async () => {
      await db.greenBeans.bulkPut(greenBeans);
      await db.roastProfiles.bulkPut(roastProfiles);
      await db.events.bulkPut(events);
      await db.cuppings.bulkPut(cuppings);
      await db.blends.bulkPut(blends);
      await db.machineTemplates.bulkPut(machineTemplates);
      await db.roastPots.bulkPut(roastPots);
    },
  );

  // 按统一规则重算占用：生效占用 / 失效待重认 / 试配方案待替换标记一次就位
  await reconcileAllocationsNow();
}
