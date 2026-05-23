'use client'

import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { getQueryClient } from '@/lib/query/client'
import { queryKeys } from '@/lib/query/keys'
import type { DeviceInfo } from './rpc-types'
import { isTauri } from './backend'

export type TelemetrySnapshot = {
  platform: {
    userAgent: string
    isTauri: boolean
    isDev: boolean
    timestamp: string
  }
  appState: {
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

// Snapshot of runtime + engine state attached to every diagnostic so a
// copied bug report carries the context needed to reproduce. Reads the
// active ML backend from the `device` query cache (seeded at startup in
// providers.tsx), falling back to 'unknown' when the backend has not yet
// answered — never a hardcoded value.
export const buildTelemetry = (): TelemetrySnapshot => {
  const prefStore = usePreferencesStore.getState()
  const editorStore = useEditorUiStore.getState()

  const deviceInfo = getQueryClient().getQueryData<DeviceInfo>(
    queryKeys.device.info,
  )
  const activeMlDevice = deviceInfo?.mlDevice || 'unknown'

  return {
    platform: {
      userAgent:
        typeof navigator !== 'undefined' ? navigator.userAgent : 'Unknown',
      isTauri: isTauri(),
      isDev: process.env.NODE_ENV === 'development',
      timestamp: new Date().toLocaleString('th-TH', {
        timeZone: 'Asia/Bangkok',
      }),
    },
    appState: {
      currentDocumentIndex: editorStore.currentDocumentIndex,
      totalPages: editorStore.totalPages,
      activeMlDevice,
      directMlEnabled: /directml/i.test(activeMlDevice),
      smartPostProcessEnabled: prefStore.smartPostProcessEnabled ?? false,
      ocrEngine: prefStore.ocrEngine || 'auto',
      detectorEngine: prefStore.detectorEngine || 'default',
      inpaintEngine: prefStore.inpaintEngine || 'lama',
      animeYoloVariant: prefStore.animeYoloVariant || 'auto',
      inpaintMaxSide: prefStore.inpaintMaxSide || 512,
      cloudProvider: prefStore.cloudProvider || 'none',
      cloudModelName: prefStore.cloudModelName || 'none',
      llmFailoverEnabled: prefStore.llmFailoverEnabled ?? false,
      installedAddonsCount: (prefStore.installedAddons || []).length,
    },
  }
}
