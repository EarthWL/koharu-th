'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ProjectInfo } from '@/lib/api'

export type SidebarTabKey =
  | 'pages'
  | 'chapters'
  | 'project'
  | 'characters'
  | 'glossary'
  | 'prompts'
  | 'profiles'
  | 'chat'

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
  /**
   * Active left-sidebar tab. Hoisted out of SidebarTabs so other panels
   * (e.g. "Open chapter" → switch to Pages) can request a tab switch.
   */
  sidebarTab: SidebarTabKey
  setSidebarTab: (key: SidebarTabKey) => void
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set) => ({
      info: null,
      setInfo: (info) =>
        set((state) => {
          // Reset activeChapterId whenever the project IDENTITY changes
          // (close, open-different, recent-pick), but NOT on a same-
          // project info refresh (e.g. chapter count update). Without
          // this guard the persisted activeChapterId from the previous
          // project leaks into the new one — at best harmless, at worst
          // (matching numeric id) silently anchors rolling-context /
          // chat-history queries to the wrong chapter.
          const switchedProject =
            (state.info?.id ?? null) !== (info?.id ?? null)
          return {
            info,
            ...(switchedProject ? { activeChapterId: null } : {}),
            // Closing a project re-enables the gate so the user has to
            // explicitly choose again.
            ...(info ? {} : { standaloneAllowed: false }),
          }
        }),
      activeChapterId: null,
      setActiveChapterId: (id) => set({ activeChapterId: id }),
      standaloneAllowed: false,
      setStandaloneAllowed: (allowed) => set({ standaloneAllowed: allowed }),
      sidebarTab: 'pages',
      setSidebarTab: (key) => set({ sidebarTab: key }),
    }),
    {
      name: 'koharu-project-ui',
      // Don't persist `info` or `standaloneAllowed` -- info is
      // re-fetched from backend; standalone is a per-session choice.
      partialize: (state) => ({
        activeChapterId: state.activeChapterId,
        sidebarTab: state.sidebarTab,
      }),
    },
  ),
)
