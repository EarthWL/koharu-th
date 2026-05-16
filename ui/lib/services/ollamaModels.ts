/**
 * Ollama (local LLM server) model catalog fetcher.
 *
 * Hits `<baseUrl>/api/tags` — Ollama's native endpoint that lists
 * locally-installed models. We accept the `baseUrl` from the user so
 * any OpenAI-compatible local server pointed at the same machine
 * (LM Studio, llama.cpp, vLLM) can swap in by using their /v1/models
 * endpoint instead.
 *
 * If `baseUrl` ends with `/v1` we treat it as OpenAI-compatible and
 * call `<baseUrl>/models`, otherwise we call `<baseUrl>/api/tags`
 * (Ollama-native).
 */

export type OllamaModel = {
  id: string
  name: string
  /** Size in bytes when known (Ollama only). */
  size?: number
}

type OllamaTagsResponse = {
  models?: Array<{
    name?: string
    model?: string
    size?: number
  }>
}

type OpenAiModelsResponse = {
  data?: Array<{
    id: string
  }>
}

function bytesToHuman(n?: number): string | null {
  if (!n) return null
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`
  return `${n} B`
}

export function formatModelSize(n?: number): string | null {
  return bytesToHuman(n)
}

export async function fetchLocalModels(
  baseUrl: string,
): Promise<OllamaModel[]> {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (!trimmed) {
    throw new Error('Local LLM base URL required')
  }
  const isOpenAiCompat = /\/v1$/i.test(trimmed)
  const url = isOpenAiCompat ? `${trimmed}/models` : `${trimmed}/api/tags`

  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `Local model fetch failed (${res.status}): ${body.slice(0, 200)}`,
    )
  }
  const data = (await res.json()) as OllamaTagsResponse & OpenAiModelsResponse

  if (isOpenAiCompat) {
    return (data.data ?? []).map((m) => ({ id: m.id, name: m.id }))
  }
  return (data.models ?? [])
    .map((m): OllamaModel | null => {
      const id = m.name ?? m.model ?? ''
      if (!id) return null
      return { id, name: id, size: m.size }
    })
    .filter((m): m is OllamaModel => m !== null)
}
