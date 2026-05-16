'use client'

import { z } from 'zod'
import {
  invoke,
  fetchThumbnail as fetchThumbnailBlob,
  type ProcessProgress,
  type DownloadProgress,
} from '@/lib/backend'
import type { DeviceInfo } from '@/lib/rpc-types'
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
    const payload = await invoke('get_document', { index })
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

  async detect(index: number): Promise<void> {
    await invoke('detect', { index })
  },

  async ocr(index: number): Promise<void> {
    await invoke('ocr', { index })
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

  async chapterAdd(input: {
    filePath: string
    chapterNumber: number
    title?: string | null
    volume?: number | null
  }): Promise<ChapterDto> {
    return invoke('chapter_add', input) as Promise<ChapterDto>
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
  filePath: string
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
