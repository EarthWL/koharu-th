'use client'

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useRouter } from 'next/navigation'
import {
  ArrowLeftIcon,
  CheckIcon,
  ClockIcon,
  FileImageIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  Loader2Icon,
  XIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  api,
  type ProjectInfo,
  type RecentProjectDto,
  type SeriesMetaDto,
} from '@/lib/api'
import { useProjectMutations } from '@/lib/query/projectMutations'
import { useProjectStore } from '@/lib/stores/projectStore'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { useDocumentMutations } from '@/lib/query/mutations'

type WizardStep =
  | { kind: 'home' }
  | { kind: 'create-name'; name: string }
  | { kind: 'create-setup'; info: ProjectInfo }
  | { kind: 'create-chapters'; info: ProjectInfo }

/**
 * Mandatory entry-point. Renders as an overlay until the user either
 *   (a) creates / opens a project, or
 *   (b) escapes via the "Standalone files" button.
 *
 * The new-project flow is a 3-step wizard:
 *   home → create-name → create-setup → create-chapters → editor
 */
export function Welcome() {
  const { t } = useTranslation()
  const router = useRouter()
  const { createPicker, openPicker, refreshCurrent } = useProjectMutations()
  const setStandalone = useProjectStore((s) => s.setStandaloneAllowed)
  const { openDocuments } = useDocumentMutations()

  const [step, setStep] = useState<WizardStep>({ kind: 'home' })
  const [loading, setLoading] = useState(false)
  const [recent, setRecent] = useState<RecentProjectDto[] | null>(null)

  // Load recent on mount.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await api.recentProjectsList()
        if (!cancelled) setRecent(list)
      } catch (err) {
        console.warn('[welcome] recent fetch failed', err)
        if (!cancelled) setRecent([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const onStartCreate = () =>
    setStep({ kind: 'create-name', name: '' })

  const onOpen = async () => {
    setLoading(true)
    try {
      const info = await openPicker()
      if (info) {
        // Existing project — straight to editor.
        router.push('/')
      }
    } finally {
      setLoading(false)
    }
  }

  const onOpenRecent = async (p: RecentProjectDto) => {
    setLoading(true)
    try {
      const info = await api.projectOpen(p.path)
      useProjectStore.getState().setInfo(info)
      await refreshCurrent()
      router.push('/')
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      // Auto-prune obviously-stale entries when the folder is gone.
      // Heuristic: backend's "not found" / "does not exist" /
      // "no such file" messages are safe to act on. Anything else
      // (permission denied, DB corrupt) is a transient — leave the
      // row so the user can retry later.
      const looksMissing = /not found|does not exist|no such file|cannot find/i.test(
        msg,
      )
      if (looksMissing) {
        try {
          await api.recentProjectsRemove(p.path)
          setRecent((cur) => cur?.filter((r) => r.path !== p.path) ?? null)
        } catch {
          // Best-effort prune; if it fails the row just stays.
        }
        alert(
          t(
            'welcome.openRecentMissing',
            'Project folder no longer exists at "{{path}}" — removed from recents.',
            { path: p.path },
          ),
        )
      } else {
        alert(
          t('welcome.openRecentFailed', 'Could not open project: {{msg}}', {
            msg,
          }),
        )
      }
    } finally {
      setLoading(false)
    }
  }

  const onRemoveRecent = async (path: string) => {
    try {
      await api.recentProjectsRemove(path)
      setRecent((cur) => cur?.filter((r) => r.path !== path) ?? null)
    } catch (err: any) {
      // Was: silently swallowed errors and pruned the UI anyway —
      // leaving the backend row intact while the user sees it gone.
      // Now: keep the row in the list and surface the failure so the
      // user can retry (or check disk/permissions).
      alert(
        t('welcome.removeRecentFailed', 'Could not remove from recent: {{msg}}', {
          msg: err?.message ?? String(err),
        }),
      )
    }
  }

  const onStandalone = async () => {
    setStandalone(true)
    await openDocuments()
  }

  // Esc steps back through the wizard instead of dismissing entirely
  // (there's no "close" — the user has to either create / open a project
  // or hit Standalone). Wizard back: subsetup → name → home. On home
  // there's nothing to step back to.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (step.kind === 'create-name') setStep({ kind: 'home' })
      else if (step.kind === 'create-setup')
        setStep({ kind: 'create-name', name: step.info.name })
      else if (step.kind === 'create-chapters') {
        // Stay — chapters is the last wizard step and dismissing would
        // leave a freshly-created empty project behind.
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [step])

  return (
    <div
      className='bg-background/95 fixed inset-0 z-40 flex items-center justify-center backdrop-blur-sm'
      role='dialog'
      aria-modal='true'
      aria-label='Welcome — open or create a project'
    >
      <div className='bg-card border-border w-full max-w-2xl rounded-lg border p-6 shadow-xl'>
        {step.kind === 'home' && (
          <HomeStep
            t={t}
            recent={recent}
            loading={loading}
            onCreate={onStartCreate}
            onOpen={() => void onOpen()}
            onOpenRecent={(p) => void onOpenRecent(p)}
            onRemoveRecent={(p) => void onRemoveRecent(p)}
            onStandalone={() => void onStandalone()}
          />
        )}
        {step.kind === 'create-name' && (
          <NameStep
            t={t}
            name={step.name}
            loading={loading}
            onChange={(name) => setStep({ kind: 'create-name', name })}
            onBack={() => setStep({ kind: 'home' })}
            onSubmit={async () => {
              if (!step.name.trim()) return
              setLoading(true)
              try {
                const info = await createPicker(step.name.trim())
                if (info) {
                  setStep({ kind: 'create-setup', info })
                }
              } finally {
                setLoading(false)
              }
            }}
          />
        )}
        {step.kind === 'create-setup' && (
          <SetupStep
            t={t}
            info={step.info}
            onSkip={() => setStep({ kind: 'create-chapters', info: step.info })}
            onSaved={() =>
              setStep({ kind: 'create-chapters', info: step.info })
            }
          />
        )}
        {step.kind === 'create-chapters' && (
          <ChaptersStep
            t={t}
            onDone={() => router.push('/')}
          />
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// Step 1: Home — pick New / Open / Recent / Standalone
// ─────────────────────────────────────────────────────────────────
function HomeStep({
  t,
  recent,
  loading,
  onCreate,
  onOpen,
  onOpenRecent,
  onRemoveRecent,
  onStandalone,
}: {
  t: any
  recent: RecentProjectDto[] | null
  loading: boolean
  onCreate: () => void
  onOpen: () => void
  onOpenRecent: (p: RecentProjectDto) => void
  onRemoveRecent: (path: string) => void
  onStandalone: () => void
}) {
  return (
    <>
      <div className='mb-6 text-center'>
        <h1 className='text-foreground text-2xl font-bold'>
          {t('welcome.title', 'Welcome to Koharu-TH')}
        </h1>
        <p className='text-muted-foreground mt-1 text-sm'>
          {t(
            'welcome.subtitle',
            'Start a series project — keeps characters, glossary, and translation memory across chapters.',
          )}
        </p>
      </div>
      <div className='grid gap-2 sm:grid-cols-2'>
        <ActionCard
          icon={FolderPlusIcon}
          title={t('welcome.newProject', 'New project')}
          description={t(
            'welcome.newProjectDescription',
            'Set up a folder for this series. Recommended.',
          )}
          disabled={loading}
          onClick={onCreate}
          primary
        />
        <ActionCard
          icon={FolderOpenIcon}
          title={t('welcome.openProject', 'Open project')}
          description={t(
            'welcome.openProjectDescription',
            'Pick an existing series.koharuproj file.',
          )}
          disabled={loading}
          onClick={onOpen}
        />
      </div>
      {recent && recent.length > 0 && (
        <div className='mt-6'>
          <div className='text-muted-foreground mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide'>
            <ClockIcon className='size-3' />
            {t('welcome.recent', 'Recent projects')}
          </div>
          <ul className='border-border divide-border divide-y rounded-md border'>
            {recent.map((p) => (
              <li
                key={p.path}
                className='hover:bg-accent/30 flex items-center gap-2 px-3 py-2 transition'
              >
                <button
                  onClick={() => onOpenRecent(p)}
                  disabled={loading}
                  className='min-w-0 flex-1 text-left disabled:opacity-50'
                >
                  <div className='text-foreground truncate text-sm font-medium'>
                    {p.name}
                  </div>
                  <div className='text-muted-foreground truncate text-[10px]'>
                    {p.path}
                  </div>
                </button>
                <Button
                  variant='ghost'
                  size='icon-xs'
                  title={t('welcome.removeRecent', 'Remove from list')}
                  onClick={() => onRemoveRecent(p.path)}
                >
                  <XIcon className='size-3' />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className='border-border mt-6 border-t pt-4'>
        <div className='text-muted-foreground mb-2 text-[10px] font-bold uppercase tracking-wide'>
          {t('welcome.standalone', 'Without a project')}
        </div>
        <p className='text-muted-foreground mb-3 text-xs'>
          {t(
            'welcome.standaloneHint',
            'Open a .khr or image directly for a quick one-off translation. No glossary, no TM, no chapter context.',
          )}
        </p>
        <Button
          variant='outline'
          size='sm'
          disabled={loading}
          onClick={onStandalone}
        >
          <FileImageIcon className='size-3.5' />
          {t('welcome.openStandalone', 'Open files…')}
        </Button>
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────
// Step 2: New project name → folder picker
// ─────────────────────────────────────────────────────────────────
function NameStep({
  t,
  name,
  loading,
  onChange,
  onBack,
  onSubmit,
}: {
  t: any
  name: string
  loading: boolean
  onChange: (name: string) => void
  onBack: () => void
  onSubmit: () => void | Promise<void>
}) {
  return (
    <>
      <WizardHeader
        step={1}
        total={3}
        title={t('welcome.newProjectModalTitle', 'New project')}
        onBack={onBack}
      />
      <p className='text-muted-foreground mb-3 text-xs'>
        {t(
          'welcome.newProjectModalHint',
          'Choose a parent folder; a sub-folder named after the series will be created inside it.',
        )}
      </p>
      <Input
        autoFocus
        value={name}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('welcome.newProjectNamePlaceholder', 'Series title')}
        className='mb-3 text-sm'
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim()) void onSubmit()
        }}
      />
      <div className='flex justify-end'>
        <Button
          variant='default'
          size='sm'
          disabled={!name.trim() || loading}
          onClick={() => void onSubmit()}
        >
          {loading && <Loader2Icon className='size-3.5 animate-spin' />}
          {t('welcome.chooseFolder', 'Choose folder…')}
        </Button>
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────
// Step 3: Series setup form
// ─────────────────────────────────────────────────────────────────
function SetupStep({
  t,
  info,
  onSaved,
  onSkip,
}: {
  t: any
  info: ProjectInfo
  onSaved: () => void
  onSkip: () => void
}) {
  const [draft, setDraft] = useState<Partial<SeriesMetaDto>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const meta = await api.seriesMetaGet()
        if (!cancelled) setDraft(meta)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [info.id])

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      await api.seriesMetaUpdate(draft)
      onSaved()
    } catch (err: any) {
      // Was: silent fail — user got stuck on Step 2 with no feedback,
      // no way to retry. Now: surface inline so they can fix + retry
      // without losing the draft they just filled.
      setSaveError(err?.message ?? String(err))
    } finally {
      setSaving(false)
    }
  }

  const patch = <K extends keyof SeriesMetaDto>(
    key: K,
    value: SeriesMetaDto[K],
  ) => setDraft((d) => ({ ...d, [key]: value }))

  if (loading) {
    return (
      <div className='text-muted-foreground p-8 text-center text-sm'>
        Loading…
      </div>
    )
  }

  return (
    <>
      <WizardHeader
        step={2}
        total={3}
        title={t('welcome.setupTitle', 'Series settings')}
      />
      <p className='text-muted-foreground mb-3 text-xs'>
        {t(
          'welcome.setupHint',
          'These get injected into every translation prompt so the model knows the tone, characters, and target audience. Skip and edit later if you want.',
        )}
      </p>
      <div className='space-y-3'>
        <Field label={t('project.titleField', 'Title')}>
          <Input
            value={draft.title ?? ''}
            onChange={(e) => patch('title', e.target.value)}
            className='text-sm'
          />
        </Field>
        <Field label={t('project.titleOriginal', 'Original title')}>
          <Input
            value={draft.titleOriginal ?? ''}
            onChange={(e) => patch('titleOriginal', e.target.value || null)}
            placeholder='e.g. 陰陽師物語'
            className='text-sm'
          />
        </Field>
        <Field label={t('project.synopsis', 'Synopsis')}>
          <Textarea
            value={draft.synopsis ?? ''}
            onChange={(e) => patch('synopsis', e.target.value || null)}
            placeholder={t(
              'project.synopsisPlaceholder',
              '2-3 sentence pitch the model will see on every page.',
            )}
            className='min-h-16 text-sm'
          />
        </Field>
        <div className='grid grid-cols-2 gap-2'>
          <Field label={t('project.sourceLanguage', 'Source language')}>
            <Input
              value={draft.sourceLanguage ?? ''}
              onChange={(e) => patch('sourceLanguage', e.target.value)}
              placeholder='ja'
              className='text-sm'
            />
          </Field>
          <Field label={t('project.targetLanguage', 'Target language')}>
            <Input
              value={draft.targetLanguage ?? ''}
              onChange={(e) => patch('targetLanguage', e.target.value)}
              placeholder='th'
              className='text-sm'
            />
          </Field>
        </div>
        <div className='grid grid-cols-2 gap-2'>
          <Field label={t('project.tone', 'Tone')}>
            <Input
              value={draft.tone ?? ''}
              onChange={(e) => patch('tone', e.target.value || null)}
              placeholder='casual / formal / mixed'
              className='text-sm'
            />
          </Field>
          <Field label={t('project.formality', 'Formality')}>
            <Input
              value={draft.formalityLevel ?? ''}
              onChange={(e) => patch('formalityLevel', e.target.value || null)}
              placeholder='low / medium / high'
              className='text-sm'
            />
          </Field>
        </div>
      </div>
      {saveError && (
        <p className='text-destructive mt-3 text-xs leading-relaxed'>
          {t('welcome.saveFailed', 'Failed to save: {{msg}}', { msg: saveError })}
        </p>
      )}
      <div className='mt-4 flex justify-between gap-2'>
        <Button variant='ghost' size='sm' onClick={onSkip}>
          {t('welcome.skip', 'Skip')}
        </Button>
        <Button
          variant='default'
          size='sm'
          disabled={saving}
          onClick={() => void save()}
        >
          {saving && <Loader2Icon className='size-3.5 animate-spin' />}
          {t('welcome.saveAndContinue', 'Save & continue')}
        </Button>
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────
// Step 4: Create chapter(s) + add page images
// ─────────────────────────────────────────────────────────────────
type WizardChapter = {
  id: number
  chapterNumber: number
  title: string | null
  folderPath: string
  pageCount: number
}

function ChaptersStep({
  t,
  onDone,
}: {
  t: any
  onDone: () => void
}) {
  const [chapters, setChapters] = useState<WizardChapter[]>([])
  const [title, setTitle] = useState('')
  const [chapterNumber, setChapterNumber] = useState<string>('1')
  const [busy, setBusy] = useState(false)
  const [pageBusyId, setPageBusyId] = useState<number | null>(null)
  const [justAdded, setJustAdded] = useState<{ id: number; n: number } | null>(
    null,
  )
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    try {
      const list = await api.chaptersList()
      // Clear any stale "Failed to load" error banner now that we have
      // a successful fetch.
      setError(null)
      setChapters(
        list.map((c) => ({
          id: c.id,
          chapterNumber: c.chapterNumber,
          title: c.title,
          folderPath: c.folderPath,
          pageCount: c.pageCount,
        })),
      )
      const next = list.reduce((m, c) => Math.max(m, c.chapterNumber), 0) + 1
      setChapterNumber(String(next))
    } catch (err: any) {
      // Was: refresh() on mount could throw silently (DB locked, disk
      // issue, project closed externally) and the user saw an empty
      // chapter list with no retry path. Now surface as inline error.
      setError(
        t('welcome.loadChaptersFailed', 'Could not load chapters: {{msg}}', {
          msg: err?.message ?? String(err),
        }),
      )
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const createChapter = async () => {
    const num = Number(chapterNumber)
    if (!Number.isFinite(num)) {
      setError(t('welcome.invalidNumber', 'Chapter number must be a number'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.chapterCreate({
        chapterNumber: num,
        title: title.trim() || null,
      })
      setTitle('')
      await refresh()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const addPages = async (chapterId: number) => {
    setPageBusyId(chapterId)
    setError(null)
    try {
      const r = await api.chapterAddPages(chapterId)
      if (r.added > 0) {
        setJustAdded({ id: chapterId, n: r.added })
        window.setTimeout(() => setJustAdded(null), 2500)
      } else if (r.skipped > 0) {
        setError(
          t('welcome.skippedPages', 'Skipped {{n}} files', { n: r.skipped }),
        )
      }
      await refresh()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setPageBusyId(null)
    }
  }

  const totalPages = chapters.reduce((n, c) => n + c.pageCount, 0)
  const firstWithPages = chapters.find((c) => c.pageCount > 0)

  const openFirstChapter = async () => {
    if (!firstWithPages) {
      onDone()
      return
    }
    setOpening(true)
    try {
      // Push the returned page count into the editor store so
      // MenuBar / palette gating + Navigator see the new chapter as
      // populated (#28).
      const count = await api.chapterOpen(firstWithPages.id)
      useEditorUiStore.getState().setTotalPages(count)
      useProjectStore.getState().setActiveChapterId(firstWithPages.id)
      onDone()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setOpening(false)
    }
  }

  return (
    <>
      <WizardHeader
        step={3}
        total={3}
        title={t('welcome.chaptersTitle', 'Add chapters')}
      />
      <p className='text-muted-foreground mb-3 text-xs leading-relaxed'>
        {t(
          'welcome.chaptersHint',
          'Create a Chapter — koharu makes source/ + render/ subfolders for it. Then click "+ Pages" to upload the page images into each chapter\'s source/.',
        )}
      </p>

      {/* Create-chapter row */}
      <div className='border-border bg-muted/30 mb-3 flex items-center gap-2 rounded-md border p-2'>
        <Input
          inputMode='decimal'
          value={chapterNumber}
          onChange={(e) => setChapterNumber(e.target.value)}
          placeholder={t('welcome.chapterNumberPh', 'No.')}
          className='h-8 w-16 text-xs'
          title={t('welcome.chapterNumberTitle', 'Chapter number')}
        />
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t(
            'welcome.chapterTitlePh',
            'Chapter title (optional)',
          )}
          className='h-8 flex-1 text-xs'
          onKeyDown={(e) => {
            if (e.key === 'Enter') void createChapter()
          }}
        />
        <Button
          size='sm'
          disabled={busy}
          onClick={() => void createChapter()}
        >
          {busy ? (
            <Loader2Icon className='size-3.5 animate-spin' />
          ) : (
            <FolderPlusIcon className='size-3.5' />
          )}
          {t('welcome.createChapter', 'Create')}
        </Button>
      </div>

      {/* Chapter list */}
      <div className='mb-4 max-h-64 space-y-1 overflow-auto pr-1'>
        {chapters.length === 0 ? (
          <div className='border-border text-muted-foreground rounded-md border border-dashed p-4 text-center text-xs'>
            {t('welcome.noChaptersYet', 'No chapters yet — create one above')}
          </div>
        ) : (
          chapters.map((c) => {
            const flashing = justAdded?.id === c.id
            return (
              <div
                key={c.id}
                className={
                  'flex items-center gap-2 rounded-md border p-2 text-xs transition ' +
                  (flashing
                    ? 'border-emerald-500/60 bg-emerald-500/10 ring-2 ring-emerald-500/40'
                    : 'border-border bg-card')
                }
              >
                <span className='bg-muted text-muted-foreground rounded px-1 py-0.5 font-mono text-[10px]'>
                  #{c.chapterNumber}
                </span>
                <span className='min-w-0 flex-1 truncate'>
                  {c.title ?? c.folderPath.split(/[\\/]/).pop()}
                </span>
                <span
                  className={
                    'shrink-0 text-[10px] font-medium ' +
                    (c.pageCount === 0
                      ? 'text-muted-foreground/60'
                      : 'text-emerald-600 dark:text-emerald-400')
                  }
                >
                  {c.pageCount} {c.pageCount === 1 ? 'page' : 'pages'}
                </span>
                {flashing && (
                  <span className='flex shrink-0 items-center gap-0.5 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300'>
                    <CheckIcon className='size-2.5' />+{justAdded!.n}
                  </span>
                )}
                <Button
                  variant='outline'
                  size='sm'
                  className='h-7 px-2 text-[10px]'
                  disabled={pageBusyId === c.id}
                  onClick={() => void addPages(c.id)}
                >
                  {pageBusyId === c.id ? (
                    <Loader2Icon className='size-3 animate-spin' />
                  ) : (
                    <FileImageIcon className='size-3' />
                  )}
                  {t('welcome.addPages', '+ Pages')}
                </Button>
              </div>
            )
          })
        )}
      </div>

      {error && (
        <div className='text-destructive mb-2 text-[10px]'>{error}</div>
      )}

      <div className='text-muted-foreground mb-2 text-center text-[10px]'>
        {chapters.length}{' '}
        {t('welcome.chaptersCount', 'chapters')} · {totalPages}{' '}
        {t('welcome.pagesCount', 'pages')}
      </div>

      <div className='flex justify-between gap-2'>
        <Button variant='ghost' size='sm' onClick={onDone}>
          {t('welcome.skipChapters', 'Add later')}
        </Button>
        <Button
          variant='default'
          size='sm'
          disabled={opening || !firstWithPages}
          onClick={() => void openFirstChapter()}
          title={
            firstWithPages
              ? undefined
              : t(
                  'welcome.needPages',
                  'Add at least one page to a chapter to open the editor',
                )
          }
        >
          {opening && <Loader2Icon className='size-3.5 animate-spin' />}
          {t('welcome.openFirst', 'Open first chapter →')}
        </Button>
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────
// shared bits
// ─────────────────────────────────────────────────────────────────
function WizardHeader({
  step,
  total,
  title,
  onBack,
}: {
  step: number
  total: number
  title: string
  onBack?: () => void
}) {
  return (
    <div className='mb-3 flex items-center gap-2'>
      {onBack && (
        <Button variant='ghost' size='icon-sm' onClick={onBack}>
          <ArrowLeftIcon className='size-3.5' />
        </Button>
      )}
      <h3 className='text-foreground flex-1 text-sm font-bold'>{title}</h3>
      <span className='text-muted-foreground text-[10px]'>
        {step} / {total}
      </span>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className='flex flex-col gap-1'>
      <label className='text-foreground text-[10px] font-semibold uppercase tracking-wide'>
        {label}
      </label>
      {children}
    </div>
  )
}

function ActionCard({
  icon: Icon,
  title,
  description,
  primary = false,
  disabled,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
  primary?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={
        primary
          ? 'border-primary bg-primary/5 hover:bg-primary/10 disabled:opacity-50 group flex flex-col items-start gap-1 rounded-md border p-3 text-left transition'
          : 'border-border bg-card hover:bg-accent/30 disabled:opacity-50 group flex flex-col items-start gap-1 rounded-md border p-3 text-left transition'
      }
    >
      <div className='flex items-center gap-2'>
        <Icon
          className={
            primary
              ? 'text-primary size-4'
              : 'text-muted-foreground group-hover:text-foreground size-4'
          }
        />
        <span className='text-foreground text-sm font-semibold'>{title}</span>
      </div>
      <p className='text-muted-foreground text-xs'>{description}</p>
    </button>
  )
}

/**
 * Conditional gate: renders the Welcome overlay when there's no
 * project open AND the user hasn't escaped via "Standalone files".
 * Mount this in the root layout so it covers everything.
 */
export function WelcomeGate() {
  const projectInfo = useProjectStore((s) => s.info)
  const standaloneAllowed = useProjectStore((s) => s.standaloneAllowed)
  const { refreshCurrent } = useProjectMutations()

  // Rehydrate project state from backend on mount so a hot reload
  // doesn't pop the welcome gate when a project is actually open.
  useEffect(() => {
    void refreshCurrent()
  }, [refreshCurrent])

  if (projectInfo || standaloneAllowed) return null
  return <Welcome />
}
