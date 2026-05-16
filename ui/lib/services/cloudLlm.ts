import { usePreferencesStore } from '../stores/preferencesStore'
import { useProjectStore } from '../stores/projectStore'
import { api } from '../api'

/**
 * If a project is open, ask the backend to render the prompt with full
 * 3-layer context (series meta + main characters + smart-filtered
 * glossary). Returns the rendered prompt + glossary hit IDs to bump
 * usage on after a successful translation. If no project is open,
 * returns null and callers fall back to a built-in stub prompt.
 */
async function tryProjectPrompt(
  text: string,
  language: string,
): Promise<{ prompt: string; glossaryHitIds: number[] } | null> {
  const project = useProjectStore.getState().info
  if (!project) return null
  try {
    const rendered = await api.promptRender({
      useCase: 'translate',
      sourceText: text,
    })
    void language // project's target_language already feeds the template
    return { prompt: rendered.prompt, glossaryHitIds: rendered.glossaryHitIds }
  } catch (err) {
    // If the project DB doesn't have a translate template (e.g. very old
    // schema) we just fall back to the stub prompt instead of failing.
    console.warn('[cloudLlm] promptRender failed; falling back', err)
    return null
  }
}

async function tryTmHit(sourceText: string, targetLang: string) {
  if (!useProjectStore.getState().info) return null
  try {
    const hit = await api.tmLookup(sourceText, targetLang)
    return hit ?? null
  } catch (err) {
    console.warn('[cloudLlm] tmLookup failed (non-fatal)', err)
    return null
  }
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

export async function generateCloudTranslation(text: string, language: string): Promise<string> {
  const { cloudProvider, cloudApiKey, cloudApiUrl, cloudModelName } = usePreferencesStore.getState()

  if (!cloudApiKey) {
    throw new Error('Cloud API Key is missing.')
  }

  // Cache key = (source text, target language). The language arg is
  // whatever the caller passed (project's target_language or a free-text
  // value), so identical pages on the same project bucket together.
  const tmHit = await tryTmHit(text, language)
  if (tmHit) {
    return tmHit.targetText
  }

  const projectPrompt = await tryProjectPrompt(text, language)
  const prompt = projectPrompt?.prompt ??
    `You are a professional manga translator. Translate the following text to ${language}.
The translation should sound natural, conversational, and appropriate for comic book characters, keeping the original tone and context intact.
Only return the translation, no extra text:\n\n${text}`

  let result: string
  if (cloudProvider === 'openai') {
    result = await fetchOpenAI(prompt, cloudApiKey, cloudApiUrl, cloudModelName)
  } else if (cloudProvider === 'openrouter') {
    result = await fetchOpenRouter(prompt, cloudApiKey, cloudModelName)
  } else if (cloudProvider === 'gemini') {
    result = await fetchGemini(prompt, cloudApiKey, cloudModelName)
  } else if (cloudProvider === 'anthropic') {
    result = await fetchAnthropic(prompt, cloudApiKey, cloudModelName)
  } else {
    throw new Error(`Unsupported cloud provider: ${cloudProvider}`)
  }

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
      provider: cloudProvider,
      model: cloudModelName,
    })
  }

  return result
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
    throw new Error('Cloud API Key is missing.')
  }

  const rendered = await api.promptRender({
    useCase: 'extract_entities',
    sourceText,
  })

  let raw: string
  if (cloudProvider === 'openai') {
    raw = await fetchOpenAI(rendered.prompt, cloudApiKey, cloudApiUrl, cloudModelName, true)
  } else if (cloudProvider === 'openrouter') {
    raw = await fetchOpenRouter(rendered.prompt, cloudApiKey, cloudModelName, true)
  } else if (cloudProvider === 'gemini') {
    raw = await fetchGemini(rendered.prompt, cloudApiKey, cloudModelName, true)
  } else if (cloudProvider === 'anthropic') {
    raw = await fetchAnthropic(rendered.prompt, cloudApiKey, cloudModelName, true)
  } else {
    throw new Error(`Unsupported cloud provider: ${cloudProvider}`)
  }

  // Extract the JSON array even if the model wrapped it in prose.
  const trimmed = raw.trim()
  const start = trimmed.indexOf('[')
  const end = trimmed.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Model did not return a JSON array. Raw: ${trimmed.slice(0, 120)}…`)
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

export async function generateCloudBatchTranslation(blocks: {index: number, text: string}[], language: string): Promise<{index: number, translation: string}[]> {
  const { cloudProvider, cloudApiKey, cloudApiUrl, cloudModelName } = usePreferencesStore.getState()
  
  if (!cloudApiKey) {
    throw new Error('Cloud API Key is missing.')
  }

  const blocksJson = JSON.stringify(blocks, null, 2)
  const prompt = `You are an expert manga translator.
Your task is to translate the 'text' fields in the following JSON array to ${language}.
The texts are sequential dialogue balloons and sound effects from a manga page. 
Ensure the translation sounds natural, conversational, and flows logically between the sequential index blocks as characters speaking to each other.

Return ONLY a valid JSON array of objects with the exact same 'index' values and your translated strings in the 'translation' fields.
Do not include any other text, conversational filler, markdown formatting, or code blocks.
Input:
${blocksJson}`

  let resultJson = ''

  if (cloudProvider === 'openai') {
    resultJson = await fetchOpenAI(prompt, cloudApiKey, cloudApiUrl, cloudModelName, true)
  } else if (cloudProvider === 'openrouter') {
    resultJson = await fetchOpenRouter(prompt, cloudApiKey, cloudModelName, true)
  } else if (cloudProvider === 'gemini') {
    resultJson = await fetchGemini(prompt, cloudApiKey, cloudModelName, true)
  } else if (cloudProvider === 'anthropic') {
    resultJson = await fetchAnthropic(prompt, cloudApiKey, cloudModelName, true)
  } else {
    throw new Error(`Unsupported cloud provider: ${cloudProvider}`)
  }

  // Try to find a JSON array within the response if it's wrapped in other text
  let jsonString = resultJson.trim()
  const arrayStart = jsonString.indexOf('[')
  const arrayEnd = jsonString.lastIndexOf(']')
  
  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    jsonString = jsonString.substring(arrayStart, arrayEnd + 1)
  } else {
    // If no array brackets found, it might be heavily malformed or not JSON at all
    throw new Error(`AI did not return a JSON array. Raw output: ${resultJson.substring(0, 100)}...`)
  }
  
  try {
    const parsed = JSON.parse(jsonString)
    if (Array.isArray(parsed)) {
      // Validate that the array actually contains what we need (at least partially)
      const validItems = parsed.filter(item => typeof item.index === 'number' && typeof item.translation === 'string')
      if (validItems.length > 0) {
         return validItems
      } else {
         throw new Error('JSON array is missing required "index" and "translation" fields')
      }
    }
    throw new Error('Parsed result is not an array')
  } catch (err: any) {
    console.error('Failed to parse batch translation JSON:', jsonString)
    throw new Error(`Failed to parse AI response as JSON: ${err.message}. Raw: ${jsonString.substring(0, 100)}...`)
  }
}


/**
 * Send a single one-shot prompt to whatever cloud provider is named.
 * Shared by the chapter-summariser and entity-extractor flows; does
 * NOT touch the project's TM (those callers want a fresh response).
 */
export async function callCloudOnce(args: {
  prompt: string
  provider: string
  apiKey: string
  apiUrl: string
  model: string
  jsonMode?: boolean
}): Promise<string> {
  const { prompt, provider, apiKey, apiUrl, model, jsonMode = false } = args
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
}

async function fetchOpenAI(prompt: string, apiKey: string, apiUrl: string, model: string, isJsonMode = false): Promise<string> {
  // Use user's custom url or trailing slash cleanup
  const baseUrl = apiUrl.replace(/\/+$/, '')
  const endpoint = `${baseUrl}/chat/completions`

  const body: any = {
    model: model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1
  }

  if (isJsonMode && model.includes('gpt')) {
    body.response_format = { type: 'json_object' } // Need to modify prompt to expect object if strict json is required by OpenAI API, but we'll try raw first since openrouter models might not support response_format
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`OpenAI API Error: ${err}`)
  }

  const data = await res.json()
  return data.choices[0]?.message?.content?.trim() || ''
}

async function fetchOpenRouter(prompt: string, apiKey: string, model: string, isJsonMode = false): Promise<string> {
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

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/EarthWL/koharu-th',
      'X-Title': 'Koharu-TH',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`OpenRouter API Error: ${err}`)
  }

  const data = await res.json()
  return data.choices?.[0]?.message?.content?.trim() || ''
}

async function fetchGemini(prompt: string, apiKey: string, model: string, isJsonMode = false): Promise<string> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
  
  const body: any = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1 }
  }

  if (isJsonMode) {
    body.generationConfig.responseMimeType = 'application/json'
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini API Error: ${err}`)
  }

  const data = await res.json()
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || ''
}

async function fetchAnthropic(prompt: string, apiKey: string, model: string, isJsonMode = false): Promise<string> {
  const endpoint = 'https://api.anthropic.com/v1/messages'

  // Notice Anthropic endpoint via browser usually hits CORS.
  // We'll add standard anthropic headers, but warn user about CORS if it runs strictly in browser.
  // Tauri intercepts or can fetch with less CORS issues, but standard fetch follows CORS.
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true' // Necessary for browser calls
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1
    })
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Anthropic API Error: ${err}`)
  }

  const data = await res.json()
  return data.content?.[0]?.text?.trim() || ''
}
