'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Command } from 'cmdk'
import {
  ArchiveIcon,
  BotIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  KeyRoundIcon,
  LogOutIcon,
  PlayIcon,
  SettingsIcon,
  StarIcon,
  WandSparklesIcon,
} from 'lucide-react'
import { api, type ChapterDto, type ProviderProfileDto } from '@/lib/api'
import { useProjectStore } from '@/lib/stores/projectStore'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import { useProjectMutations } from '@/lib/query/projectMutations'
import { SLASH_COMMANDS } from '@/lib/services/chatSlashCommands'
import { flushAllSyncQueues } from '@/lib/services/syncQueues'
import { effectiveDbProvider } from '@/lib/services/profileHelpers'

/**
 * Global Cmd+K / Ctrl+K command palette. Surfaces frequent actions
 * without hunting through sidebar tabs: jump to chapter, switch LLM
 * profile, project lifecycle, settings, AI chat slash commands.
 */
export function CommandPalette() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const projectInfo = useProjectStore((s) => s.info)
  const queryClient = useQueryClient()
  const { closeProject, openPicker, createPicker } = useProjectMutations()
  const setActiveChapterId = useProjectStore((s) => s.setActiveChapterId)
  const setPrefs = usePreferencesStore.getState()

  // Global hotkey listener. Match on `e.code` (physical key, layout-
  // independent) instead of `e.key` — on a Thai (or other non-Latin)
  // keyboard layout, Ctrl+K produces `e.key === 'ษ'` and the old
  // `key.toLowerCase() === 'k'` check silently never fired.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyK') {
        e.preventDefault()
        setOpen((v) => !v)
      } else if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const chapters = useQuery({
    queryKey: ['project', 'chapters'],
    queryFn: () => api.chaptersList(),
    enabled: !!projectInfo && open,
    staleTime: 30_000,
  })

  const profiles = useQuery({
    queryKey: ['project', 'profiles'],
    queryFn: () => api.providerProfilesList(),
    enabled: !!projectInfo && open,
    staleTime: 30_000,
  })

  const close = () => setOpen(false)

  const openChapter = async (c: ChapterDto) => {
    close()
    try {
      // Push the returned page count into the editor store so the
      // MenuBar / palette gating + Navigator see the new chapter as
      // populated (#28).
      const count = await api.chapterOpen(c.id)
      useEditorUiStore.getState().setTotalPages(count)
      setActiveChapterId(c.id)
      await queryClient.invalidateQueries({ queryKey: ['documents'] })
      router.push('/')
    } catch (err: any) {
      alert(err?.message ?? String(err))
    }
  }

  const applyProfile = async (p: ProviderProfileDto) => {
    close()
    // Route the dbProvider through effectiveDbProvider(p) so legacy
    // OpenRouter profiles (saved as provider='openai' + modelName
    // containing '/', before the v1.0.0 backend fix) reach the correct
    // dispatcher in cloudLlm.ts / cloudOcr.ts. Matches the Profiles
    // tab's apply() — palette was setting p.provider directly and
    // sending those profiles to the OpenAI dispatcher.
    setPrefs.setCloudProvider(effectiveDbProvider(p) as any)
    setPrefs.setCloudModelName(p.modelName)
    setPrefs.setActiveProfileId(p.id)
    if (p.apiUrl) setPrefs.setCloudApiUrl(p.apiUrl)
    try {
      const { apiKey } = await api.providerProfileSecretGet(p.id)
      if (apiKey) setPrefs.setCloudApiKey(apiKey)
    } catch {}
  }

  const exportCbz = async (c: ChapterDto) => {
    close()
    try {
      const r = await api.chapterExportCbz(c.id)
      if (r.path) {
        alert(t('palette.exportDone', { count: r.pageCount, path: r.path }))
      }
    } catch (err: any) {
      alert(err?.message ?? String(err))
    }
  }

  if (!open) return null

  return (
    <div
      role='dialog'
      aria-modal='true'
      aria-label={t('palette.label')}
      className='bg-background/80 fixed inset-0 z-[60] flex items-start justify-center pt-[20vh] backdrop-blur-sm'
      onClick={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <Command
        label={t('palette.label')}
        className='bg-card border-border w-[42rem] max-w-[92vw] overflow-hidden rounded-lg border shadow-2xl'
      >
        <Command.Input
          autoFocus
          placeholder={
            projectInfo
              ? t('palette.placeholderProject')
              : t('palette.placeholderNoProject')
          }
          className='text-foreground border-border w-full border-b bg-transparent px-4 py-3 text-sm outline-none'
        />
        <Command.List
          aria-live='polite'
          className='max-h-[60vh] overflow-y-auto p-2'
        >
          <Command.Empty className='text-muted-foreground p-3 text-center text-xs'>
            {t('palette.empty')}
          </Command.Empty>

          {/* Project lifecycle */}
          <Command.Group
            heading={t('palette.groupProject')}
            className='text-muted-foreground space-y-1 text-[10px] font-bold uppercase'
          >
            <Item
              onSelect={() => {
                close()
                const name = window.prompt(t('palette.projectNamePrompt'))
                if (!name?.trim()) return
                // Drain pending writes before swapping the project on the
                // store — pending text-block / mask / brush edits target
                // the outgoing project; without the flush they're orphaned.
                void (async () => {
                  await flushAllSyncQueues().catch(() => {})
                  const info = await createPicker(name.trim())
                  if (info) router.push('/')
                })()
              }}
              icon={<FolderPlusIcon className='size-3.5' />}
              label={t('palette.newProject')}
              shortcut={t('palette.shortcutPicker')}
            />
            <Item
              onSelect={() => {
                close()
                void (async () => {
                  await flushAllSyncQueues().catch(() => {})
                  const info = await openPicker()
                  if (info) router.push('/')
                })()
              }}
              icon={<FolderOpenIcon className='size-3.5' />}
              label={t('palette.openProject')}
            />
            {projectInfo && (
              <Item
                onSelect={() => {
                  close()
                  void (async () => {
                    await flushAllSyncQueues().catch(() => {})
                    void closeProject()
                  })()
                }}
                icon={<LogOutIcon className='size-3.5' />}
                label={t('palette.closeCurrentProject')}
              />
            )}
            <Item
              onSelect={() => {
                close()
                router.push('/settings')
              }}
              icon={<SettingsIcon className='size-3.5' />}
              label={t('palette.openSettings')}
              shortcut='⌘,'
            />
          </Command.Group>

          {/* Chapters */}
          {projectInfo && (chapters.data?.length ?? 0) > 0 && (
            <Command.Group
              heading={t('palette.groupOpenChapter')}
              className='text-muted-foreground mt-2 space-y-1 text-[10px] font-bold uppercase'
            >
              {chapters.data!.map((c) => (
                <Item
                  key={`open-${c.id}`}
                  onSelect={() => void openChapter(c)}
                  icon={<PlayIcon className='size-3.5' />}
                  label={`#${c.chapterNumber} ${c.title ?? t('palette.untitledChapter')}`}
                  sub={t('palette.chapterSummary', {
                    pages: t('palette.pagesCount', { count: c.pageCount }),
                    status: c.status,
                  })}
                />
              ))}
            </Command.Group>
          )}

          {/* Export */}
          {projectInfo && (chapters.data?.length ?? 0) > 0 && (
            <Command.Group
              heading={t('palette.groupExport')}
              className='text-muted-foreground mt-2 space-y-1 text-[10px] font-bold uppercase'
            >
              {chapters.data!.map((c) => (
                <Item
                  key={`cbz-${c.id}`}
                  onSelect={() => void exportCbz(c)}
                  icon={<ArchiveIcon className='size-3.5' />}
                  label={t('palette.exportChapter', {
                    number: c.chapterNumber,
                  })}
                  sub={c.title ?? t('palette.untitledChapter')}
                />
              ))}
            </Command.Group>
          )}

          {/* Profiles */}
          {projectInfo && (profiles.data?.length ?? 0) > 0 && (
            <Command.Group
              heading={t('palette.groupProfile')}
              className='text-muted-foreground mt-2 space-y-1 text-[10px] font-bold uppercase'
            >
              {profiles.data!.map((p) => (
                <Item
                  key={`profile-${p.id}`}
                  onSelect={() => void applyProfile(p)}
                  icon={
                    p.isDefault ? (
                      <StarIcon className='size-3.5 fill-amber-400 text-amber-400' />
                    ) : (
                      <KeyRoundIcon className='size-3.5' />
                    )
                  }
                  label={p.name}
                  sub={`${p.provider} · ${p.modelName || t('palette.noModel')}`}
                />
              ))}
            </Command.Group>
          )}

          {/* AI Chat slash commands */}
          {projectInfo && (
            <Command.Group
              heading={t('palette.groupSlash')}
              className='text-muted-foreground mt-2 space-y-1 text-[10px] font-bold uppercase'
            >
              {SLASH_COMMANDS.map((s) => (
                <Item
                  key={`slash-${s.name}`}
                  onSelect={() => {
                    close()
                    // Best-effort: copy command to clipboard so user can
                    // paste into the chat input. We don't have a global
                    // chat-input-fill primitive yet.
                    void navigator.clipboard
                      ?.writeText(`/${s.name} `)
                      .catch(() => {})
                  }}
                  icon={
                    s.name === 'qc-consistency' ? (
                      <WandSparklesIcon className='size-3.5' />
                    ) : (
                      <BotIcon className='size-3.5' />
                    )
                  }
                  label={`/${s.name} ${s.argsHint ?? ''}`.trim()}
                  sub={s.description}
                  shortcut={t('palette.shortcutCopy')}
                />
              ))}
            </Command.Group>
          )}
        </Command.List>
        <div className='border-border text-muted-foreground flex items-center justify-between border-t px-3 py-1.5 text-[10px]'>
          <span>{t('palette.footerHelp')}</span>
          <span>
            <kbd className='bg-muted rounded px-1'>⌘K</kbd>{' '}
            {t('palette.footerToggle')}
          </span>
        </div>
      </Command>
    </div>
  )
}

function Item({
  onSelect,
  icon,
  label,
  sub,
  shortcut,
}: {
  onSelect: () => void
  icon: React.ReactNode
  label: string
  sub?: string
  shortcut?: string
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      className='aria-selected:bg-accent text-foreground flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs transition'
    >
      <span className='text-muted-foreground shrink-0'>{icon}</span>
      <span className='min-w-0 flex-1 truncate'>{label}</span>
      {sub && (
        <span className='text-muted-foreground/70 shrink-0 truncate text-[10px]'>
          {sub}
        </span>
      )}
      {shortcut && (
        <kbd className='bg-muted text-muted-foreground shrink-0 rounded px-1 text-[9px]'>
          {shortcut}
        </kbd>
      )}
    </Command.Item>
  )
}
