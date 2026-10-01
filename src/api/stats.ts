import type { Issue, RootCauseGroup, Workspace } from './types'
import { CLOSED_STATUSES } from './groups'

export type QueueItem = {
  /** 队列条目以根因组为口径：组用主问题，独立问题用自身 */
  key: string
  groupId: string | null
  groupVersion: number | null
  issue: Issue
  /** 当前成员（独立问题只有自身） */
  members: Issue[]
  retestRecords: Issue['retestRecords']
}

export type SiteStat = { site: string; total: number; passed: number }

export type GroupStat = {
  group: RootCauseGroup
  members: Issue[]
  primary: Issue
  passed: number
  open: number
  /** 合并节省的处理数：降级为重复项（不适用）的成员数 */
  saved: number
}

export type WorkspaceStats = {
  issues: Issue[]
  groups: RootCauseGroup[]
  total: number
  openCount: number
  passedCount: number
  criticalCount: number
  coverage: number
  bySite: SiteStat[]
  groupStats: GroupStat[]
  /** 复测队列：按当前成员重算；组内任一成员的复测记录都会汇总到主问题条目 */
  retestQueue: QueueItem[]
  /** 统计口径：成员签名。成员一变签名即变，旧缓存作废 */
  memberSignature: string
  /** 与状态相关的修订号；仅状态变化时统计数字也需要刷新 */
  dataRevision: string
}

/**
 * 成员签名：完整刻画“谁属于哪个根因组”。
 * 根因或状态编辑不影响它；任何成员增减/移组都会改变它，使旧统计立即失效。
 */
export function memberSignature(groups: RootCauseGroup[]): string {
  return groups
    .map((group) => `${group.id}@v${group.memberVersion}:[${[...group.memberKeys].sort().join(',')}]`)
    .sort()
    .join('|')
}

const dataRevisionOf = (issues: Issue[]) =>
  issues.map((issue) => `${issue.key}:${issue.status}:${issue.team}:${issue.owner}:${issue.fixNote ?? ''}`).join('|')

const recordRank = (at: string) => at

export function computeStats(workspace: Workspace): WorkspaceStats {
  const { issues, groups } = workspace
  const byKey = new Map(issues.map((issue) => [issue.key, issue]))
  const total = issues.length
  const passedCount = issues.filter((issue) => issue.status === '已通过').length
  const openCount = issues.filter((issue) => !CLOSED_STATUSES.includes(issue.status)).length
  const criticalCount = issues.filter((issue) => issue.impact === '致命' || issue.impact === '严重').length
  const coverage = total === 0 ? 0 : Math.round((passedCount / total) * 100)

  const bySite = Array.from(new Set(issues.map((issue) => issue.site))).map((site) => {
    const items = issues.filter((issue) => issue.site === site)
    return { site, total: items.length, passed: items.filter((issue) => issue.status === '已通过').length }
  })

  const groupStats: GroupStat[] = groups
    .map((group) => {
      const members = group.memberKeys.map((key) => byKey.get(key)).filter((issue): issue is Issue => Boolean(issue))
      const primary = byKey.get(group.primaryKey) ?? members[0]
      return {
        group,
        members,
        primary,
        passed: members.filter((issue) => issue.status === '已通过').length,
        open: members.filter((issue) => !CLOSED_STATUSES.includes(issue.status)).length,
        saved: members.filter((issue) => issue.status === '不适用').length,
      }
    })
    .filter((stat) => Boolean(stat.primary))

  const groupedKeys = new Set(groups.flatMap((group) => group.memberKeys))
  const queueOf = (issue: Issue, group: RootCauseGroup | null, members: Issue[]): QueueItem => ({
    key: issue.key,
    groupId: group?.id ?? null,
    groupVersion: group?.memberVersion ?? null,
    issue,
    members,
    retestRecords: members
      .flatMap((member) => member.retestRecords)
      .sort((a, b) => recordRank(b.at).localeCompare(recordRank(a.at))),
  })

  const retestQueue: QueueItem[] = []
  for (const stat of groupStats) {
    if (['待复测', '已退回'].includes(stat.primary.status)) retestQueue.push(queueOf(stat.primary, stat.group, stat.members))
  }
  for (const issue of issues) {
    if (!groupedKeys.has(issue.key) && ['待复测', '已退回'].includes(issue.status)) retestQueue.push(queueOf(issue, null, [issue]))
  }

  return {
    issues,
    groups,
    total,
    openCount,
    passedCount,
    criticalCount,
    coverage,
    bySite,
    groupStats,
    retestQueue,
    memberSignature: memberSignature(groups),
    dataRevision: dataRevisionOf(issues),
  }
}

// ---- 按成员版本缓存的统计：成员签名一变，旧统计立即作废并按当前成员重算 ----
let cached: { signature: string; revision: string; stats: WorkspaceStats } | null = null

export function getWorkspaceStats(workspace: Workspace): WorkspaceStats {
  const signature = memberSignature(workspace.groups)
  const revision = dataRevisionOf(workspace.issues)
  if (cached && cached.signature === signature && cached.revision === revision) return cached.stats
  const stats = computeStats(workspace)
  cached = { signature, revision, stats }
  return stats
}

/** 测试用：清空统计缓存 */
export function resetStatsCache() {
  cached = null
}
