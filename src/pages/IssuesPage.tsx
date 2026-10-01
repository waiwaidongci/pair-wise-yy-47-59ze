import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Button,
  DatePicker,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { FilterOutlined, LogoutOutlined, MergeCellsOutlined, SaveOutlined, TeamOutlined } from '@ant-design/icons'
import {
  bulkAssign,
  isApiConflictError,
  mergeRootCauseGroup,
  removeGroupMemberApi,
  rivalMergeDemo,
  useWorkspaceStats,
} from '../api/useIssues'
import { useWorkspaceStore } from '../store/useWorkspaceStore'
import type { Issue, RootCauseGroup } from '../api/types'
import { previewMerge } from '../api/groups'

const impactColor: Record<string, string> = { 致命: 'red', 严重: 'volcano', 中等: 'gold', 轻微: 'blue' }
const statusColor: Record<string, string> = { 待分配: 'default', 修复中: 'processing', 待复测: 'orange', 已通过: 'success', 已退回: 'error', 不适用: 'default' }

type MergeBase = {
  keys: string[]
  expectedVersions: Record<string, number>
  blockedPassedKeys: string[]
  primaryKey: string
  noop: boolean
  touchedIds: string[]
}

export default function IssuesPage() {
  useWorkspaceStats()
  const queryClient = useQueryClient()
  const issues = useWorkspaceStore((state) => state.issues)
  const groups = useWorkspaceStore((state) => state.groups)
  const selectedKeys = useWorkspaceStore((state) => state.selectedKeys)
  const setSelectedKeys = useWorkspaceStore((state) => state.setSelectedKeys)
  const setWorkspace = useWorkspaceStore((state) => state.setWorkspace)
  const savedFilters = useWorkspaceStore((state) => state.savedFilters)
  const saveFilter = useWorkspaceStore((state) => state.saveFilter)
  const removeFilter = useWorkspaceStore((state) => state.removeFilter)
  const [filters, setFilters] = useState({ query: '', site: '', status: '', priority: '' })
  const [detail, setDetail] = useState<Issue | null>(null)
  const [assignOpen, setAssignOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  /** 打开合并弹窗时拍下的成员版本基线，提交时据此核对 */
  const [mergeBase, setMergeBase] = useState<MergeBase | null>(null)
  const [merging, setMerging] = useState(false)
  const [rivalPending, setRivalPending] = useState(false)
  const [form] = Form.useForm()

  const groupByMember = useMemo(() => {
    const map = new Map<string, RootCauseGroup>()
    for (const group of groups) for (const key of group.memberKeys) map.set(key, group)
    return map
  }, [groups])

  const data = useMemo(
    () =>
      issues.filter(
        (issue) =>
          (!filters.query || `${issue.key}${issue.title}${issue.rootCause}`.toLowerCase().includes(filters.query.toLowerCase())) &&
          (!filters.site || issue.site === filters.site) &&
          (!filters.status || issue.status === filters.status) &&
          (!filters.priority || issue.priority === filters.priority),
      ),
    [issues, filters],
  )

  const refresh = (workspace: Parameters<typeof setWorkspace>[0]) => {
    setWorkspace(workspace)
    queryClient.setQueryData(['workspace'], workspace)
  }

  const openMerge = () => {
    const base = previewMerge({ issues, groups }, selectedKeys)
    setMergeBase({
      keys: selectedKeys,
      expectedVersions: base.expectedVersions,
      blockedPassedKeys: base.blockedPassedKeys,
      primaryKey: base.primaryKey,
      noop: base.noop,
      touchedIds: base.touchedGroupIds,
    })
    setMergeOpen(true)
  }

  const confirmMerge = async () => {
    if (!mergeBase) return
    setMerging(true)
    try {
      const result = await mergeRootCauseGroup({ keys: mergeBase.keys, expectedVersions: mergeBase.expectedVersions })
      refresh(result.workspace)
      setMergeOpen(false)
      setSelectedKeys([])
      if (result.changed) {
        message.success(`根因组 ${result.group.id} 成员版本更新至 v${result.group.memberVersion}，总览/复测/报告已按当前成员重算`)
      } else {
        message.info('所选问题已在同一根因组，成员未变化')
      }
    } catch (error) {
      if (isApiConflictError(error)) {
        // 晚到方：携带的成员版本过期或要吞入已通过问题——拒绝并同步最新成员，让对方重新确认
        refresh(error.workspace)
        setMergeOpen(false)
        setSelectedKeys([])
        if (error.code === 'passed-protected') {
          message.error({ content: `合并被拒绝：${error.message}`, duration: 6 })
        } else {
          const versions = error.conflicts.map((c) => `${c.groupId} 最新成员版本 v${c.actual}`).join('；')
          message.error({ content: `合并冲突，已拒绝提交。${versions}。请核对最新成员后重新确认。`, duration: 7 })
        }
      } else {
        message.error('合并失败，请稍后重试')
      }
    } finally {
      setMerging(false)
    }
  }

  const simulateRival = async () => {
    if (!mergeBase) return
    const standalone = mergeBase.keys.find((key) => !groupByMember.has(key)) ?? mergeBase.keys[0]
    setRivalPending(true)
    try {
      const result = await rivalMergeDemo(standalone, mergeBase.primaryKey)
      refresh(result.workspace)
      message.warning(`另一位审核员已先把 ${standalone} 并入 ${result.group.id}（成员版本 v${result.group.memberVersion}），请再点确认合并体验冲突拒绝`)
    } catch (error) {
      if (isApiConflictError(error)) {
        refresh(error.workspace)
        message.error(`对方的合并也与最新成员冲突：${error.message}`)
      }
    } finally {
      setRivalPending(false)
    }
  }

  const removeMember = async (issue: Issue) => {
    if (!issue.groupId) return
    const group = groupByMember.get(issue.key)
    if (!group) return
    try {
      const result = await removeGroupMemberApi(group.id, issue.key, group.memberVersion)
      refresh(result.workspace)
      setDetail(null)
      message.success(result.group ? `已移出根因组，成员版本更新至 v${result.group.memberVersion}，统计已重算` : '已移出，根因组成员不足已解散，统计已重算')
    } catch (error) {
      if (isApiConflictError(error)) {
        refresh(error.workspace)
        message.error(`成员已被其他审核员调整：${error.message}`)
      }
    }
  }

  const columns: ColumnsType<Issue> = [
    {
      title: '问题',
      dataIndex: 'title',
      width: 290,
      render: (_, record) => (
        <div><Typography.Text strong>{record.key}</Typography.Text><div>{record.title}</div><Typography.Text type="secondary" style={{ fontSize: 11 }}>{record.wcag.join(' / ')}</Typography.Text></div>
      ),
    },
    { title: '站点 / 版本', dataIndex: 'site', width: 130, render: (_, record) => <div>{record.site}<br /><Typography.Text type="secondary">{record.version}</Typography.Text></div> },
    { title: '影响', dataIndex: 'impact', width: 86, render: (value) => <Tag color={impactColor[value]}>{value}</Tag> },
    {
      title: '根因 / 根因组',
      dataIndex: 'rootCause',
      width: 240,
      render: (value, record) => {
        const group = groupByMember.get(record.key)
        const isPrimary = group?.primaryKey === record.key
        return (
          <div>
            <span className="root-cause" title={value}>{value}</span>
            {group && (
              <div style={{ marginTop: 3 }}>
                <Tag color={isPrimary ? 'teal' : 'default'} style={{ fontSize: 11 }}>
                  {group.id} · v{group.memberVersion}{isPrimary ? ' · 主' : ' · 成员'}
                </Tag>
              </div>
            )}
          </div>
        )
      },
    },
    { title: '优先级', dataIndex: 'priority', width: 76, render: (value) => <Tag>{value}</Tag> },
    { title: '团队 / 负责人', dataIndex: 'team', width: 160, render: (_, record) => <div>{record.team}<br /><Typography.Text type="secondary">{record.owner}</Typography.Text></div> },
    { title: '状态', dataIndex: 'status', width: 95, render: (value) => <Tag color={statusColor[value]}>{value}</Tag> },
    { title: '截止', dataIndex: 'dueDate', width: 105 },
    { title: '', width: 76, fixed: 'right', render: (_, record) => <Button type="link" onClick={() => setDetail(record)}>详情</Button> },
  ]

  const applyFilter = () => {
    const input = window.prompt('筛选方案名称')
    if (input?.trim()) {
      saveFilter({ name: input.trim(), ...filters })
      message.success('筛选条件已保存')
    }
  }

  const detailGroup = detail ? groupByMember.get(detail.key) : null
  const detailMembers = detailGroup ? detailGroup.memberKeys.map((key) => issues.find((issue) => issue.key === key)).filter((issue): issue is Issue => Boolean(issue)) : []
  const canRivalDemo = Boolean(mergeBase && (mergeBase.keys.some((key) => !groupByMember.has(key)) || mergeBase.touchedIds.length <= 1))

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">ISSUE LEDGER / 问题台账</p>
          <h1>问题流转与批量处理</h1>
          <p className="muted">筛选条件可复用；选择多条问题后可合并同根因项或批量指派。根因组按成员版本做并发核对。</p>
        </div>
        <Space>
          <Button icon={<MergeCellsOutlined />} disabled={selectedKeys.length < 2} onClick={openMerge}>合并重复问题</Button>
          <Button type="primary" icon={<TeamOutlined />} disabled={!selectedKeys.length} onClick={() => setAssignOpen(true)}>批量分配</Button>
        </Space>
      </div>

      <div className="toolbar panel">
        <Input.Search placeholder="搜索编号、标题或根因" allowClear style={{ width: 270 }} value={filters.query} onChange={(event) => setFilters({ ...filters, query: event.target.value })} />
        <Select placeholder="站点" allowClear style={{ width: 130 }} value={filters.site || undefined} onChange={(value) => setFilters({ ...filters, site: value ?? '' })} options={[...new Set(issues.map((item) => item.site))].map((value) => ({ value }))} />
        <Select placeholder="状态" allowClear style={{ width: 120 }} value={filters.status || undefined} onChange={(value) => setFilters({ ...filters, status: value ?? '' })} options={['待分配', '修复中', '待复测', '已通过', '已退回', '不适用'].map((value) => ({ value }))} />
        <Select placeholder="优先级" allowClear style={{ width: 110 }} value={filters.priority || undefined} onChange={(value) => setFilters({ ...filters, priority: value ?? '' })} options={['P0', 'P1', 'P2', 'P3'].map((value) => ({ value }))} />
        <Button icon={<SaveOutlined />} onClick={applyFilter}>保存筛选</Button>
        <span className="spacer" />
        <Typography.Text type="secondary">已选 {selectedKeys.length} 条 · 共 {data.length} 条</Typography.Text>
      </div>

      <div className="panel">
        <div className="saved-filters">
          <FilterOutlined />
          {savedFilters.map((filter) => (
            <Tag key={filter.id} closable onClose={(event) => { event.preventDefault(); removeFilter(filter.id) }} onClick={() => setFilters({ query: filter.query, site: filter.site, status: filter.status, priority: filter.priority })} style={{ cursor: 'pointer' }}>
              {filter.name}
            </Tag>
          ))}
        </div>
        <div className="table-wrap">
          <Table
            rowKey="key"
            columns={columns}
            dataSource={data}
            pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => `共 ${total} 条` }}
            rowSelection={{ selectedRowKeys: selectedKeys, onChange: (keys) => setSelectedKeys(keys as string[]) }}
            scroll={{ x: 1300 }}
          />
        </div>
      </div>

      <Drawer title={detail ? `${detail.key} · ${detail.title}` : ''} open={Boolean(detail)} onClose={() => setDetail(null)} width={560}>
        {detail && (
          <Space direction="vertical" size={18} style={{ width: '100%' }}>
            <Space wrap><Tag color={impactColor[detail.impact]}>{detail.impact}</Tag><Tag>{detail.priority}</Tag><Tag color={statusColor[detail.status]}>{detail.status}</Tag></Space>
            <dl className="detail-list">
              <dt>站点版本</dt><dd>{detail.site} / {detail.version}</dd>
              <dt>WCAG</dt><dd>{detail.wcag.join('、')}</dd>
              <dt>影响范围</dt><dd>{detail.affected}</dd>
              <dt>复现条件</dt><dd>{detail.reproduction}</dd>
              <dt>证据链接</dt><dd><Typography.Link href={detail.evidence} target="_blank">{detail.evidence}</Typography.Link></dd>
              <dt>根因</dt><dd>{detail.rootCause}</dd>
              <dt>关联重复</dt><dd>{detail.mergedKeys.length ? detail.mergedKeys.join('、') : '无'}</dd>
              <dt>修复说明</dt><dd>{detail.fixNote ?? '开发尚未提交'}</dd>
              <dt>复测环境</dt><dd>{detail.retestEnv ?? '待开发提交'}</dd>
            </dl>
            {detailGroup && (
              <div className="panel" style={{ padding: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <Typography.Text strong>根因组 {detailGroup.id}</Typography.Text>
                  <Tag color="teal">成员版本 v{detailGroup.memberVersion} · {detailGroup.memberKeys.length} 项</Tag>
                </div>
                <Space direction="vertical" style={{ width: '100%' }} size={6}>
                  {detailMembers.map((member) => (
                    <div key={member.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <Space size={6} wrap>
                        <Typography.Text strong>{member.key}</Typography.Text>
                        <Typography.Text type="secondary">{member.title}</Typography.Text>
                        {detailGroup.primaryKey === member.key && <Tag color="teal">主问题</Tag>}
                        <Tag color={statusColor[member.status]}>{member.status}</Tag>
                      </Space>
                      {detail.key === member.key && detailGroup.primaryKey !== member.key && (
                        <Popconfirm title="移出根因组？" description="成员版本将递增，总览/复测/报告会立即按当前成员重算。" onConfirm={() => removeMember(detail)} okText="确认移出" cancelText="取消">
                          <Button size="small" danger icon={<LogoutOutlined />}>移出本组</Button>
                        </Popconfirm>
                      )}
                    </div>
                  ))}
                </Space>
              </div>
            )}
            <div>
              <Typography.Title level={5}>操作历史</Typography.Title>
              {detail.history.map((event, index) => <div className="timeline-item" key={index}><Typography.Text strong>{event.action}</Typography.Text><div>{event.detail}</div><Typography.Text type="secondary" style={{ fontSize: 11 }}>{event.actor} · {event.at}</Typography.Text></div>)}
            </div>
          </Space>
        )}
      </Drawer>

      <Modal title="批量分配整改项" open={assignOpen} onCancel={() => setAssignOpen(false)} onOk={() => form.submit()} okText="确认分配">
        <Form form={form} layout="vertical" onFinish={async (values) => {
          const result = await bulkAssign({ keys: selectedKeys, ...values, dueDate: values.dueDate.format('YYYY-MM-DD') })
          refresh(result.workspace)
          message.success(`已分配 ${selectedKeys.length} 条问题`)
          setSelectedKeys([])
          setAssignOpen(false)
        }}>
          <Form.Item name="team" label="目标团队" rules={[{ required: true }]}><Select options={['前端基础组件组', '结算体验组', '数据可视化组', '供应链前端组'].map((value) => ({ value }))} /></Form.Item>
          <Form.Item name="owner" label="负责人" rules={[{ required: true }]}><Input placeholder="输入负责人姓名" /></Form.Item>
          <Space style={{ display: 'flex' }}>
            <Form.Item name="priority" label="优先级" rules={[{ required: true }]}><Select style={{ width: 140 }} options={['P0', 'P1', 'P2', 'P3'].map((value) => ({ value }))} /></Form.Item>
            <Form.Item name="dueDate" label="截止日期" rules={[{ required: true }]}><DatePicker /></Form.Item>
          </Space>
        </Form>
      </Modal>

      <Modal
        title="合并为同一根因组"
        open={mergeOpen}
        onCancel={() => setMergeOpen(false)}
        onOk={confirmMerge}
        confirmLoading={merging}
        okText="确认合并"
        okButtonProps={{ disabled: !mergeBase || mergeBase.blockedPassedKeys.length > 0 || mergeBase.noop }}
      >
        {mergeBase && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Typography.Paragraph>
              将以 <Typography.Text code>{mergeBase.primaryKey}</Typography.Text> 为主问题，其余项保留历史并关联到该根因组。
            </Typography.Paragraph>
            <Space wrap>{mergeBase.keys.map((key) => {
              const issue = issues.find((item) => item.key === key)
              return <Tag key={key} color={mergeBase.blockedPassedKeys.includes(key) ? 'success' : undefined}>{key}{issue?.status === '已通过' ? ' · 已通过' : ''}</Tag>
            })}</Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {mergeBase.touchedIds.length
                ? `核对成员版本：${mergeBase.touchedIds.map((id) => `${id} v${mergeBase.expectedVersions[id]}`).join('、')}；成员变化时版本递增，过期提交会被拒绝。`
                : '所选均为独立问题，合并后新根因组成员版本为 v1。'}
            </Typography.Text>
            {mergeBase.blockedPassedKeys.length > 0 && (
              <Typography.Text type="danger" style={{ fontSize: 12 }}>
                已通过问题 {mergeBase.blockedPassedKeys.join('、')} 不能降级并入别的根因组（会吞掉通过结论），请取消勾选后重新确认。
              </Typography.Text>
            )}
            {mergeBase.noop && <Typography.Text type="secondary">所选问题已在同一根因组，成员不会变化。</Typography.Text>}
            <div style={{ borderTop: '1px dashed #d9e0e2', paddingTop: 10 }}>
              <Button size="small" loading={rivalPending} disabled={!canRivalDemo} onClick={simulateRival}>
                演示并发：模拟另一位审核员抢先合并
              </Button>
              <div><Typography.Text type="secondary" style={{ fontSize: 11 }}>点击后保持弹窗再点“确认合并”，晚到提交将按最新成员版本核对并被拒绝。</Typography.Text></div>
            </div>
          </Space>
        )}
      </Modal>
    </section>
  )
}
