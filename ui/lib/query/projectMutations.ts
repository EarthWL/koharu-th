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
      const prev = useProjectStore.getState().info
      useProjectStore.getState().setInfo(info)
      queryClient.setQueryData(projectQueryKeys.current, info)
      // When the project IDENTITY actually changes (open, close,
      // recent-pick), every other ['project', ...] query holds data
      // tied to the OLD project — chat history, glossary, characters,
      // profiles, cost dashboard, prompts, etc. Invalidating the whole
      // subtree (predicate match on first key === 'project') drops
      // stale rows on the floor and forces a refetch keyed against
      // the new project. The `current` slot is exempt because we just
      // set it above — invalidating it would race the fresh value.
      // Same project refresh (same id, just stat update) skips the
      // mass invalidation to avoid thrashing every panel.
      const switchedProject = (prev?.id ?? null) !== (info?.id ?? null)
      if (switchedProject) {
        void queryClient.invalidateQueries({
          predicate: (q) =>
            Array.isArray(q.queryKey) &&
            q.queryKey[0] === 'project' &&
            q.queryKey[1] !== 'current',
        })
        // Documents list is keyed under ['documents'], not ['project'],
        // so the predicate above misses it. Drop it explicitly so the
        // Pages tab repopulates against the new project's chapter.
        void queryClient.invalidateQueries({ queryKey: ['documents'] })
      } else {
        // Same-project refresh — only the project-meta caches change.
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.series })
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.chapters })
      }
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
