import type { TextBlock } from '@/types'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import i18n from '@/lib/i18n'

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

// Unicode ranges for Thai combining characters (accent/tone marks & above/below vowels)
// that do not occupy horizontal layout width.
const THAI_COMBINING_REGEXP = /[\u0e31\u0e34-\u0e3a\u0e47-\u0e4e]/g

// Speeches in manga are usually enclosed in rounded or oval speech bubbles.
// The area of an ellipse inscribed in a rectangle of width W and height H is (pi / 4) * W * H ~= 0.785 * area.
// We apply a realistic bubble boundary margin correction of 0.80.
const OVAL_BUBBLE_CORRECTION = 0.80

// Standard estimated font size in pixels if auto-fit or not specified
const DEFAULT_FONT_SIZE_PX = 20

/** Compute a warning level for a text block. Returns `null` when
 *  there's not enough info (no translation yet, zero-area block, …). */
export function bubbleFitWarning(block: TextBlock): BubbleFitWarning | null {
  const src = block.text?.trim() ?? ''
  const tgt = block.translation?.trim() ?? ''
  if (!tgt) return null

  const area = Math.max(0, block.width) * Math.max(0, block.height)
  if (area <= 0) return null

  // 1. Calculate effective character length based on target language
  const { cloudTargetLanguage } = usePreferencesStore.getState()
  const isThai = (cloudTargetLanguage || 'Thai').toLowerCase() === 'thai'
  const effectiveLength = isThai 
    ? tgt.replace(THAI_COMBINING_REGEXP, '').length 
    : tgt.length

  // 2. Determine target font size to base the capacity check on
  // If the user has locked a specific fontSize, use it; otherwise assume DEFAULT_FONT_SIZE_PX
  const fontSize = block.style?.fontSize && block.style.fontSize > 0
    ? block.style.fontSize
    : DEFAULT_FONT_SIZE_PX

  // 3. Calculate dynamic glyph footprint area
  // An average character has width proportional to height (approx 0.42x height)
  const charWidth = fontSize * 0.42
  const charHeight = fontSize * 1.1 // adding line padding
  const glyphArea = charWidth * charHeight

  // 4. Calculate bubble capacity with oval boundary correction
  const usableArea = area * OVAL_BUBBLE_CORRECTION
  const capacity = usableArea / glyphArea
  
  const fill = effectiveLength / capacity
  const density = (effectiveLength / area) * 1000
  const ratio = src.length > 0 ? effectiveLength / src.length : 0

  // Adjust thresholds based on whether it is custom size or auto
  const isAuto = !block.style?.fontSize
  
  // If it's auto-fit, we allow a higher threshold because the renderer will scale down,
  // but if the scaled font size would fall below 11px, we warn about overflow.
  const minReadableFontSize = 11
  const minReadableCapacity = usableArea / (minReadableFontSize * 0.42 * minReadableFontSize * 1.1)
  const wouldBeTooSmall = isAuto && effectiveLength > minReadableCapacity

  let level: BubbleFitLevel = 'ok'
  let reason = ''

  if (!isAuto) {
    // Locked font size limits
    const OVERFLOW_FILL = 1.05
    const TIGHT_FILL = 0.80

    if (fill >= OVERFLOW_FILL) {
      level = 'overflow'
      reason = i18n.t('bubbleFit.overflowLocked', { fill: Math.round(fill * 100), fontSize: Math.round(fontSize) })
    } else if (fill >= TIGHT_FILL) {
      level = 'tight'
      reason = i18n.t('bubbleFit.tightLocked', { fill: Math.round(fill * 100), fontSize: Math.round(fontSize) })
    } else {
      return null
    }
  } else {
    // Auto-fit font size limits
    const OVERFLOW_RATIO = 2.4
    const TIGHT_RATIO = 1.7

    if (wouldBeTooSmall) {
      level = 'overflow'
      const estimatedAutoFs = Math.max(5, Math.round((usableArea / (effectiveLength * 0.42 * 1.1)) ** 0.5))
      reason = i18n.t('bubbleFit.overflowAutoTooSmall', { fontSize: estimatedAutoFs })
    } else if (fill >= 1.0 || ratio >= OVERFLOW_RATIO) {
      level = 'overflow'
      reason = i18n.t('bubbleFit.overflowAutoLarge', { fill: Math.round(fill * 100) })
    } else if (fill >= 0.75 || ratio >= TIGHT_RATIO) {
      level = 'tight'
      reason = i18n.t('bubbleFit.tightAutoRatio', { ratio: ratio.toFixed(1) })
    } else {
      return null
    }
  }

  return { level, reason, ratio, density }
}
