export type IssueStatus = '待分配' | '修复中' | '待复测' | '已通过' | '已退回' | '不适用'

export interface RetestRecord {
  id: string
  actor: string
  result: string
  note: string
  at: string
}

export interface HistoryEvent {
  at: string
  actor: string
  action: string
  detail: string
}

export type Issue = {
  key: string
  title: string
  site: string
  version: string
  wcag: string[]
  issueType: string
  impact: '致命' | '严重' | '中等' | '轻微'
  affected: string
  reproduction: string
  evidence: string
  rootCause: string
  status: IssueStatus
  priority: 'P0' | 'P1' | 'P2' | 'P3'
  team: string
  owner: string
  dueDate: string
  mergedKeys: string[]
  fixNote?: string
  retestEnv?: string
  retestRecords: RetestRecord[]
  history: HistoryEvent[]
  /** 所属根因组；独立问题为空 */
  groupId?: string
  /** 被合并降级为“不适用”前的状态，移出根因组时恢复 */
  prevStatus?: IssueStatus
}

/** 根因组：成员集合自带版本，任何成员变化都会令 memberVersion 递增 */
export type RootCauseGroup = {
  id: string
  rootCause: string
  primaryKey: string
  /** 当前成员，主问题恒为第一个 */
  memberKeys: string[]
  /** 成员版本：初始/新建为 1，成员集合每变一次 +1 */
  memberVersion: number
  createdAt: string
  updatedAt: string
}

export type Workspace = {
  issues: Issue[]
  groups: RootCauseGroup[]
}

export type MergeRequest = {
  /** 选中的问题 key，第一个用于确定主问题（若它已在组内则沿用该组主问题） */
  keys: string[]
  /** 提交方核对的“组 id -> 已读成员版本”，独立问题不出现在 map 中 */
  expectedVersions: Record<string, number>
  actor?: string
}

export type VersionConflict = { groupId: string; expected: number | null; actual: number }

export type MergeConflictCode = 'version-conflict' | 'passed-protected' | 'not-found' | 'bad-request'

export type MergeResult = {
  workspace: Workspace
  changed: boolean
  group: RootCauseGroup
}

export type RemoveMemberResult = {
  workspace: Workspace
  /** 成员不足 2 条时根因组解散，返回 null */
  group: RootCauseGroup | null
}
