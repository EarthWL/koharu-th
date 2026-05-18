'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  CheckIcon,
  KeyRoundIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  StarIcon,
  Trash2Icon,
  XIcon,
  ZapIcon,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  SearchableSelect,
  type SearchableSelectOption,
} from '@/components/ui/searchable-select'
import { api, type ProviderProfileDto } from '@/lib/api'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import { testCloudConnection } from '@/lib/services/cloudLlm'
import {
  fetchOpenRouterModels,
  formatPricePerMillion,
  formatContextLength,
} from '@/lib/services/openrouterModels'
import {
  fetchGeminiModels,
  formatTokenLimit,
} from '@/lib/services/geminiModels'
import {
  fetchLocalModels,
  formatModelSize,
} from '@/lib/services/ollamaModels'
import {
  fetchOpenAiModels,
  isLikelyChatModel,
} from '@/lib/services/openaiModels'
import {
  fetchAnthropicModels,
  formatAnthropicCreatedAt,
} from '@/lib/services/anthropicModels'

// ─────────────────────────────────────────────────────────────────
// Provider kinds — what the user picks. Maps to DB provider + URL.
// ─────────────────────────────────────────────────────────────────
type ProviderKind = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'local'

type KindMeta = {
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
  hint?: string
}

const KINDS: KindMeta[] = [
  {
    kind: 'openai',
    label: 'OpenAI',
    dbProvider: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    hasModelList: true,
    needsKeyForList: true,
    suggestedModel: 'gpt-4o-mini',
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

function kindOf(profile: ProviderProfileDto): ProviderKind {
  if (profile.provider === 'anthropic') return 'anthropic'
  if (profile.provider === 'gemini') return 'gemini'
  if (profile.provider === 'openrouter') return 'openrouter'
  const url = profile.apiUrl ?? ''
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(url)) return 'local'
  // Legacy compat: profiles created before v1.0.0 stored OpenRouter as
  // provider='openai' (the Rust backend used to collapse openrouter into
  // openai). OpenRouter model IDs always look like `vendor/model`
  // (e.g. `anthropic/claude-haiku-latest`) — the slash is the tell.
  // Detect + route to the OpenRouter tile so the edit modal + apply
  // dispatch land on the right code path. New saves are stored with
  // the proper 'openrouter' value via the fixed parse_provider in Rust.
  if (profile.provider === 'openai' && profile.modelName.includes('/')) {
    return 'openrouter'
  }
  return 'openai'
}

const KIND_LABEL: Record<ProviderKind, string> = Object.fromEntries(
  KINDS.map((k) => [k.kind, k.label]),
) as Record<ProviderKind, string>

// ─────────────────────────────────────────────────────────────────
// List panel
// ─────────────────────────────────────────────────────────────────
export function ProfilesTabPanel() {
  const profiles = useQuery({
    queryKey: ['project', 'profiles'],
    queryFn: () => api.providerProfilesList(),
  })
  const list = profiles.data ?? []
  const [editing, setEditing] = useState<
    | { mode: 'add' }
    | { mode: 'edit'; profile: ProviderProfileDto }
    | null
  >(null)
  const refresh = () => void profiles.refetch()
  const setPrefs = usePreferencesStore.getState()
  // Subscribe so the row's "Active" badge re-renders when the active
  // LLM changes via the toolbar dropdown.
  const activeProvider = usePreferencesStore((s) => s.cloudProvider)
  const activeModel = usePreferencesStore((s) => s.cloudModelName)

  const apply = async (p: ProviderProfileDto) => {
    // Use the detected kind's dbProvider so legacy mis-stored
    // OpenRouter profiles (saved as 'openai' before v1.0.0) route to
    // the correct dispatcher in cloudLlm.ts.
    const detectedKind = kindOf(p)
    const meta = KINDS.find((k) => k.kind === detectedKind)!
    setPrefs.setCloudProvider(meta.dbProvider as any)
    setPrefs.setCloudModelName(p.modelName)
    setPrefs.setActiveProfileId(p.id)
    if (p.apiUrl) setPrefs.setCloudApiUrl(p.apiUrl)
    try {
      const { apiKey } = await api.providerProfileSecretGet(p.id)
      if (apiKey) setPrefs.setCloudApiKey(apiKey)
    } catch (err) {
      console.warn('[profiles] secret fetch failed', err)
    }
  }
  const toggleDefault = async (p: ProviderProfileDto) => {
    await api.providerProfileUpdate({ id: p.id, isDefault: !p.isDefault })
    refresh()
  }
  const remove = async (p: ProviderProfileDto) => {
    if (!confirm(`Delete "${p.name}"?`)) return
    await api.providerProfileRemove(p.id)
    refresh()
  }

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <div className='border-border flex items-center justify-between border-b px-2 py-1.5'>
        <span className='text-muted-foreground text-[10px] font-bold tracking-wide uppercase'>
          Profiles ({list.length})
        </span>
        <Button
          variant='ghost'
          size='icon-xs'
          className='size-6'
          title='Add profile'
          onClick={() => setEditing({ mode: 'add' })}
        >
          <PlusIcon className='size-3.5' />
        </Button>
      </div>
      <ScrollArea className='min-h-0 min-w-0 flex-1'>
        <div className='w-full min-w-0 space-y-1 p-2'>
          {profiles.isLoading ? (
            <p className='text-muted-foreground p-2 text-center text-xs'>
              Loading…
            </p>
          ) : !list.length ? (
            <div className='border-border rounded-md border border-dashed p-3 text-center text-xs'>
              <KeyRoundIcon className='text-muted-foreground/40 mx-auto mb-2 size-6' />
              <p className='text-muted-foreground mb-2'>
                บันทึก config ของ LLM provider หลายๆ ตัวเพื่อสลับใช้งานได้
              </p>
              <Button
                variant='outline'
                size='sm'
                className='h-7 text-[10px]'
                onClick={() => setEditing({ mode: 'add' })}
              >
                <PlusIcon className='size-3' />
                Add first profile
              </Button>
            </div>
          ) : (
            list.map((p) => {
              // Compare against the effective provider (kindOf maps
              // legacy openrouter-as-openai correctly) so Apply lights
              // up the Active badge even on mis-stored legacy rows.
              const effectiveDbProvider = KINDS.find(
                (k) => k.kind === kindOf(p),
              )!.dbProvider
              const isActive =
                effectiveDbProvider === activeProvider &&
                p.modelName === activeModel
              return (
              <div
                key={p.id}
                className={
                  'group min-w-0 rounded-md border p-1.5 ' +
                  (isActive
                    ? 'border-rose-400/60 bg-rose-400/5'
                    : 'border-border bg-card')
                }
              >
                <div className='flex items-start gap-1.5'>
                  <button
                    onClick={() => void toggleDefault(p)}
                    className='shrink-0 hover:text-amber-500'
                    title={
                      p.isDefault
                        ? 'Unmark as default'
                        : 'Mark as default (auto-loaded on project open)'
                    }
                  >
                    <StarIcon
                      className={
                        p.isDefault
                          ? 'fill-amber-400 size-3 text-amber-400'
                          : 'text-muted-foreground/50 size-3'
                      }
                    />
                  </button>
                  <div className='min-w-0 flex-1 text-xs'>
                    <div className='truncate font-semibold'>{p.name}</div>
                    <div className='text-muted-foreground truncate text-[10px]'>
                      {KIND_LABEL[kindOf(p)]} · {p.modelName || '(no model)'}
                    </div>
                  </div>
                  <Button
                    variant={isActive ? 'default' : 'outline'}
                    size='sm'
                    className={
                      'h-6 px-2 text-[10px] ' +
                      (isActive
                        ? 'bg-rose-400 hover:bg-rose-400/90 text-white'
                        : '')
                    }
                    onClick={() => void apply(p)}
                    title={
                      isActive
                        ? 'Currently active — re-Apply to refresh API key from keyring'
                        : 'Make this the active LLM for translation'
                    }
                  >
                    {isActive ? (
                      <>
                        <CheckIcon className='size-3' />
                        Active
                      </>
                    ) : (
                      'Apply'
                    )}
                  </Button>
                  <Button
                    variant='ghost'
                    size='icon-xs'
                    className='size-6 opacity-0 group-hover:opacity-100'
                    title='Edit'
                    onClick={() => setEditing({ mode: 'edit', profile: p })}
                  >
                    <PencilIcon className='size-3' />
                  </Button>
                  <Button
                    variant='ghost'
                    size='icon-xs'
                    className='size-6 opacity-0 group-hover:opacity-100'
                    title='Delete'
                    onClick={() => void remove(p)}
                  >
                    <Trash2Icon className='size-3' />
                  </Button>
                </div>
              </div>
              )
            })
          )}
        </div>
      </ScrollArea>
      {editing && (
        <ProfileFormModal
          initial={editing.mode === 'edit' ? editing.profile : null}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// Add / Edit modal
// ─────────────────────────────────────────────────────────────────
function ProfileFormModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: ProviderProfileDto | null
  onClose: () => void
  onSaved: () => void
}) {
  const initialKind = initial ? kindOf(initial) : 'openai'
  const initialMeta = KINDS.find((k) => k.kind === initialKind)!

  const [kind, setKind] = useState<ProviderKind>(initialKind)
  const [name, setName] = useState(initial?.name ?? '')
  const [apiKey, setApiKey] = useState('')
  const [apiKeyLoaded, setApiKeyLoaded] = useState(false)
  /** Tracks why the apiKey field is empty when editing. Distinguishes
   *  "no key was ever stored" vs "key is in keyring but fetch failed"
   *  so the UI can tell the user whether they need to re-enter. */
  const [apiKeyStatus, setApiKeyStatus] = useState<
    'fresh' | 'loaded' | 'never-stored' | 'keyring-miss' | 'keyring-error'
  >(initial ? 'loaded' : 'fresh')
  const [apiUrl, setApiUrl] = useState(
    initial?.apiUrl ?? initialMeta.defaultBaseUrl,
  )
  const [modelName, setModelName] = useState(initial?.modelName ?? '')
  const [saving, setSaving] = useState(false)
  const [testStatus, setTestStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'ok'; ms: number }
    | { kind: 'err'; msg: string }
  >({ kind: 'idle' })

  // Load existing API key from keyring when editing.
  useEffect(() => {
    if (!initial) {
      setApiKeyLoaded(true)
      setApiKeyStatus('fresh')
      return
    }
    let cancelled = false
    void (async () => {
      // If the profile has no api_key_ref at all, we know nothing was
      // ever stored — no need to hit the keyring.
      if (!initial.apiKeyRef) {
        if (!cancelled) {
          setApiKey('')
          setApiKeyStatus('never-stored')
          setApiKeyLoaded(true)
        }
        return
      }
      try {
        const { apiKey: existing } =
          await api.providerProfileSecretGet(initial.id)
        if (cancelled) return
        if (existing) {
          setApiKey(existing)
          setApiKeyStatus('loaded')
        } else {
          // api_key_ref is set but keyring returned nothing — the
          // entry was wiped externally, or initial write silently
          // failed.
          setApiKey('')
          setApiKeyStatus('keyring-miss')
        }
      } catch (err) {
        console.warn('[profiles] secret fetch failed', err)
        if (!cancelled) {
          setApiKey('')
          setApiKeyStatus('keyring-error')
        }
      } finally {
        if (!cancelled) setApiKeyLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [initial])

  const meta = KINDS.find((k) => k.kind === kind)!

  const switchKind = (next: ProviderKind) => {
    const nextMeta = KINDS.find((k) => k.kind === next)!
    setKind(next)
    setApiUrl(nextMeta.defaultBaseUrl)
    setModelName(nextMeta.suggestedModel)
    setTestStatus({ kind: 'idle' })
    if (!name.trim()) setName(nextMeta.label)
  }

  // ────────── Model list queries (only one fires at a time) ──────────
  const openrouterModels = useQuery({
    queryKey: ['profile-modal', 'openrouter-models', apiKey],
    queryFn: () => fetchOpenRouterModels(apiKey || undefined),
    enabled: kind === 'openrouter' && apiKeyLoaded,
    staleTime: 10 * 60 * 1000,
    retry: 1,
  })

  const geminiModels = useQuery({
    queryKey: ['profile-modal', 'gemini-models', apiKey],
    queryFn: () => fetchGeminiModels(apiKey),
    enabled: kind === 'gemini' && apiKey.length > 0 && apiKeyLoaded,
    staleTime: 10 * 60 * 1000,
    retry: 1,
  })

  const localModels = useQuery({
    queryKey: ['profile-modal', 'local-models', apiUrl],
    queryFn: () => fetchLocalModels(apiUrl),
    enabled: kind === 'local' && apiUrl.length > 0 && apiKeyLoaded,
    staleTime: 30 * 1000,
    retry: 0,
  })

  const openaiModels = useQuery({
    queryKey: ['profile-modal', 'openai-models', apiKey, apiUrl],
    queryFn: () => fetchOpenAiModels(apiKey, apiUrl),
    enabled: kind === 'openai' && apiKey.length > 0 && apiKeyLoaded,
    staleTime: 10 * 60 * 1000,
    retry: 1,
  })

  const anthropicModels = useQuery({
    queryKey: ['profile-modal', 'anthropic-models', apiKey],
    queryFn: () => fetchAnthropicModels(apiKey),
    enabled: kind === 'anthropic' && apiKey.length > 0 && apiKeyLoaded,
    staleTime: 10 * 60 * 1000,
    retry: 1,
  })

  const modelOptions: SearchableSelectOption[] = useMemo(() => {
    if (kind === 'openrouter') {
      return (openrouterModels.data ?? []).map((m) => {
        const promptPrice = formatPricePerMillion(m.pricing?.promptUsdPerToken)
        const completionPrice = formatPricePerMillion(
          m.pricing?.completionUsdPerToken,
        )
        const ctx = formatContextLength(m.contextLength)
        const trailing = [
          ctx,
          promptPrice && completionPrice
            ? `${promptPrice} in / ${completionPrice} out`
            : null,
        ]
          .filter(Boolean)
          .join(' · ')
        return {
          value: m.id,
          label: m.name,
          searchText: `${m.id} ${m.name}`,
          description: m.id,
          trailing: trailing || undefined,
        }
      })
    }
    if (kind === 'gemini') {
      return (geminiModels.data ?? []).map((m) => {
        const inN = formatTokenLimit(m.inputTokenLimit)
        const outN = formatTokenLimit(m.outputTokenLimit)
        const trailing =
          inN && outN
            ? `${inN} in / ${outN} out`
            : inN
              ? `${inN} in`
              : undefined
        return {
          value: m.id,
          label: m.name,
          searchText: `${m.id} ${m.name}`,
          description: m.id,
          trailing,
        }
      })
    }
    if (kind === 'local') {
      return (localModels.data ?? []).map((m) => ({
        value: m.id,
        label: m.id,
        searchText: m.id,
        trailing: formatModelSize(m.size) ?? undefined,
      }))
    }
    if (kind === 'openai') {
      return (openaiModels.data ?? [])
        .filter((m) => isLikelyChatModel(m.id))
        .map((m) => ({
          value: m.id,
          label: m.id,
          searchText: `${m.id} ${m.ownedBy ?? ''}`,
          trailing: m.ownedBy && m.ownedBy !== 'system'
            ? m.ownedBy
            : undefined,
        }))
    }
    if (kind === 'anthropic') {
      return (anthropicModels.data ?? []).map((m) => ({
        value: m.id,
        label: m.displayName,
        searchText: `${m.id} ${m.displayName}`,
        description: m.id,
        trailing: formatAnthropicCreatedAt(m.createdAt) ?? undefined,
      }))
    }
    return []
  }, [
    kind,
    openrouterModels.data,
    geminiModels.data,
    localModels.data,
    openaiModels.data,
    anthropicModels.data,
  ])

  // ────────── Save / test ──────────
  const valid = name.trim().length > 0 && modelName.trim().length > 0

  const save = async () => {
    if (!valid) return
    setSaving(true)
    try {
      const payload = {
        name: name.trim(),
        provider: meta.dbProvider,
        modelName: modelName.trim(),
        apiUrl: apiUrl.trim() || null,
        apiKey: apiKey.trim() || null,
      }
      let savedId: number
      if (initial) {
        await api.providerProfileUpdate({ id: initial.id, ...payload })
        savedId = initial.id
      } else {
        const saved = await api.providerProfileAdd(payload)
        savedId = saved.id
      }
      // Auto-apply the just-saved profile to the live preferences
      // store. Without this, a fresh "Add" leaves cloudApiKey empty
      // and the next translate fails with "Cloud API Key is missing".
      // Skip the keyring round-trip — we already have the plaintext key
      // in this modal's state.
      const prefs = usePreferencesStore.getState()
      prefs.setCloudProvider(meta.dbProvider as any)
      prefs.setCloudModelName(payload.modelName)
      prefs.setActiveProfileId(savedId)
      if (payload.apiUrl) prefs.setCloudApiUrl(payload.apiUrl)
      if (payload.apiKey) prefs.setCloudApiKey(payload.apiKey)
      onSaved()
    } catch (err: any) {
      alert(err?.message ?? String(err))
    } finally {
      setSaving(false)
    }
  }

  const runTest = async () => {
    setTestStatus({ kind: 'pending' })
    const r = await testCloudConnection({
      provider: meta.dbProvider,
      apiKey,
      apiUrl: apiUrl || meta.defaultBaseUrl || 'https://api.openai.com/v1',
      model: modelName,
    })
    setTestStatus(
      r.ok
        ? { kind: 'ok', ms: r.durationMs }
        : { kind: 'err', msg: r.error.slice(0, 200) },
    )
  }

  // ────────── Render ──────────
  const showApiKey = kind !== 'local'
  const showBaseUrl = kind === 'openai' || kind === 'local'
  const useSearchableModel = meta.hasModelList

  const modelLoading =
    (kind === 'openrouter' && openrouterModels.isLoading) ||
    (kind === 'gemini' && geminiModels.isLoading) ||
    (kind === 'local' && localModels.isLoading) ||
    (kind === 'openai' && openaiModels.isLoading) ||
    (kind === 'anthropic' && anthropicModels.isLoading)
  const modelError =
    (kind === 'openrouter' && openrouterModels.error) ||
    (kind === 'gemini' && geminiModels.error) ||
    (kind === 'local' && localModels.error) ||
    (kind === 'openai' && openaiModels.error) ||
    (kind === 'anthropic' && anthropicModels.error)
  const modelDisabled =
    (kind === 'gemini' && !apiKey) ||
    (kind === 'openai' && !apiKey) ||
    (kind === 'anthropic' && !apiKey) ||
    (kind === 'local' && !apiUrl)

  return (
    <div className='bg-background/80 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm'>
      <div className='bg-card border-border w-[26rem] max-w-[95vw] overflow-hidden rounded-lg border p-4 shadow-lg'>
        <h3 className='text-foreground mb-3 text-sm font-bold'>
          {initial ? `Edit "${initial.name}"` : 'Add LLM profile'}
        </h3>

        {/* Provider tiles */}
        <div className='mb-3 grid grid-cols-5 gap-1'>
          {KINDS.map((k) => (
            <button
              key={k.kind}
              onClick={() => switchKind(k.kind)}
              className={
                'flex flex-col items-center justify-center gap-1 rounded-md border px-1 py-2 text-[10px] transition ' +
                (kind === k.kind
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border bg-card text-muted-foreground hover:bg-accent/40')
              }
              title={k.hint}
            >
              <span className='font-semibold'>{k.label}</span>
            </button>
          ))}
        </div>

        <div className='space-y-2'>
          <div>
            <label className='text-muted-foreground mb-1 block text-[10px] font-semibold'>
              Profile name
            </label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='e.g. Gemini work, OpenRouter free, …'
              className='h-8 text-xs'
            />
          </div>

          {showBaseUrl && (
            <div>
              <label className='text-muted-foreground mb-1 block text-[10px] font-semibold'>
                {kind === 'local' ? 'Local server URL' : 'Base URL'}
              </label>
              <Input
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder={meta.defaultBaseUrl}
                className='h-8 text-xs'
              />
              {kind === 'local' && (
                <p className='text-muted-foreground mt-0.5 text-[10px]'>
                  Ollama: <code>http://localhost:11434/v1</code> · LM Studio:{' '}
                  <code>http://localhost:1234/v1</code>
                </p>
              )}
            </div>
          )}

          {showApiKey && (
            <div>
              <label className='text-muted-foreground mb-1 block text-[10px] font-semibold'>
                API key{' '}
                <span className='text-muted-foreground/70 font-normal'>
                  · stored in OS keyring
                </span>
              </label>
              <Input
                type='password'
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value)
                  // Once user types, status no longer matters — they're
                  // entering a fresh key.
                  if (apiKeyStatus !== 'fresh' && apiKeyStatus !== 'loaded') {
                    setApiKeyStatus('loaded')
                  }
                }}
                placeholder={
                  kind === 'openrouter'
                    ? 'sk-or-… (optional for browsing)'
                    : apiKeyStatus === 'keyring-miss' ||
                        apiKeyStatus === 'keyring-error'
                      ? 'Re-enter your API key'
                      : 'sk-…'
                }
                className='h-8 text-xs'
              />
              {initial && apiKeyLoaded && (
                <p
                  className={
                    'mt-1 text-[10px] ' +
                    (apiKeyStatus === 'loaded'
                      ? 'text-muted-foreground/70'
                      : 'text-amber-600 dark:text-amber-400')
                  }
                >
                  {apiKeyStatus === 'loaded' &&
                    'Loaded from OS keyring. Leave as-is to keep the saved key, or type a new one to replace it.'}
                  {apiKeyStatus === 'never-stored' &&
                    'No key has been stored for this profile yet — enter one to enable cloud calls.'}
                  {apiKeyStatus === 'keyring-miss' &&
                    'Saved keyring entry could not be read (entry missing or wiped externally). Re-enter to repair — saving with this field blank will NOT erase the keyring.'}
                  {apiKeyStatus === 'keyring-error' &&
                    'Could not access OS keyring (permission denied?). Re-enter the key to retry. Save with blank field to leave keyring untouched.'}
                </p>
              )}
            </div>
          )}

          <div>
            <label className='text-muted-foreground mb-1 block text-[10px] font-semibold'>
              Model
              {modelLoading && (
                <Loader2Icon className='ml-1 inline size-3 animate-spin' />
              )}
            </label>
            {useSearchableModel ? (
              <>
                <SearchableSelect
                  value={modelName}
                  onValueChange={setModelName}
                  options={modelOptions}
                  placeholder={
                    modelDisabled
                      ? kind === 'local'
                        ? 'Enter server URL to load models'
                        : 'Enter API key to load models'
                      : modelLoading
                        ? 'Loading models…'
                        : 'Search and pick a model'
                  }
                  searchPlaceholder='Search by id or name'
                  loading={modelLoading}
                  emptyMessage={
                    modelError
                      ? `Failed to load: ${(modelError as Error)?.message?.slice(0, 100) ?? 'unknown'}`
                      : 'No models match'
                  }
                  disabled={modelDisabled}
                  clearable
                />
                {kind === 'local' && (
                  <p className='text-muted-foreground mt-0.5 text-[10px]'>
                    Lists models installed on the local server.
                  </p>
                )}
              </>
            ) : (
              <Input
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                placeholder={meta.suggestedModel}
                className='h-8 text-xs'
              />
            )}
          </div>
        </div>

        <div className='mt-3 flex items-center justify-between gap-2'>
          <div className='flex items-center gap-2'>
            <Button
              variant='outline'
              size='sm'
              className='h-7 text-[10px]'
              disabled={
                !modelName ||
                (showApiKey && !apiKey && kind !== 'openrouter') ||
                testStatus.kind === 'pending'
              }
              onClick={() => void runTest()}
            >
              {testStatus.kind === 'pending' ? (
                <Loader2Icon className='size-3 animate-spin' />
              ) : (
                <ZapIcon className='size-3' />
              )}
              Test
            </Button>
            {testStatus.kind === 'ok' && (
              <span className='flex items-center gap-1 text-[10px] text-emerald-600'>
                <CheckIcon className='size-3' /> {testStatus.ms} ms
              </span>
            )}
            {testStatus.kind === 'err' && (
              <span
                className='text-destructive flex items-center gap-1 text-[10px]'
                title={testStatus.msg}
              >
                <XIcon className='size-3' /> {testStatus.msg.slice(0, 40)}
              </span>
            )}
          </div>
          <div className='flex gap-2'>
            <Button
              variant='ghost'
              size='sm'
              className='h-7 text-[10px]'
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              variant='default'
              size='sm'
              className='h-7 text-[10px]'
              disabled={!valid || saving}
              onClick={() => void save()}
            >
              {saving && <Loader2Icon className='size-3 animate-spin' />}
              {initial ? 'Save' : 'Add'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
