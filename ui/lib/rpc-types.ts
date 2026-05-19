import type {
  Document,
  InpaintRegion,
  RenderEffect,
  RenderStroke,
  TextBlock,
} from '@/types'

// Params → Result type map for all RPC methods

export type ThumbnailResult = {
  data: Uint8Array
  contentType: string
}

export type FileEntry = {
  name: string
  data: Uint8Array
}

export type FileResult = {
  filename: string
  data: Uint8Array
  contentType: string
}

export type DeviceInfo = {
  mlDevice: string
}

export type LlmModelInfo = {
  id: string
  languages: string[]
}

export type RpcMethodMap = {
  app_version: [void, string]
  device: [void, DeviceInfo]
  open_external: [{ url: string }, void]
  get_documents: [void, number]
  get_document: [{ index: number }, Document]
  // v2 blob-transport variant of get_document — backend registers
  // binary fields with the BlobStore and returns hex BlobIds in
  // place of inline bytes. Frontend always uses this; the plain
  // get_document route stays for the MCP image-extraction tools
  // that need pixel-level access. See koharu_api::views::
  // DocumentDto + docs/v2-arch.md §5 Phase 2.
  get_document_dto: [{ index: number }, Document]
  get_thumbnail: [{ index: number }, ThumbnailResult]
  add_documents: [void, number]
  open_documents: [void, number]
  save_documents: [void, void]
  export_document: [{ index: number }, void]
  export_all_inpainted: [void, number]
  export_all_rendered: [void, number]
  detect: [{ index: number }, void]
  ocr: [{ index: number }, void]
  inpaint: [{ index: number }, void]
  update_inpaint_mask: [
    { index: number; mask: Uint8Array; region?: InpaintRegion },
    void,
  ]
  update_brush_layer: [
    { index: number; patch: Uint8Array; region: InpaintRegion },
    void,
  ]
  inpaint_partial: [{ index: number; region: InpaintRegion }, void]
  render: [
    {
      index: number
      textBlockIndex?: number
      shaderEffect?: RenderEffect
      shaderStroke?: RenderStroke
      fontFamily?: string
    },
    void,
  ]
  update_text_blocks: [{ index: number; textBlocks: TextBlock[] }, void]
  list_font_families: [void, string[]]
  llm_list: [{ language?: string }, LlmModelInfo[]]
  llm_load: [{ id: string }, void]
  llm_offload: [void, void]
  llm_ready: [void, boolean]
  llm_generate: [
    { index: number; textBlockIndex?: number; language?: string },
    void,
  ]
  process: [
    {
      index?: number
      llmModelId?: string
      language?: string
      shaderEffect?: RenderEffect
      shaderStroke?: RenderStroke
      fontFamily?: string
    },
    void,
  ]
  process_cancel: [void, void]
  // ── Translation queue ────────────────────────────────────────
  queue_list: [void, QueueEntryDto[]]
  queue_enqueue: [{ chapterId: number }, QueueEntryDto]
  queue_cancel: [{ id: number }, void]
  queue_clear_finished: [void, { removed: number }]
}

export type QueueStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type QueueEntryDto = {
  id: number
  chapterId: number
  status: QueueStatus
  totalPages: number
  donePages: number
  errorMessage: string | null
  enqueuedAt: number
  startedAt: number | null
  finishedAt: number | null
}

export type DownloadProgress = {
  filename: string
  downloaded: number
  total?: number | null
  status: 'started' | 'downloading' | 'completed' | { failed: string }
}

export type ProcessProgress = {
  status: 'running' | 'completed' | 'cancelled' | { failed: string }
  step: string | null
  currentDocument: number
  totalDocuments: number
  currentStepIndex: number
  totalSteps: number
  overallPercent: number
}

export type RpcNotificationMap = {
  download_progress: DownloadProgress
  process_progress: ProcessProgress
}
