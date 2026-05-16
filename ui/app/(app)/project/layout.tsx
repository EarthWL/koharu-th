'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { useProjectStore } from '@/lib/stores/projectStore'

const TABS = [
  { href: '/project', i18nKey: 'project.tabs.overview', fallback: 'Overview' },
  { href: '/project/characters', i18nKey: 'project.tabs.characters', fallback: 'Characters' },
  { href: '/project/glossary', i18nKey: 'project.tabs.glossary', fallback: 'Glossary' },
  { href: '/project/prompts', i18nKey: 'project.tabs.prompts', fallback: 'Prompts' },
  { href: '/project/profiles', i18nKey: 'project.tabs.profiles', fallback: 'Profiles' },
]

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const info = useProjectStore((s) => s.info)
  const { t } = useTranslation()

  return (
    <div className='bg-muted flex flex-1 flex-col overflow-hidden'>
      {info && (
        <div className='border-border bg-background border-b'>
          <div className='mx-auto flex max-w-3xl items-center gap-1 px-4'>
            {TABS.map((tab) => {
              const active = pathname === tab.href
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  prefetch={false}
                  className={cn(
                    'border-b-2 px-3 py-2 text-xs font-medium transition',
                    active
                      ? 'border-primary text-foreground'
                      : 'text-muted-foreground hover:text-foreground border-transparent',
                  )}
                >
                  {t(tab.i18nKey, tab.fallback)}
                </Link>
              )
            })}
          </div>
        </div>
      )}
      {children}
    </div>
  )
}
