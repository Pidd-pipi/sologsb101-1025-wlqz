/**
 * /blends 拼配方案与结构版本导出
 * 消费 Blend 及全部模型（GreenBean / RoastProfile / Cupping）；复用 <FilterBar>、<StatBadge>、<EmptyPanel>、<ScoreTag>。
 * 交互：配方占比合计 100% 校验、参与批次杯测均分回显、目标风味登记、状态流转（试配 → 定版 → 停用）、
 *       方案 JSON 与整库档案 JSON 的导入导出（导入前做结构校验）。
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  DatePicker,
  Divider,
  Drawer,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  PieChartOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  ExportOutlined,
  ImportOutlined,
  PlusOutlined,
  ReloadOutlined,
  SwapOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import FilterBar, { type FilterSelectConfig } from '../components/common/FilterBar';
import EmptyPanel from '../components/common/EmptyPanel';
import ScoreTag from '../components/common/ScoreTag';
import StatBadge from '../components/common/StatBadge';
import { useAppDispatch, useAppSelector } from '../stores/store';
import { fetchGreenBeans, selectBeanState } from '../stores/beanSlice';
import { fetchRoastProfiles, selectRoastState } from '../stores/roastSlice';
import { fetchCuppings, selectCuppingState } from '../stores/cuppingSlice';
import {
  addDraftItem,
  advanceBlendState,
  balanceDraftItems,
  createBlend,
  deleteBlend,
  fetchBlends,
  importBlendDraft,
  loadBlendDraft,
  reconfirmBlend,
  removeDraftItem,
  resetBlendDraft,
  resetBlendFilters,
  selectBlendFilterOptions,
  selectBlendRows,
  selectBlendState,
  selectBlendStats,
  selectDraftAverageScore,
  selectDraftRatioTotal,
  selectDraftRatioValid,
  selectFilteredBlendRows,
  setBlendDraftField,
  setBlendFilters,
  setDraftItems,
  updateBlend,
  type BlendRow,
} from '../stores/blendSlice';
import { fetchRoastPots, selectPotState } from '../stores/potSlice';
import {
  BLEND_STATE_COLOR,
  BLEND_STATE_FLOW,
  BLEND_STATE_LABEL,
  BLEND_STATE_OPTIONS,
  RATIO_TOLERANCE,
  TARGET_BATCH_MAX_KG,
  TARGET_BATCH_MIN_KG,
  TARGET_FLAVOR_OPTIONS,
  isRatioValid,
  occupyKgOfItem,
  ratioMessage,
  splitFlavors,
  totalRatioPct,
  type BlendItem,
  type BlendState,
} from '../types/blend';
import { ROAST_STATE_LABEL } from '../types/roastprofile';
import { BEAN_PROCESS_LABEL } from '../types/greenbean';
import { CUPPING_PASS_SCORE } from '../types/cupping';
import {
  describeError,
  exportArchiveJson,
  exportBlendPlanJson,
  parseArchiveJson,
  parseBlendJson,
} from '../utils/export';
import { exportSnapshot, importSnapshot } from '../utils/db';
import type { Blend } from '../types/blend';
import { POT_STATUS_LABEL } from '../types/pot';
import { availableKg, occupiedKg } from '../types/pot';

interface BlendFormValues {
  name: string;
  targetFlavor: string[];
  targetBatchKg: number;
  createdAt: Dayjs;
  state: BlendState;
  items: BlendItem[];
}

type ImportMode = 'blend' | 'archive';

export default function BlendPlan() {
  const dispatch = useAppDispatch();
  const { message, modal } = AntdApp.useApp();
  const [form] = Form.useForm<BlendFormValues>();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importModeRef = useRef<ImportMode>('blend');

  const blendState = useAppSelector(selectBlendState);
  const allRows = useAppSelector(selectBlendRows);
  const rows = useAppSelector(selectFilteredBlendRows);
  const stats = useAppSelector(selectBlendStats);
  const filterOptions = useAppSelector(selectBlendFilterOptions);
  const draftRatioTotal = useAppSelector(selectDraftRatioTotal);
  const draftRatioValid = useAppSelector(selectDraftRatioValid);
  const draftAverageScore = useAppSelector(selectDraftAverageScore);
  const beanState = useAppSelector(selectBeanState);
  const roastState = useAppSelector(selectRoastState);
  const cuppingState = useAppSelector(selectCuppingState);
  const potState = useAppSelector(selectPotState);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    void dispatch(fetchBlends());
    void dispatch(fetchGreenBeans());
    void dispatch(fetchRoastProfiles());
    void dispatch(fetchCuppings());
    void dispatch(fetchRoastPots());
  }, [dispatch]);

  const beanMap = useMemo(() => new Map(beanState.greenBeans.map((bean) => [bean.id, bean])), [beanState.greenBeans]);
  const profileMap = useMemo(
    () => new Map(roastState.profiles.map((profile) => [profile.id, profile])),
    [roastState.profiles],
  );
  /** profileId → 锅次台账（含剩余 / 状态），表单与列表共用 */
  const potByProfile = useMemo(() => new Map(potState.pots.map((pot) => [pot.profileId, pot])), [potState.pots]);

  /** 某条烘焙记录已录入的杯测分（用于配方行内回显） */
  const scoresOfProfile = useMemo(() => {
    const map = new Map<string, number[]>();
    cuppingState.cuppings.forEach((cupping) => {
      const list = map.get(cupping.profileId) ?? [];
      list.push(cupping.totalScore);
      map.set(cupping.profileId, list);
    });
    return map;
  }, [cuppingState.cuppings]);

  const selects: FilterSelectConfig[] = [
    { key: 'state', label: '方案状态', options: BLEND_STATE_OPTIONS },
    {
      key: 'flavor',
      label: '目标风味',
      width: 200,
      options: (filterOptions.flavors.length > 0 ? filterOptions.flavors : TARGET_FLAVOR_OPTIONS).map((flavor) => ({
        value: flavor,
        label: flavor,
      })),
    },
    {
      key: 'ratio',
      label: '占比校验',
      width: 150,
      options: [
        { value: 'valid', label: '合计 100% 合规' },
        { value: 'invalid', label: '占比不合规' },
      ],
    },
  ];

  const handleFilterChange = (key: string, values: string[]): void => {
    if (key === 'state') dispatch(setBlendFilters({ states: values as BlendState[] }));
    if (key === 'flavor') dispatch(setBlendFilters({ flavors: values }));
    if (key === 'ratio') dispatch(setBlendFilters({ ratio: values as Array<'valid' | 'invalid'> }));
  };

  /* ------------------------------ 方案表单 ------------------------------ */

  const openCreate = (): void => {
    setEditingId(null);
    dispatch(resetBlendDraft());
    form.resetFields();
    const firstBean = beanState.greenBeans[0];
    const firstProfile = roastState.profiles.find((profile) => profile.greenBeanId === firstBean?.id);
    form.setFieldsValue({
      name: '',
      targetFlavor: [],
      targetBatchKg: blendState.draft.targetBatchKg || 1,
      createdAt: dayjs(),
      state: 'trial',
      items: [
        {
          greenBeanId: firstBean?.id ?? '',
          profileId: firstProfile?.id ?? '',
          ratioPct: 100,
        },
      ],
    });
    dispatch(
      setDraftItems([
        { greenBeanId: firstBean?.id ?? '', profileId: firstProfile?.id ?? '', ratioPct: 100 },
      ]),
    );
    setDrawerOpen(true);
  };

  const openEdit = (blend: Blend): void => {
    setEditingId(blend.id);
    dispatch(loadBlendDraft(blend));
    form.setFieldsValue({
      name: blend.name,
      targetFlavor: splitFlavors(blend.targetFlavor),
      targetBatchKg: blend.targetBatchKg || 1,
      createdAt: dayjs(blend.createdAt),
      state: blend.state,
      items: blend.items.length > 0 ? blend.items.map((item) => ({ ...item })) : [{ greenBeanId: '', profileId: '', ratioPct: 0 }],
    });
    setDrawerOpen(true);
  };

  const syncItems = (items: BlendItem[] | undefined): void => {
    if (!items) return;
    dispatch(
      setDraftItems(
        items.map((item) => ({
          greenBeanId: item?.greenBeanId ?? '',
          profileId: item?.profileId ?? '',
          ratioPct: Number(item?.ratioPct ?? 0),
        })),
      ),
    );
  };

  /** 表单变更：同步配方草稿到 slice；生豆变更时自动匹配一条烘焙记录 */
  const handleValuesChange = (changed: Record<string, unknown>, values: BlendFormValues): void => {
    syncItems(values.items);
    const changedItems = changed?.items as Array<Partial<BlendItem>> | undefined;
    if (!Array.isArray(changedItems)) return;
    changedItems.forEach((patch, index) => {
      if (!patch || typeof patch !== 'object' || !patch.greenBeanId) return;
      const profile = roastState.profiles.find((item) => item.greenBeanId === patch.greenBeanId);
      const nextItems = (values.items ?? []).map((item, position) =>
        position === index ? { ...item, profileId: profile?.id ?? '' } : item,
      );
      form.setFieldValue('items', nextItems);
      syncItems(nextItems);
    });
  };

  const handleSubmit = async (values: BlendFormValues): Promise<void> => {
    const items: BlendItem[] = (values.items ?? []).map((item) => ({
      greenBeanId: item.greenBeanId,
      profileId: item.profileId,
      ratioPct: Number(item.ratioPct ?? 0),
    }));
    if (items.length === 0) {
      message.error('至少需要一项配方成分');
      return;
    }
    if (!isRatioValid(items)) {
      message.error(`占比校验失败：${ratioMessage(items)}`);
      return;
    }
    const draft = {
      name: values.name.trim(),
      items,
      targetFlavor: values.targetFlavor ?? [],
      targetBatchKg: values.targetBatchKg,
      createdAt: values.createdAt.format('YYYY-MM-DD'),
      state: values.state,
    };
    try {
      if (editingId) {
        await dispatch(updateBlend({ id: editingId, draft })).unwrap();
        message.success('拼配方案已更新');
      } else {
        await dispatch(createBlend(draft)).unwrap();
        message.success('拼配方案已创建');
      }
      setDrawerOpen(false);
    } catch (error) {
      message.error(`保存失败：${describeError(error)}`);
    }
  };

  const handleDelete = (row: BlendRow): void => {
    modal.confirm({
      title: `删除拼配方案「${row.name}」？`,
      content: '仅删除方案本身，不会影响其引用的生豆、烘焙记录与杯测数据。',
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      async onOk() {
        await dispatch(deleteBlend(row.id)).unwrap();
        message.success('拼配方案已删除');
      },
    });
  };

  const handleAdvanceState = async (row: BlendRow, next: BlendState): Promise<void> => {
    if (next === 'final' && !row.finalizable) {
      modal.warning({
        title: `方案「${row.name}」暂不能定版`,
        content: (
          <Space direction="vertical" size={4}>
            <span>定版只允许使用「已核销且杯测通过（≥ {CUPPING_PASS_SCORE} 分）」的锅次：</span>
            {row.blockers.map((blocker) => (
              <span key={blocker}>· {blocker}</span>
            ))}
          </Space>
        ),
        okText: '知道了',
      });
      return;
    }
    try {
      await dispatch(advanceBlendState({ id: row.id, state: next })).unwrap();
      message.success(`方案「${row.name}」已流转为「${BLEND_STATE_LABEL[next]}」`);
    } catch (error) {
      message.warning(typeof error === 'string' ? error : `状态流转失败`);
    }
  };

  /** 试配方案杯测改动 / 锅次异常后重新认领失效占用 */
  const handleReconfirm = async (row: BlendRow): Promise<void> => {
    try {
      await dispatch(reconfirmBlend(row.id)).unwrap();
      message.success(`方案「${row.name}」已重新认领锅次占用`);
    } catch (payload) {
      const messages = (payload as { messages?: string[] } | undefined)?.messages ?? ['重新认领失败'];
      modal.warning({
        title: `方案「${row.name}」还不能重新认领`,
        content: (
          <Space direction="vertical" size={4}>
            {messages.map((item) => (
              <span key={item}>· {item}</span>
            ))}
          </Space>
        ),
        okText: '知道了',
      });
    }
  };

  /* ------------------------------ 导出 / 导入 ------------------------------ */

  const handleExportArchive = async (): Promise<void> => {
    const snapshot = await exportSnapshot();
    const filename = exportArchiveJson(snapshot);
    message.success(`已导出整库档案：${filename}`);
  };

  const handleExportBlend = (row: BlendRow): void => {
    const filename = exportBlendPlanJson(row, beanState.greenBeans, roastState.profiles, cuppingState.cuppings);
    message.success(`已导出方案：${filename}`);
  };

  const triggerImport = (mode: ImportMode): void => {
    importModeRef.current = mode;
    fileInputRef.current?.click();
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const mode = importModeRef.current;
    let text = '';
    try {
      text = await file.text();
    } catch (error) {
      message.error(`读取文件失败：${describeError(error)}`);
      return;
    }

    if (mode === 'archive') {
      try {
        const snapshot = parseArchiveJson(text);
        modal.confirm({
          title: '导入整库档案并覆盖现有数据？',
          content: `档案包含：生豆 ${snapshot.greenBeans.length} 批 / 烘焙记录 ${snapshot.roastProfiles.length} 次 / 曲线事件 ${snapshot.events.length} 个 / 杯测 ${snapshot.cuppings.length} 笔 / 拼配 ${snapshot.blends.length} 个。导入会先清空当前本地库。`,
          okText: '覆盖导入',
          okButtonProps: { danger: true },
          cancelText: '取消',
          async onOk() {
            await importSnapshot(snapshot);
            await Promise.all([
              dispatch(fetchBlends()).unwrap(),
              dispatch(fetchGreenBeans()).unwrap(),
              dispatch(fetchRoastProfiles()).unwrap(),
              dispatch(fetchCuppings()).unwrap(),
            ]);
            message.success('整库档案已导入');
          },
        });
      } catch (error) {
        message.error(describeError(error));
      }
      return;
    }

    try {
      const draft = parseBlendJson(text);
      modal.confirm({
        title: `导入拼配方案「${draft.name}」？`,
        content: `成分 ${draft.items.length} 项，占比合计 ${totalRatioPct(draft.items)}%，目标风味：${draft.targetFlavor || '未填写'}。`,
        okText: '导入',
        cancelText: '取消',
        async onOk() {
          await dispatch(importBlendDraft(draft)).unwrap();
          message.success('拼配方案已导入');
        },
      });
    } catch (error) {
      message.error(describeError(error));
    }
  };

  /* -------------------------------- 表格 -------------------------------- */

  const itemSummary = (row: BlendRow): string =>
    row.items
      .map((item) => {
        const bean = beanMap.get(item.greenBeanId);
        const profile = profileMap.get(item.profileId);
        const name = bean ? bean.origin : '（生豆已删除）';
        const machine = profile ? profile.machineModel : '（记录已删除）';
        return `${name} / ${machine} ${item.ratioPct}%`;
      })
      .join('　');

  const columns: ColumnsType<BlendRow> = [
    {
      title: '方案名 / 成分',
      key: 'name',
      width: 330,
      render: (_value, row) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{row.name}</Typography.Text>
          <span className="gb-muted">{itemSummary(row)}</span>
        </Space>
      ),
    },
    {
      title: '占比合计',
      key: 'ratio',
      width: 210,
      sorter: (a, b) => a.ratioTotal - b.ratioTotal,
      render: (_value, row) => (
        <Tooltip title={ratioMessage(row.items)}>
          <Tag color={row.ratioValid ? '#2f6f4f' : '#b3372f'}>
            {row.ratioTotal}% {row.ratioValid ? '· 合规' : '· 需调整'}
          </Tag>
        </Tooltip>
      ),
    },
    {
      title: '目标风味',
      key: 'flavor',
      width: 190,
      render: (_value, row) => (
        <Space size={4} wrap>
          {splitFlavors(row.targetFlavor).length > 0 ? (
            splitFlavors(row.targetFlavor).map((flavor) => (
              <Tag key={flavor} color="#a8632c">
                {flavor}
              </Tag>
            ))
          ) : (
            <span className="gb-muted">未登记</span>
          )}
        </Space>
      ),
    },
    {
      title: '参与批次杯测均分',
      key: 'averageScore',
      width: 210,
      sorter: (a, b) => a.averageScore - b.averageScore,
      render: (_value, row) =>
        row.cuppingCount > 0 ? (
          <Space size={6}>
            <ScoreTag score={row.averageScore} label="均分" />
            <span className="gb-muted">{row.cuppingCount} 笔</span>
          </Space>
        ) : (
          <span className="gb-muted">参与批次暂无杯测</span>
        ),
    },
    {
      title: '创建日期',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 120,
      sorter: (a, b) => a.createdAt.localeCompare(b.createdAt),
      render: (value: string) => <span className="gb-mono">{value}</span>,
    },
    {
      title: '锅次占用 / 待替换',
      key: 'pot',
      width: 220,
      render: (_value, row) => {
        const perItem = row.items.map((item) => {
          const pot = potByProfile.get(item.profileId);
          const occupy = occupyKgOfItem(item, row.targetBatchKg || 1);
          return { item, pot, occupy };
        });
        const remainTotal = perItem.reduce(
          (acc, entry) => acc + (entry.pot ? Math.max(availableKg(entry.pot), 0) : 0),
          0,
        );
        return (
          <Space direction="vertical" size={2}>
            <Space size={4} wrap>
              <Tag color={row.finalizable ? '#2f6f4f' : '#b3372f'}>
                生效成分 {row.activeItemCount}/{row.items.length}
              </Tag>
              <span className="gb-mono gb-muted">批量 {row.targetBatchKg || 1}kg · 剩余合计 {Math.round(remainTotal * 1000) / 1000}kg</span>
            </Space>
            {perItem.map((entry, index) => (
              <span key={`${entry.item.profileId}-${index}`} className="gb-muted" style={{ fontSize: 12 }}>
                {entry.pot
                  ? `${POT_STATUS_LABEL[entry.pot.status]} · 占 ${entry.occupy}kg / 剩 ${Math.max(
                      Math.round(availableKg(entry.pot) * 1000) / 1000,
                      0,
                    )}kg`
                  : '无锅次来源（待核销/补认）'}
              </span>
            ))}
            {row.pendingReplace ? (
              <Tag icon={<WarningOutlined />} color="#b3372f">
                待替换
              </Tag>
            ) : null}
            {row.reminders.length > 0 ? (
              <Tooltip title={row.reminders.map((item, index) => `${index + 1}. ${item}`).join('\n')}>
                <Tag icon={<WarningOutlined />} color="#d48806">
                  定版提醒 {row.reminders.length}
                </Tag>
              </Tooltip>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '状态',
      dataIndex: 'state',
      key: 'state',
      width: 100,
      render: (value: BlendState) => <Tag color={BLEND_STATE_COLOR[value]}>{BLEND_STATE_LABEL[value]}</Tag>,
    },
    {
      title: '状态流转 / 操作',
      key: 'action',
      width: 300,
      fixed: 'right',
      render: (_value, row) => (
        <Space size={4} wrap>
          {BLEND_STATE_FLOW[row.state].map((next) => (
            <Tooltip
              key={next}
              title={next === 'final' && !row.finalizable ? `定版门槛未满足：${row.blockers.join('；')}` : undefined}
            >
              <Button
                size="small"
                type={next === 'final' ? 'primary' : 'default'}
                danger={next === 'retired'}
                disabled={next === 'final' && !row.finalizable}
                icon={<SwapOutlined />}
                onClick={() => void handleAdvanceState(row, next)}
              >
                {BLEND_STATE_LABEL[next]}
              </Button>
            </Tooltip>
          ))}
          {row.state === 'trial' && row.pendingReplace ? (
            <Button size="small" type="primary"
              ghost
              icon={<ReloadOutlined />}
              onClick={() => void handleReconfirm(row)}
            >
              重新认领
            </Button>
          ) : null}
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Button size="small" type="link" icon={<DownloadOutlined />} onClick={() => handleExportBlend(row)}>
            导出
          </Button>
          <Button size="small" type="link" danger icon={<DeleteOutlined />} onClick={() => handleDelete(row)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const draftItems = blendState.draft.items;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(event) => void handleFileChange(event)}
      />

      <FilterBar
        keyword={blendState.filters.keyword}
        onKeywordChange={(keyword) => dispatch(setBlendFilters({ keyword }))}
        selects={selects}
        value={{
          state: blendState.filters.states,
          flavor: blendState.filters.flavors,
          ratio: blendState.filters.ratio,
        }}
        onChange={handleFilterChange}
        onReset={() => dispatch(resetBlendFilters())}
        searchPlaceholder="搜索方案名 / 目标风味"
        summary={<StatBadge compact label="筛选结果" value={rows.length} suffix={`/ ${allRows.length}`} tone="gold" />}
        extra={
          <Space>
            <Button icon={<ExportOutlined />} onClick={() => void handleExportArchive()}>
              导出档案
            </Button>
            <Button icon={<ImportOutlined />} onClick={() => triggerImport('archive')}>
              导入档案
            </Button>
            <Button icon={<ImportOutlined />} onClick={() => triggerImport('blend')}>
              导入方案
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新建方案
            </Button>
          </Space>
        }
      />

      <Card title="拼配方案与结构版本" styles={{ body: { paddingTop: 12 } }}>
        <div className="gb-stat-row">
          <StatBadge label="方案总数" value={stats.total} suffix=" 个" tone="brown" />
          <StatBadge label="占比合规" value={stats.valid} suffix=" 个" tone="green" />
          <StatBadge label="占比待调整" value={stats.invalid} suffix=" 个" tone="red" />
          <StatBadge label="已定版" value={stats.finalized} suffix=" 个" tone="purple" />
          <StatBadge
            label="待替换"
            value={stats.pendingReplace}
            suffix=" 个"
            tone={stats.pendingReplace > 0 ? 'red' : 'green'}
          />
          <StatBadge label="可定版" value={stats.finalizable} suffix=" 个" tone="gold" />
          <StatBadge label="参批次均分" value={stats.averageScore} suffix=" 分" tone="blue" />
        </div>
        <Typography.Paragraph className="gb-muted" style={{ marginBottom: 12 }}>
          占比校验：各成分 ratioPct 合计必须等于 100%（容差 ±{RATIO_TOLERANCE}%）；参与批次杯测均分由配方引用的烘焙记录自动回显。
        </Typography.Paragraph>

        {rows.length === 0 ? (
          <EmptyPanel
            title={allRows.length === 0 ? '还没有拼配方案' : '没有符合筛选条件的方案'}
            description={
              allRows.length === 0
                ? '把已烘焙并杯测过的批次按占比组合成方案，登记目标风味后即可定版。'
                : '试试放宽状态、目标风味或占比校验筛选。'
            }
            actionText="新建方案"
            onAction={openCreate}
            secondaryText="导入方案 JSON"
            onSecondary={() => triggerImport('blend')}
          />
        ) : (
          <Table
            className="gb-table"
            rowKey="id"
            size="small"
            loading={blendState.loading}
            columns={columns}
            dataSource={rows}
            scroll={{ x: 1760 }}
            pagination={{ pageSize: 6, showTotal: (total) => `共 ${total} 个方案` }}
          />
        )}
      </Card>

      <Drawer
        title={editingId ? '编辑拼配方案' : '新建拼配方案'}
        width={720}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={() => setDrawerOpen(false)}>取消</Button>
            <Button type="primary" loading={blendState.loading} onClick={() => form.submit()}>
              保存
            </Button>
          </Space>
        }
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
          onValuesChange={handleValuesChange}
        >
          <Form.Item
            name="name"
            label="方案名"
            rules={[
              { required: true, message: '请填写方案名' },
              { min: 2, message: '方案名至少 2 个字符' },
              { max: 30, message: '不超过 30 个字符' },
            ]}
          >
            <Input placeholder="如：晨光拼配 House Blend" />
          </Form.Item>
          <Form.Item name="targetFlavor" label="目标风味" rules={[{ required: true, message: '请选择至少一个目标风味' }]}>
            <Select mode="multiple" allowClear options={TARGET_FLAVOR_OPTIONS.map((flavor) => ({ value: flavor, label: flavor }))} />
          </Form.Item>
          <Space size={16} wrap>
            <Form.Item name="createdAt" label="创建日期" rules={[{ required: true, message: '请选择创建日期' }]}>
              <DatePicker style={{ width: 200 }} />
            </Form.Item>
            <Form.Item name="state" label="状态" rules={[{ required: true, message: '请选择状态' }]}>
              <Select style={{ width: 160 }} options={BLEND_STATE_OPTIONS} />
            </Form.Item>
            <Form.Item
              name="targetBatchKg"
              label="目标批量（kg）"
              tooltip="各成分按占比折算锅次占用：占用 = 目标批量 × 占比%，同一口锅多方案累计占用不能超过剩余成品"
              rules={[
                { required: true, message: '请填写目标批量' },
                {
                  validator: (_rule, value: number) =>
                    Number.isFinite(value) && value >= TARGET_BATCH_MIN_KG && value <= TARGET_BATCH_MAX_KG
                      ? Promise.resolve()
                      : Promise.reject(new Error(`目标批量应在 ${TARGET_BATCH_MIN_KG} - ${TARGET_BATCH_MAX_KG}kg 之间`)),
                },
              ]}
            >
              <InputNumber
                min={TARGET_BATCH_MIN_KG}
                max={TARGET_BATCH_MAX_KG}
                step={0.05}
                precision={3}
                style={{ width: 170 }}
                addonAfter="kg"
                onChange={(value) => {
                  if (value !== null) dispatch(setBlendDraftField({ field: 'targetBatchKg', value: Number(value) }));
                }}
              />
            </Form.Item>
          </Space>

          <Divider orientation="left" plain>
            配方成分（占比合计需为 100%）
          </Divider>

          <Alert
            type={draftRatioValid ? 'success' : 'warning'}
            showIcon
            style={{ marginBottom: 12 }}
            message={
              <Space size={10} wrap>
                <span>
                  占比合计 <strong>{draftRatioTotal}%</strong>
                </span>
                <Tag color={draftRatioValid ? '#2f6f4f' : '#b3372f'}>{draftRatioValid ? '校验通过' : '校验未通过'}</Tag>
                <span className="gb-muted">{ratioMessage(draftItems)}</span>
                <span className="gb-muted">参与批次杯测均分：{draftAverageScore || '暂无'}</span>
                <span className="gb-muted">
                  保存后按目标批量 × 占比占用锅次；杯测改动会让试配方案转待替换，定版只用已核销且杯测 ≥ {CUPPING_PASS_SCORE} 分的锅次
                </span>
              </Space>
            }
          />

          <Form.List name="items">
            {(fields, { add, remove }) => (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {fields.map(({ key, name, ...restField }, index) => (
                  <Card key={key} size="small" styles={{ body: { padding: 12 } }}>
                    <Space wrap size={10} align="end">
                      <Form.Item
                        {...restField}
                        name={[name, 'greenBeanId']}
                        label="生豆"
                        rules={[{ required: true, message: '请选择生豆' }]}
                        style={{ width: 200, marginBottom: 0 }}
                      >
                        <Select
                          showSearch
                          optionFilterProp="label"
                          placeholder="选择生豆"
                          options={beanState.greenBeans.map((bean) => ({
                            value: bean.id,
                            label: `${bean.origin} · ${BEAN_PROCESS_LABEL[bean.process]}`,
                          }))}
                        />
                      </Form.Item>
                      <Form.Item
                        {...restField}
                        name={[name, 'profileId']}
                        label="烘焙记录"
                        rules={[{ required: true, message: '请选择烘焙记录' }]}
                        style={{ width: 220, marginBottom: 0 }}
                      >
                        <Select
                          showSearch
                          optionFilterProp="label"
                          placeholder="选择烘焙记录"
                          options={roastState.profiles
                            .filter(
                              (profile) =>
                                !form.getFieldValue(['items', name, 'greenBeanId']) ||
                                profile.greenBeanId === form.getFieldValue(['items', name, 'greenBeanId']),
                            )
                            .map((profile) => ({
                              value: profile.id,
                              label: `${profile.roastedAt} · ${profile.machineModel} · ${ROAST_STATE_LABEL[profile.state]}`,
                            }))}
                        />
                      </Form.Item>
                      <Form.Item
                        {...restField}
                        name={[name, 'ratioPct']}
                        label="占比 %"
                        rules={[
                          { required: true, message: '请填写占比' },
                          {
                            validator: (_rule, value: number) =>
                              Number.isFinite(value) && value > 0 && value <= 100
                                ? Promise.resolve()
                                : Promise.reject(new Error('占比应在 0 - 100 之间')),
                          },
                        ]}
                        style={{ width: 130, marginBottom: 0 }}
                      >
                        <InputNumber min={0} max={100} step={5} style={{ width: '100%' }} addonAfter="%" />
                      </Form.Item>
                      <Space size={6} style={{ marginBottom: 0 }}>
                        <Tooltip title="该批次杯测分">
                          <Tag color="#3b7ea1">
                            {(() => {
                              const profileId = form.getFieldValue(['items', name, 'profileId']) as string | undefined;
                              const scores = profileId ? scoresOfProfile.get(profileId) ?? [] : [];
                              return scores.length > 0 ? `杯测 ${scores.join(' / ')}` : '暂无杯测';
                            })()}
                          </Tag>
                        </Tooltip>
                        {(() => {
                          const profileId = form.getFieldValue(['items', name, 'profileId']) as string | undefined;
                          const ratio = Number(form.getFieldValue(['items', name, 'ratioPct']) ?? 0);
                          const pot = profileId ? potByProfile.get(profileId) : undefined;
                          const occupy = occupyKgOfItem(
                            { greenBeanId: '', profileId: profileId ?? '', ratioPct: ratio },
                            Number(form.getFieldValue('targetBatchKg')) || 1,
                          );
                          if (!pot) {
                            return (
                              <Tooltip title="该烘焙记录还没有锅次台账（下豆完成后自动建锅，待核销登记）">
                                <Tag color="#c9963c">无锅次 · 占 {occupy}kg</Tag>
                              </Tooltip>
                            );
                          }
                          const remain = Math.max(availableKg(pot), 0);
                          const enough = occupy <= remain + 1e-6 && pot.status === 'verified';
                          const scoreTag =
                            pot.lastScore !== null && pot.lastScore < CUPPING_PASS_SCORE ? ` · 杯测 ${pot.lastScore} 未过` : '';
                          return (
                            <Tooltip
                              title={`${POT_STATUS_LABEL[pot.status]} · 已占 ${occupiedKg(pot)}kg / 剩余 ${remain}kg${scoreTag}`}
                            >
                              <Tag color={enough ? '#2f6f4f' : '#b3372f'}>
                                {POT_STATUS_LABEL[pot.status]} · 占 {occupy}kg / 剩 {remain}kg
                              </Tag>
                            </Tooltip>
                          );
                        })()}
                        <Button
                          danger
                          type="text"
                          icon={<DeleteOutlined />}
                          onClick={() => {
                            remove(name);
                            dispatch(removeDraftItem(index));
                          }}
                        >
                          移除
                        </Button>
                      </Space>
                    </Space>
                  </Card>
                ))}
                <Space>
                  <Button
                    type="dashed"
                    icon={<PlusOutlined />}
                    onClick={() => {
                      add({ greenBeanId: '', profileId: '', ratioPct: 0 });
                      dispatch(addDraftItem());
                    }}
                  >
                    添加成分
                  </Button>
                  <Button
                    icon={<PieChartOutlined />}
                    onClick={() => {
                      const count = blendState.draft.items.length;
                      if (count === 0) return;
                      const base = Math.floor((100 / count) * 100) / 100;
                      const rest = Math.round((100 - base * count) * 100) / 100;
                      const balanced = blendState.draft.items.map((item, position) => ({
                        ...item,
                        ratioPct: position === 0 ? Math.round((base + rest) * 100) / 100 : base,
                      }));
                      dispatch(balanceDraftItems());
                      syncItems(balanced);
                      form.setFieldValue('items', balanced);
                    }}
                  >
                    平均分配占比
                  </Button>
                  <span className="gb-muted">当前合计 {draftRatioTotal}%（需为 100% 才能保存）</span>
                </Space>
              </Space>
            )}
          </Form.List>
        </Form>
      </Drawer>
    </Space>
  );
}
