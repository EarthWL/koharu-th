/**
 * Detect the dominant source language of a manga page from its raw
 * OCR output. Used by the "Auto-detect" button next to Source language
 * in the Project panel so the user doesn't have to manually tag each
 * series. Issue #20.
 *
 * Strategy: count characters from each diagnostic Unicode block.
 * Whichever block has the most hits wins, with a few language-specific
 * tiebreakers (kana presence forces Japanese even if Han dominates;
 * Hangul alone means Korean).
 *
 *   - Hiragana   U+3040–U+309F   → Japanese
 *   - Katakana   U+30A0–U+30FF   → Japanese
 *   - Hangul syllables U+AC00–U+D7AF → Korean
 *   - Hangul jamo      U+1100–U+11FF, U+3130–U+318F → Korean
 *   - Han CJK    U+4E00–U+9FFF   → Chinese OR Japanese (kana tiebreaker)
 *   - Latin ASCII letters → English (fallback)
 *
 * Returns null when there's no usable signal (e.g. blocks contain only
 * SFX symbols, punctuation, numerals) so the caller can keep the
 * current series.source_language untouched.
 *
 * Returned strings match the ISO 639-1 codes the prompt pipeline's
 * `map_lang_name()` understands (`koharu-project/src/prompt.rs`):
 * 'ja' / 'ko' / 'zh' / 'en'. Anything else is best left to manual entry.
 */

export type DetectedSourceLanguage = 'ja' | 'ko' | 'zh' | 'en' | null

const SAMPLE_CHAR_FLOOR = 4 // need at least this many script chars to call it confident

export function detectSourceLanguage(text: string): DetectedSourceLanguage {
  if (!text) return null

  let hiraganaCount = 0
  let katakanaCount = 0
  let hangulCount = 0
  let hanCount = 0
  let latinCount = 0

  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp === undefined) continue
    if (cp >= 0x3040 && cp <= 0x309f) hiraganaCount++
    else if (cp >= 0x30a0 && cp <= 0x30ff) katakanaCount++
    else if (
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0x1100 && cp <= 0x11ff) ||
      (cp >= 0x3130 && cp <= 0x318f)
    )
      hangulCount++
    else if (cp >= 0x4e00 && cp <= 0x9fff) hanCount++
    else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a))
      latinCount++
  }

  const kanaCount = hiraganaCount + katakanaCount
  const totalScript = kanaCount + hangulCount + hanCount + latinCount

  if (totalScript < SAMPLE_CHAR_FLOOR) return null

  // Kana presence is the strongest Japanese signal — even one
  // syllabary char inside a sea of kanji means it's Japanese, not
  // Chinese (Chinese has no native kana).
  if (kanaCount > 0) return 'ja'

  // Pure Hangul or Hangul-dominant → Korean. Some Korean comics mix
  // in a sprinkle of hanja so don't require it to be 100%.
  if (hangulCount > 0 && hangulCount >= hanCount) return 'ko'

  // Han-only (no kana, no Hangul) → Chinese. This catches Hong Kong /
  // Taiwan / mainland releases that aren't translated from JP/KR.
  if (hanCount > 0) return 'zh'

  // Fall through: Latin-only text. Could be original English manga
  // or already-OCR'd Western comics.
  if (latinCount > 0) return 'en'

  return null
}

/**
 * Aggregate detection across many text blocks. Concatenates non-empty
 * `text` fields then calls `detectSourceLanguage`. Used to inspect a
 * whole chapter / series rather than a single bubble — more characters
 * sampled means more reliable verdict.
 */
export function detectSourceLanguageFromBlocks<
  T extends { text?: string | null },
>(blocks: T[]): DetectedSourceLanguage {
  const joined = blocks
    .map((b) => b.text ?? '')
    .filter(Boolean)
    .join('\n')
  return detectSourceLanguage(joined)
}
