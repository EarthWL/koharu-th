/**
 * Thai post-processing for LLM translation output.
 *
 * Cloud LLMs (and to a lesser extent local LLMs) often emit Thai
 * translations with two cosmetic defects that hurt the rendered
 * manga page:
 *
 *   1. Excess whitespace BETWEEN adjacent Thai characters
 *      ("กิน ข้าว" instead of "กินข้าว"). Some models tokenise
 *      Thai by syllable / cluster and emit spaces between them.
 *   2. Straight ASCII quotes (`"..."`, `'...'`) instead of typographic
 *      curly quotes (`"..."`, `'...'`). Manga bubbles look noticeably
 *      cleaner with curly quotes.
 *
 * Both are corrected here in a pre-render pass. The fix is conservative:
 *
 *   - Whitespace is collapsed ONLY when BOTH sides are Thai characters
 *     (U+0E00–U+0E7F). Mixed-script content like "กิน rice" keeps the
 *     space, character names like "Rio_n_riorion" are untouched.
 *   - Quote conversion uses position heuristics (opening quote after
 *     whitespace / start of string / opening bracket; closing quote
 *     otherwise). Apostrophes in English contractions ("don't") get
 *     curly-quoted too — that's the standard typographic convention,
 *     not a regression.
 *
 * Issue: https://github.com/EarthWL/koharu-th/issues/21
 */

const THAI_CLUSTER = /([฀-๿])\s+(?=[฀-๿])/g

export function applyThaiPostProcess(text: string): string {
  if (!text) return text

  let out = text

  // 1. Collapse inter-Thai whitespace. Lookahead so consecutive runs
  //    of "<Thai> <space>+ <Thai>" all collapse in one pass.
  out = out.replace(THAI_CLUSTER, '$1')

  // 2. Smart double quotes — opening = after whitespace / start /
  //    opening bracket / start-of-line; closing otherwise. Do opening
  //    pass first so the catch-all closing-quote pass sees only the
  //    leftover unmatched ones.
  out = out.replace(/(^|[\s([{<])"/g, '$1“') // U+201C LEFT DOUBLE QUOTATION MARK
  out = out.replace(/"/g, '”') // U+201D RIGHT DOUBLE QUOTATION MARK

  // 3. Same treatment for single quotes / apostrophes. Note this
  //    converts "don't" → "don't" (U+2019 RIGHT SINGLE QUOTATION
  //    MARK) — standard typography, not a bug.
  out = out.replace(/(^|[\s([{<])'/g, '$1‘') // U+2018 LEFT SINGLE QUOTATION MARK
  out = out.replace(/'/g, '’') // U+2019 RIGHT SINGLE QUOTATION MARK / APOSTROPHE

  return out
}

/**
 * Apply the post-process to every textBlock.translation in place,
 * returning the (possibly mutated) array. Cheap copy-on-write semantics:
 * blocks with unchanged translation share the same object reference
 * with the input, so React Query / Zustand referential equality checks
 * still skip no-op re-renders.
 */
export function applyThaiPostProcessToBlocks<
  T extends { translation?: string | null },
>(blocks: T[]): T[] {
  let anyChanged = false
  const next = blocks.map((b) => {
    if (!b.translation) return b
    const cleaned = applyThaiPostProcess(b.translation)
    if (cleaned === b.translation) return b
    anyChanged = true
    return { ...b, translation: cleaned }
  })
  return anyChanged ? next : blocks
}
