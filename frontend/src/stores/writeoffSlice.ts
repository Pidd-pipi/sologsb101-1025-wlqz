/**
 * 锅次核销 slice：锅次核销台账（成品/留样/损耗）、方案占用账、机台当天容量排队。
 * 与其它 slice 的协作：
 * - 杯测分数改动后调用 refreshAfterCupping，旧占用失效、试配方案转「待替换」；
 * - 定版走 finalizeBlend 闸门：只用已核销且杯测通过的锅次；
 * - 新建烘焙记录前用 evaluateQueue 判定机台当天容量是否需要下批排队。
 */
import { createAsyncThunk, createSelector, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { RoastProfile, QueueStatus } from '../types/roastprofile';
import { DEFAULT_MACHINE_DAILY_CAPACITY_G, QUEUE_STATUS_LABEL } from '../types/roastprofile';
import type { BlendState } from '../types/blend';
import type {
  OccupationState,
  PotOccupation,
  PotSettlement,
  SettlementState,
} from '../types/writeoff';
import {
  OCCUPATION_STATE_LABEL,
  OCCUPATION_STATE_ORDER,
  SETTLEMENT_STATE_ORDER,
  settlementAvailability,
} from '../types/writeoff';
import {
  backfillBlendOccupations,
  changeRoastStateWithWriteoff,
  evaluateQueueForProfile,
  finalizeBlend as finalizeBlendDb,
  listPotOccupations,
  listPotSettlements,
  nowIso,
  putPotOccupations,
  refreshOccupationsAfterCupping,
  savePotSettlement,
  setRoastQueueStatus,
  syncOccupations,
  verifyPotSettlement,
  type SettlementSaveResult,
} from '../utils/db';
import type { RootState } from './store';

export interface WriteoffFilters {
  settlementStates: SettlementState[];
  occupationStates: OccupationState[];
  keyword: string;
}

interface WriteoffStateShape {
  settlements: PotSettlement[];
  occupations: PotOccupation[];
  loading: boolean;
  error: string;
  notice: string;
  filters: WriteoffFilters;
}

export const initialWriteoffFilters: WriteoffFilters = {
  settlementStates: [],
  occupationStates: [],
  keyword: '',
};

const initialState: WriteoffStateShape = {
  settlements: [],
  occupations: [],
  loading: false,
  error: '',
  notice: '',
  filters: initialWriteoffFilters,
};

export const fetchWriteoffData = createAsyncThunk('writeoff/fetchAll', async () => {
  const [settlements, occupations] = await Promise.all([listPotSettlements(), listPotOccupations()]);
  return { settlements, occupations };
});

export const saveSettlement = createAsyncThunk<
  SettlementSaveResult,
  { profileId: string; productG: number; sampleG: number; state: SettlementState; note?: string }
>('writeoff/saveSettlement', async (input) =>
  savePotSettlement(input.profileId, {
    productG: input.productG,
    sampleG: input.sampleG,
    state: input.state,
    note: input.note,
  }),
);

export const verifySettlement = createAsyncThunk<SettlementSaveResult, string>(
  'writeoff/verifySettlement',
  (profileId) => verifyPotSettlement(profileId),
);

export const resyncOccupations = createAsyncThunk('writeoff/resync', async () => syncOccupations());

export const refreshAfterCupping = createAsyncThunk('writeoff/refreshAfterCupping', async () => {
  await refreshOccupationsAfterCupping();
  const [settlements, occupations] = await Promise.all([listPotSettlements(), listPotOccupations()]);
  return { settlements, occupations };
});

export const backfillOccupations = createAsyncThunk(
  'writeoff/backfill',
  async (blendId: string) => backfillBlendOccupations(blendId),
);

export const finalizeBlendThunk = createAsyncThunk(
  'writeoff/finalizeBlend',
  async (blendId: string) => finalizeBlendDb(blendId),
);

export const changeRoastStateThunk = createAsyncThunk(
  'writeoff/changeRoastState',
  async (input: { profileId: string; state: RoastProfile['state'] }) =>
    changeRoastStateWithWriteoff(input.profileId, input.state),
);

export const setQueueStatusThunk = createAsyncThunk(
  'writeoff/setQueueStatus',
  async (input: { profileId: string; queueStatus: QueueStatus }) =>
    setRoastQueueStatus(input.profileId, input.queueStatus),
);

/** 直接写占用行（极少使用，供人工改账兜底） */
export const replaceOccupations = createAsyncThunk(
  'writeoff/replaceOccupations',
  async (rows: PotOccupation[]) => {
    await putPotOccupations(rows.map((row) => ({ ...row, updatedAt: nowIso() })));
    return listPotOccupations();
  },
);

/** 新建烘焙记录前的机台容量判定（纯读，不写库） */
export function evaluateQueue(
  draft: Pick<RoastProfile, 'machineModel' | 'roastedAt' | 'chargeG'>,
  state: RootState,
): { queued: boolean; usedG: number; capacityG: number } {
  return evaluateQueueForProfile(draft, state.roasts.profiles, state.roasts.machines);
}

const writeoffSlice = createSlice({
  name: 'writeoff',
  initialState,
  reducers: {
    setWriteoffFilters(state, action: PayloadAction<Partial<WriteoffFilters>>) {
      state.filters = { ...state.filters, ...action.payload };
    },
    resetWriteoffFilters(state) {
      state.filters = initialWriteoffFilters;
    },
    clearWriteoffNotice(state) {
      state.notice = '';
      state.error = '';
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchWriteoffData.pending, (state) => {
        state.loading = true;
        state.error = '';
      })
      .addCase(fetchWriteoffData.fulfilled, (state, action) => {
        state.loading = false;
        state.settlements = action.payload.settlements;
        state.occupations = action.payload.occupations;
      })
      .addCase(fetchWriteoffData.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? '锅次核销数据读取失败';
      })
      .addCase(saveSettlement.fulfilled, (state, action) => {
        state.notice = action.payload.message;
      })
      .addCase(verifySettlement.fulfilled, (state, action) => {
        state.notice = action.payload.message;
      })
      .addCase(refreshAfterCupping.fulfilled, (state, action) => {
        state.settlements = action.payload.settlements;
        state.occupations = action.payload.occupations;
        state.notice = '杯测分数已变更：相关旧占用已失效，请重新认领';
      })
      .addCase(replaceOccupations.fulfilled, (state, action) => {
        state.occupations = action.payload;
      })
      .addCase(setQueueStatusThunk.fulfilled, (state, action) => {
        if (action.payload.ok) state.notice = action.payload.message;
        else state.error = action.payload.message;
      })
      .addCase(changeRoastStateThunk.fulfilled, (state, action) => {
        if (action.payload.ok) state.notice = action.payload.message;
        else state.error = action.payload.message;
      })
      .addCase(finalizeBlendThunk.fulfilled, (state, action) => {
        if (action.payload.ok) state.notice = action.payload.message;
        else state.error = action.payload.message;
      })
      .addCase(backfillOccupations.fulfilled, (state, action) => {
        state.notice = `补认完成：认出 ${action.payload.matched} 个锅次，未认出 ${action.payload.unmatched} 个（停在待核销）`;
      });
  },
});

export const { setWriteoffFilters, resetWriteoffFilters, clearWriteoffNotice } = writeoffSlice.actions;

export const selectWriteoffState = (state: RootState): WriteoffStateShape => state.writeoff;

/* ------------------------------ 核销台账派生 ------------------------------ */

export interface SettlementRow extends PotSettlement {
  heldG: number;
  remainingG: number;
  /** 该锅次最新杯测分（无则 null） */
  cuppingScore: number | null;
  /** 杯测是否通过 80 分线 */
  cuppingPassed: boolean;
  /** 关联的占用行 */
  occupations: PotOccupation[];
}

export const selectSettlementRows = createSelector(
  [
    selectWriteoffState,
    (state: RootState) => state.cuppings.cuppings,
  ],
  (writeoffState, cuppings): SettlementRow[] => {
    return writeoffState.settlements
      .map((settlement) => {
        const occupations = writeoffState.occupations.filter(
          (occupation) => occupation.profileId === settlement.profileId,
        );
        const availability = settlementAvailability(
          settlement,
          occupations.filter((occupation) => occupation.state === 'held'),
        );
        const related = cuppings
          .filter((cupping) => cupping.profileId === settlement.profileId)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const latest = related[0];
        return {
          ...settlement,
          heldG: availability.heldG,
          remainingG: availability.remainingG,
          cuppingScore: latest ? latest.totalScore : null,
          cuppingPassed: latest ? latest.totalScore >= 80 : false,
          occupations,
        };
      })
      .sort((a, b) => b.roastedAt.localeCompare(a.roastedAt) || b.updatedAt.localeCompare(a.updatedAt));
  },
);

export const selectFilteredSettlementRows = createSelector(
  [selectSettlementRows, selectWriteoffState],
  (rows, writeoffState) => {
    const { settlementStates, keyword } = writeoffState.filters;
    const needle = keyword.trim().toLowerCase();
    return rows.filter((row) => {
      if (settlementStates.length > 0 && !settlementStates.includes(row.state)) return false;
      if (needle && !`${row.machineModel} ${row.roastedAt} ${row.note}`.toLowerCase().includes(needle)) {
        return false;
      }
      return true;
    });
  },
);

/* ------------------------------ 方案占用派生 ------------------------------ */

export interface OccupationRow extends PotOccupation {
  blendState: BlendState | 'unknown';
  origin: string;
  profileStateLabel: string;
}

export const selectOccupationRows = createSelector(
  [
    selectWriteoffState,
    (state: RootState) => state.blends.blends,
    (state: RootState) => state.roasts.profiles,
    (state: RootState) => state.beans.greenBeans,
  ],
  (writeoffState, blends, profiles, beans): OccupationRow[] => {
    const blendMap = new Map(blends.map((blend) => [blend.id, blend]));
    const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));
    const beanMap = new Map(beans.map((bean) => [bean.id, bean]));
    return writeoffState.occupations
      .map((occupation) => {
        const blend = blendMap.get(occupation.blendId);
        const profile = profileMap.get(occupation.profileId);
        const bean = beanMap.get(occupation.greenBeanId);
        return {
          ...occupation,
          blendState: (blend?.state ?? 'unknown') as BlendState | 'unknown',
          origin: bean ? `${bean.origin} · ${bean.farm}` : '（生豆已删除）',
          profileStateLabel: profile
            ? `${profile.machineModel} · ${profile.roastedAt}`
            : occupation.profileId
              ? '（锅次已删除）'
              : '（未认出锅次）',
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
);

export const selectFilteredOccupationRows = createSelector(
  [selectOccupationRows, selectWriteoffState],
  (rows, writeoffState) => {
    const { occupationStates, keyword } = writeoffState.filters;
    const needle = keyword.trim().toLowerCase();
    return rows.filter((row) => {
      if (occupationStates.length > 0 && !occupationStates.includes(row.state)) return false;
      if (
        needle &&
        !`${row.blendName} ${row.origin} ${row.machineModel} ${row.roastedAt} ${row.reason}`
          .toLowerCase()
          .includes(needle)
      ) {
        return false;
      }
      return true;
    });
  },
);

/* ------------------------------ 统计与提醒 ------------------------------ */

export const selectWriteoffStats = createSelector(
  [selectSettlementRows, selectOccupationRows],
  (settlementRows, occupationRows) => ({
    settlementsTotal: settlementRows.length,
    verified: settlementRows.filter((row) => row.state === 'verified').length,
    pending: settlementRows.filter((row) => row.state === 'pending').length,
    scrapped: settlementRows.filter((row) => row.state === 'scrapped').length,
    occupationsTotal: occupationRows.length,
    held: occupationRows.filter((row) => row.state === 'held').length,
    invalid: occupationRows.filter((row) => row.state === 'invalid').length,
    occupationPending: occupationRows.filter((row) => row.state === 'pending').length,
    heldG: Math.round(occupationRows.filter((row) => row.state === 'held').reduce((acc, row) => acc + row.occupiedG, 0) * 10) / 10,
  }),
);

/** 机台当天容量排队汇总 */
export interface QueueDay {
  key: string;
  machineModel: string;
  date: string;
  usedG: number;
  capacityG: number;
  queued: RoastProfile[];
  scheduled: RoastProfile[];
}

export const selectQueueDays = createSelector(
  [(state: RootState) => state.roasts.profiles, (state: RootState) => state.roasts.machines],
  (profiles, machines): QueueDay[] => {
    const groups = new Map<string, RoastProfile[]>();
    profiles
      .filter((profile) => profile.state !== 'void')
      .forEach((profile) => {
        const key = `${profile.machineModel}@${profile.roastedAt}`;
        const list = groups.get(key) ?? [];
        list.push(profile);
        groups.set(key, list);
      });
    const days: QueueDay[] = [];
    groups.forEach((list, key) => {
      const machineModel = list[0].machineModel;
      const date = list[0].roastedAt;
      const template = machines.find((machine) => machine.model === machineModel);
      const capacityG = template?.dailyCapacityG ?? DEFAULT_MACHINE_DAILY_CAPACITY_G;
      const scheduled = list
        .filter((profile) => (profile.queueStatus ?? 'scheduled') === 'scheduled')
        .sort((a, b) => a.roastedAt.localeCompare(b.roastedAt));
      const queued = list
        .filter((profile) => profile.queueStatus === 'queued')
        .sort((a, b) => (a.queuedAt ?? '').localeCompare(b.queuedAt ?? ''));
      const usedG = scheduled.reduce((acc, profile) => acc + profile.chargeG, 0);
      if (queued.length > 0 || usedG > capacityG) {
        days.push({ key, machineModel, date, usedG, capacityG, queued, scheduled });
      }
    });
    return days.sort((a, b) => b.date.localeCompare(a.date) || a.machineModel.localeCompare(b.machineModel));
  },
);

/** 某方案的占用行（拼配页回显定版闸门用） */
export const selectOccupationsByBlend = createSelector(
  [selectWriteoffState, (_state: RootState, blendId: string) => blendId],
  (writeoffState, blendId) => writeoffState.occupations.filter((occupation) => occupation.blendId === blendId),
);

/** 定版方案是否存在杯测改动 / 占用失效的「只提醒」项 */
export function finalBlendWarnings(blendId: string, occupations: PotOccupation[]): string[] {
  return occupations
    .filter((row) => row.blendId === blendId && row.state !== 'held')
    .map((row) => `${row.machineModel || '未知锅次'}：${row.reason || OCCUPATION_STATE_LABEL[row.state]}`);
}

/** 供页面用的状态顺序导出 */
export { SETTLEMENT_STATE_ORDER, OCCUPATION_STATE_ORDER, QUEUE_STATUS_LABEL };

export default writeoffSlice.reducer;
