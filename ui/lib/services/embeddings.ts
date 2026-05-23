/**
 * Cloud embedding model dispatch — used by the semantic TM backfill +
 * lookup. Mirrors cloudLlm.ts dispatch but for `embeddings` endpoints,
 * which return a vector per input string instead of a chat completion.
 *
 * Supported providers:
 *   - OpenAI / OpenRouter / Local (OpenAI-compat): /v1/embeddings
 *     Default model: text-embedding-3-small (1536-d, cheap).
 *   - Gemini: :embedContent (per-string, no batch).
 *
 * Anthropic doesn't ship a native embeddings API; we fall back to
 * OpenAI-compat (the active OpenAI profile if one exists) when the
 * user has Anthropic active.
 */

import { usePreferencesStore } from '@/lib/stores/preferencesStore'

export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small'

export type EmbeddingsConfig = {
  provider: string
  apiKey: string
  apiUrl: string
  model: string
}

/** Read the active LLM profile from prefs and adapt for embeddings. */
export function activeEmbeddingsConfig(): EmbeddingsConfig | null {
  const p = usePreferencesStore.getState()
  if (p.cloudProvider === 'none') return null
  // Anthropic has no embeddings API — surface that to the caller.
  const provider = p.cloudProvider === 'anthropic' ? 'openai' : p.cloudProvider
  return {
    provider,
    apiKey: p.cloudApiKey,
    apiUrl: p.cloudApiUrl || 'https://api.openai.com/v1',
    model: DEFAULT_EMBEDDING_MODEL,
  }
}

/** Embed a list of strings. Returns one vector per input, in order. */
export async function embedBatch(
  cfg: EmbeddingsConfig,
  texts: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  if (texts.length === 0) return []
  switch (cfg.provider) {
    case 'openai':
    case 'openrouter':
      return embedOpenAiCompat(cfg, texts, signal)
    case 'gemini':
      return embedGemini(cfg, texts, signal)
    default:
      throw new Error(`Embeddings not supported for provider: ${cfg.provider}`)
  }
}

async function embedOpenAiCompat(
  cfg: EmbeddingsConfig,
  texts: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  const base = (cfg.apiUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const url =
    cfg.provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1/embeddings'
      : `${base}/embeddings`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  }
  if (cfg.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://koharu.local'
    headers['X-Title'] = 'Koharu TM Embeddings'
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: cfg.model, input: texts }),
    signal,
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(
      `${cfg.provider} embeddings failed (${res.status}): ${err.slice(0, 300)}`,
    )
  }
  const data = await res.json()
  const items: any[] = data.data ?? []
  // Sort by `index` defensively (OpenAI usually returns in order, but
  // the API contract allows any order).
  items.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  return items.map((it) => it.embedding as number[])
}

async function embedGemini(
  cfg: EmbeddingsConfig,
  texts: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  // Gemini's :embedContent is per-string; loop sequentially. Use
  // `text-embedding-004` as the model regardless of cfg.model, since
  // OpenAI model names won't resolve on the Gemini host.
  const model = 'text-embedding-004'
  const out: number[][] = []
  for (const text of texts) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${encodeURIComponent(cfg.apiKey)}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: { parts: [{ text }] },
      }),
      signal,
    })
    if (!res.ok) {
      const err = await res.text().catch(() => '')
      throw new Error(
        `Gemini embeddings failed (${res.status}): ${err.slice(0, 300)}`,
      )
    }
    const data = await res.json()
    const vec = data.embedding?.values as number[] | undefined
    if (!vec) {
      throw new Error('Gemini embeddings returned no `values`')
    }
    out.push(vec)
  }
  return out
}

/** Resolve the actual model id stored alongside the vector. Gemini
 *  overrides cfg.model since it has its own embedding model. */
export function effectiveModel(cfg: EmbeddingsConfig): string {
  return cfg.provider === 'gemini' ? 'text-embedding-004' : cfg.model
}
