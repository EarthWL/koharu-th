'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type CloudProvider = 'none' | 'openai' | 'openrouter' | 'gemini' | 'anthropic'

type PreferencesState = {
  brushConfig: {
    size: number
    color: string
  }
  setBrushConfig: (config: Partial<PreferencesState['brushConfig']>) => void
  fontFamily?: string
  setFontFamily: (font?: string) => void
  cloudProvider: CloudProvider
  setCloudProvider: (provider: CloudProvider) => void
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
  brushConfig: {
    size: 36,
    color: '#ffffff',
  },
  fontFamily: undefined as string | undefined,
  cloudProvider: 'none' as CloudProvider,
  cloudApiKey: '',
  cloudApiUrl: 'https://api.openai.com/v1',
  cloudModelName: 'gpt-4o',
  cloudTargetLanguage: 'Thai',
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      ...initialPreferences,
      setBrushConfig: (config) =>
        set((state) => ({
          brushConfig: {
            ...state.brushConfig,
            ...config,
          },
        })),
      setFontFamily: (font) => set({ fontFamily: font }),
      setCloudProvider: (provider) => set({ cloudProvider: provider }),
      setCloudApiKey: (key) => set({ cloudApiKey: key }),
      setCloudApiUrl: (url) => set({ cloudApiUrl: url }),
      setCloudModelName: (name) => set({ cloudModelName: name }),
      setCloudTargetLanguage: (language) => set({ cloudTargetLanguage: language }),
      resetPreferences: () => set({ ...initialPreferences }),
    }),
    {
      name: 'koharu-config',
    },
  ),
)
