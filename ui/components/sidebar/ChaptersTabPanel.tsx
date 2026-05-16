'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import {
  CheckIcon,
  FolderPlusIcon,
  ImagePlusIcon,
  Loader2Icon,
  PinIcon,
  PinOffIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
  WandSparklesIcon,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, type ChapterDto, type ChapterStatus } from '@/lib/api'
import { useProjectStore } from '@/lib/stores/projectStore'
import { ExtractEntitiesModal } from '@/components/project/ExtractEntitiesModal'

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
  const nextNumber =
    (chapters.data ?? []).reduce(
      (m, c) => Math.max(m, c.chapterNumber),
      0,
    ) + 1
  /** Set when user clicks the ✨ wand button on a chapter row — opens
   *  the extract modal with the chapter already loaded into the editor. */
  const [extractOpen, setExtractOpen] = useState(false)

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
      </div>
      <div className='border-border border-b p-2'>
        <NewChapterForm
          defaultNumber={nextNumber}
          onCreated={refresh}
        />
      </div>
      <ScrollArea className='flex-1'>
        <div className='space-y-1 p-2'>
          {chapters.isLoading ? (
            <p className='text-muted-foreground p-4 text-center text-xs'>
              Loading…
            </p>
          ) : !chapters.data?.length ? (
            <div className='border-border rounded-md border border-dashed p-4 text-center text-xs'>
              <p className='text-muted-foreground'>
                ยังไม่มีตอน — สร้าง Chapter ด้านบน แล้วค่อยอัปโหลดไฟล์รูปหน้าเข้าไป
              </p>
            </div>
          ) : (
            chapters.data.map((c) => (
              <ChapterRow
                key={c.id}
                chapter={c}
                onChanged={refresh}
                onRequestExtract={() => setExtractOpen(true)}
              />
            ))
          )}
        </div>
      </ScrollArea>
      <ExtractEntitiesModal
        open={extractOpen}
        onClose={() => setExtractOpen(false)}
        onApplied={refresh}
      />
    </div>
  )
}

function NewChapterForm({
  defaultNumber,
  onCreated,
}: {
  defaultNumber: number
  onCreated: () => void
}) {
  const [title, setTitle] = useState('')
  const [chapterNumber, setChapterNumber] = useState<string>(
    String(defaultNumber),
  )
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const num = Number(chapterNumber)
    if (!Number.isFinite(num)) return
    setBusy(true)
    try {
      await api.chapterCreate({
        chapterNumber: num,
        title: title.trim() || null,
      })
      setTitle('')
      setChapterNumber(String(num + 1))
      onCreated()
    } catch (err: any) {
      alert(err?.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='flex flex-col gap-1.5'>
      <div className='flex items-center gap-1'>
        <Input
          inputMode='decimal'
          value={chapterNumber}
          onChange={(e) => setChapterNumber(e.target.value)}
          placeholder='No.'
          className='h-7 w-16 text-xs'
          title='Chapter number (decimals OK for omake)'
        />
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder='Chapter title (optional)'
          className='h-7 flex-1 text-xs'
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
        />
        <Button
          size='sm'
          className='h-7 px-2 text-[10px]'
          disabled={busy}
          onClick={() => void submit()}
          title='Create chapter folder (source/ + render/)'
        >
          {busy ? (
            <Loader2Icon className='size-3 animate-spin' />
          ) : (
            <FolderPlusIcon className='size-3' />
          )}
          New
        </Button>
      </div>
      <p className='text-muted-foreground/70 text-[10px] leading-tight'>
        สร้าง Chapter จะมีโฟลเดอร์ source/ และ render/ ให้ — แล้วค่อยกด “+
        Pages” อัปโหลดรูปหน้าเข้าไป
      </p>
    </div>
  )
}

function ChapterRow({
  chapter,
  onChanged,
  onRequestExtract,
}: {
  chapter: ChapterDto
  onChanged: () => void
  /** Open the panel-level Extract Entities modal after this chapter
   *  is loaded into the editor. */
  onRequestExtract: () => void
}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const activeChapterId = useProjectStore((s) => s.activeChapterId)
  const setActiveChapterId = useProjectStore((s) => s.setActiveChapterId)
  const isActive = activeChapterId === chapter.id
  const [opening, setOpening] = useState(false)
  const [openingForExtract, setOpeningForExtract] = useState(false)
  const [addingPages, setAddingPages] = useState(false)
  const [justAdded, setJustAdded] = useState<number | null>(null)

  const openAndExtract = async () => {
    setOpeningForExtract(true)
    try {
      await api.chapterOpen(chapter.id)
      setActiveChapterId(chapter.id)
      await queryClient.invalidateQueries({ queryKey: ['documents'] })
      onRequestExtract()
    } catch (err: any) {
      alert(err?.message ?? String(err))
    } finally {
      setOpeningForExtract(false)
    }
  }

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

  const addPages = async () => {
    setAddingPages(true)
    try {
      const r = await api.chapterAddPages(chapter.id)
      if (r.added > 0) {
        setJustAdded(r.added)
        onChanged()
        window.setTimeout(() => setJustAdded(null), 2500)
      } else if (r.skipped > 0) {
        alert(`Skipped ${r.skipped} files (unsupported / copy failed)`)
      }
    } catch (err: any) {
      alert(err?.message ?? String(err))
    } finally {
      setAddingPages(false)
    }
  }

  const changeStatus = async (status: ChapterStatus) => {
    await api.chapterUpdate({ id: chapter.id, status })
    onChanged()
  }

  const remove = async () => {
    if (
      !confirm(
        `ลบ "${chapter.title ?? chapter.folderPath}" ออกจาก index? (ไฟล์ในโฟลเดอร์ไม่ถูกลบ)`,
      )
    )
      return
    await api.chapterRemove(chapter.id)
    onChanged()
  }

  const folderName = chapter.folderPath.split(/[\\/]/).pop() ?? ''

  return (
    <div
      className={
        'border-border bg-card hover:bg-accent/40 group rounded-md border p-2 transition ' +
        (isActive ? 'ring-primary/40 ring-1 ' : '') +
        (justAdded !== null
          ? 'ring-2 ring-emerald-500/60 bg-emerald-500/5'
          : '')
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
          {chapter.title ?? folderName}
        </span>
        <span
          className={`size-2 shrink-0 rounded-full ${STATUS_DOT[chapter.status]}`}
          title={chapter.status}
        />
      </div>
      <div className='mt-1 flex items-center gap-1.5 text-[10px]'>
        <span className='text-muted-foreground/70 min-w-0 truncate font-mono'>
          {chapter.folderPath}
        </span>
        <span className='text-muted-foreground/70 shrink-0'>·</span>
        <span
          className={
            'shrink-0 font-medium ' +
            (chapter.pageCount === 0
              ? 'text-muted-foreground/60'
              : 'text-emerald-600 dark:text-emerald-400')
          }
        >
          {chapter.pageCount} {chapter.pageCount === 1 ? 'page' : 'pages'}
        </span>
        {justAdded !== null && (
          <span className='ml-auto flex shrink-0 items-center gap-0.5 rounded bg-emerald-500/15 px-1.5 py-0.5 font-semibold text-emerald-600 dark:text-emerald-400'>
            <CheckIcon className='size-2.5' />+{justAdded}
          </span>
        )}
      </div>
      <div className='mt-1.5 flex items-center gap-1'>
        <Button
          variant='default'
          size='sm'
          className='h-6 flex-1 text-[10px]'
          disabled={opening || chapter.pageCount === 0}
          onClick={() => void open()}
          title={
            chapter.pageCount === 0
              ? 'ยังไม่มีรูปหน้า — กด “+ Pages” อัปโหลดก่อน'
              : 'Open chapter in editor'
          }
        >
          {opening ? (
            <Loader2Icon className='size-3 animate-spin' />
          ) : (
            <PlayIcon className='size-3' />
          )}
          Open
        </Button>
        <Button
          variant='outline'
          size='sm'
          className='h-6 px-2 text-[10px]'
          disabled={addingPages}
          onClick={() => void addPages()}
          title='เพิ่มรูปหน้าจากเครื่องเข้าโฟลเดอร์ source/ ของตอนนี้'
        >
          {addingPages ? (
            <Loader2Icon className='size-3 animate-spin' />
          ) : (
            <ImagePlusIcon className='size-3' />
          )}
          Pages
        </Button>
        <Button
          variant='outline'
          size='sm'
          className='h-6 px-1.5 text-[10px]'
          disabled={openingForExtract || chapter.pageCount === 0}
          onClick={() => void openAndExtract()}
          title='Auto-setup: open chapter → OCR all pages → extract characters & glossary'
        >
          {openingForExtract ? (
            <Loader2Icon className='size-3 animate-spin' />
          ) : (
            <WandSparklesIcon className='size-3' />
          )}
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
