'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Command } from 'cmdk'
import {
  ArchiveIcon,
  BotIcon,
  FilesIcon,
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
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import { useProjectMutations } from '@/lib/query/projectMutations'
import { SLASH_COMMANDS } from '@/lib/services/chatSlashCommands'

/**
 * Global Cmd+K / Ctrl+K command palette. Surfaces frequent actions
 * without hunting through sidebar tabs: jump to chapter, switch LLM
 * profile, project lifecycle, settings, AI chat slash commands.
 */
export function CommandPalette() {
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
      await api.chapterOpen(c.id)
      setActiveChapterId(c.id)
      await queryClient.invalidateQueries({ queryKey: ['documents'] })
      router.push('/')
    } catch (err: any) {
      alert(err?.message ?? String(err))
    }
  }

  const applyProfile = async (p: ProviderProfileDto) => {
    close()
    setPrefs.setCloudProvider(p.provider as any)
    setPrefs.setCloudModelName(p.modelName)
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
        alert(`Exported ${r.pageCount} page(s) → ${r.path}`)
      }
    } catch (err: any) {
      alert(err?.message ?? String(err))
    }
  }

  if (!open) return null

  return (
    <div
      className='bg-background/80 fixed inset-0 z-[60] flex items-start justify-center pt-[20vh] backdrop-blur-sm'
      onClick={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <Command
        label='Command palette'
        className='bg-card border-border w-[42rem] max-w-[92vw] overflow-hidden rounded-lg border shadow-2xl'
      >
        <Command.Input
          autoFocus
          placeholder={
            projectInfo
              ? 'Jump to chapter · switch profile · /slash · or type any action…'
              : 'Open or create a project to access more actions…'
          }
          className='bg-transparent text-foreground border-border w-full border-b px-4 py-3 text-sm outline-none'
        />
        <Command.List className='max-h-[60vh] overflow-y-auto p-2'>
          <Command.Empty className='text-muted-foreground p-3 text-center text-xs'>
            No matching action.
          </Command.Empty>

          {/* Project lifecycle */}
          <Command.Group
            heading='Project'
            className='text-muted-foreground space-y-1 text-[10px] font-bold uppercase'
          >
            <Item
              onSelect={() => {
                close()
                const name = window.prompt('Project name?')
                if (!name?.trim()) return
                void createPicker(name.trim()).then((info) => {
                  if (info) router.push('/')
                })
              }}
              icon={<FolderPlusIcon className='size-3.5' />}
              label='New project…'
              shortcut='picker'
            />
            <Item
              onSelect={() => {
                close()
                void openPicker().then((info) => {
                  if (info) router.push('/')
                })
              }}
              icon={<FolderOpenIcon className='size-3.5' />}
              label='Open project…'
            />
            {projectInfo && (
              <Item
                onSelect={() => {
                  close()
                  void closeProject()
                }}
                icon={<LogOutIcon className='size-3.5' />}
                label='Close current project'
              />
            )}
            <Item
              onSelect={() => {
                close()
                router.push('/settings')
              }}
              icon={<SettingsIcon className='size-3.5' />}
              label='Open Settings'
              shortcut='⌘,'
            />
          </Command.Group>

          {/* Chapters */}
          {projectInfo && (chapters.data?.length ?? 0) > 0 && (
            <Command.Group
              heading='Open chapter'
              className='text-muted-foreground mt-2 space-y-1 text-[10px] font-bold uppercase'
            >
              {chapters.data!.map((c) => (
                <Item
                  key={`open-${c.id}`}
                  onSelect={() => void openChapter(c)}
                  icon={<PlayIcon className='size-3.5' />}
                  label={`#${c.chapterNumber} ${c.title ?? '(untitled)'}`}
                  sub={`${c.pageCount} page${c.pageCount === 1 ? '' : 's'} · ${c.status}`}
                />
              ))}
            </Command.Group>
          )}

          {/* Export */}
          {projectInfo && (chapters.data?.length ?? 0) > 0 && (
            <Command.Group
              heading='Export as CBZ'
              className='text-muted-foreground mt-2 space-y-1 text-[10px] font-bold uppercase'
            >
              {chapters.data!.map((c) => (
                <Item
                  key={`cbz-${c.id}`}
                  onSelect={() => void exportCbz(c)}
                  icon={<ArchiveIcon className='size-3.5' />}
                  label={`Export #${c.chapterNumber} as .cbz`}
                  sub={c.title ?? '(untitled)'}
                />
              ))}
            </Command.Group>
          )}

          {/* Profiles */}
          {projectInfo && (profiles.data?.length ?? 0) > 0 && (
            <Command.Group
              heading='Apply LLM profile'
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
                  sub={`${p.provider} · ${p.modelName || '(no model)'}`}
                />
              ))}
            </Command.Group>
          )}

          {/* AI Chat slash commands */}
          {projectInfo && (
            <Command.Group
              heading='AI Chat slash command'
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
                  shortcut='copy'
                />
              ))}
            </Command.Group>
          )}
        </Command.List>
        <div className='border-border text-muted-foreground flex items-center justify-between border-t px-3 py-1.5 text-[10px]'>
          <span>↑↓ navigate · ↵ select · esc close</span>
          <span>
            <kbd className='bg-muted rounded px-1'>⌘K</kbd> toggle
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
