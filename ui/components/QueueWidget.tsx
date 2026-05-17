'use client'

import { useMemo, useState } from 'react'
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  Loader2Icon,
  PlayCircleIcon,
  Trash2Icon,
  XCircleIcon,
  XIcon,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { api, type QueueEntryDto, type QueueStatus } from '@/lib/api'
import {
  useCancelQueueEntry,
  useClearFinishedQueue,
  useQueueList,
} from '@/lib/query/queue'
import { useProjectStore } from '@/lib/stores/projectStore'

/**
 * Bottom-right floating widget for the translation queue. Hidden when
 * the queue is empty. Collapsed shows the current chapter + global
 * progress; expanded lists every entry with per-row cancel.
 */
export function QueueWidget() {
  const projectInfo = useProjectStore((s) => s.info)
  const queue = useQueueList()
  const [expanded, setExpanded] = useState(false)
  const cancel = useCancelQueueEntry()
  const clear = useClearFinishedQueue()

  // Hydrate chapter titles (cheap — re-uses the existing chapters query
  // if it's already cached).
  const chapters = useQuery({
    queryKey: ['project', 'chapters'],
    queryFn: () => api.chaptersList(),
    enabled: !!projectInfo && (queue.data?.length ?? 0) > 0,
    staleTime: 30_000,
  })

  const titleOf = useMemo(() => {
    const map = new Map<number, string>()
    for (const c of chapters.data ?? []) {
      map.set(c.id, c.title ?? `#${c.chapterNumber}`)
    }
    return (id: number) => map.get(id) ?? `chapter #${id}`
  }, [chapters.data])

  const entries = queue.data ?? []
  if (!projectInfo || entries.length === 0) return null

  const running = entries.find((e) => e.status === 'running')
  const pendingCount = entries.filter((e) => e.status === 'pending').length
  const finishedCount = entries.filter(
    (e) => e.status === 'completed' || e.status === 'failed' || e.status === 'cancelled',
  ).length

  return (
    <div className='fixed right-4 bottom-4 z-40 w-80 max-w-[calc(100vw-2rem)]'>
      <div className='border-border bg-card/95 overflow-hidden rounded-2xl border shadow-[0_15px_60px_rgba(0,0,0,0.18)] backdrop-blur'>
        {/* Header / summary */}
        <button
          type='button'
          onClick={() => setExpanded((v) => !v)}
          className='hover:bg-accent/30 flex w-full items-center gap-2 px-3 py-2 text-left transition'
        >
          {running ? (
            <Loader2Icon className='text-primary size-4 shrink-0 animate-spin' />
          ) : pendingCount > 0 ? (
            <PlayCircleIcon className='text-muted-foreground size-4 shrink-0' />
          ) : (
            <CheckIcon className='size-4 shrink-0 text-emerald-500' />
          )}
          <div className='min-w-0 flex-1'>
            <div className='truncate text-xs font-semibold'>
              {running
                ? `Translating ${titleOf(running.chapterId)}`
                : pendingCount > 0
                  ? `${pendingCount} chapter${pendingCount === 1 ? '' : 's'} waiting`
                  : 'Queue idle'}
            </div>
            <div className='text-muted-foreground truncate text-[10px]'>
              {entries.length} entr{entries.length === 1 ? 'y' : 'ies'} ·
              {finishedCount > 0 ? ` ${finishedCount} done` : ' all live'}
            </div>
          </div>
          {expanded ? (
            <ChevronDownIcon className='text-muted-foreground size-3.5 shrink-0' />
          ) : (
            <ChevronUpIcon className='text-muted-foreground size-3.5 shrink-0' />
          )}
        </button>

        {/* Active progress bar (always visible) */}
        {running && (
          <div className='px-3 pb-2'>
            <Progress entry={running} />
          </div>
        )}

        {expanded && (
          <div className='border-border max-h-72 overflow-y-auto border-t'>
            {entries.map((e) => (
              <Row
                key={e.id}
                entry={e}
                title={titleOf(e.chapterId)}
                onCancel={() => cancel.mutate(e.id)}
              />
            ))}
            {finishedCount > 0 && (
              <div className='border-border border-t p-2'>
                <Button
                  variant='ghost'
                  size='sm'
                  className='h-7 w-full text-[10px]'
                  disabled={clear.isPending}
                  onClick={() => clear.mutate()}
                >
                  <Trash2Icon className='size-3' />
                  Clear {finishedCount} finished
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const STATUS_LABEL: Record<QueueStatus, string> = {
  pending: 'Waiting',
  running: 'Running',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

const STATUS_COLOR: Record<QueueStatus, string> = {
  pending: 'text-muted-foreground',
  running: 'text-primary',
  completed: 'text-emerald-500',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground/60',
}

function Row({
  entry: e,
  title,
  onCancel,
}: {
  entry: QueueEntryDto
  title: string
  onCancel: () => void
}) {
  const isActive = e.status === 'pending' || e.status === 'running'
  return (
    <div className='border-border/40 flex items-start gap-2 border-b px-3 py-2 last:border-b-0'>
      <div className='mt-0.5 shrink-0'>
        {e.status === 'running' && (
          <Loader2Icon className='text-primary size-3.5 animate-spin' />
        )}
        {e.status === 'pending' && (
          <PlayCircleIcon className='text-muted-foreground/60 size-3.5' />
        )}
        {e.status === 'completed' && (
          <CheckIcon className='size-3.5 text-emerald-500' />
        )}
        {e.status === 'failed' && (
          <XCircleIcon className='text-destructive size-3.5' />
        )}
        {e.status === 'cancelled' && (
          <XCircleIcon className='text-muted-foreground/60 size-3.5' />
        )}
      </div>
      <div className='min-w-0 flex-1'>
        <div className='truncate text-xs font-medium'>{title}</div>
        <div className='text-muted-foreground flex items-center gap-1.5 text-[10px]'>
          <span className={STATUS_COLOR[e.status]}>{STATUS_LABEL[e.status]}</span>
          {e.totalPages > 0 && (
            <>
              <span>·</span>
              <span className='font-mono'>
                {e.donePages}/{e.totalPages} pages
              </span>
            </>
          )}
        </div>
        {e.errorMessage && (
          <div className='text-destructive mt-0.5 truncate text-[10px]' title={e.errorMessage}>
            {e.errorMessage}
          </div>
        )}
        {e.status === 'running' && <Progress entry={e} />}
      </div>
      {isActive && (
        <Button
          variant='ghost'
          size='icon-xs'
          className='size-6 shrink-0'
          title='Cancel'
          onClick={onCancel}
        >
          <XIcon className='size-3' />
        </Button>
      )}
    </div>
  )
}

function Progress({ entry: e }: { entry: QueueEntryDto }) {
  const pct =
    e.totalPages > 0
      ? Math.max(0, Math.min(100, Math.round((e.donePages / e.totalPages) * 100)))
      : undefined
  return (
    <div className='mt-1.5 flex items-center gap-2'>
      <div className='bg-muted relative h-1 flex-1 overflow-hidden rounded-full'>
        {typeof pct === 'number' ? (
          <div
            className='bg-primary h-full rounded-full transition-[width] duration-700 ease-out'
            style={{ width: `${pct}%` }}
          />
        ) : (
          <div className='from-primary/40 via-primary to-primary/40 absolute inset-0 w-1/2 animate-pulse rounded-full bg-linear-to-r' />
        )}
      </div>
      <span className='text-muted-foreground w-9 text-right font-mono text-[10px]'>
        {typeof pct === 'number' ? `${pct}%` : '—'}
      </span>
    </div>
  )
}
