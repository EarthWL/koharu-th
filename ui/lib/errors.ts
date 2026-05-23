'use client'

import { useUiErrorStore } from '@/lib/stores/uiErrorStore'
import { DiagnosticError } from './ws'
import { buildTelemetry } from './telemetry'

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
