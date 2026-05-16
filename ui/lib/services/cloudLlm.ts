import { usePreferencesStore } from '../stores/preferencesStore'

export async function generateCloudTranslation(text: string, language: string): Promise<string> {
  const { cloudProvider, cloudApiKey, cloudApiUrl, cloudModelName } = usePreferencesStore.getState()
  
  if (!cloudApiKey) {
    throw new Error('Cloud API Key is missing.')
  }

  const prompt = `You are a professional manga translator. Translate the following text to ${language}.
The translation should sound natural, conversational, and appropriate for comic book characters, keeping the original tone and context intact.
Only return the translation, no extra text:\n\n${text}`

  if (cloudProvider === 'openai') {
    return fetchOpenAI(prompt, cloudApiKey, cloudApiUrl, cloudModelName)
  } else if (cloudProvider === 'openrouter') {
    return fetchOpenRouter(prompt, cloudApiKey, cloudModelName)
  } else if (cloudProvider === 'gemini') {
    return fetchGemini(prompt, cloudApiKey, cloudModelName)
  } else if (cloudProvider === 'anthropic') {
    return fetchAnthropic(prompt, cloudApiKey, cloudModelName)
  }

  throw new Error(`Unsupported cloud provider: ${cloudProvider}`)
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
