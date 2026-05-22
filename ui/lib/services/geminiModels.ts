/**
 * Google Gemini model catalog fetcher.
 *
 * Hits https://generativelanguage.googleapis.com/v1beta/models?key=…
 * — requires an API key (Google rejects unauthenticated requests).
 * Returned IDs come back as "models/gemini-2.5-flash"; we strip the
 * "models/" prefix because that's what `generateContent` accepts.
 *
 * The /models endpoint returns the full *public catalog*, not just
 * models this key can actually call. We post-filter by probing each
 * candidate with the cheap :countTokens endpoint and dropping ones
 * that explicitly reject the key (403 PERMISSION_DENIED / 404
 * NOT_FOUND). Other transient failures (429, 5xx, network) keep the
 * model in the list so a temporary rate-limit doesn't permanently
 * hide it from the picker.
 */

import { isMangaRelevantModel, classifyRateLimit } from './modelFilters'

const GEMINI_MODELS_URL =
  'https://generativelanguage.googleapis.com/v1beta/models'

/** Max parallel `countTokens` probes — Google's free tier rate-limits
 *  aggressively, so keep this conservative. */
const PROBE_CONCURRENCY = 5

export type GeminiModel = {
  /** Bare id without the "models/" prefix. What the user pastes into modelName. */
  id: string
  name: string
  description?: string
  inputTokenLimit?: number
  outputTokenLimit?: number
  supportedActions: string[]
}

type RawGeminiModel = {
  name?: string
  displayName?: string
  description?: string
  inputTokenLimit?: number
  outputTokenLimit?: number
  supportedGenerationMethods?: string[]
}

export async function fetchGeminiModels(
  apiKey: string,
): Promise<GeminiModel[]> {
  if (!apiKey) {
    throw new Error('Gemini API key required to list models.')
  }
  const url = new URL(GEMINI_MODELS_URL)
  url.searchParams.set('key', apiKey)
  // Page through all results — pageSize maxes out at 1000 per docs.
  url.searchParams.set('pageSize', '1000')

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `Gemini models fetch failed (${res.status}): ${body.slice(0, 200)}`,
    )
  }
  const data = (await res.json()) as { models?: RawGeminiModel[] }
  const items = data.models ?? []
  const catalog = items
    .map((raw): GeminiModel | null => {
      const fullName = raw.name ?? ''
      if (!fullName.startsWith('models/')) return null
      const id = fullName.slice('models/'.length)
      const supportedActions = raw.supportedGenerationMethods ?? []
      // Only surface models we can actually use for translation.
      if (!supportedActions.includes('generateContent')) return null
      // Koharu's manga pipeline spans translation + vision OCR +
      // multi-tier inpainting (image gen) + agentic AI chat. Gemini
      // routes image generation through the same generateContent
      // endpoint as chat, so we KEEP image models (allowImage: true) —
      // unlike OpenAI/OpenRouter where image gen is a separate endpoint.
      // Shared filter drops audio/music/video/embedding/robotics.
      if (!isMangaRelevantModel(id, { allowImage: true })) {
        return null
      }

      return {
        id,
        name: raw.displayName || id,
        description: raw.description,
        inputTokenLimit: raw.inputTokenLimit,
        outputTokenLimit: raw.outputTokenLimit,
        supportedActions,
      }
    })
    .filter((m): m is GeminiModel => m !== null)

  // Probe each catalog entry to keep only ones the key can actually
  // call. countTokens is the cheapest authenticated probe and doesn't
  // consume generation quota.
  return filterAccessibleModels(catalog, apiKey)
}

/** Probe a single model with `generateContent` (1-token output). Tighter
 *  filter than `:countTokens` — Gemini gladly returns token counts for
 *  preview-only models the key can't actually call. `generateContent`
 *  surfaces the real permission via 403/404 and lets us drop those.
 *
 *  Returns:
 *   - true if the model accepted the call
 *   - false if the API explicitly rejects access (400/403/404)
 *   - true (keep) on transient failures (429/5xx/network)
 */
async function isModelAccessible(
  modelId: string,
  apiKey: string,
): Promise<boolean> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'ok' }] }],
        // Cap to 1 token so the probe costs the bare minimum.
        generationConfig: { maxOutputTokens: 1 },
      }),
    })
    if (res.ok) return true
    // 403 PERMISSION_DENIED → key lacks access (paid-tier, geo-block, ToS).
    // 404 NOT_FOUND → model id retired or not yet available to this key.
    // 400 with FAILED_PRECONDITION on preview models = same outcome (drop).
    if (res.status === 400 || res.status === 403 || res.status === 404) {
      return false
    }
    // 429 is ambiguous: temporary rate-limit (keep) vs zero-quota tier
    // (drop — e.g. Nano Banana image gen on free tier shows 0/0).
    // Shared classifier tells them apart.
    if (res.status === 429) {
      const body = await res.text().catch(() => '')
      const cls = classifyRateLimit({
        body,
        retryAfterHeader: res.headers.get('retry-after'),
      })
      return cls.kind !== 'no_quota' // drop only on zero-quota
    }
    // Other transient failures (5xx, etc.) — keep the model so a
    // temporary failure doesn't permanently hide it.
    return true
  } catch {
    // Network errors are transient. Keep the model.
    return true
  }
}

async function filterAccessibleModels(
  models: GeminiModel[],
  apiKey: string,
): Promise<GeminiModel[]> {
  const accessible: GeminiModel[] = []
  // Bounded concurrency: process the catalog in chunks of
  // PROBE_CONCURRENCY to stay friendly to Google's rate-limits.
  for (let i = 0; i < models.length; i += PROBE_CONCURRENCY) {
    const batch = models.slice(i, i + PROBE_CONCURRENCY)
    const results = await Promise.all(
      batch.map((m) => isModelAccessible(m.id, apiKey)),
    )
    batch.forEach((m, idx) => {
      if (results[idx]) accessible.push(m)
    })
  }
  return accessible
}

export function formatTokenLimit(n?: number): string | null {
  if (!n) return null
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}
