/**
 * Google Gemini model catalog fetcher.
 *
 * Hits https://generativelanguage.googleapis.com/v1beta/models?key=…
 * — requires an API key (Google rejects unauthenticated requests).
 * Returned IDs come back as "models/gemini-2.5-flash"; we strip the
 * "models/" prefix because that's what `generateContent` accepts.
 */

const GEMINI_MODELS_URL =
  'https://generativelanguage.googleapis.com/v1beta/models'

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
  return items
    .map((raw): GeminiModel | null => {
      const fullName = raw.name ?? ''
      if (!fullName.startsWith('models/')) return null
      const id = fullName.slice('models/'.length)
      const supportedActions = raw.supportedGenerationMethods ?? []
      // Only surface models we can actually use for translation.
      if (!supportedActions.includes('generateContent')) return null
      const lower = id.toLowerCase()
      if (
        lower.includes('tts') ||
        lower.includes('embedding') ||
        lower.includes('audio')
      ) {
        // We only want text/multimodal chat models, not pure audio/TTS/embedding endpoints.
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
}

export function formatTokenLimit(n?: number): string | null {
  if (!n) return null
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}
