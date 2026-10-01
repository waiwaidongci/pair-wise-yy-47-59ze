import type {
  HistoryEvent,
  Issue,
  IssueStatus,
  MergeConflictCode,
  MergeRequest,
  MergeResult,
  RemoveMemberResult,
  RootCauseGroup,
  VersionConflict,
  Workspace,
} from './types'

export const INITIAL_MEMBER_VERSION = 1

/** 合并时被降级成员的状态 */
export const MERGED_MEMBER_STATUS: IssueStatus = '不适用'
/** 从根因组移出时若无历史状态可恢复，回到的默认状态 */
export const RESTORED_DEFAULT_STATUS: IssueStatus = '待分配'
/** 终态统计口径 */
export const CLOSED_STATUSES: IssueStatus[] = ['已通过', '不适用']

export class MergeConflictError extends Error {
  code: MergeConflictCode
  /** 版本冲突时，晚到方核对错的组及其期望/实际成员版本 */
  conflicts: VersionConflict[]
  /** 服务端始终回传最新工作区，便于对方刷新后重新确认 */
  workspace: Workspace | null

  constructor(code: MergeConflictCode, message: string, conflicts: VersionConflict[] = [], workspace: Workspace | null = null) {
    super(message)
    this.name = 'MergeConflictError'
    this.code = code
    this.conflicts = conflicts
    this.workspace = workspace
  }
}

export const nowLabel = () => {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const findIssue = (issues: Issue[], key: string) => issues.find((issue) => issue.key === key)

const memberKeySet = (group: RootCauseGroup) => new Set(group.memberKeys)

/**
 * 按现有合并关系（mergedKeys）回填根因组与成员版本。
 * 以“主问题 mergedKeys 指向成员、成员 mergedKeys 指回主问题”的现有数据为准，
 * 只补齐 groupId / 成员版本与成员反向引用，不改动任何既有状态。
 */
export function backfillGroups(input: Issue[], at: string = nowLabel()): Workspace {
  const issues = input.map((issue) => ({ ...issue }))
  const byKey = new Map(issues.map((issue) => [issue.key, issue]))

  // 并查集：把 mergedKeys 里互相指向的问题闭合成一个根因组
  const parent = new Map<string, string>()
  const ensure = (key: string) => {
    if (!parent.has(key)) parent.set(key, key)
    return key
  }
  const find = (key: string): string => {
    ensure(key)
    const p = parent.get(key)!
    if (p === key) return key
    const root = find(p)
    parent.set(key, root)
    return root
  }
  const union = (a: string, b: string) => {
    if (!byKey.has(a) || !byKey.has(b)) return
    parent.set(find(a), find(b))
  }

  for (const issue of issues) {
    ensure(issue.key)
    for (const ref of issue.mergedKeys) union(issue.key, ref)
  }

  const clusters = new Map<string, string[]>()
  // 只要簇内出现过一条合并边（mergedKeys 非空），簇中全部问题都纳入根因组
  const edgeRoots = new Set<string>()
  for (const issue of issues) {
    if (issue.mergedKeys.length > 0) edgeRoots.add(find(issue.key))
  }
  for (const issue of issues) {
    if (!edgeRoots.has(find(issue.key))) continue
    const root = find(issue.key)
    if (!clusters.has(root)) clusters.set(root, [])
    clusters.get(root)!.push(issue.key)
  }

  const groups: RootCauseGroup[] = []
  for (const memberKeysAll of clusters.values()) {
    const members = memberKeysAll.filter((key, i) => memberKeysAll.indexOf(key) === i)
    if (members.length < 2) continue
    // 主问题：现有数据中“mergedKeys 指向其他成员”的那条即主问题；
    // 若互相都有指向（旧数据不规整），取最小 key，保持回填结果稳定
    const pointsToOthers = members.filter((key) => {
      const refs = byKey.get(key)?.mergedKeys ?? []
      return refs.some((ref) => ref !== key && members.includes(ref))
    })
    const primaryKey = pointsToOthers.sort()[0] ?? members[0]
    const rest = members.filter((key) => key !== primaryKey)
    const groupId = `RCG-${primaryKey}`
    const group: RootCauseGroup = {
      id: groupId,
      rootCause: byKey.get(primaryKey)?.rootCause ?? '',
      primaryKey,
      memberKeys: [primaryKey, ...rest],
      memberVersion: INITIAL_MEMBER_VERSION,
      createdAt: at,
      updatedAt: at,
    }
    groups.push(group)
    // 只补关系字段，绝不覆盖状态（包括已通过成员）
    for (const key of group.memberKeys) {
      const issue = byKey.get(key)
      if (!issue) continue
      issue.groupId = groupId
      issue.mergedKeys = key === primaryKey ? rest : [primaryKey]
    }
  }

  return { issues, groups }
}

export type MergePreview = {
  /** 提交方应携带的期望版本 */
  expectedVersions: Record<string, number>
  /** 本次会触及的现有根因组 id */
  touchedGroupIds: string[]
  /** 合并后主问题 key */
  primaryKey: string
  /** 若直接提交会被“已通过保护”拒绝的问题 */
  blockedPassedKeys: string[]
  /** 选中项已是同一组、无需任何变化 */
  noop: boolean
}

/** 以当前工作区为准，为一次合并选择生成核对信息（成员版本 + 预校验） */
export function previewMerge(workspace: Workspace, keys: string[]): MergePreview {
  const selected = Array.from(new Set(keys))
  const touched = workspace.groups.filter((group) => selected.some((key) => group.memberKeys.includes(key)))
  const expectedVersions = Object.fromEntries(touched.map((group) => [group.id, group.memberVersion]))

  // 主问题：第一个选中项若已在组内，沿用该组主问题（根因组不允许被拆散）；否则取第一个
  const firstGroup = workspace.groups.find((group) => memberKeySet(group).has(selected[0]))
  const primaryKey = firstGroup?.primaryKey ?? selected[0]

  const blockedPassedKeys = selected.filter((key) => {
    const issue = findIssue(workspace.issues, key)
    if (!issue || issue.status !== '已通过') return false
    const origin = workspace.groups.find((g) => memberKeySet(g).has(key))
    const targetId = firstGroup?.id
    // 已通过成员：只能留在原根因组（origin 必须就是目标组）；已通过独立问题：只能作为目标主问题
    if (origin) return origin.id !== targetId
    return key !== primaryKey
  })

  const targetGroup = workspace.groups.find((group) => group.primaryKey === primaryKey)
  const noop =
    selected.length > 0 &&
    touched.length <= 1 &&
    (targetGroup ? targetGroup.memberKeys.length === selected.length && selected.every((key) => memberKeySet(targetGroup).has(key)) : false)

  return {
    expectedVersions,
    touchedGroupIds: touched.map((group) => group.id),
    primaryKey,
    blockedPassedKeys,
    noop,
  }
}

/** 已通过保护：已通过成员只能留在原根因组；已通过独立问题只能作为目标主问题，其余一律拦截 */
const passedGuard = (workspace: Workspace, primaryKey: string, targetId: string, mergedKeys: Set<string>): string[] =>
  workspace.issues
    .filter((issue) => issue.status === '已通过' && mergedKeys.has(issue.key))
    .filter((issue) => {
      const origin = workspace.groups.find((g) => memberKeySet(g).has(issue.key))
      if (origin) return origin.id !== targetId
      return issue.key !== primaryKey
    })
    .map((issue) => issue.key)

/**
 * 两名审核员同时提交同一条问题的合并：
 * 晚到方携带读取时的 expectedVersions，按服务端最新成员版本核对，
 * 任何一个被触及的组成员已变化 -> 409 拒绝并回传最新工作区让其重新确认。
 */
export function mergeGroups(workspace: Workspace, request: MergeRequest, at: string = nowLabel()): MergeResult {
  const keys = Array.from(new Set(request.keys))
  const actor = request.actor ?? '当前用户'
  if (keys.length < 2) throw new MergeConflictError('bad-request', '至少选择 2 条问题才能合并')

  const issues = workspace.issues.map((issue) => ({ ...issue }))
  const groups = workspace.groups.map((group) => ({ ...group, memberKeys: [...group.memberKeys] }))
  const byKey = new Map(issues.map((issue) => [issue.key, issue]))

  for (const key of keys) {
    if (!byKey.has(key)) throw new MergeConflictError('not-found', `问题 ${key} 不存在`, [], { issues: workspace.issues, groups: workspace.groups })
  }

  // 1) 按最新成员版本核对乐观锁
  const conflicts: VersionConflict[] = []
  const touched = groups.filter((group) => keys.some((key) => group.memberKeys.includes(key)))
  for (const group of touched) {
    const expected = request.expectedVersions[group.id]
    if (expected === undefined || expected !== group.memberVersion) {
      conflicts.push({ groupId: group.id, expected: expected ?? null, actual: group.memberVersion })
    }
  }
  if (conflicts.length > 0) {
    throw new MergeConflictError(
      'version-conflict',
      `根因组成员已被其他审核员更新（成员版本 ${conflicts.map((c) => `${c.groupId} v${c.actual}`).join('、')}），请按最新成员重新确认`,
      conflicts,
      { issues: workspace.issues, groups: workspace.groups },
    )
  }

  // 2) 确定主问题：第一个选中项若已在组内，沿用该组主问题（根因组不允许被拆散）；否则取第一个
  const firstGroup = groups.find((group) => memberKeySet(group).has(keys[0]))
  const primaryKey = firstGroup?.primaryKey ?? keys[0]
  const primary = byKey.get(primaryKey)!
  const primaryGroup = groups.find((group) => group.primaryKey === primaryKey)
  const targetId = primaryGroup?.id ?? `RCG-${primaryKey}`

  // 先放入所有被选中的问题，再把它们所在组的现有成员一并并入（整组合并）
  const memberSet = new Set<string>(keys)
  for (const key of keys) {
    const group = groups.find((g) => memberKeySet(g).has(key))
    if (group) for (const member of group.memberKeys) memberSet.add(member)
  }

  // 3) 已通过保护：不能把已通过问题吞进别的组（降级为成员或跨组移动都拒绝）
  const blocked = passedGuard(workspace, primaryKey, targetId, memberSet)
  if (blocked.length > 0) {
    throw new MergeConflictError(
      'passed-protected',
      `已通过问题 ${blocked.join('、')} 不能并入其他根因组，请重新确认合并范围`,
      [],
      { issues: workspace.issues, groups: workspace.groups },
    )
  }

  const rest = [...memberSet].filter((key) => key !== primaryKey).sort()
  const oldMemberSet = new Set(primaryGroup ? primaryGroup.memberKeys : [primaryKey])
  const changed =
    !primaryGroup ||
    rest.length !== primaryGroup.memberKeys.length - 1 ||
    rest.some((key) => !oldMemberSet.has(key)) ||
    primaryGroup.memberKeys.some((key) => !memberSet.has(key))

  // 4) 组装新组：合并沿用主组 id 与成员版本递增；全新组从 v1 开始
  const nextVersion = primaryGroup ? primaryGroup.memberVersion + 1 : INITIAL_MEMBER_VERSION
  const targetGroup: RootCauseGroup = primaryGroup
    ? { ...primaryGroup, rootCause: primary.rootCause, memberKeys: [primaryKey, ...rest], memberVersion: nextVersion, updatedAt: at }
    : { id: targetId, rootCause: primary.rootCause, primaryKey, memberKeys: [primaryKey, ...rest], memberVersion: nextVersion, createdAt: at, updatedAt: at }

  // 主组与被吸收的其他根因组都从列表移除（成员已并入 target），随后统一放回新 target
  const removeIds = new Set([
    ...(primaryGroup ? [primaryGroup.id] : []),
    ...groups.filter((g) => g.id !== targetId && keys.some((key) => memberKeySet(g).has(key))).map((g) => g.id),
  ])
  const nextGroups = [...groups.filter((g) => !removeIds.has(g.id)), targetGroup]

  // 5) 更新成员：主问题保持状态，其余成员降级为“不适用”但保留前态，已通过成员不受影响
  const nextIssues = issues.map((issue) => {
    if (!memberSet.has(issue.key)) {
      // 被吸收组里未选中的旧成员也随整组并入，仍属于新组
      return issue
    }
    const isPrimary = issue.key === primaryKey
    const history: HistoryEvent[] = isPrimary
      ? changed
        ? [...issue.history, { at, actor, action: '根因组成员变更', detail: `合并至根因组 ${targetId}，当前成员 ${[primaryKey, ...rest].length} 项，成员版本 v${nextVersion}` }]
        : issue.history
      : [...issue.history, { at, actor, action: '重复问题合并', detail: `并入根因组 ${targetId}（主问题 ${primaryKey}），成员版本 v${nextVersion}` }]
    if (isPrimary) {
      return { ...issue, groupId: targetId, rootCause: primary.rootCause, mergedKeys: rest, history }
    }
    const alreadyMember = issue.groupId === targetId
    return {
      ...issue,
      groupId: targetId,
      rootCause: primary.rootCause,
      mergedKeys: [primaryKey],
      prevStatus: alreadyMember ? issue.prevStatus : issue.status,
      status: alreadyMember ? issue.status : MERGED_MEMBER_STATUS,
      history,
    }
  })

  return { workspace: { issues: nextIssues, groups: nextGroups }, changed, group: targetGroup }
}

/** 把成员移出根因组（仅非主成员）。成员不足 2 条时整组解散，成员版本随成员变化递增。 */
export function removeGroupMember(
  workspace: Workspace,
  groupId: string,
  memberKey: string,
  expectedVersion: number,
  at: string = nowLabel(),
  actor = '当前用户',
): RemoveMemberResult {
  const group = workspace.groups.find((item) => item.id === groupId)
  if (!group) throw new MergeConflictError('not-found', `根因组 ${groupId} 不存在`, [], { issues: workspace.issues, groups: workspace.groups })
  if (memberKey === group.primaryKey) throw new MergeConflictError('bad-request', '主问题不能移出根因组')
  if (!group.memberKeys.includes(memberKey)) throw new MergeConflictError('bad-request', `${memberKey} 不在根因组 ${groupId} 中`)
  if (expectedVersion !== group.memberVersion) {
    throw new MergeConflictError(
      'version-conflict',
      `根因组成员已变化（最新成员版本 v${group.memberVersion}），请刷新后重新确认`,
      [{ groupId, expected: expectedVersion, actual: group.memberVersion }],
      { issues: workspace.issues, groups: workspace.groups },
    )
  }

  const rest = group.memberKeys.filter((key) => key !== memberKey && key !== group.primaryKey)
  const nextIssues = workspace.issues.map((issue) => {
    if (issue.key === memberKey) {
      const restored = issue.status === MERGED_MEMBER_STATUS ? (issue.prevStatus ?? RESTORED_DEFAULT_STATUS) : issue.status
      return {
        ...issue,
        groupId: undefined,
        mergedKeys: [],
        status: restored,
        prevStatus: undefined,
        history: [...issue.history, { at, actor, action: '移出根因组', detail: `退出 ${groupId}，恢复状态「${restored}」` }],
      }
    }
    if (rest.length === 0 && issue.key === group.primaryKey) {
      return { ...issue, groupId: undefined, mergedKeys: [], history: [...issue.history, { at, actor, action: '根因组解散', detail: `成员全部移出，根因组 ${groupId} 解散` }] }
    }
    if (issue.key === group.primaryKey) {
      return { ...issue, mergedKeys: rest, history: [...issue.history, { at, actor, action: '根因组成员变更', detail: `${memberKey} 移出，成员版本 v${group.memberVersion + 1}` }] }
    }
    return issue
  })

  if (rest.length === 0) {
    return { workspace: { issues: nextIssues, groups: workspace.groups.filter((item) => item.id !== groupId) }, group: null }
  }

  const nextGroup: RootCauseGroup = { ...group, memberKeys: [group.primaryKey, ...rest], memberVersion: group.memberVersion + 1, updatedAt: at }
  return { workspace: { issues: nextIssues, groups: workspace.groups.map((item) => (item.id === groupId ? nextGroup : item)) }, group: nextGroup }
}
