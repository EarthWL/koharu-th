'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ProjectInfo } from '@/lib/api'

type ProjectState = {
  /** Last-known summary of the open project. `null` = no project open. */
  info: ProjectInfo | null
  setInfo: (info: ProjectInfo | null) => void
  /**
   * Which chapter row is "active" — used as the anchor for rolling
   * context (summaries of prior chapters are injected into translation
   * prompts). User sets this from /project chapters table.
   */
  activeChapterId: number | null
  setActiveChapterId: (id: number | null) => void
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set) => ({
      info: null,
      setInfo: (info) => set({ info }),
      activeChapterId: null,
      setActiveChapterId: (id) => set({ activeChapterId: id }),
    }),
    {
      name: 'koharu-project-ui',
      // Don't persist `info` -- it gets rehydrated from backend on mount.
      partialize: (state) => ({ activeChapterId: state.activeChapterId }),
    },
  ),
)
