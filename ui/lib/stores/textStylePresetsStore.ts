'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { TextStyle } from '@/types'

/**
 * Saved text-style presets + a machine-wide "default style for new
 * blocks". Persisted to localStorage (machine-wide, same convention as
 * preferencesStore / the engine profile) — presets are an editor habit,
 * not per-project data, so they follow the user across projects.
 *
 * A preset stores a full `TextStyle` snapshot. `defaultPresetId` marks
 * the preset that newly-created text blocks inherit (see
 * useTextBlocks.appendBlock).
 */
export type StylePreset = {
  id: string
  name: string
  style: TextStyle
}

type TextStylePresetsState = {
  presets: StylePreset[]
  /** Preset auto-applied to new blocks; null = leave new blocks unstyled. */
  defaultPresetId: string | null

  addPreset: (name: string, style: TextStyle) => string
  updatePreset: (id: string, style: TextStyle) => void
  renamePreset: (id: string, name: string) => void
  removePreset: (id: string) => void
  setDefault: (id: string | null) => void
  /** Resolve the default preset's style, if one is set + still exists. */
  getDefaultStyle: () => TextStyle | undefined
}

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

export const useTextStylePresetsStore = create<TextStylePresetsState>()(
  persist(
    (set, get) => ({
      presets: [],
      defaultPresetId: null,

      addPreset: (name, style) => {
        const id = newId()
        set((s) => ({
          presets: [...s.presets, { id, name, style: { ...style } }],
        }))
        return id
      },

      updatePreset: (id, style) =>
        set((s) => ({
          presets: s.presets.map((p) =>
            p.id === id ? { ...p, style: { ...style } } : p,
          ),
        })),

      renamePreset: (id, name) =>
        set((s) => ({
          presets: s.presets.map((p) => (p.id === id ? { ...p, name } : p)),
        })),

      removePreset: (id) =>
        set((s) => ({
          presets: s.presets.filter((p) => p.id !== id),
          defaultPresetId:
            s.defaultPresetId === id ? null : s.defaultPresetId,
        })),

      setDefault: (id) => set({ defaultPresetId: id }),

      getDefaultStyle: () => {
        const { presets, defaultPresetId } = get()
        if (!defaultPresetId) return undefined
        const preset = presets.find((p) => p.id === defaultPresetId)
        return preset ? { ...preset.style } : undefined
      },
    }),
    { name: 'koharu-text-style-presets' },
  ),
)
