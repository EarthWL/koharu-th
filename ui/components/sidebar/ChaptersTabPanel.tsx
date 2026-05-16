'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import {
  FolderOpenIcon,
  Loader2Icon,
  PinIcon,
  PinOffIcon,
  PlayIcon,
  Trash2Icon,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, type ChapterDto, type ChapterStatus } from '@/lib/api'
import { useProjectStore } from '@/lib/stores/projectStore'

const STATUS_OPTIONS: { value: ChapterStatus; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'translated', label: 'Translated' },
  { value: 'reviewed', label: 'Reviewed' },
  { value: 'done', label: 'Done' },
]

const STATUS_DOT: Record<ChapterStatus, string> = {
  pending: 'bg-muted-foreground/40',
  in_progress: 'bg-amber-500',
  translated: 'bg-sky-500',
  reviewed: 'bg-violet-500',
  done: 'bg-emerald-500',
}

export function ChaptersTabPanel() {
  const chapters = useQuery({
    queryKey: ['project', 'chapters'],
    queryFn: () => api.chaptersList(),
    staleTime: 30_000,
  })
  const refresh = () => void chapters.refetch()

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <div className='border-border flex items-center justify-between border-b px-2 py-1.5'>
        <span className='text-muted-foreground text-[10px] font-bold tracking-wide uppercase'>
          Chapters{' '}
          {chapters.data && (
            <span className='text-muted-foreground/60'>
              ({chapters.data.length})
            </span>
          )}
        </span>
        <ImportButton onImported={refresh} />
      </div>
      <ScrollArea className='flex-1'>
        <div className='space-y-1 p-2'>
          {chapters.isLoading ? (
            <p className='text-muted-foreground p-4 text-center text-xs'>
              Loading…
            </p>
          ) : !chapters.data?.length ? (
            <div className='border-border rounded-md border border-dashed p-4 text-center text-xs'>
              <p className='text-muted-foreground mb-2'>No chapters yet.</p>
              <ImportButton onImported={refresh} />
              <p className='text-muted-foreground/70 mt-2 text-[10px]'>
                Pick .khr or image files — they're copied into the project's
                chapters/ folder.
              </p>
            </div>
          ) : (
            chapters.data.map((c) => (
              <ChapterRow key={c.id} chapter={c} onChanged={refresh} />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

function ChapterRow({
  chapter,
  onChanged,
}: {
  chapter: ChapterDto
  onChanged: () => void
}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const activeChapterId = useProjectStore((s) => s.activeChapterId)
  const setActiveChapterId = useProjectStore((s) => s.setActiveChapterId)
  const isActive = activeChapterId === chapter.id
  const [opening, setOpening] = useState(false)

  const open = async () => {
    setOpening(true)
    try {
      await api.chapterOpen(chapter.id)
      setActiveChapterId(chapter.id)
      await queryClient.invalidateQueries({ queryKey: ['documents'] })
      router.push('/')
    } catch (err: any) {
      alert(err?.message ?? String(err))
    } finally {
      setOpening(false)
    }
  }

  const changeStatus = async (status: ChapterStatus) => {
    await api.chapterUpdate({ id: chapter.id, status })
    onChanged()
  }

  const remove = async () => {
    if (!confirm(`Remove "${chapter.title ?? chapter.filePath}" from index?`))
      return
    await api.chapterRemove(chapter.id)
    onChanged()
  }

  return (
    <div
      className={
        'border-border bg-card hover:bg-accent/40 group rounded-md border p-2 transition ' +
        (isActive ? 'ring-primary/40 ring-1' : '')
      }
    >
      <div className='flex items-center gap-1.5'>
        <button
          onClick={() => setActiveChapterId(isActive ? null : chapter.id)}
          title={
            isActive
              ? 'Unpin — translations stop pulling rolling context anchored here'
              : 'Pin as active chapter — rolling context anchors here'
          }
          className='shrink-0'
        >
          {isActive ? (
            <PinIcon className='text-primary size-3.5' />
          ) : (
            <PinOffIcon className='text-muted-foreground/60 hover:text-foreground size-3.5' />
          )}
        </button>
        <span className='bg-muted text-muted-foreground rounded px-1 py-0.5 font-mono text-[10px]'>
          #{chapter.chapterNumber}
        </span>
        <span className='min-w-0 flex-1 truncate text-xs font-medium'>
          {chapter.title ?? chapter.filePath.split(/[\\/]/).pop()}
        </span>
        <span
          className={`size-2 shrink-0 rounded-full ${STATUS_DOT[chapter.status]}`}
          title={chapter.status}
        />
      </div>
      <div className='mt-1.5 flex items-center gap-1'>
        <Button
          variant='default'
          size='sm'
          className='h-6 flex-1 text-[10px]'
          disabled={opening}
          onClick={() => void open()}
        >
          {opening ? (
            <Loader2Icon className='size-3 animate-spin' />
          ) : (
            <PlayIcon className='size-3' />
          )}
          Open
        </Button>
        <Select
          value={chapter.status}
          onValueChange={(v) => void changeStatus(v as ChapterStatus)}
        >
          <SelectTrigger className='h-6 w-20 text-[10px]'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value} className='text-xs'>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant='ghost'
          size='icon-xs'
          className='size-6'
          title='Remove from index (file stays on disk)'
          onClick={() => void remove()}
        >
          <Trash2Icon className='size-3' />
        </Button>
      </div>
    </div>
  )
}

function ImportButton({ onImported }: { onImported: () => void }) {
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      const r = await api.chapterAddFromPicker()
      if (r.added > 0) onImported()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button
      variant='outline'
      size='sm'
      className='h-6 px-2 text-[10px]'
      disabled={busy}
      onClick={() => void run()}
      title='Pick .khr / image files — they will be copied into the project'
    >
      {busy ? (
        <Loader2Icon className='size-3 animate-spin' />
      ) : (
        <FolderOpenIcon className='size-3' />
      )}
      Import
    </Button>
  )
}
