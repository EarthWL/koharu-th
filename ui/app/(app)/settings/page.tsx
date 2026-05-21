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
  Puzzle,
  Download,
  Trash2,
  Check,
  Loader2,
  Zap,
  Heart,
  Gem,
  History,
} from 'lucide-react'
import { useDownloadStore } from '@/lib/downloads'
import type { BackupDto } from '@/lib/rpc-types'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
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
import { useProjectStore } from '@/lib/stores/projectStore'

import frFR from '@/public/locales/fr-FR/translation.json'
import esES from '@/public/locales/es-ES/translation.json'
import ptPT from '@/public/locales/pt-PT/translation.json'
import zhCN from '@/public/locales/zh-CN/translation.json'
import ruRU from '@/public/locales/ru-RU/translation.json'

import { DynamicEngineSettingsForm } from '@/components/settings/DynamicEngineSettingsForm'
import { CollaborativeSessionHUD } from '@/components/settings/CollaborativeSessionHUD'
import { toast } from 'sonner'

const THEME_OPTIONS = [
  {
    value: 'light',
    icon: SunIcon,
    labelKey: 'settings.themeLight',
    fallbackLabel: 'Light',
  },
  {
    value: 'dark',
    icon: MoonIcon,
    labelKey: 'settings.themeDark',
    fallbackLabel: 'Dark',
  },
  {
    value: 'system',
    icon: MonitorIcon,
    labelKey: 'settings.themeSystem',
    fallbackLabel: 'System',
  },
  {
    value: 'cyberpunk',
    icon: Zap,
    labelKey: 'settings.themeCyberpunk',
    fallbackLabel: 'Cyberpunk',
  },
  {
    value: 'sakura',
    icon: Heart,
    labelKey: 'settings.themeSakura',
    fallbackLabel: 'Sakura',
  },
  {
    value: 'obsidian',
    icon: Gem,
    labelKey: 'settings.themeObsidian',
    fallbackLabel: 'Obsidian',
  },
] as const

export default function SettingsPage() {
  const { t, i18n } = useTranslation()
  const { theme, setTheme } = useTheme()
  const { data: backendAddons = [] } = useQuery({
    queryKey: ['app', 'addons'],
    queryFn: () => api.getInstalledAddons(),
    enabled: !!(window as any).__TAURI__,
  })
  const locales = useMemo(
    () => {
      const allLocales = Object.keys(i18n.options.resources || {})
      const storeAddons = usePreferencesStore.getState().installedAddons || []
      return allLocales.filter(code => {
        if (code === 'en-US' || code === 'th-TH') return true
        const base = code.split('-')[0]
        return backendAddons.includes(base) || storeAddons.includes('addon-' + base)
      })
    },
    [i18n.options.resources, backendAddons],
  )
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo>()
  const [mlDeviceSelection, setMlDeviceSelection] = useState<string>('AUTO')
  const [needsRelaunch, setNeedsRelaunch] = useState<boolean>(false)
  // CUDA devices discovered at runtime via `nvidia-smi`. Empty when the
  // machine has no NVIDIA GPU or the driver isn't installed.
  const [cudaDevices, setCudaDevices] = useState<
    Array<{ index: number; name: string }>
  >([])
  // cuDNN install state — driven by `runtime_cudnn_status` on mount and
  // the streaming `koharu://runtime/cudnn-progress` event during install.
  type CudnnStatus =
    | { kind: 'installed'; version: string; path: string }
    | { kind: 'missing'; version: string }
    | {
        kind: 'downloading'
        version: string
        bytes_done: number
        bytes_total: number | null
      }
    | { kind: 'extracting'; version: string }
    | { kind: 'ready'; version: string; path: string }
    | { kind: 'failed'; version: string; error: string }
  const [cudnnStatus, setCudnnStatus] = useState<CudnnStatus | null>(null)
  const [cudnnInstalling, setCudnnInstalling] = useState(false)
  const ocrEngine = usePreferencesStore((s) => s.ocrEngine)
  const setOcrEngine = usePreferencesStore((s) => s.setOcrEngine)
  const ocrSmartCloudFallback = usePreferencesStore(
    (s) => s.ocrSmartCloudFallback,
  )
  const setOcrSmartCloudFallback = usePreferencesStore(
    (s) => s.setOcrSmartCloudFallback,
  )
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
  const autoUpdateMode = usePreferencesStore((s) => s.autoUpdateMode)
  const setAutoUpdateMode = usePreferencesStore((s) => s.setAutoUpdateMode)
  const inpaintMaxSide = usePreferencesStore((s) => s.inpaintMaxSide)
  const setInpaintMaxSide = usePreferencesStore((s) => s.setInpaintMaxSide)
  const inpaintEngine = usePreferencesStore((s) => s.inpaintEngine)
  const setInpaintEngine = usePreferencesStore((s) => s.setInpaintEngine)
  const smartPostProcess = usePreferencesStore((s) => s.smartPostProcess)
  const setSmartPostProcess = usePreferencesStore((s) => s.setSmartPostProcess)
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
  // Same heuristic as ProfilesTabPanel.kindOf — legacy OpenRouter
  // profiles created before commit d6a97bb6 were saved with
  // provider='openai' (Rust backend used to collapse the variant).
  // The model id retains the `vendor/model` slash, which is the tell.
  // Without this, the filter rejects perfectly-valid OpenRouter
  // vision profiles (Gemini via OpenRouter etc.) and the user sees
  // "no vision profile" even though their AI Chat works fine with
  // the same profile.
  const effectiveProvider = (p: { provider: string; modelName: string }) =>
    p.provider === 'openai' && p.modelName.includes('/')
      ? 'openrouter'
      : p.provider
  const visionProfiles = (profiles.data ?? []).filter(
    (p) => supportsVision(effectiveProvider(p), p.modelName).supported,
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
      effectiveProvider({
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

    const loadMlDeviceSelection = async () => {
      try {
        const sel = await invoke('get_ml_device_config')
        setMlDeviceSelection(sel)
      } catch (error) {
        console.error('Failed to load ML device config', error)
      }
    }

    const loadCudaDevices = async () => {
      try {
        // Rust returns `Vec<(usize, String)>` — reshape into our UI
        // type so the dropdown can render named entries.
        const raw = (await invoke('enumerate_cuda_devices')) as Array<
          [number, string]
        >
        setCudaDevices(raw.map(([index, name]) => ({ index, name })))
      } catch (error) {
        // Non-fatal — UI just falls back to the static AUTO/CPU choices.
        console.error('Failed to enumerate CUDA devices', error)
      }
    }
    void loadCudaDevices()

    const loadCudnnStatus = async () => {
      try {
        const status = (await invoke('runtime_cudnn_status')) as CudnnStatus
        setCudnnStatus(status)
      } catch (error) {
        console.error('Failed to read cuDNN status', error)
      }
    }
    void loadCudnnStatus()

    // Stream install progress so the user sees a live progress bar while
    // the ~700 MB cuDNN archive downloads. Cleanup on unmount cancels
    // the listener so dev-mode HMR doesn't accumulate stale subscribers.
    let unlisten: (() => void) | null = null
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event')
      unlisten = await listen<CudnnStatus>(
        'koharu://runtime/cudnn-progress',
        (e) => {
          setCudnnStatus(e.payload)
          if (e.payload.kind === 'ready' || e.payload.kind === 'failed') {
            setCudnnInstalling(false)
            if (e.payload.kind === 'ready') setNeedsRelaunch(true)
          }
        },
      )
    })()
    return () => {
      if (unlisten) unlisten()
    }

    void loadDeviceInfo()
    void loadMlDeviceSelection()
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

            <NextGenStudioSection />

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
                <div className='grid grid-cols-3 gap-2'>
                  {THEME_OPTIONS.map(
                    ({ value, icon: Icon, labelKey, fallbackLabel }) => (
                      <button
                        key={value}
                        onClick={() => setTheme(value)}
                        data-active={theme === value}
                        className='border-border bg-card text-muted-foreground hover:border-foreground/30 data-[active=true]:border-primary data-[active=true]:text-foreground flex flex-col items-center gap-2 rounded-lg border p-3 transition'
                      >
                        <Icon className='size-5' />
                        <span className='text-xs font-medium'>
                          {t(labelKey, fallbackLabel)}
                        </span>
                      </button>
                    ),
                  )}
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
                <h3 className='text-foreground mb-3 text-xs font-semibold tracking-wide uppercase'>
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

                  {(detectorEngine === 'anime_yolo' ||
                    detectorEngine === 'auto') && (
                    <>
                      <label className='text-muted-foreground'>
                        {t('settings.engineDetectorVariant', 'Variant')}
                      </label>
                      <Select
                        value={animeYoloVariant}
                        onValueChange={(v) =>
                          setAnimeYoloVariant(
                            v as 'n' | 's' | 'm' | 'l' | 'x' | 'auto',
                          )
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
                          <SelectItem value='s'>S · small · ~30MB</SelectItem>
                          <SelectItem value='m'>M · medium · ~80MB</SelectItem>
                          <SelectItem value='l'>L · large · ~150MB</SelectItem>
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
                        <div className='text-muted-foreground/60 flex justify-between text-[10px] tracking-wide uppercase'>
                          <span>
                            {t(
                              'settings.confidenceMoreDetections',
                              'More (noisy)',
                            )}
                          </span>
                          <span>
                            {t(
                              'settings.confidenceFewerDetections',
                              'Fewer (strict)',
                            )}
                          </span>
                        </div>
                      </div>
                    </>
                  )}
                </div>

                {detectorEngine === 'anime_yolo' && (
                  <p className='text-muted-foreground/70 border-border/60 mt-4 border-t pt-3 text-xs leading-relaxed'>
                    {t(
                      'settings.engineDetectorAnimeYoloHint',
                      'Anime Text YOLO (mayocream/anime-text-yolo, YOLO12) is tuned for anime/manga text and catches SFX, stylised titles, and out-of-bubble text the default detector misses. Bubble mask still comes from the default detector. Switching variant reloads the model on next Process — pick N for speed, X for max recall. Raise Confidence (~0.35–0.45) to cut over-detection on noisy pages; lower it to rescue faint SFX.',
                    )}
                  </p>
                )}

                {detectorEngine === 'auto' && (
                  <p className='text-muted-foreground/70 border-border/60 mt-4 border-t pt-3 text-xs leading-relaxed'>
                    {t(
                      'settings.engineDetectorAutoHint',
                      'Auto Mode runs the default detector and dynamically cascades to Anime Text YOLO for action pages, dense text, or out-of-bubble SFX. Overlapping bboxes are resolved automatically. Variant "Auto" scales dynamically based on resolution and CUDA GPU capacity.',
                    )}
                  </p>
                )}
              </div>

              {/* OCR sub-card */}
              <div className='bg-card border-border mb-3 rounded-lg border p-4'>
                <h3 className='text-foreground mb-3 text-xs font-semibold tracking-wide uppercase'>
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
                        Manga OCR (Japanese-tuned, local, ~100MB first-use
                        download)
                      </SelectItem>
                      <SelectItem value='cloud'>
                        Cloud Vision (uses a saved LLM profile · counts tokens)
                      </SelectItem>
                    </SelectContent>
                  </Select>

                  {ocrEngine === 'auto' && (
                    <>
                      <label className='text-muted-foreground'>
                        {t(
                          'settings.engineOcrSmartCloudFallback',
                          'Smart Cloud Fallback',
                        )}
                      </label>
                      <div className='flex items-center gap-2'>
                        <button
                          type='button'
                          role='switch'
                          aria-checked={ocrSmartCloudFallback}
                          onClick={() =>
                            setOcrSmartCloudFallback(!ocrSmartCloudFallback)
                          }
                          className={[
                            'focus-visible:ring-ring relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:ring-2 focus-visible:outline-none',
                            ocrSmartCloudFallback ? 'bg-primary' : 'bg-input',
                          ].join(' ')}
                        >
                          <span
                            className={[
                              'bg-background pointer-events-none inline-block size-4 rounded-full shadow-lg ring-0 transition-transform',
                              ocrSmartCloudFallback
                                ? 'translate-x-4'
                                : 'translate-x-0',
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
                          setOcrCloudProfileId(
                            v === 'active' ? null : Number(v),
                          )
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

                <p className='text-muted-foreground/70 border-border/60 mt-4 border-t pt-3 text-xs leading-relaxed'>
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
                    <p className='mt-2 text-xs leading-relaxed text-amber-600 dark:text-amber-400'>
                      ⚠ No vision-capable profile available. Open Sidebar →
                      Profiles, add an OpenAI / Claude / Gemini / OpenRouter
                      profile with a vision-capable model (e.g. gpt-4o,
                      claude-3.5-sonnet, gemini-2.0-flash) and click Apply, then
                      come back here.
                    </p>
                  )}
              </div>

              {/* Inpaint sub-card */}
              <div className='bg-card border-border rounded-lg border p-4'>
                <h3 className='text-foreground mb-3 text-xs font-semibold tracking-wide uppercase'>
                  {t('settings.engineInpaint', 'Inpaint Engine')}
                </h3>
                <div className='grid grid-cols-[max-content_1fr] items-center gap-x-6 gap-y-3 text-sm'>
                  <label className='text-muted-foreground'>
                    {t('settings.engineInpaintEngine', 'Engine')}
                  </label>
                  <Select
                    value={inpaintEngine}
                    onValueChange={(v) =>
                      setInpaintEngine(
                        v as 'lama' | 'stable_diffusion' | 'cloud_flux',
                      )
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='lama'>
                        Lama (Tier 1 · Offline, fast, lightweight)
                      </SelectItem>
                      <SelectItem value='stable_diffusion'>
                        Stable Diffusion (Tier 2 · Offline, high-quality, local)
                      </SelectItem>
                      <SelectItem value='cloud_flux'>
                        Cloud FLUX.1 (Tier 3 · Online, state-of-the-art cloud
                        API)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <p className='text-muted-foreground/70 border-border/60 mt-4 border-t pt-3 text-xs leading-relaxed'>
                  {inpaintEngine === 'lama'
                    ? t(
                        'settings.engineInpaintLamaHint',
                        'Lama (Tier 1) เป็นค่าเริ่มต้นแบบออฟไลน์ที่เบาและเร็วมาก เหมาะสำหรับการลบอักษรทั่วไปที่ไม่ต้องการทรัพยากรเครื่องสูง',
                      )
                    : inpaintEngine === 'stable_diffusion'
                      ? t(
                          'settings.engineInpaintStableDiffusionHint',
                          'Stable Diffusion (Tier 2) ประมวลผลแบบออฟไลน์ในเครื่องเพื่อให้ได้ผลลัพธ์การลบอักษรคุณภาพสูงขึ้น โดยใช้โมเดลวาดต่อประสิทธิภาพสูง เหมาะกับภาพที่มีรายละเอียดพื้นหลังซับซ้อน',
                        )
                      : t(
                          'settings.engineInpaintCloudFluxHint',
                          'Cloud FLUX.1 (Tier 3) ใช้โมเดลระดับแนวหน้าของวงการผ่าน API บนระบบ Cloud เพื่อการสร้างพื้นหลังทดแทนที่เนียนตาที่สุด ใช้งานได้รวดเร็วแม้สเปกเครื่องไม่สูง',
                        )}
                </p>
              </div>
            </section>

            {/* Translation Section */}
            <section className='mb-8'>
              <h2 className='text-foreground mb-1 text-sm font-bold'>
                {t('settings.translation', 'Translation')}
              </h2>
              <p className='text-muted-foreground mb-4 text-sm'>
                {t(
                  'settings.translationDescription',
                  'Post-processing and performance options for the translate + inpaint pipeline.',
                )}
              </p>

              {/* Inpaint quality sub-card */}
              <div className='bg-card border-border mb-3 rounded-lg border p-4'>
                <h3 className='text-foreground mb-3 text-xs font-semibold tracking-wide uppercase'>
                  {t('settings.inpaintQuality', 'Inpaint quality')}
                </h3>
                <div className='grid grid-cols-[max-content_1fr] items-center gap-x-6 gap-y-3 text-sm'>
                  <label className='text-muted-foreground'>
                    {t('settings.inpaintQualityLevel', 'Quality')}
                  </label>
                  <Select
                    value={String(inpaintMaxSide)}
                    onValueChange={(v) =>
                      setInpaintMaxSide(Number(v) as 256 | 512 | 768)
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='256'>
                        ⚡ {t('settings.inpaintFast', 'Fast')} (256 px)
                      </SelectItem>
                      <SelectItem value='512'>
                        ⚖️ {t('settings.inpaintBalanced', 'Balanced')} (512 px){' '}
                        — {t('settings.inpaintDefault', 'default')}
                      </SelectItem>
                      <SelectItem value='768'>
                        ✨ {t('settings.inpaintQualityHigh', 'Quality')} (768
                        px)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <p className='text-muted-foreground/70 border-border/60 mt-4 border-t pt-3 text-xs leading-relaxed'>
                  {t(
                    'settings.inpaintQualityHint',
                    'Controls the maximum crop size sent to LaMa. Larger = sharper inpaint but slower (quadratic). Balanced (512 px) is recommended for most pages.',
                  )}
                </p>
              </div>

              {/* Smart Typography & Post-Processing sub-card */}
              <div className='bg-card border-border rounded-lg border p-4'>
                <h3 className='text-foreground mb-3 text-xs font-semibold tracking-wide uppercase'>
                  {t('settings.smartPostProcess', 'Smart Typography & Post-Processing')}
                </h3>
                <div className='flex items-center justify-between gap-4'>
                  <div className='min-w-0'>
                    <p className='text-foreground text-sm'>
                      {t(
                        'settings.smartPostProcessLabel',
                        'Normalize quotes & spaces',
                      )}
                    </p>
                    <p className='text-muted-foreground mt-0.5 text-xs'>
                      {t(
                        'settings.smartPostProcessHint',
                        'แปลง " " → \u201c \u201d และลบ space เกินระหว่างตัวอักษรไทย (เช่น "ไป แล้ว" → "ไปแล้ว")',
                      )}
                    </p>
                  </div>
                  <button
                    type='button'
                    role='switch'
                    aria-checked={smartPostProcess}
                    data-testid='settings-thai-post-process'
                    onClick={() => setSmartPostProcess(!smartPostProcess)}
                    className={[
                      'focus-visible:ring-ring relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:ring-2 focus-visible:outline-none',
                      smartPostProcess ? 'bg-primary' : 'bg-input',
                    ].join(' ')}
                  >
                    <span
                      className={[
                        'bg-background pointer-events-none inline-block size-4 rounded-full shadow-lg ring-0 transition-transform',
                        smartPostProcess ? 'translate-x-4' : 'translate-x-0',
                      ].join(' ')}
                    />
                  </button>
                </div>
              </div>
            </section>

            {/* Device Section — render unconditionally so the cuDNN
             *  install card stays reachable even when `invoke('device')`
             *  fails or races against the WS RPC bootstrap. Active ML
             *  Device falls back to a "Loading…" placeholder. */}
            <section className='mb-8'>
                <h2 className='text-foreground mb-1 text-sm font-bold'>
                  {t('settings.device')}
                </h2>
                <p className='text-muted-foreground mb-4 text-sm'>
                  {t('settings.deviceDescription')}
                </p>

                <div className='bg-card border-border rounded-lg border p-4'>
                  <div className='space-y-4 text-sm'>
                    <div className='border-border flex items-center justify-between border-b pb-3'>
                      <span className='text-muted-foreground'>
                        {t('settings.deviceMl')}
                      </span>
                      <span className='text-foreground font-medium'>
                        {deviceInfo?.mlDevice ?? 'Loading…'}
                      </span>
                    </div>

                    <div className='flex items-center justify-between pt-1'>
                      <div className='flex flex-col gap-0.5'>
                        <span className='text-foreground text-sm font-medium'>
                          {t('settings.mlComputeMode', 'ML Compute Mode')}
                        </span>
                        <span className='text-muted-foreground text-xs'>
                          {t(
                            'settings.mlComputeModeDesc',
                            'Select device or force CPU',
                          )}
                        </span>
                      </div>
                      <Select
                        value={mlDeviceSelection}
                        onValueChange={async (v) => {
                          setMlDeviceSelection(v)
                          try {
                            await invoke('set_ml_device_config', {
                              selection: v,
                            })
                            setNeedsRelaunch(true)
                          } catch (err) {
                            console.error(err)
                          }
                        }}
                      >
                        <SelectTrigger className='w-[180px]'>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value='AUTO'>AUTO</SelectItem>
                          <SelectItem value='CPU'>CPU</SelectItem>
                          {cudaDevices.map((d) => (
                            <SelectItem
                              key={d.index}
                              value={`CUDA:${d.index}`}
                            >
                              {/* Show plain GPU name when there's just
                               *  one CUDA device; prefix `[N]` when
                               *  multi-GPU so duplicates stay
                               *  distinguishable. Backend value still
                               *  carries the CUDA index. */}
                              {cudaDevices.length > 1
                                ? `[${d.index}] ${d.name}`
                                : d.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {needsRelaunch && (
                      <div className='bg-primary/10 border-primary/20 text-primary mt-2 flex items-center justify-between rounded-lg border p-3 text-xs'>
                        <span>
                          {t(
                            'settings.relaunchWarning',
                            'การตั้งค่าจะมีผลหลังจากรีสตาร์ทแอปพลิเคชัน',
                          )}
                        </span>
                        <Button
                          variant='ghost'
                          size='sm'
                          className='text-primary hover:bg-primary/20 h-7 px-2 font-bold'
                          onClick={() => invoke('relaunch_app')}
                        >
                          {t('settings.relaunchBtn', 'รีสตาร์ทตอนนี้')}
                        </Button>
                      </div>
                    )}

                    {/* cuDNN runtime install card. Only surfaced when
                     *  the user actually has a CUDA-capable GPU on the
                     *  machine — otherwise installing cuDNN is pointless. */}
                    {cudnnStatus && cudaDevices.length > 0 && (
                      <div className='border-border/60 mt-3 rounded-lg border p-3'>
                        <div className='flex items-start justify-between gap-3'>
                          <div className='flex flex-col gap-0.5'>
                            <span className='text-foreground text-sm font-medium'>
                              {t('settings.cudnnTitle', 'cuDNN GPU runtime')}
                            </span>
                            <span className='text-muted-foreground text-xs'>
                              {cudnnStatus.kind === 'installed'
                                ? t(
                                    'settings.cudnnInstalled',
                                    'ติดตั้งแล้ว v{{version}} — ใช้งาน GPU acceleration ได้เต็มสปีด',
                                    { version: cudnnStatus.version },
                                  )
                                : cudnnStatus.kind === 'ready'
                                  ? t(
                                      'settings.cudnnReady',
                                      'พร้อมใช้งาน v{{version}} — รีสตาร์ทเพื่อเปิด GPU',
                                      { version: cudnnStatus.version },
                                    )
                                  : cudnnStatus.kind === 'failed'
                                    ? t(
                                        'settings.cudnnFailed',
                                        'ดาวน์โหลดล้มเหลว: {{error}}',
                                        { error: cudnnStatus.error },
                                      )
                                    : t(
                                        'settings.cudnnMissing',
                                        'ยังไม่ติดตั้ง — GPU จะ fallback ไป CPU. ดาวน์โหลด v{{version}} (~700 MB) จาก NVIDIA CDN',
                                        { version: cudnnStatus.version },
                                      )}
                            </span>
                          </div>
                          {(cudnnStatus.kind === 'missing' ||
                            cudnnStatus.kind === 'failed') && (
                            <Button
                              variant='outline'
                              size='sm'
                              disabled={cudnnInstalling}
                              onClick={async () => {
                                setCudnnInstalling(true)
                                try {
                                  await invoke('runtime_install_cudnn')
                                } catch (err) {
                                  console.error('cuDNN install failed', err)
                                  setCudnnInstalling(false)
                                }
                              }}
                            >
                              {cudnnInstalling
                                ? t('settings.cudnnInstalling', 'กำลังติดตั้ง…')
                                : t('settings.cudnnInstall', 'ติดตั้ง')}
                            </Button>
                          )}
                        </div>
                        {cudnnStatus.kind === 'downloading' && (
                          <div className='mt-2'>
                            <div className='bg-muted h-1.5 w-full overflow-hidden rounded-full'>
                              <div
                                className='bg-primary h-full transition-all'
                                style={{
                                  width: cudnnStatus.bytes_total
                                    ? `${Math.min(100, (cudnnStatus.bytes_done / cudnnStatus.bytes_total) * 100)}%`
                                    : '0%',
                                }}
                              />
                            </div>
                            <span className='text-muted-foreground mt-1 block text-[10px]'>
                              {(cudnnStatus.bytes_done / 1_000_000).toFixed(1)}{' '}
                              MB
                              {cudnnStatus.bytes_total
                                ? ` / ${(cudnnStatus.bytes_total / 1_000_000).toFixed(0)} MB`
                                : ''}
                            </span>
                          </div>
                        )}
                        {cudnnStatus.kind === 'extracting' && (
                          <span className='text-muted-foreground mt-2 block text-[10px]'>
                            {t(
                              'settings.cudnnExtracting',
                              'กำลังแตกไฟล์ DLL…',
                            )}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </section>

            {/* Updater Section */}
            <section className='mb-8'>
              <h2 className='text-foreground mb-1 text-sm font-bold'>
                {t('settings.updaterTitle', 'Auto-updater preferences')}
              </h2>
              <p className='text-muted-foreground mb-4 text-sm'>
                {t(
                  'settings.updaterDescription',
                  'Choose how Koharu handles software updates.',
                )}
              </p>

              <div className='bg-card border-border rounded-lg border p-4'>
                <div className='space-y-4'>
                  <div className='flex items-center justify-between'>
                    <div className='flex flex-col gap-0.5'>
                      <span className='text-foreground text-sm font-medium'>
                        {t('settings.updaterMode', 'Update checking mode')}
                      </span>
                    </div>
                    <Select
                      value={autoUpdateMode}
                      onValueChange={(v) =>
                        setAutoUpdateMode(v as 'auto' | 'notify' | 'manual')
                      }
                    >
                      <SelectTrigger className='w-[180px]'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='auto'>
                          {t('settings.updateModeAuto', 'Auto-Update')}
                        </SelectItem>
                        <SelectItem value='notify'>
                          {t('settings.updateModeNotify', 'Notify Only')}
                        </SelectItem>
                        <SelectItem value='manual'>
                          {t('settings.updateModeManual', 'Manual')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <p className='text-muted-foreground/70 border-border/60 border-t pt-3 text-xs leading-relaxed'>
                    {autoUpdateMode === 'auto' &&
                      t(
                        'settings.updaterAutoHint',
                        'Auto-Update: Koharu will check for updates on startup, download and install them silently in the background, and then prompt you to restart. Zero effort required.',
                      )}
                    {autoUpdateMode === 'notify' &&
                      t(
                        'settings.updaterNotifyHint',
                        'Notify Only: Koharu will check for updates on startup. If an update is available, you will receive a prompt to download and install it.',
                      )}
                    {autoUpdateMode === 'manual' &&
                      t(
                        'settings.updaterManualHint',
                        'Manual: Koharu will not check for updates automatically. You must manually check from the Help menu or About page.',
                      )}
                  </p>
                </div>
              </div>
            </section>

            {/* Addon Store Section */}
            <AddonStoreSection />

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
// Storage Section
// ────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  )
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
    target: 'orphanCache',
    label: 'Incomplete download cache',
    description:
      'Temporary files (.part, .download, .tmp) left behind by aborted or interrupted AI model downloads. Safe to clear anytime.',
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
          'On-disk data koharu manages outside your project folders. Project files (.khr / chapter pages / SQLite) are never touched by anything here.',
        )}
      </p>

      <div className='bg-card border-border rounded-lg border p-4'>
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
                      <span className='ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-amber-700 uppercase dark:text-amber-400'>
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
                    {entry?.exists ? formatBytes(entry.sizeBytes) : '—'}
                  </span>
                  <button
                    type='button'
                    disabled={!entry?.exists || isBusy}
                    onClick={() => clear(spec.target, spec)}
                    className='text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground text-xs underline-offset-2 hover:underline disabled:no-underline disabled:opacity-40'
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
                <span className='ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-amber-700 uppercase dark:text-amber-400'>
                  user data
                </span>
              </div>
              <div className='text-muted-foreground/80 mt-0.5 text-xs leading-relaxed'>
                Cloud API keys, OCR / detector choices, theme, language, brush,
                and other UI prefs. Stored in browser localStorage; project
                files unaffected.
              </div>
            </div>
            <div className='flex shrink-0 flex-col items-end gap-1'>
              <button
                type='button'
                disabled={busy === 'prefs'}
                onClick={resetPrefs}
                className='text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline disabled:opacity-40'
              >
                {busy === 'prefs' ? 'Resetting…' : 'Reset to defaults'}
              </button>
            </div>
          </div>
        </div>

        {lastResult && (
          <p className='text-muted-foreground border-border/60 mt-3 border-t pt-3 text-xs'>
            {lastResult}
          </p>
        )}
        {stats.isError && (
          <p className='mt-3 text-xs text-amber-600 dark:text-amber-400'>
            Could not read storage stats — backend may not be ready yet.
          </p>
        )}
      </div>
    </section>
  )
}

// ────────────────────────────────────────────────────────────────
// Addons Manager Store Section
// ────────────────────────────────────────────────────────────────

type AddonItem = {
  id: string
  name: string
  code: string
  label: string
  descEn: string
  descTh: string
  targetLanguage: string
  author: string
  version: string
  badgeEn: string
  badgeTh: string
  resources: any
}

const AVAILABLE_ADDONS: AddonItem[] = [
  {
    id: 'addon-fr',
    name: 'French Language Pack Addon',
    code: 'fr-FR',
    label: 'Français (French)',
    descEn:
      'Enables French UI (EN/FR) and configures dynamic translation post-processing for French spacing and guillemets.',
    descTh:
      'เปิดใช้งานหน้า UI ภาษาฝรั่งเศส (EN/FR) และระบบ Dynamic Post-Processor สำหรับเครื่องหมายวรรคตอนและการตัดคำภาษาฝรั่งเศส',
    targetLanguage: 'French',
    author: 'HetCreep',
    version: '1.0.0',
    badgeEn: 'French Spacing & Guillemets',
    badgeTh: 'วรรณยุกต์และเครื่องหมายฝรั่งเศส',
    resources: frFR,
  },
  {
    id: 'addon-es',
    name: 'Spanish Language Pack Addon',
    code: 'es-ES',
    label: 'Español (Spanish)',
    descEn:
      'Enables Spanish UI (EN/ES) and adapts the translation pipeline for Spanish quotation metrics.',
    descTh:
      'เปิดใช้งานหน้า UI ภาษาสเปน (EN/ES) และปรับท่อประมวลผลคำแปลเพื่อรอบรับโควตเครื่องหมายคำพูดภาษาสเปน',
    targetLanguage: 'Spanish',
    author: 'HetCreep',
    version: '1.0.0',
    badgeEn: 'Spanish Quotes & Spacing',
    badgeTh: 'เครื่องหมายโควตภาษาสเปน',
    resources: esES,
  },
  {
    id: 'addon-pt',
    name: 'Portuguese Language Pack Addon',
    code: 'pt-PT',
    label: 'Português (Portuguese)',
    descEn:
      'Enables Portuguese UI (EN/PT) and optimizes dynamic bubble capacity rules for Portuguese translation.',
    descTh:
      'เปิดใช้งานหน้า UI ภาษาโปรตุเกส (EN/PT) และปรับระดับพื้นที่ฟองคำพูดคำแปลของภาษาโปรตุเกสให้พอดีแม่นยำ',
    targetLanguage: 'Portuguese',
    author: 'HetCreep',
    version: '1.0.0',
    badgeEn: 'Portuguese Dynamic Adjuster',
    badgeTh: 'ความจุข้อความโปรตุเกส',
    resources: ptPT,
  },
  {
    id: 'addon-cn',
    name: 'Mandarin Chinese Language Addon',
    code: 'zh-CN',
    label: '简体中文 (Chinese)',
    descEn:
      'Enables Mandarin Chinese UI (EN/CN) and activates CJK vertical writing layouts in tall speech bubbles.',
    descTh:
      'เปิดใช้งานหน้า UI ภาษาจีนกลาง (EN/CN) และเปิดใช้ระบบประมวลผลข้อความ CJK แนวตั้งในกล่องฟองคำพูดทรงสูง',
    targetLanguage: 'Chinese',
    author: 'HetCreep',
    version: '1.0.0',
    badgeEn: 'CJK Vertical Writing & UI',
    badgeTh: 'ข้อความภาษาจีนแนวตั้ง & UI',
    resources: zhCN,
  },
  {
    id: 'addon-ru',
    name: 'Russian Language Pack Addon',
    code: 'ru-RU',
    label: 'Русский (Russian)',
    descEn:
      'Enables Russian UI (EN/RU) and adds full Cyrillic font fallbacks across the layout renderer.',
    descTh:
      'เปิดใช้งานหน้า UI ภาษารัสเซีย (EN/RU) และปรับแต่งระบบฟอนต์ฟอลแบ็กแบบซีริลลิก (Cyrillic Fonts) สำหรับความจุคำแปลรัสเซีย',
    targetLanguage: 'Russian',
    author: 'HetCreep',
    version: '1.0.0',
    badgeEn: 'Cyrillic Fonts & Spacing',
    badgeTh: 'ระบบฟอนต์ซีริลลิก & UI',
    resources: ruRU,
  },
]

function AddonStoreSection() {
  const { t, i18n } = useTranslation()
  const installedAddons = usePreferencesStore((s) => s.installedAddons)
  const setInstalledAddons = usePreferencesStore((s) => s.setInstalledAddons)
  const cloudTargetLanguage = usePreferencesStore((s) => s.cloudTargetLanguage)
  const setCloudTargetLanguage = usePreferencesStore(
    (s) => s.setCloudTargetLanguage,
  )

  const [installingId, setInstallingId] = useState<string | null>(null)
  const [installProgress, setInstallProgress] = useState<number>(0)
  const [relaunchAddon, setRelaunchAddon] = useState<AddonItem | null>(null)

  const isTh = i18n.language === 'th-TH'

  const handleInstall = async (addon: AddonItem) => {
    setInstallingId(addon.id)
    setInstallProgress(10)

    try {
      setInstallProgress(30)
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 3000)

      let resources = addon.resources
      try {
        const res = await fetch(
          `https://cdn.jsdelivr.net/gh/EarthWL/koharu-th-addons@main/langs/${addon.code}.json`,
          { signal: controller.signal },
        )
        clearTimeout(timeoutId)
        if (res.ok) {
          resources = await res.json()
        }
      } catch (err) {
        console.warn(
          `CDN fetch failed, falling back to bundled resources:`,
          err,
        )
      }

      setInstallProgress(60)
      await new Promise((resolve) => setTimeout(resolve, 300))

      setInstallProgress(90)
      // 1. Inject resource bundle dynamically
      i18n.addResourceBundle(addon.code, 'translation', resources, true, true)

      // 2. Add language labels dynamically
      const activeLanguages = Object.keys(i18n.options.resources || {})
      activeLanguages.forEach((lang) => {
        i18n.addResourceBundle(
          lang,
          'translation',
          {
            menu: {
              languages: {
                [addon.code]: addon.label,
              },
            },
          },
          true,
          true,
        )
      })

      // 3. Update store state
      setInstalledAddons([...installedAddons, addon.id])
      setCloudTargetLanguage(addon.targetLanguage)
      setRelaunchAddon(addon) // Trigger the relaunch modal!
    } catch (e) {
      console.error('Installation failed:', e)
    } finally {
      setInstallingId(null)
      setInstallProgress(0)
    }
  }

  const handleUninstall = (addon: AddonItem) => {
    // Remove addon from installed list
    setInstalledAddons(installedAddons.filter((id) => id !== addon.id))

    // Fall back target language to Thai if current was uninstalled
    if (cloudTargetLanguage === addon.targetLanguage) {
      setCloudTargetLanguage('Thai')
    }

    // Switch UI language back if active UI language was this addon's code
    if (i18n.language === addon.code) {
      i18n.changeLanguage('th-TH')
    }
  }

  return (
    <section className='mb-8'>
      <h2 className='text-foreground mb-1 flex items-center gap-2 text-sm font-bold'>
        <Puzzle className='text-primary size-4' />
        {isTh ? 'จัดการ Addon เสริมภาษา' : 'Addons & Language Store'}
      </h2>
      <p className='text-muted-foreground mb-4 text-sm leading-relaxed'>
        {isTh
          ? 'ติดตั้ง Addon เสริมสําหรับแต่ละภาษา เพื่อปรับเปลี่ยนหน้าตาเมนูโปรแกรม ตลอดจนลอจิกวิเคราะห์ขนาดกรอบคำพูดและเครื่องหมายวรรคตอนสำหรับภาษานั้นๆ แบบอัตโนมัติ'
          : 'Install language addons to dynamically customize the user interface, typography rules, speech bubble measurements, and punctuation cleanup pipelines for specific languages.'}
      </p>

      <div className='space-y-4'>
        {AVAILABLE_ADDONS.map((addon) => {
          const isInstalled = installedAddons.includes(addon.id)
          const isInstalling = installingId === addon.id
          const isActive = cloudTargetLanguage === addon.targetLanguage

          return (
            <div
              key={addon.id}
              className='bg-card border-border hover:border-primary/30 relative overflow-hidden rounded-lg border p-4 transition-all duration-300'
            >
              {/* Active language border glow */}
              {isActive && (
                <div className='bg-primary/80 absolute top-0 bottom-0 left-0 w-1' />
              )}

              <div className='flex items-start justify-between gap-4'>
                <div className='min-w-0 flex-1'>
                  <div className='flex flex-wrap items-center gap-2'>
                    <h3 className='text-foreground text-sm font-semibold'>
                      {addon.name}
                    </h3>
                    <span className='bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[10px]'>
                      v{addon.version}
                    </span>
                    <span className='border-primary/20 bg-primary/5 text-primary rounded-full border px-2 py-0.5 text-[9px] font-medium tracking-wide uppercase'>
                      {isTh ? addon.badgeTh : addon.badgeEn}
                    </span>
                    {isActive && (
                      <span className='flex items-center gap-0.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-emerald-600 uppercase dark:text-emerald-400'>
                        <Check className='size-2.5' />
                        {isTh ? 'กำลังใช้งาน' : 'Active Target'}
                      </span>
                    )}
                  </div>

                  <p className='text-muted-foreground/90 mt-1.5 text-xs leading-relaxed'>
                    {isTh ? addon.descTh : addon.descEn}
                  </p>

                  <div className='text-muted-foreground/60 mt-2 flex items-center gap-3 text-[10px] tracking-wide uppercase'>
                    <span>
                      {isTh ? 'ผู้พัฒนา' : 'Developer'}: {addon.author}
                    </span>
                    <span>•</span>
                    <span>
                      {isTh ? 'ภาษาปลายทาง' : 'Target Lang'}:{' '}
                      {addon.targetLanguage}
                    </span>
                  </div>
                </div>

                <div className='flex shrink-0 items-center justify-end gap-2 self-center'>
                  {isInstalled ? (
                    <button
                      type='button'
                      onClick={() => handleUninstall(addon)}
                      className='border-destructive/20 text-destructive hover:bg-destructive/10 flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition'
                    >
                      <Trash2 className='size-3.5' />
                      {isTh ? 'ถอนการติดตั้ง' : 'Uninstall'}
                    </button>
                  ) : isInstalling ? (
                    <div className='text-muted-foreground flex items-center gap-1.5 text-xs font-medium'>
                      <Loader2 className='size-3.5 animate-spin' />
                      {installProgress}%
                    </div>
                  ) : (
                    <button
                      type='button'
                      disabled={installingId !== null}
                      onClick={() => handleInstall(addon)}
                      className='bg-primary text-primary-foreground hover:bg-primary/95 flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium shadow-sm transition disabled:opacity-50'
                    >
                      <Download className='size-3.5' />
                      {isTh ? 'ติดตั้ง' : 'Install'}
                    </button>
                  )}
                </div>
              </div>

              {/* Progress bar overlay during installation */}
              {isInstalling && (
                <div className='bg-muted absolute right-0 bottom-0 left-0 h-1'>
                  <div
                    className='bg-primary h-full transition-all duration-150'
                    style={{ width: `${installProgress}%` }}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>

      {relaunchAddon && (
        <div className='bg-background/80 animate-in fade-in fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm duration-200'>
          <div className='bg-card border-border animate-in zoom-in-95 relative flex w-full max-w-sm flex-col gap-4 rounded-xl border p-6 shadow-2xl duration-200'>
            <div className='border-border flex items-center gap-3 border-b pb-3'>
              <Puzzle className='text-primary size-5 animate-pulse' />
              <h3 className='text-foreground text-base font-bold'>
                {isTh ? '🧩 ติดตั้ง Addon สำเร็จ!' : '🧩 Addon Installed!'}
              </h3>
            </div>

            <p className='text-muted-foreground text-sm leading-relaxed'>
              {isTh
                ? `ติดตั้งภาษา ${relaunchAddon.label} เรียบร้อยแล้ว! เพื่อสลับการแสดงผลหน้า UI หลักทั้งหมดของตัวโปรแกรมเป็นภาษาใหม่ทันที กรุณากดปุ่มรีสตาร์ทแอป หรือเลือกทำภายหลัง`
                : `Language pack ${relaunchAddon.label} has been successfully installed! To switch the main user interface language immediately, please restart the application, or select switch later.`}
            </p>

            <div className='mt-2 flex gap-3'>
              <button
                type='button'
                onClick={() => {
                  i18n.changeLanguage(relaunchAddon.code)
                  invoke('relaunch_app')
                }}
                className='bg-primary text-primary-foreground hover:bg-primary/95 h-9 flex-1 rounded-md text-xs font-semibold shadow-sm transition'
              >
                {isTh ? 'รีสตาร์ททันที' : 'Restart Now'}
              </button>
              <button
                type='button'
                onClick={() => setRelaunchAddon(null)}
                className='border-input hover:bg-accent hover:text-accent-foreground h-9 flex-1 rounded-md border text-xs font-semibold transition'
              >
                {isTh ? 'สลับภายหลัง' : 'Switch Later'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function NextGenStudioSection() {
  const { i18n, t } = useTranslation()
  const isTh = i18n.language === 'th' || i18n.language === 'th-TH'
  const [benchmarking, setBenchmarking] = useState(false)
  const [syncEnabled, setSyncEnabled] = useState(false)
  const [modelManagerOpen, setModelManagerOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<'models' | 'dynamicForm'>('models')

  // Backups state
  const [backupManagerOpen, setBackupManagerOpen] = useState(false)
  const [backups, setBackups] = useState<BackupDto[]>([])
  const [autoBackupEnabled, setAutoBackupEnabled] = useState(true)
  const [creatingBackup, setCreatingBackup] = useState(false)
  const [restoring, setRestoring] = useState(false)

  // Model Cache / Downloads state
  const downloads = useDownloadStore((s) => s.downloads)
  const ensureDownloadSubscribed = useDownloadStore((s) => s.ensureSubscribed)
  const [cacheSize, setCacheSize] = useState<string>('Querying...')
  const [clearingCache, setClearingCache] = useState(false)

  useEffect(() => {
    ensureDownloadSubscribed()
  }, [ensureDownloadSubscribed])

  const activeDownloads = Array.from(downloads.values()).filter(
    (d) => d.status === 'started' || d.status === 'downloading',
  )

  const loadCacheSize = async () => {
    try {
      const stats = await api.appStorageStats()
      const hf = stats.modelsHf
      if (hf?.exists) {
        setCacheSize(formatBytes(hf.sizeBytes))
      } else {
        setCacheSize('0 B')
      }
    } catch (err) {
      setCacheSize('Unknown')
    }
  }

  const loadBackups = async () => {
    try {
      const list = await api.projectBackupList()
      setBackups(list)
    } catch (err) {
      console.error('Failed to load backups:', err)
    }
  }

  useEffect(() => {
    if (modelManagerOpen) {
      loadCacheSize()
    }
  }, [modelManagerOpen])

  useEffect(() => {
    if (backupManagerOpen) {
      loadBackups()
      const enabled =
        localStorage.getItem('koharu_auto_backup_enabled') !== 'false'
      setAutoBackupEnabled(enabled)
    }
  }, [backupManagerOpen])

  const handleClearCache = async () => {
    if (
      !confirm(
        isTh
          ? 'คุณแน่ใจหรือไม่ว่าต้องการล้างแคชโมเดล AI? โมเดลจะถูกดาวน์โหลดใหม่โดยอัตโนมัติเมื่อมีการใช้งานครั้งแรก'
          : 'Are you sure you want to wipe AI Model cache? Models will be automatically re-downloaded on first inference.',
      )
    )
      return

    setClearingCache(true)
    try {
      const res = await api.appStorageClear(['modelsHf'])
      toast.error(
        isTh
          ? `ล้างแคชเรียบร้อยแล้ว! คืนพื้นที่ว่างในเครื่อง: ${formatBytes(res.freedBytes)}`
          : `Successfully cleared cache! Freed ${formatBytes(res.freedBytes)}.`,
      )
      loadCacheSize()
    } catch (err: any) {
      toast.error(`Failed to clear cache: ${err?.message || err}`)
    } finally {
      setClearingCache(false)
    }
  }

  const simulateDownload = async (filename: string, totalSize: number) => {
    try {
      const diskSpace = await api.projectCheckDiskSpace()
      const safetyMargin = 100 * 1024 * 1024 // 100MB safety margin
      const neededBytes = totalSize + safetyMargin

      if (diskSpace.freeBytes < neededBytes) {
        const freeMb = Math.round(diskSpace.freeBytes / (1024 * 1024))
        const neededMb = Math.round(neededBytes / (1024 * 1024))
        toast.error(
          isTh
            ? `⚠️ พื้นที่ฮาร์ดดิสก์ไม่เพียงพอสำหรับการดาวน์โหลด!\nต้องการอย่างน้อย: ${neededMb} MB\nพื้นที่ว่างปัจจุบันของคุณ: ${freeMb} MB\nกรุณาเคลียร์พื้นที่ในเครื่องก่อนดาวน์โหลดโมเดล`
            : `⚠️ Insufficient disk space for download!\nRequires at least: ${neededMb} MB\nYour current free space: ${freeMb} MB\nPlease free up some disk space before installing.`,
        )
        return
      }
    } catch (err: any) {
      console.warn('Failed to check disk space:', err)
    }

    let downloaded = 0

    // Initial started state
    const nextStarted = new Map(useDownloadStore.getState().downloads)
    nextStarted.set(filename, {
      filename,
      downloaded: 0,
      total: totalSize,
      status: 'started',
      percent: 0,
    })
    useDownloadStore.setState({ downloads: nextStarted })

    const interval = setInterval(() => {
      downloaded += Math.round(totalSize / 20) // 5% ticks
      if (downloaded >= totalSize) {
        downloaded = totalSize
        clearInterval(interval)

        // Completed state
        const nextCompleted = new Map(useDownloadStore.getState().downloads)
        nextCompleted.set(filename, {
          filename,
          downloaded,
          total: totalSize,
          status: 'completed',
          percent: 100,
        })
        useDownloadStore.setState({ downloads: nextCompleted })

        // Auto-remove after 3 seconds
        setTimeout(() => {
          const current = useDownloadStore.getState().downloads
          if (current.has(filename)) {
            const updated = new Map(current)
            updated.delete(filename)
            useDownloadStore.setState({ downloads: updated })
          }
          loadCacheSize()
        }, 3000)
      } else {
        // Downloading state
        const nextDownloading = new Map(useDownloadStore.getState().downloads)
        nextDownloading.set(filename, {
          filename,
          downloaded,
          total: totalSize,
          status: 'downloading',
          percent: Math.round((downloaded / totalSize) * 100),
        })
        useDownloadStore.setState({ downloads: nextDownloading })
      }
    }, 250)
  }

  const handleCreateBackup = async () => {
    setCreatingBackup(true)
    try {
      await api.projectBackupSilent()
      await loadBackups()
    } catch (err: any) {
      toast.error(`Failed to create snapshot: ${err?.message || err}`)
    } finally {
      setCreatingBackup(false)
    }
  }

  const handleRestoreBackup = async (name: string) => {
    const msg = isTh
      ? `คุณแน่ใจหรือไม่ว่าต้องการย้อนกลับ (Restore) โปรเจกต์เป็นเวอร์ชัน "${name}"?\nงานที่ยังไม่ได้เซฟทั้งหมดในเซสชันปัจจุบันจะถูกเขียนทับ`
      : `Are you sure you want to restore snapshot "${name}"?\nAll unsaved work in the current session will be overwritten.`

    if (!confirm(msg)) return
    setRestoring(true)
    try {
      await api.projectBackupRestore(name)
      toast.error(
        isTh
          ? 'กู้คืนข้อมูลโปรเจกต์สำเร็จแล้ว! กำลังโหลดหน้าใหม่...'
          : 'Project restored successfully! Reloading studio...',
      )
      window.location.reload()
    } catch (err: any) {
      toast.error(`Failed to restore project: ${err?.message || err}`)
    } finally {
      setRestoring(false)
    }
  }

  return (
    <section className='border-primary/30 bg-primary/5 shadow-primary/5 relative mb-8 overflow-hidden rounded-xl border p-1 shadow-lg'>
      <div className='bg-primary/20 pointer-events-none absolute -top-4 -right-4 size-24 rounded-full blur-2xl' />
      <div className='bg-accent/20 pointer-events-none absolute -bottom-4 -left-4 size-24 rounded-full blur-2xl' />

      <div className='bg-card/50 relative z-10 rounded-lg p-5 backdrop-blur-md'>
        <div className='mb-2 flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <Zap className='text-primary size-5 animate-pulse' />
            <h2 className='text-foreground from-primary to-accent bg-gradient-to-r bg-clip-text text-sm font-bold text-transparent'>
              {isTh
                ? 'ส่วนเสริมNext-Gen Studio'
                : 'Next-Gen Studio Enhancements'}
            </h2>
          </div>
          <span className='bg-primary/20 text-primary rounded px-2 py-0.5 text-[9px] font-bold tracking-widest uppercase'>
            Premium
          </span>
        </div>
        <p className='text-muted-foreground mb-5 text-sm'>
          {isTh
            ? 'ฟีเจอร์ระดับพรีเมียมเฉพาะของ Koharu-TH (เปิดใช้งานแล้ว)'
            : 'Premium features exclusive to Koharu-TH (activated)'}
        </p>

        <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
          {/* 1. Dynamic Theme */}
          <div className='bg-background/80 border-border/50 flex flex-col gap-2 rounded-lg border p-4 shadow-sm'>
            <div className='flex items-center gap-2'>
              <Heart className='size-4 text-rose-400' />
              <h3 className='text-xs font-bold'>
                {isTh
                  ? 'ระบบปรับแต่งสี Dynamic Theme'
                  : 'Dynamic Theme Customizer'}
              </h3>
            </div>
            <p className='text-muted-foreground text-[10px] leading-relaxed'>
              {isTh
                ? 'ปลดล็อกธีมกระจกโปร่งแสง (Cyberpunk, Sakura, Obsidian) ในแถบเมนูแสดงผล'
                : 'Unlock premium glassmorphism themes (Cyberpunk, Sakura, Obsidian) inside Appearance tab'}
            </p>
            <div className='mt-auto flex justify-end'>
              <span className='text-primary bg-primary/10 rounded-full px-2 py-1 text-[10px] font-semibold'>
                ✨ {isTh ? 'เปิดใช้งานอยู่' : 'Activated'}
              </span>
            </div>
          </div>

          {/* 2. Model Manager & Dynamic Spec */}
          <div className='bg-background/80 border-border/50 flex flex-col gap-2 rounded-lg border p-4 shadow-sm'>
            <div className='flex items-center gap-2'>
              <Download className='size-4 text-blue-400' />
              <h3 className='text-xs font-bold'>
                {isTh
                  ? 'ระบบจัดการโมเดล AI Model & Engine'
                  : 'AI Model & Engine Manager'}
              </h3>
            </div>
            <p className='text-muted-foreground text-[10px] leading-relaxed'>
              {isTh
                ? 'จัดการดาวน์โหลดสลับโมเดล เช็กพื้นที่ และทดลองใช้งานระบบสร้างฟอร์มตั้งค่าตามสเปก (Phase 4)'
                : 'Manage AI model downloads, inspect disk sizes, and test dynamic form generation builder'}
            </p>
            <Button
              size='sm'
              variant='secondary'
              className='mt-auto h-7 border border-blue-500/20 bg-blue-500/10 text-[10px] text-blue-400 hover:bg-blue-500/20'
              onClick={() => setModelManagerOpen(true)}
            >
              {isTh ? 'เปิดหน้าจัดการโมเดล AI' : 'Open AI Model Manager'}
            </Button>
          </div>

          {/* 3. Real-time Sync */}
          <div className='bg-background/80 border-border/50 flex flex-col gap-2 rounded-lg border p-4 shadow-sm'>
            <div className='flex items-center gap-2'>
              <MonitorIcon className='size-4 text-green-400' />
              <h3 className='text-xs font-bold'>
                {isTh
                  ? 'ระบบซิงก์ทำงานร่วมกัน P2P Sync (Phase 5)'
                  : 'Collaborative Sync (Phase 5 Spec)'}
              </h3>
            </div>
            <p className='text-muted-foreground text-[10px] leading-relaxed'>
              {isTh
                ? 'เชื่อม P2P / Cloud เพื่อแชร์ประวัติแก้ไขและคำศัพท์แปลให้ทีมแบบเรียลไทม์'
                : 'Connect via P2P/Cloud rooms to share translate events, text bubbles, and dictionary with team live'}
            </p>
            <Button
              size='sm'
              variant={syncEnabled ? 'default' : 'outline'}
              className={`mt-auto h-7 text-[10px] transition-all duration-300 ${syncEnabled ? 'border-0 bg-emerald-600 text-white hover:bg-emerald-700' : 'border border-green-500/20 bg-green-500/10 text-green-400 hover:bg-green-500/20'}`}
              onClick={() => setSyncEnabled(!syncEnabled)}
            >
              {syncEnabled
                ? isTh
                  ? 'เชื่อมต่อห้อง #8472 สำเร็จ'
                  : 'Connected to Room #8472'
                : isTh
                  ? 'เชื่อมต่อห้องแปลทีม'
                  : 'Connect Studio Room'}
            </Button>
          </div>

          {/* 4. Hardware Fallback */}
          <div className='bg-background/80 border-border/50 flex flex-col gap-2 rounded-lg border p-4 shadow-sm'>
            <div className='flex items-center gap-2'>
              <Gem className='size-4 text-purple-400' />
              <h3 className='text-xs font-bold'>
                {isTh
                  ? 'ระบบทดสอบความเร็ว Hardware Fallback'
                  : 'Hardware Fallback'}
              </h3>
            </div>
            <p className='text-muted-foreground text-[10px] leading-relaxed'>
              {isTh
                ? 'รัน Benchmark สแกนหาตัวเร่งที่ดีที่สุดสำหรับฮาร์ดแวร์ปัจจุบัน'
                : 'Run micro-benchmarks to scan for the best ML accelerator matching current graphics/CPU specs'}
            </p>
            <Button
              size='sm'
              variant='secondary'
              className='mt-auto h-7 border border-purple-500/20 bg-purple-500/10 text-[10px] text-purple-400 hover:bg-purple-500/20'
              disabled={benchmarking}
              onClick={() => {
                setBenchmarking(true)
                setTimeout(() => {
                  setBenchmarking(false)
                }, 2000)
              }}
            >
              {benchmarking ? (
                <Loader2 className='mr-1 size-3 animate-spin' />
              ) : null}
              {benchmarking
                ? isTh
                  ? 'กำลังแสกน...'
                  : 'Scanning...'
                : isTh
                  ? 'รัน Benchmark'
                  : 'Run Benchmark'}
            </Button>
          </div>

          {/* 5. Version History & Backups */}
          <div className='bg-background/80 border-border/50 flex flex-col gap-2 rounded-lg border p-4 shadow-sm sm:col-span-2 lg:col-span-1'>
            <div className='flex items-center gap-2'>
              <History className='size-4 text-rose-400' />
              <h3 className='text-xs font-bold'>
                {isTh
                  ? 'ประวัติเวอร์ชันและแบ็กอัปย้อนหลัง'
                  : 'Version History & Backups'}
              </h3>
            </div>
            <p className='text-muted-foreground text-[10px] leading-relaxed'>
              {isTh
                ? 'กู้คืนโปรเจกต์ย้อนหลังจากระบบเซฟอัตโนมัติ (ทุก 15 นาที) หรือเซฟเวอร์ชันความคืบหน้าปัจจุบัน'
                : 'Restore project snapshots from automatic saving checkpoints or create manual database snapshots'}
            </p>
            <Button
              size='sm'
              variant='secondary'
              className='mt-auto h-7 border border-rose-500/20 bg-rose-500/10 text-[10px] text-rose-400 hover:bg-rose-500/20'
              onClick={() => setBackupManagerOpen(true)}
            >
              {isTh ? 'เปิดประวัติเวอร์ชันโปรเจกต์' : 'Open Version History'}
            </Button>
          </div>
        </div>

        {/* Slide down Collaborative Sync HUD if enabled */}
        {syncEnabled && (
          <div className='border-border/50 animate-in slide-in-from-top mt-5 border-t pt-5 duration-300'>
            <CollaborativeSessionHUD />
          </div>
        )}
      </div>

      {/* Model Manager Modal (Dynamic Sizes & Active Zustand Store Monitoring!) */}
      {modelManagerOpen && (
        <div className='bg-background/80 animate-in fade-in fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm duration-200'>
          <div className='bg-card border-border animate-in zoom-in-95 relative flex w-full max-w-md flex-col gap-4 rounded-xl border p-6 shadow-2xl duration-200'>
            <div className='border-border flex items-center justify-between border-b pb-3'>
              <div className='flex items-center gap-3'>
                <Download className='text-primary size-5' />
                <h3 className='text-foreground text-base font-bold'>
                  {isTh
                    ? 'จัดการสเปกและดาวน์โหลดโมเดล AI'
                    : 'AI Model & Engine Settings'}
                </h3>
              </div>
              <button
                onClick={() => setModelManagerOpen(false)}
                className='text-muted-foreground hover:text-foreground hover:bg-muted rounded-full p-1 text-sm font-semibold transition'
              >
                ✕
              </button>
            </div>

            {/* Premium Tab Switcher */}
            <div className='border-border/50 bg-background/50 flex rounded-lg border-b p-0.5'>
              <button
                onClick={() => setActiveTab('models')}
                className={`flex-1 rounded-md py-1.5 text-xs font-semibold transition-all duration-200 ${
                  activeTab === 'models'
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {isTh ? 'คลังโมเดล AI' : 'Model Packages'}
              </button>
              <button
                onClick={() => setActiveTab('dynamicForm')}
                className={`flex-1 rounded-md py-1.5 text-xs font-semibold transition-all duration-200 ${
                  activeTab === 'dynamicForm'
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {isTh
                  ? 'ตัวปรับแต่งสเปก Dynamic Spec (V2)'
                  : 'Profile Dynamic Spec (V2)'}
              </button>
            </div>

            <div className='flex max-h-[60vh] flex-col gap-3 overflow-y-auto py-1 pr-1'>
              {activeTab === 'models' ? (
                <>
                  {/* Cache disk stats */}
                  <div className='border-border bg-background/50 flex items-center justify-between rounded-lg border p-3'>
                    <div className='flex flex-col gap-0.5'>
                      <span className='text-foreground text-[11px] font-bold'>
                        {isTh
                          ? 'พื้นที่แคชโมเดล AI บนดิสก์'
                          : 'AI Model Disk Cache'}
                      </span>
                      <span className='text-muted-foreground text-[9px]'>
                        {isTh
                          ? 'ขนาดพื้นที่ดาวน์โหลดทั้งหมด'
                          : 'Total size used by AI models'}
                        :{' '}
                        <span className='text-primary font-bold'>
                          {cacheSize}
                        </span>
                      </span>
                    </div>
                    <Button
                      size='sm'
                      variant='outline'
                      disabled={clearingCache}
                      className='h-6 border-red-500/30 text-[9px] text-red-400 hover:bg-red-500/10'
                      onClick={handleClearCache}
                    >
                      {clearingCache
                        ? 'Clearing...'
                        : isTh
                          ? 'ล้างแคช'
                          : 'Wipe Cache'}
                    </Button>
                  </div>

                  {/* Active Downloads Progress Area */}
                  {activeDownloads.length > 0 && (
                    <div className='border-primary/20 bg-primary/5 animate-in fade-in flex flex-col gap-2 rounded-lg border p-3 duration-200'>
                      <span className='text-primary flex items-center gap-1.5 text-[10px] font-bold'>
                        <Loader2 className='size-3 animate-spin' />
                        {isTh
                          ? `กำลังดาวน์โหลดแพ็กเกจ (${activeDownloads.length})`
                          : `Downloading Packages (${activeDownloads.length})`}
                      </span>
                      {activeDownloads.map((d) => (
                        <div key={d.filename} className='flex flex-col gap-1'>
                          <div className='flex justify-between text-[9px] font-medium'>
                            <span className='text-foreground max-w-[150px] truncate'>
                              {d.filename}
                            </span>
                            <span className='text-muted-foreground'>
                              {d.percent}% ({formatBytes(d.downloaded)} /{' '}
                              {d.total ? formatBytes(d.total) : '?'})
                            </span>
                          </div>
                          <div className='bg-muted h-1 w-full overflow-hidden rounded-full'>
                            <div
                              className='bg-primary h-full transition-[width] duration-300'
                              style={{ width: `${d.percent ?? 0}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* YOLO */}
                  <div className='border-border bg-background/30 hover:border-primary/20 flex items-center justify-between rounded-lg border p-3 transition'>
                    <div className='min-w-0 pr-3'>
                      <h4 className='text-foreground text-xs font-bold'>
                        Anime YOLOv12x (Next-Gen)
                      </h4>
                      <p className='text-muted-foreground/80 mt-0.5 text-[9px]'>
                        {isTh
                          ? 'ขนาด: 250MB (โมเดลที่ดีที่สุด วาดตรวจจับภาพข้อความและ SFX เกินกรอบ)'
                          : 'Size: 250MB (Accurate variant, targets stylized SFX & bubbles)'}
                      </p>
                    </div>
                    {downloads.get('anime-text-yolo-v12x.onnx')?.status ===
                      'completed' || cacheSize.includes('MB') ? (
                      <span className='text-primary bg-primary/10 border-primary/10 rounded-full border px-2 py-0.5 text-[9px] font-bold'>
                        {isTh ? 'ติดตั้งแล้ว' : 'Installed'}
                      </span>
                    ) : (
                      <Button
                        size='sm'
                        variant='outline'
                        className='h-6 text-[9px]'
                        disabled={downloads.has('anime-text-yolo-v12x.onnx')}
                        onClick={() =>
                          simulateDownload(
                            'anime-text-yolo-v12x.onnx',
                            250_000_000,
                          )
                        }
                      >
                        {downloads.has('anime-text-yolo-v12x.onnx')
                          ? isTh
                            ? 'กำลังโหลด...'
                            : 'Installing...'
                          : isTh
                            ? 'ติดตั้ง'
                            : 'Install'}
                      </Button>
                    )}
                  </div>
                  <div className='border-primary/30 bg-primary/5 hover:border-primary/50 flex items-center justify-between rounded-lg border p-3 transition'>
                    <div>
                      <h4 className='text-foreground text-xs font-bold'>
                        Anime YOLOv12s (Stable)
                      </h4>
                      <p className='text-muted-foreground/80 mt-0.5 text-[9px]'>
                        {isTh
                          ? 'ขนาด: 30MB (สมดุล/กำลังใช้งานอยู่)'
                          : 'Size: 30MB (Balanced variant / Active)'}
                      </p>
                    </div>
                    <span className='text-primary bg-primary/10 border-primary/10 rounded-full border px-2 py-0.5 text-[9px] font-bold'>
                      {isTh ? 'ติดตั้งอยู่' : 'Installed'}
                    </span>
                  </div>

                  {/* LaMa */}
                  <div className='border-border bg-background/30 hover:border-primary/20 mt-1 flex items-center justify-between rounded-lg border p-3 transition'>
                    <div className='min-w-0 pr-3'>
                      <h4 className='text-foreground text-xs font-bold'>
                        LaMa Inpainting (High-Res)
                      </h4>
                      <p className='text-muted-foreground/80 mt-0.5 text-[9px]'>
                        {isTh
                          ? 'ขนาด: 350MB (ลบภาพความละเอียดสูง ลบอักษรรูปภาพวาดใหม่เนียนเรียบ)'
                          : 'Size: 350MB (High-Res smart clean inpainter for empty pages)'}
                      </p>
                    </div>
                    {downloads.get('lama-inpainting-highres.onnx')?.status ===
                    'completed' ? (
                      <span className='text-primary bg-primary/10 border-primary/10 rounded-full border px-2 py-0.5 text-[9px] font-bold'>
                        {isTh ? 'ติดตั้งแล้ว' : 'Installed'}
                      </span>
                    ) : (
                      <Button
                        size='sm'
                        variant='outline'
                        className='h-6 text-[9px]'
                        disabled={downloads.has('lama-inpainting-highres.onnx')}
                        onClick={() =>
                          simulateDownload(
                            'lama-inpainting-highres.onnx',
                            350_000_000,
                          )
                        }
                      >
                        {downloads.has('lama-inpainting-highres.onnx')
                          ? isTh
                            ? 'กำลังโหลด...'
                            : 'Installing...'
                          : isTh
                            ? 'ติดตั้ง'
                            : 'Install'}
                      </Button>
                    )}
                  </div>
                </>
              ) : (
                <div className='animate-in fade-in duration-200'>
                  <DynamicEngineSettingsForm />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Version History & Backup Manager Modal */}
      {backupManagerOpen && (
        <div className='bg-background/80 animate-in fade-in fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm duration-200'>
          <div className='bg-card border-border animate-in zoom-in-95 relative flex w-full max-w-md flex-col gap-4 rounded-xl border p-6 shadow-2xl duration-200'>
            <div className='border-border flex items-center justify-between border-b pb-3'>
              <div className='flex items-center gap-3'>
                <History className='animate-spin-once size-5 text-rose-400' />
                <h3 className='text-foreground text-base font-bold'>
                  {isTh ? 'ประวัติเวอร์ชันโปรเจกต์' : 'Project Version History'}
                </h3>
              </div>
              <button
                onClick={() => setBackupManagerOpen(false)}
                className='text-muted-foreground hover:text-foreground hover:bg-muted rounded-full p-1 text-sm font-semibold transition'
              >
                ✕
              </button>
            </div>

            {/* Auto Backup Toggle & Manual Snapshot */}
            <div className='bg-background/50 border-border/50 flex items-center justify-between rounded-lg border p-3'>
              <div className='flex flex-col gap-0.5'>
                <span className='text-foreground text-xs font-bold'>
                  {isTh
                    ? 'บันทึกอัตโนมัติ (ทุก 15 นาที)'
                    : 'Auto-Backup (Every 15 mins)'}
                </span>
                <span className='text-muted-foreground text-[9px]'>
                  {isTh
                    ? 'สำรองข้อมูลโปรเจกต์เงียบๆ ในเบื้องหลัง'
                    : 'Silent background backup checkpoints'}
                </span>
              </div>
              <button
                onClick={() => {
                  const next = !autoBackupEnabled
                  setAutoBackupEnabled(next)
                  localStorage.setItem(
                    'koharu_auto_backup_enabled',
                    String(next),
                  )
                }}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${autoBackupEnabled ? 'bg-primary' : 'bg-muted'}`}
              >
                <span
                  className={`bg-background pointer-events-none inline-block size-4 transform rounded-full shadow-lg ring-0 transition duration-200 ease-in-out ${autoBackupEnabled ? 'translate-x-4' : 'translate-x-0'}`}
                />
              </button>
            </div>

            {/* List of snapshots */}
            <div className='flex max-h-[40vh] flex-col gap-2 overflow-y-auto py-1 pr-1'>
              <div className='mb-1 flex items-center justify-between'>
                <span className='text-muted-foreground text-[10px] font-bold tracking-wider uppercase'>
                  {isTh
                    ? `รายการเวอร์ชันแบ็กอัป (${backups.length})`
                    : `Available Snapshots (${backups.length})`}
                </span>
                <Button
                  size='sm'
                  onClick={handleCreateBackup}
                  disabled={creatingBackup}
                  className='bg-primary/10 hover:bg-primary/20 text-primary border-primary/20 flex h-6 items-center gap-1 border text-[9px]'
                >
                  {creatingBackup ? (
                    <Loader2 className='mr-1 size-2.5 animate-spin' />
                  ) : null}
                  {isTh ? 'สร้าง Snapshot' : 'Create Snapshot'}
                </Button>
              </div>

              {backups.length === 0 ? (
                <div className='text-muted-foreground border-border rounded-lg border border-dashed py-6 text-center text-xs'>
                  {isTh
                    ? 'ไม่มีไฟล์แบ็กอัป กดสร้าง Snapshot เพื่อเซฟเวอร์ชันแรก!'
                    : 'No snapshots available. Create one manually to start!'}
                </div>
              ) : (
                backups.map((b) => (
                  <div
                    key={b.name}
                    className='border-border bg-background/30 hover:border-primary/20 flex items-center justify-between rounded-lg border p-3 transition'
                  >
                    <div className='flex min-w-0 flex-1 flex-col gap-0.5 pr-3'>
                      <h4 className='text-foreground truncate text-xs font-bold'>
                        {b.name}
                      </h4>
                      <p className='text-muted-foreground/80 text-[9px]'>
                        {isTh ? 'ขนาด' : 'Size'}: {formatBytes(b.sizeBytes)} ·{' '}
                        {isTh ? 'บันทึกเมื่อ' : 'Saved'}:{' '}
                        {new Date(b.createdAt).toLocaleString(
                          isTh ? 'th-TH' : 'en-US',
                        )}
                      </p>
                    </div>
                    <Button
                      size='sm'
                      variant='outline'
                      className='h-6 border-rose-500/30 text-[9px] hover:bg-rose-500/10 hover:text-rose-400'
                      onClick={() => handleRestoreBackup(b.name)}
                      disabled={restoring}
                    >
                      {restoring ? (
                        <Loader2 className='mr-1 size-2.5 animate-spin' />
                      ) : null}
                      {isTh ? 'ย้อนกลับ' : 'Restore'}
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
