import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Issue, RootCauseGroup, Workspace } from '../api/types'
import { seedIssues } from '../api/seed'
import { backfillGroups } from '../api/groups'

type SavedFilter = { id: string; name: string; query: string; site: string; status: string; priority: string }

const hydratedSeed = backfillGroups(structuredClone(seedIssues))

type WorkspaceState = {
  issues: Issue[]
  groups: RootCauseGroup[]
  selectedKeys: string[]
  savedFilters: SavedFilter[]
  draft: string
  mergeKeys: string[]
  setWorkspace: (workspace: Workspace) => void
  setSelectedKeys: (keys: string[]) => void
  saveFilter: (filter: Omit<SavedFilter, 'id'>) => void
  removeFilter: (id: string) => void
  setDraft: (draft: string) => void
  updateIssue: (issue: Issue) => void
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      issues: hydratedSeed.issues,
      groups: hydratedSeed.groups,
      selectedKeys: [],
      savedFilters: [
        { id: 'f1', name: 'P0/P1 未关闭', query: '', site: '', status: '', priority: 'P0' },
        { id: 'f2', name: '基础组件组待复测', query: '基础组件', site: '', status: '待复测', priority: '' },
      ],
      draft: 'A11Y-1048：需同时验证 Esc 关闭与 Tab/Shift+Tab 环绕顺序，移动端抽屉也需复测。',
      mergeKeys: [],
      // 合并/移出只接收服务端按成员版本核对后的最新工作区，不在本地直接改根因和状态
      setWorkspace: (workspace) => set({ issues: workspace.issues, groups: workspace.groups }),
      setSelectedKeys: (selectedKeys) => set({ selectedKeys }),
      saveFilter: (filter) => set((state) => ({ savedFilters: [...state.savedFilters, { ...filter, id: crypto.randomUUID() }] })),
      removeFilter: (id) => set((state) => ({ savedFilters: state.savedFilters.filter((item) => item.id !== id) })),
      setDraft: (draft) => set({ draft }),
      updateIssue: (updated) => set((state) => ({ issues: state.issues.map((issue) => (issue.key === updated.key ? updated : issue)) })),
    }),
    {
      name: 'accessibility-remediation-v1',
      version: 2,
      // 旧数据（v1，无 groups）按现有合并关系回填根因组与成员版本
      migrate: (persisted) => {
        const state = persisted as Partial<WorkspaceState> | undefined
        if (Array.isArray(state?.groups)) return persisted as WorkspaceState
        const { issues, groups } = backfillGroups((state?.issues ?? structuredClone(seedIssues)) as Issue[])
        return { ...(state as WorkspaceState), issues, groups }
      },
    },
  ),
)
