import type { Issue } from '../api/types'

/**
 * 判断一条问题是否为某个根因组的子项（被合并进主问题）。
 * 子项的 parentKey 指向主问题；主问题为 null。
 */
export function isMergedChild(issue: Issue, _issues: Issue[]): boolean {
  return issue.parentKey != null
}

/**
 * 当前成员：未被合并的根因组主问题（或独立问题）。
 * 总览、复测队列、报告均按当前成员重算，子项不再独立计数。
 */
export function isRootIssue(issue: Issue, issues: Issue[]): boolean {
  return !isMergedChild(issue, issues)
}

export type OverviewStats = {
  /** 根因组数量（整改项） */
  total: number
  /** 开放组（未通过 / 未适用） */
  open: number
  /** 已通过组 */
  passed: number
  /** 严重 / 致命组 */
  critical: number
  /** 复测通过率（%） */
  coverage: number
  bySite: Array<{ site: string; total: number; passed: number }>
}

/**
 * 按当前成员（根因组）重算总览统计。
 * 只要成员变化，调用方应在 memberVersion / statsVersion 变化后重新调用本函数。
 */
export function computeOverview(issues: Issue[]): OverviewStats {
  const roots = issues.filter((issue) => isRootIssue(issue, issues))
  const open = roots.filter((issue) => !['已通过', '不适用'].includes(issue.status))
  const passed = roots.filter((issue) => issue.status === '已通过')
  const critical = roots.filter((issue) => issue.impact === '致命' || issue.impact === '严重')
  const coverage = roots.length ? Math.round((passed.length / roots.length) * 100) : 0
  const siteNames = Array.from(new Set(roots.map((issue) => issue.site)))
  const bySite = siteNames.map((site) => {
    const items = roots.filter((issue) => issue.site === site)
    return { site, total: items.length, passed: items.filter((issue) => issue.status === '已通过').length }
  })
  return { total: roots.length, open: open.length, passed: passed.length, critical: critical.length, coverage, bySite }
}

/**
 * 按当前成员重算复测队列：仅保留需要复测的根因组，子项不单独入队。
 */
export function computeRetestQueue(issues: Issue[]): Issue[] {
  return issues.filter((issue) => isRootIssue(issue, issues) && ['待复测', '已退回'].includes(issue.status))
}

/**
 * 按当前成员重算报告行：仅列出根因组（当前成员），子项作为组成员不再单独成行。
 */
export function computeReportRows(issues: Issue[], site: string): Issue[] {
  return issues.filter((issue) => isRootIssue(issue, issues) && (site === '全部站点' || issue.site === site))
}
