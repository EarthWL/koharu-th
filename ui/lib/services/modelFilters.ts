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

export type RateLimitClass = {
  kind: 'no_quota' | 'rate_limited'
  retrySec: number | null
}

/**
 * Classify an HTTP 429 (or quota-related 4xx) across providers. A 429
 * means one of two very different things and the UI should react
 * differently:
 *
 *   - **no_quota**: the key's tier has *zero* allowance for this model
 *     or has run out of credits entirely — retrying never helps; the
 *     user must switch model / upgrade tier / top up. Examples:
 *       · Gemini: quota metric `limit: 0` (Nano Banana free tier 0/0)
 *       · OpenAI: `insufficient_quota` (out of credits)
 *       · OpenRouter: `insufficient_credits` / 402
 *   - **rate_limited**: ceiling is N>0 but momentarily exhausted
 *     (free-tier text models, per-minute caps). Waiting `retrySec`
 *     fixes it.
 *
 * Provider-agnostic: pass the raw body + the `Retry-After`/`retry-after`
 * header value when available (OpenAI & Anthropic put the wait there;
 * Gemini encodes it in the body). Used by the model-picker probe and
 * every runtime error handler so the distinction is consistent.
 */
export function classifyRateLimit(opts: {
  body: string
  retryAfterHeader?: string | null
}): RateLimitClass {
  const { body, retryAfterHeader } = opts
  const lower = body.toLowerCase()

  // ── no_quota markers ──────────────────────────────────────────
  // Gemini: quota metric ceiling of 0.
  const limitMatch =
    body.match(/limit:\s*"?(\d+)"?/i) ||
    body.match(/quota_limit_value"?\s*:\s*"?(\d+)"?/i)
  const geminiZeroQuota = !!limitMatch && parseInt(limitMatch[1], 10) === 0
  // OpenAI / OpenRouter: out-of-credits markers.
  const creditExhausted =
    lower.includes('insufficient_quota') ||
    lower.includes('insufficient_credits') ||
    lower.includes('exceeded your current quota') ||
    lower.includes('billing_hard_limit')
  if (geminiZeroQuota || creditExhausted) {
    return { kind: 'no_quota', retrySec: null }
  }

  // ── retry hint ────────────────────────────────────────────────
  let retrySec: number | null = null
  // 1. Retry-After header (OpenAI/Anthropic) — integer seconds or HTTP date.
  if (retryAfterHeader) {
    const asInt = parseInt(retryAfterHeader, 10)
    if (Number.isFinite(asInt) && String(asInt) === retryAfterHeader.trim()) {
      retrySec = asInt
    } else {
      const when = Date.parse(retryAfterHeader)
      if (!Number.isNaN(when)) {
        retrySec = Math.max(0, Math.round((when - Date.now()) / 1000))
      }
    }
  }
  // 2. Gemini RetryInfo body hint (e.g. "retryDelay": "36s").
  if (retrySec === null) {
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
  }
  return { kind: 'rate_limited', retrySec }
}

/** @deprecated use `classifyRateLimit`. Kept as a thin Gemini-only
 *  shim for the model-picker probe which only has the body. */
export function classifyGemini429(body: string): RateLimitClass {
  return classifyRateLimit({ body })
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
