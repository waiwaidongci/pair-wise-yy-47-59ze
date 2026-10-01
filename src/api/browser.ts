import { setupWorker } from 'msw/browser'
import { http, HttpResponse } from 'msw'
import { seedIssues } from './seed'
import type { Issue, MergeRequest, Workspace } from './types'
import { backfillGroups, mergeGroups, MergeConflictError, nowLabel, removeGroupMember } from './groups'

/** 旧数据按现有合并关系回填根因组与成员版本 */
let workspace: Workspace = backfillGroups(structuredClone(seedIssues))

const findIssue = (key: string) => workspace.issues.find((item) => item.key === key)

const conflictResponse = (error: MergeConflictError) =>
  HttpResponse.json(
    {
      message: error.message,
      code: error.code,
      conflicts: error.conflicts,
      workspace: error.workspace ?? workspace,
    },
    { status: error.code === 'version-conflict' ? 409 : error.code === 'passed-protected' ? 422 : 400 },
  )

export const worker = setupWorker(
  http.get('/api/workspace', () => HttpResponse.json(workspace)),

  http.get('/api/issues', ({ request }) => {
    const url = new URL(request.url)
    const query = url.searchParams.get('query')?.toLowerCase() ?? ''
    const status = url.searchParams.get('status') ?? ''
    const site = url.searchParams.get('site') ?? ''
    const filtered = workspace.issues.filter(
      (issue) =>
        (!query || `${issue.key}${issue.title}${issue.rootCause}`.toLowerCase().includes(query)) &&
        (!status || issue.status === status) &&
        (!site || issue.site === site),
    )
    return HttpResponse.json(filtered)
  }),

  http.post('/api/issues/:key/review', async ({ params, request }) => {
    const issue = findIssue(params.key as string)
    const body = (await request.json()) as { result: string; note: string; environment: string }
    if (!issue) return new HttpResponse(null, { status: 404 })
    const at = nowLabel()
    const updated: Issue = {
      ...issue,
      status: body.result as Issue['status'],
      retestEnv: body.environment,
      retestRecords: [...issue.retestRecords, { id: `RT-${Date.now()}`, actor: '当前用户', result: body.result, note: body.note, at }],
      history: [...issue.history, { at, actor: '当前用户', action: `复测${body.result}`, detail: body.note }],
    }
    workspace = { ...workspace, issues: workspace.issues.map((item) => (item.key === updated.key ? updated : item)) }
    return HttpResponse.json({ issue: updated, workspace })
  }),

  http.post('/api/issues/bulk-assign', async ({ request }) => {
    const body = (await request.json()) as { keys: string[]; team: string; owner: string; dueDate: string; priority: string }
    const at = nowLabel()
    workspace = {
      ...workspace,
      issues: workspace.issues.map((issue) =>
        body.keys.includes(issue.key)
          ? {
              ...issue,
              team: body.team,
              owner: body.owner,
              dueDate: body.dueDate,
              priority: body.priority as Issue['priority'],
              status: '修复中',
              history: [...issue.history, { at, actor: '当前用户', action: '批量分配', detail: `指派至 ${body.team} / ${body.owner}` }],
            }
          : issue,
      ),
    }
    return HttpResponse.json({ updated: body.keys.length, workspace })
  }),

  // 合并根因组：携带期望成员版本，晚到方按最新版本核对，冲突即拒绝
  http.post('/api/root-cause-groups/merge', async ({ request }) => {
    const body = (await request.json()) as MergeRequest
    try {
      const result = mergeGroups(workspace, body)
      if (result.changed) workspace = result.workspace
      return HttpResponse.json({ ...result, workspace })
    } catch (error) {
      if (error instanceof MergeConflictError) return conflictResponse(error)
      throw error
    }
  }),

  http.post('/api/root-cause-groups/:groupId/members/:memberKey/remove', async ({ params, request }) => {
    const body = (await request.json()) as { expectedVersion: number }
    try {
      const result = removeGroupMember(workspace, params.groupId as string, params.memberKey as string, Number(body.expectedVersion))
      workspace = result.workspace
      return HttpResponse.json({ ...result, workspace })
    } catch (error) {
      if (error instanceof MergeConflictError) return conflictResponse(error)
      throw error
    }
  }),

  // 演示并发：另一名审核员抢先把独立问题并入同一根因组，使后提交者的成员版本过期
  http.post('/api/demo/rival-merge', async ({ request }) => {
    const body = (await request.json()) as { standaloneKey: string; targetKey: string }
    try {
      const result = mergeGroups(
        workspace,
        {
          keys: [body.targetKey, body.standaloneKey],
          expectedVersions: Object.fromEntries(
            workspace.groups
              .filter((group) => group.memberKeys.includes(body.targetKey))
              .map((group) => [group.id, group.memberVersion]),
          ),
          actor: '另一位审核员',
        },
        nowLabel(),
      )
      workspace = result.workspace
      return HttpResponse.json({ workspace, group: result.group })
    } catch (error) {
      if (error instanceof MergeConflictError) return conflictResponse(error)
      throw error
    }
  }),
)

export { workspace }
