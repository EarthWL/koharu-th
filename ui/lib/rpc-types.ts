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
  reorder_text_blocks: [{ index: number; readingOrder: 'rtl' | 'ltr' | 'custom' }, void]
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

  // ── Project lifecycle ────────────────────────────────────────
  project_create: [any, any]
  project_create_picker: [any, any]
  project_open: [any, any]
  project_open_picker: [void, any]
  project_close: [void, any]
  project_current: [void, any]
  project_backup_picker: [void, any]
  project_backup_silent: [void, { path: string | null; fileCount: number }]
  project_backup_list: [void, BackupDto[]]
  project_backup_restore: [{ backupName: string }, void]
  project_check_disk_space: [void, ProjectDiskSpaceResult]
  recent_projects_list: [void, any]
  recent_projects_remove: [any, any]

  // ── Storage management ───────────────────────────────────────
  app_storage_stats: [void, any]
  app_storage_clear: [any, any]

  // ── Series + chapters ────────────────────────────────────────
  series_meta_get: [void, any]
  series_meta_update: [any, any]
  chapters_list: [void, any]
  chapter_create: [any, any]
  chapter_add_pages: [any, any]
  chapter_open: [any, any]
  chapter_update: [any, any]
  chapter_remove: [any, any]
  chapter_clear_pages: [any, any]
  chapter_get_page_bytes: [any, any]
  chapter_export_cbz: [any, any]

  // ── Characters + glossary ────────────────────────────────────
  characters_list: [void, any]
  character_add: [any, any]
  character_update: [any, any]
  character_remove: [any, any]
  glossary_list: [void, any]
  glossary_add: [any, any]
  glossary_update: [any, any]
  glossary_remove: [any, any]
  glossary_bulk_add: [any, any]
  glossary_bump_usage: [any, any]

  // ── Prompt templates + rendering ─────────────────────────────
  prompt_templates_list: [void, any]
  prompt_template_add: [any, any]
  prompt_template_update: [any, any]
  prompt_template_remove: [any, any]
  prompt_render: [any, any]

  // ── Translation memory ───────────────────────────────────────
  tm_lookup: [any, any]
  tm_lookup_fuzzy: [any, any]
  tm_pending_embeddings: [any, any]
  tm_pending_count: [any, any]
  tm_set_embedding: [any, any]
  tm_lookup_semantic: [any, any]
  tm_export_tmx: [void, any]
  tm_import_tmx: [void, any]
  tm_insert: [any, any]

  // ── Provider profiles + cost tracking ────────────────────────
  provider_profiles_list: [void, any]
  provider_profile_add: [any, any]
  provider_profile_update: [any, any]
  provider_profile_remove: [any, any]
  provider_profile_secret_get: [any, any]
  llm_call_log: [any, any]
  llm_cost_stats: [void, any]
  llm_cost_breakdown: [void, any]
  cloud_llm_call: [
    {
      profileId: number
      prompt: string
      modelName: string
      apiUrl?: string | null
      jsonMode: boolean
    },
    { text: string }
  ]

  // ── AI Chat ──────────────────────────────────────────────────
  chat_messages_list: [any, any]
  chat_message_add: [any, any]
  chat_messages_clear: [void, any]
  chat_message_delete: [{ id: number }, { removed: number }]
  chat_messages_delete_from: [{ fromId: number }, { removed: number }]
  web_fetch_url: [any, any]

  // ── Translation queue ────────────────────────────────────────
  queue_list: [void, QueueEntryDto[]]
  queue_enqueue: [{ chapterId: number }, QueueEntryDto]
  queue_cancel: [{ id: number }, void]
  queue_clear_finished: [void, { removed: number }]

  // ── ML Device config + Relaunch ─────────────────────────────
  get_ml_device_config: [void, string]
  set_ml_device_config: [{ selection: string }, void]
  relaunch_app: [void, void]
  text_block_fit_to_bubble: [any, any]
  update_text_block: [any, any]
  collab_publish: [CollabEvent, boolean]
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

export type CollabEvent = {
  session_id: string
  event_type: string
  payload: any
}

export type RpcNotificationMap = {
  download_progress: DownloadProgress
  process_progress: ProcessProgress
  collab_sync: CollabEvent
}

export type BackupDto = {
  name: string
  path: string
  sizeBytes: number
  createdAt: string
}

export type ProjectDiskSpaceResult = {
  freeBytes: number
}

