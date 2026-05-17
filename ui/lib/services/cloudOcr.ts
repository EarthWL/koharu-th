/**
 * Cloud Vision OCR — send a manga page's detected text-bubble crops
 * to a vision-capable cloud LLM, get back the recognised text per
 * bubble.
 *
 * Strategy: crop each detected bubble (with a small context margin)
 * client-side and send the crops as a multi-image request. The
 * previous "send full page + bbox list" / "send annotated page"
 * approaches both relied on the model to map text → index, which
 * small/cheap vision models (e.g. gemini-2.5-flash-lite) get wrong
 * once the page has many bubbles or the user has manually deleted
 * some boxes. With crops the mapping is unambiguous: image[i] →
 * texts[i], no reasoning required.
 *
 * Why frontend-only: cloudLlm.ts already speaks all four providers'
 * multi-modal request formats. Porting that to Rust would duplicate
 * ~500 LoC and create drift risk. The trade-off is documented in
 * roadmap_next_features Tier B #3 ("Backport Cloud-Vision OCR to
 * Rust dispatch").
 *
 * Limitations:
 * - Doesn't run inside the background `translation_queue` worker
 *   (worker has no path to the TS dispatch layer; it always uses the
 *   default local engine).
 * - Single request per page — all crops batched into one call so
 *   token accounting stays simple. Pages with >40-ish bubbles may
 *   bump up against provider-side image-count limits; that case is
 *   rare enough to leave for now.
 *
 * Token usage is logged to `llm_call_log` with `use_case='ocr'` so
 * the Cost Dashboard shows OCR spend alongside Translation + Chat.
 */

import { api, type ProviderProfileDto } from '@/lib/api'
import type { TextBlock } from '@/types'
import { useProjectStore } from '@/lib/stores/projectStore'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import { toArrayBuffer } from '@/lib/util'
import type { TokenUsage } from '@/lib/services/cloudLlm'
import { supportsVision } from '@/lib/services/visionSupport'

/** Returned per-block-index, in the same order as the input
 *  `textBlocks` array. `null` = model didn't recognise anything. */
export type CloudOcrResult = {
  texts: (string | null)[]
  usage: TokenUsage | null
}

/** Each bubble is cropped with this much padding (fraction of the
 *  bubble's own width/height) so the model can see a bit of the
 *  surrounding bubble shape — helps with vertical-text orientation
 *  cues and avoids clipping characters whose bbox was tight. */
const CROP_MARGIN = 0.08
/** Long edge of each crop's JPEG. Keeps token cost bounded while
 *  staying large enough to read fine kana on stylised SFX. */
const CROP_MAX_DIMENSION = 384
const CROP_JPEG_QUALITY = 0.9

const OCR_PROMPT = `You are an OCR engine for manga / comic text.

I am giving you N image crops. Each crop contains ONE text region
(a speech bubble, SFX, title, caption, etc.). Process them in the
order received.

For EACH crop, extract the text inside it EXACTLY as written —
preserve line breaks, preserve the original script (do NOT
romanise, do NOT translate, do NOT explain).

Output STRICTLY a JSON object of the shape:

{"blocks": ["<text in crop 0>", "<text in crop 1>", ...]}

The output array length MUST equal the number of crops. Use an empty
string "" only for a crop that is genuinely unreadable or empty.`

type CropImage = { dataUrl: string; mimeType: string }

/**
 * Crop one bubble out of the page bitmap into a downsized JPEG data
 * URL. Padding is added so the model sees a little context (bubble
 * outline / neighbouring whitespace), which improves OCR for
 * stylised vertical SFX where the tight bbox can clip strokes.
 */
async function cropBubble(
  bitmap: ImageBitmap,
  block: TextBlock,
): Promise<CropImage> {
  const padX = block.width * CROP_MARGIN
  const padY = block.height * CROP_MARGIN
  const sx = Math.max(0, Math.floor(block.x - padX))
  const sy = Math.max(0, Math.floor(block.y - padY))
  const sw = Math.min(
    bitmap.width - sx,
    Math.ceil(block.width + padX * 2),
  )
  const sh = Math.min(
    bitmap.height - sy,
    Math.ceil(block.height + padY * 2),
  )
  // Defensive: if the bbox is degenerate (zero/negative), produce a
  // 1×1 transparent stub so the request still has the right count.
  // The caller surfaces "" for that index via parseBlocks.
  const cropW = Math.max(1, sw)
  const cropH = Math.max(1, sh)

  const scale = Math.min(1, CROP_MAX_DIMENSION / Math.max(cropW, cropH))
  const dstW = Math.max(1, Math.round(cropW * scale))
  const dstH = Math.max(1, Math.round(cropH * scale))

  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(dstW, dstH)
      : (() => {
          const c = document.createElement('canvas')
          c.width = dstW
          c.height = dstH
          return c
        })()
  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null
  if (!ctx) throw new Error('cropBubble: no 2D context')
  ctx.drawImage(bitmap, sx, sy, cropW, cropH, 0, 0, dstW, dstH)

  let outBlob: Blob
  if ('convertToBlob' in canvas) {
    outBlob = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: CROP_JPEG_QUALITY,
    })
  } else {
    outBlob = await new Promise<Blob>((resolve, reject) => {
      ;(canvas as HTMLCanvasElement).toBlob(
        (b) =>
          b ? resolve(b) : reject(new Error('cropBubble: toBlob returned null')),
        'image/jpeg',
        CROP_JPEG_QUALITY,
      )
    })
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () =>
      reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(outBlob)
  })

  return { dataUrl, mimeType: 'image/jpeg' }
}

/** Parse the model's JSON output back into a per-block array. Robust
 *  to common drift (extra prose around the JSON, missing keys,
 *  wrong-length arrays). */
function parseBlocks(raw: string, expected: number): (string | null)[] {
  // Strip code fences / markdown that some models wrap JSON in.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  let parsed: any = null
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    // Fallback: find the first { ... } in the string.
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (match) {
      try {
        parsed = JSON.parse(match[0])
      } catch {}
    }
  }
  const arr: unknown = parsed?.blocks
  if (!Array.isArray(arr)) {
    return new Array(expected).fill(null)
  }
  const out: (string | null)[] = []
  for (let i = 0; i < expected; i++) {
    const v = arr[i]
    out.push(typeof v === 'string' ? v : null)
  }
  return out
}

function logCallSafe(args: {
  success: boolean
  usage: TokenUsage | null
  durationMs: number
  errorMessage?: string
  /** ID of the saved profile that did the OCR. Pass `null` for the
   *  synthetic "(Use active translation profile)" path — we'll fall
   *  back to whatever profile the user has Applied. */
  profileId: number | null
}) {
  if (!useProjectStore.getState().info) return
  // For the synthetic active-translation fallback, the resolved
  // profile has id=-1 which isn't a real row; the real one to credit
  // is preferencesStore.activeProfileId.
  const profileId =
    args.profileId != null && args.profileId > 0
      ? args.profileId
      : usePreferencesStore.getState().activeProfileId
  const chapterId = useProjectStore.getState().activeChapterId
  void api
    .llmCallLog({
      useCase: 'ocr',
      profileId,
      chapterId,
      success: args.success,
      promptTokens: args.usage?.promptTokens ?? null,
      completionTokens: args.usage?.completionTokens ?? null,
      durationMs: args.durationMs,
      errorMessage: args.errorMessage ?? null,
    })
    .catch((err) => console.warn('[cloudOcr] llmCallLog failed', err))
}

/** Run cloud OCR for one page. Returns texts in the same order as
 *  `textBlocks`. Throws on a hard failure (no API key, bad provider,
 *  HTTP non-2xx) — caller is expected to surface that to the user. */
export async function ocrPageViaCloud(
  profile: ProviderProfileDto,
  apiKey: string,
  image: Uint8Array,
  textBlocks: TextBlock[],
): Promise<CloudOcrResult> {
  if (textBlocks.length === 0) {
    return { texts: [], usage: null }
  }

  // Decode the page once, then crop every bubble out of the same
  // bitmap. Cheaper than re-decoding for each block.
  const blob = new Blob([toArrayBuffer(image)])
  const bitmap = await createImageBitmap(blob)
  let crops: CropImage[]
  try {
    crops = await Promise.all(textBlocks.map((b) => cropBubble(bitmap, b)))
  } finally {
    bitmap.close?.()
  }

  const start = Date.now()
  try {
    const { text, usage } = await dispatchVisionRequest({
      profile,
      apiKey,
      prompt: OCR_PROMPT,
      crops,
    })
    logCallSafe({
      success: true,
      usage,
      durationMs: Date.now() - start,
      profileId: profile.id,
    })
    return { texts: parseBlocks(text, textBlocks.length), usage }
  } catch (err: any) {
    logCallSafe({
      success: false,
      usage: null,
      durationMs: Date.now() - start,
      errorMessage: err?.message ?? String(err),
      profileId: profile.id,
    })
    throw err
  }
}

// ────────────────────────────────────────────────────────────────
// Per-provider one-shot vision request (non-streaming).
// Streaming would buy us nothing for OCR — we only render after
// the whole JSON arrives anyway.
// ────────────────────────────────────────────────────────────────

type VisionArgs = {
  profile: ProviderProfileDto
  apiKey: string
  prompt: string
  /** All bubble crops for this page, in text-block order. Each
   *  provider's call function unpacks these into its own image-part
   *  shape. */
  crops: CropImage[]
}

type VisionResult = { text: string; usage: TokenUsage | null }

/** Effective provider for dispatch. Mirrors ProfilesTabPanel.kindOf —
 *  profiles created before commit d6a97bb6 stored OpenRouter as
 *  provider='openai' because the Rust backend used to collapse the
 *  variant. Detect by the `vendor/model` slash and route correctly so
 *  the legacy profile hits openrouter.ai (with its proper API key
 *  shape) instead of api.openai.com (which would 401). */
function effectiveProvider(profile: ProviderProfileDto): string {
  if (
    profile.provider === 'openai' &&
    profile.modelName.includes('/')
  ) {
    return 'openrouter'
  }
  return profile.provider
}

async function dispatchVisionRequest(args: VisionArgs): Promise<VisionResult> {
  // Use a corrected provider for the dispatch decision so legacy
  // profiles work; keep the original on args.profile so user-visible
  // surfaces (the resolved-profile object the caller sees) match
  // what's in the DB.
  const provider = effectiveProvider(args.profile)
  const corrected: VisionArgs =
    provider === args.profile.provider
      ? args
      : { ...args, profile: { ...args.profile, provider } }
  switch (provider) {
    case 'openai':
    case 'openrouter':
      return callOpenAiCompatVision(corrected)
    case 'anthropic':
      return callAnthropicVision(corrected)
    case 'gemini':
      return callGeminiVision(corrected)
    default:
      throw new Error(
        `Cloud Vision OCR isn't implemented for provider '${args.profile.provider}'.`,
      )
  }
}

async function callOpenAiCompatVision(args: VisionArgs): Promise<VisionResult> {
  const base = (args.profile.apiUrl || 'https://api.openai.com/v1').replace(
    /\/+$/,
    '',
  )
  const url =
    args.profile.provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1/chat/completions'
      : `${base}/chat/completions`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${args.apiKey}`,
  }
  if (args.profile.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://koharu.local'
    headers['X-Title'] = 'Koharu OCR'
  }
  // text first, then one image_url per crop in order. "low" detail
  // is plenty for ~384px bubble crops and roughly halves token cost
  // vs "high".
  const content: any[] = [{ type: 'text', text: args.prompt }]
  for (const c of args.crops) {
    content.push({
      type: 'image_url',
      image_url: { url: c.dataUrl, detail: 'low' },
    })
  }
  const body = {
    model: args.profile.modelName,
    messages: [{ role: 'user', content }],
    response_format: { type: 'json_object' },
    temperature: 0,
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(
      `${args.profile.provider} OCR failed (${res.status}): ${errBody.slice(0, 400)}`,
    )
  }
  const json = await res.json()
  const text = json.choices?.[0]?.message?.content ?? ''
  const usage: TokenUsage | null = json.usage
    ? {
        promptTokens: json.usage.prompt_tokens ?? null,
        completionTokens: json.usage.completion_tokens ?? null,
      }
    : null
  return { text, usage }
}

async function callAnthropicVision(args: VisionArgs): Promise<VisionResult> {
  const content: any[] = []
  for (const c of args.crops) {
    const base64 = c.dataUrl.replace(/^data:[^;]+;base64,/, '')
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: c.mimeType, data: base64 },
    })
  }
  content.push({ type: 'text', text: args.prompt })
  const body = {
    model: args.profile.modelName,
    max_tokens: 4096,
    messages: [{ role: 'user', content }],
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': args.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(
      `Anthropic OCR failed (${res.status}): ${errBody.slice(0, 400)}`,
    )
  }
  const json = await res.json()
  const blocks: any[] = json.content ?? []
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
  const usage: TokenUsage | null = json.usage
    ? {
        promptTokens: json.usage.input_tokens ?? null,
        completionTokens: json.usage.output_tokens ?? null,
      }
    : null
  return { text, usage }
}

async function callGeminiVision(args: VisionArgs): Promise<VisionResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(args.profile.modelName)}:generateContent?key=${encodeURIComponent(args.apiKey)}`
  const parts: any[] = []
  for (const c of args.crops) {
    const base64 = c.dataUrl.replace(/^data:[^;]+;base64,/, '')
    parts.push({ inlineData: { mimeType: c.mimeType, data: base64 } })
  }
  parts.push({ text: args.prompt })
  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0,
    },
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(
      `Gemini OCR failed (${res.status}): ${errBody.slice(0, 400)}`,
    )
  }
  const json = await res.json()
  const respParts: any[] = json.candidates?.[0]?.content?.parts ?? []
  const text = respParts
    .filter((p) => typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
  const um = json.usageMetadata
  const usage: TokenUsage | null = um
    ? {
        promptTokens: um.promptTokenCount ?? null,
        completionTokens: um.candidatesTokenCount ?? null,
      }
    : null
  return { text, usage }
}

/** Resolve the active OCR cloud profile from `preferencesStore.ocrCloudProfileId`,
 *  falling back to the active translation profile. Also fetches the
 *  API key from the OS keyring. Returns null if no usable profile +
 *  key combo exists (caller should surface "no cloud OCR profile"
 *  error to the user). */
export async function resolveOcrCloudProfile(
  ocrCloudProfileId: number | null,
  profiles: ProviderProfileDto[],
  activeProvider: string,
  activeModelName: string,
  activeApiKey: string,
): Promise<{ profile: ProviderProfileDto; apiKey: string } | null> {
  // 1. Explicit OCR profile choice
  if (ocrCloudProfileId != null) {
    const p = profiles.find((x) => x.id === ocrCloudProfileId)
    if (p) {
      try {
        const { apiKey } = await api.providerProfileSecretGet(p.id)
        if (apiKey) return { profile: p, apiKey }
      } catch {}
    }
  }
  // 2. Fallback: synthesize a profile-shaped object from the active
  //    translation profile + its in-memory key. Apply the same legacy
  //    OpenRouter-as-openai heuristic so a user whose active profile
  //    is an old OpenRouter row still gets recognised as vision.
  const effectiveActive =
    activeProvider === 'openai' && activeModelName.includes('/')
      ? 'openrouter'
      : activeProvider
  if (
    activeProvider &&
    activeProvider !== 'none' &&
    activeModelName &&
    activeApiKey &&
    supportsVision(effectiveActive, activeModelName).supported
  ) {
    const synthetic: ProviderProfileDto = {
      id: -1,
      name: 'Active translation profile',
      // Use the heuristic-corrected provider so the dispatcher routes
      // correctly even when the source pref is the legacy 'openai'-
      // with-slash form (dispatcher itself also applies the same
      // heuristic — belt-and-suspenders).
      provider: effectiveActive,
      apiUrl: null,
      modelName: activeModelName,
      apiKeyRef: null,
      isDefault: false,
      costInputPer1m: null,
      costOutputPer1m: null,
      createdAt: '',
      updatedAt: '',
    }
    return { profile: synthetic, apiKey: activeApiKey }
  }
  return null
}
