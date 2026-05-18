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
      // profiles, cost dashboard, prompts, etc.
      //
      // We use removeQueries here, NOT invalidateQueries — the latter
      // only marks data stale, so consumers (useQuery) keep reading
      // the OLD project's cached rows for the 200–1000 ms it takes
      // refetch to resolve. During that window a fast click in the
      // chat / glossary / characters panel can fire a mutation
      // targeting the outgoing project even though the store + UI
      // chrome already say "project B".
      //
      // removeQueries drops the rows on the floor, so consumers see
      // `isLoading: true` until the new project's fetch returns —
      // mildly uglier than a brief stale flash, but the only safe
      // option when each row is project-scoped.
      //
      // The `current` slot is exempt because we just setQueryData'd
      // it above with the fresh ProjectInfo — removing it would race
      // that write and flicker the menu/title bar.
      //
      // Same-project refresh (same id, just stat update) keeps the
      // mild invalidate-then-refetch path so panels don't thrash.
      const switchedProject = (prev?.id ?? null) !== (info?.id ?? null)
      if (switchedProject) {
        queryClient.removeQueries({
          predicate: (q) =>
            Array.isArray(q.queryKey) &&
            q.queryKey[0] === 'project' &&
            q.queryKey[1] !== 'current',
        })
        // Documents list is keyed under ['documents'], not ['project'],
        // so the predicate above misses it. Drop it explicitly so the
        // Pages tab repopulates against the new project's chapter.
        queryClient.removeQueries({ queryKey: ['documents'] })
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
