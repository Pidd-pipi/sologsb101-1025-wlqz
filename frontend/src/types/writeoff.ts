/**
 * PotSettlement 锅次核销 · 成品 / 留样 / 损耗记账 + 试配方案按比例占用
 * 动作：
 * - 锅次核销登记成品、留样与损耗，只有「已核销」且杯测通过的锅次才能被定版方案使用；
 * - 方案占用按配方占比 × 计划产量切分锅次成品，累计占用不得超过剩余量（成品 - 留样 - 已占用）；
 * - 杯测分数改动 / 杯测不通过 / 锅次报废后，旧占用失效，需重新认领；
 * - 旧数据里无锅次来源的方案成分按豆源、机台、日期补认，认不出先停在「待核销」。
 */
import type { Cupping } from './cupping';

/** 锅次核销状态：待核销 / 已核销 / 已报废 */
export type SettlementState = 'pending' | 'verified' | 'scrapped';

/** 方案占用状态：占用中 / 待核销（认不出锅次或锅次未核销）/ 失效（杯测改动、不通过、报废）/ 已释放 */
export type OccupationState = 'held' | 'pending' | 'invalid' | 'released';

/** 锅次核销：每个烘焙记录（锅次）至多一条 */
export interface PotSettlement {
  id: string;
  /** 关联烘焙记录（锅次） */
  profileId: string;
  /** 关联生豆（冗余自烘焙记录，便于按豆源补认） */
  greenBeanId: string;
  /** 机台型号（冗余自烘焙记录，便于按机台补认） */
  machineModel: string;
  /** 烘焙日期（冗余自烘焙记录，便于按日期补认） */
  roastedAt: string;
  /** 投豆量（克，冗余自烘焙记录 chargeG） */
  chargeG: number;
  /** 成品熟豆重量（克） */
  productG: number;
  /** 留样重量（克） */
  sampleG: number;
  /** 损耗重量（克，默认 = 投豆 - 成品 - 留样） */
  lossG: number;
  /** 状态：待核销 / 已核销 / 已报废 */
  state: SettlementState;
  /** 备注（损耗原因等） */
  note: string;
  /** 旧数据补认标记：true 表示由迁移 / 补认流程自动生成，等待人工核对 */
  backfilled: boolean;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 方案对单个锅次的占用（一个方案成分一条） */
export interface PotOccupation {
  id: string;
  /** 关联拼配方案 */
  blendId: string;
  /** 方案名（冗余，列表回显用） */
  blendName: string;
  /** 关联烘焙记录（锅次）；认不出来时为空，停在 pending */
  profileId: string;
  /** 关联生豆 */
  greenBeanId: string;
  /** 机台型号（旧数据补认线索） */
  machineModel: string;
  /** 烘焙日期（旧数据补认线索） */
  roastedAt: string;
  /** 配方占比 % */
  ratioPct: number;
  /** 方案计划产量（克）：方案计划做多少熟豆，占用量 = batchG × 占比 */
  batchG: number;
  /** 实际占用成品重量（克，三位小数）；pending 时尚无法计算为 0 */
  occupiedG: number;
  /** 占用状态 */
  state: OccupationState;
  /** 失效 / 待核销原因（杯测改动、杯测未过、锅次报废、余量不足、补认失败等） */
  reason: string;
  /** 最近一次认领时杯测记录的 updatedAt：杯测分数晚于此时间改动则占用失效，需重新认领 */
  cupCheckedAt: string | null;
  /** 旧数据补认标记 */
  backfilled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PotSettlementDraft = Omit<
  PotSettlement,
  'id' | 'createdAt' | 'updatedAt' | 'verifiedAt'
>;

export const SETTLEMENT_STATE_LABEL: Record<SettlementState, string> = {
  pending: '待核销',
  verified: '已核销',
  scrapped: '已报废',
};

export const SETTLEMENT_STATE_COLOR: Record<SettlementState, string> = {
  pending: '#c9963c',
  verified: '#2f6f4f',
  scrapped: '#b3372f',
};

export const SETTLEMENT_STATE_ORDER: SettlementState[] = ['pending', 'verified', 'scrapped'];

export const SETTLEMENT_STATE_OPTIONS = SETTLEMENT_STATE_ORDER.map((value) => ({
  value,
  label: SETTLEMENT_STATE_LABEL[value],
}));

export const OCCUPATION_STATE_LABEL: Record<OccupationState, string> = {
  held: '占用中',
  pending: '待核销',
  invalid: '已失效',
  released: '已释放',
};

export const OCCUPATION_STATE_COLOR: Record<OccupationState, string> = {
  held: '#2f6f4f',
  pending: '#c9963c',
  invalid: '#b3372f',
  released: '#8c8c8c',
};

export const OCCUPATION_STATE_ORDER: OccupationState[] = ['held', 'pending', 'invalid', 'released'];

export const OCCUPATION_STATE_OPTIONS = OCCUPATION_STATE_ORDER.map((value) => ({
  value,
  label: OCCUPATION_STATE_LABEL[value],
}));

/** 杯测通过线：加权总分 ≥ 80（良好及以上）才允许占用定版 */
export const CUPPING_PASS_SCORE = 80;

/** 默认计划产量（克）：方案未填写计划产量时按 1kg 一锅计 */
export const DEFAULT_BLEND_BATCH_G = 1000;

/** 旧数据补认默认损耗率（成品率 82%） */
export const BACKFILL_YIELD_RATE = 0.82;

/** 重量比较容差（克），避免浮点误差 */
export const WEIGHT_TOLERANCE_G = 0.5;

/** 重量保留一位小数（0.1g） */
export function roundGram(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
}

/** 投豆 - 成品 - 留样 的损耗重量 */
export function lossWeightOf(chargeG: number, productG: number, sampleG: number): number {
  return roundGram(Math.max(0, chargeG - productG - sampleG));
}

/** 成品率 %（成品 / 投豆） */
export function yieldPctOf(settlement: Pick<PotSettlement, 'chargeG' | 'productG'>): number {
  if (settlement.chargeG <= 0) return 0;
  return Math.round((settlement.productG / settlement.chargeG) * 1000) / 10;
}

/** 某方案成分在给定计划产量下应占用的锅次成品重量（克） */
export function occupiedWeightOf(ratioPct: number, batchG: number): number {
  return roundGram((Math.max(0, ratioPct) / 100) * Math.max(0, batchG));
}

/** 杯测是否通过（取该锅次最新一笔杯测，无杯测视为未过） */
export function isCuppingPassed(cuppings: Pick<Cupping, 'totalScore'>[]): boolean {
  if (cuppings.length === 0) return false;
  const latest = cuppings.reduce((acc, item) => Math.max(acc, item.totalScore), 0);
  return latest >= CUPPING_PASS_SCORE;
}

export interface SettlementAvailability {
  /** 成品总量 */
  productG: number;
  /** 留样量（不可被方案占用） */
  sampleG: number;
  /** 已占用量（仅占用中） */
  heldG: number;
  /** 剩余可占用量 */
  remainingG: number;
}

/** 锅次剩余可占用成品：成品 - 留样 - 占用中累计 */
export function settlementAvailability(
  settlement: PotSettlement,
  heldOccupations: Array<Pick<PotOccupation, 'occupiedG'>>,
): SettlementAvailability {
  const heldG = roundGram(heldOccupations.reduce((acc, item) => acc + item.occupiedG, 0));
  const remainingG = roundGram(settlement.productG - settlement.sampleG - heldG);
  return {
    productG: settlement.productG,
    sampleG: settlement.sampleG,
    heldG,
    remainingG,
  };
}

/** 占用状态是否还挂在锅次上（占用中或待核销都占账，失效 / 已释放不占） */
export function occupiesStock(state: OccupationState): boolean {
  return state === 'held';
}
