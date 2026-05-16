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
import { Input } from '@/components/ui/input'
import { invoke, isTauri } from '@/lib/backend'
import type { DeviceInfo } from '@/lib/rpc-types'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'

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
  const {
    cloudProvider,
    setCloudProvider,
    cloudApiKey,
    setCloudApiKey,
    cloudApiUrl,
    setCloudApiUrl,
    cloudModelName,
    setCloudModelName,
  } = usePreferencesStore()

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
      <ScrollArea className='flex-1'>
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

            {/* Cloud AI Section */}
            <section className='mb-8'>
              <h2 className='text-foreground mb-1 text-sm font-bold'>
                {t('settings.cloudAi', 'Cloud AI')}
              </h2>
              <p className='text-muted-foreground mb-4 text-sm'>
                {t('settings.cloudAiDescription', 'Configure an external API provider for LLM translation. Leave as "None" to use local models.')}
              </p>

              <div className='bg-card border-border rounded-lg border p-4 space-y-4'>
                <div className='flex flex-col gap-1.5'>
                  <label className='text-foreground text-xs font-semibold'>
                    {t('settings.cloudProvider', 'Provider')}
                  </label>
                  <Select
                    value={cloudProvider}
                    onValueChange={(value: any) => setCloudProvider(value)}
                  >
                    <SelectTrigger className='w-full'>
                      <SelectValue placeholder="Select Provider" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None (Local LLM)</SelectItem>
                      <SelectItem value="openai">OpenAI (or Compatible)</SelectItem>
                      <SelectItem value="gemini">Google Gemini</SelectItem>
                      <SelectItem value="anthropic">Anthropic Claude</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {cloudProvider !== 'none' && (
                  <>
                    <div className='flex flex-col gap-1.5'>
                      <label className='text-foreground text-xs font-semibold'>
                        {t('settings.cloudApiKey', 'API Key')}
                      </label>
                      <Input
                        type="password"
                        placeholder="sk-..."
                        value={cloudApiKey}
                        onChange={(e) => setCloudApiKey(e.target.value)}
                        className='text-xs'
                      />
                    </div>
                    
                    <div className='flex flex-col gap-1.5'>
                      <label className='text-foreground text-xs font-semibold'>
                        {t('settings.cloudModelName', 'Model Name')}
                      </label>
                      <Input
                        type="text"
                        placeholder={cloudProvider === 'openai' ? 'gpt-4o' : cloudProvider === 'gemini' ? 'gemini-2.5-pro' : 'claude-3-5-sonnet'}
                        value={cloudModelName}
                        onChange={(e) => setCloudModelName(e.target.value)}
                        className='text-xs'
                      />
                    </div>

                    {cloudProvider === 'openai' && (
                      <div className='flex flex-col gap-1.5'>
                        <label className='text-foreground text-xs font-semibold'>
                          {t('settings.cloudApiUrl', 'API Base URL')}
                        </label>
                        <Input
                          type="text"
                          placeholder="https://api.openai.com/v1"
                          value={cloudApiUrl}
                          onChange={(e) => setCloudApiUrl(e.target.value)}
                          className='text-xs'
                        />
                        <span className='text-muted-foreground text-[10px]'>
                          {t('settings.cloudApiUrlHint', 'Default: https://api.openai.com/v1. Change this to use OpenAI-compatible endpoints like OpenRouter or local servers.')}
                        </span>
                      </div>
                    )}
                  </>
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
