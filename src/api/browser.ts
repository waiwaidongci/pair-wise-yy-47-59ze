import { setupWorker } from 'msw/browser'
import { http, HttpResponse } from 'msw'
import { seedIssues } from './seed'
import type { Issue } from './types'

let issues = structuredClone(seedIssues)

export const worker = setupWorker(
  http.get('/api/issues', ({ request }) => {
    const url = new URL(request.url)
    const query = url.searchParams.get('query')?.toLowerCase() ?? ''
    const status = url.searchParams.get('status') ?? ''
    const site = url.searchParams.get('site') ?? ''
    const filtered = issues.filter((issue) => (!query || `${issue.key}${issue.title}${issue.rootCause}`.toLowerCase().includes(query)) && (!status || issue.status === status) && (!site || issue.site === site))
    return HttpResponse.json(filtered)
  }),
  http.post('/api/issues/:key/review', async ({ params, request }) => {
    const issue = issues.find((item) => item.key === params.key)
    const body = (await request.json()) as { result: string; note: string; environment: string }
    if (!issue) return new HttpResponse(null, { status: 404 })
    issue.status = body.result as Issue['status']
    issue.retestEnv = body.environment
    issue.retestRecords.push({ id: `RT-${Date.now()}`, actor: '当前用户', result: body.result, note: body.note, at: '刚刚' })
    issue.history.push({ at: '刚刚', actor: '当前用户', action: `复测${body.result}`, detail: body.note })
    return HttpResponse.json(issue)
  }),
  http.post('/api/issues/bulk-assign', async ({ request }) => {
    const body = (await request.json()) as { keys: string[]; team: string; owner: string; dueDate: string; priority: string }
    issues = issues.map((issue) =>
      body.keys.includes(issue.key)
        ? { ...issue, team: body.team, owner: body.owner, dueDate: body.dueDate, priority: body.priority as Issue['priority'], status: '修复中', history: [...issue.history, { at: '刚刚', actor: '当前用户', action: '批量分配', detail: `指派至 ${body.team} / ${body.owner}` }] }
        : issue,
    )
    return HttpResponse.json({ updated: body.keys.length })
  }),
  http.post('/api/issues/merge', async ({ request }) => {
    const body = (await request.json()) as { keys: string[]; baseMemberVersion: number }
    const { keys, baseMemberVersion } = body
    if (!Array.isArray(keys) || keys.length < 2) {
      return HttpResponse.json({ error: '至少选择两条问题才能合并' }, { status: 400 })
    }
    const primary = issues.find((item) => item.key === keys[0])
    if (!primary) return HttpResponse.json({ error: '主问题不存在' }, { status: 404 })

    // 乐观锁：晚到的一方按最新成员版本核对，不一致则拒绝并要求重新确认。
    if (primary.memberVersion !== baseMemberVersion) {
      return HttpResponse.json(
        { error: '成员版本已被其他审核员更新，请刷新后按最新成员重新确认合并', currentMemberVersion: primary.memberVersion },
        { status: 409 },
      )
    }

    // 保护已通过问题：不能把已通过的问题吞进别的组。
    const swallowed = keys
      .slice(1)
      .map((key) => issues.find((item) => item.key === key))
      .find((item) => item && item.status === '已通过')
    if (swallowed) {
      return HttpResponse.json(
        { error: `已通过的问题 ${swallowed.key} 不能并入其他组，请先恢复其独立状态` },
        { status: 409 },
      )
    }

    const childKeys = keys.slice(1)
    const now = '刚刚'
    const oldParentKeys = new Set<string>()
    issues.forEach((issue) => {
      if (childKeys.includes(issue.key) && issue.parentKey && issue.parentKey !== primary.key) {
        oldParentKeys.add(issue.parentKey)
      }
    })

    issues = issues.map((issue) => {
      if (issue.key === primary.key) {
        // 合并是追加成员，不隐式移除已有成员。
        const nextMergedKeys = Array.from(new Set([...issue.mergedKeys, ...childKeys]))
        const memberChanged = childKeys.some((key) => !issue.mergedKeys.includes(key))
        return {
          ...issue,
          rootCause: primary.rootCause,
          mergedKeys: nextMergedKeys,
          parentKey: null,
          memberVersion: memberChanged ? issue.memberVersion + 1 : issue.memberVersion,
          history: [...issue.history, { at: now, actor: '当前用户', action: '重复问题合并', detail: `合并 ${childKeys.length} 项至本组（成员版本 v${memberChanged ? issue.memberVersion + 1 : issue.memberVersion}）` }],
        }
      }
      if (childKeys.includes(issue.key)) {
        return {
          ...issue,
          rootCause: primary.rootCause,
          status: '不适用',
          mergedKeys: [],
          parentKey: primary.key,
          history: [...issue.history, { at: now, actor: '当前用户', action: '重复问题合并', detail: `合并至 ${primary.key}` }],
        }
      }
      if (oldParentKeys.has(issue.key)) {
        return {
          ...issue,
          mergedKeys: issue.mergedKeys.filter((key) => !childKeys.includes(key)),
          memberVersion: issue.memberVersion + 1,
          history: [...issue.history, { at: now, actor: '当前用户', action: '成员变更', detail: `子项被并入 ${primary.key}，成员版本 v${issue.memberVersion + 1}` }],
        }
      }
      return issue
    })

    return HttpResponse.json({ issues, primary: issues.find((item) => item.key === primary.key) })
  }),
)

export { issues }
