'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { useProjectStore } from '@/lib/stores/projectStore'

const TABS = [
  { href: '/project', label: 'Overview' },
  { href: '/project/characters', label: 'Characters' },
  { href: '/project/glossary', label: 'Glossary' },
]

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const info = useProjectStore((s) => s.info)

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
                  {tab.label}
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
