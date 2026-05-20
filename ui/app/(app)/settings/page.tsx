'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTheme } from 'next-themes'
import { useTranslation } from 'react-i18next'
import Link from 'next/link'
import {
  SunIcon,
  MoonIcon,
  MonitorIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Loader2Icon,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { invoke, isTauri } from '@/lib/backend'
import type { DeviceInfo } from '@/lib/rpc-types'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type StorageClearTarget, type StorageEntry } from '@/lib/api'
import { supportsVision } from '@/lib/services/visionSupport'
import { effectiveDbProvider } from '@/lib/services/profileHelpers'
import { useProjectStore } from '@/lib/stores/projectStore'

const THEME_OPTIONS = [
  { value: 'light', icon: SunIcon, labelKey: 'settings.themeLight' },
  { value: 'dark', icon: MoonIcon, labelKey: 'settings.themeDark' },
  { value: 'system', icon: MonitorIcon, labelKey: 'settings.themeSystem' },
] as const

export default function SettingsPage() {
  const { t, i18n } = useTranslation()
  const { theme, setTheme } = useTheme()
  const locales = useMemo(
    () => Object.keys(i18n.options.resources || {}),
    [i18n.options.resources],
  )
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo>()
  const ocrEngine = usePreferencesStore((s) => s.ocrEngine)
  const setOcrEngine = usePreferencesStore((s) => s.setOcrEngine)
  const ocrCloudProfileId = usePreferencesStore((s) => s.ocrCloudProfileId)
  const setOcrCloudProfileId = usePreferencesStore(
    (s) => s.setOcrCloudProfileId,
  )
  const projectInfo = useProjectStore((s) => s.info)
  const cloudProvider = usePreferencesStore((s) => s.cloudProvider)
  const cloudModelName = usePreferencesStore((s) => s.cloudModelName)
  const cloudApiKey = usePreferencesStore((s) => s.cloudApiKey)
  // Only load the profile list when the user is actually looking at
  // Engines + has cloud OCR selected. List is cheap (one SQL row per
  // profile) but no point churning it otherwise.
  const profiles = useQuery({
    queryKey: ['project', 'profiles'],
    queryFn: () => api.providerProfilesList(),
    enabled: !!projectInfo && ocrEngine === 'cloud',
    staleTime: 30_000,
  })
  // Vision-capability filter for the OCR Cloud Vision profile picker.
  // Uses the shared `effectiveDbProvider()` helper so legacy OpenRouter
  // profiles (stored as provider='openai' before backend commit
  // b3d4c7f3 — slash in modelName is the tell) are routed to the
  // right vision check. Was duplicated inline here + in
  // CanvasToolbar + in cloudOcr; now lives in profileHelpers.ts.
  const visionProfiles = (profiles.data ?? []).filter((p) =>
    supportsVision(effectiveDbProvider(p), p.modelName).supported,
  )
  // Active translation profile counts too — the "(Use the active
  // translation profile)" option in the dropdown uses it. So the
  // "no vision profile" warning is only meaningful if NEITHER a
  // saved profile NOR the live one would work.
  const activeIsVision =
    !!cloudApiKey &&
    !!cloudModelName &&
    cloudProvider !== 'none' &&
    supportsVision(
      // Inline call: we have a synthetic profile shape (no id), so
      // construct the minimal object effectiveDbProvider needs.
      effectiveDbProvider({
        provider: cloudProvider,
        modelName: cloudModelName,
      }),
      cloudModelName,
    ).supported

  useEffect(() => {
    if (!isTauri()) return

    const loadDeviceInfo = async () => {
      try {
        const info = await invoke('device')
        setDeviceInfo(info)
      } catch (error) {
        console.error('Failed to load device info', error)
      }
    }

    void loadDeviceInfo()
  }, [])

  return (
    <div className='bg-muted flex flex-1 flex-col overflow-hidden'>
      <ScrollArea className='min-h-0 min-w-0 flex-1'>
        <div className='px-4 py-6'>
          {/* Content column */}
          <div className='relative mx-auto max-w-xl'>
            {/* Header with back button */}
            <div className='mb-8 flex items-center'>
              <Link
                href='/'
                prefetch={false}
                className='text-muted-foreground hover:bg-accent hover:text-foreground absolute -left-14 flex size-10 items-center justify-center rounded-full transition'
              >
                <ChevronLeftIcon className='size-6' />
              </Link>
              <h1 className='text-foreground text-2xl font-bold'>
                {t('settings.title')}
              </h1>
            </div>

            {/* Appearance Section */}
            <section className='mb-8'>
              <h2 className='text-foreground mb-1 text-sm font-bold'>
                {t('settings.appearance')}
              </h2>
              <p className='text-muted-foreground mb-4 text-sm'>
                {t('settings.appearanceDescription')}
              </p>

              <div className='space-y-3'>
                <div className='text-foreground text-sm'>
                  {t('settings.theme')}
                </div>
                <div className='flex gap-2'>
                  {THEME_OPTIONS.map(({ value, icon: Icon, labelKey }) => (
                    <button
                      key={value}
                      onClick={() => setTheme(value)}
                      data-active={theme === value}
                      className='border-border bg-card text-muted-foreground hover:border-foreground/30 data-[active=true]:border-primary data-[active=true]:text-foreground flex flex-1 flex-col items-center gap-2 rounded-lg border p-3 transition'
                    >
                      <Icon className='size-5' />
                      <span className='text-xs font-medium'>{t(labelKey)}</span>
                    </button>
                  ))}
                </div>
              </div>
            </section>

            {/* Language Section */}
            <section className='mb-8'>
              <h2 className='text-foreground mb-1 text-sm font-bold'>
                {t('settings.language')}
              </h2>
              <p className='text-muted-foreground mb-4 text-sm'>
                {t('settings.languageDescription')}
              </p>

              <Select
                value={i18n.language}
                onValueChange={(value) => i18n.changeLanguage(value)}
              >
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {locales.map((code) => (
                    <SelectItem key={code} value={code}>
                      {t(`menu.languages.${code}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </section>

            {/* Engines Section — engine choice + per-engine settings now
                live in the Engines tab of the project sidebar. Only Cloud
                Vision OCR stays here because it isn't a v2 engine yet. */}
            <section className='mb-8'>
              <h2 className='text-foreground mb-1 text-sm font-bold'>
                {t('settings.engines', 'Engines')}
              </h2>
              <p className='text-muted-foreground mb-4 text-sm'>
                {t(
                  'settings.enginesConfiguredInTab',
                  'Detector, OCR, inpaint and render engines — and all their settings — are configured in the Engines tab of the project sidebar. Cloud Vision OCR is the one exception and is toggled here.',
                )}
              </p>

              {/* Cloud Vision OCR — frontend-orchestrated, not a v2 engine */}
              <div className='bg-card border-border rounded-lg border p-4'>
                <label className='flex cursor-pointer items-start justify-between gap-4 text-sm'>
                  <div className='min-w-0 flex-1'>
                    <div className='text-foreground font-medium'>
                      {t('settings.engineOcrCloud', 'Cloud Vision OCR')}
                    </div>
                    <div className='text-muted-foreground/80 mt-1 text-xs leading-relaxed'>
                      {t(
                        'settings.engineOcrCloudToggleHint',
                        'When on, the standalone OCR button and Process current send each detected bubble to a vision-capable LLM instead of the local OCR engine. Best quality, but every page costs tokens. When off, OCR uses the local engine chosen in the Engines tab. Batch never uses Cloud Vision.',
                      )}
                    </div>
                  </div>
                  <input
                    type='checkbox'
                    checked={ocrEngine === 'cloud'}
                    onChange={(e) =>
                      setOcrEngine(e.target.checked ? 'cloud' : 'mit48px')
                    }
                    className='mt-1 size-4 cursor-pointer accent-primary'
                  />
                </label>

                {ocrEngine === 'cloud' && (
                  <div className='border-border/60 mt-3 grid grid-cols-[max-content_1fr] items-center gap-x-6 gap-y-3 border-t pt-3 text-sm'>
                    <label className='text-muted-foreground'>
                      {t('settings.engineOcrCloudProfile', 'Vision profile')}
                    </label>
                    <Select
                      value={
                        ocrCloudProfileId == null
                          ? 'active'
                          : String(ocrCloudProfileId)
                      }
                      onValueChange={(v) =>
                        setOcrCloudProfileId(v === 'active' ? null : Number(v))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='active'>
                          (Use the active translation profile)
                        </SelectItem>
                        {visionProfiles.map((p) => (
                          <SelectItem key={p.id} value={String(p.id)}>
                            {p.name} · {p.provider} · {p.modelName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {ocrEngine === 'cloud' &&
                  profiles.data &&
                  visionProfiles.length === 0 &&
                  !activeIsVision && (
                    <p className='text-amber-600 dark:text-amber-400 mt-2 text-xs leading-relaxed'>
                      {t(
                        'settings.engineOcrNoVisionProfile',
                        '⚠ No vision-capable profile available. Open the Profiles tab in the project sidebar, add an OpenAI / Claude / Gemini / OpenRouter profile with a vision-capable model (e.g. gpt-4o, claude-3.5-sonnet, gemini-2.0-flash), and click Apply. This page will refresh automatically.',
                      )}
                    </p>
                  )}
              </div>
            </section>

            {/* Device Section */}
            {deviceInfo && (
              <section className='mb-8'>
                <h2 className='text-foreground mb-1 text-sm font-bold'>
                  {t('settings.device')}
                </h2>
                <p className='text-muted-foreground mb-4 text-sm'>
                  {t('settings.deviceDescription')}
                </p>

                <div className='bg-card border-border rounded-lg border p-4'>
                  <div className='space-y-3 text-sm'>
                    <div className='flex items-center justify-between'>
                      <span className='text-muted-foreground'>
                        {t('settings.deviceMl')}
                      </span>
                      <span className='text-foreground font-medium'>
                        {deviceInfo.mlDevice}
                      </span>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* Translation post-processing (Thai) */}
            <ThaiPostProcessSection />

            {/* Storage Section */}
            <StorageSection />

            {/* Divider */}
            <div className='border-border mb-8 border-t' />

            {/* About Link */}
            <Link
              href='/about'
              prefetch={false}
              className='hover:bg-accent flex w-full items-center justify-between rounded-lg px-3 py-3 text-left transition'
            >
              <span className='text-foreground text-sm font-medium'>
                {t('settings.about')}
              </span>
              <ChevronRightIcon className='text-muted-foreground size-5' />
            </Link>
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────
// Thai post-process section (Issue #21)
// ────────────────────────────────────────────────────────────────

function ThaiPostProcessSection() {
  const { t } = useTranslation()
  const enabled = usePreferencesStore((s) => s.thaiPostProcessEnabled)
  const setEnabled = usePreferencesStore((s) => s.setThaiPostProcessEnabled)

  return (
    <section className='mb-8'>
      <h2 className='text-foreground mb-1 text-sm font-bold'>
        {t('settings.thaiPostProcess', 'Thai post-processing')}
      </h2>
      <p className='text-muted-foreground mb-4 text-sm'>
        {t(
          'settings.thaiPostProcessDescription',
          'Cleanup pass applied automatically after every LLM translation.',
        )}
      </p>

      <div className='bg-card border-border rounded-lg border p-4'>
        <label className='flex cursor-pointer items-start justify-between gap-4 text-sm'>
          <div className='min-w-0 flex-1'>
            <div className='text-foreground font-medium'>
              {t('settings.thaiPostProcessEnabled', 'Enable Thai cleanup')}
            </div>
            <div className='text-muted-foreground/80 mt-1 text-xs leading-relaxed'>
              {t(
                'settings.thaiPostProcessDetails',
                'Collapses excess whitespace between Thai characters (e.g. "กิน ข้าว" → "กินข้าว") and converts ASCII quotes to typographic curly quotes ("..." → "..."). Mixed-script content like character names is preserved — "กิน rice" keeps its space.',
              )}
            </div>
          </div>
          <input
            type='checkbox'
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className='mt-1 size-4 cursor-pointer accent-primary'
          />
        </label>
      </div>
    </section>
  )
}

// ────────────────────────────────────────────────────────────────
// Storage Section
// ────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

type RowSpec = {
  target: StorageClearTarget
  label: string
  /** Short description shown under the label. */
  description: string
  /** Set true for targets that delete user-created data — UI shows
   *  amber warning text + uses a stricter confirm. */
  destructive?: boolean
}

const STORAGE_ROWS: RowSpec[] = [
  {
    target: 'libsCuda',
    label: 'CUDA runtime libraries',
    description:
      'Downloaded automatically on first GPU launch. Re-downloaded if cleared.',
  },
  {
    target: 'modelsHf',
    label: 'AI model cache',
    description:
      'Anime YOLO, Manga OCR, comic_text_detector, LaMa, font detector. Re-fetched on first inference.',
  },
  {
    target: 'fontsCustom',
    label: 'Custom fonts',
    description:
      'TTF/OTF files you dropped into the Koharu/fonts folder. Removing loses these fonts.',
    destructive: true,
  },
  {
    target: 'recentProjects',
    label: 'Recent projects list',
    description:
      'The "recently opened" list shown on the home screen. Project folders themselves are untouched.',
  },
]

function StorageSection() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const resetPreferences = usePreferencesStore((s) => s.resetPreferences)
  const stats = useQuery({
    queryKey: ['app', 'storage', 'stats'],
    queryFn: () => api.appStorageStats(),
    enabled: isTauri(),
    staleTime: 5_000,
  })
  const [busy, setBusy] = useState<StorageClearTarget | 'prefs' | null>(null)
  const [lastResult, setLastResult] = useState<string | null>(null)

  const clear = async (target: StorageClearTarget, spec: RowSpec) => {
    const entry = stats.data?.[target]
    const sizeText = entry?.exists
      ? formatBytes(entry.sizeBytes)
      : 'no data on disk'
    const verb = spec.destructive
      ? `permanently delete ${spec.label} (${sizeText})`
      : `clear ${spec.label} (${sizeText})`
    if (!confirm(`Are you sure you want to ${verb}?`)) return
    setBusy(target)
    setLastResult(null)
    try {
      const res = await api.appStorageClear([target])
      const ok = res.cleared.includes(target)
      const err = res.errors.find((e) => e.target === target)
      if (ok) {
        setLastResult(
          `Cleared ${spec.label} — freed ${formatBytes(res.freedBytes)}.`,
        )
      } else if (err) {
        setLastResult(`Failed to clear ${spec.label}: ${err.message}`)
      }
      await queryClient.invalidateQueries({ queryKey: ['app', 'storage'] })
    } catch (e: any) {
      setLastResult(`Failed to clear ${spec.label}: ${e?.message ?? e}`)
    } finally {
      setBusy(null)
    }
  }

  const resetPrefs = () => {
    if (
      !confirm(
        'Reset all preferences to defaults? Cloud API keys, OCR/detector choices, language, theme, and brush settings will revert. Project data is unaffected.',
      )
    )
      return
    setBusy('prefs')
    setLastResult(null)
    try {
      resetPreferences()
      setLastResult('Preferences reset to defaults.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className='mb-8'>
      <h2 className='text-foreground mb-1 text-sm font-bold'>
        {t('settings.storage', 'Storage')}
      </h2>
      <p className='text-muted-foreground mb-4 text-sm'>
        {t(
          'settings.storageDescription',
          "On-disk data koharu manages outside your project folders. Project files (.khr / chapter pages / SQLite) are never touched by anything here.",
        )}
      </p>

      <div className='bg-card border-border rounded-lg border p-4'>
        {stats.isLoading && (
          <div className='text-muted-foreground mb-3 flex items-center gap-1.5 text-xs'>
            <Loader2Icon className='size-3 animate-spin' />
            {t('settings.storageScanning', 'Scanning…')}
          </div>
        )}
        <div className='space-y-3 text-sm'>
          {STORAGE_ROWS.map((spec) => {
            const entry: StorageEntry | undefined = stats.data?.[spec.target]
            const isBusy = busy === spec.target
            return (
              <div
                key={spec.target}
                className='border-border/60 flex items-start justify-between gap-3 border-b pb-3 last:border-b-0 last:pb-0'
              >
                <div className='min-w-0 flex-1'>
                  <div className='text-foreground font-medium'>
                    {spec.label}
                    {spec.destructive && (
                      <span className='ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400'>
                        user data
                      </span>
                    )}
                  </div>
                  <div className='text-muted-foreground/80 mt-0.5 text-xs leading-relaxed'>
                    {spec.description}
                  </div>
                  {entry && (
                    <div className='text-muted-foreground/60 mt-1 font-mono text-[10px] break-all'>
                      {entry.path}
                    </div>
                  )}
                </div>
                <div className='flex shrink-0 flex-col items-end gap-1'>
                  <span className='text-foreground font-mono text-xs tabular-nums'>
                    {entry?.exists
                      ? formatBytes(entry.sizeBytes)
                      : '—'}
                  </span>
                  <button
                    type='button'
                    disabled={!entry?.exists || isBusy}
                    onClick={() => clear(spec.target, spec)}
                    className='text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground text-xs underline-offset-2 hover:underline disabled:no-underline'
                  >
                    {isBusy ? 'Clearing…' : 'Clear'}
                  </button>
                </div>
              </div>
            )
          })}

          {/* Preferences reset — lives outside the Rust storage API
              because it touches browser localStorage, not <app-data>. */}
          <div className='border-border/60 flex items-start justify-between gap-3 border-t pt-3'>
            <div className='min-w-0 flex-1'>
              <div className='text-foreground font-medium'>
                Preferences
                <span className='ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400'>
                  user data
                </span>
              </div>
              <div className='text-muted-foreground/80 mt-0.5 text-xs leading-relaxed'>
                Cloud API keys, OCR / detector choices, theme, language, brush, and other UI prefs. Stored in browser localStorage; project files unaffected.
              </div>
            </div>
            <div className='flex shrink-0 flex-col items-end gap-1'>
              <button
                type='button'
                disabled={busy === 'prefs'}
                onClick={resetPrefs}
                className='text-muted-foreground hover:text-foreground disabled:opacity-40 text-xs underline-offset-2 hover:underline'
              >
                {busy === 'prefs' ? 'Resetting…' : 'Reset to defaults'}
              </button>
            </div>
          </div>
        </div>

        {lastResult && (
          <p className='text-muted-foreground mt-3 border-t border-border/60 pt-3 text-xs'>
            {lastResult}
          </p>
        )}
        {stats.isError && (
          <p className='text-amber-600 dark:text-amber-400 mt-3 text-xs'>
            Could not read storage stats — backend may not be ready yet.
          </p>
        )}
      </div>
    </section>
  )
}
