'use client'

import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  BookOpenIcon,
  BotIcon,
  FilesIcon,
  FolderIcon,
  ImagesIcon,
  KeyRoundIcon,
  MessageSquareIcon,
  UsersIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Navigator } from '@/components/Navigator'
import { ChaptersTabPanel } from '@/components/sidebar/ChaptersTabPanel'
import { ProjectTabPanel } from '@/components/sidebar/ProjectTabPanel'
import { CharactersTabPanel } from '@/components/sidebar/CharactersTabPanel'
import { GlossaryTabPanel } from '@/components/sidebar/GlossaryTabPanel'
import { PromptsTabPanel } from '@/components/sidebar/PromptsTabPanel'
import { ProfilesTabPanel } from '@/components/sidebar/ProfilesTabPanel'
import { ChatTabPanel } from '@/components/sidebar/ChatTabPanel'
import { useProjectStore, type SidebarTabKey } from '@/lib/stores/projectStore'
import { api } from '@/lib/api'

type TabKey = SidebarTabKey

const TABS: {
  key: TabKey
  icon: React.ComponentType<{ className?: string }>
  labelKey: string
  fallback: string
  needsProject?: boolean
}[] = [
  { key: 'pages', icon: ImagesIcon, labelKey: 'sidebar.tabPages', fallback: 'Pages' },
  {
    key: 'chapters',
    icon: FilesIcon,
    labelKey: 'sidebar.tabChapters',
    fallback: 'Chapters',
    needsProject: true,
  },
  {
    key: 'project',
    icon: FolderIcon,
    labelKey: 'sidebar.tabProject',
    fallback: 'Project',
    needsProject: true,
  },
  {
    key: 'characters',
    icon: UsersIcon,
    labelKey: 'sidebar.tabCharacters',
    fallback: 'Characters',
    needsProject: true,
  },
  {
    key: 'glossary',
    icon: BookOpenIcon,
    labelKey: 'sidebar.tabGlossary',
    fallback: 'Glossary',
    needsProject: true,
  },
  {
    key: 'prompts',
    icon: MessageSquareIcon,
    labelKey: 'sidebar.tabPrompts',
    fallback: 'Prompts',
    needsProject: true,
  },
  {
    key: 'profiles',
    icon: KeyRoundIcon,
    labelKey: 'sidebar.tabProfiles',
    fallback: 'Profiles',
    needsProject: true,
  },
  {
    key: 'chat',
    icon: BotIcon,
    labelKey: 'sidebar.tabChat',
    fallback: 'AI Chat',
    needsProject: true,
  },
]

/**
 * Replaces the previous bare `<Navigator />` left-panel content with
 * a tabbed sidebar that covers the entire project workflow (pages,
 * chapters, series settings, characters, glossary, prompts, profiles)
 * — so there's no need for separate `/project/*` routes.
 */
export function SidebarTabs() {
  const { t } = useTranslation()
  const projectInfo = useProjectStore((s) => s.info)
  const active = useProjectStore((s) => s.sidebarTab)
  const setActive = useProjectStore((s) => s.setSidebarTab)

  // Surface chapter count in the chapters tab badge.
  const chapters = useQuery({
    queryKey: ['project', 'chapters'],
    queryFn: () => api.chaptersList(),
    enabled: !!projectInfo,
    staleTime: 30_000,
  })

  // If the user navigates from a project-only tab into a no-project
  // state, fall back to Pages so they don't see an empty stub.
  if (active !== 'pages' && !projectInfo) {
    setTimeout(() => setActive('pages'), 0)
  }

  return (
    <div className='bg-muted/50 flex h-full min-h-0 w-full flex-row border-r'>
      {/* Vertical icon strip on the left edge.
       *  - flex-col stacks the buttons from the top
       *  - shrink-0 keeps its natural width
       *  - The button list scrolls internally (overflow-y-auto on the
       *    inner div, not on the column itself) so we don't fight the
       *    parent's flex height calculation. */}
      <div className='border-border bg-background/60 flex w-10 shrink-0 flex-col border-r'>
        <div className='flex min-h-0 flex-1 flex-col overflow-y-auto py-1'>
        {TABS.map(({ key, icon: Icon, labelKey, fallback, needsProject }) => {
          const disabled = needsProject && !projectInfo
          const badge =
            key === 'chapters' && chapters.data?.length
              ? chapters.data.length
              : null
          return (
            <button
              key={key}
              onClick={() => !disabled && setActive(key)}
              disabled={disabled}
              data-active={active === key}
              title={t(labelKey, fallback)}
              className={cn(
                'group relative mx-1 my-0.5 flex h-8 items-center justify-center rounded-md transition disabled:cursor-not-allowed disabled:opacity-30',
                active === key
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )}
            >
              <Icon className='size-4' />
              {badge != null && (
                <span className='bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full px-0.5 text-[8px] font-semibold'>
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </button>
          )
        })}
        </div>
      </div>

      {/* Active tab content */}
      <div className='flex min-w-0 min-h-0 flex-1 flex-col'>
        {active === 'pages' && <Navigator />}
        {active === 'chapters' && projectInfo && <ChaptersTabPanel />}
        {active === 'project' && projectInfo && <ProjectTabPanel />}
        {active === 'characters' && projectInfo && <CharactersTabPanel />}
        {active === 'glossary' && projectInfo && <GlossaryTabPanel />}
        {active === 'prompts' && projectInfo && <PromptsTabPanel />}
        {active === 'profiles' && projectInfo && <ProfilesTabPanel />}
        {active === 'chat' && projectInfo && <ChatTabPanel />}
      </div>
    </div>
  )
}
