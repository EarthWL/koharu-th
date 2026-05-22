/**
 * Shared model-catalog filtering for cloud LLM providers.
 *
 * Every provider's `/models` list includes endpoints that have no role
 * in koharu's manga pipeline (translation chat + vision OCR + agentic
 * chat + — for Gemini only — inline image generation). This module
 * centralises the "is this model relevant?" decision so all providers
 * behave consistently.
 *
 * ## Why image handling is provider-specific
 *
 * - **Gemini**: image generation (Nano Banana / Imagen) runs through
 *   the SAME `:generateContent` endpoint as chat, so an image model
 *   selected as a chat profile actually works (multimodal output).
 *   → `allowImage: true`.
 * - **OpenAI / OpenRouter / Anthropic**: image generation lives behind
 *   a SEPARATE endpoint (`/images/generations`, etc.), not
 *   `/chat/completions`. Selecting an image model as a chat/translation
 *   profile would just fail at call time, so we hide them.
 *   → `allowImage: false`.
 *
 * Vision *input* (reading manga pages) is a property of multimodal chat
 * models (gpt-4o, claude-3.5, gemini-flash) and is never filtered out.
 */

/** Families that are never useful as a manga chat/translation profile,
 *  regardless of provider. */
const ALWAYS_DROP = [
  'tts',
  'whisper',
  'audio',
  'embedding',
  'moderation',
  'lyria', // music generation (Gemini)
  'veo', // video generation (Gemini)
  'sora', // video generation (OpenAI)
  'robotics',
  'text-similarity',
]

/** Image-generation markers — dropped unless the provider routes image
 *  output through its chat endpoint (Gemini). */
const IMAGE_MARKERS = ['image', 'dall-e', 'imagen', 'nano-banana']

/** Legacy OpenAI completion models that aren't chat-capable. */
const LEGACY_OPENAI = ['davinci', 'babbage', 'curie', 'ada']

export interface ModelFilterOptions {
  /** Keep image-generation models (true only for Gemini). */
  allowImage?: boolean
  /** Drop legacy non-chat completion models (OpenAI-family). */
  dropLegacyCompletions?: boolean
}

/**
 * Classify a Gemini HTTP 429 body. A 429 means one of two very
 * different things and the UI should react differently:
 *
 *   - **no_quota**: the metric ceiling is 0 — the key's tier has *zero*
 *     allowance for this model (e.g. Nano Banana image gen on the free
 *     tier; AI Studio shows it as 0/0). Retrying never helps; the user
 *     must switch model or upgrade tier.
 *   - **rate_limited**: ceiling is N>0 but momentarily exhausted (free
 *     tier text models are 5 req/min). Waiting `retrySec` fixes it.
 *
 * Used by both the model-picker probe and the runtime error handlers so
 * the distinction is consistent everywhere.
 */
export function classifyGemini429(body: string): {
  kind: 'no_quota' | 'rate_limited'
  retrySec: number | null
} {
  const limitMatch =
    body.match(/limit:\s*"?(\d+)"?/i) ||
    body.match(/quota_limit_value"?\s*:\s*"?(\d+)"?/i)
  if (limitMatch && parseInt(limitMatch[1], 10) === 0) {
    return { kind: 'no_quota', retrySec: null }
  }
  // Pull the RetryInfo hint (e.g. "retryDelay": "36s") when present.
  let retrySec: number | null = null
  try {
    const json = JSON.parse(body)
    const details: any[] = json?.error?.details ?? []
    for (const d of details) {
      if (typeof d?.retryDelay === 'string') {
        const m = d.retryDelay.match(/^(\d+)s$/)
        if (m) retrySec = parseInt(m[1], 10)
      }
    }
  } catch {
    // best-effort
  }
  return { kind: 'rate_limited', retrySec }
}

/**
 * Decide whether a model id should appear in the manga model picker.
 * Returns true to KEEP, false to DROP.
 */
export function isMangaRelevantModel(
  id: string,
  options: ModelFilterOptions = {},
): boolean {
  const lower = id.toLowerCase()

  if (ALWAYS_DROP.some((kw) => lower.includes(kw))) return false

  if (!options.allowImage && IMAGE_MARKERS.some((kw) => lower.includes(kw))) {
    return false
  }

  if (options.dropLegacyCompletions) {
    if (LEGACY_OPENAI.some((kw) => lower.includes(kw))) return false
    if (lower.startsWith('ft:')) return false // fine-tuning artefacts
    if (lower.includes('realtime')) return false // realtime audio API
  }

  return true
}
