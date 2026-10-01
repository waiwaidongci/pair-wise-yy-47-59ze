import { Button, Progress, Space, Tag, Typography } from 'antd'
import { ArrowRightOutlined, CheckCircleOutlined, ClockCircleOutlined, ExclamationCircleOutlined, MergeCellsOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useWorkspaceStats } from '../api/useIssues'

export default function DashboardPage() {
  const stats = useWorkspaceStats()
  const navigate = useNavigate()
  const { openCount, passedCount, criticalCount, coverage, bySite, groupStats, groups } = stats
  const totalSaved = groupStats.reduce((sum, group) => sum + group.saved, 0)
  const pendingRetestPrimary = groupStats.find((group) => ['待复测', '已退回'].includes(group.primary.status))
  const dueSoon = stats.issues.filter((issue) => {
    const diff = new Date(issue.dueDate).getTime() - new Date('2026-10-01').getTime()
    return diff >= 0 && diff <= 3 * 24 * 3600 * 1000
  })

  const focusCards = [
    pendingRetestPrimary
      ? { icon: <ExclamationCircleOutlined />, tone: '#ba4d31', title: `${pendingRetestPrimary.primary.key} 等待复测结论`, detail: `根因组 ${pendingRetestPrimary.group.id}（v${pendingRetestPrimary.group.memberVersion}）含 ${pendingRetestPrimary.members.length} 项成员，复测以主问题为准`, action: '前往复测' }
      : { icon: <CheckCircleOutlined />, tone: '#367d61', title: '根因组复测已全部处理', detail: '当前没有待复测/已退回的整改项', action: '前往复测' },
    { icon: <ClockCircleOutlined />, tone: '#ba8529', title: `${dueSoon.length} 项临近截止`, detail: dueSoon.length ? `未来 3 天内到期：${dueSoon.map((issue) => issue.key).join('、')}` : '未来 3 天无到期项', action: '查看排期' },
    groupStats.length
      ? { icon: <MergeCellsOutlined />, tone: '#257c80', title: `根因组合并节省 ${totalSaved} 次处理`, detail: groupStats.map((group) => `${group.group.id} 关联 ${group.members.length} 项 / v${group.group.memberVersion}`).join('；'), action: '查看合并关系' }
      : { icon: <CheckCircleOutlined />, tone: '#367d61', title: '暂无根因组', detail: '可在问题台账把同根因问题合并', action: '查看合并关系' },
  ]

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">ACCESSIBILITY PROGRAM / 无障碍治理</p>
          <h1>多站点整改总览</h1>
          <p className="muted">按风险、版本和团队持续跟踪 WCAG 问题；根因组成员一变，总览立即按当前成员重算。</p>
        </div>
        <Space>
          <Button onClick={() => navigate('/versions')}>查看版本差异</Button>
          <Button type="primary" onClick={() => navigate('/issues')}>进入问题台账 <ArrowRightOutlined /></Button>
        </Space>
      </div>

      <div className="metric-grid">
        <div className="metric-card"><span>开放问题</span><strong>{openCount}</strong><small>{stats.total} 条总记录</small></div>
        <div className="metric-card"><span>严重 / 致命</span><strong style={{ color: '#b84f32' }}>{criticalCount}</strong><small>需优先排期</small></div>
        <div className="metric-card"><span>复测通过率</span><strong>{coverage}%</strong><small>当前成员口径</small></div>
        <div className="metric-card"><span>覆盖站点</span><strong>{bySite.length}</strong><small>统一 WCAG 2.2 AA</small></div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <Tag color="teal">统计口径：{groups.length} 个根因组 · 成员签名 {stats.memberSignature ? stats.memberSignature.slice(0, 24) : '无合并组'}…</Tag>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>成员版本变化即作废旧统计，以下数字始终按当前成员计算</Typography.Text>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.2fr) minmax(300px,.8fr)', gap: 14 }}>
        <div className="panel">
          <div className="panel-head"><h3>站点整改进度</h3><Tag color="blue">按当前成员实时统计</Tag></div>
          <div style={{ padding: 18 }}>
            {bySite.map((item) => (
              <div key={item.site} style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}>
                  <Typography.Text strong>{item.site}</Typography.Text>
                  <Typography.Text type="secondary">{item.passed}/{item.total} 已通过</Typography.Text>
                </div>
                <Progress percent={Math.round((item.passed / item.total) * 100)} showInfo={false} strokeColor="#257c80" />
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><h3>处理关注</h3><span className="muted">随成员版本更新</span></div>
          <div style={{ padding: 12 }}>
            {focusCards.map((item) => (
              <div key={item.title} style={{ display: 'flex', gap: 10, padding: 12, borderBottom: '1px solid #edf1f2' }}>
                <span style={{ color: item.tone, fontSize: 20 }}>{item.icon}</span>
                <div style={{ flex: 1 }}><Typography.Text strong>{item.title}</Typography.Text><Typography.Paragraph type="secondary" style={{ margin: '5px 0 0', fontSize: 12 }}>{item.detail}</Typography.Paragraph></div>
                <Button size="small" type="link" onClick={() => navigate('/retest')}>{item.action}</Button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
