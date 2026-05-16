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
]

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
