'use client'

import { useUiErrorStore } from '@/lib/stores/uiErrorStore'
import { DiagnosticError } from './ws'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { isTauri } from './backend'

const SURFACED_RPC_METHODS = new Set([
  'open_documents',
  'add_documents',
  'save_documents',
  'export_document',
  'export_all_inpainted',
  'export_all_rendered',
  'detect',
  'ocr',
  'inpaint',
  'update_inpaint_mask',
  'update_brush_layer',
  'inpaint_partial',
  'render',
  'update_text_blocks',
  'llm_load',
  'llm_offload',
  'llm_generate',
  'process',
])

const buildTelemetry = () => {
  const prefStore = usePreferencesStore.getState()
  const editorStore = useEditorUiStore.getState()
  
  return {
    platform: {
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'Unknown',
      isTauri: isTauri(),
      isDev: process.env.NODE_ENV === 'development',
      timestamp: new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }),
    },
    appState: {
      currentDocumentIndex: editorStore.currentDocumentIndex,
      totalPages: editorStore.totalPages,
      directMlEnabled: false,
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

export const normalizeErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  return 'Unexpected error'
}

export const reportRpcError = (method: string, error: unknown) => {
  if (!SURFACED_RPC_METHODS.has(method)) return

  const telemetry = buildTelemetry()

  if (error instanceof DiagnosticError) {
    useUiErrorStore.getState().showError(error.message, {
      code: error.code,
      msgTh: error.msgTh,
      details: error.details,
      method,
      stack: error.stack,
      ...telemetry,
    })
  } else {
    const rawMessage = normalizeErrorMessage(error)
    const stack = error instanceof Error ? error.stack : undefined
    
    useUiErrorStore.getState().showError(rawMessage, {
      code: 'APP-UNEXPECTED',
      msgTh: `เกิดข้อผิดพลาดที่ไม่คาดคิดในระบบการเรียกประมวลผลเบื้องหลัง (${method})`,
      details: rawMessage,
      method,
      stack,
      ...telemetry,
    })
  }
}
