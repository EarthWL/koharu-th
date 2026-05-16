'use client'

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CoinsIcon, Loader2Icon } from 'lucide-react'
import { api, type LlmCostBreakdown } from '@/lib/api'

function fmtUsd(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return '<$0.01'
  if (n < 1) return `$${n.toFixed(3)}`
  if (n < 100) return `$${n.toFixed(2)}`
  return `$${n.toFixed(0)}`
}

function fmtTokens(n: number): string {
  if (n === 0) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function fmtPct(part: number, total: number): string {
  if (total === 0) return '0%'
  return `${Math.round((part / total) * 100)}%`
}

/** A horizontal bar chart for a single dimension. Uses CSS only — no
 *  chart library — to keep bundle small. */
function BarChart({
  rows,
}: {
  rows: { key: string; label: string; value: number; sub?: string }[]
}) {
  const max = Math.max(0, ...rows.map((r) => r.value))
  if (max === 0 || rows.length === 0) {
    return (
      <p className='text-muted-foreground text-center text-[10px]'>
        No data yet
      </p>
    )
  }
  return (
    <div className='space-y-1'>
      {rows.map((r) => (
        <div key={r.key} className='text-[10px]'>
          <div className='mb-0.5 flex items-baseline justify-between gap-2'>
            <span className='text-foreground min-w-0 truncate font-medium'>
              {r.label}
            </span>
            <span className='text-muted-foreground shrink-0 font-mono'>
              {fmtUsd(r.value)}
              {r.sub && (
                <span className='text-muted-foreground/70 ml-1'>· {r.sub}</span>
              )}
            </span>
          </div>
          <div className='bg-muted h-1.5 overflow-hidden rounded'>
            <div
              className='bg-primary h-full transition-all'
              style={{ width: `${(r.value / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

export function CostDashboard() {
  const stats = useQuery({
    queryKey: ['project', 'cost-stats'],
    queryFn: () => api.llmCostStats(),
    staleTime: 60_000,
  })
  const breakdown = useQuery({
    queryKey: ['project', 'cost-breakdown'],
    queryFn: () => api.llmCostBreakdown(),
    staleTime: 60_000,
  })

  const data: LlmCostBreakdown | undefined = breakdown.data
  const totalCost = stats.data?.totalCostUsd ?? 0

  const dayRows = useMemo(
    () =>
      (data?.byDay ?? []).map((d) => ({
        key: d.day,
        label: d.day.slice(5), // MM-DD
        value: d.totalCostUsd,
        sub: `${d.totalCalls} call${d.totalCalls === 1 ? '' : 's'}`,
      })),
    [data?.byDay],
  )
  const profileRows = useMemo(
    () =>
      (data?.byProfile ?? []).map((p) => ({
        key: String(p.profileId),
        label: `${p.profileName}`,
        value: p.totalCostUsd,
        sub: `${p.provider} · ${p.totalCalls} call${
          p.totalCalls === 1 ? '' : 's'
        }`,
      })),
    [data?.byProfile],
  )
  const chapterRows = useMemo(
    () =>
      (data?.byChapter ?? []).map((c) => ({
        key: String(c.chapterId),
        label: `#${c.chapterNumber} ${c.chapterTitle || '(untitled)'}`,
        value: c.totalCostUsd,
        sub: `${fmtTokens(c.totalPromptTokens + c.totalCompletionTokens)} tok`,
      })),
    [data?.byChapter],
  )
  const useCaseRows = useMemo(
    () =>
      (data?.byUseCase ?? []).map((u) => ({
        key: u.useCase,
        label: u.useCase,
        value: u.totalCostUsd,
        sub: `${u.totalCalls} call${u.totalCalls === 1 ? '' : 's'}`,
      })),
    [data?.byUseCase],
  )

  const loading = stats.isLoading || breakdown.isLoading
  const hasData = (stats.data?.totalCalls ?? 0) > 0

  return (
    <div className='space-y-3 text-xs'>
      <div className='border-border bg-card rounded-md border p-3'>
        <div className='text-muted-foreground mb-1 flex items-center gap-1 text-[10px] font-bold tracking-wide uppercase'>
          <CoinsIcon className='size-3' />
          LLM cost — all-time
          {loading && <Loader2Icon className='ml-auto size-3 animate-spin' />}
        </div>
        {!hasData ? (
          <p className='text-muted-foreground text-center text-[10px]'>
            No LLM calls logged yet for this project.
          </p>
        ) : (
          <div className='grid grid-cols-3 gap-2 text-center'>
            <Stat label='Total spent' value={fmtUsd(totalCost)} />
            <Stat
              label='Calls'
              value={String(stats.data?.totalCalls ?? 0)}
              sub={`${fmtPct(
                stats.data?.successfulCalls ?? 0,
                stats.data?.totalCalls ?? 0,
              )} ok`}
            />
            <Stat
              label='Tokens'
              value={fmtTokens(
                (stats.data?.totalPromptTokens ?? 0) +
                  (stats.data?.totalCompletionTokens ?? 0),
              )}
              sub={`${fmtTokens(stats.data?.totalPromptTokens ?? 0)} in / ${fmtTokens(stats.data?.totalCompletionTokens ?? 0)} out`}
            />
          </div>
        )}
      </div>

      {hasData && (
        <>
          <Section title='Last 30 days'>
            <BarChart rows={dayRows} />
          </Section>
          <Section title='By profile'>
            <BarChart rows={profileRows} />
          </Section>
          <Section title='By chapter'>
            <BarChart rows={chapterRows} />
          </Section>
          <Section title='By use case'>
            <BarChart rows={useCaseRows} />
          </Section>
          <p className='text-muted-foreground/70 text-center text-[10px]'>
            Token counts depend on what each provider reports. Cost uses the
            per-1M rates saved on each profile — set them in Profiles tab for
            accurate $ figures.
          </p>
        </>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string
  value: string
  sub?: string
}) {
  return (
    <div>
      <div className='text-foreground text-sm font-bold'>{value}</div>
      <div className='text-muted-foreground text-[10px]'>{label}</div>
      {sub && (
        <div className='text-muted-foreground/70 text-[9px]'>{sub}</div>
      )}
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className='border-border bg-card rounded-md border p-2'>
      <div className='text-muted-foreground mb-1.5 text-[10px] font-bold tracking-wide uppercase'>
        {title}
      </div>
      {children}
    </div>
  )
}
