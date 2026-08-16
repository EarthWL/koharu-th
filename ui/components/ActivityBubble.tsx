'use client'

import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleXIcon, AlertTriangle, Terminal, Clock } from 'lucide-react'
import { useDownloadStore } from '@/lib/downloads'
import { Button } from '@/components/ui/button'
import { type OperationState } from '@/lib/operations'
import { useOperationStore } from '@/lib/stores/operationStore'
import { useUiErrorStore, type DiagnosticErrorPayload } from '@/lib/stores/uiErrorStore'
import { useDocumentMutations } from '@/lib/query/mutations'
import { ErrorDialog } from '@/components/ui/error-dialog'
import { cn } from '@/lib/utils'

type TranslateFunc = ReturnType<typeof useTranslation>['t']

const clampProgress = (value?: number) => {
  if (typeof value !== 'number' || Number.isNaN(value)) return undefined
  return Math.max(0, Math.min(100, Math.round(value)))
}

function BubbleCard({ children }: { children: ReactNode }) {
  return (
    <div className='border-border bg-card/95 rounded-2xl border p-4 shadow-[0_15px_60px_rgba(0,0,0,0.12)] backdrop-blur'>
      {children}
    </div>
  )
}

function ProgressBar({ percent }: { percent?: number }) {
  return (
    <div className='mt-3 flex items-center gap-2'>
      <div className='bg-muted relative h-1.5 flex-1 overflow-hidden rounded-full'>
        {typeof percent === 'number' ? (
          <div
            className='bg-primary h-full rounded-full transition-[width] duration-700 ease-out'
            style={{ width: `${percent}%` }}
          />
        ) : (
          <div className='activity-progress-indeterminate from-primary/40 via-primary to-primary/40 absolute inset-0 w-1/2 rounded-full bg-linear-to-r' />
        )}
      </div>
      {typeof percent === 'number' && (
        <span className='text-muted-foreground w-12 text-right text-[11px] font-semibold tabular-nums'>
          {percent}%
        </span>
      )}
    </div>
  )
}

function DownloadCard({
  filename,
  percent,
  t,
}: {
  filename: string
  percent?: number
  t: TranslateFunc
}) {
  return (
    <BubbleCard>
      <div className='flex items-start gap-3'>
        <div className='activity-bubble-pulse bg-primary mt-1 h-2.5 w-2.5 animate-pulse rounded-full shadow-[0_0_0_6px_hsl(var(--primary)/0.16)]' />
        <div className='flex-1'>
          <div className='text-foreground text-sm font-semibold'>
            {t('download.title')}
          </div>
          <div className='text-muted-foreground truncate text-xs'>
            {filename}
          </div>
          <ProgressBar percent={percent} />
        </div>
      </div>
    </BubbleCard>
  )
}

/** Detect the `[RATE_LIMIT:provider[:seconds]]` marker injected by
 *  cloud LLM clients for HTTP 429 responses. We surface those as
 *  amber soft-warning toasts instead of red panic cards so users
 *  don't think the app crashed. */
function parseRateLimit(
  raw: string,
): { provider: string; retrySec: number | null; body: string } | null {
  // Avoid the `s` flag (dotall) — TS targets pre-ES2018; use
  // `[\s\S]` instead so multi-line bodies still match.
  const m = raw.match(/^\[RATE_LIMIT:([^:\]]+)(?::(\d+))?\]\s*([\s\S]*)$/)
  if (!m) return null
  return {
    provider: m[1],
    retrySec: m[2] ? parseInt(m[2], 10) : null,
    body: m[3],
  }
}

/** Detect the `[NO_QUOTA:provider]` marker — a model the key's tier
 *  has zero quota for (permanent, not transient). Surfaced as an amber
 *  notice nudging the user to switch model rather than a red crash. */
function parseNoQuota(
  raw: string,
): { provider: string; body: string } | null {
  const m = raw.match(/^\[NO_QUOTA:([^\]]+)\]\s*([\s\S]*)$/)
  if (!m) return null
  return { provider: m[1], body: m[2] }
}

function ErrorCard({
  message,
  diagnostic,
  onDismiss,
  onDebugClick,
  t,
}: {
  message: string
  diagnostic?: DiagnosticErrorPayload
  onDismiss: () => void
  onDebugClick?: () => void
  t: TranslateFunc
}) {
  const rateLimit = parseRateLimit(message)
  const noQuota = parseNoQuota(message)
  // Both rate-limit and no-quota render as amber soft notices (Clock
  // icon) — neither is a crash. no_quota just isn't time-based.
  const isSoftNotice = (!!rateLimit || !!noQuota) && !diagnostic
  const isRateLimit = isSoftNotice

  // Use the cleaned-up body so the marker prefix doesn't leak into UI.
  const displayMessage = rateLimit
    ? rateLimit.body
    : noQuota
      ? noQuota.body
      : message

  return (
    <div
      className={cn(
        'relative bg-card/90 rounded-2xl border p-4 backdrop-blur transition-all duration-300 animate-in fade-in slide-in-from-bottom-5',
        isRateLimit
          ? 'border-amber-500/30 bg-linear-to-b from-card/95 to-amber-500/5 shadow-[0_15px_60px_rgba(245,158,11,0.18)]'
          : diagnostic
            ? 'border-red-500/30 bg-linear-to-b from-card/95 to-red-500/5 shadow-[0_15px_60px_rgba(239,68,68,0.2)]'
            : 'border-red-200/80 dark:border-red-950/80 shadow-[0_15px_60px_rgba(239,68,68,0.12)]',
      )}
    >
      {/* Visual top border glow for diagnostic errors */}
      {diagnostic && !isRateLimit && (
        <div className='absolute top-0 left-4 right-4 h-[2px] bg-linear-to-r from-red-500/50 via-rose-500 to-red-500/50 blur-[1px]' />
      )}

      <div className='flex items-start gap-3'>
        <div
          className={cn(
            'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-all duration-300',
            isRateLimit
              ? 'bg-amber-500/10 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400'
              : diagnostic
                ? 'bg-red-500/10 text-red-500 dark:bg-red-950/40 dark:text-red-400 animate-pulse'
                : 'bg-red-100 text-red-600 dark:bg-red-950/70 dark:text-red-400',
          )}
        >
          {isRateLimit ? (
            <Clock className='size-4' />
          ) : diagnostic ? (
            <AlertTriangle className='size-4' />
          ) : (
            <CircleXIcon className='size-4' />
          )}
        </div>
        
        <div className='min-w-0 flex-1'>
          <div className='flex items-start justify-between gap-3'>
            <div className='min-w-0 flex-1'>
              <div className='flex items-center gap-1.5 flex-wrap'>
                <span
                  className={cn(
                    'text-sm font-semibold tracking-wide',
                    isRateLimit
                      ? 'text-amber-600 dark:text-amber-400'
                      : diagnostic
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-red-700 dark:text-red-300',
                  )}
                >
                  {rateLimit
                    ? `โควต้า API หมดชั่วคราว (${rateLimit.provider})`
                    : noQuota
                      ? `โมเดลไม่รองรับบน tier นี้ (${noQuota.provider})`
                      : diagnostic
                        ? 'ตรวจพบข้อผิดพลาดระบบการแปล'
                        : t('errors.title')}
                </span>
                {rateLimit && rateLimit.retrySec !== null && (
                  <span className='bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-400 font-mono text-[9px] font-bold px-1.5 py-0.5 rounded-sm uppercase tracking-wider'>
                    ~{rateLimit.retrySec}s
                  </span>
                )}
                {!isRateLimit && diagnostic && (
                  <span className='bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 font-mono text-[9px] font-bold px-1.5 py-0.5 rounded-sm uppercase tracking-wider'>
                    {diagnostic.code}
                  </span>
                )}
              </div>
              <div
                className={cn(
                  'mt-1.5 border-l-2 pl-3 text-xs leading-relaxed break-words',
                  isRateLimit
                    ? 'border-amber-500/50 text-foreground/90'
                    : diagnostic
                      ? 'border-red-500/50 text-foreground/90 font-medium'
                      : 'border-red-500 text-red-700/90 dark:text-red-200/90',
                )}
              >
                {displayMessage}
              </div>
            </div>
            
            <Button
              variant='ghost'
              size='icon-xs'
              onClick={onDismiss}
              className='text-muted-foreground hover:bg-muted hover:text-foreground shrink-0 rounded-lg'
              aria-label={t('errors.dismiss')}
            >
              <CircleXIcon className='size-3.5' />
            </Button>
          </div>

          {/* Action buttons for diagnostics */}
          {diagnostic && onDebugClick && (
            <div className='mt-3 flex items-center justify-between gap-2 border-t border-red-500/10 pt-3'>
              <span className='font-mono text-[9px] text-muted-foreground truncate max-w-[120px]'>
                Method: {diagnostic.method || 'Unknown'}
              </span>
              <Button
                variant='ghost'
                size='xs'
                onClick={onDebugClick}
                className={cn(
                  'h-7 px-3 text-[11px] font-semibold transition-all duration-200 border border-red-500/20 hover:border-red-500/40 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40 gap-1 rounded-lg shrink-0'
                )}
              >
                <Terminal className='size-3' />
                <span>วิเคราะห์เชิงลึก (Debug)</span>
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function OperationCard({
  operation,
  onCancel,
  t,
}: {
  operation: OperationState
  onCancel: () => void
  t: TranslateFunc
}) {
  const isProcessAll = operation.type === 'process-all'
  const hasProgressNumbers =
    typeof operation.current === 'number' &&
    typeof operation.total === 'number' &&
    operation.total > 0
  const currentValue = hasProgressNumbers ? operation.current : undefined
  const total = hasProgressNumbers ? operation.total : undefined
  const progress = clampProgress(
    total && typeof currentValue === 'number'
      ? (currentValue / total) * 100
      : undefined,
  )
  const displayCurrent =
    total && typeof currentValue === 'number'
      ? Math.min(
          total,
          Math.floor(currentValue) + (currentValue >= total ? 0 : 1),
        )
      : undefined
  const titles: Record<OperationState['type'], string> = {
    'load-khr': t('operations.loadKhr'),
    'save-khr': t('operations.saveKhr'),
    'process-current': t('operations.processCurrent'),
    'process-all': t('operations.processAll'),
    'llm-load': t('operations.loadModel'),
  }
  const stepLabels: Record<string, string> = {
    detect: t('processing.detect'),
    ocr: t('processing.ocr'),
    inpaint: t('mask.inpaint'),
    llmGenerate: t('llm.generate'),
    render: t('processing.render'),
  }

  const stepLabel = operation.step
    ? (stepLabels[operation.step] ?? operation.step)
    : undefined
  const stepText =
    stepLabel && total && typeof displayCurrent === 'number'
      ? t('operations.stepProgress', {
          current: displayCurrent,
          total,
          step: stepLabel,
        })
      : undefined

  const imageText =
    operation.type === 'process-all' &&
    total &&
    typeof displayCurrent === 'number'
      ? t('operations.imageProgress', {
          current: displayCurrent,
          total,
        })
      : undefined

  const subtitleParts =
    operation.type === 'process-all'
      ? [stepLabel]
      : [imageText, stepText ?? stepLabel].filter(Boolean)
  const subtitle =
    subtitleParts.filter(Boolean).join(' \u00b7 ') || t('operations.inProgress')

  return (
    <BubbleCard>
      <div
        data-testid='operation-card'
        data-operation-type={operation.type}
        data-cancel-requested={operation.cancelRequested ? 'true' : 'false'}
        data-current={
          typeof operation.current === 'number' ? String(operation.current) : ''
        }
        data-total={
          typeof operation.total === 'number' ? String(operation.total) : ''
        }
        className='flex items-start gap-3'
      >
        <div className='bg-primary mt-1 h-2.5 w-2.5 rounded-full shadow-[0_0_0_6px_hsl(var(--primary)/0.16)]' />
        <div className='flex-1'>
          <div className='flex items-start justify-between gap-2'>
            <div className='flex flex-col gap-1'>
              <div className='text-foreground text-sm font-semibold'>
                {titles[operation.type] ?? t('operations.title')}
              </div>
              <div className='text-muted-foreground text-xs'>
                {/* `subtitle` already falls back to operations.inProgress
                 * when subtitleParts is empty (see line above) — keeping
                 * the || guard here would just confuse a future reader. */}
                {subtitle}
              </div>
            </div>
            {isProcessAll && total && typeof displayCurrent === 'number' ? (
              <span className='bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[11px] font-medium'>
                {t('operations.imageProgress', {
                  current: displayCurrent,
                  total,
                })}
              </span>
            ) : null}
          </div>
          <ProgressBar percent={progress} />
          {operation.cancellable && (
            <div className='mt-3 flex justify-end'>
              <Button
                data-testid='operation-cancel'
                variant='outline'
                size='sm'
                onClick={onCancel}
                disabled={operation.cancelRequested}
                className='text-xs font-semibold'
              >
                {operation.cancelRequested
                  ? t('operations.cancelling')
                  : t('operations.cancel')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </BubbleCard>
  )
}

export function ActivityBubble() {
  const { t } = useTranslation()
  const operation = useOperationStore((state) => state.operation)
  const error = useUiErrorStore((state) => state.error)
  const clearError = useUiErrorStore((state) => state.clearError)
  const { cancelOperation } = useDocumentMutations()
  const downloads = useDownloadStore((s) => s.downloads)
  const ensureSubscribed = useDownloadStore((s) => s.ensureSubscribed)
  const [debugDialogOpen, setDebugDialogOpen] = useState(false)

  useEffect(() => {
    ensureSubscribed()
  }, [ensureSubscribed])

  useEffect(() => {
    if (!error) {
      setDebugDialogOpen(false)
    }
  }, [error])

  const activeDownloads = Array.from(downloads.values()).filter(
    (d) => d.status === 'started' || d.status === 'downloading',
  )

  if (!error && !operation && activeDownloads.length === 0) return null

  return (
    // role="status" + aria-live="polite" so screen readers announce when a
    // new card appears (operation start, error surfaced, download begun)
    // without interrupting the user. aria-atomic="false" keeps the
    // announcement scoped to the card that actually changed, avoiding a
    // re-read of every sibling card on each progress tick.
    <div
      role='status'
      aria-live='polite'
      aria-atomic='false'
      aria-label={t('operations.title')}
      className='pointer-events-auto fixed right-6 bottom-6 z-100 flex w-80 max-w-[calc(100%-1.5rem)] flex-col gap-3'
    >
      {error && (
        <ErrorCard 
          message={error.diagnostic ? error.diagnostic.msgTh : error.message}
          diagnostic={error.diagnostic}
          onDismiss={clearError} 
          onDebugClick={() => setDebugDialogOpen(true)}
          t={t} 
        />
      )}
      {error && error.diagnostic && (
        <ErrorDialog
          open={debugDialogOpen}
          onOpenChange={(open) => {
            setDebugDialogOpen(open)
            if (!open) {
              clearError()
            }
          }}
          code={error.diagnostic.code}
          msgTh={error.diagnostic.msgTh}
          details={error.diagnostic.details}
          method={error.diagnostic.method}
          stack={error.diagnostic.stack}
          platform={error.diagnostic.platform}
          appState={error.diagnostic.appState}
        />
      )}
      {operation && (
        <OperationCard operation={operation} onCancel={cancelOperation} t={t} />
      )}
      {activeDownloads.map((d) => (
        <DownloadCard
          key={d.filename}
          filename={d.filename}
          percent={d.percent}
          t={t}
        />
      ))}
    </div>
  )
}
