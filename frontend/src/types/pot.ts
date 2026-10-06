/**
 * RoastPot 锅次核销 · 成品 / 留样 / 损耗的核销台账
 *
 * 多个试配方案争抢同一锅成品时，按比例占用核销后的「可占用成品」，
 * 累计占用不能超过剩余量；杯测没过或锅次报废（对应烘焙记录作废 / 删除）后，
 * 旧占用失效，方案回到「待替换」。
 *
 * 一锅成品对应一次已完成的烘焙记录（RoastProfile）。
 * 核销重量关系：成品 + 留样 + 损耗 = 投豆量（chargeG 换算的 kg，允许烘焙失重，
 * 即合计可以小于投豆量，但不得大于投豆量）。
 */

/** 锅次核销状态 */
export type PotStatus =
  | 'pending' // 待核销：已完成但还没登记成品/留样/损耗（旧数据补认失败的锅次也停在这里）
  | 'verified' // 已核销：成品/留样/损耗已登记，可被方案占用
  | 'void'; // 已报废：对应烘焙记录作废或删除，占用全部失效

/** 占用状态：active 生效中 / stale 失效待重认（杯测变动、锅次报废等） */
export type AllocationState = 'active' | 'stale';

export interface PotAllocation {
  id: string;
  /** 占用方：拼配方案 id */
  blendId: string;
  /** 方案名快照（方案删除后仍能在台账中辨识） */
  blendName: string;
  /** 被占用的锅次（= RoastProfile id） */
  profileId: string;
  /** 占用重量（kg，按方案占比折算） */
  occupyKg: number;
  /** 占用登记时间 */
  createdAt: string;
  /** active：占用生效；stale：杯测分数改动 / 锅次报废后失效，等待方案重认 */
  state: AllocationState;
  /** 失效原因，state=stale 时回显（如「杯测分数已改动」「锅次已报废」） */
  staleReason: string;
  updatedAt: string;
}

export interface RoastPot {
  id: string;
  /** 关联烘焙记录（一锅 = 一次烘焙，1:1） */
  profileId: string;
  /** 冗余豆源 / 机台 / 日期：旧数据「无锅次来源方案」据此补认，烘焙记录删除后也保留台账 */
  greenBeanId: string;
  machineModel: string;
  /** 烘焙日期（YYYY-MM-DD）：机台当天容量按此日期聚合 */
  roastedAt: string;
  /** 投豆量（kg，= RoastProfile.chargeG / 1000） */
  chargeKg: number;
  /** 成品重量（kg） */
  productKg: number;
  /** 留样重量（kg） */
  sampleKg: number;
  /** 损耗重量（kg，含烘焙失重 / 报废损耗） */
  lossKg: number;
  status: PotStatus;
  /** 方案占用列表（含失效记录，便于台账展示与重认） */
  allocations: PotAllocation[];
  /** 杯测签名：杯测分数改动后据此判定占用是否需要失效重认 */
  cuppingSignature: string;
  /** 最近一次杯测总分（用于列表回显与通过线判断） */
  lastScore: number | null;
  /** 备注（报废原因 / 排队说明等） */
  note: string;
  createdAt: string;
  updatedAt: string;
}

export type RoastPotDraft = Pick<RoastPot, 'profileId' | 'productKg' | 'sampleKg' | 'lossKg' | 'note'>;

export const POT_STATUS_LABEL: Record<PotStatus, string> = {
  pending: '待核销',
  verified: '已核销',
  void: '已报废',
};

export const POT_STATUS_COLOR: Record<PotStatus, string> = {
  pending: '#c9963c',
  verified: '#2f6f4f',
  void: '#b3372f',
};

export const POT_STATUS_ORDER: PotStatus[] = ['pending', 'verified', 'void'];

export const POT_STATUS_OPTIONS = POT_STATUS_ORDER.map((value) => ({
  value,
  label: POT_STATUS_LABEL[value],
}));

export const ALLOCATION_STATE_LABEL: Record<AllocationState, string> = {
  active: '占用生效',
  stale: '失效待重认',
};

export const ALLOCATION_STATE_COLOR: Record<AllocationState, string> = {
  active: '#2f6f4f',
  stale: '#b3372f',
};

/** 仅生效中的占用参与剩余量计算与定版 */
export function activeAllocations(pot: Pick<RoastPot, 'allocations'>): PotAllocation[] {
  return pot.allocations.filter((item) => item.state === 'active');
}

/** 生效占用合计（kg，保留 3 位小数） */
export function occupiedKg(pot: Pick<RoastPot, 'allocations'>): number {
  const sum = activeAllocations(pot).reduce((acc, item) => acc + (Number.isFinite(item.occupyKg) ? item.occupyKg : 0), 0);
  return Math.round(sum * 1000) / 1000;
}

/** 可占用剩余成品 = 成品 - 留样 - 已生效占用（留样不参与拼配，保留 3 位小数） */
export function availableKg(pot: Pick<RoastPot, 'productKg' | 'sampleKg' | 'allocations'>): number {
  const remain = (pot.productKg || 0) - (pot.sampleKg || 0) - occupiedKg(pot);
  return Math.round(remain * 1000) / 1000;
}

/** 已核销重量合计：成品 + 留样 + 损耗 */
export function verifiedTotalKg(pot: Pick<RoastPot, 'productKg' | 'sampleKg' | 'lossKg'>): number {
  return Math.round(((pot.productKg || 0) + (pot.sampleKg || 0) + (pot.lossKg || 0)) * 1000) / 1000;
}

/** 核销校验结果 */
export interface PotVerifyCheck {
  ok: boolean;
  message: string;
}

/** 核销登记校验：各项非负且合计不超过投豆量 */
export function checkPotWeights(input: {
  chargeKg: number;
  productKg: number;
  sampleKg: number;
  lossKg: number;
}): PotVerifyCheck {
  const { chargeKg, productKg, sampleKg, lossKg } = input;
  if (![productKg, sampleKg, lossKg].every((value) => Number.isFinite(value) && value >= 0)) {
    return { ok: false, message: '成品、留样、损耗都必须是非负数字' };
  }
  const total = Math.round((productKg + sampleKg + lossKg) * 1000) / 1000;
  if (total > chargeKg + 1e-6) {
    return { ok: false, message: `成品+留样+损耗 ${total}kg 超出投豆量 ${chargeKg}kg` };
  }
  if (productKg <= 0) {
    return { ok: false, message: '成品重量需大于 0，没有成品的锅次请直接报废' };
  }
  return { ok: true, message: '核销重量校验通过' };
}

/**
 * 占用上限校验：某方案再追加 occupyKg 后，生效占用合计不得超过可占用剩余。
 * excludeBlendId 用于同一方案重新认领（覆盖旧占用）时排除自身。
 */
export function checkAllocationCapacity(
  pot: Pick<RoastPot, 'productKg' | 'sampleKg' | 'allocations'>,
  occupyKg: number,
  excludeBlendId?: string,
): PotVerifyCheck {
  if (!Number.isFinite(occupyKg) || occupyKg < 0) {
    return { ok: false, message: '占用重量必须是非负数字' };
  }
  const others = activeAllocations(pot)
    .filter((item) => item.id !== excludeBlendId && item.blendId !== excludeBlendId)
    .reduce((acc, item) => acc + item.occupyKg, 0);
  const capacity = Math.round(((pot.productKg || 0) - (pot.sampleKg || 0) - others) * 1000) / 1000;
  if (occupyKg > capacity + 1e-6) {
    return {
      ok: false,
      message: `占用 ${roundKg3(occupyKg)}kg 超过该锅剩余可占用成品 ${Math.max(capacity, 0)}kg`,
    };
  }
  return { ok: true, message: '占用容量校验通过' };
}

export function roundKg3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
