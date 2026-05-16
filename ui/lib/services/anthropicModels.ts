/**
 * Anthropic (Claude) model catalog fetcher.
 *
 * Hits https://api.anthropic.com/v1/models with `x-api-key` +
 * `anthropic-version`. Anthropic also requires
 * `anthropic-dangerous-direct-browser-access: true` for calls made
 * from a browser/webview origin (otherwise CORS preflight is rejected).
 *
 * The list endpoint is paginated (`has_more`, `last_id`) but in
 * practice fits in one page — we still page-through defensively.
 */

const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models'
const ANTHROPIC_VERSION = '2023-06-01'

export type AnthropicModel = {
  id: string
  displayName: string
  /** RFC 3339 timestamp. */
  createdAt?: string
}

type RawAnthropicModelsResponse = {
  data?: Array<{
    type?: string
    id: string
    display_name?: string
    created_at?: string
  }>
  has_more?: boolean
  last_id?: string
}

export async function fetchAnthropicModels(
  apiKey: string,
): Promise<AnthropicModel[]> {
  if (!apiKey) {
    throw new Error('Anthropic API key required to list models.')
  }

  const all: AnthropicModel[] = []
  let cursor: string | undefined
  for (let page = 0; page < 10; page++) {
    const url = new URL(ANTHROPIC_MODELS_URL)
    url.searchParams.set('limit', '100')
    if (cursor) url.searchParams.set('after_id', cursor)

    const res = await fetch(url.toString(), {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
        Accept: 'application/json',
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(
        `Anthropic models fetch failed (${res.status}): ${body.slice(0, 200)}`,
      )
    }
    const data = (await res.json()) as RawAnthropicModelsResponse
    const items = data.data ?? []
    for (const raw of items) {
      all.push({
        id: raw.id,
        displayName: raw.display_name || raw.id,
        createdAt: raw.created_at,
      })
    }
    if (!data.has_more || !data.last_id) break
    cursor = data.last_id
  }
  return all
}

export function formatAnthropicCreatedAt(iso?: string): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}
