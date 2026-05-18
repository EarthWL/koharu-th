/**
 * Thai text post-processing — applied after LLM translation when
 * `thaiPostProcess` preference is enabled.
 *
 * Rules:
 * 1. Straight quotes → curly quotes  ("..." → "...")
 * 2. Strip excess spaces between Thai script characters
 *    (LLMs often output "ไป แล้ว" instead of "ไปแล้ว")
 */

// ช่วง Unicode ของอักษรไทย U+0E00–U+0E7F
const THAI = '\u0e00-\u0e7f'
// Regex: space ที่อยู่ระหว่างตัวอักษรไทย 2 ตัว
const THAI_SPACE_RE = new RegExp(`([${THAI}]) ([${THAI}])`, 'g')
// วนซ้ำเพื่อจัดการกรณี "ก า รไ ป"  → "การไป" (หลายช่อง)
const applyRepeatedly = (re: RegExp, s: string, rep: string) => {
  let prev = ''
  while (prev !== s) {
    prev = s
    s = s.replace(re, rep)
  }
  return s
}

export function applyThaiPostProcess(text: string): string {
  // 1. Straight double quotes → curly quotes
  //    วางคู่ซ้าย-ขวาโดยดูจาก context (ซ้ายของคำ = เปิด, ขวาของคำ = ปิด)
  text = text
    .replace(/(^|[\s([{])"([^\s])/g, '$1\u201c$2')   // "word → "word
    .replace(/([^\s])"([\s,!.?;:)\]}]|$)/g, '$1\u201d$2') // word" → word"
    // กรณีที่เหลือ: แปลงตรงๆ
    .replace(/"/g, '\u201c')

  // 2. ลบ space ระหว่างตัวอักษรไทย
  text = applyRepeatedly(THAI_SPACE_RE, text, '$1$2')

  return text
}

/**
 * ตรวจสอบว่าข้อความส่วนใหญ่เป็นภาษาไทยหรือไม่
 * ใช้สำหรับ auto-detect source language
 */
export function detectDominantLanguage(texts: string[]): string | null {
  const combined = texts.join('')
  if (!combined) return null

  const counts: Record<string, number> = {
    ja: 0, // Hiragana + Katakana + CJK (common)
    zh: 0, // CJK ที่ไม่มี kana
    ko: 0, // Hangul
    th: 0, // Thai
    ar: 0, // Arabic
  }

  for (const ch of combined) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp >= 0x3040 && cp <= 0x309f) counts['ja']! += 2 // Hiragana (jp strong signal)
    else if (cp >= 0x30a0 && cp <= 0x30ff) counts['ja']! += 2 // Katakana
    else if (cp >= 0x4e00 && cp <= 0x9fff) counts['ja']! += 1  // CJK shared
    else if (cp >= 0xac00 && cp <= 0xd7ff) counts['ko']! += 3  // Hangul syllables
    else if (cp >= 0x0e00 && cp <= 0x0e7f) counts['th']! += 3  // Thai
    else if (cp >= 0x0600 && cp <= 0x06ff) counts['ar']! += 3  // Arabic
  }

  // ถ้า CJK แต่ไม่มี kana → likely Chinese
  if (counts['ja']! > 0 && combined.search(/[\u3040-\u30ff]/) === -1) {
    counts['zh'] = counts['ja']!
    counts['ja'] = 0
  }

  const [lang, score] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]!
  if (score === 0) return null

  // map to BCP-47
  const map: Record<string, string> = {
    ja: 'Japanese',
    zh: 'Chinese',
    ko: 'Korean',
    th: 'Thai',
    ar: 'Arabic',
  }
  return map[lang] ?? null
}
