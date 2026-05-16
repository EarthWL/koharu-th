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
   * prompts). User sets this from the Chapters tab.
   */
  activeChapterId: number | null
  setActiveChapterId: (id: number | null) => void
  /**
   * Transient (per-session): true once the user clicks the
   * "Standalone files" escape hatch on the welcome gate so the gate
   * stops blocking them. Reset on project close or app restart.
   */
  standaloneAllowed: boolean
  setStandaloneAllowed: (allowed: boolean) => void
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set) => ({
      info: null,
      setInfo: (info) =>
        set({
          info,
          // Closing a project re-enables the gate so the user has to
          // explicitly choose again.
          ...(info ? {} : { standaloneAllowed: false }),
        }),
      activeChapterId: null,
      setActiveChapterId: (id) => set({ activeChapterId: id }),
      standaloneAllowed: false,
      setStandaloneAllowed: (allowed) => set({ standaloneAllowed: allowed }),
    }),
    {
      name: 'koharu-project-ui',
      // Don't persist `info` or `standaloneAllowed` -- info is
      // re-fetched from backend; standalone is a per-session choice.
      partialize: (state) => ({ activeChapterId: state.activeChapterId }),
    },
  ),
)
