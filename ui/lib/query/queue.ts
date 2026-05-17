'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type QueueEntryDto } from '@/lib/api'
import { useProjectStore } from '@/lib/stores/projectStore'

const QUEUE_KEY = ['project', 'translation-queue'] as const

/** Poll the queue. Fast (1.5s) while any entry is running so the
 *  progress bar updates smoothly; idle (10s) otherwise so we don't
 *  hammer SQLite when nothing's happening. */
export function useQueueList() {
  const projectInfo = useProjectStore((s) => s.info)
  return useQuery({
    queryKey: QUEUE_KEY,
    queryFn: () => api.queueList(),
    enabled: !!projectInfo,
    refetchInterval: (q) => {
      const data = q.state.data as QueueEntryDto[] | undefined
      const hasActive = data?.some(
        (e) => e.status === 'running' || e.status === 'pending',
      )
      return hasActive ? 1500 : 10_000
    },
    staleTime: 0,
  })
}

export function useEnqueueChapter() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (chapterId: number) => api.queueEnqueue(chapterId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUEUE_KEY })
    },
  })
}

export function useCancelQueueEntry() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.queueCancel(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUEUE_KEY })
    },
  })
}

export function useClearFinishedQueue() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.queueClearFinished(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUEUE_KEY })
    },
  })
}
