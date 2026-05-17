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
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { supportsVision } from '@/lib/services/visionSupport'
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
  const detectorEngine = usePreferencesStore((s) => s.detectorEngine)
  const setDetectorEngine = usePreferencesStore((s) => s.setDetectorEngine)
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
    (p) =>
      supportsVision(effectiveProvider(p), p.modelName).supported,
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

              <div className='bg-card border-border rounded-lg border p-4'>
                <div className='grid grid-cols-[max-content_1fr] items-center gap-x-6 gap-y-3 text-sm'>
                  <label className='text-muted-foreground'>
                    {t('settings.engineDetector', 'Detector')}
                  </label>
                  <Select
                    value={detectorEngine}
                    onValueChange={(v) =>
                      setDetectorEngine(v as 'default' | 'anime_yolo')
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='default'>
                        Default (comic_text_detector · DBNet + UNet, tuned for in-bubble text)
                      </SelectItem>
                      <SelectItem value='anime_yolo'>
                        Anime Text YOLO (mayocream/anime-text-yolo · catches SFX / titles, ~10MB first-use download)
                      </SelectItem>
                    </SelectContent>
                  </Select>

                  <label className='text-muted-foreground'>
                    {t('settings.engineOcr', 'OCR')}
                  </label>
                  <Select
                    value={ocrEngine}
                    onValueChange={(v) =>
                      setOcrEngine(v as 'mit48px' | 'manga' | 'cloud')
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
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
                <p className='text-muted-foreground/70 mt-3 text-xs'>
                  {ocrEngine === 'cloud'
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
                    <p className='text-amber-600 dark:text-amber-400 mt-2 text-xs'>
                      ⚠ No vision-capable profile available. Open Sidebar →
                      Profiles, add an OpenAI / Claude / Gemini / OpenRouter
                      profile with a vision-capable model (e.g. gpt-4o,
                      claude-3.5-sonnet, gemini-2.0-flash) and click Apply,
                      then come back here.
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
