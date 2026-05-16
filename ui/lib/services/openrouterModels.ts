/**
 * OpenRouter model catalog fetcher.
 *
 * Hits https://openrouter.ai/api/v1/models — the endpoint is technically
 * public (works without auth) but we pass the API key when available so
 * the response reflects model availability/pricing for that account.
 */

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'

export type OpenRouterModel = {
  id: string
  name: string
  description?: string
  contextLength?: number
  pricing?: {
    promptUsdPerToken?: number
    completionUsdPerToken?: number
  }
  /** Indicates whether the model can be invoked without per-call charge. */
  isFree?: boolean
}

type RawOpenRouterModel = {
  id: string
  name?: string
  description?: string
  context_length?: number
  pricing?: {
    prompt?: string | number
    completion?: string | number
  }
}

function toNumber(v: string | number | undefined): number | undefined {
  if (v === undefined || v === null) return undefined
  const n = typeof v === 'string' ? parseFloat(v) : v
  return Number.isFinite(n) ? n : undefined
}

export async function fetchOpenRouterModels(apiKey?: string): Promise<OpenRouterModel[]> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
  }
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }
  const res = await fetch(OPENROUTER_MODELS_URL, { headers })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`OpenRouter models fetch failed (${res.status}): ${body.slice(0, 200)}`)
  }
  const data = (await res.json()) as { data?: RawOpenRouterModel[] }
  const items = data.data ?? []
  return items.map((raw) => {
    const prompt = toNumber(raw.pricing?.prompt)
    const completion = toNumber(raw.pricing?.completion)
    return {
      id: raw.id,
      name: raw.name || raw.id,
      description: raw.description,
      contextLength: raw.context_length,
      pricing: {
        promptUsdPerToken: prompt,
        completionUsdPerToken: completion,
      },
      isFree: prompt === 0 && completion === 0,
    }
  })
}

/** Format pricing as $/M tokens, e.g. "$2.50/M". Returns null if unknown. */
export function formatPricePerMillion(usdPerToken?: number): string | null {
  if (usdPerToken === undefined) return null
  const perMillion = usdPerToken * 1_000_000
  if (perMillion === 0) return 'free'
  if (perMillion < 0.01) return `$${perMillion.toFixed(4)}/M`
  if (perMillion < 1) return `$${perMillion.toFixed(3)}/M`
  return `$${perMillion.toFixed(2)}/M`
}

/** Format a context length like 128000 → "128K". */
export function formatContextLength(n?: number): string | null {
  if (!n) return null
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M ctx`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K ctx`
  return `${n} ctx`
}
