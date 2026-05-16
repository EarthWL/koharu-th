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
      alert(
        t('welcome.openRecentFailed', 'Could not open project: {{msg}}', {
          msg: err?.message ?? String(err),
        }),
      )
    } finally {
      setLoading(false)
    }
  }

  const onRemoveRecent = async (path: string) => {
    await api.recentProjectsRemove(path)
    setRecent((cur) => cur?.filter((r) => r.path !== path) ?? null)
  }

  const onStandalone = async () => {
    setStandalone(true)
    await openDocuments()
  }

  return (
    <div className='bg-background/95 fixed inset-0 z-40 flex items-center justify-center backdrop-blur-sm'>
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
  t: (key: string, fallback?: any, opts?: any) => string
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
  t: (key: string, fallback?: any, opts?: any) => string
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
  t: (key: string, fallback?: any, opts?: any) => string
  info: ProjectInfo
  onSaved: () => void
  onSkip: () => void
}) {
  const [draft, setDraft] = useState<Partial<SeriesMetaDto>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

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
    try {
      await api.seriesMetaUpdate(draft)
      onSaved()
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
// Step 4: Add first chapter(s)
// ─────────────────────────────────────────────────────────────────
function ChaptersStep({
  t,
  onDone,
}: {
  t: (key: string, fallback?: any, opts?: any) => string
  onDone: () => void
}) {
  const [importing, setImporting] = useState(false)
  const [addedCount, setAddedCount] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const importFiles = async () => {
    setImporting(true)
    setError(null)
    try {
      const r = await api.chapterAddFromPicker()
      setAddedCount((c) => c + r.added)
      if (r.added === 0 && r.skipped === 0) {
        // Cancelled.
      } else if (r.added === 0) {
        setError(`Skipped ${r.skipped} files (unsupported / copy failed)`)
      }
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setImporting(false)
    }
  }

  const openFirstChapter = async () => {
    setImporting(true)
    try {
      const chapters = await api.chaptersList()
      if (chapters.length > 0) {
        const first = chapters[0]
        await api.chapterOpen(first.id)
        useProjectStore.getState().setActiveChapterId(first.id)
      }
      onDone()
    } finally {
      setImporting(false)
    }
  }

  return (
    <>
      <WizardHeader
        step={3}
        total={3}
        title={t('welcome.chaptersTitle', 'Add chapters')}
      />
      <p className='text-muted-foreground mb-4 text-xs'>
        {t(
          'welcome.chaptersHint',
          'Pick .khr or image files. They will be copied into the project so the original folder stays untouched. You can add more later from the Chapters tab.',
        )}
      </p>
      <div className='border-border bg-muted/30 mb-4 rounded-md border border-dashed p-6 text-center'>
        <Button
          variant='default'
          size='sm'
          disabled={importing}
          onClick={() => void importFiles()}
        >
          {importing ? (
            <Loader2Icon className='size-3.5 animate-spin' />
          ) : (
            <FolderOpenIcon className='size-3.5' />
          )}
          {t('welcome.pickChapterFiles', 'Pick files…')}
        </Button>
        {addedCount > 0 && (
          <div className='mt-3 flex items-center justify-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400'>
            <CheckIcon className='size-3.5' />
            {addedCount}{' '}
            {t('welcome.chaptersAdded', 'chapters added — pick more or finish')}
          </div>
        )}
        {error && (
          <div className='text-destructive mt-2 text-[10px]'>{error}</div>
        )}
      </div>
      <div className='flex justify-between gap-2'>
        <Button variant='ghost' size='sm' onClick={onDone}>
          {t('welcome.skipChapters', 'Add later')}
        </Button>
        <Button
          variant='default'
          size='sm'
          disabled={importing || addedCount === 0}
          onClick={() => void openFirstChapter()}
        >
          {importing && <Loader2Icon className='size-3.5 animate-spin' />}
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
