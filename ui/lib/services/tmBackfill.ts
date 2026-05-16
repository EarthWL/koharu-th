/**
 * Drive an embedding backfill loop: keep pulling pending TM entries
 * from the backend, embed them in batches via the active provider,
 * and write the resulting vectors back. Idempotent + resumable.
 *
 * Caller supplies a progress callback so a UI button can show
 * "embedded N of M" while it runs. Returns total embedded.
 */

import { api } from '@/lib/api'
import {
  activeEmbeddingsConfig,
  effectiveModel,
  embedBatch,
} from '@/lib/services/embeddings'

const BATCH_SIZE = 32

export type BackfillProgress = {
  done: number
  total: number
  /** Human-readable status — for tooltip / status line. */
  label: string
}

export async function runTmEmbeddingBackfill(
  onProgress: (p: BackfillProgress) => void,
  signal?: AbortSignal,
): Promise<{ embedded: number; model: string }> {
  const cfg = activeEmbeddingsConfig()
  if (!cfg) {
    throw new Error(
      'No active cloud LLM profile — apply one in the Profiles tab first.',
    )
  }
  if (cfg.provider === 'anthropic') {
    // We already remap Anthropic → OpenAI in activeEmbeddingsConfig,
    // but require an OpenAI key in that case.
    if (!cfg.apiKey) {
      throw new Error(
        'Anthropic has no embeddings API — apply an OpenAI / OpenRouter / Local profile instead.',
      )
    }
  }
  if (!cfg.apiKey && cfg.provider !== 'openrouter') {
    throw new Error('Active profile has no API key configured.')
  }

  const model = effectiveModel(cfg)
  const total = await api.tmPendingCount(model)
  onProgress({ done: 0, total, label: 'starting…' })
  if (total === 0) return { embedded: 0, model }

  let done = 0
  while (true) {
    if (signal?.aborted) break
    const pending = await api.tmPendingEmbeddings({ model, limit: BATCH_SIZE })
    if (pending.length === 0) break

    onProgress({ done, total, label: `embedding ${pending.length}…` })
    const vectors = await embedBatch(
      cfg,
      pending.map((p) => p.sourceText),
      signal,
    )

    for (let i = 0; i < pending.length; i++) {
      const vec = vectors[i]
      if (!vec) continue
      await api.tmSetEmbedding({
        id: pending[i].id,
        embedding: vec,
        model,
      })
      done += 1
      onProgress({ done, total, label: `wrote ${done}/${total}` })
    }
  }

  return { embedded: done, model }
}
