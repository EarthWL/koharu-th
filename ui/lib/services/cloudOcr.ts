/**
 * Cloud Vision OCR — send a manga page + its detected text-block
 * coordinates to a vision-capable cloud LLM, get back the recognised
 * text per block.
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
 * - Single request per page — no per-block streaming.
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

const OCR_PROMPT_PREFIX = `You are an OCR engine for a manga / comic page.

I have ANNOTATED the page with NUMBERED red rectangles. Each rectangle
is one text region; the number in the corner is its index. For EACH
numbered region, extract the text inside it EXACTLY as written
(preserve line breaks).

CRITICAL: match by NUMBER, not by reading order. The numbers do NOT
follow manga reading order — they follow the order they were detected.
A region labelled "5" must map to index 5 in your output even if you
would naturally read it 1st or 12th.

If a numbered region is unreadable, empty, or you genuinely cannot
locate it, return "" for that index. Do NOT skip indices; the output
array length MUST equal the number of regions.

Do NOT translate, do NOT explain, do NOT add commentary. Output
STRICTLY a JSON object of the shape:

{"blocks": ["<text in region 0>", "<text in region 1>", ...]}

For reference, here are the coordinates of each numbered region
(x, y, width, height) in pixels:`

function fmtBlocks(blocks: TextBlock[]): string {
  return blocks
    .map(
      (b, i) =>
        `  ${i}: [${Math.round(b.x)}, ${Math.round(b.y)}, ${Math.round(b.width)}, ${Math.round(b.height)}]`,
    )
    .join('\n')
}

/**
 * Burn numbered red rectangles onto the page image so the vision LLM
 * can unambiguously match its OCR output to our text-block indices.
 *
 * Without this, the model OCRs in its own natural reading order
 * (typically top-right for Japanese manga) and the texts[] returned
 * end up offset / swapped from our input order — particularly bad
 * after the user manually deletes some boxes, where the index gap is
 * invisible in the un-annotated image. With numbered overlays the
 * mapping is visual and unambiguous.
 *
 * Annotations are scaled to match the downsized image so labels stay
 * a readable size at the 1024px-max attachment resolution.
 */
async function annotatePageWithBoxes(
  image: Uint8Array,
  blocks: TextBlock[],
): Promise<{ dataUrl: string; mimeType: string }> {
  const MAX_DIMENSION = 1024
  const JPEG_QUALITY = 0.9 // a touch higher than the chat attach default — annotations should stay crisp
  const blob = new Blob([toArrayBuffer(image)])
  const bitmap = await createImageBitmap(blob)
  const { width: srcW, height: srcH } = bitmap
  const scale = Math.min(1, MAX_DIMENSION / Math.max(srcW, srcH))
  const dstW = Math.max(1, Math.round(srcW * scale))
  const dstH = Math.max(1, Math.round(srcH * scale))

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
  if (!ctx) throw new Error('annotatePageWithBoxes: no 2D context')
  ctx.drawImage(bitmap, 0, 0, dstW, dstH)
  bitmap.close?.()

  // Scale-aware visuals so labels stay readable at any page size.
  const strokePx = Math.max(2, Math.round(3 * scale * 1.6))
  const labelFontPx = Math.max(14, Math.round(28 * scale))
  ctx.lineWidth = strokePx
  ctx.strokeStyle = '#ff2d55' // strong red, distinguishable from page ink
  ctx.font = `bold ${labelFontPx}px sans-serif`
  ctx.textBaseline = 'top'

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    const x = b.x * scale
    const y = b.y * scale
    const w = b.width * scale
    const h = b.height * scale
    ctx.strokeRect(x, y, w, h)

    const label = String(i)
    const padding = Math.max(2, Math.round(4 * scale))
    const metrics = ctx.measureText(label)
    const tagW = metrics.width + padding * 2
    const tagH = labelFontPx + padding * 2
    // Pin tag to top-left of the box. Clamp so it stays on-canvas
    // (top edge boxes would otherwise render the tag off-screen).
    const tagX = Math.max(0, Math.min(dstW - tagW, x))
    const tagY = Math.max(0, Math.min(dstH - tagH, y))
    ctx.fillStyle = '#ff2d55'
    ctx.fillRect(tagX, tagY, tagW, tagH)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(label, tagX + padding, tagY + padding)
  }

  let outBlob: Blob
  if ('convertToBlob' in canvas) {
    outBlob = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: JPEG_QUALITY,
    })
  } else {
    outBlob = await new Promise<Blob>((resolve, reject) => {
      ;(canvas as HTMLCanvasElement).toBlob(
        (b) =>
          b
            ? resolve(b)
            : reject(new Error('annotatePageWithBoxes: toBlob returned null')),
        'image/jpeg',
        JPEG_QUALITY,
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

  // Burn numbered red boxes onto the page so the LLM can match by
  // VISIBLE LABEL rather than coordinate reasoning. The previous
  // "send raw page + bbox list" approach drifted whenever the model's
  // natural reading order didn't match our detection order — especially
  // visible after the user manually deletes a few boxes.
  const { dataUrl, mimeType } = await annotatePageWithBoxes(image, textBlocks)
  const prompt = `${OCR_PROMPT_PREFIX}\n${fmtBlocks(textBlocks)}`

  const start = Date.now()
  try {
    const { text, usage } = await dispatchVisionRequest({
      profile,
      apiKey,
      prompt,
      imageDataUrl: dataUrl,
      mimeType,
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
  imageDataUrl: string
  mimeType: string
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
  const body = {
    model: args.profile.modelName,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: args.prompt },
          {
            type: 'image_url',
            image_url: { url: args.imageDataUrl, detail: 'high' },
          },
        ],
      },
    ],
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
  const base64 = args.imageDataUrl.replace(/^data:[^;]+;base64,/, '')
  const body = {
    model: args.profile.modelName,
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: args.mimeType, data: base64 },
          },
          { type: 'text', text: args.prompt },
        ],
      },
    ],
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
  const base64 = args.imageDataUrl.replace(/^data:[^;]+;base64,/, '')
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(args.profile.modelName)}:generateContent?key=${encodeURIComponent(args.apiKey)}`
  const body = {
    contents: [
      {
        parts: [
          { inlineData: { mimeType: args.mimeType, data: base64 } },
          { text: args.prompt },
        ],
      },
    ],
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
  const parts: any[] = json.candidates?.[0]?.content?.parts ?? []
  const text = parts
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
