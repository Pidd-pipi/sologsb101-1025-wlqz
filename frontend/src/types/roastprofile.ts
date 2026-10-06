/**
 * RoastProfile 烘焙记录 · 机型/载量/入豆温/风门火力档
 * 动作：新建后逐点录入曲线事件并生成发展率；状态流转「记录中 → 已完成 / 作废」。
 * 同时定义 MachineTemplate（机型 + 风门 + 火力档 + 常用载量模板），归本文件职责。
 */
export type Airflow = 'closed' | 'half' | 'open';
export type RoastState = 'recording' | 'done' | 'void';

/**
 * 排产状态：机台当天容量不足时新锅次进入排队（queued），不占用当天容量；
 * 容量释放（记录作废 / 日期改期）后按排队顺序 admit（scheduled）。
 * 排队中的锅次不产生成品，锅次台账里也不会出现。
 */
export type ScheduleStatus = 'scheduled' | 'queued';

export interface RoastProfile {
  id: string;
  /** 关联生豆 */
  greenBeanId: string;
  /** 机型号 */
  machineModel: string;
  /** 载量（克） */
  chargeG: number;
  /** 入豆温（℃） */
  chargeTempC: number;
  /** 风门：关 / 半开 / 全开 */
  airflow: Airflow;
  /** 火力档 1-6 */
  gasLevel: number;
  /** 烘焙日期（YYYY-MM-DD） */
  roastedAt: string;
  /** 状态：记录中 / 已完成 / 作废 */
  state: RoastState;
  /** 排产：已排产 / 排队中（机台当天容量不足） */
  scheduleStatus: ScheduleStatus;
  /** 排队序号：queued 时按该序号依次递补，scheduled 时为 0 */
  queueOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type RoastProfileDraft = Omit<RoastProfile, 'id' | 'createdAt' | 'updatedAt'>;

/** 机型 + 风门 + 火力档 + 常用载量模板（/machines 维护，/curves 建单时复用） */
export interface MachineTemplate {
  id: string;
  /** 机型号 */
  model: string;
  /** 默认风门 */
  airflow: Airflow;
  /** 默认火力档 */
  gasLevel: number;
  /** 常用载量（克） */
  chargeG: number;
  /**
   * 机台当天容量（克）：同机台、同烘焙日期的「已排产且未作废」锅次载量合计不得超过该值；
   * 为空或 0 表示不限制。容量不足时新批次进入排队。
   */
  dailyCapacityG: number | null;
  /** 备注：如「满锅」「样品烘焙」 */
  note: string;
  createdAt: string;
  updatedAt: string;
}

export type MachineTemplateDraft = Omit<MachineTemplate, 'id' | 'createdAt' | 'updatedAt'>;

export const AIRFLOW_LABEL: Record<Airflow, string> = {
  closed: '关',
  half: '半开',
  open: '全开',
};

export const AIRFLOW_COLOR: Record<Airflow, string> = {
  closed: '#8c8c8c',
  half: '#c9963c',
  open: '#3b7ea1',
};

export const AIRFLOW_ORDER: Airflow[] = ['closed', 'half', 'open'];

export const AIRFLOW_OPTIONS = AIRFLOW_ORDER.map((value) => ({ value, label: AIRFLOW_LABEL[value] }));

/** 火力档位（1 最小 → 6 最大） */
export const GAS_LEVEL_OPTIONS = [1, 2, 3, 4, 5, 6].map((value) => ({ value, label: `${value} 档` }));

export const ROAST_STATE_LABEL: Record<RoastState, string> = {
  recording: '记录中',
  done: '已完成',
  void: '作废',
};

export const ROAST_STATE_COLOR: Record<RoastState, string> = {
  recording: '#c9963c',
  done: '#2f6f4f',
  void: '#b3372f',
};

export const ROAST_STATE_ORDER: RoastState[] = ['recording', 'done', 'void'];

export const ROAST_STATE_OPTIONS = ROAST_STATE_ORDER.map((value) => ({
  value,
  label: ROAST_STATE_LABEL[value],
}));

/** 状态流转：记录中 → 已完成 / 作废；已完成可再作废；作废可恢复为记录中 */
export const ROAST_STATE_FLOW: Record<RoastState, RoastState[]> = {
  recording: ['done', 'void'],
  done: ['void'],
  void: ['recording'],
};

/** 常用机型号候选 */
export const MACHINE_MODEL_OPTIONS = [
  'HB-M6',
  'Giesen W6A',
  'Probat P12',
  'Mill City 500g',
  '三豆客 R500',
  '自家改装 1kg',
];

export const MACHINE_MODEL_FALLBACK = MACHINE_MODEL_OPTIONS[0];

export const SCHEDULE_STATUS_LABEL: Record<ScheduleStatus, string> = {
  scheduled: '已排产',
  queued: '排队中',
};

export const SCHEDULE_STATUS_COLOR: Record<ScheduleStatus, string> = {
  scheduled: '#2f6f4f',
  queued: '#3b7ea1',
};

/**
 * 机台当天容量判定：
 * 统计同机台、同日期「已排产（scheduled）且未作废（state !== 'void'）」的载量合计，
 * 追加 additionalG 后是否仍不超过容量。容量为空 / 0 表示不限量。
 */
export function isWithinDailyCapacity(input: {
  dailyCapacityG: number | null | undefined;
  scheduledChargeTotalG: number;
  additionalG: number;
}): boolean {
  const capacity = input.dailyCapacityG ?? 0;
  if (!Number.isFinite(capacity) || capacity <= 0) return true;
  return input.scheduledChargeTotalG + input.additionalG <= capacity + 1e-6;
}

/** 当天剩余容量（克）；不限量时返回 null */
export function remainingDailyCapacityG(dailyCapacityG: number | null | undefined, scheduledChargeTotalG: number): number | null {
  const capacity = dailyCapacityG ?? 0;
  if (!Number.isFinite(capacity) || capacity <= 0) return null;
  return Math.max(0, Math.round((capacity - scheduledChargeTotalG) * 100) / 100);
}

/** 载量分档提示：用于机型页的载量区间参考 */
export function chargeLevelOf(chargeG: number): 'sample' | 'standard' | 'full' {
  if (chargeG < 250) return 'sample';
  if (chargeG < 700) return 'standard';
  return 'full';
}

export const CHARGE_LEVEL_LABEL: Record<'sample' | 'standard' | 'full', string> = {
  sample: '样品烘焙',
  standard: '常规载量',
  full: '满锅载量',
};
