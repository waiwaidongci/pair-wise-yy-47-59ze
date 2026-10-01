import { useShallow } from 'zustand/react/shallow'
import { useEffect } from 'react'
import axios, { AxiosError } from 'axios'
import { useQuery } from '@tanstack/react-query'
import type {
  Issue,
  MergeRequest,
  MergeResult,
  RemoveMemberResult,
  RootCauseGroup,
  VersionConflict,
  Workspace,
} from './types'
import { getWorkspaceStats, WorkspaceStats } from './stats'
import { useWorkspaceStore } from '../store/useWorkspaceStore'

export type ApiConflictError = {
  message: string
  code: 'version-conflict' | 'passed-protected' | 'not-found' | 'bad-request'
  conflicts: VersionConflict[]
  workspace: Workspace
}

export function isApiConflictError(error: unknown): error is ApiConflictError & { isApiConflict: true } {
  return typeof error === 'object' && error !== null && (error as { isApiConflict?: boolean }).isApiConflict === true
}

const toConflict = (error: AxiosError<ApiConflictError>) => {
  const data = error.response?.data
  if (!data) return error
  return Object.assign(new Error(data.message), { ...data, isApiConflict: true as const })
}

export const fetchWorkspace = async (): Promise<Workspace> => (await axios.get<Workspace>('/api/workspace')).data

export const mergeRootCauseGroup = async (payload: MergeRequest): Promise<MergeResult & { workspace: Workspace }> => {
  try {
    return await axios.post('/api/root-cause-groups/merge', payload).then((res) => res.data)
  } catch (error) {
    throw toConflict(error as AxiosError<ApiConflictError>)
  }
}

export const removeGroupMemberApi = async (
  groupId: string,
  memberKey: string,
  expectedVersion: number,
): Promise<RemoveMemberResult & { workspace: Workspace }> => {
  try {
    return await axios.post(`/api/root-cause-groups/${groupId}/members/${memberKey}/remove`, { expectedVersion }).then((res) => res.data)
  } catch (error) {
    throw toConflict(error as AxiosError<ApiConflictError>)
  }
}

export const rivalMergeDemo = async (standaloneKey: string, targetKey: string) =>
  (await axios.post<{ workspace: Workspace; group: RootCauseGroup }>('/api/demo/rival-merge', { standaloneKey, targetKey })).data

export const submitReview = async (key: string, values: { result: string; note: string; environment: string }) =>
  (await axios.post<{ issue: Issue; workspace: Workspace }>(`/api/issues/${key}/review`, values)).data

export const bulkAssign = async (payload: { keys: string[]; team: string; owner: string; dueDate: string; priority: string }) =>
  (await axios.post<{ updated: number; workspace: Workspace }>('/api/issues/bulk-assign', payload)).data

export function useWorkspace() {
  const setWorkspace = useWorkspaceStore((state) => state.setWorkspace)
  const query = useQuery({
    queryKey: ['workspace'],
    queryFn: fetchWorkspace,
  })

  useEffect(() => {
    if (query.data) setWorkspace(query.data)
  }, [query.data, setWorkspace])

  return query
}

/** 总览 / 复测队列 / 报告统一入口：始终按当前成员版本派生，成员一变旧统计即失效重算 */
export function useWorkspaceStats(): WorkspaceStats {
  const { issues, groups } = useWorkspaceStore(
    useShallow((state) => ({ issues: state.issues, groups: state.groups })),
  )
  return getWorkspaceStats({ issues, groups })
}
