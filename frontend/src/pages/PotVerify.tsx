/**
 * /pots 锅次核销
 * 消费 RoastPot、RoastProfile、GreenBean、Cupping、Blend；复用 <FilterBar>、<EmptyPanel>、<StatBadge>、<ScoreTag>。
 * 交互：
 *  - 登记成品 / 留样 / 损耗（合计不超过投豆量）→ 已核销；锅次报废；
 *  - 展示每口锅的成品、留样、损耗、生效/失效占用与剩余量（累计占用不得超过成品-留样）；
 *  - 机台当天容量不足的排队批次展示与手动递补；
 *  - 旧数据无锅次来源方案按豆源 + 日期补认（认不出停在待核销）。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Collapse,
  Form,
  Input,
  InputNumber,
  Modal,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  DeleteOutlined,
  HistoryOutlined,
  MinusCircleOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons';
import FilterBar, { type FilterSelectConfig } from '../components/common/FilterBar';
import EmptyPanel from '../components/common/EmptyPanel';
import ScoreTag from '../components/common/ScoreTag';
import StatBadge from '../components/common/StatBadge';
import { useAppDispatch, useAppSelector } from '../stores/store';
import { fetchGreenBeans } from '../stores/beanSlice';
import {
  admitQueued,
  changeSchedule,
  fetchRoastProfiles,
  selectRoastState,
} from '../stores/roastSlice';
import { fetchCuppings } from '../stores/cuppingSlice';
import { fetchBlends } from '../stores/blendSlice';
import {
  deletePot,
  fetchRoastPots,
  recognizeLegacy,
  resetPotFilters,
  selectFilteredPotRows,
  selectPotRows,
  selectPotStats,
  selectPotState,
  setPotFilters,
  verifyPot,
  voidPot,
  type PotRow,
} from '../stores/potSlice';
import {
  ALLOCATION_STATE_COLOR,
  ALLOCATION_STATE_LABEL,
  POT_STATUS_COLOR,
  POT_STATUS_LABEL,
  POT_STATUS_OPTIONS,
  type PotStatus,
  type RoastPot,
} from '../types/pot';
import { SCHEDULE_STATUS_COLOR, type RoastProfile } from '../types/roastprofile';
import { CUPPING_PASS_SCORE, isCuppingPassed } from '../types/cupping';
import type { PotVerifyInput } from '../utils/db';

interface VerifyFormValues {
  productKg: number;
  sampleKg: number;
  lossKg: number;
  note: string;
}

export default function PotVerify() {
  const dispatch = useAppDispatch();
  const { message, modal } = AntdApp.useApp();
  const [form] = Form.useForm<VerifyFormValues>();

  const potState = useAppSelector(selectPotState);
  const rows = useAppSelector(selectFilteredPotRows);
  const allRows = useAppSelector(selectPotRows);
  const stats = useAppSelector(selectPotStats);
  const roastState = useAppSelector(selectRoastState);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingPot, setEditingPot] = useState<RoastPot | null>(null);

  useEffect(() => {
    void dispatch(fetchRoastPots());
    void dispatch(fetchRoastProfiles());
    void dispatch(fetchGreenBeans());
    void dispatch(fetchCuppings());
    void dispatch(fetchBlends());
  }, [dispatch]);

  /** 已完成 / 记录中但还没有锅次台账的烘焙记录（排队中的不提示，要先递补） */
  const profilesWithoutPot = useMemo(() => {
    const potProfileIds = new Set(allRows.map((row) => row.profileId));
    return roastState.profiles.filter(
      (profile) => !potProfileIds.has(profile.id) && profile.scheduleStatus === 'scheduled',
    );
  }, [allRows, roastState.profiles]);

  const queuedProfiles = useMemo(
    () =>
      [...roastState.profiles]
        .filter((profile) => profile.scheduleStatus === 'queued')
        .sort((a, b) => (a.queueOrder || 0) - (b.queueOrder || 0)),
    [roastState.profiles],
  );

  const selects: FilterSelectConfig[] = [
    { key: 'status', label: '锅次状态', options: POT_STATUS_OPTIONS },
  ];

  const handleFilterChange = (key: string, values: string[]): void => {
    if (key === 'status') dispatch(setPotFilters({ statuses: values as PotStatus[] }));
  };

  const openVerify = (row: PotRow): void => {
    setEditingPot(row);
    form.setFieldsValue({
      productKg: row.productKg || Number((row.chargeKg * 0.85).toFixed(3)),
      sampleKg: row.sampleKg || 0.03,
      lossKg: row.lossKg || Number((row.chargeKg - (row.productKg || row.chargeKg * 0.85) - (row.sampleKg || 0.03)).toFixed(3)),
      note: row.note,
    });
    setModalOpen(true);
  };

  const handleSubmit = async (values: VerifyFormValues): Promise<void> => {
    if (!editingPot) return;
    const draft: PotVerifyInput = {
      productKg: Number(values.productKg),
      sampleKg: Number(values.sampleKg),
      lossKg: Number(values.lossKg),
      note: values.note?.trim() ?? '',
    };
    try {
      await dispatch(verifyPot({ profileId: editingPot.profileId, draft })).unwrap();
      message.success('锅次已核销，方案占用已按当前杯测重新认领');
      setModalOpen(false);
    } catch (error) {
      message.error(`核销失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  const handleVoid = (row: PotRow): void => {
    modal.confirm({
      title: `报废「${row.machineModel} · ${row.roastedAt}」这口锅？`,
      content: '报废后成品不可再被占用：试配方案旧占用失效并转「待替换」，已定版方案只保留提醒。',
      okText: '确认报废',
      okButtonProps: { danger: true },
      cancelText: '取消',
      async onOk() {
        try {
          await dispatch(voidPot({ profileId: row.profileId })).unwrap();
          message.success('锅次已报废');
        } catch (error) {
          message.error(`报废失败：${error instanceof Error ? error.message : '未知错误'}`);
        }
      },
    });
  };

  const handleDelete = (row: PotRow): void => {
    modal.confirm({
      title: `删除锅次台账「${row.machineModel} · ${row.roastedAt}」？`,
      content: '只删除台账记录，不影响烘焙记录与生豆；删除后相关方案占用会重新计算。',
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      async onOk() {
        await dispatch(deletePot(row.id));
        message.success('台账记录已删除');
      },
    });
  };

  const handleRecognize = (): void => {
    modal.confirm({
      title: '按豆源 + 机台 + 日期补认旧数据？',
      content: '旧方案里找不到锅次来源的成分，会按豆源与烘焙日期自动匹配唯一锅次；同豆源同日多机台多锅或找不到锅次的，先停在待核销人工处理。',
      okText: '开始补认',
      cancelText: '取消',
      async onOk() {
        try {
          await dispatch(recognizeLegacy()).unwrap();
          message.success('旧数据补认完成');
        } catch (error) {
          message.error(`补认失败：${error instanceof Error ? error.message : '未知错误'}`);
        }
      },
    });
  };

  const handleAdmit = async (profile: RoastProfile): Promise<void> => {
    await dispatch(changeSchedule({ id: profile.id, scheduleStatus: 'scheduled' })).unwrap();
    await dispatch(admitQueued()).unwrap();
    message.success(`「${profile.machineModel} · ${profile.roastedAt}」已提前递补排产`);
  };

  const columns: ColumnsType<PotRow> = [
    {
      title: '锅次（机台 / 日期）',
      key: 'pot',
      width: 230,
      render: (_value, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{row.machineModel}</Typography.Text>
          <span className="gb-muted">{row.origin}</span>
          <span className="gb-mono gb-muted">{row.roastedAt}</span>
        </Space>
      ),
    },
    {
      title: '投豆 / 成品 / 留样 / 损耗',
      key: 'weights',
      width: 250,
      render: (_value, row) => (
        <Space direction="vertical" size={0}>
          <span className="gb-mono">
            投豆 {row.chargeKg}kg · 成品 <strong>{row.productKg}</strong>kg
          </span>
          <span className="gb-muted">
            留样 {row.sampleKg}kg · 损耗 {row.lossKg}kg（核销合计 {row.verifiedTotalKg}kg）
          </span>
        </Space>
      ),
    },
    {
      title: '占用 / 剩余',
      key: 'occupancy',
      width: 220,
      render: (_value, row) => (
        <Space direction="vertical" size={0}>
          <Space size={6}>
            <Tag color="#2f6f4f">生效 {row.activeBlendCount}</Tag>
            {row.staleBlendCount > 0 ? <Tag color="#b3372f">失效 {row.staleBlendCount}</Tag> : null}
          </Space>
          <span className="gb-mono">
            已占 {row.occupiedKg}kg / 剩余 <strong>{Math.max(row.availableKg, 0)}</strong>kg
          </span>
          {row.status === 'verified' && row.availableKg < 0 ? (
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              累计占用超过剩余量
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: '最新杯测',
      key: 'score',
      width: 130,
      render: (_value, row) =>
        row.latestScore === null ? (
          <span className="gb-muted">暂无杯测</span>
        ) : (
          <Space direction="vertical" size={0}>
            <ScoreTag score={row.latestScore} label="杯测" />
            <span className="gb-muted">{isCuppingPassed(row.latestScore) ? '已达通过线' : `未达 ${CUPPING_PASS_SCORE} 分通过线`}</span>
          </Space>
        ),
    },
    {
      title: '状态',
      key: 'status',
      width: 100,
      render: (_value, row) => <Tag color={POT_STATUS_COLOR[row.status]}>{POT_STATUS_LABEL[row.status]}</Tag>,
    },
    {
      title: '占用方案',
      key: 'allocations',
      render: (_value, row) =>
        row.allocations.length === 0 ? (
          <span className="gb-muted">暂无方案占用</span>
        ) : (
          <Space size={4} wrap>
            {row.allocations.map((allocation) => (
              <Tooltip key={allocation.id} title={allocation.staleReason || '占用生效中'}>
                <Tag color={ALLOCATION_STATE_COLOR[allocation.state]}>
                  {allocation.blendName} · {allocation.occupyKg}kg · {ALLOCATION_STATE_LABEL[allocation.state]}
                </Tag>
              </Tooltip>
            ))}
          </Space>
        ),
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      fixed: 'right',
      render: (_value, row) => (
        <Space size={4} wrap>
          {row.status !== 'void' ? (
            <Button size="small" type="primary" ghost icon={<CheckCircleOutlined />} onClick={() => openVerify(row)}>
              {row.status === 'verified' ? '改核销' : '核销登记'}
            </Button>
          ) : null}
          {row.status !== 'void' ? (
            <Button size="small" danger icon={<StopOutlined />} onClick={() => handleVoid(row)}>
              报废
            </Button>
          ) : null}
          <Button size="small" type="link" danger icon={<DeleteOutlined />} onClick={() => handleDelete(row)}>
            删台账
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <FilterBar
        keyword={potState.filters.keyword}
        onKeywordChange={(keyword) => dispatch(setPotFilters({ keyword }))}
        selects={selects}
        value={{ status: potState.filters.statuses }}
        onChange={handleFilterChange}
        onReset={() => dispatch(resetPotFilters())}
        searchPlaceholder="搜索机台 / 产地 / 备注"
        summary={<StatBadge compact label="筛选结果" value={rows.length} suffix={`/ ${allRows.length}`} tone="gold" />}
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => void dispatch(fetchRoastPots())}>
              刷新台账
            </Button>
            <Button icon={<HistoryOutlined />} onClick={handleRecognize}>
              旧数据补认
            </Button>
          </Space>
        }
      />

      <Card title="锅次核销总览" styles={{ body: { paddingTop: 12 } }}>
        <div className="gb-stat-row">
          <StatBadge label="锅次总数" value={stats.total} suffix=" 锅" tone="brown" />
          <StatBadge label="待核销" value={stats.pending} suffix=" 锅" tone="gold" />
          <StatBadge label="已核销" value={stats.verified} suffix=" 锅" tone="green" />
          <StatBadge label="已报废" value={stats.voided} suffix=" 锅" tone="red" />
          <StatBadge label="成品合计" value={stats.productKg} suffix=" kg" tone="blue" />
          <StatBadge label="可占用剩余" value={stats.availableKg} suffix=" kg" tone="purple" />
        </div>
        <Typography.Paragraph className="gb-muted" style={{ marginBottom: 0, marginTop: 8 }}>
          成品、留样、损耗在每口锅下豆后登记，三者合计不能超过投豆量；方案按目标批量 × 占比占用「成品 -
          留样」，多个方案的累计占用不能超过该锅剩余量。杯测分数改动后旧占用失效：试配方案转「待替换」需重新认领，已定版方案只保留提醒。
        </Typography.Paragraph>
      </Card>

      {profilesWithoutPot.length > 0 ? (
        <Alert
          type="info"
          showIcon
          message={`有 ${profilesWithoutPot.length} 条烘焙记录还没有锅次台账`}
          description={
            <Space wrap>
              {profilesWithoutPot.slice(0, 6).map((profile) => (
                <Tag key={profile.id}>
                  {profile.roastedAt} · {profile.machineModel} ·{' '}
                  {profile.state === 'recording' ? '记录中（下豆后自动建锅）' : '待建台账'}
                </Tag>
              ))}
            </Space>
          }
        />
      ) : null}

      {queuedProfiles.length > 0 ? (
        <Card
          size="small"
          title="机台当天容量排队"
          extra={<span className="gb-muted">容量不足时新批次排队，不占当天容量；作废 / 改期释放容量后自动按序递补</span>}
        >
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {queuedProfiles.map((profile) => (
              <Space key={profile.id} size={10}>
                <Tag color={SCHEDULE_STATUS_COLOR.queued}>第 {profile.queueOrder} 位</Tag>
                <span className="gb-mono">
                  {profile.roastedAt} · {profile.machineModel} · {profile.chargeG}g
                </span>
                <Button size="small" icon={<ReloadOutlined />} onClick={() => void handleAdmit(profile)}>
                  提前递补
                </Button>
              </Space>
            ))}
            <Button type="primary" ghost size="small" onClick={() => void dispatch(admitQueued())}>
              按排队顺序一键递补
            </Button>
          </Space>
        </Card>
      ) : null}

      {rows.length === 0 ? (
        <EmptyPanel
          title={allRows.length === 0 ? '还没有锅次台账' : '没有符合筛选条件的锅次'}
          description="烘焙记录在下豆完成时会自动建锅（待核销）；在这里登记成品、留样与损耗后，杯测通过的锅次才能被拼配方案占用。"
          secondaryText="重置筛选"
          secondaryIcon="none"
          onSecondary={() => dispatch(resetPotFilters())}
          size="small"
        />
      ) : (
        <Table
          className="gb-table"
          rowKey="id"
          size="small"
          loading={potState.loading}
          columns={columns}
          dataSource={rows}
          scroll={{ x: 1400 }}
          pagination={{ pageSize: 8, showTotal: (total) => `共 ${total} 口锅` }}
        />
      )}

      <Collapse
        items={[
          {
            key: 'rules',
            label: '核销与占用规则',
            children: (
              <Space direction="vertical" size={4}>
                <span className="gb-muted">
                  1. 核销重量：成品 + 留样 + 损耗 ≤ 投豆量（烘焙失重计入损耗）；留样不参与拼配占用。
                </span>
                <span className="gb-muted">
                  2. 方案占用 = 目标批量（kg）× 成分占比%，同一口锅所有方案的生效占用累计 ≤ 成品 - 留样，超卖会被拒绝。
                </span>
                <span className="gb-muted">
                  3. 杯测分数（含新增 / 删除杯测）改动后占用签名失效：试配方案转「待替换」，在拼配页重新认领；已定版方案保留提醒、不强制下线。
                </span>
                <span className="gb-muted">
                  4. 锅次报废（烘焙记录作废 / 删除）后占用立即失效；旧数据无锅次来源的方案按豆源 + 日期补认，认不出先停在待核销。
                </span>
                <span className="gb-muted">
                  5. 定版只允许使用「已核销且杯测 ≥ {CUPPING_PASS_SCORE} 分通过」的锅次。
                </span>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editingPot?.status === 'verified' ? '修改锅次核销重量' : '锅次核销登记'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        okText="保存并重新认领占用"
        cancelText="取消"
        confirmLoading={potState.loading}
        destroyOnClose
      >
        {editingPot ? (
          <Space direction="vertical" size={4} style={{ marginBottom: 12 }}>
            <span>
              {editingPot.machineModel} · {editingPot.roastedAt} · 投豆 {editingPot.chargeKg}kg
            </span>
            <span className="gb-muted">杯测未通过（或未录入）的锅次可以先核销，但占用要等杯测通过后才生效。</span>
          </Space>
        ) : null}
        <Form form={form} layout="vertical" onFinish={(values) => void handleSubmit(values)}>
          <Form.Item
            name="productKg"
            label="成品重量（kg）"
            rules={[{ required: true, message: '请填写成品重量' }]}
          >
            <InputNumber min={0} step={0.05} precision={3} style={{ width: '100%' }} addonAfter="kg" />
          </Form.Item>
          <Form.Item name="sampleKg" label="留样重量（kg）" rules={[{ required: true, message: '请填写留样重量' }]}>
            <InputNumber min={0} step={0.01} precision={3} style={{ width: '100%' }} addonAfter="kg" />
          </Form.Item>
          <Form.Item name="lossKg" label="损耗重量（kg，含烘焙失重 / 报废损耗）" rules={[{ required: true, message: '请填写损耗重量' }]}>
            <InputNumber min={0} step={0.01} precision={3} style={{ width: '100%' }} addonAfter="kg" />
          </Form.Item>
          <Form.Item name="note" label="备注" rules={[{ max: 60, message: '不超过 60 个字符' }]}>
            <Input placeholder="如：成品率 84%，留样 30g" />
          </Form.Item>
          <Form.Item shouldUpdate noStyle>
            {() => {
              const product = Number(form.getFieldValue('productKg') ?? 0);
              const sample = Number(form.getFieldValue('sampleKg') ?? 0);
              const loss = Number(form.getFieldValue('lossKg') ?? 0);
              const total = Math.round((product + sample + loss) * 1000) / 1000;
              const over = editingPot ? total > editingPot.chargeKg + 1e-6 : false;
              return (
                <Alert
                  type={over ? 'error' : 'success'}
                  showIcon
                  style={{ marginTop: 4 }}
                  message={
                    over
                      ? `合计 ${total}kg 已超出投豆量 ${editingPot?.chargeKg ?? 0}kg`
                      : `合计 ${total}kg，可占用成品 ${Math.max(Math.round((product - sample) * 1000) / 1000, 0)}kg`
                  }
                  icon={over ? <MinusCircleOutlined /> : <CheckCircleOutlined />}
                />
              );
            }}
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
