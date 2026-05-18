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
  Trash2Icon,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
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
  const ocrSmartCloudFallback = usePreferencesStore((s) => s.ocrSmartCloudFallback)
  const setOcrSmartCloudFallback = usePreferencesStore((s) => s.setOcrSmartCloudFallback)
  const ocrCloudProfileId = usePreferencesStore((s) => s.ocrCloudProfileId)
  const setOcrCloudProfileId = usePreferencesStore(
    (s) => s.setOcrCloudProfileId,
  )
  const detectorEngine = usePreferencesStore((s) => s.detectorEngine)
  const setDetectorEngine = usePreferencesStore((s) => s.setDetectorEngine)
  const animeYoloVariant = usePreferencesStore((s) => s.animeYoloVariant)
  const setAnimeYoloVariant = usePreferencesStore((s) => s.setAnimeYoloVariant)
  const animeYoloConfidence = usePreferencesStore((s) => s.animeYoloConfidence)
  const setAnimeYoloConfidence = usePreferencesStore(
    (s) => s.setAnimeYoloConfidence,
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
    enabled: !!projectInfo && (ocrEngine === 'cloud' || ocrEngine === 'auto'),
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

            {/* Engines Section */}
            <section className='mb-8'>
              <h2 className='text-foreground mb-1 text-sm font-bold'>
                {t('settings.engines', 'Engines')}
              </h2>
              <p className='text-muted-foreground mb-4 text-sm'>
                {t(
                  'settings.enginesDescription',
                  'Pick which ML model handles each pipeline stage. Most stages only have one option today — more will land in future releases.',
                )}
              </p>

              {/* Detector sub-card — engine + variant + hint live together */}
              <div className='bg-card border-border mb-3 rounded-lg border p-4'>
                <h3 className='text-foreground mb-3 text-xs font-semibold uppercase tracking-wide'>
                  {t('settings.engineDetector', 'Detector')}
                </h3>
                <div className='grid grid-cols-[max-content_1fr] items-center gap-x-6 gap-y-3 text-sm'>
                  <label className='text-muted-foreground'>
                    {t('settings.engineDetectorEngine', 'Engine')}
                  </label>
                  <Select
                    value={detectorEngine}
                    onValueChange={(v) =>
                      setDetectorEngine(v as 'default' | 'anime_yolo' | 'auto')
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='default'>
                        Default (comic_text_detector)
                      </SelectItem>
                      <SelectItem value='anime_yolo'>
                        Anime Text YOLO
                      </SelectItem>
                      <SelectItem value='auto'>
                        Auto (Smart Parallel Hybrid)
                      </SelectItem>
                    </SelectContent>
                  </Select>

                  {(detectorEngine === 'anime_yolo' || detectorEngine === 'auto') && (
                    <>
                      <label className='text-muted-foreground'>
                        {t('settings.engineDetectorVariant', 'Variant')}
                      </label>
                      <Select
                        value={animeYoloVariant}
                        onValueChange={(v) =>
                          setAnimeYoloVariant(v as 'n' | 's' | 'm' | 'l' | 'x' | 'auto')
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value='auto'>
                            Auto (Smart Hardware Scaling)
                          </SelectItem>
                          <SelectItem value='n'>
                            N · nano · ~10MB · fastest
                          </SelectItem>
                          <SelectItem value='s'>
                            S · small · ~30MB
                          </SelectItem>
                          <SelectItem value='m'>
                            M · medium · ~80MB
                          </SelectItem>
                          <SelectItem value='l'>
                            L · large · ~150MB
                          </SelectItem>
                          <SelectItem value='x'>
                            X · xlarge · ~250MB · best recall
                          </SelectItem>
                        </SelectContent>
                      </Select>

                      <label className='text-muted-foreground self-start pt-2'>
                        {t('settings.engineDetectorConfidence', 'Confidence')}
                      </label>
                      <div className='flex flex-col gap-2 pt-1.5'>
                        <div className='flex items-center gap-3'>
                          <Slider
                            min={5}
                            max={95}
                            step={5}
                            value={[Math.round(animeYoloConfidence * 100)]}
                            onValueChange={(vals) =>
                              setAnimeYoloConfidence((vals[0] ?? 25) / 100)
                            }
                            className='flex-1'
                          />
                          <span className='text-foreground w-12 text-right font-mono text-xs tabular-nums'>
                            {animeYoloConfidence.toFixed(2)}
                          </span>
                          {Math.abs(animeYoloConfidence - 0.25) > 0.001 && (
                            <button
                              type='button'
                              onClick={() => setAnimeYoloConfidence(0.25)}
                              className='text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline'
                            >
                              {t('settings.reset', 'Reset')}
                            </button>
                          )}
                        </div>
                        <div className='text-muted-foreground/60 flex justify-between text-[10px] uppercase tracking-wide'>
                          <span>{t('settings.confidenceMoreDetections', 'More (noisy)')}</span>
                          <span>{t('settings.confidenceFewerDetections', 'Fewer (strict)')}</span>
                        </div>
                      </div>
                    </>
                  )}
                </div>

                {detectorEngine === 'anime_yolo' && (
                  <p className='text-muted-foreground/70 mt-4 border-t border-border/60 pt-3 text-xs leading-relaxed'>
                    {t(
                      'settings.engineDetectorAnimeYoloHint',
                      'Anime Text YOLO (mayocream/anime-text-yolo, YOLO12) is tuned for anime/manga text and catches SFX, stylised titles, and out-of-bubble text the default detector misses. Bubble mask still comes from the default detector. Switching variant reloads the model on next Process — pick N for speed, X for max recall. Raise Confidence (~0.35–0.45) to cut over-detection on noisy pages; lower it to rescue faint SFX.',
                    )}
                  </p>
                )}

                {detectorEngine === 'auto' && (
                  <p className='text-muted-foreground/70 mt-4 border-t border-border/60 pt-3 text-xs leading-relaxed'>
                    {t(
                      'settings.engineDetectorAutoHint',
                      'Auto Mode runs the default detector and dynamically cascades to Anime Text YOLO for action pages, dense text, or out-of-bubble SFX. Overlapping bboxes are resolved automatically. Variant "Auto" scales dynamically based on resolution and CUDA GPU capacity.',
                    )}
                  </p>
                )}
              </div>

              {/* OCR sub-card */}
              <div className='bg-card border-border rounded-lg border p-4'>
                <h3 className='text-foreground mb-3 text-xs font-semibold uppercase tracking-wide'>
                  {t('settings.engineOcr', 'OCR')}
                </h3>
                <div className='grid grid-cols-[max-content_1fr] items-center gap-x-6 gap-y-3 text-sm'>
                  <label className='text-muted-foreground'>
                    {t('settings.engineOcrEngine', 'Engine')}
                  </label>
                  <Select
                    value={ocrEngine}
                    onValueChange={(v) =>
                      setOcrEngine(v as 'mit48px' | 'manga' | 'cloud' | 'auto')
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='auto'>
                        Auto (Smart Local Hybrid)
                      </SelectItem>
                      <SelectItem value='mit48px'>
                        MIT-48px (default · multilingual, local)
                      </SelectItem>
                      <SelectItem value='manga'>
                        Manga OCR (Japanese-tuned, local, ~100MB first-use download)
                      </SelectItem>
                      <SelectItem value='cloud'>
                        Cloud Vision (uses a saved LLM profile · counts tokens)
                      </SelectItem>
                    </SelectContent>
                  </Select>

                  {ocrEngine === 'auto' && (
                    <>
                      <label className='text-muted-foreground'>
                        {t('settings.engineOcrSmartCloudFallback', 'Smart Cloud Fallback')}
                      </label>
                      <div className='flex items-center gap-2'>
                        <button
                          type='button'
                          role='switch'
                          aria-checked={ocrSmartCloudFallback}
                          onClick={() => setOcrSmartCloudFallback(!ocrSmartCloudFallback)}
                          className={[
                            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            ocrSmartCloudFallback ? 'bg-primary' : 'bg-input',
                          ].join(' ')}
                        >
                          <span
                            className={[
                              'pointer-events-none inline-block size-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
                              ocrSmartCloudFallback ? 'translate-x-4' : 'translate-x-0',
                            ].join(' ')}
                          />
                        </button>
                        <span className='text-muted-foreground/70 text-xs'>
                          {ocrSmartCloudFallback
                            ? t('settings.enabled', 'Enabled')
                            : t('settings.disabled', 'Disabled')}
                        </span>
                      </div>
                    </>
                  )}

                  {ocrEngine === 'cloud' && (
                    <>
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
                    </>
                  )}
                </div>

                <p className='text-muted-foreground/70 mt-4 border-t border-border/60 pt-3 text-xs leading-relaxed'>
                  {ocrEngine === 'auto'
                    ? t(
                        'settings.engineOcrAutoHint',
                        'โหมด Auto จะวิเคราะห์ภาษาของโปรเจกต์โดยอัตโนมัติเพื่อเลือกโมเดลที่ดีที่สุด (เช่น Manga OCR สำหรับภาษาญี่ปุ่น, MIT-48px สำหรับภาษาไทย/อังกฤษ) และสามารถเปิด "Smart Cloud Fallback" เพื่อนำประโยคที่ซับซ้อน/อ่านยาก ส่งให้ Cloud Vision ช่วยประมวลผลเพิ่มความแม่นยำขั้นสูงสุดได้!',
                      )
                    : ocrEngine === 'cloud'
                    ? t(
                        'settings.engineOcrCloudHint',
                        'Cloud Vision OCR sends the page image + bubble coordinates to the selected vision-capable LLM and asks for the text per bubble. Quality is usually best, but every page costs tokens. Use for hard pages; pick a local engine for batch translation in the queue (batch never uses Cloud Vision — it falls back to MIT-48px). Calls are logged to the Cost Dashboard as use_case=ocr.',
                      )
                    : t(
                        'settings.engineOcrHint',
                        'MIT-48px is the production default and handles Latin / CJK / Thai. Manga OCR (mayocream/manga-ocr) is tuned for Japanese handwriting + stylised SFX; first switch downloads ~100MB of weights.',
                      )}
                </p>
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
  const [busy, setBusy] = useState<StorageClearTarget | 'prefs' | 'chat' | null>(null)
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

  const clearChatHistory = async () => {
    if (
      !confirm(
        'Are you sure you want to permanently clear the AI Chat history and reborn the assistant? This will wipe all memory logs for the active project.',
      )
    )
      return
    setBusy('chat')
    setLastResult(null)
    try {
      await api.chatMessagesClear()
      setLastResult('AI Chat memory cleared successfully. Assistant is reborn!')
    } catch (e: any) {
      setLastResult(`Failed to clear AI Chat history: ${e?.message ?? e}`)
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

          {/* AI Chat History clear — lives outside the Rust storage API
              because it clears SQLite DB via local invoke, not app-data. */}
          <div className='border-border/60 flex items-start justify-between gap-3 border-t pt-3'>
            <div className='min-w-0 flex-1'>
              <div className='text-foreground font-medium flex items-center gap-1.5'>
                ความจำแชท AI
                <span className='rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400'>
                  ข้อมูลผู้ใช้
                </span>
              </div>
              <div className='text-muted-foreground/80 mt-0.5 text-xs leading-relaxed'>
                ประวัติการสนทนาและบันทึกความจำของระบบประมวลผลสำหรับโปรเจกต์ที่เปิดอยู่ การล้างความจำส่วนนี้จะช่วยชุบชีวิตผู้ช่วย AI ให้เริ่มต้นใหม่ด้วยสมองที่สะอาดบริสุทธิ์
              </div>
            </div>
            <div className='flex shrink-0 flex-col items-end gap-1'>
              <button
                type='button'
                disabled={busy === 'chat'}
                onClick={clearChatHistory}
                className='text-muted-foreground hover:text-foreground disabled:opacity-40 text-xs underline-offset-2 hover:underline flex items-center gap-1 cursor-pointer'
              >
                <Trash2Icon className='size-3 text-destructive dark:text-red-400' />
                {busy === 'chat' ? 'Reborning…' : 'Clear'}
              </button>
            </div>
          </div>

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
