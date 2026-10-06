/**
 * /writeoff 锅次核销与占用台账
 * 消费 PotSettlement（成品/留样/损耗）、PotOccupation（方案按比例占用）、RoastProfile（机台当天容量排队）。
 * 交互：
 * - 锅次核销：登记成品、留样、损耗，累计占用不得超过「成品 - 留样」剩余量；
 * - 杯测不通过 / 锅次报废后占用自动失效，杯测分数改动后占用需重新认领，试配方案转「待替换」；
 * - 旧数据无锅次来源的方案按豆源/机台/日期补认，认不出停在待核销；
 * - 机台当天容量不足的锅次在「下批排队」区展示，可手动插队 / 让位。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  FieldTimeOutlined,
  ReloadOutlined,
  RetweetOutlined,
  SafetyCertificateOutlined,
  StopOutlined,
} from '@ant-design/icons';
import FilterBar, { type FilterSelectConfig } from '../components/common/FilterBar';
import EmptyPanel from '../components/common/EmptyPanel';
import ScoreTag from '../components/common/ScoreTag';
import StatBadge from '../components/common/StatBadge';
import { useAppDispatch, useAppSelector } from '../stores/store';
import { fetchGreenBeans, selectBeanState } from '../stores/beanSlice';
import { fetchRoastProfiles, selectRoastState } from '../stores/roastSlice';
import { fetchCuppings } from '../stores/cuppingSlice';
import { fetchBlends } from '../stores/blendSlice';
import {
  backfillOccupations,
  changeRoastStateThunk,
  clearWriteoffNotice,
  fetchWriteoffData,
  resetWriteoffFilters,
  resyncOccupations,
  saveSettlement,
  selectFilteredOccupationRows,
  selectFilteredSettlementRows,
  selectQueueDays,
  selectWriteoffState,
  selectWriteoffStats,
  setQueueStatusThunk,
  setWriteoffFilters,
  verifySettlement,
  type OccupationRow,
  type SettlementRow,
} from '../stores/writeoffSlice';
import {
  OCCUPATION_STATE_COLOR,
  OCCUPATION_STATE_LABEL,
  OCCUPATION_STATE_OPTIONS,
  SETTLEMENT_STATE_COLOR,
  SETTLEMENT_STATE_LABEL,
  SETTLEMENT_STATE_OPTIONS,
  yieldPctOf,
  type OccupationState,
  type SettlementState,
} from '../types/writeoff';
import {
  QUEUE_STATUS_COLOR,
  ROAST_STATE_COLOR,
  ROAST_STATE_LABEL,
  type RoastProfile,
} from '../types/roastprofile';
import { describeError } from '../utils/export';

interface SettlementFormValues {
  productG: number;
  sampleG: number;
  note?: string;
}

export default function WriteoffBoard() {
  const dispatch = useAppDispatch();
  const { message, modal } = AntdApp.useApp();
  const [form] = Form.useForm<SettlementFormValues>();

  const writeoffState = useAppSelector(selectWriteoffState);
  const settlementRows = useAppSelector(selectFilteredSettlementRows);
  const occupationRows = useAppSelector(selectFilteredOccupationRows);
  const stats = useAppSelector(selectWriteoffStats);
  const queueDays = useAppSelector(selectQueueDays);
  const roastState = useAppSelector(selectRoastState);
  const beanState = useAppSelector(selectBeanState);

  const [editing, setEditing] = useState<SettlementRow | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void dispatch(fetchWriteoffData());
    void dispatch(fetchRoastProfiles());
    void dispatch(fetchCuppings());
    void dispatch(fetchBlends());
    void dispatch(fetchGreenBeans());
  }, [dispatch]);

  useEffect(() => {
    if (writeoffState.error) message.error(writeoffState.error);
    if (writeoffState.notice) {
      message.success(writeoffState.notice);
      dispatch(clearWriteoffNotice());
    }
  }, [dispatch, message, writeoffState.error, writeoffState.notice]);

  const beanMap = useMemo(() => new Map(beanState.greenBeans.map((bean) => [bean.id, bean])), [beanState.greenBeans]);
  const profileMap = useMemo(
    () => new Map(roastState.profiles.map((profile) => [profile.id, profile])),
    [roastState.profiles],
  );

  const selects: FilterSelectConfig[] = [
    { key: 'settlement', label: '核销状态', options: SETTLEMENT_STATE_OPTIONS },
    { key: 'occupation', label: '占用状态', options: OCCUPATION_STATE_OPTIONS },
  ];

  const handleFilterChange = (key: string, values: string[]): void => {
    if (key === 'settlement') dispatch(setWriteoffFilters({ settlementStates: values as SettlementState[] }));
    if (key === 'occupation') dispatch(setWriteoffFilters({ occupationStates: values as OccupationState[] }));
  };

  /* ------------------------------ 核销弹窗 ------------------------------ */

  const openEdit = (row: SettlementRow): void => {
    setEditing(row);
    form.setFieldsValue({ productG: row.productG, sampleG: row.sampleG, note: row.note });
    setModalOpen(true);
  };

  const submitAs = async (state: SettlementState): Promise<void> => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      if (!editing) return;
      const result = await dispatch(
        saveSettlement({
          profileId: editing.profileId,
          productG: values.productG,
          sampleG: values.sampleG ?? 0,
          state,
          note: values.note,
        }),
      ).unwrap();
      await dispatch(fetchWriteoffData());
      await dispatch(fetchBlends());
      if (result.ok) message.success(result.message);
      else message.warning(result.message);
      if (result.ok && state !== 'pending') setModalOpen(false);
    } catch (error) {
      if (error && typeof error === 'object' && 'errorFields' in error) return; // 表单校验错误
      message.error(`核销失败：${describeError(error)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleQuickVerify = async (row: SettlementRow): Promise<void> => {
    const result = await dispatch(verifySettlement(row.profileId)).unwrap();
    await dispatch(fetchWriteoffData());
    await dispatch(fetchBlends());
    if (result.ok) message.success(result.message);
    else message.warning(result.message);
  };

  const handleScrap = (row: SettlementRow): void => {
    modal.confirm({
      title: `把锅次「${row.machineModel} · ${row.roastedAt}」标记报废？`,
      content: '报废后成品清零、烘焙记录置为「作废」，相关方案占用全部失效，试配方案转「待替换」。',
      okText: '确认报废',
      okButtonProps: { danger: true },
      cancelText: '取消',
      async onOk() {
        const result = await dispatch(changeRoastStateThunk({ profileId: row.profileId, state: 'void' })).unwrap();
        await dispatch(fetchWriteoffData());
        await dispatch(fetchRoastProfiles());
        await dispatch(fetchBlends());
        if (result.ok) message.success('锅次已报废，旧占用已释放');
        else message.warning(result.message);
      },
    });
  };

  const handleResync = async (): Promise<void> => {
    await dispatch(resyncOccupations()).unwrap();
    await dispatch(fetchWriteoffData());
    await dispatch(fetchBlends());
    message.success('占用账已按当前核销与杯测重算');
  };

  const handleBackfill = (row: OccupationRow): void => {
    modal.confirm({
      title: `为方案「${row.blendName}」补认锅次？`,
      content: '将按豆源、机台和日期匹配唯一锅次；仍认不出的成分会继续停在待核销。',
      okText: '补认',
      cancelText: '取消',
      async onOk() {
        const result = await dispatch(backfillOccupations(row.blendId)).unwrap();
        await dispatch(fetchWriteoffData());
        await dispatch(fetchBlends());
        message.success(`认出 ${result.matched} 个，未认出 ${result.unmatched} 个`);
      },
    });
  };

  const handleQueueToggle = async (profile: RoastProfile, target: 'scheduled' | 'queued'): Promise<void> => {
    const result = await dispatch(setQueueStatusThunk({ profileId: profile.id, queueStatus: target })).unwrap();
    await dispatch(fetchRoastProfiles());
    if (result.ok) message.success(result.message);
    else message.warning(result.message);
  };

  /* ------------------------------ 表格列 ------------------------------ */

  const settlementColumns: ColumnsType<SettlementRow> = [
    {
      title: '锅次（机台 / 日期 / 生豆）',
      key: 'profile',
      width: 260,
      render: (_v, row) => {
        const bean = beanMap.get(row.greenBeanId);
        const profile = profileMap.get(row.profileId);
        return (
          <Space direction="vertical" size={0}>
            <Typography.Text strong>{row.machineModel}</Typography.Text>
            <span className="gb-muted">{row.roastedAt}</span>
            <span className="gb-muted">{bean ? `${bean.origin} · ${bean.farm}` : '（生豆已删除）'}</span>
            {profile ? (
              <Tag style={{ marginTop: 2 }} color={ROAST_TAG_COLOR(profile.state)}>
                {ROAST_STATE_LABEL[profile.state]}
              </Tag>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '投豆 / 成品 / 留样 / 损耗 (g)',
      key: 'weights',
      width: 250,
      render: (_v, row) => (
        <Space direction="vertical" size={0} className="gb-mono">
          <span>
            投豆 {row.chargeG}g · 成品 <strong>{row.productG}</strong>g · 留样 {row.sampleG}g
          </span>
          <span className="gb-muted">损耗 {row.lossG}g · 成品率 {yieldPctOf(row)}%</span>
        </Space>
      ),
    },
    {
      title: '杯测',
      key: 'cupping',
      width: 150,
      render: (_v, row) =>
        row.cuppingScore === null ? (
          <Tag icon={<ClockCircleOutlined />} color="#8c8c8c">
            暂无杯测
          </Tag>
        ) : (
          <ScoreTag score={row.cuppingScore} />
        ),
    },
    {
      title: '占用 / 剩余 (g)',
      key: 'remaining',
      width: 210,
      render: (_v, row) => {
        const available = Math.max(0, row.productG - row.sampleG);
        const percent = available > 0 ? Math.min(100, Math.round((row.heldG / available) * 100)) : 0;
        return (
          <Space direction="vertical" size={2} style={{ width: 180 }}>
            <span className="gb-mono">
              已占 {row.heldG}g · 剩余 <strong>{Math.max(0, row.remainingG)}</strong>g
            </span>
            <Progress percent={percent} size="small" status={row.remainingG < 0 ? 'exception' : 'active'} showInfo={false} />
          </Space>
        );
      },
    },
    {
      title: '核销状态',
      dataIndex: 'state',
      key: 'state',
      width: 110,
      render: (value: SettlementState) => (
        <Tag color={SETTLEMENT_STATE_COLOR[value]}>{SETTLEMENT_STATE_LABEL[value]}</Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 260,
      fixed: 'right',
      render: (_v, row) => (
        <Space size={4} wrap>
          <Button size="small" type={row.state === 'verified' ? 'default' : 'primary'} onClick={() => openEdit(row)}>
            登记成品
          </Button>
          {row.state !== 'verified' ? (
            <Button
              size="small"
              type="primary"
              ghost
              icon={<SafetyCertificateOutlined />}
              disabled={row.productG <= 0}
              onClick={() => void handleQuickVerify(row)}
            >
              核销通过
            </Button>
          ) : null}
          {row.state !== 'scrapped' ? (
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleScrap(row)}>
              报废
            </Button>
          ) : null}
        </Space>
      ),
    },
  ];

  const occupationColumns: ColumnsType<OccupationRow> = [
    {
      title: '方案 / 成分',
      key: 'blend',
      width: 240,
      render: (_v, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{row.blendName}</Typography.Text>
          <span className="gb-muted">{row.origin}</span>
        </Space>
      ),
    },
    {
      title: '锅次',
      key: 'pot',
      width: 220,
      render: (_v, row) => (
        <Space direction="vertical" size={0}>
          <span>{row.profileStateLabel}</span>
          {row.backfilled ? (
            <Tag color="#7a4b8f">旧数据补认</Tag>
          ) : null}
        </Space>
      ),
    },
    {
      title: '占比 / 计划产量 / 占用',
      key: 'occupy',
      width: 210,
      render: (_v, row) => (
        <span className="gb-mono">
          {row.ratioPct}% × {row.batchG}g = <strong>{row.occupiedG}</strong>g
        </span>
      ),
    },
    {
      title: '状态 / 原因',
      key: 'state',
      width: 280,
      render: (_v, row) => (
        <Space direction="vertical" size={0}>
          <Tag color={OCCUPATION_STATE_COLOR[row.state]}>{OCCUPATION_STATE_LABEL[row.state]}</Tag>
          {row.reason ? <span className="gb-muted">{row.reason}</span> : null}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      fixed: 'right',
      render: (_v, row) =>
        row.state === 'pending' ? (
          <Button size="small" icon={<RetweetOutlined />} onClick={() => handleBackfill(row)}>
            补认锅次
          </Button>
        ) : row.state === 'invalid' ? (
          <Tooltip title="处理完杯测 / 报废 / 余量问题后，到拼配页对该方案点「重新认领」">
            <Button size="small" type="link" disabled>
              待方案重认
            </Button>
          </Tooltip>
        ) : (
          <span className="gb-muted">—</span>
        ),
    },
  ];

  const allSettlements = writeoffState.settlements;
  const pendingProfilesWithoutSettlement = roastState.profiles.filter(
    (profile) =>
      profile.state === 'done' && !allSettlements.some((settlement) => settlement.profileId === profile.id),
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <FilterBar
        keyword={writeoffState.filters.keyword}
        onKeywordChange={(keyword) => dispatch(setWriteoffFilters({ keyword }))}
        selects={selects}
        value={{
          settlement: writeoffState.filters.settlementStates,
          occupation: writeoffState.filters.occupationStates,
        }}
        onChange={handleFilterChange}
        onReset={() => dispatch(resetWriteoffFilters())}
        searchPlaceholder="搜索机台 / 日期 / 方案 / 原因"
        summary={<StatBadge compact label="核销 / 占用" value={`${stats.verified} / ${stats.held}`} tone="gold" />}
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void handleResync()}>
            重算占用账
          </Button>
        }
      />

      <Card title="锅次核销台账（成品 / 留样 / 损耗）" styles={{ body: { paddingTop: 12 } }}>
        <div className="gb-stat-row">
          <StatBadge label="核销台账" value={stats.settlementsTotal} suffix=" 锅" tone="brown" />
          <StatBadge label="已核销" value={stats.verified} suffix=" 锅" tone="green" icon={<CheckCircleOutlined />} />
          <StatBadge label="待核销" value={stats.pending} suffix=" 锅" tone="gold" icon={<ClockCircleOutlined />} />
          <StatBadge label="已报废" value={stats.scrapped} suffix=" 锅" tone="red" icon={<StopOutlined />} />
          <StatBadge label="占用中" value={stats.held} suffix=" 笔" tone="blue" />
          <StatBadge label="占用失效" value={stats.invalid} suffix=" 笔" tone="red" />
          <StatBadge label="待认领" value={stats.occupationPending} suffix=" 笔" tone="gold" />
          <StatBadge label="占用成品" value={stats.heldG} suffix=" g" tone="purple" />
        </div>
        <Typography.Paragraph className="gb-muted" style={{ marginTop: 12, marginBottom: 12 }}>
          占用规则：方案按「占比 × 计划产量」切分锅次成品，累计占用不能超过剩余量（成品 - 留样 - 已占用）；
          杯测低于 80 分、无杯测或锅次未核销/已报废的成分不能占账。杯测分数改动后旧占用失效，需在拼配页重新认领，试配方案自动转「待替换」。
        </Typography.Paragraph>

        {pendingProfilesWithoutSettlement.length > 0 ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={`有 ${pendingProfilesWithoutSettlement.length} 个已完成锅次尚未建核销台账`}
            description={
              <Space wrap>
                {pendingProfilesWithoutSettlement.map((profile) => (
                  <Tag key={profile.id} color="#c9963c">
                    {profile.machineModel} · {profile.roastedAt}
                  </Tag>
                ))}
              </Space>
            }
          />
        ) : null}

        {settlementRows.length === 0 ? (
          <EmptyPanel
            title={allSettlements.length === 0 ? '还没有锅次核销记录' : '没有符合筛选条件的核销记录'}
            description="烘焙下豆后会自动生成待核销台账；在此登记成品、留样与损耗，核销通过的锅次才能被定版方案使用。"
          />
        ) : (
          <Table
            className="gb-table"
            rowKey="id"
            size="small"
            loading={writeoffState.loading}
            columns={settlementColumns}
            dataSource={settlementRows}
            scroll={{ x: 1280 }}
            pagination={{ pageSize: 6, showTotal: (total) => `共 ${total} 个锅次` }}
          />
        )}
      </Card>

      <Card
        title="方案占用账（按比例占用，累计不超剩余量）"
        extra={<span className="gb-muted">旧数据认不出锅次的成分停在「待核销」，可点「补认锅次」</span>}
        styles={{ body: { paddingTop: 12 } }}
      >
        {occupationRows.length === 0 ? (
          <EmptyPanel
            title="还没有方案占用"
            description="在拼配页保存试配方案后，系统会按占比和计划产量自动占用已核销且杯测通过的锅次成品。"
          />
        ) : (
          <Table
            className="gb-table"
            rowKey="id"
            size="small"
            columns={occupationColumns}
            dataSource={occupationRows}
            scroll={{ x: 1100 }}
            pagination={{ pageSize: 8, showTotal: (total) => `共 ${total} 笔占用` }}
          />
        )}
      </Card>

      <Card
        title={<Space><FieldTimeOutlined /> 机台当天容量与下批排队</Space>}
        extra={<span className="gb-muted">同机台同日期已排产载量合计超过机台日容量时，新锅次自动进入排队；作废或删除后按入队顺序自动补位</span>}
        styles={{ body: { paddingTop: 12 } }}
      >
        {queueDays.length === 0 ? (
          <EmptyPanel title="当前没有排队或超载的机台/日期" description="容量充足时新建烘焙记录会直接排产；容量不足会自动下批排队。" />
        ) : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {queueDays.map((day) => {
              const percent = Math.min(150, Math.round((day.usedG / day.capacityG) * 100));
              return (
                <Card key={day.key} size="small" styles={{ body: { padding: 12 } }}>
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <Space wrap>
                      <Typography.Text strong>{day.machineModel}</Typography.Text>
                      <Tag>{day.date}</Tag>
                      <span className="gb-mono">
                        已排产 {day.usedG}g / 日容量 {day.capacityG}g
                      </span>
                      {day.usedG > day.capacityG ? <Tag color="#b3372f">超载</Tag> : null}
                      {day.queued.length > 0 ? <Tag color="#c9963c">排队 {day.queued.length} 锅</Tag> : null}
                    </Space>
                    <Progress percent={percent} size="small" status={day.usedG > day.capacityG ? 'exception' : 'active'} />
                    <Space wrap>
                      {day.queued.map((profile) => (
                        <Tag key={profile.id} color={QUEUE_STATUS_COLOR.queued} icon={<ClockCircleOutlined />}>
                          {ROAST_STATE_LABEL[profile.state]} · {profile.chargeG}g
                          <Button
                            size="small"
                            type="link"
                            onClick={() => void handleQueueToggle(profile, 'scheduled')}
                          >
                            提前排产
                          </Button>
                        </Tag>
                      ))}
                      {day.scheduled
                        .filter((profile) => profile.state !== 'void')
                        .map((profile) => (
                          <Tag key={profile.id} color={QUEUE_STATUS_COLOR.scheduled}>
                            {ROAST_STATE_LABEL[profile.state]} · {profile.chargeG}g
                            <Button
                              size="small"
                              type="link"
                              onClick={() => void handleQueueToggle(profile, 'queued')}
                            >
                              让位排队
                            </Button>
                          </Tag>
                        ))}
                    </Space>
                  </Space>
                </Card>
              );
            })}
          </Space>
        )}
      </Card>

      <Modal
        title={editing ? `登记锅次成品 · ${editing.machineModel} ${editing.roastedAt}` : '登记锅次成品'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        destroyOnClose
        footer={
          <Space>
            <Button onClick={() => setModalOpen(false)}>取消</Button>
            <Button loading={submitting} onClick={() => void submitAs('pending')}>
              暂存待核销
            </Button>
            <Button type="primary" danger ghost loading={submitting} onClick={() => void submitAs('scrapped')}>
              整锅报废
            </Button>
            <Button type="primary" icon={<SafetyCertificateOutlined />} loading={submitting} onClick={() => void submitAs('verified')}>
              核销通过
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="productG"
            label="成品熟豆重量（克）"
            rules={[
              { required: true, message: '请填写成品重量' },
              {
                validator: (_rule, value: number) =>
                  Number.isFinite(value) && value >= 0 && value <= (editing?.chargeG ?? 0) + 0.5
                    ? Promise.resolve()
                    : Promise.reject(new Error(`成品重量不能为负，且不超过投豆 ${editing?.chargeG ?? 0}g`)),
              },
            ]}
          >
            <InputNumber min={0} step={10} style={{ width: '100%' }} addonAfter="g" />
          </Form.Item>
          <Form.Item
            name="sampleG"
            label="留样重量（克，不计入可占用成品）"
            rules={[
              { required: true, message: '请填写留样重量' },
              {
                validator: (_rule, value: number) =>
                  Number.isFinite(value) && value >= 0
                    ? Promise.resolve()
                    : Promise.reject(new Error('留样重量不能为负')),
              },
            ]}
          >
            <InputNumber min={0} step={5} style={{ width: '100%' }} addonAfter="g" />
          </Form.Item>
          <Form.Item shouldUpdate noStyle>
            {() => {
              const productG = Number(form.getFieldValue('productG') ?? 0);
              const sampleG = Number(form.getFieldValue('sampleG') ?? 0);
              const chargeG = editing?.chargeG ?? 0;
              const loss = Math.max(0, Math.round((chargeG - productG - sampleG) * 10) / 10);
              const over = productG + sampleG > chargeG + 0.5;
              return (
                <Alert
                  style={{ marginBottom: 12 }}
                  type={over ? 'error' : 'info'}
                  showIcon
                  message={
                    over
                      ? `成品 ${productG}g + 留样 ${sampleG}g 超过投豆 ${chargeG}g，请核对`
                      : `按当前数值：损耗 ${loss}g，成品率 ${chargeG > 0 ? Math.round((productG / chargeG) * 1000) / 10 : 0}%，可占用 ${Math.max(
                          0,
                          Math.round((productG - sampleG) * 10) / 10,
                        )}g`
                  }
                />
              );
            }}
          </Form.Item>
          <Form.Item name="note" label="备注（损耗原因等）" rules={[{ max: 60, message: '不超过 60 个字符' }]}>
            <Input.TextArea rows={2} placeholder="如：烟感豆偏多 / 一爆火力回调不及时" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

function ROAST_TAG_COLOR(state: RoastProfile['state']): string {
  return ROAST_STATE_COLOR[state];
}
