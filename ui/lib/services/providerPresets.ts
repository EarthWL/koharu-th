/**
 * Quick-set presets for the Cloud AI provider config. Each preset
 * picks a sensible {provider, baseUrl, model} so the user can land on
 * a working setup with one click then just paste their key.
 *
 * The `provider` here is what koharu's cloudLlm.ts speaks — for the
 * many OpenAI-compatible vendors (Groq, Together, DeepSeek, Mistral,
 * xAI, Ollama, …) we send `openai` and override the base URL.
 */

import type { CloudProvider } from '@/lib/stores/preferencesStore'

export type ProviderPreset = {
  /** Stable id for the dropdown value. */
  id: string
  /** Human-readable label. */
  label: string
  /** Cloud-provider dialect used by cloudLlm.ts dispatch. */
  provider: CloudProvider
  /** Base URL for OpenAI-compatible providers. Empty for native dialects. */
  baseUrl: string
  /** Suggested model to drop into cloudModelName. */
  defaultModel: string
  /** Optional secondary line shown in the dropdown. */
  hint?: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    provider: 'openrouter',
    baseUrl: '',
    defaultModel: '',
    hint: 'Live model picker on this fork',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    provider: 'anthropic',
    baseUrl: '',
    defaultModel: 'claude-3-5-sonnet-latest',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    provider: 'gemini',
    baseUrl: '',
    defaultModel: 'gemini-2.5-flash',
  },
  {
    id: 'groq',
    label: 'Groq',
    provider: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    hint: 'Very fast hosted inference',
  },
  {
    id: 'together',
    label: 'Together AI',
    provider: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    provider: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    provider: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    provider: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-2-1212',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    provider: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.3',
    hint: 'Requires Ollama running locally',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    provider: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: 'auto',
    hint: 'Whichever model is loaded in LM Studio',
  },
]
