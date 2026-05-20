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

import { usePreferencesStore } from '@/lib/stores/preferencesStore'

const THAI_CLUSTER = /([฀-๿])\s+(?=[฀-๿])/g

export function applyThaiPostProcess(text: string): string {
  if (!text) return text

  const { cloudTargetLanguage } = usePreferencesStore.getState()
  const targetLang = (cloudTargetLanguage || 'Thai').toLowerCase()

  let out = text

  if (targetLang === 'thai') {
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
  } else if (targetLang === 'french') {
    // French Typography:
    // 1. Double quotes to French guillemets with non-breaking spaces (U+00A0)
    out = out.replace(/(^|[\s([{<])"/g, '$1«\u00a0')
    out = out.replace(/"/g, '\u00a0»')

    // 2. Non-breaking space before high punctuation marks: ? ! ; :
    out = out.replace(/\s*([?!;:])($|[\s)\]}])/g, '\u00a0$1$2')
    out = out.replace(/\s*:\s*/g, '\u00a0:\u00a0')
  } else if (targetLang === 'german') {
    // German Typography:
    // 1. Double quotes → lower-opening „..." (U+201E open / U+201C close)
    out = out.replace(/(^|[\s([{<])"/g, '$1\u201e')
    out = out.replace(/"/g, '\u201c')

    // 2. Single quotes → ‚...' (U+201A open / U+2018 close)
    out = out.replace(/(^|[\s([{<])'/g, '$1\u201a')
    out = out.replace(/'/g, '\u2018')
  } else if (targetLang === 'spanish') {
    // Spanish Typography:
    // 1. Guillemets « » without extra spaces
    out = out.replace(/(^|[\s([{<])"/g, '$1«')
    out = out.replace(/"/g, '»')
  } else if (targetLang === 'portuguese') {
    // Portuguese Typography:
    // Standard curly double quotes "..." — used in both Brazilian and
    // European Portuguese manga translations (not guillemets).
    out = out.replace(/(^|[\s([{<])"/g, '$1\u201c')
    out = out.replace(/"/g, '\u201d')

    // Single quotes / apostrophes
    out = out.replace(/(^|[\s([{<])'/g, '$1\u2018')
    out = out.replace(/'/g, '\u2019')
  } else if (targetLang === 'korean') {
    // Korean Typography:
    // 1. Collapse inter-Hangul whitespace.
    //    LLMs sometimes emit "나 는" instead of "나는" — same problem as Thai.
    //    Hangul syllables U+AC00–U+D7A3, Jamo U+1100–U+11FF / U+3130–U+318F.
    const HANGUL = '\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F'
    const HANGUL_SPACE_RE = new RegExp(`([${HANGUL}]) ([${HANGUL}])`, 'g')
    let prevKo = ''
    while (prevKo !== out) { prevKo = out; out = out.replace(HANGUL_SPACE_RE, '$1$2') }

    // 2. Standard curly double quotes (Korean uses same convention as English)
    out = out.replace(/(^|[\s([{<])"/g, '$1\u201c')
    out = out.replace(/"/g, '\u201d')
  } else {
    // Standard English / General typography: Curly quotes
    out = out.replace(/(^|[\s([{<])"/g, '$1“')
    out = out.replace(/"/g, '”')
    out = out.replace(/(^|[\s([{<])'/g, '$1‘')
    out = out.replace(/'/g, '’')
  }

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
