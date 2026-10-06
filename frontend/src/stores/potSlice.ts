/**
 * 锅次核销 slice：维护锅次台账（成品 / 留样 / 损耗）、方案占用派生、
 * 核销 / 报废 / 重新认领 / 旧数据补认动作。
 *
 * 占用规则见 utils/pot.ts：只有已核销且杯测通过的锅次才能生效占用，
 * 累计占用不超过「成品 - 留样」；杯测改动后试配方案转待替换，定版只留提醒。
 */
import { createAsyncThunk, createSelector, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Cupping } from '../types/cupping';
import { latestCuppingOf } from '../types/cupping';
import type { PotStatus, RoastPot } from '../types/pot';
import { availableKg, occupiedKg, verifiedTotalKg } from '../types/pot';
import type { RoastProfile } from '../types/roastprofile';
import type { Blend } from '../types/blend';
import {
  listRoastPots,
  recognizeLegacyBlendsNow,
  removeRoastPot,
  verifyRoastPot,
  voidRoastPot,
  type PotVerifyInput,
} from '../utils/db';
import { rebuildAllocations, type BlendRebuildReport, type ItemAllocationReport } from '../utils/pot';
import type { RootState } from './store';

export interface PotFilters {
  keyword: string;
  statuses: PotStatus[];
}

interface PotStateShape {
  pots: RoastPot[];
  loading: boolean;
  error: string;
  notice: string;
  filters: PotFilters;
}

const initialState: PotStateShape = {
  pots: [],
  loading: false,
  error: '',
  notice: '',
  filters: { keyword: '', statuses: [] },
};

export const fetchRoastPots = createAsyncThunk('pots/fetchAll', async () => listRoastPots());

export const verifyPot = createAsyncThunk(
  'pots/verify',
  async (input: { profileId: string; draft: PotVerifyInput }) => {
    const result = await verifyRoastPot(input.profileId, input.draft);
    if (!result.ok) throw new Error(result.message);
    return listRoastPots();
  },
);

export const voidPot = createAsyncThunk('pots/void', async (input: { profileId: string; reason?: string }) => {
  const result = await voidRoastPot(input.profileId, input.reason);
  if (!result.ok) throw new Error(result.message);
  return listRoastPots();
});

export const deletePot = createAsyncThunk('pots/remove', async (id: string) => {
  await removeRoastPot(id);
  return listRoastPots();
});

/** 旧数据补认：无锅次来源方案按豆源 + 日期补认 */
export const recognizeLegacy = createAsyncThunk('pots/recognizeLegacy', async () => {
  const result = await recognizeLegacyBlendsNow();
  return { pots: await listRoastPots(), recognized: result.recognized, notes: result.notes };
});

const potSlice = createSlice({
  name: 'pots',
  initialState,
  reducers: {
    setPotFilters(state, action: PayloadAction<Partial<PotFilters>>) {
      state.filters = { ...state.filters, ...action.payload };
    },
    resetPotFilters(state) {
      state.filters = { keyword: '', statuses: [] };
    },
    clearPotNotice(state) {
      state.notice = '';
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchRoastPots.pending, (state) => {
        state.loading = true;
        state.error = '';
      })
      .addCase(fetchRoastPots.fulfilled, (state, action) => {
        state.loading = false;
        state.pots = action.payload;
      })
      .addCase(fetchRoastPots.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? '锅次台账读取失败';
      })
      .addCase(verifyPot.fulfilled, (state, action) => {
        state.loading = false;
        state.pots = action.payload;
        state.notice = '锅次已核销，方案占用已重新认领';
      })
      .addCase(verifyPot.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? '锅次核销失败';
      })
      .addCase(voidPot.fulfilled, (state, action) => {
        state.pots = action.payload;
        state.notice = '锅次已报废，相关试配方案已转待替换';
      })
      .addCase(voidPot.rejected, (state, action) => {
        state.error = action.error.message ?? '锅次报废失败';
      })
      .addCase(deletePot.fulfilled, (state, action) => {
        state.pots = action.payload;
        state.notice = '锅次台账记录已删除';
      })
      .addCase(recognizeLegacy.fulfilled, (state, action) => {
        state.loading = false;
        state.pots = action.payload.pots;
        state.notice =
          action.payload.recognized > 0 ? `旧数据补认完成：${action.payload.recognized} 个方案已补认锅次` : '旧数据补认完成：没有可补认的方案';
      })
      .addCase(recognizeLegacy.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? '旧数据补认失败';
      });
  },
});

export const { setPotFilters, resetPotFilters, clearPotNotice } = potSlice.actions;

export const selectPotState = (state: RootState): PotStateShape => state.pots;

export interface PotRow extends RoastPot {
  origin: string;
  farm: string;
  profileState: RoastProfile['state'] | 'missing';
  occupiedKg: number;
  availableKg: number;
  verifiedTotalKg: number;
  /** 生效占用的方案数 */
  activeBlendCount: number;
  /** 失效占用的方案数 */
  staleBlendCount: number;
  latestScore: number | null;
}

/** 锅次台账行：联表生豆 / 烘焙记录 / 杯测，派生占用与剩余 */
export const selectPotRows = createSelector(
  [
    selectPotState,
    (state: RootState) => state.roasts.profiles,
    (state: RootState) => state.beans.greenBeans,
    (state: RootState) => state.cuppings.cuppings,
  ],
  (potState, profiles, beans, cuppings): PotRow[] => {
    const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));
    const beanMap = new Map(beans.map((bean) => [bean.id, bean]));
    const cuppingsByProfile = new Map<string, Cupping[]>();
    cuppings.forEach((cupping) => {
      const list = cuppingsByProfile.get(cupping.profileId) ?? [];
      list.push(cupping);
      cuppingsByProfile.set(cupping.profileId, list);
    });
    return potState.pots.map((pot) => {
      const profile = profileMap.get(pot.profileId);
      const bean = beanMap.get(pot.greenBeanId);
      const potCuppings = cuppingsByProfile.get(pot.profileId) ?? [];
      return {
        ...pot,
        origin: bean?.origin ?? '（生豆已删除）',
        farm: bean?.farm ?? '',
        profileState: profile ? profile.state : 'missing',
        occupiedKg: occupiedKg(pot),
        availableKg: availableKg(pot),
        verifiedTotalKg: verifiedTotalKg(pot),
        activeBlendCount: pot.allocations.filter((item) => item.state === 'active').length,
        staleBlendCount: pot.allocations.filter((item) => item.state === 'stale').length,
        latestScore: latestCuppingOf(potCuppings)?.totalScore ?? pot.lastScore,
      };
    });
  },
);

/** 关键字 + 状态过滤 */
export const selectFilteredPotRows = createSelector([selectPotRows, selectPotState], (rows, potState) => {
  const { keyword, statuses } = potState.filters;
  const needle = keyword.trim().toLowerCase();
  return rows.filter((row) => {
    if (needle) {
      const haystack = `${row.machineModel} ${row.origin} ${row.farm} ${row.roastedAt} ${row.note}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    if (statuses.length > 0 && !statuses.includes(row.status)) return false;
    return true;
  });
});

/**
 * 基于当前全量数据重算占用报告（页面实时派生，不写库）。
 * 锅次页 / 拼配页共用同一份方案-锅次占用视图。
 */
export const selectAllocationContext = createSelector(
  [
    (state: RootState) => state.blends.blends,
    selectPotState,
    (state: RootState) => state.roasts.profiles,
    (state: RootState) => state.cuppings.cuppings,
  ],
  (blends, potState, profiles, cuppings) =>
    rebuildAllocations({
      blends: blends.map((blend: Blend) => ({ ...blend })),
      pots: potState.pots,
      profiles,
      cuppings,
      now: ':derive:',
    }),
);

export const selectBlendReportMap = createSelector(
  [selectAllocationContext],
  (context): Map<string, BlendRebuildReport> => context.reports,
);

export function selectBlendReport(blendId: string) {
  return (state: RootState): BlendRebuildReport | undefined => selectBlendReportMap(state).get(blendId);
}

export interface PotStats {
  total: number;
  pending: number;
  verified: number;
  voided: number;
  staleBlends: number;
  productKg: number;
  availableKg: number;
}

export const selectPotStats = createSelector([selectPotRows], (rows): PotStats => {
  const sum = (values: number[]): number => Math.round(values.reduce((acc, value) => acc + value, 0) * 1000) / 1000;
  return {
    total: rows.length,
    pending: rows.filter((row) => row.status === 'pending').length,
    verified: rows.filter((row) => row.status === 'verified').length,
    voided: rows.filter((row) => row.status === 'void').length,
    staleBlends: new Set(
      rows.flatMap((row) => row.allocations.filter((item) => item.state === 'stale').map((item) => item.blendId)),
    ).size,
    productKg: sum(rows.filter((row) => row.status === 'verified').map((row) => row.productKg)),
    availableKg: sum(rows.map((row) => Math.max(row.availableKg, 0))),
  };
});

export type { BlendRebuildReport, ItemAllocationReport };

export default potSlice.reducer;
