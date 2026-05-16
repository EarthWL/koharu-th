'use client'

import type { ComponentType } from 'react'

/**
 * Friendly empty-state card for project tabs. Surfaces a one-liner
 * explanation, optional numbered steps, and an optional primary CTA
 * — so a first-time user knows what the tab is for and what to do
 * next.
 */
export function EmptyHint({
  icon: Icon,
  title,
  description,
  steps,
  cta,
}: {
  icon?: ComponentType<{ className?: string }>
  title: string
  description: string
  steps?: string[]
  cta?: React.ReactNode
}) {
  return (
    <div className='border-border bg-card/50 rounded-lg border border-dashed p-6 text-center'>
      {Icon && (
        <div className='mb-3 flex justify-center'>
          <Icon className='text-muted-foreground/60 size-8' />
        </div>
      )}
      <h3 className='text-foreground text-sm font-semibold'>{title}</h3>
      <p className='text-muted-foreground mx-auto mt-1 max-w-md text-xs'>
        {description}
      </p>
      {steps && steps.length > 0 && (
        <ol className='text-muted-foreground mx-auto mt-3 max-w-md space-y-1 text-left text-xs'>
          {steps.map((s, i) => (
            <li key={i} className='flex gap-2'>
              <span className='text-foreground font-semibold'>{i + 1}.</span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
      )}
      {cta && <div className='mt-4 flex justify-center'>{cta}</div>}
    </div>
  )
}
