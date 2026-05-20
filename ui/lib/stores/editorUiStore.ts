'use client'

import { create } from 'zustand'
import { RenderEffect, RenderStroke, ToolMode, TextStyle, TextBlock } from '@/types'

export type HistoryStep = {
  id: string
  name: string
  blocks: TextBlock[]
}

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
  
  // Photoshop-style enhancements states
  historyPast: HistoryStep[]
  historyFuture: HistoryStep[]
  isBatchingHistory: boolean
  activeXLine: number | null
  activeYLine: number | null
  showShortcutsCheatSheet: boolean

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

  // Photoshop-style methods
  initHistory: (blocks: TextBlock[]) => void
  pushHistory: (name: string, blocks: TextBlock[]) => void
  undo: (updateBlocksFn: (blocks: TextBlock[]) => Promise<void> | void) => void
  redo: (updateBlocksFn: (blocks: TextBlock[]) => Promise<void> | void) => void
  jumpToHistory: (stepId: string, updateBlocksFn: (blocks: TextBlock[]) => Promise<void> | void) => void
  startBatchHistory: () => void
  endBatchHistory: (name: string, blocks: TextBlock[]) => void
  setActiveGuides: (x: number | null, y: number | null) => void
  setShowShortcutsCheatSheet: (show: boolean) => void

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
  historyPast: [] as HistoryStep[],
  historyFuture: [] as HistoryStep[],
  isBatchingHistory: false,
  activeXLine: null as number | null,
  activeYLine: null as number | null,
  showShortcutsCheatSheet: false,
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

  // Photoshop-style methods implementation
  initHistory: (blocks) => {
    set({
      historyPast: [{ id: 'initial', name: 'Open Page', blocks: JSON.parse(JSON.stringify(blocks)) }],
      historyFuture: [],
    })
  },
  pushHistory: (name, blocks) => {
    const { historyPast, isBatchingHistory } = get()
    if (isBatchingHistory) return

    // Deep clone to avoid mutating reference blocks in history
    const clonedBlocks = JSON.parse(JSON.stringify(blocks))
    const nextPast = [
      ...historyPast,
      { id: Math.random().toString(36).substring(2, 9), name, blocks: clonedBlocks }
    ]

    // Cap history size, but keep the initial state at index 0
    if (nextPast.length > 50) {
      const initial = nextPast[0]
      const remaining = nextPast.slice(nextPast.length - 49)
      set({
        historyPast: [initial, ...remaining],
        historyFuture: [],
      })
    } else {
      set({
        historyPast: nextPast,
        historyFuture: [],
      })
    }
  },
  undo: (updateBlocksFn) => {
    const { historyPast, historyFuture } = get()
    if (historyPast.length <= 1) return

    const nextPast = [...historyPast]
    const popped = nextPast.pop()!
    const nextFuture = [popped, ...historyFuture]
    const activeState = nextPast[nextPast.length - 1]

    set({
      historyPast: nextPast,
      historyFuture: nextFuture,
      selectedBlockIndex: undefined,
    })

    void updateBlocksFn(activeState.blocks)
  },
  redo: (updateBlocksFn) => {
    const { historyPast, historyFuture } = get()
    if (historyFuture.length === 0) return

    const nextFuture = [...historyFuture]
    const popped = nextFuture.shift()!
    const nextPast = [...historyPast, popped]

    set({
      historyPast: nextPast,
      historyFuture: nextFuture,
      selectedBlockIndex: undefined,
    })

    void updateBlocksFn(popped.blocks)
  },
  jumpToHistory: (stepId, updateBlocksFn) => {
    const { historyPast, historyFuture } = get()
    const allSteps = [...historyPast, ...historyFuture]
    const targetIdx = allSteps.findIndex((s) => s.id === stepId)
    if (targetIdx === -1) return

    const nextPast = allSteps.slice(0, targetIdx + 1)
    const nextFuture = allSteps.slice(targetIdx + 1)

    set({
      historyPast: nextPast,
      historyFuture: nextFuture,
      selectedBlockIndex: undefined,
    })

    const activeState = nextPast[nextPast.length - 1]
    void updateBlocksFn(activeState.blocks)
  },
  startBatchHistory: () => set({ isBatchingHistory: true }),
  endBatchHistory: (name, blocks) => {
    set({ isBatchingHistory: false })
    get().pushHistory(name, blocks)
  },
  setActiveGuides: (x, y) => set({ activeXLine: x, activeYLine: y }),
  setShowShortcutsCheatSheet: (show) => set({ showShortcutsCheatSheet: show }),

  resetUiState: () =>
    set(() => ({
      ...initialState,
      totalPages: get().totalPages,
      documentsVersion: get().documentsVersion,
      currentDocumentIndex: get().currentDocumentIndex,
    })),
}))
