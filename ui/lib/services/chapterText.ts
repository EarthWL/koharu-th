'use client'

import { api } from '@/lib/api'

/**
 * Concatenate the source text from every block of every page currently
 * loaded in the editor workspace. Used by the summarise / extract
 * modals so the user doesn't have to paste chapter text by hand.
 *
 * Pages are joined with "\n\n--- page N ---\n\n" so the LLM can see
 * page boundaries.
 */
export async function loadCurrentWorkspaceText(): Promise<string> {
  const count = await api.getDocumentsCount()
  if (!count) return ''
  const parts: string[] = []
  for (let i = 0; i < count; i++) {
    try {
      const doc = await api.getDocument(i)
      const pageText = (doc.textBlocks ?? [])
        .map((b: { text?: string | null }) => b.text?.trim() ?? '')
        .filter(Boolean)
        .join('\n')
      if (pageText) {
        parts.push(`--- page ${i + 1} ---\n${pageText}`)
      }
    } catch (err) {
      console.warn(`[chapterText] page ${i} fetch failed`, err)
    }
  }
  return parts.join('\n\n')
}
