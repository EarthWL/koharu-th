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

/**
 * Run detect + OCR on every loaded page that doesn't have text yet,
 * then return the concatenated text. Idempotent — pages that already
 * have text blocks (i.e. OCR was run before) are skipped. Calls
 * `onProgress(done, total, label)` after each page so callers can
 * surface progress.
 *
 * Used by the auto-extract flow that runs immediately after a user
 * adds pages to a fresh chapter — they shouldn't have to walk through
 * "click detect, click ocr, repeat" before the LLM can read the text.
 */
export async function ocrAllOpenPages(
  onProgress: (done: number, total: number, label: string) => void,
): Promise<string> {
  const count = await api.getDocumentsCount()
  if (!count) return ''
  for (let i = 0; i < count; i++) {
    onProgress(i, count, `Page ${i + 1}: detect`)
    try {
      const before = await api.getDocument(i)
      if ((before.textBlocks ?? []).length === 0) {
        await api.detect(i)
      }
      const afterDetect = await api.getDocument(i)
      const needsOcr = (afterDetect.textBlocks ?? []).some(
        (b: { text?: string | null }) => !b.text || b.text.trim() === '',
      )
      if (needsOcr) {
        onProgress(i, count, `Page ${i + 1}: ocr`)
        await api.ocr(i)
      }
    } catch (err) {
      console.warn(`[chapterText] ocr page ${i} failed`, err)
    }
    onProgress(i + 1, count, `Page ${i + 1} done`)
  }
  return loadCurrentWorkspaceText()
}
