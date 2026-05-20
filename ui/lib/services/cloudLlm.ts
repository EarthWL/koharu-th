import { usePreferencesStore } from '../stores/preferencesStore'
import { useProjectStore } from '../stores/projectStore'
import { api, type TmEntryDto } from '../api'
import { toast } from 'sonner'

/** Token counts as reported by the provider. `null` = provider didn't return them. */
export type TokenUsage = {
  promptTokens: number | null
  completionTokens: number | null
}

/** Provider response decoded into text + usage. */
export type CloudResult = {
  text: string
  usage: TokenUsage | null
}

/** Callback fired for every incremental text chunk during streaming. */
export type StreamHandler = (delta: string) => void

/**
 * Read a Server-Sent Events stream from `body` and yield each
 * non-empty `data:` payload string (without the prefix). Drops the
 * `[DONE]` sentinel some providers emit. Used by the streaming
 * implementations of OpenAI / OpenRouter / Gemini below.
 */
async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trimEnd()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      yield payload
    }
  }
  // Flush whatever's left in the buffer in case the server didn't
  // terminate with a newline.
  const tail = buffer.trim()
  if (tail.startsWith('data:')) {
    const payload = tail.slice(5).trim()
    if (payload && payload !== '[DONE]') yield payload
  }
}

/**
 * Log a single cloud-LLM call to the project DB. No-op when no project
 * is open. Best-effort: never throws — failures are logged to console.
 */
function logCallSafe(args: {
  useCase: string
  success: boolean
  usage: TokenUsage | null
  durationMs: number
  errorMessage?: string
}) {
  if (!useProjectStore.getState().info) return
  const profileId = usePreferencesStore.getState().activeProfileId
  const chapterId = useProjectStore.getState().activeChapterId
  void api
    .llmCallLog({
      useCase: args.useCase,
      profileId,
      chapterId,
      success: args.success,
      promptTokens: args.usage?.promptTokens ?? null,
      completionTokens: args.usage?.completionTokens ?? null,
      durationMs: args.durationMs,
      errorMessage: args.errorMessage ?? null,
    })
    .catch((err) => console.warn('[cloudLlm] llmCallLog failed', err))
}

/**
 * If a project is open, ask the backend to render the prompt with full
 * 3-layer context (series meta + main characters + smart-filtered
 * glossary). Returns the rendered prompt + glossary hit IDs to bump
 * usage on after a successful translation. If no project is open,
 * returns null and callers fall back to a built-in stub prompt.
 */
type ProjectPrompt = {
  prompt: string
  glossaryHitIds: number[]
  templateName: string
  /** True when activeChapterId was set so rolling-context summaries
   *  were eligible for injection (the backend may still produce empty
   *  text if no prior summaries exist). */
  rollingContextRequested: boolean
}

async function tryProjectPrompt(
  text: string,
  language: string,
): Promise<ProjectPrompt | null> {
  const project = useProjectStore.getState().info
  if (!project) return null
  try {
    const activeChapterId = useProjectStore.getState().activeChapterId
    const rendered = await api.promptRender({
      useCase: 'translate',
      sourceText: text,
      // Pass chapter id so the backend auto-injects summaries of the
      // last 2 chapters as rolling context. Null when user hasn't picked
      // an active chapter -- rolling context just stays empty.
      chapterId: activeChapterId ?? undefined,
      rollingChapterCount: 2,
    })
    void language // project's target_language already feeds the template
    return {
      prompt: rendered.prompt,
      glossaryHitIds: rendered.glossaryHitIds,
      templateName: rendered.templateName,
      rollingContextRequested: activeChapterId != null,
    }
  } catch (err) {
    // If the project DB doesn't have a translate template (e.g. very old
    // schema) we just fall back to the stub prompt instead of failing.
    console.warn('[cloudLlm] promptRender failed; falling back', err)
    return null
  }
}

/** Threshold below which a fuzzy hit is ignored. */
const FUZZY_TM_MIN_SIMILARITY = 0.92

type TmHit = { entry: TmEntryDto; similarity: number }

async function tryTmHit(
  sourceText: string,
  targetLang: string,
): Promise<TmHit | null> {
  if (!useProjectStore.getState().info) return null
  try {
    // Exact-match short-circuit first — fastest path.
    const exact = await api.tmLookup(sourceText, targetLang)
    if (exact) return { entry: exact, similarity: 1.0 }
    // Then fall back to fuzzy. Threshold is conservative (0.92) so we
    // don't poison the cache with "close but actually different" hits.
    const fuzzy = await api.tmLookupFuzzy(
      sourceText,
      targetLang,
      FUZZY_TM_MIN_SIMILARITY,
    )
    if (fuzzy) {
      return fuzzy
    }
    return null
  } catch (err) {
    console.warn('[cloudLlm] tmLookup failed (non-fatal)', err)
    return null
  }
}

/**
 * Retry a fetch-shaped call on transient failures (HTTP 429 / 5xx,
 * thrown errors). Exponential backoff capped at `maxBackoffMs`.
 * Re-raises after `maxAttempts` attempts.
 *
 * `retryable(err)` returns true if the error should be retried.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts?: number
    initialBackoffMs?: number
    maxBackoffMs?: number
    retryable?: (err: unknown) => boolean
    onRetry?: (attempt: number, err: unknown, waitMs: number) => void
  } = {},
): Promise<T> {
  const max = opts.maxAttempts ?? 4
  const initial = opts.initialBackoffMs ?? 800
  const cap = opts.maxBackoffMs ?? 15_000
  const isRetryable = opts.retryable ?? defaultRetryable
  let attempt = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn()
    } catch (err) {
      attempt++
      if (attempt >= max || !isRetryable(err)) throw err
      // Decorrelated jitter: random between initial and 3x the previous
      // delay, capped. Keeps thundering-herd low if many calls fail.
      const base = Math.min(cap, initial * Math.pow(2, attempt - 1))
      const wait = Math.round(base * (0.5 + Math.random()))
      opts.onRetry?.(attempt, err, wait)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}

function defaultRetryable(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  // HTTP 429 / 5xx surfacing through the fetch* helpers' thrown messages.
  if (msg.includes('429')) return true
  if (/\b5\d{2}\b/.test(msg)) return true
  // Common transient transports: timeouts, resets, etc.
  if (
    msg.includes('etimedout') ||
    msg.includes('network') ||
    msg.includes('fetch failed')
  ) {
    return true
  }
  return false
}

async function rememberTm(args: {
  sourceText: string
  targetText: string
  targetLang: string
  provider: string
  model: string
}) {
  if (!useProjectStore.getState().info) return
  try {
    await api.tmInsert({
      sourceText: args.sourceText,
      targetText: args.targetText,
      sourceLang: 'auto',
      targetLang: args.targetLang,
      provider: args.provider,
      model: args.model,
    })
  } catch (err) {
    console.warn('[cloudLlm] tmInsert failed (non-fatal)', err)
  }
}

/** Extra context about how a translation was produced. Surfaced to the
 *  QA page so it can render "♻️ TM hit" / "📖 3 glossary" / "📍 ch.5"
 *  badges alongside each block. */
export type TranslationMeta = {
  /** True if the text came from translation memory (exact or fuzzy). */
  tmHit: boolean
  /** Similarity for fuzzy TM hits (0..1). 1.0 means exact match. */
  tmSimilarity: number | null
  /** Chapter id where the matched TM entry was originally stored. */
  tmFromChapterId: number | null
  /** Names / ids of glossary entries injected into the prompt. */
  glossaryHitIds: number[]
  /** Template the backend picked (e.g. "manga-standard"). */
  templateName: string | null
  /** True if a rolling-context summary was injected. */
  rollingContextUsed: boolean
  /** Wall-clock duration in ms. */
  durationMs: number
  /** Token usage when known. */
  usage: TokenUsage | null
}

export type TranslationDetailed = {
  text: string
  meta: TranslationMeta
}

/** When set, the translation call uses these credentials instead of
 *  the live preferences store. Useful for "Translate this block with
 *  a different model" without disturbing the user's saved default. */
export type ProviderOverride = {
  provider: string
  apiKey: string
  apiUrl: string
  model: string
}

/**
 * [ฟังก์ชัน public แบบ Detailed]
 * คืนผลการแปลพร้อม metadata ครบชุด (TM hit, glossary, template ที่ใช้, เวลาที่ใช้)
 * เหมาะสำหรับ QA Page หรือ Debug UI ที่ต้องการข้อมูลเชิงลึก
 *
 * @param style - สไตล์การแปล (ดู generateCloudTranslationImpl สำหรับรายละเอียด)
 */
export async function generateCloudTranslationDetailed(
  text: string,
  language: string,
  onChunk?: StreamHandler,
  override?: ProviderOverride,
  style?: 'standard' | 'shonen' | 'polite',
  context?: string,
): Promise<TranslationDetailed> {
  return generateCloudTranslationImpl(
    text,
    language,
    onChunk,
    override,
    style,
    context,
  )
}

/**
 * [ฟังก์ชัน public แบบ Simple]
 * คืนแค่ข้อความที่แปลแล้ว (string ล้วนๆ) ไม่มี metadata พ่วงมาด้วย
 * เรียกใช้จาก llmGenerate() ใน mutations.ts เพื่อแปลแต่ละ bubble
 *
 * @param style - กำหนดน้ำเสียงการแปล:
 *   - 'standard'  → ภาษาทั่วไป สมดุล เหมาะกับการ์ตูนทุกแนว (default)
 *   - 'shonen'    → ดุดัน ร้อนแรง มีพลัง เหมาะกับมังงะแนวต่อสู้
 *   - 'polite'    → สุภาพ อ่อนโยน เหมาะกับมังงะแนวดราม่า ชีวิต โรแมนซ์
 */
export async function generateCloudTranslation(
  text: string,
  language: string,
  onChunk?: StreamHandler,
  style?: 'standard' | 'shonen' | 'polite',
  context?: string,
): Promise<string> {
  return (
    await generateCloudTranslationImpl(
      text,
      language,
      onChunk,
      undefined,
      style,
      context,
    )
  ).text
}

// Map of profile ID to recovery timestamp (Date.now() + cooldownDuration)
const profileRecoveryTimestamps = new Map<number, number>()

function getCooldownDurationForProvider(
  provider: string,
  errorMessage: string,
): number {
  const msg = errorMessage.toLowerCase()

  if (provider === 'gemini') {
    // Check if it's a daily limit or rate limit
    if (
      msg.includes('daily') ||
      msg.includes('quota exceeded') ||
      msg.includes('limit exceeded')
    ) {
      return 4 * 60 * 60 * 1000 // 4 hours check back for Gemini daily limits
    }
    return 1 * 60 * 1000 // 1 minute rolling limit (standard RPM)
  }

  if (provider === 'anthropic') {
    // Anthropic free tier has 5 hours cooldown if token limit is hit
    if (
      msg.includes('usage limit') ||
      msg.includes('exceeded') ||
      msg.includes('free tier') ||
      msg.includes('hours') ||
      msg.includes('exhausted')
    ) {
      return 5 * 60 * 60 * 1000 // 5 hours
    }
    return 1 * 60 * 1000 // 1 minute rolling RPM limit
  }

  if (provider === 'openai' || provider === 'openrouter') {
    // OpenAI billing issues, credit exhausted
    if (
      msg.includes('billing') ||
      msg.includes('quota') ||
      msg.includes('insufficient') ||
      msg.includes('credit')
    ) {
      return 2 * 60 * 60 * 1000 // 2 hours check in case user filled it
    }
    return 1 * 60 * 1000 // 1 minute rolling RPM limit
  }

  return 1 * 60 * 1000 // Default 1 minute
}

/**
 * [ฟังก์ชัน core — ไม่ export โดยตรง]
 * รับ text + language + style แล้วสร้าง prompt → ส่งไปหา Cloud LLM
 * ผ่าน failover หลายโปรไฟล์ → คืน TranslationDetailed
 *
 * ลำดับการทำงาน:
 *  1. ตรวจ Translation Memory (TM) ก่อน — ถ้า hit ตรงๆ ไม่เปลือง token เลย
 *  2. ถ้าไม่มี TM hit → ดึง Project Prompt จาก backend (ถ้ามี project เปิดอยู่)
 *  3. เติม style instruction ต่อท้าย prompt ตามค่า `style` ที่รับมา
 *  4. วน failover ลิสต์โปรไฟล์ → ส่ง request → คืนผลตัวแรกที่สำเร็จ
 *  5. บันทึกผลลงใน TM เพื่อใช้ซ้ำในอนาคต (best-effort)
 */
async function generateCloudTranslationImpl(
  text: string,
  language: string,
  onChunk?: StreamHandler,
  override?: ProviderOverride,
  style?: 'standard' | 'shonen' | 'polite',
  context?: string,
): Promise<TranslationDetailed> {
  const live = usePreferencesStore.getState()

  // [ด่านที่ 1] ตรวจ TM ก่อนเลย — ถ้าเจอ exact/fuzzy match ไม่ต้องยิง API เลย
  // ช่วยประหยัด token ได้มากสำหรับ dialogue ที่ซ้ำบ่อยในมังงะ
  const tmHit = await tryTmHit(text, language)
  if (tmHit) {
    if (onChunk) onChunk(tmHit.entry.targetText)
    return {
      text: tmHit.entry.targetText,
      meta: {
        tmHit: true,
        tmSimilarity: tmHit.similarity,
        tmFromChapterId: tmHit.entry.chapterId,
        glossaryHitIds: [],
        templateName: null,
        rollingContextUsed: false,
        durationMs: 0,
        usage: null,
      },
    }
  }

  // [ด่านที่ 2] ดึง Project Prompt — ถ้ามี project เปิดอยู่ backend จะ inject
  // glossary + ตัวละคร + rolling context เข้าไปในตัว prompt อัตโนมัติ
  // ถ้าไม่มี project → ใช้ fallback prompt stub ทั่วไปแทน
  const projectPrompt = await tryProjectPrompt(text, language)
  const t0 = performance.now()
  let basePrompt =
    projectPrompt?.prompt ??
    `You are a professional manga translator. Translate the following text to ${language}.
The translation should sound natural, conversational, and appropriate for comic book characters, keeping the original tone and context intact.
Only return the translation, no extra text:\n\n${text}`

  if (context && context.trim()) {
    basePrompt = `[Translation Context]\n${context}\n\n[Instructions]\nUse the above context to keep translation consistency if applicable.\n\n[Text to Translate]\n${basePrompt}`
  }

  // [ด่านที่ 3] เติม Style Instruction ท้าย prompt
  // หมายเหตุ: ถ้า projectPrompt มีอยู่ (project mode) style instruction จะ append ต่อท้าย
  // project prompt นั้น — ไม่ override ทั้งหมด เพื่อรักษา glossary/character context ไว้
  if (style === 'shonen') {
    // โชเน็น: ดุดัน ร้อนแรง มีพลังงาน เหมาะกับมังงะต่อสู้อย่าง Dragon Ball, Naruto, One Piece
    basePrompt += `\n\n[STYLE INSTRUCTION: Translate with an energetic, raw, passionate, and aggressive Shonen battle manga tone. Use energetic pronouns (e.g. in Thai, use 'แก'/'ฉัน', 'ข้า'/'เจ้า') and passionate exclamation endings (e.g. 'ว้อย!', 'ย้าก!', 'เซ่!').]`
  } else if (style === 'polite') {
    // สุภาพ: อ่อนโยน ประณีต เหมาะกับมังงะแนวดราม่า ชีวิต โรแมนซ์ หรือตัวละครผู้ใหญ่
    basePrompt += `\n\n[STYLE INSTRUCTION: Translate with a highly polite, soft, respectful, and elegant tone. Use formal/gentle pronouns (e.g. in Thai, use 'คุณ'/'ผม'/'ดิฉัน'/'ฉัน') and polite sentence endings (e.g. 'ครับ'/'ค่ะ'/'นะคะ').]`
  } else if (style === 'standard') {
    // ทั่วไป: สมดุล เป็นธรรมชาติ ไม่เอนไปทางใดทางหนึ่ง ใช้ได้กับมังงะทุกแนว
    basePrompt += `\n\n[STYLE INSTRUCTION: Translate in a standard manga dialogue tone - natural, conversational, expressive, and fitting the general scene without being overly aggressive or overly formal.]`
  }
  // style === undefined → ไม่เติมอะไร ใช้ prompt ตามที่มีอยู่โดยตรง

  const prompt = basePrompt

  // Build failover attempts list if enabled
  type ConfigAttempt = {
    id: number | null
    name: string
    provider: string
    apiKey: string
    apiUrl: string
    modelName: string
  }

  let attempts: ConfigAttempt[] = []

  if (!override && live.llmFailoverEnabled) {
    try {
      const profiles = await api.providerProfilesList()
      const sorted = [...profiles].sort((a, b) => {
        let idxA = live.llmFailoverPriority.indexOf(a.id)
        let idxB = live.llmFailoverPriority.indexOf(b.id)
        if (idxA === -1) idxA = 9999
        if (idxB === -1) idxB = 9999
        return idxA - idxB
      })

      const now = Date.now()
      const isCooldown = (id: number) => {
        const recovery = profileRecoveryTimestamps.get(id)
        return recovery ? now < recovery : false
      }

      // Filter out candidates that are currently in cooldown unless ALL are in cooldown
      let candidates = sorted
      const workingCandidates = sorted.filter((p) => !isCooldown(p.id))
      if (workingCandidates.length > 0) {
        candidates = workingCandidates
      }

      const activeId = live.activeProfileId
      const activeCandidate = candidates.find((c) => c.id === activeId)
      const otherCandidates = candidates.filter((c) => c.id !== activeId)

      const getDetails = async (
        p: (typeof profiles)[0],
      ): Promise<ConfigAttempt> => {
        let key = ''
        if (p.provider !== 'local') {
          try {
            const secret = await api.providerProfileSecretGet(p.id)
            key = secret.apiKey ?? ''
          } catch (e) {
            console.warn(`[failover] Failed to get API key for ${p.name}`, e)
          }
        }
        return {
          id: p.id,
          name: p.name,
          provider: p.provider,
          apiKey: key,
          apiUrl:
            p.apiUrl ??
            (p.provider === 'openai' ? 'https://api.openai.com/v1' : ''),
          modelName: p.modelName,
        }
      }

      if (activeCandidate) {
        attempts.push(await getDetails(activeCandidate))
      }
      for (const p of otherCandidates) {
        attempts.push(await getDetails(p))
      }
    } catch (err) {
      console.error('[failover] Failed to build failover candidates list', err)
    }
  }

  if (attempts.length === 0) {
    const cloudProvider = override?.provider ?? live.cloudProvider
    const cloudApiKey = override?.apiKey ?? live.cloudApiKey
    const cloudApiUrl = override?.apiUrl ?? live.cloudApiUrl
    const cloudModelName = override?.model ?? live.cloudModelName

    attempts.push({
      id: live.activeProfileId,
      name: 'Active Profile',
      provider: cloudProvider,
      apiKey: cloudApiKey,
      apiUrl: cloudApiUrl,
      modelName: cloudModelName,
    })
  }

  let raw: CloudResult | null = null
  let successfulAttempt: ConfigAttempt | null = null
  let lastError: any = null

  for (let i = 0; i < attempts.length; i++) {
    const att = attempts[i]
    if (!att.apiKey && att.provider !== 'local') {
      lastError = new Error(`No API key for profile "${att.name}"`)
      continue
    }

    try {
      raw = await withRetry(
        () => {
          if (att.provider === 'openai') {
            return fetchOpenAI(
              prompt,
              att.apiKey,
              att.apiUrl,
              att.modelName,
              false,
              onChunk,
            )
          } else if (att.provider === 'openrouter') {
            return fetchOpenRouter(
              prompt,
              att.apiKey,
              att.modelName,
              false,
              onChunk,
            )
          } else if (att.provider === 'gemini') {
            return fetchGemini(
              prompt,
              att.apiKey,
              att.modelName,
              false,
              onChunk,
            )
          } else if (att.provider === 'anthropic') {
            return fetchAnthropic(
              prompt,
              att.apiKey,
              att.modelName,
              false,
              onChunk,
            )
          } else {
            throw new Error(`Unsupported cloud provider: ${att.provider}`)
          }
        },
        {
          onRetry: (attemptNum, err, waitMs) =>
            console.warn(
              `[cloudLlm] retry ${attemptNum} for profile "${att.name}" after ${waitMs}ms:`,
              err instanceof Error ? err.message : err,
            ),
        },
      )
      successfulAttempt = att
      if (att.id !== null) {
        profileRecoveryTimestamps.delete(att.id)
      }
      break
    } catch (err: any) {
      console.warn(
        `[cloudLlm] Profile "${att.name}" failed:`,
        err?.message ?? err,
      )
      lastError = err

      if (att.id !== null) {
        const errorMsg = err?.message ?? String(err)
        const cooldown = getCooldownDurationForProvider(att.provider, errorMsg)
        const recoveryTime = Date.now() + cooldown
        profileRecoveryTimestamps.set(att.id, recoveryTime)
      }
    }
  }

  if (!raw || !successfulAttempt) {
    logCallSafe({
      useCase: 'translate',
      success: false,
      usage: null,
      durationMs: Math.round(performance.now() - t0),
      errorMessage: lastError?.message ?? String(lastError),
    })
    throw lastError || new Error('All translation profiles failed')
  }

  if (
    live.llmFailoverEnabled &&
    successfulAttempt.id !== live.activeProfileId &&
    successfulAttempt.id !== null
  ) {
    const origName = attempts[0]?.name ?? 'โปรไฟล์เดิม'
    setTimeout(() => {
      toast.error(
        `⚠️ ระบบสลับผู้ให้บริการสำรองอัตโนมัติทำงาน!\n\nเนื่องจากโปรไฟล์หลัก "${origName}" ขัดข้องหรือโควตาหมด ระบบจึงสลับไปใช้โปรไฟล์สำรอง "${successfulAttempt!.name}" เพื่อแปลข้อความให้ท่านอย่างต่อเนื่องเรียบร้อยครับ`,
      )
    }, 10)

    usePreferencesStore.setState({
      activeProfileId: successfulAttempt.id,
      cloudProvider: successfulAttempt.provider as any,
      cloudApiKey: successfulAttempt.apiKey,
      cloudApiUrl: successfulAttempt.apiUrl,
      cloudModelName: successfulAttempt.modelName,
    })
  }

  const result = raw.text

  // Bump glossary usage after a successful generation so the dashboard
  // reflects which entries are actually pulling weight.
  if (projectPrompt && projectPrompt.glossaryHitIds.length > 0) {
    void api.glossaryBumpUsage(projectPrompt.glossaryHitIds).catch((err) => {
      console.warn('[cloudLlm] glossaryBumpUsage failed (non-fatal)', err)
    })
  }

  // Remember the translation in TM so future identical bubbles skip the
  // API call entirely. Best-effort: failure is logged, not raised.
  if (result) {
    void rememberTm({
      sourceText: text,
      targetText: result,
      targetLang: language,
      provider: successfulAttempt.provider,
      model: successfulAttempt.modelName,
    })
  }

  const durationMs = Math.round(performance.now() - t0)
  logCallSafe({
    useCase: 'translate',
    success: !!result,
    usage: raw.usage,
    durationMs,
  })

  return {
    text: result,
    meta: {
      tmHit: false,
      tmSimilarity: null,
      tmFromChapterId: null,
      glossaryHitIds: projectPrompt?.glossaryHitIds ?? [],
      templateName: projectPrompt?.templateName ?? null,
      rollingContextUsed: projectPrompt?.rollingContextRequested ?? false,
      durationMs,
      usage: raw.usage,
    },
  }
}

/**
 * Ask the cloud LLM to propose entities (characters, places, terms, etc.)
 * from a chapter's text. Requires an open project (uses its
 * `extract_entities` prompt template) and a configured cloud provider.
 *
 * Returns the parsed JSON array exactly as the LLM produced it; the
 * caller is responsible for showing a review UI and bulk-applying.
 */
export type ExtractedEntity = {
  original: string
  translation: string
  category: string
}

export async function extractEntitiesFromText(
  sourceText: string,
): Promise<ExtractedEntity[]> {
  const project = useProjectStore.getState().info
  if (!project) {
    throw new Error('Open a project first — extraction needs a series context.')
  }
  const { cloudProvider, cloudApiKey, cloudApiUrl, cloudModelName } =
    usePreferencesStore.getState()
  if (cloudProvider === 'none') {
    throw new Error(
      'Pick a Cloud AI provider in Settings — extraction uses the cloud LLM.',
    )
  }
  if (!cloudApiKey) {
    throw new Error(
      `No API key for the active "${cloudProvider}" profile. Open Profiles tab → edit the active profile and re-enter your API key, then Apply.`,
    )
  }

  const rendered = await api.promptRender({
    useCase: 'extract_entities',
    sourceText,
  })

  const t0 = performance.now()
  let raw: CloudResult
  try {
    if (cloudProvider === 'openai') {
      raw = await fetchOpenAI(
        rendered.prompt,
        cloudApiKey,
        cloudApiUrl,
        cloudModelName,
        true,
      )
    } else if (cloudProvider === 'openrouter') {
      raw = await fetchOpenRouter(
        rendered.prompt,
        cloudApiKey,
        cloudModelName,
        true,
      )
    } else if (cloudProvider === 'gemini') {
      raw = await fetchGemini(
        rendered.prompt,
        cloudApiKey,
        cloudModelName,
        true,
      )
    } else if (cloudProvider === 'anthropic') {
      raw = await fetchAnthropic(
        rendered.prompt,
        cloudApiKey,
        cloudModelName,
        true,
      )
    } else {
      throw new Error(`Unsupported cloud provider: ${cloudProvider}`)
    }
  } catch (err: any) {
    logCallSafe({
      useCase: 'extract_entities',
      success: false,
      usage: null,
      durationMs: Math.round(performance.now() - t0),
      errorMessage: err?.message ?? String(err),
    })
    throw err
  }
  logCallSafe({
    useCase: 'extract_entities',
    success: true,
    usage: raw.usage,
    durationMs: Math.round(performance.now() - t0),
  })

  // Extract the JSON array even if the model wrapped it in prose.
  const trimmed = raw.text.trim()
  const start = trimmed.indexOf('[')
  const end = trimmed.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `Model did not return a JSON array. Raw: ${trimmed.slice(0, 120)}…`,
    )
  }
  const slice = trimmed.slice(start, end + 1)
  const parsed = JSON.parse(slice) as unknown
  if (!Array.isArray(parsed)) throw new Error('Parsed result was not an array')

  return parsed
    .filter(
      (e): e is ExtractedEntity =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as any).original === 'string' &&
        typeof (e as any).translation === 'string' &&
        typeof (e as any).category === 'string',
    )
    .map((e) => ({
      original: e.original.trim(),
      translation: e.translation.trim(),
      category: e.category.trim().toLowerCase(),
    }))
    .filter((e) => e.original && e.translation)
}

export async function generateCloudBatchTranslation(
  blocks: { index: number; text: string }[],
  language: string,
  context?: string,
): Promise<{ index: number; translation: string }[]> {
  const { cloudProvider, cloudApiUrl, cloudModelName, activeProfileId } =
    usePreferencesStore.getState()

  if (!activeProfileId) {
    throw new Error(
      'No LLM profile applied. Open the Profiles sidebar tab and click Apply on a saved profile (or pick one from the LLM badge in the toolbar).',
    )
  }

  const blocksJson = JSON.stringify(blocks, null, 2)
  const prompt = `You are an expert manga translator.
Your task is to translate the 'text' fields in the following JSON array to ${language}.
The texts are sequential dialogue balloons and sound effects from a manga page. 
${context ? `Here is the translation context from previous pages/bubbles to keep consistency:\n${context}\n\n` : ''}Ensure the translation sounds natural, conversational, and flows logically between the sequential index blocks as characters speaking to each other.

Return ONLY a valid JSON array of objects with the exact same 'index' values and your translated strings in the 'translation' fields.
Do not include any other text, conversational filler, markdown formatting, or code blocks.
Input:
${blocksJson}`

  let resultJson = ''
  const t0 = performance.now()
  try {
    const res = await api.cloudLlmCall({
      profileId: activeProfileId,
      prompt,
      modelName: cloudModelName,
      apiUrl: cloudApiUrl || null,
      jsonMode: true,
    })
    resultJson = res.text
  } catch (err: any) {
    logCallSafe({
      useCase: 'translate',
      success: false,
      usage: null,
      durationMs: Math.round(performance.now() - t0),
      errorMessage: err?.message ?? String(err),
    })
    throw err
  }
  logCallSafe({
    useCase: 'translate',
    success: true,
    usage: null,
    durationMs: Math.round(performance.now() - t0),
  })
  resultJson = resultJson

  // Try to find a JSON array within the response if it's wrapped in other text
  let jsonString = resultJson.trim()
  const arrayStart = jsonString.indexOf('[')
  const arrayEnd = jsonString.lastIndexOf(']')

  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    jsonString = jsonString.substring(arrayStart, arrayEnd + 1)
  } else {
    // If no array brackets found, it might be heavily malformed or not JSON at all
    throw new Error(
      `AI did not return a JSON array. Raw output: ${resultJson.substring(0, 100)}...`,
    )
  }

  try {
    const parsed = JSON.parse(jsonString)
    if (Array.isArray(parsed)) {
      // Validate that the array actually contains what we need (at least partially)
      const validItems = parsed.filter(
        (item) =>
          typeof item.index === 'number' &&
          typeof item.translation === 'string',
      )
      if (validItems.length > 0) {
        return validItems
      } else {
        throw new Error(
          'JSON array is missing required "index" and "translation" fields',
        )
      }
    }
    throw new Error('Parsed result is not an array')
  } catch (err: any) {
    console.error('Failed to parse batch translation JSON:', jsonString)
    throw new Error(
      `Failed to parse AI response as JSON: ${err.message}. Raw: ${jsonString.substring(0, 100)}...`,
    )
  }
}

export async function callCloudOnce(args: {
  prompt: string
  provider: string
  apiKey: string
  apiUrl: string
  model: string
  jsonMode?: boolean
  /** Use-case string for cost log. Defaults to "translate". */
  useCase?: string
}): Promise<string> {
  const {
    prompt,
    provider,
    apiKey,
    apiUrl,
    model,
    jsonMode = false,
    useCase = 'translate',
  } = args
  const t0 = performance.now()
  const { activeProfileId } = usePreferencesStore.getState()

  // หากมี activeProfileId ให้รันบนหลังบ้าน Rust ทันทีเพื่อความปลอดภัยระดับสูงสุด
  if (activeProfileId) {
    try {
      const res = await api.cloudLlmCall({
        profileId: activeProfileId,
        prompt,
        modelName: model,
        apiUrl: apiUrl || null,
        jsonMode,
      })
      logCallSafe({
        useCase,
        success: true,
        usage: null,
        durationMs: Math.round(performance.now() - t0),
      })
      return res.text
    } catch (err: any) {
      logCallSafe({
        useCase,
        success: false,
        usage: null,
        durationMs: Math.round(performance.now() - t0),
        errorMessage: err?.message ?? String(err),
      })
      throw err
    }
  }

  let result: CloudResult
  try {
    result = await withRetry(() => {
      switch (provider) {
        case 'openai':
          return fetchOpenAI(prompt, apiKey, apiUrl, model, jsonMode)
        case 'openrouter':
          return fetchOpenRouter(prompt, apiKey, model, jsonMode)
        case 'gemini':
          return fetchGemini(prompt, apiKey, model, jsonMode)
        case 'anthropic':
          return fetchAnthropic(prompt, apiKey, model, jsonMode)
        default:
          throw new Error(`Unsupported cloud provider: ${provider}`)
      }
    })
  } catch (err: any) {
    logCallSafe({
      useCase,
      success: false,
      usage: null,
      durationMs: Math.round(performance.now() - t0),
      errorMessage: err?.message ?? String(err),
    })
    throw err
  }
  logCallSafe({
    useCase,
    success: true,
    usage: result.usage,
    durationMs: Math.round(performance.now() - t0),
  })
  return result.text
}

/**
 * Send a single trivial round-trip to the configured provider and
 * report success/failure. Used by the "Test connection" buttons in
 * Settings and Profiles. Tiny prompt to keep the cost negligible —
 * usually a few cents per thousand pings.
 */
export type TestConnectionInput = {
  provider: string
  apiKey: string
  apiUrl: string
  model: string
}

export type TestConnectionResult =
  | { ok: true; reply: string; durationMs: number; usage: TokenUsage | null }
  | { ok: false; error: string; durationMs: number }

export async function testCloudConnection(
  input: TestConnectionInput,
): Promise<TestConnectionResult> {
  const t0 = performance.now()
  const prompt = 'Reply with the single word OK and nothing else.'
  try {
    let res: CloudResult
    switch (input.provider) {
      case 'openai':
        res = await fetchOpenAI(prompt, input.apiKey, input.apiUrl, input.model)
        break
      case 'openrouter':
        res = await fetchOpenRouter(prompt, input.apiKey, input.model)
        break
      case 'gemini':
        res = await fetchGemini(prompt, input.apiKey, input.model)
        break
      case 'anthropic':
        res = await fetchAnthropic(prompt, input.apiKey, input.model)
        break
      default:
        throw new Error(`Unsupported provider: ${input.provider}`)
    }
    return {
      ok: true,
      reply: res.text,
      durationMs: Math.round(performance.now() - t0),
      usage: res.usage,
    }
  } catch (err: any) {
    return {
      ok: false,
      error: err?.message ?? String(err),
      durationMs: Math.round(performance.now() - t0),
    }
  }
}

async function fetchOpenAI(
  prompt: string,
  apiKey: string,
  apiUrl: string,
  model: string,
  isJsonMode = false,
  onChunk?: StreamHandler,
): Promise<CloudResult> {
  // Use user's custom url or trailing slash cleanup
  const baseUrl = apiUrl.replace(/\/+$/, '')
  const endpoint = `${baseUrl}/chat/completions`

  const body: any = {
    model: model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
  }

  if (isJsonMode) {
    // Modern OpenAI-compatible servers (OpenRouter, Groq, DeepSeek,
    // Together, vLLM, llama.cpp …) accept `response_format` and
    // either honour it or silently ignore it. The previous
    // `model.includes('gpt')` gate skipped it for everything except
    // first-party OpenAI, which meant batch JSON translation through
    // these compat bases relied entirely on the prompt + the
    // JSON-extraction regex fallback. Always send it now; the
    // fallback is still in place if a fringe server 400s.
    body.response_format = { type: 'json_object' }
  }

  if (onChunk) {
    body.stream = true
    body.stream_options = { include_usage: true }
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`OpenAI API Error: ${err}`)
  }

  if (onChunk && res.body) {
    return await parseOpenAiStream(res.body, onChunk)
  }

  const data = await res.json()
  return {
    text: data.choices[0]?.message?.content?.trim() || '',
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? null,
      completionTokens: data.usage?.completion_tokens ?? null,
    },
  }
}

async function parseOpenAiStream(
  body: ReadableStream<Uint8Array>,
  onChunk: StreamHandler,
): Promise<CloudResult> {
  let acc = ''
  let usage: TokenUsage | null = null
  for await (const payload of readSseEvents(body)) {
    let evt: any
    try {
      evt = JSON.parse(payload)
    } catch {
      continue
    }
    const delta = evt.choices?.[0]?.delta?.content
    if (typeof delta === 'string' && delta) {
      acc += delta
      onChunk(delta)
    }
    if (evt.usage) {
      usage = {
        promptTokens: evt.usage.prompt_tokens ?? null,
        completionTokens: evt.usage.completion_tokens ?? null,
      }
    }
  }
  return { text: acc.trim(), usage }
}

async function fetchOpenRouter(
  prompt: string,
  apiKey: string,
  model: string,
  isJsonMode = false,
  onChunk?: StreamHandler,
): Promise<CloudResult> {
  // OpenRouter speaks OpenAI's chat-completions dialect. We send the
  // optional HTTP-Referer / X-Title headers it uses for app attribution.
  const endpoint = 'https://openrouter.ai/api/v1/chat/completions'

  const body: any = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
  }

  // OpenRouter forwards `response_format` to upstream models that support it
  // and ignores it elsewhere, so it's safe to always pass in JSON mode.
  if (isJsonMode) {
    body.response_format = { type: 'json_object' }
  }

  if (onChunk) {
    body.stream = true
    body.stream_options = { include_usage: true }
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/EarthWL/koharu-th',
      'X-Title': 'Koharu-TH',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`OpenRouter API Error: ${err}`)
  }

  if (onChunk && res.body) {
    return await parseOpenAiStream(res.body, onChunk)
  }

  const data = await res.json()
  return {
    text: data.choices?.[0]?.message?.content?.trim() || '',
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? null,
      completionTokens: data.usage?.completion_tokens ?? null,
    },
  }
}

async function fetchGemini(
  prompt: string,
  apiKey: string,
  model: string,
  isJsonMode = false,
  onChunk?: StreamHandler,
): Promise<CloudResult> {
  // Gemini exposes a separate :streamGenerateContent endpoint for SSE
  // streaming. We use alt=sse to get the data:-prefixed framing that
  // matches our shared parser; otherwise it returns a JSON array.
  const endpoint = onChunk
    ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
    : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

  const body: any = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1 },
  }

  if (isJsonMode) {
    body.generationConfig.responseMimeType = 'application/json'
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini API Error: ${err}`)
  }

  if (onChunk && res.body) {
    let acc = ''
    let usage: TokenUsage | null = null
    for await (const payload of readSseEvents(res.body)) {
      let evt: any
      try {
        evt = JSON.parse(payload)
      } catch {
        continue
      }
      const parts = evt.candidates?.[0]?.content?.parts ?? []
      for (const part of parts) {
        const t = part.text
        if (typeof t === 'string' && t) {
          acc += t
          onChunk(t)
        }
      }
      if (evt.usageMetadata) {
        usage = {
          promptTokens: evt.usageMetadata.promptTokenCount ?? null,
          completionTokens: evt.usageMetadata.candidatesTokenCount ?? null,
        }
      }
    }
    return { text: acc.trim(), usage }
  }

  const data = await res.json()
  return {
    text: data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '',
    usage: {
      promptTokens: data.usageMetadata?.promptTokenCount ?? null,
      completionTokens: data.usageMetadata?.candidatesTokenCount ?? null,
    },
  }
}

async function fetchAnthropic(
  prompt: string,
  apiKey: string,
  model: string,
  isJsonMode = false,
  onChunk?: StreamHandler,
): Promise<CloudResult> {
  const endpoint = 'https://api.anthropic.com/v1/messages'

  // Notice Anthropic endpoint via browser usually hits CORS.
  // We'll add standard anthropic headers, but warn user about CORS if it runs strictly in browser.
  // Tauri intercepts or can fetch with less CORS issues, but standard fetch follows CORS.
  // Scale output budget with input length. Batch JSON translation
  // requests roughly 1:1 in size, so a long page with many bubbles
  // could blow past a hardcoded 4096 cap and truncate the JSON array
  // — caller would then throw "AI did not return JSON". Floor at 4096
  // (covers normal pages), cap at 8192 to stay safe across all Claude
  // model output limits (Haiku tops out around there). Char-to-token
  // ratio of ~3 is a rough mixed-text approximation.
  const estimatedInputTokens = Math.ceil(prompt.length / 3)
  const maxTokens = Math.min(8192, Math.max(4096, estimatedInputTokens * 2))
  const body: any = {
    model: model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
  }
  if (onChunk) body.stream = true
  void isJsonMode // Anthropic ignores this; consumers post-process the text.

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true', // Necessary for browser calls
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Anthropic API Error: ${err}`)
  }

  if (onChunk && res.body) {
    let acc = ''
    let usage: TokenUsage = { promptTokens: null, completionTokens: null }
    for await (const payload of readSseEvents(res.body)) {
      let evt: any
      try {
        evt = JSON.parse(payload)
      } catch {
        continue
      }
      // content_block_delta carries the streaming text shards.
      if (evt.type === 'content_block_delta') {
        const t = evt.delta?.text
        if (typeof t === 'string' && t) {
          acc += t
          onChunk(t)
        }
      } else if (evt.type === 'message_start') {
        const u = evt.message?.usage
        if (u?.input_tokens != null) usage.promptTokens = u.input_tokens
      } else if (evt.type === 'message_delta') {
        const u = evt.usage
        if (u?.output_tokens != null) usage.completionTokens = u.output_tokens
      }
    }
    return { text: acc.trim(), usage }
  }

  const data = await res.json()
  return {
    text: data.content?.[0]?.text?.trim() || '',
    usage: {
      promptTokens: data.usage?.input_tokens ?? null,
      completionTokens: data.usage?.output_tokens ?? null,
    },
  }
}
