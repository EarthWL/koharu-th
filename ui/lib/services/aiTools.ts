/**
 * Tool registry for the in-app AI Chat. Each tool is exposed to the
 * active LLM via that provider's function-calling API; when the model
 * decides to invoke one, we dispatch it through the matching `api.*`
 * call here and pipe the result back into the conversation.
 *
 * Same source of truth that powers the MCP server externally — keeps
 * the two surfaces in sync. Wire format is JSON Schema (Draft-07
 * subset) which every major provider understands.
 */

import { api } from '@/lib/api'
import {
  activeEmbeddingsConfig,
  effectiveModel,
  embedBatch,
} from '@/lib/services/embeddings'
import { blobToAttachment } from '@/lib/services/imageAttach'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { fetchBlobBytes, toArrayBuffer } from '@/lib/util'

/**
 * Sentinel-tagged tool result for image-returning tools. The chat
 * loop recognises this shape and routes the bytes into the model's
 * native multi-modal channel (Anthropic tool_result with image block,
 * Gemini functionResponse with inlineData, OpenAI-compat synthetic
 * follow-up user message) instead of stringifying to JSON.
 */
export type ImageToolResult = {
  _kind: 'image'
  /** `image/jpeg` after downsizing; original mime if pass-through. */
  mimeType: string
  /** Base64-encoded image bytes (no `data:` prefix). */
  base64: string
  /** Short human-readable label rendered alongside the image —
   *  becomes the tool_result text body so the model has a caption. */
  alt: string
}

export function isImageToolResult(x: unknown): x is ImageToolResult {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as any)._kind === 'image' &&
    typeof (x as any).base64 === 'string'
  )
}

/** Convert raw page bytes into a downsized, model-friendly ImageToolResult. */
async function bytesToImageResult(
  bytes: Uint8Array,
  alt: string,
): Promise<ImageToolResult> {
  // blobToAttachment downsizes to ≤1024px + JPEG q85 (same constants
  // we use for user-attached images). Reuse so vision-tool images are
  // sized identically.
  const blob = new Blob([toArrayBuffer(bytes)])
  const att = await blobToAttachment(blob)
  const base64 = att.dataUrl.replace(/^data:[^;]+;base64,/, '')
  return { _kind: 'image', mimeType: att.mimeType, base64, alt }
}

export type JsonSchema = Record<string, unknown>

export type ToolHandler = (args: any) => Promise<unknown>

export type ToolDef = {
  /** Stable id used by the model — snake_case. */
  name: string
  /** One-sentence description (model uses this to pick). */
  description: string
  /** JSON Schema for the args object. */
  parameters: JsonSchema
  /** Server-side dispatcher. */
  handler: ToolHandler
}

const empty = (): JsonSchema => ({
  type: 'object',
  properties: {},
  additionalProperties: false,
})

const TOOLS: ToolDef[] = [
  // ── Project / series meta ─────────────────────────────────────
  {
    name: 'project_current',
    description: 'Get the currently-open project (id, name, schema version, counts).',
    parameters: empty(),
    handler: () => api.projectCurrent(),
  },
  {
    name: 'series_meta_get',
    description:
      'Read the series metadata (title, synopsis, languages, tone, style notes, genre, etc.) for the open project.',
    parameters: empty(),
    handler: () => api.seriesMetaGet(),
  },
  {
    name: 'series_meta_update',
    description:
      'Update series metadata fields. Only provided fields change. Use this to fill in synopsis / style notes / tone after summarising a wiki page.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string' },
        titleOriginal: { type: 'string' },
        synopsis: { type: 'string' },
        genre: { type: 'array', items: { type: 'string' } },
        targetAudience: { type: 'string' },
        sourceLanguage: { type: 'string' },
        targetLanguage: { type: 'string' },
        tone: { type: 'string' },
        formalityLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
        styleNotes: { type: 'string' },
      },
    },
    handler: (args) => api.seriesMetaUpdate(args),
  },

  // ── Chapters ─────────────────────────────────────────────────
  {
    name: 'chapters_list',
    description: 'List all chapters in the open project (sorted by chapter number).',
    parameters: empty(),
    handler: () => api.chaptersList(),
  },
  {
    name: 'chapter_update',
    description:
      'Update a chapter — useful for writing the chapter summary after translating it (feeds the rolling-context for future translations).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'integer' },
        title: { type: 'string' },
        chapterNumber: { type: 'number' },
        volume: { type: 'integer' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'translated', 'reviewed', 'done'],
        },
        summary: { type: 'string' },
        notes: { type: 'string' },
      },
    },
    handler: (args) => api.chapterUpdate(args),
  },

  // ── Characters ───────────────────────────────────────────────
  {
    name: 'characters_list',
    description: 'List all characters defined in the open project.',
    parameters: empty(),
    handler: () => api.charactersList(),
  },
  {
    name: 'character_add',
    description:
      'Add a character. Use for "main cast" entries gathered from a wiki — set isMain=true so they get injected into the translate prompt.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['originalName', 'translatedName'],
      properties: {
        originalName: { type: 'string', description: 'Source-language name (Japanese / Korean / Chinese).' },
        translatedName: { type: 'string', description: 'Target-language name (Thai).' },
        aliases: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['src', 'tgt'],
            properties: { src: { type: 'string' }, tgt: { type: 'string' } },
          },
        },
        role: { type: 'string', description: 'protagonist / antagonist / supporting / etc.' },
        gender: { type: 'string' },
        age: { type: 'string' },
        speechStyle: { type: 'string', description: 'How they speak — keigo / casual / boyish / etc.' },
        personality: { type: 'string' },
        notes: { type: 'string' },
        isMain: { type: 'boolean' },
        sortOrder: { type: 'integer' },
      },
    },
    handler: (args) => api.characterAdd(args),
  },
  {
    name: 'character_update',
    description: 'Update a character. Only provided fields are changed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'integer' },
        originalName: { type: 'string' },
        translatedName: { type: 'string' },
        role: { type: 'string' },
        gender: { type: 'string' },
        age: { type: 'string' },
        speechStyle: { type: 'string' },
        personality: { type: 'string' },
        notes: { type: 'string' },
        isMain: { type: 'boolean' },
      },
    },
    handler: (args) => api.characterUpdate(args),
  },

  // ── Glossary ─────────────────────────────────────────────────
  {
    name: 'glossary_list',
    description: 'List all glossary entries (terms / places / skills / honorifics / etc.).',
    parameters: empty(),
    handler: () => api.glossaryList(),
  },
  {
    name: 'glossary_bulk_add',
    description:
      'Add many glossary entries at once. Most efficient way to populate glossary from a wiki page. Duplicates are skipped.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['sourceText', 'targetText', 'category'],
            properties: {
              sourceText: { type: 'string' },
              targetText: { type: 'string' },
              category: {
                type: 'string',
                enum: ['character', 'place', 'term', 'skill', 'honorific', 'item', 'org', 'sfx'],
              },
              aliases: { type: 'array', items: { type: 'string' } },
              contextNote: { type: 'string' },
            },
          },
        },
      },
    },
    handler: (args) => api.glossaryBulkAdd(args.items),
  },

  // ── Prompt templates ─────────────────────────────────────────
  {
    name: 'prompt_templates_list',
    description: 'List all prompt templates (translate / extract_entities / summarize_chapter).',
    parameters: empty(),
    handler: () => api.promptTemplatesList(),
  },
  {
    name: 'prompt_render',
    description:
      'Render the actual prompt that would be sent to translate a piece of source text — useful for previewing what context the LLM will see.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['useCase', 'sourceText'],
      properties: {
        useCase: {
          type: 'string',
          enum: ['translate', 'extract_entities', 'summarize_chapter'],
        },
        sourceText: { type: 'string' },
        templateName: { type: 'string' },
        chapterId: { type: 'integer' },
        rollingChapterCount: { type: 'integer' },
      },
    },
    handler: (args) => api.promptRender(args),
  },

  // ── Translation memory ───────────────────────────────────────
  {
    name: 'tm_lookup',
    description: 'Exact-match TM lookup — get cached translation for an exact source string.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['sourceText', 'targetLang'],
      properties: {
        sourceText: { type: 'string' },
        targetLang: { type: 'string' },
      },
    },
    handler: (args) => api.tmLookup(args.sourceText, args.targetLang),
  },
  {
    name: 'tm_lookup_semantic',
    description:
      'Semantic TM lookup via embeddings — finds paraphrases / similar source phrases beyond exact/fuzzy match. Requires the user to have run "Embed TM for semantic search" first. Returns top-K entries with cosine similarity scores.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['sourceText', 'targetLang'],
      properties: {
        sourceText: { type: 'string' },
        targetLang: { type: 'string' },
        topK: { type: 'integer', description: 'Default 5.' },
        minSimilarity: {
          type: 'number',
          description: '0.0..1.0, default 0.75. 0.85+ is "very close".',
        },
      },
    },
    handler: (args) => runSemanticLookup(args),
  },

  // ── Text block edit (for QC fixes) ────────────────────────────
  {
    name: 'get_text_blocks',
    description:
      'Return the text_blocks array for the currently-open page as a compact JSON list. Each entry has { index, x, y, width, height, sourceText, translation }. Use this when you need the 0-based block indices before calling update_text_block, e.g. for the /translate-page workflow. Read-only — no mutation.',
    parameters: empty(),
    handler: async () => {
      const idx = useEditorUiStore.getState().currentDocumentIndex
      const doc = await api.getDocument(idx)
      const blocks = (doc.textBlocks ?? []).map((b: any, i: number) => ({
        index: i,
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        sourceText: b.text ?? null,
        translation: b.translation ?? null,
      }))
      return {
        pageIndex: idx,
        blockCount: blocks.length,
        blocks,
      }
    },
  },

  {
    name: 'update_text_block',
    description:
      'Update a single text block on a specific page. Use to fix translations after a QC scan finds a glossary / character name mismatch. Index is the page (0-based), textBlockIndex is the block within that page.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['index', 'textBlockIndex'],
      properties: {
        index: {
          type: 'integer',
          description: '0-based page index in the currently-open chapter.',
        },
        textBlockIndex: {
          type: 'integer',
          description: '0-based block index within the page.',
        },
        translation: { type: 'string' },
        fontSize: { type: 'number' },
        color: { type: 'string', description: 'Hex like #ffffff.' },
      },
    },
    handler: (args) => api.updateTextBlock(args),
  },

  // ── QC consistency check ──────────────────────────────────────
  {
    name: 'qc_chapter_consistency',
    description:
      'Scan the currently-loaded chapter pages: for every translated text block, check whether glossary terms / character names that appear in the source were rendered as the canonical translation. Returns mismatches (source term, expected target, actual target, page+block index) so the assistant can summarise + propose fixes.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    handler: () => runQcConsistency(),
  },

  // ── Web fetch (agentic) ───────────────────────────────────────
  {
    name: 'web_fetch_url',
    description:
      'Fetch a web page (wiki / fandom / blog) and return its readable text + title. Use this to pull a manga wiki into context so you can summarise into series_meta + characters + glossary. ~1.5MB cap, 12s timeout.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL.' },
      },
    },
    handler: (args) => api.webFetchUrl(args.url),
  },

  // ── Vision: let the model browse pages on its own ─────────────
  {
    name: 'view_current_page',
    description:
      'Return the image of the page the human is currently looking at in the editor canvas. Useful when the user says things like "translate this page" or "what does the speech bubble in the top-right say" without first attaching the image themselves. Image is downsized to ≤1024px JPEG.',
    parameters: empty(),
    handler: async () => {
      const idx = useEditorUiStore.getState().currentDocumentIndex
      try {
        const doc = await api.getDocument(idx)
        // v2 blob-transport: doc.image is a hex BlobId. Fetch the
        // raw bytes so we can downsize + re-encode for the LLM
        // attachment. Browser-cached after the first canvas render.
        const imageBytes = await fetchBlobBytes(doc.image)
        return await bytesToImageResult(
          imageBytes,
          `current canvas page (index ${idx})`,
        )
      } catch (err: any) {
        return { error: err?.message ?? String(err) }
      }
    },
  },
  {
    name: 'view_chapter_page',
    description:
      "Read one page image from any chapter in the open project. Lets you page through a chapter to find the panel you want without disturbing the human's editor. `pageIndex` is 0-based into the chapter's source/ folder sorted by filename. Returns an error if the chapter has no pages or the index is out of range. Use `chapters_list` to discover chapter IDs + page counts first.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['chapterId', 'pageIndex'],
      properties: {
        chapterId: { type: 'number', description: 'Chapter row id.' },
        pageIndex: {
          type: 'number',
          description: '0-based page index within the chapter.',
        },
      },
    },
    handler: async (args) => {
      const chapterId = Number(args.chapterId)
      const pageIndex = Number(args.pageIndex)
      if (!Number.isFinite(chapterId) || !Number.isFinite(pageIndex)) {
        return { error: 'chapterId and pageIndex must be numbers' }
      }
      try {
        const page = await api.chapterGetPageBytes(chapterId, pageIndex)
        return await bytesToImageResult(
          page.data,
          `chapter ${chapterId} · page ${page.pageIndex + 1}/${page.totalPages} (${page.filename})`,
        )
      } catch (err: any) {
        return { error: err?.message ?? String(err) }
      }
    },
  },
]

// ─────────────────────────────────────────────────────────────────
// QC consistency — pure JS scan, no LLM cost
// ─────────────────────────────────────────────────────────────────
type QcMismatch = {
  page: number
  blockIndex: number
  source: string
  translation: string
  term: string
  expected: string
  category: string
}

type QcReport = {
  pagesScanned: number
  blocksScanned: number
  glossaryTermsChecked: number
  charactersChecked: number
  mismatches: QcMismatch[]
  summary: string
}

async function runSemanticLookup(args: {
  sourceText: string
  targetLang: string
  topK?: number
  minSimilarity?: number
}): Promise<unknown> {
  const cfg = activeEmbeddingsConfig()
  if (!cfg) {
    return {
      error:
        'No active cloud LLM profile — apply one in the Profiles tab to enable embeddings.',
    }
  }
  if (cfg.provider === 'anthropic' && !cfg.apiKey) {
    return {
      error:
        'Anthropic has no embeddings API. Apply an OpenAI / OpenRouter / Local profile to use semantic search.',
    }
  }
  const model = effectiveModel(cfg)
  let vectors: number[][]
  try {
    vectors = await embedBatch(cfg, [args.sourceText])
  } catch (err: any) {
    return { error: err?.message ?? String(err) }
  }
  const vec = vectors[0]
  if (!vec) return { error: 'Embeddings call returned no vector.' }
  return api.tmLookupSemantic({
    embedding: vec,
    model,
    targetLang: args.targetLang,
    topK: args.topK,
    minSimilarity: args.minSimilarity,
  })
}

async function runQcConsistency(): Promise<QcReport> {
  const [pageCount, glossary, characters] = await Promise.all([
    api.getDocumentsCount(),
    api.glossaryList().catch(() => [] as Awaited<ReturnType<typeof api.glossaryList>>),
    api.charactersList().catch(() => [] as Awaited<ReturnType<typeof api.charactersList>>),
  ])

  // Flatten into a single (sourceTerm, expectedTarget, category) list.
  const terms: { src: string; tgt: string; category: string }[] = []
  for (const g of glossary) {
    if (g.sourceText && g.targetText) {
      terms.push({ src: g.sourceText, tgt: g.targetText, category: g.category })
    }
    for (const a of g.aliases ?? []) {
      if (a) terms.push({ src: a, tgt: g.targetText, category: g.category })
    }
  }
  for (const c of characters) {
    if (c.originalName && c.translatedName) {
      terms.push({
        src: c.originalName,
        tgt: c.translatedName,
        category: 'character',
      })
    }
    for (const a of c.aliases ?? []) {
      if (a.src && a.tgt) {
        terms.push({ src: a.src, tgt: a.tgt, category: 'character' })
      }
    }
  }

  const mismatches: QcMismatch[] = []
  let blocksScanned = 0
  let pagesScanned = 0
  for (let pageIdx = 0; pageIdx < pageCount; pageIdx++) {
    let doc: Awaited<ReturnType<typeof api.getDocument>>
    try {
      doc = await api.getDocument(pageIdx)
    } catch {
      continue
    }
    pagesScanned += 1
    const blocks = doc.textBlocks ?? []
    for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
      const b = blocks[bIdx]
      const src = b.text?.trim() ?? ''
      const tgt = b.translation?.trim() ?? ''
      if (!src || !tgt) continue
      blocksScanned += 1
      for (const term of terms) {
        if (!src.includes(term.src)) continue
        // Mismatch if expected target text doesn't appear in translation.
        if (!tgt.includes(term.tgt)) {
          mismatches.push({
            page: pageIdx + 1,
            blockIndex: bIdx,
            source: src,
            translation: tgt,
            term: term.src,
            expected: term.tgt,
            category: term.category,
          })
        }
      }
    }
  }

  const summary =
    mismatches.length === 0
      ? `Scanned ${blocksScanned} translated block(s) across ${pagesScanned} page(s). No glossary / character mismatches found.`
      : `Found ${mismatches.length} potential mismatch(es) across ${blocksScanned} translated block(s) on ${pagesScanned} page(s). Glossary terms checked: ${terms.length}.`

  return {
    pagesScanned,
    blocksScanned,
    glossaryTermsChecked: glossary.length,
    charactersChecked: characters.length,
    mismatches,
    summary,
  }
}

export function listTools(): ToolDef[] {
  return TOOLS
}

export function getTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name)
}

/** Dispatch a tool call by name. Returns the JSON-serialisable result
 *  the model will see, or an `{ error: string }` object on failure. */
export async function dispatchTool(name: string, args: unknown): Promise<unknown> {
  const tool = getTool(name)
  if (!tool) return { error: `Unknown tool: ${name}` }
  try {
    return await tool.handler(args ?? {})
  } catch (err: any) {
    return { error: err?.message ?? String(err) }
  }
}
