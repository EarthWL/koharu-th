/**
 * Heuristic bubble-fit checker for translated text. Thai (and other
 * languages with wider script) often overflows the original bubble
 * which was sized for Japanese/Korean/Chinese — this helper surfaces
 * a warning so the user can adjust font size, edit the translation
 * shorter, or resize the bubble before render.
 *
 * No renderer integration — this runs purely on the text + box
 * dimensions so it works the moment a translation arrives, without
 * waiting for `render` to fall back to floor and silently truncate.
 */

import type { TextBlock } from '@/types'

export type BubbleFitLevel = 'ok' | 'tight' | 'overflow'

export type BubbleFitWarning = {
  level: BubbleFitLevel
  /** Short one-line explanation, suitable for a tooltip. */
  reason: string
  /** Translation/source character ratio (informational). */
  ratio: number
  /** Chars per 1000 px² of box area (informational). */
  density: number
}

const GLYPH_AREA_18PT = 9 * 22 // px² per char at ~18pt Thai
const TIGHT_FILL = 0.78
const OVERFLOW_FILL = 1.05
const TIGHT_RATIO = 1.8
const OVERFLOW_RATIO = 2.4

/** Compute a warning level for a text block. Returns `null` when
 *  there's not enough info (no translation yet, zero-area block, …). */
export function bubbleFitWarning(block: TextBlock): BubbleFitWarning | null {
  const src = block.text?.trim() ?? ''
  const tgt = block.translation?.trim() ?? ''
  if (!tgt) return null

  const area = Math.max(0, block.width) * Math.max(0, block.height)
  if (area <= 0) return null

  const capacity = area / GLYPH_AREA_18PT
  const fill = tgt.length / capacity
  const density = (tgt.length / area) * 1000
  const ratio = src.length > 0 ? tgt.length / src.length : 0

  let level: BubbleFitLevel = 'ok'
  let reason = ''
  if (fill >= OVERFLOW_FILL || ratio >= OVERFLOW_RATIO) {
    level = 'overflow'
    reason = `Translation fills ~${Math.round(fill * 100)}% of bubble at 18pt — text likely won't fit; consider shrinking font, shortening translation, or expanding the bubble.`
  } else if (fill >= TIGHT_FILL || ratio >= TIGHT_RATIO) {
    level = 'tight'
    reason = `Translation is tight (~${Math.round(fill * 100)}% bubble fill${ratio ? `, ${ratio.toFixed(1)}× source length` : ''}). Render may auto-shrink to fit.`
  } else {
    return null
  }
  return { level, reason, ratio, density }
}
