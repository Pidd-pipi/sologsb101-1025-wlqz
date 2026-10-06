/**
 * 拼配 slice：维护拼配方案列表、配方成分草稿（生豆/烘焙记录/占比%）与占比合计校验，
 * 并回显参与批次杯测均分；支持方案状态流转「试配 → 定版 → 停用」。
 */
import { createAsyncThunk, createSelector, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Blend, BlendDraft, BlendItem, BlendState } from '../types/blend';
import {
  BLEND_STATE_ORDER,
  DEFAULT_TARGET_BATCH_KG,
  TARGET_BATCH_MAX_KG,
  TARGET_BATCH_MIN_KG,
  createEmptyBlendItem,
  isRatioValid,
  joinFlavors,
  splitFlavors,
  totalRatioPct,
} from '../types/blend';
import { averageScore } from '../types/cupping';
import { rebuildAllocations } from '../utils/pot';
import {
  createId,
  listBlends,
  listCuppings,
  listRoastPots,
  listRoastProfiles,
  nowIso,
  putBlend,
  reconcileAllocationsNow,
  reconfirmBlendNow,
  removeBlend,
} from '../utils/db';
import { checkBlendFinalizable } from '../utils/pot';
import type { RootState } from './store';
import { fetchRoastPots } from './potSlice';

export type RatioFlag = 'valid' | 'invalid';

export interface BlendFilters {
  keyword: string;
  states: BlendState[];
  flavors: string[];
  ratio: RatioFlag[];
}

/** 配方草稿（跨页共享：拼配页表单与校验） */
export interface BlendDraftState {
  name: string;
  items: BlendItem[];
  /** 目标风味（多选，提交时以「、」连接为字符串） */
  targetFlavor: string[];
  /** 目标批量（kg），按占比折算每口锅的占用 */
  targetBatchKg: number;
  createdAt: string;
  state: BlendState;
}

interface BlendStateShape {
  blends: Blend[];
  loading: boolean;
  error: string;
  filters: BlendFilters;
  draft: BlendDraftState;
  editingId: string | null;
  notice: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export const emptyBlendDraft = (): BlendDraftState => ({
  name: '',
  items: [createEmptyBlendItem()],
  targetFlavor: [],
  targetBatchKg: DEFAULT_TARGET_BATCH_KG,
  createdAt: today(),
  state: 'trial',
});

export const initialBlendFilters: BlendFilters = {
  keyword: '',
  states: [],
  flavors: [],
  ratio: [],
};

const initialState: BlendStateShape = {
  blends: [],
  loading: false,
  error: '',
  filters: initialBlendFilters,
  draft: emptyBlendDraft(),
  editingId: null,
  notice: '',
};

export const fetchBlends = createAsyncThunk('blends/fetchAll', async () => listBlends());

export const createBlend = createAsyncThunk('blends/create', async (draft: BlendDraftState, { dispatch }) => {
  const blocked = await ensureFinalizableIfNeeded({ id: null, draft });
  if (blocked) throw new Error(blocked);
  const stamp = nowIso();
  const row: Blend = {
    id: createId('bl'),
    name: draft.name.trim(),
    items: draft.items.map((item) => ({ ...item, ratioPct: Math.round(item.ratioPct * 100) / 100 })),
    targetFlavor: joinFlavors(draft.targetFlavor),
    targetBatchKg: normalizeBatchKg(draft.targetBatchKg),
    pendingReplace: false,
    createdAt: draft.createdAt,
    state: draft.state,
    updatedAt: stamp,
  };
  await putBlend(row);
  // 新建后按当前锅次 / 杯测重算占用（容量不足或杯测未过 → 试配方案转待替换）
  await reconcileAllocationsNow();
  await dispatch(fetchRoastPots());
  return listBlends();
});

export const updateBlend = createAsyncThunk(
  'blends/update',
  async (input: { id: string; draft: BlendDraftState }, { dispatch }) => {
    const blocked = await ensureFinalizableIfNeeded({ id: input.id, draft: input.draft });
    if (blocked) throw new Error(blocked);
    const stamp = nowIso();
    const existing = (await listBlends()).find((blend) => blend.id === input.id);
    const row: Blend = {
      id: input.id,
      name: input.draft.name.trim(),
      items: input.draft.items.map((item) => ({ ...item, ratioPct: Math.round(item.ratioPct * 100) / 100 })),
      targetFlavor: joinFlavors(input.draft.targetFlavor),
      targetBatchKg: normalizeBatchKg(input.draft.targetBatchKg),
      // 配方 / 批量变更后先清掉旧的待替换标记，由对账重新判定
      pendingReplace: false,
      createdAt: input.draft.createdAt,
      state: input.draft.state,
      updatedAt: stamp,
    };
    void existing;
    await putBlend(row);
    await reconcileAllocationsNow();
    await dispatch(fetchRoastPots());
    return listBlends();
  },
);

export const deleteBlend = createAsyncThunk('blends/remove', async (id: string, { dispatch }) => {
  await removeBlend(id);
  await reconcileAllocationsNow();
  await dispatch(fetchRoastPots());
  return listBlends();
});

export interface AdvanceStateResult {
  blends: Blend[];
  /** 定版校验不通过时的原因列表 */
  blocked: string[];
}

/**
 * 方案状态流转。定版（trial → final）有硬门槛：
 * 每个成分都必须占用「已核销且杯测通过」的锅次，否则拒绝并给出原因；
 * 已定版方案只做提醒，不允许因此被强制下线。
 */
export const advanceBlendState = createAsyncThunk<
  AdvanceStateResult,
  { id: string; state: BlendState },
  { rejectValue: string }
>('blends/advanceState', async (input, { rejectWithValue, dispatch }) => {
  const existing = (await listBlends()).find((blend) => blend.id === input.id);
  if (!existing) return { blends: await listBlends(), blocked: [] };
  if (input.state === 'final') {
    const [pots, profiles, cuppings] = await Promise.all([listRoastPots(), listRoastProfiles(), listCuppings()]);
    const check = checkBlendFinalizable({ blend: existing, pots, profiles, cuppings });
    if (!check.ok) {
      return rejectWithValue(`定版被拦截：${check.messages.join('；')}`);
    }
  }
  await putBlend({ ...existing, state: input.state, pendingReplace: false, updatedAt: nowIso() });
  await reconcileAllocationsNow();
  await dispatch(fetchRoastPots());
  return { blends: await listBlends(), blocked: [] };
});

/** 杯测分数改动后试配方案「重新认领」失效占用；全部成分通过才解除待替换 */
export const reconfirmBlend = createAsyncThunk<
  { blends: Blend[]; messages: string[] },
  string,
  { rejectValue: { blends: Blend[]; messages: string[] } }
>('blends/reconfirm', async (blendId, { rejectWithValue, dispatch }) => {
  const result = await reconfirmBlendNow(blendId);
  const blends = await listBlends();
  await dispatch(fetchRoastPots());
  if (!result.ok) return rejectWithValue({ blends, messages: result.messages });
  return { blends, messages: result.messages };
});

/** 导入单个方案 JSON（已通过 parseBlendJson 校验）；定版门槛不足时自动降级为试配 */
export const importBlendDraft = createAsyncThunk('blends/import', async (draft: BlendDraft, { dispatch }) => {
  const stamp = nowIso();
  let state = draft.state;
  if (state === 'final') {
    const [pots, profiles, cuppings] = await Promise.all([listRoastPots(), listRoastProfiles(), listCuppings()]);
    const candidate: Blend = {
      ...draft,
      targetBatchKg: normalizeBatchKg(draft.targetBatchKg),
      id: 'pending',
      updatedAt: stamp,
    };
    const check = checkBlendFinalizable({ blend: candidate, pots, profiles, cuppings });
    if (!check.ok) state = 'trial';
  }
  const row: Blend = {
    ...draft,
    state,
    targetBatchKg: normalizeBatchKg(draft.targetBatchKg),
    pendingReplace: false,
    id: createId('bl'),
    updatedAt: stamp,
  };
  await putBlend(row);
  await reconcileAllocationsNow();
  await dispatch(fetchRoastPots());
  return listBlends();
});

/** 目标批量归一化（kg，限制在 0.1 - 100，非法值兜底 1kg） */
export function normalizeBatchKg(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TARGET_BATCH_KG;
  const rounded = Math.round(value * 1000) / 1000;
  return Math.min(TARGET_BATCH_MAX_KG, Math.max(TARGET_BATCH_MIN_KG, rounded));
}

/**
 * 保存方案时的定版门槛兜底：从「试配 / 新建」直接落成「定版」必须每口锅已核销且杯测通过；
 * 已经是定版的方案编辑不拦截（后续异常只给提醒，与状态流转按钮共用 checkBlendFinalizable）。
 * 返回通过时为 null，否则返回拒绝原因。
 */
async function ensureFinalizableIfNeeded(input: {
  id: string | null;
  draft: BlendDraftState;
}): Promise<string | null> {
  if (input.draft.state !== 'final') return null;
  const existing = input.id ? (await listBlends()).find((blend) => blend.id === input.id) : undefined;
  if (existing?.state === 'final') return null;
  const [pots, profiles, cuppings] = await Promise.all([listRoastPots(), listRoastProfiles(), listCuppings()]);
  const candidate: Blend = {
    id: input.id ?? 'pending',
    name: input.draft.name.trim(),
    items: input.draft.items,
    targetFlavor: joinFlavors(input.draft.targetFlavor),
    targetBatchKg: normalizeBatchKg(input.draft.targetBatchKg),
    pendingReplace: false,
    createdAt: input.draft.createdAt,
    state: 'final',
    updatedAt: nowIso(),
  };
  const check = checkBlendFinalizable({ blend: candidate, pots, profiles, cuppings });
  return check.ok ? null : `该方案不能直接保存为「定版」：${check.messages.join('；')}`;
}

const blendSlice = createSlice({
  name: 'blends',
  initialState,
  reducers: {
    setBlendFilters(state, action: PayloadAction<Partial<BlendFilters>>) {
      state.filters = { ...state.filters, ...action.payload };
    },
    resetBlendFilters(state) {
      state.filters = initialBlendFilters;
    },
    setBlendDraftField(
      state,
      action: PayloadAction<{
        field: 'name' | 'createdAt' | 'state' | 'targetFlavor' | 'targetBatchKg';
        value: string | string[] | BlendState | number;
      }>,
    ) {
      const { field, value } = action.payload;
      switch (field) {
        case 'name':
          state.draft.name = String(value);
          break;
        case 'createdAt':
          state.draft.createdAt = String(value);
          break;
        case 'state':
          state.draft.state = value as BlendState;
          break;
        case 'targetFlavor':
          state.draft.targetFlavor = Array.isArray(value) ? value : splitFlavors(String(value));
          break;
        case 'targetBatchKg':
          state.draft.targetBatchKg = normalizeBatchKg(Number(value));
          break;
        default:
          break;
      }
    },
    /** 用表单当前值整体覆盖配方草稿（Form.List 变更时同步） */
    setDraftItems(state, action: PayloadAction<BlendItem[]>) {
      state.draft.items = action.payload;
    },
    addDraftItem(state) {
      state.draft.items = [...state.draft.items, createEmptyBlendItem()];
    },
    updateDraftItem(state, action: PayloadAction<{ index: number; patch: Partial<BlendItem> }>) {
      const { index, patch } = action.payload;
      state.draft.items = state.draft.items.map((item, position) =>
        position === index ? { ...item, ...patch } : item,
      );
    },
    removeDraftItem(state, action: PayloadAction<number>) {
      state.draft.items = state.draft.items.filter((_item, position) => position !== action.payload);
    },
    /** 平均分配占比：一键把合计凑到 100% */
    balanceDraftItems(state) {
      const count = state.draft.items.length;
      if (count === 0) return;
      const base = Math.floor((100 / count) * 100) / 100;
      const rest = Math.round((100 - base * count) * 100) / 100;
      state.draft.items = state.draft.items.map((item, index) => ({
        ...item,
        ratioPct: index === 0 ? Math.round((base + rest) * 100) / 100 : base,
      }));
    },
    resetBlendDraft(state) {
      state.draft = emptyBlendDraft();
      state.editingId = null;
    },
    loadBlendDraft(state, action: PayloadAction<Blend>) {
      const blend = action.payload;
      state.draft = {
        name: blend.name,
        items: blend.items.length > 0 ? blend.items.map((item) => ({ ...item })) : [createEmptyBlendItem()],
        targetFlavor: splitFlavors(blend.targetFlavor),
        targetBatchKg: blend.targetBatchKg || DEFAULT_TARGET_BATCH_KG,
        createdAt: blend.createdAt,
        state: blend.state,
      };
      state.editingId = blend.id;
    },
    clearBlendNotice(state) {
      state.notice = '';
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchBlends.pending, (state) => {
        state.loading = true;
        state.error = '';
      })
      .addCase(fetchBlends.fulfilled, (state, action) => {
        state.loading = false;
        state.blends = action.payload;
      })
      .addCase(fetchBlends.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? '拼配方案读取失败';
      })
      .addCase(createBlend.fulfilled, (state, action) => {
        state.loading = false;
        state.blends = action.payload;
        state.draft = emptyBlendDraft();
        state.notice = '拼配方案已保存';
      })
      .addCase(createBlend.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? '拼配方案保存失败';
      })
      .addCase(updateBlend.fulfilled, (state, action) => {
        state.loading = false;
        state.blends = action.payload;
        state.editingId = null;
        state.notice = '拼配方案已更新';
      })
      .addCase(updateBlend.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? '拼配方案更新失败';
      })
      .addCase(deleteBlend.fulfilled, (state, action) => {
        state.blends = action.payload;
      })
      .addCase(deleteBlend.rejected, (state, action) => {
        state.error = action.error.message ?? '拼配方案删除失败';
      })
      .addCase(advanceBlendState.fulfilled, (state, action) => {
        state.blends = action.payload.blends;
        state.notice = '方案状态已流转';
      })
      .addCase(advanceBlendState.rejected, (state, action) => {
        state.error = action.payload ?? action.error.message ?? '方案状态流转失败';
        state.notice = action.payload ?? '';
      })
      .addCase(reconfirmBlend.fulfilled, (state, action) => {
        state.blends = action.payload.blends;
        state.notice = '失效占用已重新认领，方案解除待替换';
      })
      .addCase(reconfirmBlend.rejected, (state, action) => {
        state.blends = action.payload?.blends ?? state.blends;
        state.error = action.payload?.messages.join('；') ?? '重新认领失败';
      })
      .addCase(importBlendDraft.fulfilled, (state, action) => {
        state.blends = action.payload;
        state.notice = '方案 JSON 已导入';
      })
      .addCase(importBlendDraft.rejected, (state, action) => {
        state.error = action.error.message ?? '方案 JSON 导入失败';
      });
  },
});

export const {
  setBlendFilters,
  resetBlendFilters,
  setBlendDraftField,
  setDraftItems,
  addDraftItem,
  updateDraftItem,
  removeDraftItem,
  balanceDraftItems,
  resetBlendDraft,
  loadBlendDraft,
  clearBlendNotice,
} = blendSlice.actions;

export const selectBlendState = (state: RootState): BlendStateShape => state.blends;

export const selectBlendDraft = (state: RootState): BlendDraftState => state.blends.draft;

/** 草稿占比合计 */
export const selectDraftRatioTotal = createSelector([selectBlendDraft], (draft) => totalRatioPct(draft.items));

/** 草稿占比是否合规（合计 100%） */
export const selectDraftRatioValid = createSelector([selectBlendDraft], (draft) => isRatioValid(draft.items));

/** 草稿中参与批次（烘焙记录）的杯测均分 */
export const selectDraftAverageScore = createSelector(
  [selectBlendDraft, (state: RootState) => state.cuppings.cuppings],
  (draft, cuppings) => {
    const profileIds = new Set(draft.items.map((item) => item.profileId).filter(Boolean));
    const related = cuppings.filter((cupping) => profileIds.has(cupping.profileId));
    return averageScore(related);
  },
);

export interface BlendRow extends Blend {
  ratioTotal: number;
  ratioValid: boolean;
  averageScore: number;
  cuppingCount: number;
  /** 是否可定版：全部成分占用的锅次已核销且杯测通过、容量足够 */
  finalizable: boolean;
  /** 不可定版 / 定版后的提醒原因（逐项） */
  blockers: string[];
  reminders: string[];
  /** 生效占用的成分数 / 总成分数 */
  activeItemCount: number;
}

/** 拼配列表行：附占比合计、校验结果、杯测均分与锅次占用派生状态 */
export const selectBlendRows = createSelector(
  [
    selectBlendState,
    (state: RootState) => state.cuppings.cuppings,
    (state: RootState) => state.pots,
    (state: RootState) => state.roasts.profiles,
  ],
  (blendState, cuppings, potState, profiles): BlendRow[] => {
    const { reports } = rebuildAllocations({
      blends: blendState.blends.map((blend) => ({ ...blend })),
      pots: potState.pots,
      profiles,
      cuppings,
      now: ':derive:',
    });
    return blendState.blends.map((blend) => {
      const profileIds = new Set(blend.items.map((item) => item.profileId).filter(Boolean));
      const related = cuppings.filter((cupping) => profileIds.has(cupping.profileId));
      const report = reports.get(blend.id);
      const itemReports = report?.items ?? [];
      const activeItemCount = itemReports.filter((item) => item.state === 'active').length;
      const blockers = itemReports
        .map((item, index) =>
          item.state !== 'active' ? `第 ${index + 1} 项（占比 ${item.ratioPct}%）：${item.reason || '锅次占用未生效'}` : '',
        )
        .filter(Boolean);
      return {
        ...blend,
        ratioTotal: totalRatioPct(blend.items),
        ratioValid: isRatioValid(blend.items),
        averageScore: averageScore(related),
        cuppingCount: related.length,
        finalizable: itemReports.length > 0 && activeItemCount === itemReports.length,
        blockers,
        reminders: report?.reminders ?? [],
        activeItemCount,
      };
    });
  },
);

/** 关键字 + 状态 + 目标风味 + 占比校验过滤 */
export const selectFilteredBlendRows = createSelector([selectBlendRows, selectBlendState], (rows, blendState) => {
  const { keyword, states, flavors, ratio } = blendState.filters;
  const needle = keyword.trim().toLowerCase();
  return rows.filter((row) => {
    if (needle) {
      const haystack = `${row.name} ${row.targetFlavor}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    if (states.length > 0 && !states.includes(row.state)) return false;
    if (flavors.length > 0 && !splitFlavors(row.targetFlavor).some((flavor) => flavors.includes(flavor))) return false;
    if (ratio.length > 0) {
      const flag: RatioFlag = row.ratioValid ? 'valid' : 'invalid';
      if (!ratio.includes(flag)) return false;
    }
    return true;
  });
});

export const selectBlendFilterOptions = createSelector([selectBlendRows], (rows) => ({
  flavors: Array.from(new Set(rows.flatMap((row) => splitFlavors(row.targetFlavor)))).sort((a, b) =>
    a.localeCompare(b, 'zh-Hans-CN'),
  ),
  states: BLEND_STATE_ORDER,
}));

export const selectBlendStats = createSelector([selectBlendRows], (rows) => ({
  total: rows.length,
  valid: rows.filter((row) => row.ratioValid).length,
  invalid: rows.filter((row) => !row.ratioValid).length,
  finalized: rows.filter((row) => row.state === 'final').length,
  pendingReplace: rows.filter((row) => row.pendingReplace).length,
  finalizable: rows.filter((row) => row.state === 'trial' && row.finalizable).length,
  averageScore:
    rows.filter((row) => row.cuppingCount > 0).length > 0
      ? Math.round(
          (rows.filter((row) => row.cuppingCount > 0).reduce((acc, row) => acc + row.averageScore, 0) /
            rows.filter((row) => row.cuppingCount > 0).length) *
            10,
        ) / 10
      : 0,
}));

export default blendSlice.reducer;
