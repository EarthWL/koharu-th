'use client'

import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, type ProjectInfo } from '@/lib/api'
import { useProjectStore } from '@/lib/stores/projectStore'

export const projectQueryKeys = {
  current: ['project', 'current'] as const,
  series: ['project', 'series-meta'] as const,
  chapters: ['project', 'chapters'] as const,
}

/**
 * Mutations that change project state. All of them refresh the relevant
 * react-query caches and the lightweight project store used by the
 * menu/title bar.
 */
export const useProjectMutations = () => {
  const queryClient = useQueryClient()

  const applyOpenedProject = useCallback(
    (info: ProjectInfo | null) => {
      useProjectStore.getState().setInfo(info)
      queryClient.setQueryData(projectQueryKeys.current, info)
      // Force refetch of series + chapters when the project changes.
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.series })
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.chapters })
    },
    [queryClient],
  )

  const refreshCurrent = useCallback(async () => {
    const info = await api.projectCurrent()
    applyOpenedProject(info)
    return info
  }, [applyOpenedProject])

  const createPicker = useCallback(
    async (name: string) => {
      const info = await api.projectCreatePicker(name)
      if (info) applyOpenedProject(info)
      return info
    },
    [applyOpenedProject],
  )

  const openPicker = useCallback(async () => {
    const info = await api.projectOpenPicker()
    if (info) applyOpenedProject(info)
    return info
  }, [applyOpenedProject])

  const closeProject = useCallback(async () => {
    await api.projectClose()
    applyOpenedProject(null)
  }, [applyOpenedProject])

  return {
    refreshCurrent,
    createPicker,
    openPicker,
    closeProject,
  }
}
