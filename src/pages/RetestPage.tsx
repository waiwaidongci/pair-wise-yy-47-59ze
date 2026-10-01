import { useEffect, useState } from 'react'
import { Alert, Button, Descriptions, Form, Input, Radio, Space, Table, Tag, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { submitReview, useWorkspaceStats } from '../api/useIssues'
import { useWorkspaceStore } from '../store/useWorkspaceStore'
import { useQueryClient } from '@tanstack/react-query'
import type { QueueItem } from '../api/stats'

export default function RetestPage() {
  const stats = useWorkspaceStats()
  const setWorkspace = useWorkspaceStore((state) => state.setWorkspace)
  const queryClient = useQueryClient()
  const queue = stats.retestQueue
  const [activeKey, setActiveKey] = useState<string | null>(queue[0]?.key ?? null)
  const [form] = Form.useForm()

  const active: QueueItem | undefined = queue.find((item) => item.key === activeKey) ?? queue[0]

  // 成员变化导致队列重算后，旧选中项可能已不在队列
  useEffect(() => {
    if (activeKey && !queue.some((item) => item.key === activeKey)) setActiveKey(queue[0]?.key ?? null)
  }, [queue, activeKey])

  const submit = async (values: { result: '已通过' | '已退回' | '不适用'; note: string; environment: string }) => {
    if (!active) return
    const result = await submitReview(active.key, values)
    setWorkspace(result.workspace)
    queryClient.setQueryData(['workspace'], result.workspace)
    form.resetFields()
    message.success(`复测结果已记录：${values.result}`)
  }

  const columns: ColumnsType<QueueItem> = [
    {
      title: '问题 / 根因组',
      dataIndex: 'key',
      render: (_, record) => (
        <div>
          <Typography.Text strong>{record.key}</Typography.Text>
          <div>{record.issue.title}</div>
          {record.groupId && <Tag color="teal" style={{ fontSize: 11 }}>{record.groupId} · v{record.groupVersion} · {record.members.length} 项成员</Tag>}
        </div>
      ),
    },
    { title: '修复说明', dataIndex: 'fixNote', width: 240, render: (_, record) => record.issue.fixNote ?? '未提交' },
    { title: '环境', dataIndex: 'retestEnv', width: 190, render: (_, record) => record.issue.retestEnv ?? '待开发提交' },
    { title: '状态', dataIndex: 'status', width: 90, render: (_, record) => <Tag color={record.issue.status === '已退回' ? 'error' : 'orange'}>{record.issue.status}</Tag> },
  ]

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">RETEST / 复测工作台</p>
          <h1>逐项验证修复结果</h1>
          <p className="muted">复测必须记录环境和结论；退回的问题不可无痕跳过。队列按根因组当前成员实时生成。</p>
        </div>
        <Space>
          <Tag color="orange">{queue.length} 项待复测</Tag>
          <Tag color="teal">统计口径 {stats.memberSignature ? `成员签名 ${stats.memberSignature.slice(0, 18)}…` : '无合并组'}</Tag>
        </Space>
      </div>

      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="复测规则" description="键盘问题必须覆盖 Tab、Shift+Tab、Esc 和焦点返回；屏幕阅读器问题需保留截图或播报日志。根因组以主问题为复测对象，结论按当前成员聚合记录。" />

      <div className="review-grid">
        <div className="panel">
          <div className="panel-head"><h3>复测队列</h3><span className="muted">点击选择问题</span></div>
          <Table rowKey="key" columns={columns} dataSource={queue} pagination={false} rowClassName={(record) => record.key === active?.key ? 'ant-table-row-selected' : ''} onRow={(record) => ({ onClick: () => { setActiveKey(record.key); form.resetFields() } })} scroll={{ x: 780 }} />
        </div>

        <div className="panel review-box">
          <Typography.Title level={4}>{active?.key ?? '暂无可复测项'}</Typography.Title>
          {active && (
            <>
              {active.groupId && (
                <Alert type="success" showIcon style={{ marginBottom: 12 }} message={`根因组 ${active.groupId} · 成员版本 v${active.groupVersion}`} description={`当前成员：${active.members.map((member) => `${member.key}（${member.status}）`).join('、')}`} />
              )}
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="问题">{active.issue.title}</Descriptions.Item>
                <Descriptions.Item label="根因">{active.issue.rootCause}</Descriptions.Item>
                <Descriptions.Item label="修复说明">{active.issue.fixNote ?? '未提交'}</Descriptions.Item>
                <Descriptions.Item label="复测环境">{active.issue.retestEnv ?? '待开发提交'}</Descriptions.Item>
              </Descriptions>
              <Form form={form} layout="vertical" style={{ marginTop: 18 }} onFinish={submit} initialValues={{ result: '已通过' }}>
                <Form.Item name="result" label="复测结论" rules={[{ required: true }]}>
                  <Radio.Group><Radio.Button value="已通过">通过</Radio.Button><Radio.Button value="已退回">退回</Radio.Button><Radio.Button value="不适用">不适用</Radio.Button></Radio.Group>
                </Form.Item>
                <Form.Item name="environment" label="本次复测环境" rules={[{ required: true }]}><Input placeholder="浏览器 / 辅助技术 / 版本号" /></Form.Item>
                <Form.Item name="note" label="复测记录" rules={[{ required: true, message: '请填写可验证的复测记录' }]}><Input.TextArea rows={5} placeholder="记录实际操作、结果与证据位置" /></Form.Item>
                <Button type="primary" htmlType="submit" block>提交复测记录</Button>
              </Form>
              <Typography.Title level={5} style={{ marginTop: 20 }}>历史复测（按当前成员聚合）</Typography.Title>
              {active.retestRecords.length === 0 && <Typography.Text type="secondary">暂无历史记录</Typography.Text>}
              {active.retestRecords.map((record) => <div className="timeline-item" key={record.id}><Tag color={record.result === '通过' ? 'success' : record.result === '退回' ? 'error' : 'default'}>{record.result}</Tag><Typography.Text strong>{record.actor}</Typography.Text><div>{record.note}</div><Typography.Text type="secondary" style={{ fontSize: 11 }}>{record.at}</Typography.Text></div>)}
            </>
          )}
        </div>
      </div>
    </section>
  )
}
