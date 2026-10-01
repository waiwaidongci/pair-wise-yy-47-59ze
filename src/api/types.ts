export type IssueStatus = '待分配' | '修复中' | '待复测' | '已通过' | '已退回' | '不适用'

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
  /**
   * 根因组主问题标识：子项指向主问题的 key，主问题为 null。
   * 用于明确组成员关系，避免 mergedKeys 双向引用时无法区分主从。
   */
  parentKey: string | null
  /**
   * 成员版本：根因组成员关系的乐观锁版本号。
   * 每当该组的成员（mergedKeys）发生变化时自增，用于并发合并时的冲突核对。
   * 非根因组（子项）恒为 0。
   */
  memberVersion: number
  fixNote?: string
  retestEnv?: string
  retestRecords: Array<{ id: string; actor: string; result: string; note: string; at: string }>
  history: Array<{ at: string; actor: string; action: string; detail: string }>
}
