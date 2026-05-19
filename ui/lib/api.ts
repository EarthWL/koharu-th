'use client'

import { z } from 'zod'
import {
  invoke,
  fetchThumbnail as fetchThumbnailBlob,
  type ProcessProgress,
  type DownloadProgress,
} from '@/lib/backend'
import type {
  DetectedHardware,
  DeviceInfo,
  EngineInfoView,
  EngineProfile,
  HistoryState,
} from '@/lib/rpc-types'
import {
  Document,
  InpaintRegion,
  RenderEffect,
  RenderStroke,
  TextBlock,
} from '@/types'
import {
  deviceInfoSchema,
  documentSchema,
  llmModelInfoListSchema,
  processProgressSchema,
  downloadProgressSchema,
} from '@/lib/rpcSchemas'

const parseWithSchema = <T>(
  schema: z.ZodType<T>,
  payload: unknown,
  context: string,
): T => {
  const result = schema.safeParse(payload)
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join(', ')
    throw new Error(`Invalid ${context} payload: ${message}`)
  }
  return result.data
}

const parseOrLogAndThrow = <T>(
  schema: z.ZodType<T>,
  payload: unknown,
  context: string,
): T => {
  try {
    return parseWithSchema(schema, payload, context)
  } catch (error) {
    console.error('[api] schema validation failed', {
      context,
      error,
    })
    throw error
  }
}

export const api = {
  async appVersion(): Promise<string> {
    return invoke('app_version')
  },

  async deviceInfo(): Promise<DeviceInfo> {
    const payload = await invoke('device')
    return parseOrLogAndThrow(deviceInfoSchema, payload, 'device')
  },

  async openExternal(url: string): Promise<void> {
    await invoke('open_external', { url })
  },

  async getDocumentsCount(): Promise<number> {
    return invoke('get_documents')
  },

  async getDocument(index: number): Promise<Document> {
    // v2 blob-transport route: backend registers binaries with the
    // BlobStore + returns hex BlobIds (see koharu_api::views::
    // DocumentDto). Frontend renders via `<img src="/blob/{hex}">`.
    // The plain `get_document` route still exists for MCP image-
    // extraction tools that need pixel-level access — frontend
    // never uses it.
    const payload = await invoke('get_document_dto', { index })
    return parseOrLogAndThrow(documentSchema, payload, 'document')
  },

  async getThumbnail(index: number): Promise<Blob> {
    return fetchThumbnailBlob(index)
  },

  async addDocuments(): Promise<number> {
    return invoke('add_documents')
  },

  async openDocuments(): Promise<number> {
    return invoke('open_documents')
  },

  async saveDocuments(): Promise<void> {
    await invoke('save_documents')
  },

  async exportDocument(index: number): Promise<void> {
    await invoke('export_document', { index })
  },

  async exportAllInpainted(): Promise<number> {
    return invoke('export_all_inpainted')
  },

  async exportAllRendered(): Promise<number> {
    return invoke('export_all_rendered')
  },

  async detect(
    index: number,
    options?: {
      /** Detector engine. Backend defaults to `default` (comic_text_detector)
       *  if omitted. `anime_yolo` uses mayocream/anime-text-yolo (YOLO12) —
       *  better at SFX + out-of-bubble text but lazy-downloads weights on
       *  first use. */
      detectorEngine?: 'default' | 'anime_yolo'
      /** AnimeText YOLO size variant. Only honoured when detectorEngine is
       *  'anime_yolo'. */
      animeYoloVariant?: 'n' | 's' | 'm' | 'l' | 'x'
      /** Confidence threshold override for Anime Text YOLO. Backend
       *  clamps to [0.05, 0.95]; defaults to 0.25 (upstream). */
      animeYoloConfidence?: number
    },
  ): Promise<void> {
    await invoke('detect', {
      index,
      ...options,
    })
  },

  async ocr(
    index: number,
    options?: {
      /** Local OCR engine. Backend defaults to MIT-48px if omitted.
       *  `manga` uses mayocream/manga-ocr (~100MB first-use download,
       *  tuned for Japanese SFX + vertical handwriting). `cloud` is
       *  handled in the frontend dispatch layer (see ocrPageViaCloud),
       *  NOT here — passing 'cloud' would be a programming error. */
      ocrEngine?: 'mit48px' | 'manga'
    },
  ): Promise<void> {
    await invoke('ocr', {
      index,
      ...options,
    })
  },

  async inpaint(index: number): Promise<void> {
    await invoke('inpaint', { index })
  },

  async updateInpaintMask(
    index: number,
    mask: Uint8Array,
    region?: InpaintRegion,
  ): Promise<void> {
    await invoke('update_inpaint_mask', { index, mask, region })
  },

  async updateBrushLayer(
    index: number,
    patch: Uint8Array,
    region: InpaintRegion,
  ): Promise<void> {
    await invoke('update_brush_layer', { index, patch, region })
  },

  async inpaintPartial(index: number, region: InpaintRegion): Promise<void> {
    await invoke('inpaint_partial', { index, region })
  },

  async render(
    index: number,
    options?: {
      textBlockIndex?: number
      shaderEffect?: RenderEffect
      shaderStroke?: RenderStroke
      fontFamily?: string
    },
  ): Promise<void> {
    await invoke('render', {
      index,
      ...options,
    })
  },

  async updateTextBlocks(
    index: number,
    textBlocks: TextBlock[],
  ): Promise<void> {
    await invoke('update_text_blocks', { index, textBlocks })
  },

  /** Expand a text block's bbox to fit the bubble it sits in. Uses a
   *  flood-fill of high-luminance pixels on the original image as a
   *  heuristic for "inside the bubble". Useful when comic-text-detector
   *  returned a tight bbox around the source text but the translated
   *  Thai needs the full bubble area to render without overflow. */
  async textBlockFitToBubble(
    index: number,
    textBlockIndex: number,
  ): Promise<unknown> {
    return invoke('text_block_fit_to_bubble', {
      index,
      textBlockIndex,
    })
  },

  /** Update a single text block on a page — used by the QC consistency
   *  flow to patch one translation at a time. */
  async updateTextBlock(input: {
    index: number
    textBlockIndex: number
    translation?: string
    x?: number
    y?: number
    width?: number
    height?: number
    fontFamilies?: string[]
    fontSize?: number
    color?: string
    shaderEffect?: string
    rotationDeg?: number
  }): Promise<void> {
    await invoke('update_text_block', input)
  },

  async listFontFamilies(): Promise<string[]> {
    return invoke('list_font_families')
  },

  async llmList(language?: string) {
    const payload = await invoke('llm_list', { language })
    return parseOrLogAndThrow(llmModelInfoListSchema, payload, 'llm_list')
  },

  async llmLoad(id: string): Promise<void> {
    await invoke('llm_load', { id })
  },

  async llmOffload(): Promise<void> {
    await invoke('llm_offload')
  },

  async llmReady(): Promise<boolean> {
    return invoke('llm_ready')
  },

  async llmGenerate(
    index: number,
    textBlockIndex?: number,
    language?: string,
  ): Promise<void> {
    await invoke('llm_generate', {
      index,
      textBlockIndex,
      language,
    })
  },

  async process(options: {
    index?: number
    llmModelId?: string
    language?: string
    shaderEffect?: RenderEffect
    shaderStroke?: RenderStroke
    fontFamily?: string
    /** OCR engine for the OCR pipeline step. Backend defaults to
     *  Mit48px if omitted. */
    ocrEngine?: 'mit48px' | 'manga'
    /** When `true`, the Rust pipeline skips the OCR step entirely
     *  — the caller is expected to have populated text_blocks[].text
     *  already (e.g. via Cloud Vision OCR done in TypeScript). */
    skipOcr?: boolean
    /** Skip the detect step (frontend ran it directly already, often
     *  in tandem with `skipOcr` for the Cloud Vision OCR flow). */
    skipDetect?: boolean
    /** Skip the inpaint step. Used by the Re-translate flow: keep the
     *  existing inpainted image (the slowest pipeline step), only
     *  re-run translate + render. Issue #17. */
    skipInpaint?: boolean
    /** Detector engine for the Detect pipeline step. Backend defaults
     *  to `default` (comic_text_detector) if omitted. `anime_yolo`
     *  uses mayocream/anime-text-yolo (YOLO12) — better at SFX +
     *  out-of-bubble text but lazy-downloads weights on first use. */
    detectorEngine?: 'default' | 'anime_yolo'
    /** AnimeText YOLO size variant. N (nano, ~10MB) → X (xlarge,
     *  ~250MB). Only honoured when detectorEngine is 'anime_yolo'. */
    animeYoloVariant?: 'n' | 's' | 'm' | 'l' | 'x'
    /** Confidence threshold override for Anime Text YOLO. Backend
     *  clamps to [0.05, 0.95]; defaults to 0.25 (upstream). */
    animeYoloConfidence?: number
  }): Promise<void> {
    await invoke('process', options)
  },

  async processCancel(): Promise<void> {
    await invoke('process_cancel')
  },

  // ----------------------------------------------------------------
  // Project lifecycle (Phase 1)
  // ----------------------------------------------------------------
  async projectCreate(path: string, name: string): Promise<ProjectInfo> {
    return invoke('project_create', { path, name }) as Promise<ProjectInfo>
  },

  async projectCreatePicker(name: string): Promise<ProjectInfo | null> {
    return invoke('project_create_picker', { name }) as Promise<ProjectInfo | null>
  },

  async projectOpen(path: string): Promise<ProjectInfo> {
    return invoke('project_open', { path }) as Promise<ProjectInfo>
  },

  async projectOpenPicker(): Promise<ProjectInfo | null> {
    return invoke('project_open_picker') as Promise<ProjectInfo | null>
  },

  async projectClose(): Promise<void> {
    await invoke('project_close')
  },

  async projectCurrent(): Promise<ProjectInfo | null> {
    return invoke('project_current') as Promise<ProjectInfo | null>
  },

  async projectBackupPicker(): Promise<{
    path: string | null
    fileCount: number
  }> {
    return invoke('project_backup_picker') as Promise<{
      path: string | null
      fileCount: number
    }>
  },

  async recentProjectsList(): Promise<RecentProjectDto[]> {
    return invoke('recent_projects_list') as Promise<RecentProjectDto[]>
  },

  async recentProjectsRemove(path: string): Promise<boolean> {
    return invoke('recent_projects_remove', { path }) as Promise<boolean>
  },

  // ----------------------------------------------------------------
  // Storage management (Settings → Storage panel + NSIS uninstall hook)
  // ----------------------------------------------------------------
  async appStorageStats(): Promise<AppStorageStats> {
    return invoke('app_storage_stats') as Promise<AppStorageStats>
  },

  async appStorageClear(
    targets: StorageClearTarget[],
  ): Promise<AppStorageClearResult> {
    return invoke('app_storage_clear', { targets }) as Promise<AppStorageClearResult>
  },

  // ----------------------------------------------------------------
  // Series + chapters (Phase 2)
  // ----------------------------------------------------------------
  async seriesMetaGet(): Promise<SeriesMetaDto> {
    return invoke('series_meta_get') as Promise<SeriesMetaDto>
  },

  async seriesMetaUpdate(patch: Partial<Omit<SeriesMetaDto, 'createdAt' | 'updatedAt'>>): Promise<SeriesMetaDto> {
    return invoke('series_meta_update', patch) as Promise<SeriesMetaDto>
  },

  async chaptersList(): Promise<ChapterDto[]> {
    return invoke('chapters_list') as Promise<ChapterDto[]>
  },

  /** Create a chapter folder + DB row. No files copied — call
   *  `chapterAddPages` after. */
  async chapterCreate(input: {
    chapterNumber: number
    title?: string | null
    volume?: number | null
  }): Promise<ChapterDto> {
    return invoke('chapter_create', input) as Promise<ChapterDto>
  },

  /** Pop a file picker and copy selected page images into the chapter's
   *  `source/` subfolder. */
  async chapterAddPages(
    chapterId: number,
  ): Promise<{ added: number; skipped: number }> {
    return invoke('chapter_add_pages', { chapterId }) as Promise<{
      added: number
      skipped: number
    }>
  },

  /** Load all pages from the chapter's `source/` folder into the editor. */
  async chapterOpen(id: number): Promise<number> {
    return invoke('chapter_open', { id }) as Promise<number>
  },

  async chapterUpdate(input: {
    id: number
    chapterNumber?: number
    title?: string | null
    volume?: number | null
    status?: ChapterStatus
    summary?: string | null
    notes?: string | null
    pageCount?: number
  }): Promise<ChapterDto | null> {
    return invoke('chapter_update', input) as Promise<ChapterDto | null>
  },

  async chapterRemove(id: number): Promise<boolean> {
    return invoke('chapter_remove', { id }) as Promise<boolean>
  },

  /** Delete every file in the chapter's `source/` folder (does NOT
   *  touch `render/`, characters, glossary, or any other DB data —
   *  just the page files on disk). Used by the "Clear pages" button
   *  when the user has uploaded duplicates and wants to start over
   *  without losing the chapter row + its translation context. */
  async chapterClearPages(id: number): Promise<{
    removed: number
    failed: number
  }> {
    return invoke('chapter_clear_pages', { id }) as Promise<{
      removed: number
      failed: number
    }>
  },

  /** Read one page's raw bytes from a chapter's source/ folder without
   *  loading the chapter into editor state. Used by the AI Chat's
   *  vision tools so the model can browse any page of any chapter
   *  without disrupting what the human is currently editing. */
  async chapterGetPageBytes(
    chapterId: number,
    pageIndex: number,
  ): Promise<{
    data: Uint8Array
    filename: string
    pageIndex: number
    totalPages: number
  }> {
    return invoke('chapter_get_page_bytes', {
      chapterId,
      pageIndex,
    }) as Promise<{
      data: Uint8Array
      filename: string
      pageIndex: number
      totalPages: number
    }>
  },

  /** Export a chapter as a `.cbz` (Comic Book ZIP). Backend pops a
   *  save dialog; uses pages from render/ if present, else source/. */
  async chapterExportCbz(id: number): Promise<{
    path: string | null
    pageCount: number
    usedRender: boolean
  }> {
    return invoke('chapter_export_cbz', { id }) as Promise<{
      path: string | null
      pageCount: number
      usedRender: boolean
    }>
  },

  // ----------------------------------------------------------------
  // Characters + glossary (Phase 3)
  // ----------------------------------------------------------------
  async charactersList(): Promise<CharacterDto[]> {
    return invoke('characters_list') as Promise<CharacterDto[]>
  },

  async characterAdd(input: CharacterAddInput): Promise<CharacterDto> {
    return invoke('character_add', input) as Promise<CharacterDto>
  },

  async characterUpdate(input: CharacterUpdateInput): Promise<CharacterDto | null> {
    return invoke('character_update', input) as Promise<CharacterDto | null>
  },

  async characterRemove(id: number): Promise<boolean> {
    return invoke('character_remove', { id }) as Promise<boolean>
  },

  async glossaryList(): Promise<GlossaryDto[]> {
    return invoke('glossary_list') as Promise<GlossaryDto[]>
  },

  async glossaryAdd(input: GlossaryAddInput): Promise<GlossaryDto> {
    return invoke('glossary_add', input) as Promise<GlossaryDto>
  },

  async glossaryUpdate(input: GlossaryUpdateInput): Promise<GlossaryDto | null> {
    return invoke('glossary_update', input) as Promise<GlossaryDto | null>
  },

  async glossaryRemove(id: number): Promise<boolean> {
    return invoke('glossary_remove', { id }) as Promise<boolean>
  },

  async glossaryBulkAdd(
    items: GlossaryAddInput[],
  ): Promise<{ inserted: number; skipped: number }> {
    return invoke('glossary_bulk_add', { items }) as Promise<{
      inserted: number
      skipped: number
    }>
  },

  async glossaryBumpUsage(ids: number[]): Promise<void> {
    await invoke('glossary_bump_usage', { ids })
  },

  // ----------------------------------------------------------------
  // Prompt templates + rendering (Phase 4 / 5)
  // ----------------------------------------------------------------
  async promptTemplatesList(): Promise<PromptTemplateDto[]> {
    return invoke('prompt_templates_list') as Promise<PromptTemplateDto[]>
  },

  async promptTemplateAdd(input: {
    name: string
    description?: string | null
    useCase: PromptUseCase
    template: string
    isDefault?: boolean
  }): Promise<PromptTemplateDto> {
    return invoke('prompt_template_add', input) as Promise<PromptTemplateDto>
  },

  async promptTemplateUpdate(input: {
    id: number
    name?: string
    description?: string | null
    useCase?: PromptUseCase
    template?: string
    isDefault?: boolean
  }): Promise<PromptTemplateDto | null> {
    return invoke('prompt_template_update', input) as Promise<PromptTemplateDto | null>
  },

  async promptTemplateRemove(id: number): Promise<boolean> {
    return invoke('prompt_template_remove', { id }) as Promise<boolean>
  },

  async promptRender(input: {
    useCase: PromptUseCase
    sourceText: string
    templateName?: string
    rollingSummary?: string
    chapterId?: number | null
    rollingChapterCount?: number
  }): Promise<PromptRenderResult> {
    return invoke('prompt_render', input) as Promise<PromptRenderResult>
  },

  // ----------------------------------------------------------------
  // Translation memory (Phase 6)
  // ----------------------------------------------------------------
  async tmLookup(sourceText: string, targetLang: string): Promise<TmEntryDto | null> {
    return invoke('tm_lookup', { sourceText, targetLang }) as Promise<TmEntryDto | null>
  },

  async tmLookupFuzzy(
    sourceText: string,
    targetLang: string,
    minSimilarity = 0.85,
  ): Promise<{ entry: TmEntryDto; similarity: number } | null> {
    return invoke('tm_lookup_fuzzy', {
      sourceText,
      targetLang,
      minSimilarity,
    }) as Promise<{ entry: TmEntryDto; similarity: number } | null>
  },

  // ── TM embeddings (semantic search) ─────────────────────────────

  async tmPendingEmbeddings(input: {
    model: string
    limit?: number
  }): Promise<{ id: number; sourceText: string }[]> {
    return invoke('tm_pending_embeddings', input) as Promise<
      { id: number; sourceText: string }[]
    >
  },

  async tmPendingCount(model: string): Promise<number> {
    return invoke('tm_pending_count', { model }) as Promise<number>
  },

  async tmSetEmbedding(input: {
    id: number
    embedding: number[]
    model: string
  }): Promise<void> {
    await invoke('tm_set_embedding', input)
  },

  async tmLookupSemantic(input: {
    embedding: number[]
    model: string
    targetLang: string
    topK?: number
    minSimilarity?: number
  }): Promise<{ entry: TmEntryDto; similarity: number }[]> {
    return invoke('tm_lookup_semantic', input) as Promise<
      { entry: TmEntryDto; similarity: number }[]
    >
  },

  /** Export the project's translation memory as a TMX 1.4 file
   *  (interchange format for Trados / OmegaT / MemoQ / …). */
  async tmExportTmx(): Promise<{ path: string | null; entries: number }> {
    return invoke('tm_export_tmx') as Promise<{
      path: string | null
      entries: number
    }>
  },

  /** Import TMX file from disk. Duplicates by (source, target_lang) are
   *  skipped. Uses the series' source/target languages as the language
   *  filter so off-target units are dropped. */
  async tmImportTmx(): Promise<{ inserted: number; skipped: number }> {
    return invoke('tm_import_tmx') as Promise<{
      inserted: number
      skipped: number
    }>
  },

  async tmInsert(input: {
    sourceText: string
    targetText: string
    sourceLang: string
    targetLang: string
    chapterId?: number | null
    pageIndex?: number | null
    textBlockIndex?: number | null
    provider?: string | null
    model?: string | null
  }): Promise<TmEntryDto> {
    return invoke('tm_insert', input) as Promise<TmEntryDto>
  },

  // ----------------------------------------------------------------
  // Provider profiles + cost tracking (Phase 9 + 10)
  // ----------------------------------------------------------------
  async providerProfilesList(): Promise<ProviderProfileDto[]> {
    return invoke('provider_profiles_list') as Promise<ProviderProfileDto[]>
  },

  async providerProfileAdd(input: {
    name: string
    provider: string
    apiUrl?: string | null
    modelName: string
    /** Plaintext key — stored in OS keyring server-side. */
    apiKey?: string | null
    isDefault?: boolean
    costInputPer1m?: number | null
    costOutputPer1m?: number | null
  }): Promise<ProviderProfileDto> {
    return invoke('provider_profile_add', input) as Promise<ProviderProfileDto>
  },

  async providerProfileUpdate(input: {
    id: number
    name?: string
    provider?: string
    apiUrl?: string | null
    modelName?: string
    /** Pass empty string to clear, omit to leave alone. */
    apiKey?: string | null
    isDefault?: boolean
    costInputPer1m?: number | null
    costOutputPer1m?: number | null
  }): Promise<ProviderProfileDto | null> {
    return invoke('provider_profile_update', input) as Promise<ProviderProfileDto | null>
  },

  async providerProfileRemove(id: number): Promise<boolean> {
    return invoke('provider_profile_remove', { id }) as Promise<boolean>
  },

  /** Fetch the plaintext API key for `id` from the OS keyring. */
  async providerProfileSecretGet(id: number): Promise<{ apiKey: string | null }> {
    return invoke('provider_profile_secret_get', { id }) as Promise<{ apiKey: string | null }>
  },

  async llmCallLog(input: {
    profileId?: number | null
    useCase: string
    chapterId?: number | null
    promptTokens?: number | null
    completionTokens?: number | null
    estimatedCostUsd?: number | null
    durationMs?: number | null
    success: boolean
    errorMessage?: string | null
  }): Promise<void> {
    await invoke('llm_call_log', input)
  },

  async llmCostStats(): Promise<LlmCostStats> {
    return invoke('llm_cost_stats') as Promise<LlmCostStats>
  },

  async llmCostBreakdown(): Promise<LlmCostBreakdown> {
    return invoke('llm_cost_breakdown') as Promise<LlmCostBreakdown>
  },

  // ----------------------------------------------------------------
  // AI Chat (per-project history + agentic web fetch)
  // ----------------------------------------------------------------
  async chatMessagesList(input: {
    limit?: number
    beforeId?: number | null
  } = {}): Promise<ChatMessageDto[]> {
    return invoke('chat_messages_list', input) as Promise<ChatMessageDto[]>
  },

  async chatMessageAdd(input: {
    role: 'user' | 'assistant' | 'tool' | 'system'
    content: string
    toolCalls?: string | null
    toolCallId?: string | null
    model?: string | null
    /** JSON-stringified array of {dataUrl, mimeType, width, height}. */
    attachments?: string | null
  }): Promise<ChatMessageDto> {
    return invoke('chat_message_add', input) as Promise<ChatMessageDto>
  },

  async chatMessagesClear(): Promise<{ removed: number }> {
    return invoke('chat_messages_clear') as Promise<{ removed: number }>
  },

  /** Delete one chat message by id. Returns {removed: 0|1}. */
  async chatMessageDelete(id: number): Promise<{ removed: number }> {
    return invoke('chat_message_delete', { id }) as Promise<{ removed: number }>
  },

  /** "Undo from this point" — delete every message with id >= fromId.
   *  Powers the "remove this turn and everything after" flow when the
   *  user wants to retry a question with different context. */
  async chatMessagesDeleteFrom(
    fromId: number,
  ): Promise<{ removed: number }> {
    return invoke('chat_messages_delete_from', { fromId }) as Promise<{
      removed: number
    }>
  },

  /** Server-side HTTP GET — bypasses CORS, capped to 1.5MB / 12s.
   *  Returns title + HTML-stripped text, suitable for piping into the
   *  active LLM to summarise into project metadata. */
  async webFetchUrl(url: string): Promise<WebFetchResult> {
    return invoke('web_fetch_url', { url }) as Promise<WebFetchResult>
  },

  // ── Translation queue ────────────────────────────────────────

  async queueList(): Promise<QueueEntryDto[]> {
    return invoke('queue_list') as Promise<QueueEntryDto[]>
  },

  async queueEnqueue(chapterId: number): Promise<QueueEntryDto> {
    return invoke('queue_enqueue', { chapterId }) as Promise<QueueEntryDto>
  },

  async queueCancel(id: number): Promise<void> {
    await invoke('queue_cancel', { id })
  },

  async queueClearFinished(): Promise<{ removed: number }> {
    return invoke('queue_clear_finished') as Promise<{ removed: number }>
  },

  // ── Phase 4.7: Engine system surfaces ──────────────────────────
  /** List every engine registered via `inventory::submit!` in the
   *  Rust binary. Used by the Engine Profile sidebar tab. */
  async enginesList(): Promise<EngineInfoView[]> {
    return invoke('engines_list')
  },

  /** Host hardware snapshot from `koharu_engines::probe()`. Drives
   *  the compatibility chips in the Engine Profile UI. */
  async hardwareDetected(): Promise<DetectedHardware> {
    return invoke('hardware_detected')
  },

  /** Load the machine-wide engine profile (active engine per
   *  artifact slot + per-engine setting overrides). Missing file
   *  returns an empty profile. */
  async engineProfileGet(): Promise<EngineProfile> {
    return invoke('engine_profile_get')
  },

  /** Replace + persist the engine profile. Used for import/
   *  export + full-profile reset; the per-control mutations use
   *  the granular `engineProfileSetActive` / `…SetSetting`
   *  endpoints to avoid stale-snapshot trampling (audit #6 P2). */
  async engineProfileSet(profile: EngineProfile): Promise<EngineProfile> {
    return invoke('engine_profile_set', { profile })
  },

  /** Granular: set the active engine for one artifact slot.
   *  Atomic under the backend's profile RwLock. */
  async engineProfileSetActive(
    artifact: import('@/lib/rpc-types').ArtifactKind,
    engineId: string,
  ): Promise<EngineProfile> {
    return invoke('engine_profile_set_active', { artifact, engineId })
  },

  /** Granular: set one setting value for one engine. */
  async engineProfileSetSetting(
    engineId: string,
    settingId: string,
    value: import('@/lib/rpc-types').StoredValue,
  ): Promise<EngineProfile> {
    return invoke('engine_profile_set_setting', {
      engineId,
      settingId,
      value,
    })
  },

  /** Pop the most recent applied op from the ProjectSession's
   *  history, apply its inverse to Scene + mirror onto the
   *  legacy Document. Returns the new HistoryState so the
   *  toolbar can update undo/redo enabled flags. */
  async sessionUndo(index: number): Promise<HistoryState> {
    return invoke('session_undo', { index })
  },

  async sessionRedo(index: number): Promise<HistoryState> {
    return invoke('session_redo', { index })
  },

  /** Read-only snapshot of the session's history pointers. Used
   *  by the toolbar on mount + after every engine run. */
  async sessionHistoryState(): Promise<HistoryState> {
    return invoke('session_history_state')
  },
}

export type { QueueStatus, QueueEntryDto } from '@/lib/rpc-types'
export type {
  ArtifactKind,
  BackendSupport,
  DetectedHardware,
  EngineCost,
  EngineInfoView,
  EngineProfile,
  GpuVendor,
  HardwareReq,
  HistoryState,
  SettingDescriptor,
  StoredValue,
} from '@/lib/rpc-types'

export type ChatMessageDto = {
  id: number
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  /** JSON string of tool_calls array when assistant invoked tools. */
  toolCalls: string | null
  /** Set on tool rows — matching assistant tool_call.id. */
  toolCallId: string | null
  /** `provider:model` that produced this message. */
  model: string | null
  /** JSON string of attachments array [{dataUrl, mimeType, width, height}]. */
  attachments: string | null
  createdAt: string
}

export type ChatAttachment = {
  /** data:image/jpeg;base64,… */
  dataUrl: string
  mimeType: string
  width: number
  height: number
}

export type WebFetchResult = {
  url: string
  status: number
  contentType: string
  title: string | null
  text: string
  truncated: boolean
}

export type ProviderProfileDto = {
  id: number
  name: string
  provider: string
  apiUrl: string | null
  modelName: string
  apiKeyRef: string | null
  isDefault: boolean
  costInputPer1m: number | null
  costOutputPer1m: number | null
  createdAt: string
  updatedAt: string
}

export type LlmCostStats = {
  totalCalls: number
  successfulCalls: number
  totalPromptTokens: number
  totalCompletionTokens: number
  totalCostUsd: number
}

export type LlmCostByProfile = {
  profileId: number
  profileName: string
  provider: string
  totalCalls: number
  successfulCalls: number
  totalPromptTokens: number
  totalCompletionTokens: number
  totalCostUsd: number
}

export type LlmCostByChapter = {
  chapterId: number
  chapterTitle: string
  chapterNumber: number
  totalCalls: number
  totalPromptTokens: number
  totalCompletionTokens: number
  totalCostUsd: number
}

export type LlmCostByDay = {
  /** YYYY-MM-DD UTC */
  day: string
  totalCalls: number
  totalPromptTokens: number
  totalCompletionTokens: number
  totalCostUsd: number
}

export type LlmCostByUseCase = {
  useCase: string
  totalCalls: number
  totalPromptTokens: number
  totalCompletionTokens: number
  totalCostUsd: number
}

export type LlmCostBreakdown = {
  byProfile: LlmCostByProfile[]
  byChapter: LlmCostByChapter[]
  byDay: LlmCostByDay[]
  byUseCase: LlmCostByUseCase[]
}

export type TmEntryDto = {
  id: number
  sourceText: string
  targetText: string
  sourceLang: string
  targetLang: string
  chapterId: number | null
  pageIndex: number | null
  textBlockIndex: number | null
  provider: string | null
  model: string | null
  isApproved: boolean
  createdAt: string
}

export type PromptUseCase = 'translate' | 'extract_entities' | 'summarize_chapter'

export type PromptTemplateDto = {
  id: number
  name: string
  description: string | null
  isDefault: boolean
  useCase: PromptUseCase
  template: string
  createdAt: string
  updatedAt: string
}

export type PromptRenderResult = {
  prompt: string
  templateName: string
  glossaryHitIds: number[]
}

export type NameAliasDto = { src: string; tgt: string }

export type CharacterDto = {
  id: number
  originalName: string
  translatedName: string
  aliases: NameAliasDto[]
  role: string | null
  gender: string | null
  age: string | null
  speechStyle: string | null
  personality: string | null
  notes: string | null
  isMain: boolean
  sortOrder: number
  firstAppearanceChapterId: number | null
  createdAt: string
  updatedAt: string
}

export type CharacterAddInput = {
  originalName: string
  translatedName: string
  aliases?: NameAliasDto[]
  role?: string | null
  gender?: string | null
  age?: string | null
  speechStyle?: string | null
  personality?: string | null
  notes?: string | null
  isMain?: boolean
  sortOrder?: number
  firstAppearanceChapterId?: number | null
}

export type CharacterUpdateInput = {
  id: number
  originalName?: string
  translatedName?: string
  aliases?: NameAliasDto[]
  role?: string | null
  gender?: string | null
  age?: string | null
  speechStyle?: string | null
  personality?: string | null
  notes?: string | null
  isMain?: boolean
  sortOrder?: number
  firstAppearanceChapterId?: number | null
}

export type GlossaryCategory =
  | 'term'
  | 'place'
  | 'skill'
  | 'honorific'
  | 'item'
  | 'org'
  | 'sfx'

export type GlossaryConfidence = 'manual' | 'extracted' | 'auto'

export type GlossaryDto = {
  id: number
  sourceText: string
  targetText: string
  category: GlossaryCategory
  aliases: string[]
  contextNote: string | null
  firstAppearanceChapterId: number | null
  usageCount: number
  confidence: GlossaryConfidence
  approved: boolean
  createdAt: string
  updatedAt: string
}

export type GlossaryAddInput = {
  sourceText: string
  targetText: string
  category: GlossaryCategory
  aliases?: string[]
  contextNote?: string | null
  firstAppearanceChapterId?: number | null
  confidence?: GlossaryConfidence
  approved?: boolean
}

export type GlossaryUpdateInput = {
  id: number
  sourceText?: string
  targetText?: string
  category?: GlossaryCategory
  aliases?: string[]
  contextNote?: string | null
  firstAppearanceChapterId?: number | null
  confidence?: GlossaryConfidence
  approved?: boolean
}

export type SeriesMetaDto = {
  title: string
  titleOriginal: string | null
  synopsis: string | null
  genre: string[]
  targetAudience: string | null
  sourceLanguage: string
  targetLanguage: string
  tone: string | null
  formalityLevel: string | null
  styleNotes: string | null
  coverImage: string | null
  createdAt: string
  updatedAt: string
}

export type ChapterStatus =
  | 'pending'
  | 'in_progress'
  | 'translated'
  | 'reviewed'
  | 'done'

export type ChapterDto = {
  id: number
  folderPath: string
  chapterNumber: number
  title: string | null
  volume: number | null
  status: ChapterStatus
  summary: string | null
  notes: string | null
  pageCount: number
  createdAt: string
  updatedAt: string
}

export type RecentProjectDto = {
  path: string
  name: string
  lastOpenedAt: number
}

export type StorageClearTarget =
  | 'libsCuda'
  | 'modelsHf'
  | 'fontsCustom'
  | 'recentProjects'

export type StorageEntry = {
  /** Absolute path on disk — shown in UI so user sees what'll be touched. */
  path: string
  exists: boolean
  sizeBytes: number
  fileCount: number
}

export type AppStorageStats = {
  /** Runtime CUDA+cuDNN dylibs. Safe to clear; re-downloaded on next GPU launch. */
  libsCuda: StorageEntry
  /** HuggingFace model cache (Anime YOLO, Manga OCR, etc.). Safe to clear; re-fetched on first inference. */
  modelsHf: StorageEntry
  /** User-dropped custom fonts. Confirm before clearing — user data. */
  fontsCustom: StorageEntry
  /** recent-projects.json (UI convenience). Project folders themselves unaffected. */
  recentProjects: StorageEntry
}

export type StorageClearError = {
  target: StorageClearTarget
  message: string
}

export type AppStorageClearResult = {
  cleared: StorageClearTarget[]
  freedBytes: number
  errors: StorageClearError[]
}

export type ProjectInfo = {
  root: string
  id: string
  name: string
  nameOriginal: string | null
  schemaVersion: number
  createdAt: string
  updatedAt: string
  tags: string[]
  chapterCount: number
  characterCount: number
  glossaryCount: number
}

export const parseDownloadProgress = (payload: unknown): DownloadProgress =>
  parseWithSchema(downloadProgressSchema, payload, 'download_progress')

export const parseProcessProgress = (payload: unknown): ProcessProgress =>
  parseWithSchema(processProgressSchema, payload, 'process_progress')
