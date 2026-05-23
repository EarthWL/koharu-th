'use client'

import { create } from 'zustand'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import { buildTelemetry } from '@/lib/telemetry'

export type DiagnosticErrorPayload = {
  code: string
  msgTh: string
  details?: string
  method?: string
  stack?: string
  platform?: {
    userAgent: string
    isTauri: boolean
    isDev: boolean
    timestamp: string
  }
  appState?: {
    currentDocumentIndex: number
    totalPages: number
    activeMlDevice: string
    directMlEnabled: boolean
    smartPostProcessEnabled: boolean
    ocrEngine: string
    detectorEngine: string
    inpaintEngine: string
    animeYoloVariant: string
    inpaintMaxSide: number
    cloudProvider: string
    cloudModelName: string
    llmFailoverEnabled: boolean
    installedAddonsCount: number
  }
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

    // Developer mode (toggled in About): synthesize a diagnostic
    // payload for plain errors so the full debug ErrorDialog (raw
    // message + telemetry) is always reachable. Soft-notice markers
    // ([RATE_LIMIT]/[NO_QUOTA]) stay as amber toasts — they're not
    // crashes and forcing them into the debug dialog would be noise.
    const isSoftMarker =
      message.startsWith('[RATE_LIMIT:') || message.startsWith('[NO_QUOTA:')
    if (!diagnostic && !isSoftMarker) {
      let devMode = false
      try {
        devMode = usePreferencesStore.getState().developerMode
      } catch {
        // store not ready — fall back to non-dev behaviour
      }
      if (devMode) {
        diagnostic = {
          code: 'DEV-DEBUG',
          msgTh: message,
          details: message,
          ...buildTelemetry(),
        }
      }
    }

    set({
      error: {
        id: Date.now(),
        message,
        diagnostic,
      },
    })

    // Diagnostic errors (real or dev-synthesized) do NOT auto-dismiss.
    // Only simple errors auto-dismiss after 8 seconds.
    if (!diagnostic) {
      dismissTimer = setTimeout(() => {
        dismissTimer = null
        set({ error: undefined })
      }, ERROR_AUTO_DISMISS_MS)
    }
  },
  clearError: () => {
    clearDismissTimer()
    set({ error: undefined })
  },
}))
