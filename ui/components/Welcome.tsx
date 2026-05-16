'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslation } from 'react-i18next'
import {
  ClockIcon,
  FileImageIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  Loader2Icon,
  XIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, type RecentProjectDto } from '@/lib/api'
import { useProjectMutations } from '@/lib/query/projectMutations'
import { useProjectStore } from '@/lib/stores/projectStore'
import { useDocumentMutations } from '@/lib/query/mutations'

/**
 * Empty-state landing when no document is loaded. Surfaces the four
 * primary entry points (New project / Open project / Open recent /
 * Standalone files) so users don't have to discover the workflow
 * through menus.
 */
export function Welcome() {
  const { t } = useTranslation()
  const projectInfo = useProjectStore((s) => s.info)
  const { createPicker, openPicker, refreshCurrent } = useProjectMutations()
  const { openDocuments } = useDocumentMutations()

  const [recent, setRecent] = useState<RecentProjectDto[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [namePromptOpen, setNamePromptOpen] = useState(false)
  const [draftName, setDraftName] = useState('')

  // Pull recent on mount + after each project change.
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
  }, [projectInfo?.id])

  const onCreate = async () => {
    if (!draftName.trim()) return
    setLoading(true)
    try {
      await createPicker(draftName.trim())
      setNamePromptOpen(false)
      setDraftName('')
    } finally {
      setLoading(false)
    }
  }

  const onOpen = async () => {
    setLoading(true)
    try {
      await openPicker()
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
    } catch (err: any) {
      alert(
        t(
          'welcome.openRecentFailed',
          'Could not open project: {{msg}}',
          { msg: err?.message ?? String(err) },
        ),
      )
    } finally {
      setLoading(false)
    }
  }

  const onRemoveRecent = async (path: string) => {
    await api.recentProjectsRemove(path)
    setRecent((cur) => cur?.filter((r) => r.path !== path) ?? null)
  }

  return (
    <div className='flex h-full w-full items-center justify-center p-6'>
      <div className='bg-card border-border w-full max-w-2xl rounded-lg border p-6 shadow-sm'>
        {/* Header */}
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

        {/* Primary actions */}
        <div className='grid gap-2 sm:grid-cols-2'>
          <ActionCard
            icon={FolderPlusIcon}
            title={t('welcome.newProject', 'New project')}
            description={t(
              'welcome.newProjectDescription',
              'Set up a folder for this series. Recommended.',
            )}
            disabled={loading}
            onClick={() => {
              setNamePromptOpen(true)
            }}
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
            onClick={() => void onOpen()}
          />
        </div>

        {/* Recent projects */}
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
                    onClick={() => void onOpenRecent(p)}
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
                    onClick={() => void onRemoveRecent(p.path)}
                  >
                    <XIcon className='size-3' />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Standalone (no-project) escape hatch */}
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
            onClick={() => void openDocuments()}
          >
            <FileImageIcon className='size-3.5' />
            {t('welcome.openStandalone', 'Open files…')}
          </Button>
        </div>

        {/* Help link */}
        <div className='text-muted-foreground mt-4 text-center text-[10px]'>
          <Link
            href='/project'
            prefetch={false}
            className='hover:text-foreground underline'
          >
            {t('welcome.projectDashboard', 'Open project dashboard')}
          </Link>
        </div>
      </div>

      {/* New-project name modal */}
      {namePromptOpen && (
        <div className='bg-background/80 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm'>
          <div className='bg-card border-border w-96 rounded-lg border p-5 shadow-lg'>
            <h3 className='text-foreground mb-1 text-sm font-bold'>
              {t('welcome.newProjectModalTitle', 'New project')}
            </h3>
            <p className='text-muted-foreground mb-3 text-xs'>
              {t(
                'welcome.newProjectModalHint',
                'Choose a parent folder; a sub-folder named after the series will be created inside it.',
              )}
            </p>
            <Input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder={t('welcome.newProjectNamePlaceholder', 'Series title')}
              className='mb-3 text-sm'
              onKeyDown={(e) => {
                if (e.key === 'Enter' && draftName.trim()) void onCreate()
              }}
            />
            <div className='flex justify-end gap-2'>
              <Button
                variant='ghost'
                size='sm'
                onClick={() => {
                  setNamePromptOpen(false)
                  setDraftName('')
                }}
              >
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                variant='default'
                size='sm'
                disabled={!draftName.trim() || loading}
                onClick={() => void onCreate()}
              >
                {loading && <Loader2Icon className='size-3.5 animate-spin' />}
                {t('welcome.chooseFolder', 'Choose folder…')}
              </Button>
            </div>
          </div>
        </div>
      )}
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
