/**
 * Heuristic check for whether a given (provider, model) supports vision
 * input. Used by the AI Chat to disable image attachments + warn the
 * user before they send a multimodal request that would 400 at the
 * provider.
 *
 * Heuristics are conservative — when in doubt we return `false` so the
 * user notices and can override. Provider model lists change quickly;
 * this isn't a contract.
 */

export type VisionCheck = {
  supported: boolean
  /** Human-readable reason shown in tooltips when not supported. */
  reason: string
}

const SUPPORTED: VisionCheck = {
  supported: true,
  reason: 'Model supports image attachments.',
}

/** Check if the given (provider, model) accepts image inputs. */
export function supportsVision(provider: string, modelId: string): VisionCheck {
  if (!modelId) {
    return { supported: false, reason: 'No model selected.' }
  }
  const m = modelId.toLowerCase()

  switch (provider) {
    case 'openai':
      // gpt-4o family, gpt-4-turbo, gpt-4-vision-preview, o1/o3/o4
      // reasoning models, gpt-5 family. Excludes gpt-3.5, base gpt-4,
      // embedding/audio/tts models.
      if (
        m.includes('gpt-4o') ||
        m.includes('gpt-4-turbo') ||
        m.includes('gpt-4-vision') ||
        m.includes('gpt-5') ||
        /\bo[1-9](\b|-)/.test(m) // o1, o3, o4 reasoning models
      ) {
        return SUPPORTED
      }
      // OpenAI-compatible endpoints (LM Studio etc.) — heuristic
      // can't tell, default to "may not" so user knows to verify.
      return {
        supported: false,
        reason:
          'OpenAI-compatible models other than gpt-4o / gpt-4-turbo / o1+ usually do not accept images. Verify your model supports vision.',
      }

    case 'anthropic':
      // Claude 3 series + 4 / 4.5 all support vision. Claude 2 and
      // claude-instant do not.
      if (
        /\bclaude-(3|4|opus-4|sonnet-4|haiku-4|3-5|3\.5|3\.7)/.test(m) ||
        m.includes('claude-3-haiku') ||
        m.includes('claude-3-opus') ||
        m.includes('claude-3-sonnet') ||
        m.includes('claude-haiku') ||
        m.includes('claude-sonnet') ||
        m.includes('claude-opus')
      ) {
        return SUPPORTED
      }
      return {
        supported: false,
        reason: 'Pre-Claude-3 models do not support image inputs.',
      }

    case 'gemini':
      // 1.5 / 2.x / pro-vision all support multimodal; gemma is text-only.
      if (m.includes('gemma')) {
        return {
          supported: false,
          reason: 'Gemma models are text-only.',
        }
      }
      if (
        m.includes('gemini-1.5') ||
        m.includes('gemini-2') ||
        m.includes('gemini-pro-vision') ||
        m.includes('gemini-flash')
      ) {
        return SUPPORTED
      }
      // gemini-pro (without -vision) is text-only in legacy versions.
      if (m === 'gemini-pro' || m === 'models/gemini-pro') {
        return {
          supported: false,
          reason:
            'Legacy gemini-pro is text-only — use gemini-1.5+ or 2.x for images.',
        }
      }
      // Default optimistic for unknown gemini variants — they're newer.
      return SUPPORTED

    case 'openrouter':
      // OpenRouter model IDs are vendor/model. Apply the underlying
      // provider's heuristic by sniffing the vendor prefix. For ones
      // we can't classify, return uncertain.
      if (m.startsWith('openai/')) {
        return supportsVision('openai', m.slice('openai/'.length))
      }
      if (m.startsWith('anthropic/')) {
        return supportsVision('anthropic', m.slice('anthropic/'.length))
      }
      if (m.startsWith('google/')) {
        return supportsVision('gemini', m.slice('google/'.length))
      }
      // Many vision-capable OpenRouter models include these markers
      // explicitly in their id.
      if (
        m.includes('vision') ||
        m.includes('llava') ||
        m.includes('vl-') ||
        m.includes('-vl') ||
        m.includes('molmo') ||
        m.includes('pixtral')
      ) {
        return SUPPORTED
      }
      return {
        supported: false,
        reason:
          'Unknown if this OpenRouter model supports images. Verify on openrouter.ai or pick a known-vision model.',
      }

    default:
      // Local LLM (Ollama / LM Studio / llama.cpp) — most installs are
      // text-only; vision (llava, qwen2-vl, …) is opt-in. Detect by
      // common suffixes.
      if (
        m.includes('llava') ||
        m.includes('vision') ||
        m.includes('vl-') ||
        m.includes('-vl') ||
        m.includes('moondream') ||
        m.includes('bakllava')
      ) {
        return SUPPORTED
      }
      return {
        supported: false,
        reason:
          'Local model does not look vision-capable. Use a multimodal model (llava, qwen2-vl, moondream, …) if you want to attach images.',
      }
  }
}
