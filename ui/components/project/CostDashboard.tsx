'use client'

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
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
  emptyLabel,
}: {
  rows: { key: string; label: string; value: number; sub?: string }[]
  emptyLabel: string
}) {
  if (rows.length === 0) {
    return (
      <p className='text-muted-foreground text-center text-[10px]'>
        {emptyLabel}
      </p>
    )
  }
  // When every row's value is 0 (typically: user hasn't set per-1M
  // cost rates on their profiles yet, so estimated_cost_usd is 0 for
  // every call), still render the rows with labels + counts so the
  // user can SEE breakdown by profile / chapter / use case. Bars just
  // collapse to 0% width. Avoids the misleading "No data yet" state
  // when there's clearly data — just no cost figure.
  const max = Math.max(0, ...rows.map((r) => r.value))
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
              style={{ width: max > 0 ? `${(r.value / max) * 100}%` : '0%' }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

export function CostDashboard() {
  const { t } = useTranslation()
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
  const tokSuffix = t('costDashboard.tokensSuffix')

  const dayRows = useMemo(
    () =>
      (data?.byDay ?? []).map((d) => ({
        key: d.day,
        label: d.day.slice(5), // MM-DD — universally readable, no locale parse risk
        value: d.totalCostUsd,
        sub: t('costDashboard.callsCount', { count: d.totalCalls }),
      })),
    [data?.byDay, t],
  )
  const profileRows = useMemo(
    () =>
      (data?.byProfile ?? []).map((p) => ({
        key: String(p.profileId),
        label: `${p.profileName}`,
        value: p.totalCostUsd,
        sub: `${p.provider} · ${t('costDashboard.callsCount', {
          count: p.totalCalls,
        })}`,
      })),
    [data?.byProfile, t],
  )
  const chapterRows = useMemo(
    () =>
      (data?.byChapter ?? []).map((c) => ({
        key: String(c.chapterId),
        label: `#${c.chapterNumber} ${
          c.chapterTitle || t('costDashboard.untitledChapter')
        }`,
        value: c.totalCostUsd,
        sub: `${fmtTokens(c.totalPromptTokens + c.totalCompletionTokens)} ${tokSuffix}`,
      })),
    [data?.byChapter, t, tokSuffix],
  )
  const useCaseRows = useMemo(
    () =>
      (data?.byUseCase ?? []).map((u) => ({
        key: u.useCase,
        // useCase comes from the backend as a stable identifier
        // (ocr / translation / chat / …) — surfaced verbatim to keep
        // it greppable in logs and discoverable for users debugging
        // unexpected costs.
        label: u.useCase,
        value: u.totalCostUsd,
        sub: t('costDashboard.callsCount', { count: u.totalCalls }),
      })),
    [data?.byUseCase, t],
  )

  const loading = stats.isLoading || breakdown.isLoading
  const hasData = (stats.data?.totalCalls ?? 0) > 0
  const emptyLabel = t('costDashboard.noData')

  return (
    <div className='space-y-3 text-xs'>
      <div className='border-border bg-card rounded-md border p-3'>
        <div className='text-muted-foreground mb-1 flex items-center gap-1 text-[10px] font-bold tracking-wide uppercase'>
          <CoinsIcon className='size-3' />
          {t('costDashboard.title')}
          {loading && (
            <Loader2Icon
              className='ml-auto size-3 animate-spin'
              aria-label={t('costDashboard.loadingAria')}
            />
          )}
        </div>
        {!hasData ? (
          <p className='text-muted-foreground text-center text-[10px]'>
            {t('costDashboard.empty')}
          </p>
        ) : (
          <div className='grid grid-cols-3 gap-2 text-center'>
            <Stat
              label={t('costDashboard.statTotal')}
              value={fmtUsd(totalCost)}
            />
            <Stat
              label={t('costDashboard.statCalls')}
              value={String(stats.data?.totalCalls ?? 0)}
              sub={t('costDashboard.statCallsOk', {
                percent: fmtPct(
                  stats.data?.successfulCalls ?? 0,
                  stats.data?.totalCalls ?? 0,
                ),
              })}
            />
            <Stat
              label={t('costDashboard.statTokens')}
              value={fmtTokens(
                (stats.data?.totalPromptTokens ?? 0) +
                  (stats.data?.totalCompletionTokens ?? 0),
              )}
              sub={t('costDashboard.statTokensIo', {
                input: fmtTokens(stats.data?.totalPromptTokens ?? 0),
                output: fmtTokens(stats.data?.totalCompletionTokens ?? 0),
              })}
            />
          </div>
        )}
      </div>

      {hasData && (
        <>
          <Section title={t('costDashboard.sectionLast30')}>
            <BarChart rows={dayRows} emptyLabel={emptyLabel} />
          </Section>
          <Section title={t('costDashboard.sectionByProfile')}>
            <BarChart rows={profileRows} emptyLabel={emptyLabel} />
          </Section>
          <Section title={t('costDashboard.sectionByChapter')}>
            <BarChart rows={chapterRows} emptyLabel={emptyLabel} />
          </Section>
          <Section title={t('costDashboard.sectionByUseCase')}>
            <BarChart rows={useCaseRows} emptyLabel={emptyLabel} />
          </Section>
          <p className='text-muted-foreground/70 text-center text-[10px]'>
            {t('costDashboard.footnote')}
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
