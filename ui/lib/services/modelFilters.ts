/**
 * Shared model-catalog filtering for cloud LLM providers.
 *
 * Every provider's `/models` list includes endpoints that have no role
 * in koharu's manga pipeline (translation chat + vision OCR + agentic
 * chat + — for Gemini only — inline image generation). This module
 * centralises the "is this model relevant?" decision so all providers
 * behave consistently.
 *
 * ## Why image handling is provider-specific
 *
 * - **Gemini**: image generation (Nano Banana / Imagen) runs through
 *   the SAME `:generateContent` endpoint as chat, so an image model
 *   selected as a chat profile actually works (multimodal output).
 *   → `allowImage: true`.
 * - **OpenAI / OpenRouter / Anthropic**: image generation lives behind
 *   a SEPARATE endpoint (`/images/generations`, etc.), not
 *   `/chat/completions`. Selecting an image model as a chat/translation
 *   profile would just fail at call time, so we hide them.
 *   → `allowImage: false`.
 *
 * Vision *input* (reading manga pages) is a property of multimodal chat
 * models (gpt-4o, claude-3.5, gemini-flash) and is never filtered out.
 */

/** Families that are never useful as a manga chat/translation profile,
 *  regardless of provider. */
const ALWAYS_DROP = [
  'tts',
  'whisper',
  'audio',
  'embedding',
  'moderation',
  'lyria', // music generation (Gemini)
  'veo', // video generation (Gemini)
  'sora', // video generation (OpenAI)
  'robotics',
  'text-similarity',
]

/** Image-generation markers — dropped unless the provider routes image
 *  output through its chat endpoint (Gemini). */
const IMAGE_MARKERS = ['image', 'dall-e', 'imagen', 'nano-banana']

/** Legacy OpenAI completion models that aren't chat-capable. */
const LEGACY_OPENAI = ['davinci', 'babbage', 'curie', 'ada']

export interface ModelFilterOptions {
  /** Keep image-generation models (true only for Gemini). */
  allowImage?: boolean
  /** Drop legacy non-chat completion models (OpenAI-family). */
  dropLegacyCompletions?: boolean
}

/**
 * Decide whether a model id should appear in the manga model picker.
 * Returns true to KEEP, false to DROP.
 */
export function isMangaRelevantModel(
  id: string,
  options: ModelFilterOptions = {},
): boolean {
  const lower = id.toLowerCase()

  if (ALWAYS_DROP.some((kw) => lower.includes(kw))) return false

  if (!options.allowImage && IMAGE_MARKERS.some((kw) => lower.includes(kw))) {
    return false
  }

  if (options.dropLegacyCompletions) {
    if (LEGACY_OPENAI.some((kw) => lower.includes(kw))) return false
    if (lower.startsWith('ft:')) return false // fine-tuning artefacts
    if (lower.includes('realtime')) return false // realtime audio API
  }

  return true
}
