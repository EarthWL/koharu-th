'use client'

import { create } from 'zustand'
import { RenderEffect, RenderStroke, ToolMode, TextStyle } from '@/types'

type EditorUiState = {
  totalPages: number
  documentsVersion: number
  currentDocumentIndex: number
  scale: number
  showSegmentationMask: boolean
  showInpaintedImage: boolean
  showBrushLayer: boolean
  showRenderedImage: boolean
  showTextBlocksOverlay: boolean
  mode: ToolMode
  selectedBlockIndex?: number
  autoFitEnabled: boolean
  renderEffect: RenderEffect
  renderStroke: RenderStroke
  readingOrder: 'rtl' | 'ltr' | 'custom'
  copiedStyle?: TextStyle
  hudMessage?: string
  setTotalPages: (count: number) => void
  setCurrentDocumentIndex: (index: number) => void
  setScale: (scale: number) => void
  setShowSegmentationMask: (show: boolean) => void
  setShowInpaintedImage: (show: boolean) => void
  setShowBrushLayer: (show: boolean) => void
  setShowRenderedImage: (show: boolean) => void
  setShowTextBlocksOverlay: (show: boolean) => void
  setMode: (mode: ToolMode) => void
  setSelectedBlockIndex: (index?: number) => void
  setAutoFitEnabled: (enabled: boolean) => void
  setRenderEffect: (effect: RenderEffect) => void
  setRenderStroke: (stroke: RenderStroke) => void
  setReadingOrder: (order: 'rtl' | 'ltr' | 'custom') => void
  setCopiedStyle: (style?: TextStyle) => void
  setHudMessage: (msg?: string) => void
  showHud: (msg: string) => void
  hideHud: () => void
  resetUiState: () => void
}

const initialState = {
  totalPages: 0,
  documentsVersion: 0,
  currentDocumentIndex: 0,
  scale: 100,
  showSegmentationMask: false,
  showInpaintedImage: false,
  showBrushLayer: false,
  showRenderedImage: false,
  showTextBlocksOverlay: false,
  mode: 'select' as ToolMode,
  selectedBlockIndex: undefined,
  autoFitEnabled: true,
  renderEffect: {
    italic: false,
    bold: false,
    fauxItalic: false,
    fauxBold: false,
  } as RenderEffect,
  renderStroke: {
    enabled: true,
    color: [255, 255, 255, 255],
    widthPx: undefined,
  } as RenderStroke,
  readingOrder: 'rtl' as const,
}

export const useEditorUiStore = create<EditorUiState>((set, get) => ({
  ...initialState,
  setTotalPages: (count) => {
    set((state) => {
      if (state.totalPages === count) return state
      return {
        totalPages: count,
        documentsVersion: state.documentsVersion + 1,
        currentDocumentIndex: 0,
        selectedBlockIndex: undefined,
      }
    })
  },
  setCurrentDocumentIndex: (index) =>
    set(() => ({
      currentDocumentIndex: index,
      selectedBlockIndex: undefined,
    })),
  setScale: (scale) => {
    const clamped = Math.max(10, Math.min(300, Math.round(scale)))
    set({ scale: clamped })
  },
  setShowSegmentationMask: (show) => set({ showSegmentationMask: show }),
  setShowInpaintedImage: (show) => set({ showInpaintedImage: show }),
  setShowBrushLayer: (show) => set({ showBrushLayer: show }),
  setShowRenderedImage: (show) => set({ showRenderedImage: show }),
  setShowTextBlocksOverlay: (show) => set({ showTextBlocksOverlay: show }),
  setMode: (mode) => {
    set({ mode })

    if (mode === 'repairBrush' || mode === 'brush' || mode === 'eraser') {
      set({
        showRenderedImage: false,
        showInpaintedImage: true,
      })
    }

    if (mode === 'repairBrush') {
      set({
        showTextBlocksOverlay: true,
        showSegmentationMask: true,
        showBrushLayer: false,
      })
    } else if (mode !== 'eraser') {
      set({ showSegmentationMask: false })

      if (mode === 'brush') {
        set({
          showBrushLayer: true,
        })
      } else if (mode === 'block') {
        set({
          showTextBlocksOverlay: true,
        })
      }
    }
  },
  setSelectedBlockIndex: (index) => set({ selectedBlockIndex: index }),
  setAutoFitEnabled: (enabled) => set({ autoFitEnabled: enabled }),
  setRenderEffect: (effect) => set({ renderEffect: effect }),
  setRenderStroke: (stroke) => set({ renderStroke: stroke }),
  setReadingOrder: (order) => set({ readingOrder: order }),
  setCopiedStyle: (style) => set({ copiedStyle: style }),
  setHudMessage: (msg) => set({ hudMessage: msg }),
  showHud: (msg) => {
    const state = get() as any
    if (state.hudTimeoutId) {
      clearTimeout(state.hudTimeoutId)
    }
    const timeoutId = setTimeout(() => {
      set({ hudMessage: undefined, hudTimeoutId: undefined } as any)
    }, 500)
    set({ hudMessage: msg, hudTimeoutId: timeoutId } as any)
  },
  hideHud: () => {
    const state = get() as any
    if (state.hudTimeoutId) {
      clearTimeout(state.hudTimeoutId)
    }
    set({ hudMessage: undefined, hudTimeoutId: undefined } as any)
  },
  resetUiState: () =>
    set(() => ({
      ...initialState,
      totalPages: get().totalPages,
      documentsVersion: get().documentsVersion,
      currentDocumentIndex: get().currentDocumentIndex,
    })),
}))
