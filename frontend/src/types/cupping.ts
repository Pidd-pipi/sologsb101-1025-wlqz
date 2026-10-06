/**
 * Cupping 杯测 · 干香/湿香/酸质/甜感/余韵五项
 * 动作：分项加权算总分（totalScore），并按分档给出结论标签。
 */
export interface Cupping {
  id: string;
  /** 关联烘焙记录 */
  profileId: string;
  /** 杯测日期（YYYY-MM-DD） */
  cuppedAt: string;
  /** 干香 0-10 */
  dryAroma: number;
  /** 湿香 0-10 */
  wetAroma: number;
  /** 酸质 0-10 */
  acidity: number;
  /** 甜感 0-10 */
  sweetness: number;
  /** 余韵 0-10 */
  aftertaste: number;
  /** 加权总分 0-100 */
  totalScore: number;
  createdAt: string;
  updatedAt: string;
}

export type CuppingDraft = Omit<Cupping, 'id' | 'totalScore' | 'createdAt' | 'updatedAt'>;

export type CuppingField = 'dryAroma' | 'wetAroma' | 'acidity' | 'sweetness' | 'aftertaste';

export interface CuppingFieldMeta {
  key: CuppingField;
  label: string;
  /** 权重（合计 1） */
  weight: number;
  hint: string;
}

/** 分项权重：酸质与甜感占比更高，符合烘焙复盘的关注点 */
export const CUPPING_FIELDS: CuppingFieldMeta[] = [
  { key: 'dryAroma', label: '干香', weight: 0.15, hint: '研磨后干粉香气' },
  { key: 'wetAroma', label: '湿香', weight: 0.2, hint: '注水破渣后的湿香' },
  { key: 'acidity', label: '酸质', weight: 0.25, hint: '酸的质量与明亮度' },
  { key: 'sweetness', label: '甜感', weight: 0.25, hint: '甜度与回甘' },
  { key: 'aftertaste', label: '余韵', weight: 0.15, hint: '吞咽后风味留存' },
];

export const CUPPING_WEIGHTS: Record<CuppingField, number> = CUPPING_FIELDS.reduce(
  (acc, field) => ({ ...acc, [field.key]: field.weight }),
  {} as Record<CuppingField, number>,
);

export type CuppingParts = Record<CuppingField, number>;

/** 单项得分归一化到 0-10（保留 2 位小数） */
export function normalizePartScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(10, Math.max(0, Math.round(value * 100) / 100));
}

/** 分项加权总分：Σ(分项 × 权重) × 10 → 0-100 */
export function weightedTotalScore(parts: CuppingParts): number {
  const sum = CUPPING_FIELDS.reduce((acc, field) => acc + normalizePartScore(parts[field.key]) * field.weight, 0);
  return Math.round(sum * 10 * 10) / 10;
}

export interface CuppingGrade {
  min: number;
  label: string;
  color: string;
  conclusion: string;
}

/** 分档结论：从高到低匹配第一个满足 min 的档位 */
export const CUPPING_GRADES: CuppingGrade[] = [
  { min: 90, label: '卓越', color: '#7a4b8f', conclusion: '风味层次完整，可作为定版拼配基底' },
  { min: 85, label: '优秀', color: '#2f6f4f', conclusion: '烘焙曲线稳定，可列入常规出品' },
  { min: 80, label: '良好', color: '#3b7ea1', conclusion: '结构平衡，微调发展率后可复测' },
  { min: 75, label: '合格', color: '#c9963c', conclusion: '存在瑕疵倾向，建议调整火力曲线' },
  { min: 0, label: '待改进', color: '#b3372f', conclusion: '风味缺陷明显，建议重烘或另作拼配填充' },
];

export function cuppingGradeOf(score: number): CuppingGrade {
  return CUPPING_GRADES.find((grade) => score >= grade.min) ?? CUPPING_GRADES[CUPPING_GRADES.length - 1];
}

export const CUPPING_GRADE_OPTIONS = CUPPING_GRADES.map((grade) => ({
  value: grade.label,
  label: `${grade.label}（≥${grade.min}）`,
}));

/** 从杯测记录提取分项，便于加权复算 */
export function partsOf(cupping: Pick<Cupping, CuppingField>): CuppingParts {
  return {
    dryAroma: cupping.dryAroma,
    wetAroma: cupping.wetAroma,
    acidity: cupping.acidity,
    sweetness: cupping.sweetness,
    aftertaste: cupping.aftertaste,
  };
}

/** 求一组杯测均分（用于拼配方案回显） */
export function averageScore(cuppings: Pick<Cupping, 'totalScore'>[]): number {
  if (cuppings.length === 0) return 0;
  return Math.round((cuppings.reduce((acc, item) => acc + item.totalScore, 0) / cuppings.length) * 10) / 10;
}

/**
 * 杯测通过线：总分 ≥ 80（良好档下限）才算杯测通过。
 * 锅次核销后定版时，只允许使用「已核销且杯测通过」的锅次。
 */
export const CUPPING_PASS_SCORE = 80;

export function isCuppingPassed(score: number): boolean {
  return Number.isFinite(score) && score >= CUPPING_PASS_SCORE;
}

/** 某锅次最新一笔杯测（按杯测日期倒序，没有则 undefined） */
export function latestCuppingOf<T extends Pick<Cupping, 'cuppedAt'>>(cuppings: T[]): T | undefined {
  if (cuppings.length === 0) return undefined;
  return [...cuppings].sort((a, b) => b.cuppedAt.localeCompare(a.cuppedAt))[0];
}

/**
 * 锅次杯测签名：杯测笔数 + 按日期升序的总分序列。
 * 杯测分数（含新增 / 删除杯测）一旦改动，签名就变化，占用据此判定失效重认。
 */
export function cuppingSignatureOf(cuppings: Array<Pick<Cupping, 'cuppedAt' | 'totalScore'>>): string {
  const ordered = [...cuppings].sort((a, b) => a.cuppedAt.localeCompare(b.cuppedAt));
  return `${ordered.length}:${ordered.map((item) => item.totalScore).join('/')}`;
}
