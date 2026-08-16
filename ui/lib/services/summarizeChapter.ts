'use client'

import { api } from '@/lib/api'
import { useProjectStore } from '@/lib/stores/projectStore'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'

/**
 * Generate a 2-3 sentence summary of a chapter's text via the project's
 * `summarize_chapter` template + the configured cloud provider, then
 * persist it to the chapter row.
 *
 * Returns the saved summary string. Throws if no project is open or no
 * cloud provider is configured.
 */
export async function summarizeChapter(
  chapterId: number,
  fullText: string,
): Promise<string> {
  if (!useProjectStore.getState().info) {
    throw new Error('Open a project first.')
  }
  const { cloudProvider, cloudApiKey, cloudApiUrl, cloudModelName } =
    usePreferencesStore.getState()
  if (cloudProvider === 'none') {
    throw new Error(
      'Pick a Cloud AI provider — summarisation uses the cloud LLM.',
    )
  }
  if (!cloudApiKey) throw new Error('Cloud API Key is missing.')

  const rendered = await api.promptRender({
    useCase: 'summarize_chapter',
    sourceText: fullText,
  })

  // We deliberately reuse the simple chat-completion shapes from
  // cloudLlm.ts via dynamic import to avoid a circular dependency.
  const { callCloudOnce } = await import('./cloudLlm')
  const summary = await callCloudOnce({
    prompt: rendered.prompt,
    provider: cloudProvider,
    apiKey: cloudApiKey,
    apiUrl: cloudApiUrl,
    model: cloudModelName,
    jsonMode: false,
    useCase: 'summarize_chapter',
  })

  await api.chapterUpdate({ id: chapterId, summary })
  return summary
}
