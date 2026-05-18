/**
 * Shared helpers for LLM provider profile handling. Extracted from
 * `ProfilesTabPanel.tsx` so other consumers (CanvasToolbar's
 * LlmStatusPopover, Settings page, cloudOcr / cloudLlm dispatch) can
 * reuse the same provider-detection heuristics without copy-pasting.
 *
 * `kindOf()` is kept here for legacy compatibility (see comment) but
 * will become near-dead code once the v1.x audience has rotated through
 * fresh profile saves — backend commit b3d4c7f3 fixed the underlying
 * `"openrouter" → Provider::Openai` DB-read collapse so new rows are
 * stored correctly.
 *
 * TODO(v1.5.0): re-evaluate whether `kindOf` still earns its keep, or
 * if direct `profile.provider` reads suffice.
 */

import type { ProviderProfileDto } from '@/lib/api'

export type ProviderKind = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'local'

export type KindMeta = {
  kind: ProviderKind
  label: string
  dbProvider: 'openai' | 'openrouter' | 'gemini' | 'anthropic'
  defaultBaseUrl: string
  /** Whether we can list models for this provider. */
  hasModelList: boolean
  /** Whether the API key is required to fetch the model list. */
  needsKeyForList: boolean
  /** Default model when user hasn't picked anything yet. */
  suggestedModel: string
  /** Provider's web page where the user generates an API key. Linked
   *  in "no API key" error hints across the app so the user has a
   *  one-click path to fix the problem. */
  keyUrl?: string
  hint?: string
}

export const KINDS: KindMeta[] = [
  {
    kind: 'openai',
    label: 'OpenAI',
    dbProvider: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    hasModelList: true,
    needsKeyForList: true,
    suggestedModel: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    hint: 'Live model list',
  },
  {
    kind: 'anthropic',
    label: 'Claude',
    dbProvider: 'anthropic',
    defaultBaseUrl: '',
    hasModelList: true,
    needsKeyForList: true,
    suggestedModel: 'claude-3-5-sonnet-latest',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    hint: 'Live model list',
  },
  {
    kind: 'gemini',
    label: 'Gemini',
    dbProvider: 'gemini',
    defaultBaseUrl: '',
    hasModelList: true,
    needsKeyForList: true,
    suggestedModel: 'gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
    hint: 'Live model list',
  },
  {
    kind: 'openrouter',
    label: 'OpenRouter',
    dbProvider: 'openrouter',
    defaultBaseUrl: '',
    hasModelList: true,
    needsKeyForList: false,
    suggestedModel: '',
    keyUrl: 'https://openrouter.ai/keys',
    hint: 'Live model list',
  },
  {
    kind: 'local',
    label: 'Local LLM',
    dbProvider: 'openai',
    defaultBaseUrl: 'http://localhost:11434/v1',
    hasModelList: true,
    needsKeyForList: false,
    suggestedModel: '',
    hint: 'Ollama / LM Studio / llama.cpp',
  },
]

export const KIND_LABEL: Record<ProviderKind, string> = Object.fromEntries(
  KINDS.map((k) => [k.kind, k.label]),
) as Record<ProviderKind, string>

/**
 * Resolve a profile DTO to its display "kind" (provider tile).
 *
 * Most rows now come back from Rust with a correct `provider` field
 * (after backend commit b3d4c7f3). This function exists for two
 * reasons:
 *
 *   1. **Local LLM detection** — local profiles persist as
 *      `provider='openai'` but with an Ollama / LM Studio URL. We tag
 *      them as `'local'` for the UI.
 *
 *   2. **Legacy OpenRouter compat** — profiles created before v1.0.0
 *      stored OpenRouter as `provider='openai'` because the backend
 *      used to collapse "openrouter" → Openai on read. The slash in
 *      OpenRouter model ids (`vendor/model`) is the tell. We re-route
 *      them to the `'openrouter'` tile so the edit modal + Apply
 *      dispatch land on the right code path.
 *
 * TODO(v1.5.0): the legacy branch can probably be removed once we're
 * confident no installs still have pre-v1.0.0 rows in the DB.
 */
/** Minimum shape we need to determine the kind / dispatch provider.
 *  Accepts the full DTO from the DB list, OR a synthetic on-the-fly
 *  object built from `preferencesStore.{cloudProvider, cloudModelName,
 *  cloudApiUrl}` for the "active translation profile" fallback path. */
export type ProfileLike = Pick<
  ProviderProfileDto,
  'provider' | 'modelName'
> & {
  apiUrl?: string | null
}

export function kindOf(profile: ProfileLike): ProviderKind {
  if (profile.provider === 'anthropic') return 'anthropic'
  if (profile.provider === 'gemini') return 'gemini'
  if (profile.provider === 'openrouter') return 'openrouter'
  const url = profile.apiUrl ?? ''
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(url)) return 'local'
  if (profile.provider === 'openai' && profile.modelName.includes('/')) {
    return 'openrouter'
  }
  return 'openai'
}

/**
 * Resolve to the dbProvider string the dispatch layer expects
 * (`cloudLlm.ts` / `cloudOcr.ts` switch on this). Handles the same
 * legacy OpenRouter mis-store as `kindOf`.
 */
export function effectiveDbProvider(profile: ProfileLike): string {
  return KINDS.find((k) => k.kind === kindOf(profile))!.dbProvider
}

/**
 * Whether the model list query for a given provider should be enabled
 * right now. Centralised so the React Query `enabled` predicate and
 * the SearchableSelect's `disabled` prop agree — if they drift, the
 * UI shows "loading…" while the query never fires.
 */
export function canLoadModels(args: {
  kind: ProviderKind
  apiKey: string
  apiUrl: string
  apiKeyLoaded: boolean
}): boolean {
  const { kind, apiKey, apiUrl, apiKeyLoaded } = args
  if (!apiKeyLoaded) return false
  switch (kind) {
    case 'openrouter':
      return true // browsing without a key is supported
    case 'gemini':
    case 'openai':
    case 'anthropic':
      return apiKey.length > 0
    case 'local':
      return apiUrl.length > 0
  }
}
