import { useMemo, useState } from 'react'
import { Button, Checkbox, Select, Space, Table, Tag, Typography, message } from 'antd'
import { useWorkspaceStats } from '../api/useIssues'

const FIELD_MAP: Record<string, string> = {
  'A11Y-1048': '修复状态',
  'A11Y-1052': '客服弹窗焦点',
  'A11Y-1061': '券选择层键盘循环',
  'A11Y-1074': '图表色板',
  'A11Y-1083': '错误提示实现',
}
const CANDIDATE_MAP: Record<string, string> = {
  'A11Y-1048': '已提交复测材料（focus trap 退出 + 焦点归还）',
  'A11Y-1052': 'triggerRef.focus 恢复逻辑已上线',
  'A11Y-1061': '券选择层 Esc 关闭并归还焦点',
  'A11Y-1074': '#1D6570 / 对比度 5.1:1 + 纹理',
  'A11Y-1083': 'aria-live + aria-describedby',
}

export default function VersionsPage() {
  const stats = useWorkspaceStats()
  const trackedKeys = ['A11Y-1048', 'A11Y-1052', 'A11Y-1061', 'A11Y-1074', 'A11Y-1083']
  const [accepted, setAccepted] = useState<string[]>(['A11Y-1074'])

  // 变更清单从当前工作区派生：成员被移出/移入后基线状态自动跟着变，不会出现版本差异对不上
  const diffs = useMemo(
    () =>
      stats.issues
        .filter((issue) => trackedKeys.includes(issue.key))
        .map((issue) => {
          const group = stats.groups.find((item) => item.memberKeys.includes(issue.key))
          const risk = issue.impact === '致命' ? '高' : issue.impact === '严重' ? '中' : '低'
          return {
            key: issue.key,
            field: FIELD_MAP[issue.key] ?? issue.issueType,
            baseline: group
              ? `根因组 ${group.id} v${group.memberVersion} / ${group.primaryKey === issue.key ? '主问题' : '成员'} / ${issue.status}`
              : `独立问题 / ${issue.status}`,
            candidate: CANDIDATE_MAP[issue.key] ?? '随根因组统一修复',
            risk,
            status: issue.status,
          }
        }),
    [stats],
  )

  const acceptedIssues = stats.issues.filter((issue) => accepted.includes(issue.key))
  const willClose = acceptedIssues.filter((issue) => !['已通过', '不适用'].includes(issue.status)).length
  const willRetest = acceptedIssues.filter((issue) => issue.status === '待复测').length

  const toggle = (key: string, checked: boolean) => {
    setAccepted((current) => checked ? [...new Set([...current, key])] : current.filter((item) => item !== key))
  }

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">VERSION DIFF / 版本差异</p>
          <h1>比较整改版本并部分采纳</h1>
          <p className="muted">可选择接受单一变更，生成新的整改版本而不覆盖基线。基线口径与根因组当前成员保持一致。</p>
        </div>
        <Space>
          <Select defaultValue="v4.18" options={[{ value: 'v4.18' }, { value: 'v4.17' }]} style={{ width: 110 }} />
          <span>对比</span>
          <Select defaultValue="v4.18-rc2" options={[{ value: 'v4.18-rc2' }, { value: 'v4.19-dev' }]} style={{ width: 130 }} />
          <Button type="primary" disabled={!accepted.length} onClick={() => message.success(`已接受 ${accepted.length} 项变更并生成新修订`)}>接受所选变更</Button>
        </Space>
      </div>

      <div style={{ marginBottom: 12 }}>
        <Tag color="teal">成员签名 {stats.memberSignature ? stats.memberSignature.slice(0, 24) : '无合并组'}…</Tag>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>根因组成员变化后，下方基线与影响会立即按当前成员重算</Typography.Text>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>变更清单</h3><Tag color="blue">基线 v4.18</Tag></div>
        <Table
          rowKey="key"
          dataSource={diffs}
          pagination={false}
          scroll={{ x: 900 }}
          columns={[
            { title: '采纳', width: 70, render: (_, record) => <Checkbox checked={accepted.includes(record.key)} onChange={(event) => toggle(record.key, event.target.checked)} /> },
            { title: '问题', dataIndex: 'key', width: 110, render: (value) => <Typography.Text strong>{value}</Typography.Text> },
            { title: '变更项', dataIndex: 'field', width: 150 },
            { title: '当前基线（按当前成员）', dataIndex: 'baseline', width: 320, render: (value) => <span style={{ color: '#9a4d35' }}>{value}</span> },
            { title: '候选版本', dataIndex: 'candidate', width: 330, render: (value) => <span style={{ color: '#26705a' }}>{value}</span> },
            { title: '风险', dataIndex: 'risk', width: 80, render: (value) => <Tag color={value === '高' ? 'red' : value === '中' ? 'gold' : 'green'}>{value}</Tag> },
          ]}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14 }}>
        <div className="panel"><div className="panel-head"><h3>被接受变更的影响</h3></div><div style={{ padding: 16 }}><Typography.Paragraph>预计关闭 {willClose} 个开放问题，新增 {willRetest} 次复测任务。已按根因组当前成员（{stats.groupStats.map((group) => `${group.group.id} v${group.group.memberVersion}`).join('、') || '无合并组'}）计算。</Typography.Paragraph><Space><Tag color="green">共 {stats.groupStats.reduce((sum, group) => sum + group.saved, 0)} 项重复成员合并处理</Tag><Tag color="blue">覆盖 {new Set(acceptedIssues.map((issue) => issue.site)).size} 个站点</Tag></Space></div></div>
        <div className="panel"><div className="panel-head"><h3>版本操作历史</h3></div><div style={{ padding: 16 }}><div className="timeline-item"><strong>v4.18-rc2 创建</strong><div>仅包含无障碍修复，不影响业务功能。</div><span className="muted">何沐 · 09-28 16:20</span></div></div></div>
      </div>
    </section>
  )
}
