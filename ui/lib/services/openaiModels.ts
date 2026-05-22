/**
 * OpenAI (or OpenAI-compatible) model catalog fetcher.
 *
 * Hits `<baseUrl>/models` with `Authorization: Bearer <key>`. Works on
 * the official OpenAI API and any compatible endpoint (Groq, DeepSeek,
 * Mistral, xAI, Together, LM Studio /v1, …). Returns every model the
 * key can see; callers filter for chat-capable IDs because the OpenAI
 * response doesn't categorise them.
 */

import { isMangaRelevantModel } from './modelFilters'

export type OpenAiModel = {
  id: string
  ownedBy?: string
  /** Unix seconds. */
  created?: number
}

type RawOpenAiModelsResponse = {
  data?: Array<{
    id: string
    owned_by?: string
    created?: number
  }>
}

const DEFAULT_BASE = 'https://api.openai.com/v1'

/** Strip `/v1` trailing segment from a base URL if present (caller may
 *  pass the base URL with or without it). Returns a normalised
 *  `<host>/v1` form. */
function normalise(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (!trimmed) return DEFAULT_BASE
  if (/\/v\d+$/.test(trimmed)) return trimmed
  return `${trimmed}/v1`
}

export async function fetchOpenAiModels(
  apiKey: string,
  baseUrl?: string,
): Promise<OpenAiModel[]> {
  if (!apiKey) {
    throw new Error('OpenAI API key required to list models.')
  }
  const url = `${normalise(baseUrl ?? DEFAULT_BASE)}/models`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `OpenAI models fetch failed (${res.status}): ${body.slice(0, 200)}`,
    )
  }
  const data = (await res.json()) as RawOpenAiModelsResponse
  return (data.data ?? []).map((m) => ({
    id: m.id,
    ownedBy: m.owned_by,
    created: m.created,
  }))
}

/**
 * Heuristic filter to drop models the chat translator can't use.
 * Delegates to the shared `isMangaRelevantModel` so OpenAI, OpenRouter,
 * Anthropic and Local stay consistent. OpenAI image/audio/video models
 * live behind separate endpoints, so `allowImage` stays false here —
 * picking dall-e as a chat profile would just fail at call time.
 */
export function isLikelyChatModel(id: string): boolean {
  return isMangaRelevantModel(id, {
    allowImage: false,
    dropLegacyCompletions: true,
  })
}
