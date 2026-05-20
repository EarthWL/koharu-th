'use client'

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  CheckCircle2Icon,
  CircleSlash2Icon,
  CpuIcon,
  Loader2Icon,
  MicrochipIcon,
  RefreshCwIcon,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import {
  api,
  type ArtifactKind,
  type DetectedHardware,
  type EngineInfoView,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { EngineSettingsForm } from '@/components/sidebar/EngineSettingsForm'
import { useEngineProfile } from '@/lib/hooks/useEngineProfile'

/// Phase 4.7 sidebar tab — read-only list of registered engines +
/// detected hardware summary. Phase 4.7b/c will add settings forms
/// + active-engine save + compatibility chips per engine.
export function EnginesTabPanel() {
  const { t } = useTranslation()

  const engines = useQuery({
    queryKey: ['engines', 'list'],
    queryFn: () => api.enginesList(),
    staleTime: 60_000,
  })

  const hardware = useQuery({
    queryKey: ['engines', 'hardware'],
    queryFn: () => api.hardwareDetected(),
    staleTime: 60_000,
  })

  // Group engines by what they produce — same artifact group =
  // mutually-exclusive choice in the Profile UI (Phase 4.7c).
  const groups = useMemo(
    () => groupEnginesByProduces(engines.data ?? []),
    [engines.data],
  )

  const reprobe = () => {
    hardware.refetch()
    engines.refetch()
  }

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <div className='flex items-center justify-between border-b px-3 py-2'>
        <div className='flex items-center gap-2 text-sm font-medium'>
          <MicrochipIcon className='size-4' />
          {t('engines.title', 'Engines')}
        </div>
        <Button
          size='sm'
          variant='ghost'
          onClick={reprobe}
          disabled={engines.isFetching || hardware.isFetching}
          title={t('engines.reprobe', 'Re-probe hardware')}
        >
          {hardware.isFetching ? (
            <Loader2Icon className='size-3.5 animate-spin' />
          ) : (
            <RefreshCwIcon className='size-3.5' />
          )}
        </Button>
      </div>

      <ScrollArea className='min-h-0 min-w-0 flex-1'>
        <div className='space-y-4 p-3'>
          <HardwareSummary hardware={hardware.data} loading={hardware.isLoading} />

          {engines.isLoading && (
            <div className='text-muted-foreground flex items-center gap-2 text-sm'>
              <Loader2Icon className='size-3.5 animate-spin' />
              {t('engines.loading', 'Loading engines…')}
            </div>
          )}

          {engines.error && (
            <div className='text-destructive text-sm'>
              {t('engines.loadError', 'Failed to load engine list')}
              <pre className='text-muted-foreground mt-1 text-xs'>
                {String(engines.error)}
              </pre>
            </div>
          )}

          {groups.length === 0 && !engines.isLoading && (
            <div className='text-muted-foreground text-sm'>
              {t(
                'engines.empty',
                'No engines registered. (Phase 4.7 — coming online with Phase 4 commits.)',
              )}
            </div>
          )}

          {groups.map(([artifact, list]) => (
            <EngineGroup
              key={artifact}
              artifact={artifact}
              engines={list}
              hardware={hardware.data ?? null}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function HardwareSummary({
  hardware,
  loading,
}: {
  hardware: DetectedHardware | undefined
  loading: boolean
}) {
  const { t } = useTranslation()
  if (loading) {
    return (
      <div className='text-muted-foreground flex items-center gap-2 text-xs'>
        <Loader2Icon className='size-3 animate-spin' />
        {t('engines.probing', 'Probing hardware…')}
      </div>
    )
  }
  if (!hardware) return null

  const backends: string[] = []
  if (hardware.cudaAvailable) backends.push('CUDA')
  if (hardware.metalAvailable) backends.push('Metal')
  if (hardware.vulkanAvailable) backends.push('Vulkan')

  return (
    <div className='bg-muted/30 space-y-1 rounded border p-2 text-xs'>
      <div className='flex items-center gap-1.5 font-medium'>
        <CpuIcon className='size-3.5' />
        {hardware.gpuName ?? t('engines.unknownGpu', 'Unknown GPU')}
      </div>
      <div className='text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5'>
        {hardware.vramMb != null && (
          <span>VRAM {Math.round(hardware.vramMb / 1024)} GB</span>
        )}
        {hardware.computeCap != null && (
          <span>Compute cap {hardware.computeCap.toFixed(1)}</span>
        )}
        {backends.length > 0 && (
          <span>{backends.join(' / ')}</span>
        )}
        {backends.length === 0 && (
          <span className='text-amber-600 dark:text-amber-400'>
            {t('engines.cpuOnly', 'CPU only')}
          </span>
        )}
      </div>
    </div>
  )
}

const ARTIFACT_LABELS: Partial<Record<ArtifactKind, string>> = {
  detection_boxes: 'Detection',
  segmentation_mask: 'Segmentation',
  ocr_text: 'OCR',
  inpainted_image: 'Inpaint',
  translation: 'Translate',
  rendered_image: 'Render',
  font_prediction: 'Font detect',
  layout_analysis: 'Layout',
  source_image: 'Source',
  brush_layer: 'Brush',
}

function EngineGroup({
  artifact,
  engines,
  hardware,
}: {
  artifact: ArtifactKind
  engines: EngineInfoView[]
  hardware: DetectedHardware | null
}) {
  const { t } = useTranslation()
  const { activeEngine, setActiveEngine } = useEngineProfile()
  const active = activeEngine(artifact)

  // Single-engine groups don't need radios — no choice to make.
  const showActiveRadios = engines.length > 1
  // Resolve "default" pick when no profile override exists: the
  // first engine in the list (stable insertion order from
  // `groupEnginesByProduces`). Matches what the bridge does as a
  // fallback today.
  const effectiveActive = active ?? engines[0]?.id
  const usingImplicitDefault = active === undefined && showActiveRadios

  return (
    <div className='space-y-1.5'>
      <div className='flex items-baseline justify-between gap-2'>
        <div className='text-muted-foreground text-[10px] font-semibold uppercase tracking-wide'>
          {ARTIFACT_LABELS[artifact] ?? artifact}
        </div>
        {usingImplicitDefault && (
          <div
            className='text-muted-foreground text-[9px] italic'
            title={t(
              'engines.implicitDefaultTooltip',
              'No profile override saved — using the first registered engine as the default',
            )}
          >
            {t('engines.implicitDefault', 'using default')}
          </div>
        )}
      </div>
      <div className='space-y-1'>
        {engines.map((e) => (
          <EngineCard
            key={e.id}
            engine={e}
            hardware={hardware}
            isActive={e.id === effectiveActive}
            isImplicitDefault={usingImplicitDefault && e.id === effectiveActive}
            showActiveSelector={showActiveRadios}
            onSelectActive={() => setActiveEngine(artifact, e.id)}
          />
        ))}
      </div>
    </div>
  )
}

function EngineCard({
  engine,
  hardware,
  isActive,
  isImplicitDefault,
  showActiveSelector,
  onSelectActive,
}: {
  engine: EngineInfoView
  hardware: DetectedHardware | null
  isActive: boolean
  isImplicitDefault: boolean
  showActiveSelector: boolean
  onSelectActive: () => void
}) {
  const { t } = useTranslation()
  const fit = checkFit(engine, hardware)
  return (
    <div
      className={cn(
        'space-y-1 rounded border px-2.5 py-2 text-xs transition-colors',
        isActive && showActiveSelector
          ? 'border-primary/60 bg-primary/5'
          : 'hover:bg-accent/30',
      )}
    >
      <div className='flex items-center justify-between gap-2'>
        <div className='flex items-center gap-1.5 font-medium'>
          {showActiveSelector && (
            <button
              type='button'
              onClick={onSelectActive}
              aria-label={isActive ? 'Active engine' : 'Make active'}
              className={cn(
                'size-3 rounded-full border transition-colors',
                isActive
                  ? 'border-primary bg-primary'
                  : isImplicitDefault
                    ? 'border-primary/60 bg-primary/40 hover:bg-primary/60'
                    : 'border-muted-foreground/40 hover:border-foreground',
              )}
              title={
                isImplicitDefault
                  ? t(
                      'engines.implicitDefaultRadioTooltip',
                      'Implicit default — click to lock this choice into your profile',
                    )
                  : undefined
              }
            />
          )}
          {engine.displayName}
        </div>
        <FitChip fit={fit} />
      </div>
      <div className='text-muted-foreground leading-snug'>
        {engine.description}
      </div>
      <div className='text-muted-foreground flex flex-wrap gap-x-2 gap-y-0.5 text-[10px]'>
        <span>id: {engine.id}</span>
        {engine.cost.local ? (
          <span>Local</span>
        ) : engine.cost.perCallUsd != null ? (
          <span>${engine.cost.perCallUsd.toFixed(4)}/call</span>
        ) : null}
        {engine.hardware.weightsSizeMb > 0 && (
          <span>~{engine.hardware.weightsSizeMb}MB weights</span>
        )}
      </div>
      <EngineSettingsForm
        engineId={engine.id}
        schema={engine.settingsSchema}
      />
    </div>
  )
}

type Fit = 'fits' | 'cpu-fallback' | 'no-backend' | 'unknown'

function checkFit(engine: EngineInfoView, hw: DetectedHardware | null): Fit {
  if (!hw) return 'unknown'
  const { backends } = engine.hardware
  const anyGpuDeclared = backends.cuda || backends.metal || backends.vulkan
  const gpuMatched =
    (backends.cuda && hw.cudaAvailable) ||
    (backends.metal && hw.metalAvailable) ||
    (backends.vulkan && hw.vulkanAvailable)
  if (gpuMatched) return 'fits'
  if (anyGpuDeclared && backends.cpuFallback) return 'cpu-fallback'
  if (!anyGpuDeclared && backends.cpuFallback) return 'fits'
  return 'no-backend'
}

function FitChip({ fit }: { fit: Fit }) {
  const { t } = useTranslation()
  const styles: Record<Fit, string> = {
    fits: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    'cpu-fallback': 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    'no-backend': 'bg-red-500/15 text-red-700 dark:text-red-300',
    unknown: 'bg-muted text-muted-foreground',
  }
  const labels: Record<Fit, string> = {
    fits: t('engines.fits', 'Fits'),
    'cpu-fallback': t('engines.cpuFallback', 'CPU fallback'),
    'no-backend': t('engines.noBackend', 'No backend'),
    unknown: t('engines.unknown', 'Probing…'),
  }
  const Icon = fit === 'fits' ? CheckCircle2Icon : CircleSlash2Icon
  return (
    <span
      className={cn(
        'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
        styles[fit],
      )}
    >
      <Icon className='size-3' />
      {labels[fit]}
    </span>
  )
}

/// Group engines by what they produce so the UI shows mutually-
/// exclusive choices together (e.g. mit48px_ocr + manga_ocr under
/// "OCR"). An engine that produces multiple artifacts appears in
/// each group it contributes to.
function groupEnginesByProduces(
  engines: EngineInfoView[],
): [ArtifactKind, EngineInfoView[]][] {
  const map = new Map<ArtifactKind, EngineInfoView[]>()
  for (const e of engines) {
    for (const a of e.produces) {
      if (!map.has(a)) map.set(a, [])
      map.get(a)!.push(e)
    }
  }
  // Stable order: walk our known artifact list so the UI doesn't
  // jitter on each refetch.
  const ORDER: ArtifactKind[] = [
    'detection_boxes',
    'segmentation_mask',
    'ocr_text',
    'inpainted_image',
    'translation',
    'rendered_image',
    'font_prediction',
    'layout_analysis',
    'brush_layer',
    'source_image',
  ]
  return ORDER.filter((a) => map.has(a)).map((a) => [a, map.get(a)!])
}
