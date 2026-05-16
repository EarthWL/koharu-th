'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type CloudProvider = 'none' | 'openai' | 'openrouter' | 'gemini' | 'anthropic'

/** Per-provider wire config. Each provider keeps its own slot so the
 *  user can switch providers without re-pasting keys. */
export type ProviderConfig = {
  apiKey: string
  modelName: string
  /** Base URL — only meaningful for `openai` (compatible endpoints).
   *  Other providers ignore this and we just keep the field empty. */
  apiUrl: string
}

type ProviderConfigs = Record<
  Exclude<CloudProvider, 'none'>,
  ProviderConfig
>

const DEFAULT_CONFIGS: ProviderConfigs = {
  openai: {
    apiKey: '',
    modelName: 'gpt-4o-mini',
    apiUrl: 'https://api.openai.com/v1',
  },
  openrouter: { apiKey: '', modelName: '', apiUrl: '' },
  gemini: { apiKey: '', modelName: 'gemini-2.5-flash', apiUrl: '' },
  anthropic: {
    apiKey: '',
    modelName: 'claude-3-5-sonnet-latest',
    apiUrl: '',
  },
}

type PreferencesState = {
  brushConfig: {
    size: number
    color: string
  }
  setBrushConfig: (config: Partial<PreferencesState['brushConfig']>) => void
  fontFamily?: string
  setFontFamily: (font?: string) => void

  /** Currently active provider. The legacy `cloudApiKey` / `cloudApiUrl` /
   *  `cloudModelName` fields below are a derived view of
   *  `providerConfigs[cloudProvider]` for backward compat with existing
   *  callers — setters write through to the per-provider record. */
  cloudProvider: CloudProvider
  setCloudProvider: (provider: CloudProvider) => void

  /** Per-provider stash. Survives provider switches. */
  providerConfigs: ProviderConfigs

  cloudApiKey: string
  setCloudApiKey: (key: string) => void
  cloudApiUrl: string
  setCloudApiUrl: (url: string) => void
  cloudModelName: string
  setCloudModelName: (name: string) => void

  cloudTargetLanguage: string
  setCloudTargetLanguage: (language: string) => void
  resetPreferences: () => void
}

const initialPreferences = {
  brushConfig: { size: 36, color: '#ffffff' },
  fontFamily: undefined as string | undefined,
  cloudProvider: 'none' as CloudProvider,
  providerConfigs: DEFAULT_CONFIGS,
  cloudApiKey: '',
  cloudApiUrl: DEFAULT_CONFIGS.openai.apiUrl,
  cloudModelName: '',
  cloudTargetLanguage: 'Thai',
}

/**
 * Pull the active provider's config into the legacy mirror fields.
 * `none` resolves to empty strings — there's nothing to mirror.
 */
function activeMirror(
  configs: ProviderConfigs,
  provider: CloudProvider,
): Pick<PreferencesState, 'cloudApiKey' | 'cloudApiUrl' | 'cloudModelName'> {
  if (provider === 'none') {
    return { cloudApiKey: '', cloudApiUrl: '', cloudModelName: '' }
  }
  const c = configs[provider]
  return {
    cloudApiKey: c.apiKey,
    cloudApiUrl: c.apiUrl,
    cloudModelName: c.modelName,
  }
}

/** Write a delta back into the per-provider record. No-op for 'none'. */
function patchConfig(
  configs: ProviderConfigs,
  provider: CloudProvider,
  patch: Partial<ProviderConfig>,
): ProviderConfigs {
  if (provider === 'none') return configs
  return {
    ...configs,
    [provider]: { ...configs[provider], ...patch },
  }
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      ...initialPreferences,
      setBrushConfig: (config) =>
        set((state) => ({
          brushConfig: { ...state.brushConfig, ...config },
        })),
      setFontFamily: (font) => set({ fontFamily: font }),

      setCloudProvider: (provider) =>
        set((state) => ({
          cloudProvider: provider,
          ...activeMirror(state.providerConfigs, provider),
        })),

      setCloudApiKey: (key) =>
        set((state) => ({
          cloudApiKey: key,
          providerConfigs: patchConfig(
            state.providerConfigs,
            state.cloudProvider,
            { apiKey: key },
          ),
        })),
      setCloudApiUrl: (url) =>
        set((state) => ({
          cloudApiUrl: url,
          providerConfigs: patchConfig(
            state.providerConfigs,
            state.cloudProvider,
            { apiUrl: url },
          ),
        })),
      setCloudModelName: (name) =>
        set((state) => ({
          cloudModelName: name,
          providerConfigs: patchConfig(
            state.providerConfigs,
            state.cloudProvider,
            { modelName: name },
          ),
        })),

      setCloudTargetLanguage: (language) =>
        set({ cloudTargetLanguage: language }),
      resetPreferences: () => set({ ...initialPreferences }),
    }),
    {
      name: 'koharu-config',
      version: 2,
      migrate: (persisted: any, fromVersion) => {
        // V1 stored a single (cloudApiKey, cloudApiUrl, cloudModelName)
        // shared across providers. Push that record into the slot for
        // whichever provider was active so the user doesn't lose it.
        if (!persisted || typeof persisted !== 'object') return persisted
        const next = { ...persisted }
        if (fromVersion < 2) {
          const configs: ProviderConfigs = { ...DEFAULT_CONFIGS }
          const activeProvider = (persisted.cloudProvider ?? 'none') as CloudProvider
          if (activeProvider !== 'none') {
            configs[activeProvider] = {
              apiKey: persisted.cloudApiKey ?? '',
              modelName:
                persisted.cloudModelName ?? DEFAULT_CONFIGS[activeProvider].modelName,
              apiUrl: persisted.cloudApiUrl ?? DEFAULT_CONFIGS[activeProvider].apiUrl,
            }
          }
          next.providerConfigs = configs
          // Re-mirror to the legacy fields too.
          Object.assign(next, activeMirror(configs, activeProvider))
        }
        return next
      },
    },
  ),
)
