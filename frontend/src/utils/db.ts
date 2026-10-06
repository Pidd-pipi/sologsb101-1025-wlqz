/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbroastlog，数据结构版本号 DB_VERSION = 2（version(1) 初版 + version(2) 真实迁移）
 * - 生豆 / 烘焙记录 / 曲线事件 / 杯测 / 拼配方案 分表存储（另有载量模板表）
 * - 首屏自动播种演示数据（父→子→孙三层贯通，幂等）
 * - 整库快照导出导入、级联删除、下豆扣减生豆在库重量
 * 纯前端应用：不依赖任何后端或数据库服务。
 */
import Dexie, { type Table } from 'dexie';
import type { GreenBean } from '../types/greenbean';
import { LOW_STOCK_KG } from '../types/greenbean';
import type { MachineTemplate, RoastProfile, RoastState } from '../types/roastprofile';
import {
  DEFAULT_MACHINE_DAILY_CAPACITY_G,
  ROAST_STATE_LABEL,
  dailyCapacityOf,
  scheduledChargeOf,
} from '../types/roastprofile';
import type { RoastEvent } from '../types/event';
import type { Cupping } from '../types/cupping';
import { weightedTotalScore } from '../types/cupping';
import type { Blend } from '../types/blend';
import type { PotOccupation, PotSettlement, SettlementState } from '../types/writeoff';
import {
  BACKFILL_YIELD_RATE,
  occupiedWeightOf,
  roundGram,
  yieldPctOf,
} from '../types/writeoff';
import {
  backfillProfileForItem,
  blendBatchOf,
  finalizationBlockers,
  rebuildOccupations,
} from './writeoff';
import { rorPerMinBetween } from './curve';

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
  /** 锅次核销：成品 / 留样 / 损耗 */
  potSettlements!: Table<PotSettlement, string>;
  /** 方案占用：按比例占用锅次成品 */
  potOccupations!: Table<PotOccupation, string>;

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

    // v3：锅次核销（成品/留样/损耗）+ 方案按比例占用；机台当天容量与锅次排队
    this.version(DB_VERSION)
      .stores({
        potSettlements: 'id, profileId, greenBeanId, machineModel, roastedAt, state, updatedAt',
        potOccupations: 'id, blendId, profileId, greenBeanId, machineModel, roastedAt, state, updatedAt',
      })
      .upgrade(async (tx) => {
        const stamp = nowIso();

        // 1) 载量模板补当天容量
        await tx
          .table('machineTemplates')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.dailyCapacityG !== 'number' || row.dailyCapacityG <= 0) {
              row.dailyCapacityG = DEFAULT_MACHINE_DAILY_CAPACITY_G;
            }
          });

        // 2) 烘焙记录补排队状态
        await tx
          .table('roastProfiles')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (row.queueStatus !== 'scheduled' && row.queueStatus !== 'queued') row.queueStatus = 'scheduled';
            if (row.queuedAt === undefined) row.queuedAt = null;
          });

        // 3) 拼配方案补计划产量
        await tx
          .table('blends')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.batchG !== 'number' || row.batchG <= 0) {
              row.batchG = 1000;
            }
          });

        // 4) 旧锅次补核销台账：已完成 → 待核销（按默认成品率回填，等待人工核对）；作废 → 已报废
        const profilesForSettle = (await tx.table('roastProfiles').toArray()) as RoastProfile[];
        const settlements: PotSettlement[] = profilesForSettle
          .filter((profile) => profile.state === 'done' || profile.state === 'void')
          .map((profile) => {
            const productG =
              profile.state === 'done' ? roundGram(profile.chargeG * BACKFILL_YIELD_RATE) : 0;
            return {
              id: settlementIdOf(profile.id),
              profileId: profile.id,
              greenBeanId: profile.greenBeanId,
              machineModel: profile.machineModel,
              roastedAt: profile.roastedAt,
              chargeG: profile.chargeG,
              productG,
              sampleG: 0,
              lossG: roundGram(profile.chargeG - productG),
              state: profile.state === 'void' ? 'scrapped' : 'pending',
              note: '旧数据迁移补认：成品按默认成品率回填，请核对后核销',
              backfilled: true,
              verifiedAt: null,
              createdAt: stamp,
              updatedAt: stamp,
            };
          });
        if (settlements.length > 0) await tx.table('potSettlements').bulkPut(settlements);

        // 5) 旧方案占用：按豆源/机台/日期补认锅次；认不出停在待核销（迁移阶段不自动改方案状态）
        const blendRows = (await tx.table('blends').toArray()) as Blend[];
        const beanRows = (await tx.table('greenBeans').toArray()) as GreenBean[];
        const cuppingRows = (await tx.table('cuppings').toArray()) as Cupping[];
        if (blendRows.length > 0) {
          const rebuilt = rebuildOccupations(
            {
              blends: blendRows,
              profiles: profilesForSettle,
              beans: beanRows,
              cuppings: cuppingRows,
              settlements,
            },
            [],
          );
          if (rebuilt.occupations.length > 0) await tx.table('potOccupations').bulkPut(rebuilt.occupations);
        }
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

/** 删除生豆：级联删除其烘焙记录、曲线事件、杯测、锅次核销/占用，并从拼配配方中摘除相关成分 */
export async function removeGreenBean(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.greenBeans, db.roastProfiles, db.events, db.cuppings, db.blends, db.potSettlements, db.potOccupations],
    async () => {
      const profiles = await db.roastProfiles.where('greenBeanId').equals(id).toArray();
      const profileIds = profiles.map((profile) => profile.id);
      if (profileIds.length > 0) {
        await db.events.where('profileId').anyOf(profileIds).delete();
        await db.cuppings.where('profileId').anyOf(profileIds).delete();
        await db.potSettlements.where('profileId').anyOf(profileIds).delete();
        await db.potOccupations.where('profileId').anyOf(profileIds).delete();
        await db.roastProfiles.bulkDelete(profileIds);
      }
      const blends = await db.blends.toArray();
      const stamp = nowIso();
      const affected = blends
        .map((blend) => {
          const items = blend.items.filter((item) => item.greenBeanId !== id && !profileIds.includes(item.profileId));
          return items.length === blend.items.length ? null : { ...blend, items, updatedAt: stamp };
        })
        .filter((blend): blend is Blend => blend !== null);
      if (affected.length > 0) {
        await db.blends.bulkPut(affected);
        await syncOccupationsInTx();
      }
      await db.greenBeans.delete(id);
    },
  );
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

/** 删除烘焙记录：级联删除曲线事件、杯测、锅次核销/占用，并从拼配配方中摘除相关成分 */
export async function removeRoastProfile(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.roastProfiles, db.events, db.cuppings, db.blends, db.potSettlements, db.potOccupations, db.greenBeans],
    async () => {
      await db.events.where('profileId').equals(id).delete();
      await db.cuppings.where('profileId').equals(id).delete();
      await db.potSettlements.where('profileId').equals(id).delete();
      await db.potOccupations.where('profileId').equals(id).delete();
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
      await syncOccupationsInTx();
    },
  );
}

/** 状态流转：记录中 → 已完成 / 作废（仅改状态；涉及核销联动时用 changeRoastStateWithWriteoff） */
export async function updateRoastState(id: string, state: RoastState): Promise<void> {
  await db.roastProfiles.update(id, { state, updatedAt: nowIso() });
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
}

export async function removeCupping(id: string): Promise<void> {
  await db.cuppings.delete(id);
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

/* ------------------------ 锅次核销 PotSettlement ------------------------ */

/** 一锅次一条核销台账：用 profileId 派生稳定主键 */
export function settlementIdOf(profileId: string): string {
  return `st-${profileId}`;
}

export async function listPotSettlements(): Promise<PotSettlement[]> {
  return db.potSettlements.toArray();
}

export async function getPotSettlement(profileId: string): Promise<PotSettlement | undefined> {
  return db.potSettlements.get(settlementIdOf(profileId));
}

export async function putPotSettlement(row: PotSettlement): Promise<void> {
  await db.potSettlements.put(row);
}

export async function removePotSettlementByProfile(profileId: string): Promise<void> {
  await db.potSettlements.where('profileId').equals(profileId).delete();
}

/* ------------------------- 方案占用 PotOccupation ------------------------- */

export async function listPotOccupations(): Promise<PotOccupation[]> {
  return db.potOccupations.toArray();
}

export async function putPotOccupations(rows: PotOccupation[]): Promise<void> {
  if (rows.length > 0) await db.potOccupations.bulkPut(rows);
}

export async function removePotOccupationsByBlend(blendId: string): Promise<void> {
  await db.potOccupations.where('blendId').equals(blendId).delete();
}

export async function removePotOccupationsByProfile(profileId: string): Promise<void> {
  await db.potOccupations.where('profileId').equals(profileId).delete();
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
  return db.transaction(
    'rw',
    [db.greenBeans, db.roastProfiles, db.potSettlements, db.potOccupations, db.blends, db.cuppings, db.machineTemplates],
    async () => {
    const profile = await db.roastProfiles.get(profileId);
    if (!profile) {
      return { ok: false, message: '烘焙记录不存在', deductedKg: 0, remainingKg: 0, warning: false };
    }
    const bean = await db.greenBeans.get(profile.greenBeanId);
    if (!bean) {
      return { ok: false, message: '该烘焙记录关联的生豆已不存在', deductedKg: 0, remainingKg: 0, warning: false };
    }
    const deductedKg = roundKg(profile.chargeG / 1000);
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

    // 下豆完成即生成待核销台账（成品默认按投豆回填，核销时改账），等待登记成品/留样/损耗
    const existingSettlement = await db.potSettlements.get(settlementIdOf(profileId));
    if (!existingSettlement) {
      const productG = roundGram(profile.chargeG * BACKFILL_YIELD_RATE);
      const pending: PotSettlement = {
        id: settlementIdOf(profileId),
        profileId,
        greenBeanId: profile.greenBeanId,
        machineModel: profile.machineModel,
        roastedAt: profile.roastedAt,
        chargeG: profile.chargeG,
        productG,
        sampleG: 0,
        lossG: roundGram(profile.chargeG - productG),
        state: 'pending',
        note: '下豆自动建账，请登记实际成品/留样/损耗后核销',
        backfilled: false,
        verifiedAt: null,
        createdAt: stamp,
        updatedAt: stamp,
      };
      await db.potSettlements.put(pending);
    }
    await promoteRoastQueueInTx(profile.machineModel, profile.roastedAt, stamp);
    await syncOccupationsInTx();

    const warning = remainingKg < LOW_STOCK_KG;
    return {
      ok: true,
      message: `已按载量扣减 ${deductedKg}kg，${bean.farm || bean.origin} 余量 ${remainingKg}kg${
        warning ? '（余量偏低，请及时补货）' : ''
      }；锅次已进入待核销`,
      deductedKg,
      remainingKg,
      warning,
      bean: nextBean,
      profile: nextProfile,
    };
  });
}

/* ------------------------ 锅次核销 / 方案占用动作 ------------------------ */

export interface SettlementSaveResult {
  ok: boolean;
  message: string;
  settlement?: PotSettlement;
}

/**
 * 事务内：重算全部方案占用，并把失效的试配方案转为「待替换」（定版只留提醒、不动状态）。
 * 必须在已经开启 rw 事务的动作里调用。
 */
async function syncOccupationsInTx(): Promise<{ pendingBlendIds: string[] }> {
  const [blends, profiles, beans, cuppings, settlements, previous] = await Promise.all([
    db.blends.toArray(),
    db.roastProfiles.toArray(),
    db.greenBeans.toArray(),
    db.cuppings.toArray(),
    db.potSettlements.toArray(),
    db.potOccupations.toArray(),
  ]);
  const rebuilt = rebuildOccupations({ blends, profiles, beans, cuppings, settlements }, previous);
  await db.potOccupations.clear();
  if (rebuilt.occupations.length > 0) await db.potOccupations.bulkPut(rebuilt.occupations);
  const stamp = nowIso();
  const pendingSet = new Set(rebuilt.pendingBlendIds);
  const nextBlends = blends
    .filter((blend) => blend.state === 'trial' && pendingSet.has(blend.id))
    .map((blend) => ({ ...blend, state: 'pending' as const, updatedAt: stamp }));
  if (nextBlends.length > 0) await db.blends.bulkPut(nextBlends);
  return { pendingBlendIds: rebuilt.pendingBlendIds };
}

/** 重算全部占用账（供页面动作调用） */
export async function syncOccupations(): Promise<{ pendingBlendIds: string[] }> {
  return db.transaction(
    'rw',
    [db.blends, db.roastProfiles, db.greenBeans, db.cuppings, db.potSettlements, db.potOccupations],
    syncOccupationsInTx);
}

/**
 * 保存锅次核销（记成品、留样、损耗）。
 * - 成品 + 留样不得大于投豆；
 * - 核销通过 → state=verified 并写 verifiedAt；
 * - 标记报废 → state=scrapped（占用随之失效）。
 * 保存后重算占用账。
 */
export async function savePotSettlement(
  profileId: string,
  input: {
    productG: number;
    sampleG: number;
    state: SettlementState;
    note?: string;
  },
): Promise<SettlementSaveResult> {
  return db.transaction(
    'rw',
    [db.roastProfiles, db.potSettlements, db.potOccupations, db.blends, db.greenBeans, db.cuppings],
    async () => {
      const profile = await db.roastProfiles.get(profileId);
      if (!profile) return { ok: false, message: '烘焙记录（锅次）不存在' };
      const productG = roundGram(input.productG);
      const sampleG = roundGram(input.sampleG);
      if (productG < 0 || sampleG < 0) {
        return { ok: false, message: '成品与留样重量不能为负' };
      }
      if (input.state !== 'scrapped' && productG + sampleG > profile.chargeG + 0.5) {
        return {
          ok: false,
          message: `成品 ${productG}g + 留样 ${sampleG}g 超过投豆量 ${profile.chargeG}g，请先核对`,
        };
      }
      const stamp = nowIso();
      const previous = await db.potSettlements.get(settlementIdOf(profileId));
      const row: PotSettlement = {
        id: settlementIdOf(profileId),
        profileId,
        greenBeanId: profile.greenBeanId,
        machineModel: profile.machineModel,
        roastedAt: profile.roastedAt,
        chargeG: profile.chargeG,
        productG: input.state === 'scrapped' ? 0 : productG,
        sampleG: input.state === 'scrapped' ? 0 : sampleG,
        lossG: input.state === 'scrapped' ? profile.chargeG : roundGram(profile.chargeG - productG - sampleG),
        state: input.state,
        note: input.note?.trim() ?? previous?.note ?? '',
        backfilled: previous?.backfilled ?? false,
        verifiedAt: input.state === 'verified' ? previous?.verifiedAt ?? stamp : null,
        createdAt: previous?.createdAt ?? stamp,
        updatedAt: stamp,
      };
      await db.potSettlements.put(row);
      await syncOccupationsInTx();
      const yieldPct = yieldPctOf(row);
      return {
        ok: true,
        message:
          input.state === 'scrapped'
            ? '锅次已报废，相关方案占用已失效'
            : input.state === 'verified'
              ? `锅次已核销：成品 ${row.productG}g / 留样 ${row.sampleG}g / 损耗 ${row.lossG}g（成品率 ${yieldPct}%）`
              : '已保存为待核销，登记完整后点「核销通过」',
        settlement: row,
      };
    },
  );
}

/** 一键核销通过（沿用已登记的成品/留样/损耗） */
export async function verifyPotSettlement(profileId: string): Promise<SettlementSaveResult> {
  const previous = await db.potSettlements.get(settlementIdOf(profileId));
  if (!previous) return { ok: false, message: '请先登记成品、留样与损耗' };
  return savePotSettlement(profileId, {
    productG: previous.productG,
    sampleG: previous.sampleG,
    state: 'verified',
    note: previous.note,
  });
}

/**
 * 旧数据无锅次来源的方案成分：按豆源 + 机台 + 日期补认，认不出保持待核销。
 * 机台 / 日期线索取自该方案已有成分里同豆源锅次（拼配通常围绕同一天同一台机的几锅）。
 */
export async function backfillBlendOccupations(blendId: string): Promise<{ matched: number; unmatched: number }> {
  return db.transaction(
    'rw',
    [db.blends, db.roastProfiles, db.greenBeans, db.cuppings, db.potSettlements, db.potOccupations],
    async () => {
      const blend = await db.blends.get(blendId);
      if (!blend) return { matched: 0, unmatched: 0 };
      const profiles = await db.roastProfiles.toArray();
      // 收集线索：同豆源已有成分的机台与烘焙日期
      const machineHintByBean = new Map<string, Set<string>>();
      const dateHintByBean = new Map<string, Set<string>>();
      blend.items.forEach((item) => {
        if (!item.profileId) return;
        const profile = profiles.find((row) => row.id === item.profileId);
        if (!profile) return;
        const machines = machineHintByBean.get(item.greenBeanId) ?? new Set<string>();
        machines.add(profile.machineModel);
        machineHintByBean.set(item.greenBeanId, machines);
        const dates = dateHintByBean.get(item.greenBeanId) ?? new Set<string>();
        dates.add(profile.roastedAt);
        dateHintByBean.set(item.greenBeanId, dates);
      });

      let matched = 0;
      let unmatched = 0;
      const stamp = nowIso();
      const nextItems = blend.items.map((item) => {
        if (item.profileId) return item;
        const machines = machineHintByBean.get(item.greenBeanId);
        const dates = dateHintByBean.get(item.greenBeanId);
        // 只有当线索唯一时才用于收窄候选，避免误匹配
        const hint: { machineModel?: string; roastedAt?: string } = {
          machineModel: machines && machines.size === 1 ? Array.from(machines)[0] : undefined,
          roastedAt: dates && dates.size === 1 ? Array.from(dates)[0] : undefined,
        };
        const found = backfillProfileForItem(item, hint, profiles);
        if (found) {
          matched += 1;
          return { ...item, profileId: found.id };
        }
        unmatched += 1;
        return item;
      });
      if (matched > 0) await db.blends.put({ ...blend, items: nextItems, updatedAt: stamp });
      await syncOccupationsInTx();
      return { matched, unmatched };
    },
  );
}

export interface FinalizeBlendResult {
  ok: boolean;
  message: string;
}

/**
 * 定版闸门：只用已核销且杯测通过的锅次。
 * 先重算占用，存在任何未 held / 杯测不过的成分即拒绝定版。
 */
export async function finalizeBlend(blendId: string): Promise<FinalizeBlendResult> {
  return db.transaction(
    'rw',
    [db.blends, db.roastProfiles, db.greenBeans, db.cuppings, db.potSettlements, db.potOccupations],
    async () => {
      await syncOccupationsInTx();
      const blend = await db.blends.get(blendId);
      if (!blend) return { ok: false, message: '拼配方案不存在' };
      const occupations = await db.potOccupations.toArray();
      const cuppings = await db.cuppings.toArray();
      const blockers = finalizationBlockers(blend, occupations, cuppings);
      if (blockers.length > 0) {
        return { ok: false, message: `定版被拦截：${blockers.join('；')}` };
      }
      const stamp = nowIso();
      await db.blends.put({ ...blend, state: 'final', updatedAt: stamp });
      return { ok: true, message: '方案已定版：全部成分均来自已核销且杯测通过的锅次' };
    },
  );
}

/* --------------------------- 机台当天容量 / 排队 --------------------------- */

/**
 * 事务内：某机台某日有容量释放时，按入队时间把排队锅次补成已排产（下批排队先进先出）。
 * @param excludeProfileId 手动「让位排队」时排除刚入队的锅次，避免容量释放后立刻又把它排回来。
 */
async function promoteRoastQueueInTx(
  machineModel: string,
  date: string,
  stamp: string,
  excludeProfileId?: string,
): Promise<number> {
  const templates = await db.machineTemplates.toArray();
  const capacity = dailyCapacityOf(templates, machineModel);
  const all = await db.roastProfiles.where('machineModel').equals(machineModel).toArray();
  const sameDay = all.filter((profile) => profile.roastedAt === date && profile.state !== 'void');
  const used = scheduledChargeOf(sameDay, machineModel, date);
  let remaining = capacity - used;
  const queued = sameDay
    .filter(
      (profile) =>
        (profile.queueStatus ?? 'scheduled') === 'queued' &&
        profile.id !== excludeProfileId &&
        // 已完成的排队锅次属于历史异常数据，不参与自动补位
        profile.state === 'recording',
    )
    .sort((a, b) => (a.queuedAt ?? '').localeCompare(b.queuedAt ?? '') || a.createdAt.localeCompare(b.createdAt));
  let promoted = 0;
  for (const profile of queued) {
    if (profile.chargeG <= remaining + 0.5) {
      remaining -= profile.chargeG;
      await db.roastProfiles.put({ ...profile, queueStatus: 'scheduled', queuedAt: null, updatedAt: stamp });
      promoted += 1;
    } else {
      break;
    }
  }
  return promoted;
}

export interface CreateRoastWithQueueResult {
  profile: RoastProfile;
  queued: boolean;
  message: string;
}

/**
 * 新建烘焙记录前做机台当天容量判定：
 * 已排产载量 + 本锅载量超过机台日容量 → 该锅次进排队队列（记录照常建立，queueStatus=queued）。
 */
export function evaluateQueueForProfile(
  draft: Pick<RoastProfile, 'machineModel' | 'roastedAt' | 'chargeG'>,
  profiles: RoastProfile[],
  templates: MachineTemplate[],
): { queued: boolean; usedG: number; capacityG: number } {
  const capacityG = dailyCapacityOf(templates, draft.machineModel);
  const usedG = scheduledChargeOf(profiles, draft.machineModel, draft.roastedAt);
  return { queued: usedG + draft.chargeG > capacityG + 0.5, usedG, capacityG };
}

/** 手动调整某锅次排队状态（插队 / 让位），并自动顺延队列 */
export async function setRoastQueueStatus(
  profileId: string,
  queueStatus: 'scheduled' | 'queued',
): Promise<{ ok: boolean; message: string }> {
  return db.transaction('rw', db.roastProfiles, db.machineTemplates, async () => {
    const profile = await db.roastProfiles.get(profileId);
    if (!profile) return { ok: false, message: '烘焙记录不存在' };
    const stamp = nowIso();
    if (queueStatus === 'queued') {
      await db.roastProfiles.put({
        ...profile,
        queueStatus: 'queued',
        queuedAt: profile.queuedAt ?? stamp,
        updatedAt: stamp,
      });
      await promoteRoastQueueInTx(profile.machineModel, profile.roastedAt, stamp, profileId);
      return { ok: true, message: '该锅次已下批排队' };
    }
    const templates = await db.machineTemplates.toArray();
    const capacity = dailyCapacityOf(templates, profile.machineModel);
    const others = await db.roastProfiles.where('machineModel').equals(profile.machineModel).toArray();
    const used = scheduledChargeOf(
      others.filter((item) => item.id !== profileId),
      profile.machineModel,
      profile.roastedAt,
    );
    if (used + profile.chargeG > capacity + 0.5) {
      return {
        ok: false,
        message: `当天剩余容量仅 ${roundGram(capacity - used)}g，无法安排 ${profile.chargeG}g 的锅次`,
      };
    }
    await db.roastProfiles.put({ ...profile, queueStatus: 'scheduled', queuedAt: null, updatedAt: stamp });
    return { ok: true, message: '该锅次已排产' };
  });
}

/** 作废 / 恢复记录状态后联动：核销台账、方案占用、排队队列 */
export async function changeRoastStateWithWriteoff(
  profileId: string,
  state: RoastState,
): Promise<{ ok: boolean; message: string }> {
  return db.transaction(
    'rw',
    [db.roastProfiles, db.potSettlements, db.potOccupations, db.blends, db.greenBeans, db.cuppings, db.machineTemplates],
    async () => {
      const profile = await db.roastProfiles.get(profileId);
      if (!profile) return { ok: false, message: '烘焙记录不存在' };
      const stamp = nowIso();
      await db.roastProfiles.put({ ...profile, state, updatedAt: stamp });

      const settlement = await db.potSettlements.get(settlementIdOf(profileId));
      if (state === 'void' && settlement && settlement.state !== 'scrapped') {
        await db.potSettlements.put({
          ...settlement,
          state: 'scrapped',
          productG: 0,
          sampleG: 0,
          lossG: settlement.chargeG,
          verifiedAt: null,
          note: settlement.note ? `${settlement.note}；锅次作废` : '锅次作废',
          updatedAt: stamp,
        });
      }
      if (state === 'recording' && settlement && settlement.state === 'scrapped') {
        await db.potSettlements.put({ ...settlement, state: 'pending', verifiedAt: null, updatedAt: stamp });
      }
      await syncOccupationsInTx();
      await promoteRoastQueueInTx(profile.machineModel, profile.roastedAt, stamp);
      return { ok: true, message: `记录状态已更新为「${ROAST_STATE_LABEL[state]}」` };
    },
  );
}

/** 杯测保存 / 删除后：失效相关锅次的占用（分数改动需重新认领），并重算试配方案状态 */
export async function refreshOccupationsAfterCupping(): Promise<void> {
  await db.transaction(
    'rw',
    [db.blends, db.roastProfiles, db.greenBeans, db.cuppings, db.potSettlements, db.potOccupations],
    async () => {
      await syncOccupationsInTx();
    },
  );
}

/** 计算方案在计划产量下各成分应占用的成品重量（克），供表单预估 */
export function planOccupationWeights(blend: Blend): Array<{ profileId: string; needG: number }> {
  return blend.items.map((item) => ({ profileId: item.profileId, needG: occupiedWeightOf(item.ratioPct, blendBatchOf(blend)) }));
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
  potSettlements: PotSettlement[];
  potOccupations: PotOccupation[];
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
  const [greenBeans, roastProfiles, events, cuppings, blends, machineTemplates, potSettlements, potOccupations] =
    await Promise.all([
      db.greenBeans.toArray(),
      db.roastProfiles.toArray(),
      db.events.toArray(),
      db.cuppings.toArray(),
      db.blends.toArray(),
      db.machineTemplates.toArray(),
      db.potSettlements.toArray(),
      db.potOccupations.toArray(),
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
    potSettlements,
    potOccupations,
  };
}

/** 用快照覆盖整库（导入档案）；旧档案缺核销/占用表时按迁移同规则补认 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  if (!isDatabaseSnapshot(snapshot)) {
    throw new Error('档案结构不合法：缺少 greenBeans / roastProfiles / events / cuppings / blends 数组字段');
  }
  await db.transaction(
    'rw',
    [
      db.greenBeans,
      db.roastProfiles,
      db.events,
      db.cuppings,
      db.blends,
      db.machineTemplates,
      db.potSettlements,
      db.potOccupations,
    ],
    async () => {
      await Promise.all([
        db.greenBeans.clear(),
        db.roastProfiles.clear(),
        db.events.clear(),
        db.cuppings.clear(),
        db.blends.clear(),
        db.machineTemplates.clear(),
        db.potSettlements.clear(),
        db.potOccupations.clear(),
      ]);
      await db.greenBeans.bulkPut(snapshot.greenBeans);
      await db.roastProfiles.bulkPut(snapshot.roastProfiles);
      await db.events.bulkPut(snapshot.events);
      await db.cuppings.bulkPut(snapshot.cuppings);
      await db.blends.bulkPut(snapshot.blends);
      await db.machineTemplates.bulkPut(snapshot.machineTemplates ?? []);

      const stamp = nowIso();
      const incomingSettlements = Array.isArray(snapshot.potSettlements) ? snapshot.potSettlements : null;
      if (incomingSettlements && incomingSettlements.length > 0) {
        await db.potSettlements.bulkPut(incomingSettlements);
      } else {
        // 旧档案补认：已完成锅次按默认成品率建待核销台账，作废锅次建报废台账
        const backfilled: PotSettlement[] = snapshot.roastProfiles
          .filter((profile) => profile.state === 'done' || profile.state === 'void')
          .map((profile) => {
            const productG = profile.state === 'done' ? roundGram(profile.chargeG * BACKFILL_YIELD_RATE) : 0;
            return {
              id: settlementIdOf(profile.id),
              profileId: profile.id,
              greenBeanId: profile.greenBeanId,
              machineModel: profile.machineModel,
              roastedAt: profile.roastedAt,
              chargeG: profile.chargeG,
              productG,
              sampleG: 0,
              lossG: roundGram(profile.chargeG - productG),
              state: profile.state === 'void' ? 'scrapped' : 'pending',
              note: '旧档案导入补认：成品按默认成品率回填，请核对后核销',
              backfilled: true,
              verifiedAt: null,
              createdAt: stamp,
              updatedAt: stamp,
            };
          });
        if (backfilled.length > 0) await db.potSettlements.bulkPut(backfilled);
      }

      const incomingOccupations = Array.isArray(snapshot.potOccupations) ? snapshot.potOccupations : null;
      if (incomingOccupations && incomingOccupations.length > 0) {
        await db.potOccupations.bulkPut(incomingOccupations);
      }
      await syncOccupationsInTx();
    },
  );
}

/** 清空全部表 */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.greenBeans,
      db.roastProfiles,
      db.events,
      db.cuppings,
      db.blends,
      db.machineTemplates,
      db.potSettlements,
      db.potOccupations,
    ],
    async () => {
      await Promise.all([
        db.greenBeans.clear(),
        db.roastProfiles.clear(),
        db.events.clear(),
        db.cuppings.clear(),
        db.blends.clear(),
        db.machineTemplates.clear(),
        db.potSettlements.clear(),
        db.potOccupations.clear(),
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
  const [greenBeans, roastProfiles, events, cuppings, blends, machineTemplates, potSettlements, potOccupations] =
    await Promise.all([
      db.greenBeans.count(),
      db.roastProfiles.count(),
      db.events.count(),
      db.cuppings.count(),
      db.blends.count(),
      db.machineTemplates.count(),
      db.potSettlements.count(),
      db.potOccupations.count(),
    ]);
  return { greenBeans, roastProfiles, events, cuppings, blends, machineTemplates, potSettlements, potOccupations };
}

/* ------------------------------ 首屏初始化 ------------------------------ */

/** 打开数据库：空库时自动播种演示数据，保证每个页面开箱即有内容 */
export async function initDatabase(): Promise<void> {
  await db.open();
  if ((await db.greenBeans.count()) === 0) {
    await seedDatabase();
  }
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
      queueStatus: 'scheduled',
      queuedAt: null,
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
      queueStatus: 'scheduled',
      queuedAt: null,
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
      queueStatus: 'scheduled',
      queuedAt: null,
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
      queueStatus: 'scheduled',
      queuedAt: null,
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
        { greenBeanId: 'gb-guji-washed', profileId: 'rp-guji-500', ratioPct: 40 },
        { greenBeanId: 'gb-cerrado-natural', profileId: 'rp-cerrado-1200', ratioPct: 45 },
        { greenBeanId: 'gb-huila-honey', profileId: 'rp-huila-800', ratioPct: 15 },
      ],
      targetFlavor: '柑橘果酸、坚果可可',
      createdAt: day(15),
      state: 'final',
      batchG: 1000,
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
      createdAt: day(23),
      state: 'trial',
      batchG: 1000,
      updatedAt: stamp,
    },
    {
      id: 'bl-draft-03',
      name: '实验批次（占比待调平）',
      items: [
        { greenBeanId: 'gb-guji-washed', profileId: 'rp-guji-500', ratioPct: 50 },
        { greenBeanId: 'gb-huila-honey', profileId: 'rp-huila-800', ratioPct: 30 },
      ],
      targetFlavor: '花香、莓果',
      createdAt: day(27),
      state: 'trial',
      batchG: 500,
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
      dailyCapacityG: 6000,
      note: '常规出品载量',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'mt-giesen-w6a',
      model: 'Giesen W6A',
      airflow: 'open',
      gasLevel: 5,
      chargeG: 800,
      dailyCapacityG: 8000,
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
      dailyCapacityG: 12000,
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
      dailyCapacityG: 3000,
      note: '样品烘焙，风门关',
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];

  // 锅次核销台账：演示「已核销 / 已报废」两种状态（记录中的锅次下豆时自动建待核销账）
  const profileById = new Map(roastProfiles.map((profile) => [profile.id, profile]));
  const buildSettlement = (
    profileId: string,
    state: PotSettlement['state'],
    productG: number,
    sampleG: number,
    note: string,
  ): PotSettlement => {
    const profile = profileById.get(profileId)!;
    return {
      id: settlementIdOf(profileId),
      profileId,
      greenBeanId: profile.greenBeanId,
      machineModel: profile.machineModel,
      roastedAt: profile.roastedAt,
      chargeG: profile.chargeG,
      productG: state === 'scrapped' ? 0 : productG,
      sampleG: state === 'scrapped' ? 0 : sampleG,
      lossG: state === 'scrapped' ? profile.chargeG : roundGram(profile.chargeG - productG - sampleG),
      state,
      note,
      backfilled: false,
      verifiedAt: state === 'verified' ? stamp : null,
      createdAt: stamp,
      updatedAt: stamp,
    };
  };
  const potSettlements: PotSettlement[] = [
    buildSettlement('rp-guji-500', 'verified', 420, 30, '出锅状态稳定，留 30g 杯测样'),
    buildSettlement('rp-cerrado-1200', 'verified', 1002, 50, '满锅熟豆 1kg 出头'),
    buildSettlement('rp-nyeri-400', 'scrapped', 0, 0, '脱水期过长，整锅报废'),
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
      db.potSettlements,
      db.potOccupations,
    ],
    async () => {
      await db.greenBeans.bulkPut(greenBeans);
      await db.roastProfiles.bulkPut(roastProfiles);
      await db.events.bulkPut(events);
      await db.cuppings.bulkPut(cuppings);
      await db.blends.bulkPut(blends);
      await db.machineTemplates.bulkPut(machineTemplates);
      await db.potSettlements.bulkPut(potSettlements);
      // 占用账由台账 + 杯测 + 方案统一重算，保证播种数据与运行期规则一致
      const rebuilt = rebuildOccupations(
        { blends, profiles: roastProfiles, beans: greenBeans, cuppings, settlements: potSettlements },
        [],
      );
      if (rebuilt.occupations.length > 0) await db.potOccupations.bulkPut(rebuilt.occupations);
      // 占用失效的试配方案在播种阶段也转「待替换」，与运行期规则保持一致
      const pendingSet = new Set(rebuilt.pendingBlendIds);
      const flipped = blends
        .filter((blend) => blend.state === 'trial' && pendingSet.has(blend.id))
        .map((blend) => ({ ...blend, state: 'pending' as const, updatedAt: stamp }));
      if (flipped.length > 0) await db.blends.bulkPut(flipped);
    },
  );
}
