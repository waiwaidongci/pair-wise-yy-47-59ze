import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import axios from 'axios'
import type { Issue } from '../api/types'
import { seedIssues } from '../api/seed'

type SavedFilter = { id: string; name: string; query: string; site: string; status: string; priority: string }

type WorkspaceState = {
  issues: Issue[]
  selectedKeys: string[]
  savedFilters: SavedFilter[]
  draft: string
  mergeKeys: string[]
  /**
   * 统计版本：成员变化时自增，使旧统计失效并按当前成员重算总览、复测队列与报告。
   */
  statsVersion: number
  setIssues: (issues: Issue[]) => void
  setSelectedKeys: (keys: string[]) => void
  saveFilter: (filter: Omit<SavedFilter, 'id'>) => void
  removeFilter: (id: string) => void
  setDraft: (draft: string) => void
  mergeIssues: (keys: string[]) => Promise<void>
  updateIssue: (issue: Issue) => void
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      issues: structuredClone(seedIssues),
      selectedKeys: [],
      savedFilters: [
        { id: 'f1', name: 'P0/P1 未关闭', query: '', site: '', status: '', priority: 'P0' },
        { id: 'f2', name: '基础组件组待复测', query: '基础组件', site: '', status: '待复测', priority: '' },
      ],
      draft: 'A11Y-1048：需同时验证 Esc 关闭与 Tab/Shift+Tab 环绕顺序，移动端抽屉也需复测。',
      mergeKeys: [],
      statsVersion: 0,
      setIssues: (issues) => set({ issues }),
      setSelectedKeys: (selectedKeys) => set({ selectedKeys }),
      saveFilter: (filter) => set((state) => ({ savedFilters: [...state.savedFilters, { ...filter, id: crypto.randomUUID() }] })),
      removeFilter: (id) => set((state) => ({ savedFilters: state.savedFilters.filter((item) => item.id !== id) })),
      setDraft: (draft) => set({ draft }),
      mergeIssues: async (keys) => {
        const state = get()
        const primary = state.issues.find((issue) => issue.key === keys[0])
        if (!primary) return
        // 提交时携带主问题当前成员版本，服务端按最新成员版本核对。
        const { data } = await axios.post<{ issues: Issue[] }>('/api/issues/merge', {
          keys,
          baseMemberVersion: primary.memberVersion,
        })
        set({ issues: data.issues, statsVersion: state.statsVersion + 1, selectedKeys: [] })
      },
      updateIssue: (updated) => set((state) => ({ issues: state.issues.map((issue) => (issue.key === updated.key ? updated : issue)) })),
    }),
    {
      name: 'accessibility-remediation-v1',
      version: 2,
      migrate: (persistedState) => {
        const state = persistedState as Partial<WorkspaceState> | null
        if (!state || !Array.isArray(state.issues)) return state as WorkspaceState
        const issues = state.issues
        // 旧数据 mergedKeys 双向引用，需区分主从：子项指向主问题，主问题列出子项。
        const isChild = (issue: Issue): boolean => {
          if (issue.mergedKeys.length !== 1) return false
          const parent = issues.find((item) => item.key === issue.mergedKeys[0])
          if (!parent || parent.key === issue.key) return false
          if (!parent.mergedKeys.includes(issue.key)) return false
          // 单子项组的平局判断：key 较小的为主问题。
          return parent.mergedKeys.length > 1 || parent.key < issue.key
        }
        state.issues = issues.map((issue) => {
          const child = isChild(issue)
          const parent = !child && issue.mergedKeys.length > 0
          return {
            ...issue,
            parentKey: child ? issue.mergedKeys[0] : null,
            mergedKeys: child ? [] : issue.mergedKeys,
            memberVersion: issue.memberVersion ?? (parent ? 1 : 0),
          }
        })
        return state as WorkspaceState
      },
    },
  ),
)
