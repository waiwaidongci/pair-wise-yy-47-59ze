import { seedIssues } from '../seed'
import { backfillGroups, mergeGroups, MergeConflictError, removeGroupMember, previewMerge } from '../groups'
import { getWorkspaceStats, resetStatsCache } from '../stats'

let pass = 0, fail = 0
const assert = (cond: boolean, msg: string) => { if (cond) { pass++; console.log('  ✓', msg) } else { fail++; console.error('  ✗', msg) } }

// 1. 旧数据回填
let ws = backfillGroups(structuredClone(seedIssues))
const g = ws.groups.find(g => g.id === 'RCG-A11Y-1048')!
console.log('回填:')
assert(ws.groups.length === 1, `回填出 1 个根因组（实际 ${ws.groups.length}）`)
assert(g.memberKeys.join() === 'A11Y-1048,A11Y-1052,A11Y-1061', `成员按现有合并关系回填（实际 ${g.memberKeys}）`)
assert(g.memberVersion === 1, '旧数据回填成员版本 v1')
assert(ws.issues.find(i => i.key === 'A11Y-1052')!.status === '已通过', '回填不改动已通过状态')
assert(ws.issues.find(i => i.key === 'A11Y-1052')!.groupId === 'RCG-A11Y-1048', '回填补齐 groupId')

// 2. 并发：两人同时把 A11Y-1090 并入 RCG-A11Y-1048
console.log('并发合并:')
const base = previewMerge(ws, ['A11Y-1048', 'A11Y-1090'])
assert(base.expectedVersions['RCG-A11Y-1048'] === 1, '先到方读取期望版本 v1')
const first = mergeGroups(ws, { keys: ['A11Y-1048', 'A11Y-1090'], expectedVersions: base.expectedVersions, actor: '审核员甲' })
assert(first.changed && first.group.memberVersion === 2, '先到方成功，成员版本 v1 -> v2')
assert(first.group.memberKeys.includes('A11Y-1090'), '新成员进入根因组')
ws = first.workspace
let rejected: any = null
try {
  mergeGroups(ws, { keys: ['A11Y-1048', 'A11Y-1090'], expectedVersions: { 'RCG-A11Y-1048': 1 }, actor: '审核员乙' })
} catch (e) { rejected = e }
assert(rejected instanceof MergeConflictError && rejected.code === 'version-conflict', '晚到方携带 v1 被拒绝（409 语义）')
assert(rejected.conflicts[0].actual === 2, '冲突信息回传最新成员版本 v2')
assert(rejected.workspace.groups[0].memberVersion === 2, '冲突回传最新工作区供重新确认')
// 乙按最新版本重新确认 -> 但成员已在组内，noop
const retry = mergeGroups(ws, { keys: ['A11Y-1048', 'A11Y-1090'], expectedVersions: { 'RCG-A11Y-1048': 2 }, actor: '审核员乙' })
assert(retry.changed === false, '乙按 v2 重新确认：已是同组，不重复改动')

// 3. 已通过保护
console.log('已通过保护:')
let prot: any = null
try {
  // 试图以 1074 为主，把已通过的 1052 吞进新组
  mergeGroups(ws, { keys: ['A11Y-1074', 'A11Y-1052'], expectedVersions: { 'RCG-A11Y-1048': 2 }, actor: '审核员丙' })
} catch (e) { prot = e }
assert(prot?.code === 'passed-protected', '已通过成员跨组移动被拒绝')
assert(ws.issues.find(i => i.key === 'A11Y-1052')!.status === '已通过', '拒绝后已通过结论原样保留')
// 同组内带已通过成员继续合并独立问题 -> 允许（已通过成员留在本组）
const stay = mergeGroups(ws, { keys: ['A11Y-1048', 'A11Y-1074'], expectedVersions: { 'RCG-A11Y-1048': 2 } })
assert(stay.changed && stay.group.memberVersion === 3, '同组扩张（含已通过成员留组）允许，v2 -> v3')
ws = stay.workspace
assert(ws.issues.find(i => i.key === 'A11Y-1052')!.status === '已通过', '同组扩张后 1052 仍为已通过')
assert(ws.issues.find(i => i.key === 'A11Y-1074')!.status === '不适用', '非通过新成员降级为不适用')
assert(ws.issues.find(i => i.key === 'A11Y-1074')!.prevStatus === '待复测', '降级前状态被保存')

// 3b. 更多已通过保护场景
console.log('已通过保护（补充）:')
// 已通过的独立问题作为非第一项并入 -> 拒绝（不能吞进别的组）
let prot2: any = null
try {
  const standalonePassed = structuredClone(seedIssues).map(i => i.key === 'A11Y-1090' ? { ...i, status: '已通过' as const } : i)
  const wsp = backfillGroups(standalonePassed)
  mergeGroups(wsp, { keys: ['A11Y-1074', 'A11Y-1090'], expectedVersions: {} })
} catch (e) { prot2 = e }
assert(prot2?.code === 'passed-protected', '已通过的独立问题被降级进组时拒绝')
// 已通过成员（1052）作为第一项会沿用组主问题 1048，同组扩张仍允许
const stay2 = mergeGroups(ws, { keys: ['A11Y-1052', 'A11Y-1083'], expectedVersions: { 'RCG-A11Y-1048': 3 } })
assert(stay2.group.primaryKey === 'A11Y-1048' && stay2.changed, '从已通过成员发起选择时仍沿用组主问题，不拆散根因组')
ws = stay2.workspace
assert(ws.issues.find(i => i.key === 'A11Y-1052')!.status === '已通过', '该场景下 1052 保持已通过')
// 上面把 1083 也并进来了，后续移出测试改用仍在组里的成员键

// 4. 移出成员 + 版本递增 + 统计重算
console.log('移出与统计:')
resetStatsCache()
const before = getWorkspaceStats(ws)
const totalBefore = before.total
const rm = removeGroupMember(ws, 'RCG-A11Y-1048', 'A11Y-1074', 4)
assert(rm.group!.memberVersion === 5, '移出后成员版本 v4 -> v5')
assert(rm.workspace.issues.find(i => i.key === 'A11Y-1074')!.status === '待复测', '移出恢复降级前状态')
assert(rm.workspace.issues.find(i => i.key === 'A11Y-1074')!.groupId === undefined, '移出后 groupId 清空')
ws = rm.workspace
const after = getWorkspaceStats(ws)
assert(after.memberSignature !== before.memberSignature, '成员变化后成员签名改变（旧统计失效）')
assert(after.total === totalBefore, '问题总数不变，统计按当前成员重算')
// 移出时版本过期 -> 拒绝
let rmConflict: any = null
try { removeGroupMember(ws, 'RCG-A11Y-1048', 'A11Y-1090', 1) } catch (e) { rmConflict = e }
assert(rmConflict?.code === 'version-conflict', '移出也按成员版本核对，过期拒绝')

// 5. 解散：把组移到只剩主问题
console.log('解散:')
let cur = ws
const grp = cur.groups.find(g => g.id === 'RCG-A11Y-1048')!
let v = grp.memberVersion
for (const key of grp.memberKeys.slice(1)) {
  const r = removeGroupMember(cur, 'RCG-A11Y-1048', key, v)
  cur = r.workspace
  v = r.group ? r.group.memberVersion : v + 1
}
assert(!cur.groups.find(g => g.id === 'RCG-A11Y-1048'), '成员不足 2 条时根因组解散')
assert(cur.issues.find(i => i.key === 'A11Y-1048')!.groupId === undefined, '解散后主问题恢复独立')

// 6. 复测队列按当前成员
console.log('复测队列:')
const seeded2 = structuredClone(seedIssues).map(i => i.key === 'A11Y-1048' ? { ...i, status: '待复测' as const } : i)
let ws2 = backfillGroups(seeded2)
resetStatsCache()
const q1 = getWorkspaceStats(ws2).retestQueue.map(i => i.key)
assert(q1.includes('A11Y-1048') && q1.includes('A11Y-1074') && q1.includes('A11Y-1083'), '初始队列：主问题1048 + 独立1074/1083')
const mg = mergeGroups(ws2, { keys: ['A11Y-1048', 'A11Y-1074'], expectedVersions: { 'RCG-A11Y-1048': 1 } })
ws2 = mg.workspace
const q2 = getWorkspaceStats(ws2).retestQueue.map(i => i.key)
assert(q2.includes('A11Y-1048') && !q2.includes('A11Y-1074'), '成员并入后 1074 从独立队列消失，并入主问题条目')
const item = getWorkspaceStats(ws2).retestQueue.find(i => i.key === 'A11Y-1048')!
assert(item.members.some(m => m.key === 'A11Y-1074'), '队列条目带当前成员列表')
// 成员移出后队列条目成员同步变化（旧聚合失效）
const rm2 = removeGroupMember(ws2, 'RCG-A11Y-1048', 'A11Y-1074', 2)
ws2 = rm2.workspace
const item2 = getWorkspaceStats(ws2).retestQueue.find(i => i.key === 'A11Y-1048')!
assert(!item2.members.some(m => m.key === 'A11Y-1074'), '移出后队列按当前成员重算，1074 不再聚合')
assert(getWorkspaceStats(ws2).retestQueue.some(i => i.key === 'A11Y-1074'), '1074 恢复独立后以自身回到复测队列')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
