'use client'

import { create } from 'zustand'

export type DiagnosticErrorPayload = {
  code: string
  msgTh: string
  details?: string
}

type UiError = {
  id: number
  message: string
  diagnostic?: DiagnosticErrorPayload
}

type UiErrorStoreState = {
  error?: UiError
  showError: (message: string, diagnostic?: DiagnosticErrorPayload) => void
  clearError: () => void
}

const ERROR_AUTO_DISMISS_MS = 8000

let dismissTimer: ReturnType<typeof setTimeout> | null = null

const clearDismissTimer = () => {
  if (!dismissTimer) return
  clearTimeout(dismissTimer)
  dismissTimer = null
}

export const useUiErrorStore = create<UiErrorStoreState>((set) => ({
  error: undefined,
  showError: (message, diagnostic) => {
    clearDismissTimer()
    set({
      error: {
        id: Date.now(),
        message,
        diagnostic,
      },
    })
    dismissTimer = setTimeout(() => {
      dismissTimer = null
      set({ error: undefined })
    }, ERROR_AUTO_DISMISS_MS)
  },
  clearError: () => {
    clearDismissTimer()
    set({ error: undefined })
  },
}))
