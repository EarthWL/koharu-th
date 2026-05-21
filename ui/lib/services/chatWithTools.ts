/**
 * Multi-turn chat with auto tool-loop for the in-app AI Chat panel.
 *
 * Provider-agnostic — accepts the active profile's preferences slot
 * and dispatches to the right wire format:
 *   - openai / openrouter / local (OpenAI-compatible) → /v1/chat/completions
 *   - anthropic                                       → /v1/messages
 *   - gemini                                          → :generateContent
 *
 * Tools come from `aiTools.listTools()` — the assistant decides which
 * to call; we run the handler client-side and append the result as a
 * tool message before re-sending. Loop caps at MAX_TOOL_ROUNDS to avoid
 * runaway agents.
 */

import {
  dispatchTool,
  isImageToolResult,
  listTools,
  type ToolDef,
} from './aiTools'
import { api, type ChatAttachment } from '@/lib/api'
import { useProjectStore } from '@/lib/stores/projectStore'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import type { TokenUsage } from './cloudLlm'

/** Provider-call result: the assistant message plus whatever token
 *  counts the provider returned (null if it didn't). */
type ProviderResult = { message: ChatMessage; usage: TokenUsage | null }

/** Fire-and-forget: log a single chat round to `llm_call_log`. No-op
 *  when no project is open. Mirrors `cloudLlm.ts:logCallSafe` so the
 *  AI Chat panel shows up alongside translation calls in the cost
 *  dashboard. */
function logChatRoundSafe(args: {
  success: boolean
  usage: TokenUsage | null
  durationMs: number
  errorMessage?: string
}) {
  if (!useProjectStore.getState().info) return
  const profileId = usePreferencesStore.getState().activeProfileId
  const chapterId = useProjectStore.getState().activeChapterId
  void api
    .llmCallLog({
      useCase: 'chat',
      profileId,
      chapterId,
      success: args.success,
      promptTokens: args.usage?.promptTokens ?? null,
      completionTokens: args.usage?.completionTokens ?? null,
      durationMs: args.durationMs,
      errorMessage: args.errorMessage ?? null,
    })
    .catch((err) => console.warn('[chatWithTools] llmCallLog failed', err))
}

const MAX_TOOL_ROUNDS = 8

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export type ToolCall = {
  id: string
  name: string
  /** JSON-stringified arguments. */
  arguments: string
  /** Gemini-only: opaque base64 signature attached to the model's
   *  function-call part. Must be echoed back verbatim on the next
   *  request, otherwise Gemini 2.5+ returns 400 "Function call is
   *  missing a thought_signature in functionCall parts."
   *  See https://ai.google.dev/gemini-api/docs/thought-signatures */
  thoughtSignature?: string
}

export type ChatMessage = {
  role: ChatRole
  content: string
  /** Present on assistant messages that invoked tools. */
  toolCalls?: ToolCall[]
  /** Present on tool messages — the matching toolCalls[].id. */
  toolCallId?: string
  /** Image attachments — only meaningful on user turns. Each provider
   *  adapter converts these to its native multi-modal format. */
  attachments?: ChatAttachment[]
  /** Set on synthetic messages we generated mid-turn (e.g. follow-up
   *  user message that carries images from a `view_current_page` tool
   *  result). Callers must NOT persist these to `chat_messages` —
   *  they're in-memory analysis context, not user-facing history. */
  _synthetic?: boolean
}

export type ChatEvent =
  | { kind: 'text-delta'; delta: string }
  | { kind: 'tool-call'; call: ToolCall }
  | { kind: 'tool-result'; toolCallId: string; result: unknown }
  | { kind: 'done'; finalMessages: ChatMessage[] }
  | { kind: 'error'; message: string }

export type ChatProviderConfig = {
  /** 'openai' | 'openrouter' | 'gemini' | 'anthropic'. */
  provider: string
  apiKey: string
  /** Required for OpenAI-compatible providers; ignored for native Gemini/Anthropic. */
  apiUrl: string
  model: string
  /** Abort the in-flight request when the user clicks Stop. */
  signal?: AbortSignal
  /** Optional temperature configuration (0.0 to 2.0) */
  temperature?: number
  /** Optional max tokens configuration (256 to 4096) */
  maxTokens?: number
}

/**
 * Read a Server-Sent Events stream from a fetch Response body and
 * yield each non-empty `data:` payload string (without the prefix).
 * Stops at the `[DONE]` sentinel some providers emit.
 */
async function* readSseLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trimEnd()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      yield payload
    }
  }
  const tail = buffer.trim()
  if (tail.startsWith('data:')) {
    const payload = tail.slice(5).trim()
    if (payload && payload !== '[DONE]') yield payload
  }
}

/** Run one turn of chat. The caller passes the full history (system +
 *  prior user/assistant/tool turns) plus the new user message; we
 *  loop until the assistant has no more tool calls, emitting events.
 *  Returns the final updated history. */
export async function runChatTurn(
  cfg: ChatProviderConfig,
  history: ChatMessage[],
  // Handler may be async — `done` in particular kicks off persistence
  // of the new tail to SQLite, and we MUST await it so callers don't
  // refetch the chat history before those rows land in the DB.
  onEvent: (e: ChatEvent) => void | Promise<void>,
): Promise<ChatMessage[]> {
  let messages = [...history]
  const tools = listTools()

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let assistant: ChatMessage
    const roundStart = Date.now()
    try {
      const result = await callProvider(cfg, messages, tools, onEvent)
      assistant = result.message
      logChatRoundSafe({
        success: true,
        usage: result.usage,
        durationMs: Date.now() - roundStart,
      })
    } catch (err: any) {
      logChatRoundSafe({
        success: false,
        usage: null,
        durationMs: Date.now() - roundStart,
        errorMessage: err?.message ?? String(err),
      })
      await onEvent({ kind: 'error', message: err?.message ?? String(err) })
      throw err
    }
    messages.push(assistant)

    if (!assistant.toolCalls || assistant.toolCalls.length === 0) {
      await onEvent({ kind: 'done', finalMessages: messages })
      return messages
    }

    // Dispatch each requested tool and append results.
    //
    // For image-returning tools (view_current_page, view_chapter_page):
    // the tool message itself stays text (caption / "[see next
    // message]") so model knows what it asked for, and a single
    // synthetic user message at the end of the round carries ALL the
    // image attachments. This keeps the tool messages grouped right
    // after the assistant's tool_calls — OpenAI requires every
    // tool_call_id to be answered before any non-tool message
    // appears. The synthetic user message is in-memory only; we don't
    // persist it because tool images are ephemeral analysis context.
    const pendingImages: ChatAttachment[] = []
    const pendingImageAlts: string[] = []
    for (const call of assistant.toolCalls) {
      await onEvent({ kind: 'tool-call', call })
      let args: unknown = {}
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {}
      } catch {
        // Pass the raw string — handlers ignore unknown shapes safely.
        args = { _raw: call.arguments }
      }
      const result = await dispatchTool(call.name, args)
      await onEvent({ kind: 'tool-result', toolCallId: call.id, result })

      if (isImageToolResult(result)) {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: `[image returned: ${result.alt}. See the follow-up message for the actual image.]`,
        })
        pendingImages.push({
          dataUrl: `data:${result.mimeType};base64,${result.base64}`,
          mimeType: result.mimeType,
          width: 0,
          height: 0,
        })
        pendingImageAlts.push(result.alt)
      } else {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: safeStringify(result),
        })
      }
    }
    if (pendingImages.length > 0) {
      messages.push({
        role: 'user',
        content: `(tool-returned images, in order: ${pendingImageAlts.join('; ')})`,
        attachments: pendingImages,
        _synthetic: true,
      })
    }
  }
  // Hit the tool-loop cap — return what we have plus a synthetic note.
  messages.push({
    role: 'assistant',
    content: `_(stopped after ${MAX_TOOL_ROUNDS} tool rounds — too many)_`,
  })
  await onEvent({ kind: 'done', finalMessages: messages })
  return messages
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

// ────────────────────────────────────────────────────────────────
// Provider dispatch
// ────────────────────────────────────────────────────────────────

async function callProvider(
  cfg: ChatProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
  onEvent: (e: ChatEvent) => void,
): Promise<ProviderResult> {
  switch (cfg.provider) {
    case 'openai':
    case 'openrouter':
      return callOpenAiCompat(cfg, messages, tools, onEvent)
    case 'anthropic':
      return callAnthropic(cfg, messages, tools, onEvent)
    case 'gemini':
      return callGemini(cfg, messages, tools, onEvent)
    default:
      throw new Error(`Unsupported provider for chat: ${cfg.provider}`)
  }
}

// ── OpenAI / OpenRouter / Local LLM (OpenAI-compatible) ─────────

function toOpenAiMessages(msgs: ChatMessage[]) {
  return msgs.map((m) => {
    const base: any = { role: m.role }
    // Multi-modal content: only meaningful on user turns. OpenAI accepts
    // an array of {type:'text'|'image_url'} blocks when there's an image,
    // otherwise a plain string.
    if (m.role === 'user' && m.attachments?.length) {
      const parts: any[] = []
      if (m.content) parts.push({ type: 'text', text: m.content })
      for (const a of m.attachments) {
        parts.push({
          type: 'image_url',
          image_url: { url: a.dataUrl },
        })
      }
      base.content = parts
    } else {
      base.content = m.content
    }
    if (m.toolCalls?.length) {
      base.tool_calls = m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      }))
    }
    if (m.toolCallId) base.tool_call_id = m.toolCallId
    return base
  })
}

function toOpenAiTools(tools: ToolDef[]) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
}

async function callOpenAiCompat(
  cfg: ChatProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
  onEvent: (e: ChatEvent) => void,
): Promise<ProviderResult> {
  const base = (cfg.apiUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const url =
    cfg.provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1/chat/completions'
      : `${base}/chat/completions`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  }
  if (cfg.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://koharu.local'
    headers['X-Title'] = 'Koharu AI Chat'
  }

  const body = {
    model: cfg.model,
    messages: toOpenAiMessages(messages),
    tools: toOpenAiTools(tools),
    tool_choice: 'auto',
    stream: true,
    // Ask the server to emit a final SSE chunk containing token usage
    // so we can log it to llm_call_log. OpenAI + OpenRouter both
    // honour this flag.
    stream_options: { include_usage: true },
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
    ...(cfg.maxTokens !== undefined ? { max_tokens: cfg.maxTokens } : {}),
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: cfg.signal,
  })
  if (!res.ok || !res.body) {
    const errBody = res.body ? await res.text().catch(() => '') : ''
    throw new Error(
      `${cfg.provider} chat failed (${res.status}): ${errBody.slice(0, 400)}`,
    )
  }

  let content = ''
  // Accumulate tool_calls by streamed index. OpenAI sends partial
  // arguments as repeated deltas; concatenate them per index.
  const toolByIndex: Record<
    number,
    { id?: string; name: string; arguments: string }
  > = {}

  let usage: TokenUsage | null = null

  for await (const payload of readSseLines(res.body)) {
    let chunk: any
    try {
      chunk = JSON.parse(payload)
    } catch {
      continue
    }
    // The usage chunk has no `choices[0].delta` — it stands alone.
    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens ?? null,
        completionTokens: chunk.usage.completion_tokens ?? null,
      }
    }
    const delta = chunk.choices?.[0]?.delta
    if (!delta) continue
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      content += delta.content
      onEvent({ kind: 'text-delta', delta: delta.content })
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        const entry = (toolByIndex[idx] ??= { name: '', arguments: '' })
        if (tc.id) entry.id = tc.id
        if (tc.function?.name) entry.name += tc.function.name
        if (typeof tc.function?.arguments === 'string') {
          entry.arguments += tc.function.arguments
        }
      }
    }
  }

  const toolCalls: ToolCall[] = Object.values(toolByIndex)
    .filter((t) => t.name)
    .map((t) => ({
      id: t.id ?? `openai-${Math.random().toString(36).slice(2, 10)}`,
      name: t.name,
      arguments: t.arguments || '{}',
    }))

  return {
    message: {
      role: 'assistant',
      content,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    },
    usage,
  }
}

// ── Anthropic ──────────────────────────────────────────────────

function toAnthropicMessages(msgs: ChatMessage[]) {
  // System messages go to the top-level `system` field — strip from
  // the array. Tool turns become content blocks of type tool_result.
  const out: any[] = []
  for (const m of msgs) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId ?? '',
            content: m.content,
          },
        ],
      })
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      const content: any[] = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const c of m.toolCalls) {
        let parsed: any = {}
        try {
          parsed = c.arguments ? JSON.parse(c.arguments) : {}
        } catch {
          parsed = {}
        }
        content.push({
          type: 'tool_use',
          id: c.id,
          name: c.name,
          input: parsed,
        })
      }
      out.push({ role: 'assistant', content })
    } else if (m.role === 'user' && m.attachments?.length) {
      // Anthropic image block: base64 + media_type. Strip the
      // `data:<mime>;base64,` prefix from the dataUrl.
      const content: any[] = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const a of m.attachments) {
        const base64 = a.dataUrl.replace(/^data:[^;]+;base64,/, '')
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: a.mimeType,
            data: base64,
          },
        })
      }
      out.push({ role: 'user', content })
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}

function toAnthropicTools(tools: ToolDef[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }))
}

async function callAnthropic(
  cfg: ChatProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
  onEvent: (e: ChatEvent) => void,
): Promise<ProviderResult> {
  const system =
    messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n') || undefined

  const body: any = {
    model: cfg.model,
    max_tokens: cfg.maxTokens ?? 4096,
    messages: toAnthropicMessages(messages),
    tools: toAnthropicTools(tools),
    stream: true,
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
  }
  if (system) body.system = system

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    signal: cfg.signal,
  })
  if (!res.ok || !res.body) {
    const errBody = res.body ? await res.text().catch(() => '') : ''
    throw new Error(
      `Anthropic chat failed (${res.status}): ${errBody.slice(0, 400)}`,
    )
  }

  // Anthropic SSE: text blocks arrive as content_block_delta with
  // {type:'text_delta', text:'...'}; tool_use blocks arrive as
  // content_block_start with the {id, name}, then content_block_delta
  // with {type:'input_json_delta', partial_json:'...'} that we concat.
  // Usage: message_start carries input_tokens; message_delta carries
  // the final output_tokens.
  let text = ''
  const blocks: Record<
    number,
    { type: string; id?: string; name?: string; partial: string }
  > = {}
  let promptTokens: number | null = null
  let completionTokens: number | null = null

  for await (const payload of readSseLines(res.body)) {
    let evt: any
    try {
      evt = JSON.parse(payload)
    } catch {
      continue
    }
    switch (evt.type) {
      case 'message_start': {
        const u = evt.message?.usage
        if (u) {
          promptTokens = u.input_tokens ?? null
          completionTokens = u.output_tokens ?? null
        }
        break
      }
      case 'content_block_start': {
        const idx = evt.index ?? 0
        const cb = evt.content_block ?? {}
        blocks[idx] = {
          type: cb.type ?? 'text',
          id: cb.id,
          name: cb.name,
          partial: '',
        }
        break
      }
      case 'content_block_delta': {
        const idx = evt.index ?? 0
        const block = blocks[idx]
        if (!block) break
        const d = evt.delta ?? {}
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          text += d.text
          block.partial += d.text
          onEvent({ kind: 'text-delta', delta: d.text })
        } else if (
          d.type === 'input_json_delta' &&
          typeof d.partial_json === 'string'
        ) {
          block.partial += d.partial_json
        }
        break
      }
      case 'message_delta': {
        const u = evt.usage
        if (u && typeof u.output_tokens === 'number') {
          completionTokens = u.output_tokens
        }
        break
      }
      case 'message_stop':
      case 'content_block_stop':
      default:
        break
    }
  }

  const toolCalls: ToolCall[] = Object.values(blocks)
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({
      id: b.id ?? `anthropic-${Math.random().toString(36).slice(2, 10)}`,
      name: b.name ?? '',
      arguments: b.partial || '{}',
    }))

  const usage: TokenUsage | null =
    promptTokens !== null || completionTokens !== null
      ? { promptTokens, completionTokens }
      : null

  return {
    message: {
      role: 'assistant',
      content: text,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    },
    usage,
  }
}

// ── Gemini ─────────────────────────────────────────────────────

function toGeminiContents(msgs: ChatMessage[]) {
  const out: any[] = []
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      // Gemini's `functionResponse.name` must match the FUNCTION NAME
      // of the originating `functionCall`, not the OpenAI-style tool
      // call ID. ChatMessage on the 'tool' row only carries
      // `toolCallId` (which is fine for OpenAI/Anthropic where it's
      // used as the matching key), so look back at the most recent
      // assistant message's toolCalls and recover the name by id.
      // Falls back to the id itself if no match — same behaviour as
      // before, but at least correct in the normal single-round flow.
      let funcName = m.toolCallId ?? ''
      for (let j = i - 1; j >= 0; j--) {
        const prev = msgs[j]
        if (prev.role === 'assistant' && prev.toolCalls?.length) {
          const match = prev.toolCalls.find((c) => c.id === m.toolCallId)
          if (match) {
            funcName = match.name
          }
          break
        }
      }
      out.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: funcName,
              response: { result: m.content },
            },
          },
        ],
      })
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      const parts: any[] = []
      if (m.content) parts.push({ text: m.content })
      for (const c of m.toolCalls) {
        let parsed: any = {}
        try {
          parsed = c.arguments ? JSON.parse(c.arguments) : {}
        } catch {
          parsed = {}
        }
        // Echo back `thoughtSignature` if the model issued one.
        // Required by Gemini 2.5+; missing it yields HTTP 400.
        const part: any = { functionCall: { name: c.name, args: parsed } }
        if (c.thoughtSignature) {
          part.thoughtSignature = c.thoughtSignature
        }
        parts.push(part)
      }
      out.push({ role: 'model', parts })
    } else if (m.role === 'user' && m.attachments?.length) {
      // Gemini inlineData: base64 + mimeType.
      const parts: any[] = []
      if (m.content) parts.push({ text: m.content })
      for (const a of m.attachments) {
        const base64 = a.dataUrl.replace(/^data:[^;]+;base64,/, '')
        parts.push({
          inlineData: { mimeType: a.mimeType, data: base64 },
        })
      }
      out.push({ role: 'user', parts })
    } else {
      out.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })
    }
  }
  return out
}

function stripAdditionalProperties(schema: any): any {
  if (typeof schema !== 'object' || schema === null) return schema
  if (Array.isArray(schema)) return schema.map(stripAdditionalProperties)

  const out: any = {}
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties') continue
    out[k] = stripAdditionalProperties(v)
  }
  return out
}

function toGeminiTools(tools: ToolDef[]) {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: stripAdditionalProperties(t.parameters),
      })),
    },
  ]
}

async function callGemini(
  cfg: ChatProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
  onEvent: (e: ChatEvent) => void,
): Promise<ProviderResult> {
  const system =
    messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n') || undefined

  const body: any = {
    contents: toGeminiContents(messages),
    tools: toGeminiTools(tools),
    ...(cfg.temperature !== undefined || cfg.maxTokens !== undefined
      ? {
          generationConfig: {
            ...(cfg.temperature !== undefined
              ? { temperature: cfg.temperature }
              : {}),
            ...(cfg.maxTokens !== undefined
              ? { maxOutputTokens: cfg.maxTokens }
              : {}),
          },
        }
      : {}),
  }
  if (system) body.systemInstruction = { parts: [{ text: system }] }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(cfg.apiKey)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: cfg.signal,
  })
  if (!res.ok || !res.body) {
    const errBody = res.body ? await res.text().catch(() => '') : ''
    throw new Error(
      `Gemini chat failed (${res.status}): ${errBody.slice(0, 400)}`,
    )
  }

  let text = ''
  const toolCalls: ToolCall[] = []
  let usage: TokenUsage | null = null

  for await (const payload of readSseLines(res.body)) {
    let chunk: any
    try {
      chunk = JSON.parse(payload)
    } catch {
      continue
    }
    // usageMetadata typically arrives on the final chunk — keep
    // overwriting so we end with whatever was reported last.
    const um = chunk.usageMetadata
    if (um) {
      usage = {
        promptTokens: um.promptTokenCount ?? null,
        completionTokens: um.candidatesTokenCount ?? null,
      }
    }
    const parts: any[] = chunk.candidates?.[0]?.content?.parts ?? []
    for (const p of parts) {
      if (typeof p.text === 'string' && p.text.length > 0) {
        text += p.text
        onEvent({ kind: 'text-delta', delta: p.text })
      } else if (p.functionCall) {
        // Preserve thoughtSignature (Gemini 2.5+ requirement).
        // The SDK uses camelCase `thoughtSignature` in JSON; some
        // intermediaries may surface the snake_case form, so accept both.
        const sig: string | undefined =
          typeof p.thoughtSignature === 'string'
            ? p.thoughtSignature
            : typeof p.thought_signature === 'string'
              ? p.thought_signature
              : undefined
        toolCalls.push({
          id: `gemini-${Math.random().toString(36).slice(2, 10)}`,
          name: p.functionCall.name,
          arguments: JSON.stringify(p.functionCall.args ?? {}),
          ...(sig ? { thoughtSignature: sig } : {}),
        })
      }
    }
  }

  return {
    message: {
      role: 'assistant',
      content: text,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    },
    usage,
  }
}
