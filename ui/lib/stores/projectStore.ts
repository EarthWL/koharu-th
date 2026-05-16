'use client'

import { create } from 'zustand'
import type { ProjectInfo } from '@/lib/api'

type ProjectState = {
  /** Last-known summary of the open project. `null` = no project open. */
  info: ProjectInfo | null
  setInfo: (info: ProjectInfo | null) => void
}

export const useProjectStore = create<ProjectState>((set) => ({
  info: null,
  setInfo: (info) => set({ info }),
}))
