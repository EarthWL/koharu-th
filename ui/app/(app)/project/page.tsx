'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronLeftIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  Loader2Icon,
  LogOutIcon,
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
} from 'lucide-react'
import { summarizeChapter } from '@/lib/services/summarizeChapter'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { api, type ChapterDto, type ChapterStatus, type SeriesMetaDto } from '@/lib/api'
import {
  projectQueryKeys,
  useProjectMutations,
} from '@/lib/query/projectMutations'
import { useProjectStore } from '@/lib/stores/projectStore'

const STATUS_OPTIONS: { value: ChapterStatus; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'translated', label: 'Translated' },
  { value: 'reviewed', label: 'Reviewed' },
  { value: 'done', label: 'Done' },
]

const STATUS_BADGE: Record<ChapterStatus, string> = {
  pending: 'bg-muted text-muted-foreground',
  in_progress: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  translated: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  reviewed: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  done: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
}

export default function ProjectPage() {
  const info = useProjectStore((s) => s.info)
  const { refreshCurrent, createPicker, openPicker, closeProject } =
    useProjectMutations()

  // Make sure the store reflects the actual backend state on mount.
  useEffect(() => {
    void refreshCurrent()
  }, [refreshCurrent])

  return (
    <ScrollArea className='flex-1'>
      <div className='px-4 py-6'>
        <div className='relative mx-auto max-w-3xl'>
          <div className='mb-8 flex items-center'>
            <Link
              href='/'
              prefetch={false}
              className='text-muted-foreground hover:bg-accent hover:text-foreground absolute -left-14 flex size-10 items-center justify-center rounded-full transition'
            >
              <ChevronLeftIcon className='size-6' />
            </Link>
            <h1 className='text-foreground text-2xl font-bold'>Project</h1>
          </div>

            <section className='mb-8'>
              <h2 className='text-foreground mb-1 text-sm font-bold'>
                Current project
              </h2>
              <p className='text-muted-foreground mb-4 text-sm'>
                A project bundles related chapters with shared characters,
                glossary, and prompt settings.
              </p>

              <div className='bg-card border-border rounded-lg border p-4'>
                {info ? (
                  <div className='space-y-3'>
                    <div className='flex items-start justify-between gap-3'>
                      <div className='min-w-0'>
                        <div className='text-foreground truncate text-base font-semibold'>
                          {info.name}
                          {info.nameOriginal && (
                            <span className='text-muted-foreground ml-2 text-xs font-normal'>
                              {info.nameOriginal}
                            </span>
                          )}
                        </div>
                        <div className='text-muted-foreground truncate text-xs'>
                          {info.root}
                        </div>
                      </div>
                      <Button
                        variant='ghost'
                        size='sm'
                        onClick={() => void closeProject()}
                        title='Close project'
                      >
                        <LogOutIcon className='size-3.5' />
                        Close
                      </Button>
                    </div>
                    <div className='text-muted-foreground flex gap-4 text-xs'>
                      <span>📚 {info.chapterCount} chapters</span>
                      <span>👤 {info.characterCount} characters</span>
                      <span>📖 {info.glossaryCount} glossary entries</span>
                    </div>
                  </div>
                ) : (
                  <div className='flex flex-col items-start gap-3'>
                    <p className='text-muted-foreground text-sm'>
                      No project is open. Create a new one or open an existing
                      project folder.
                    </p>
                    <div className='flex gap-2'>
                      <CreateProjectButton onCreate={createPicker} />
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={() => void openPicker()}
                      >
                        <FolderOpenIcon className='size-3.5' />
                        Open project…
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </section>

          {info && (
            <>
              <SeriesMetaSection />
              <ChaptersSection />
            </>
          )}
        </div>
      </div>
    </ScrollArea>
  )
}

function CreateProjectButton({
  onCreate,
}: {
  onCreate: (name: string) => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  return (
    <>
      <Button variant='default' size='sm' onClick={() => setOpen(true)}>
        <FolderPlusIcon className='size-3.5' />
        New project…
      </Button>
      {open && (
        <div className='bg-background/80 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm'>
          <div className='bg-card border-border w-96 rounded-lg border p-5 shadow-lg'>
            <h3 className='text-foreground mb-1 text-sm font-bold'>
              New project
            </h3>
            <p className='text-muted-foreground mb-4 text-xs'>
              Pick a parent folder; a new sub-folder will be created using the
              project name.
            </p>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='Series title'
              className='mb-3 text-sm'
            />
            <div className='flex justify-end gap-2'>
              <Button variant='ghost' size='sm' onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant='default'
                size='sm'
                disabled={!name.trim()}
                onClick={async () => {
                  await onCreate(name.trim())
                  setOpen(false)
                  setName('')
                }}
              >
                Choose folder…
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function SeriesMetaSection() {
  const seriesMeta = useQuery({
    queryKey: projectQueryKeys.series,
    queryFn: () => api.seriesMetaGet(),
  })

  const [draft, setDraft] = useState<Partial<SeriesMetaDto>>({})
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    if (seriesMeta.data) {
      setDraft(seriesMeta.data)
      setDirty(false)
    }
  }, [seriesMeta.data])

  const patch = <K extends keyof SeriesMetaDto>(key: K, value: SeriesMetaDto[K]) => {
    setDraft((d) => ({ ...d, [key]: value }))
    setDirty(true)
  }

  const save = async () => {
    const next = await api.seriesMetaUpdate(draft)
    setDraft(next)
    setDirty(false)
    void seriesMeta.refetch()
  }

  if (seriesMeta.isLoading) {
    return (
      <section className='mb-8'>
        <p className='text-muted-foreground text-sm'>Loading series metadata…</p>
      </section>
    )
  }

  return (
    <section className='mb-8'>
      <h2 className='text-foreground mb-1 text-sm font-bold'>Series</h2>
      <p className='text-muted-foreground mb-4 text-sm'>
        Story-level context injected into every translation prompt.
      </p>

      <div className='bg-card border-border space-y-4 rounded-lg border p-4'>
        <Row label='Title'>
          <Input
            value={draft.title ?? ''}
            onChange={(e) => patch('title', e.target.value)}
            className='text-sm'
          />
        </Row>
        <Row label='Original title'>
          <Input
            value={draft.titleOriginal ?? ''}
            onChange={(e) => patch('titleOriginal', e.target.value || null)}
            placeholder='e.g. 陰陽師物語'
            className='text-sm'
          />
        </Row>
        <Row label='Synopsis'>
          <Textarea
            value={draft.synopsis ?? ''}
            onChange={(e) => patch('synopsis', e.target.value || null)}
            placeholder='A 2-3 sentence pitch the model will see for every page.'
            className='min-h-20 text-sm'
          />
        </Row>
        <div className='grid grid-cols-2 gap-3'>
          <Row label='Source language'>
            <Input
              value={draft.sourceLanguage ?? ''}
              onChange={(e) => patch('sourceLanguage', e.target.value)}
              className='text-sm'
            />
          </Row>
          <Row label='Target language'>
            <Input
              value={draft.targetLanguage ?? ''}
              onChange={(e) => patch('targetLanguage', e.target.value)}
              className='text-sm'
            />
          </Row>
        </div>
        <div className='grid grid-cols-2 gap-3'>
          <Row label='Tone'>
            <Input
              value={draft.tone ?? ''}
              onChange={(e) => patch('tone', e.target.value || null)}
              placeholder='casual / formal / mixed'
              className='text-sm'
            />
          </Row>
          <Row label='Formality'>
            <Input
              value={draft.formalityLevel ?? ''}
              onChange={(e) => patch('formalityLevel', e.target.value || null)}
              placeholder='low / medium / high'
              className='text-sm'
            />
          </Row>
        </div>
        <Row label='Style notes'>
          <Textarea
            value={draft.styleNotes ?? ''}
            onChange={(e) => patch('styleNotes', e.target.value || null)}
            placeholder='Free text — anything the model should know about voicing.'
            className='min-h-16 text-sm'
          />
        </Row>

        <div className='flex justify-end'>
          <Button
            variant='default'
            size='sm'
            disabled={!dirty}
            onClick={() => void save()}
          >
            Save changes
          </Button>
        </div>
      </div>
    </section>
  )
}

function ChaptersSection() {
  const chapters = useQuery({
    queryKey: projectQueryKeys.chapters,
    queryFn: () => api.chaptersList(),
  })

  const refresh = () => void chapters.refetch()

  const removeChapter = async (id: number) => {
    await api.chapterRemove(id)
    refresh()
  }

  const updateStatus = async (c: ChapterDto, status: ChapterStatus) => {
    await api.chapterUpdate({ id: c.id, status })
    refresh()
  }

  return (
    <section className='mb-8'>
      <div className='mb-1 flex items-center justify-between'>
        <h2 className='text-foreground text-sm font-bold'>Chapters</h2>
        <AddChapterButton onAdded={refresh} />
      </div>
      <p className='text-muted-foreground mb-4 text-sm'>
        Each chapter is a standalone .khr file stored under{' '}
        <code>chapters/</code>. Re-order with the chapter number.
      </p>

      <div className='bg-card border-border overflow-hidden rounded-lg border'>
        {chapters.isLoading ? (
          <div className='text-muted-foreground p-6 text-center text-sm'>
            Loading chapters…
          </div>
        ) : !chapters.data?.length ? (
          <div className='text-muted-foreground p-6 text-center text-sm'>
            No chapters yet. Add one to begin.
          </div>
        ) : (
          <table className='w-full text-left text-xs'>
            <thead className='bg-muted/50 text-muted-foreground'>
              <tr>
                <th className='px-3 py-2 font-medium'>#</th>
                <th className='px-3 py-2 font-medium'>File</th>
                <th className='px-3 py-2 font-medium'>Title</th>
                <th className='px-3 py-2 font-medium'>Pages</th>
                <th className='px-3 py-2 font-medium'>Status</th>
                <th className='px-3 py-2 font-medium'></th>
              </tr>
            </thead>
            <tbody>
              {chapters.data.map((c) => (
                <ChapterRow
                  key={c.id}
                  chapter={c}
                  onChanged={refresh}
                  onStatusChange={(s) => void updateStatus(c, s)}
                  onRemove={() => void removeChapter(c.id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}

function ChapterRow({
  chapter,
  onChanged,
  onStatusChange,
  onRemove,
}: {
  chapter: ChapterDto
  onChanged: () => void
  onStatusChange: (status: ChapterStatus) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const [summarising, setSummarising] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summaryDraft, setSummaryDraft] = useState(chapter.summary ?? '')

  // Sync local draft when chapter row reloads.
  if (summaryDraft === '' && chapter.summary && !open) {
    // No-op — controlled by open state.
  }

  const runSummarise = async () => {
    const text = prompt(
      'Paste the chapter text the summary should be based on.\n(Or close this dialog and paste in the editor below.)',
    )
    if (!text || !text.trim()) return
    setSummarising(true)
    setError(null)
    try {
      const summary = await summarizeChapter(chapter.id, text)
      setSummaryDraft(summary)
      onChanged()
      setOpen(true)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSummarising(false)
    }
  }

  const saveSummary = async () => {
    await api.chapterUpdate({ id: chapter.id, summary: summaryDraft || null })
    onChanged()
    setOpen(false)
  }

  return (
    <>
      <tr className='border-border border-t hover:bg-accent/30'>
        <td className='px-3 py-2'>{chapter.chapterNumber}</td>
        <td className='text-muted-foreground truncate px-3 py-2'>
          {chapter.filePath}
        </td>
        <td className='px-3 py-2'>{chapter.title ?? '—'}</td>
        <td className='text-muted-foreground px-3 py-2'>
          {chapter.pageCount || '—'}
        </td>
        <td className='px-3 py-2'>
          <Select
            value={chapter.status}
            onValueChange={(v) => onStatusChange(v as ChapterStatus)}
          >
            <SelectTrigger
              className={`h-6 px-1.5 text-[10px] ${STATUS_BADGE[chapter.status]}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </td>
        <td className='px-3 py-2 text-right'>
          <Button
            variant='ghost'
            size='sm'
            title={chapter.summary ? 'View / edit summary' : 'Add summary'}
            onClick={() => {
              setSummaryDraft(chapter.summary ?? '')
              setOpen(!open)
            }}
          >
            {chapter.summary ? '📝' : '➕'}
          </Button>
          <Button
            variant='ghost'
            size='sm'
            title='Generate summary via LLM'
            disabled={summarising}
            onClick={() => void runSummarise()}
          >
            {summarising ? (
              <Loader2Icon className='size-3.5 animate-spin' />
            ) : (
              <SparklesIcon className='size-3.5' />
            )}
          </Button>
          <Button
            variant='ghost'
            size='sm'
            title='Remove from index'
            onClick={onRemove}
          >
            <Trash2Icon className='size-3.5' />
          </Button>
        </td>
      </tr>
      {open && (
        <tr className='bg-muted/30'>
          <td colSpan={6} className='px-3 py-3'>
            {error && (
              <div className='border-destructive/40 bg-destructive/10 text-destructive mb-2 rounded-md border p-2 text-xs'>
                {error}
              </div>
            )}
            <Textarea
              value={summaryDraft}
              onChange={(e) => setSummaryDraft(e.target.value)}
              placeholder='Chapter summary used as rolling context in future translations.'
              className='min-h-20 text-xs'
            />
            <div className='mt-2 flex justify-end gap-2'>
              <Button variant='ghost' size='sm' onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant='default' size='sm' onClick={() => void saveSummary()}>
                Save
              </Button>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function AddChapterButton({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false)
  const [filePath, setFilePath] = useState('')
  const [chapterNumber, setChapterNumber] = useState('1')
  const [title, setTitle] = useState('')

  const submit = async () => {
    const num = parseFloat(chapterNumber)
    if (!filePath.trim() || !Number.isFinite(num)) return
    await api.chapterAdd({
      filePath: filePath.trim(),
      chapterNumber: num,
      title: title.trim() || null,
    })
    setOpen(false)
    setFilePath('')
    setChapterNumber('1')
    setTitle('')
    onAdded()
  }

  return (
    <>
      <Button variant='outline' size='sm' onClick={() => setOpen(true)}>
        <PlusIcon className='size-3.5' />
        Add chapter
      </Button>
      {open && (
        <div className='bg-background/80 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm'>
          <div className='bg-card border-border w-96 rounded-lg border p-5 shadow-lg'>
            <h3 className='text-foreground mb-3 text-sm font-bold'>
              Add chapter
            </h3>
            <div className='space-y-3'>
              <Row label='File path (relative to project root)'>
                <Input
                  autoFocus
                  value={filePath}
                  onChange={(e) => setFilePath(e.target.value)}
                  placeholder='chapters/ch01.khr'
                  className='text-sm'
                />
              </Row>
              <div className='grid grid-cols-2 gap-3'>
                <Row label='Chapter number'>
                  <Input
                    value={chapterNumber}
                    onChange={(e) => setChapterNumber(e.target.value)}
                    className='text-sm'
                  />
                </Row>
                <Row label='Title (optional)'>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className='text-sm'
                  />
                </Row>
              </div>
            </div>
            <div className='mt-4 flex justify-end gap-2'>
              <Button variant='ghost' size='sm' onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant='default'
                size='sm'
                disabled={!filePath.trim()}
                onClick={() => void submit()}
              >
                Add
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className='flex flex-col gap-1.5'>
      <label className='text-foreground text-xs font-semibold'>{label}</label>
      {children}
    </div>
  )
}
