'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertCircleIcon,
  CheckIcon,
  KeyRoundIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  StarIcon,
  Trash2Icon,
  XIcon,
  ZapIcon,
  ArrowUpIcon,
  ArrowDownIcon,
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
  KINDS,
  KIND_LABEL,
  canLoadModels,
  effectiveDbProvider,
  kindOf,
  type ProviderKind,
} from '@/lib/services/profileHelpers'
import {
  fetchOpenRouterModels,
  formatPricePerMillion,
  formatContextLength,
} from '@/lib/services/openrouterModels'
import {
  fetchGeminiModels,
  formatTokenLimit,
} from '@/lib/services/geminiModels'
import { fetchLocalModels, formatModelSize } from '@/lib/services/ollamaModels'
import {
  fetchOpenAiModels,
  isLikelyChatModel,
} from '@/lib/services/openaiModels'
import {
  fetchAnthropicModels,
  formatAnthropicCreatedAt,
} from '@/lib/services/anthropicModels'

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
    { mode: 'add' } | { mode: 'edit'; profile: ProviderProfileDto } | null
  >(null)
  const refresh = async () => {
    await profiles.refetch()
  }
  const setPrefs = usePreferencesStore.getState()

  const llmFailoverEnabled = usePreferencesStore((s) => s.llmFailoverEnabled)
  const setLlmFailoverEnabled = usePreferencesStore(
    (s) => s.setLlmFailoverEnabled,
  )
  const llmFailoverPriority = usePreferencesStore((s) => s.llmFailoverPriority)
  const setLlmFailoverPriority = usePreferencesStore(
    (s) => s.setLlmFailoverPriority,
  )

  const sortedList = useMemo(() => {
    const listCopy = [...list]
    return listCopy.sort((a, b) => {
      let idxA = llmFailoverPriority.indexOf(a.id)
      let idxB = llmFailoverPriority.indexOf(b.id)
      if (idxA === -1) idxA = 9999
      if (idxB === -1) idxB = 9999
      return idxA - idxB
    })
  }, [list, llmFailoverPriority])

  const moveProfile = (id: number, direction: 'up' | 'down') => {
    const currentOrder = sortedList.map((p) => p.id)
    const idx = currentOrder.indexOf(id)
    if (idx === -1) return
    const nextIdx = direction === 'up' ? idx - 1 : idx + 1
    if (nextIdx < 0 || nextIdx >= currentOrder.length) return
    const temp = currentOrder[idx]
    currentOrder[idx] = currentOrder[nextIdx]
    currentOrder[nextIdx] = temp
    setLlmFailoverPriority(currentOrder)
  }

  // Subscribe so the row's "Active" badge re-renders when the active
  // LLM changes via the toolbar dropdown.
  const activeProvider = usePreferencesStore((s) => s.cloudProvider)
  const activeModel = usePreferencesStore((s) => s.cloudModelName)

  const apply = async (p: ProviderProfileDto) => {
    // Use the dbProvider routed by kindOf so legacy mis-stored
    // OpenRouter profiles (saved as 'openai' before v1.0.0) hit the
    // correct dispatcher in cloudLlm.ts / cloudOcr.ts.
    setPrefs.setCloudProvider(effectiveDbProvider(p) as any)
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
    await refresh()
  }
  const remove = async (p: ProviderProfileDto) => {
    if (!confirm(`Delete "${p.name}"?`)) return
    await api.providerProfileRemove(p.id)
    await refresh()
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

      {list.length > 1 && (
        <div className='bg-muted/30 border-border flex shrink-0 flex-col gap-1.5 border-b px-3 py-2 text-xs'>
          <div className='flex items-center justify-between'>
            <span className='text-foreground flex items-center gap-1 font-semibold'>
              <ZapIcon className='size-3 fill-amber-500/10 text-amber-500' />
              Auto Switch Failover
            </span>
            <div className='flex items-center gap-2'>
              <button
                type='button'
                role='switch'
                aria-checked={llmFailoverEnabled}
                onClick={() => setLlmFailoverEnabled(!llmFailoverEnabled)}
                className={[
                  'focus-visible:ring-ring relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border border-transparent transition-colors focus-visible:ring-2 focus-visible:outline-none',
                  llmFailoverEnabled ? 'bg-amber-500' : 'bg-input',
                ].join(' ')}
              >
                <span
                  className={[
                    'bg-background pointer-events-none inline-block size-3 rounded-full shadow-lg ring-0 transition-transform',
                    llmFailoverEnabled ? 'translate-x-3' : 'translate-x-0',
                  ].join(' ')}
                />
              </button>
            </div>
          </div>
          <p className='text-muted-foreground text-[10px] leading-relaxed'>
            {llmFailoverEnabled
              ? 'ยินยอม: แปลต่ออัตโนมัติหากติดขัด/เครดิตหมด โดยสลับไปโปรไฟล์สำรองตามลำดับตัวเลขด้านล่าง'
              : 'ปิดการสลับโปรไฟล์อัตโนมัติ (แนะนำเพื่อการควบคุมค่าใช้จ่าย)'}
          </p>
        </div>
      )}
      <ScrollArea className='min-h-0 min-w-0 flex-1'>
        <div className='w-full min-w-0 space-y-1 p-2'>
          {profiles.isLoading ? (
            <p className='text-muted-foreground flex items-center justify-center gap-1.5 p-3 text-xs'>
              <Loader2Icon className='size-3 animate-spin' />
              Loading profiles…
            </p>
          ) : !list.length ? (
            <div className='border-border rounded-md border border-dashed p-3 text-center text-xs'>
              <KeyRoundIcon className='text-muted-foreground/40 mx-auto mb-2 size-6' />
              <p className='text-foreground mb-1 text-xs font-semibold'>
                No LLM profile yet
              </p>
              <p className='text-muted-foreground mb-3 text-[10px] leading-relaxed'>
                Profiles store your cloud LLM credentials so you can switch
                between OpenAI / Claude / Gemini / OpenRouter (or a local Ollama
                / LM Studio server) per project.
                <br />
                <br />
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
            sortedList.map((p) => {
              // Effective provider routes legacy openrouter-as-openai
              // through the right code path so the Active badge lights
              // up correctly on those rows too.
              const isActive =
                effectiveDbProvider(p) === activeProvider &&
                p.modelName === activeModel
              const priorityIndex = sortedList.findIndex((x) => x.id === p.id)
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
                    {/* แสดงลำดับความสำคัญเมื่อเปิด Failover */}
                    {llmFailoverEnabled && sortedList.length > 1 && (
                      <div className='border-border/60 mr-0.5 flex shrink-0 flex-col items-center gap-0.5 border-r pr-1.5'>
                        <span className='text-[10px] font-bold text-amber-500'>
                          #{priorityIndex + 1}
                        </span>
                        <div className='flex flex-col gap-0.5'>
                          <button
                            onClick={() => moveProfile(p.id, 'up')}
                            disabled={priorityIndex === 0}
                            className='text-muted-foreground hover:text-foreground transition disabled:opacity-20'
                            title='เลื่อนขึ้น'
                          >
                            <ArrowUpIcon className='size-2.5' />
                          </button>
                          <button
                            onClick={() => moveProfile(p.id, 'down')}
                            disabled={priorityIndex === sortedList.length - 1}
                            className='text-muted-foreground hover:text-foreground transition disabled:opacity-20'
                            title='เลื่อนลง'
                          >
                            <ArrowDownIcon className='size-2.5' />
                          </button>
                        </div>
                      </div>
                    )}

                    <button
                      onClick={() => void toggleDefault(p)}
                      className='shrink-0 pt-0.5 hover:text-amber-500'
                      title={
                        p.isDefault
                          ? 'Unmark as default'
                          : 'Mark as default (auto-loaded on project open)'
                      }
                    >
                      <StarIcon
                        className={
                          p.isDefault
                            ? 'size-3 fill-amber-400 text-amber-400'
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
                          ? 'bg-rose-400 text-white hover:bg-rose-400/90'
                          : '')
                      }
                      onClick={() => void apply(p)}
                      title={
                        isActive
                          ? 'Active — click to re-pull the API key from the OS keyring (use after editing the key externally)'
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
          existingProfiles={list}
          onSaved={async () => {
            await refresh()
            setEditing(null)
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
  existingProfiles,
}: {
  initial: ProviderProfileDto | null
  onClose: () => void
  onSaved: () => Promise<void> | void
  existingProfiles: ProviderProfileDto[]
}) {
  const initialKind = initial ? kindOf(initial) : 'openai'
  const initialMeta = KINDS.find((k) => k.kind === initialKind)!

  const [kind, setKind] = useState<ProviderKind>(initialKind)
  const [name, setName] = useState(initial?.name ?? '')
  const [apiKey, setApiKey] = useState('')
  const [apiKeyLoaded, setApiKeyLoaded] = useState(!initial)
  /** Tracks why the apiKey field is empty when editing. Distinguishes
   *  "no key was ever stored" vs "key is in keyring but fetch failed"
   *  so the UI can tell the user whether they need to re-enter.
   *  Initialised to 'fresh' for both Add and Edit; the keyring-load
   *  effect upgrades to 'loaded' / 'never-stored' / 'keyring-*' once
   *  it resolves. Previously initialised to 'loaded' on edit, which
   *  caused a flash of "Loaded from keyring" while models were
   *  still disabled. */
  const [apiKeyStatus, setApiKeyStatus] = useState<
    'fresh' | 'loaded' | 'never-stored' | 'keyring-miss' | 'keyring-error'
  >('fresh')
  const [apiUrl, setApiUrl] = useState(
    initial?.apiUrl ?? initialMeta.defaultBaseUrl,
  )
  const [modelName, setModelName] = useState(initial?.modelName ?? '')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [testStatus, setTestStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'ok'; ms: number }
    | { kind: 'err'; msg: string }
  >({ kind: 'idle' })
  /** Bumps every time the user wants to re-fetch the keyring entry
   *  (Retry button on a keyring-error). Triggers the useEffect below. */
  const [keyringFetchSeq, setKeyringFetchSeq] = useState(0)

  // Esc-to-close + focus trap (basic: focus stays on first input on
  // mount; not full WAI-ARIA dialog, but enough that keyboard users
  // aren't stuck).
  const firstFieldRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    firstFieldRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Load existing API key from keyring when editing. Re-runs when
  // keyringFetchSeq bumps (Retry button).
  useEffect(() => {
    if (!initial) {
      setApiKeyLoaded(true)
      setApiKeyStatus('fresh')
      return
    }
    let cancelled = false
    setApiKeyLoaded(false)
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
        const { apiKey: existing } = await api.providerProfileSecretGet(
          initial.id,
        )
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
  }, [initial, keyringFetchSeq])

  const meta = KINDS.find((k) => k.kind === kind)!

  const switchKind = (next: ProviderKind) => {
    const nextMeta = KINDS.find((k) => k.kind === next)!
    setKind(next)
    setApiUrl(nextMeta.defaultBaseUrl)
    setModelName(nextMeta.suggestedModel)
    setTestStatus({ kind: 'idle' })
    setFormError(null)
    if (!name.trim()) setName(nextMeta.label)
  }

  // Debounce `apiUrl` for the local-models query so typing into the
  // URL field doesn't fire a fetch per keystroke (and to close the
  // small race window where the model list comes back from a half-
  // typed URL).
  const [debouncedApiUrl, setDebouncedApiUrl] = useState(apiUrl)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedApiUrl(apiUrl), 300)
    return () => clearTimeout(t)
  }, [apiUrl])

  // ────────── Model list queries (only one fires at a time) ──────────
  const enabledForKind = (k: ProviderKind) =>
    kind === k &&
    canLoadModels({ kind, apiKey, apiUrl: debouncedApiUrl, apiKeyLoaded })

  const openrouterModels = useQuery({
    queryKey: ['profile-modal', 'openrouter-models', apiKey],
    queryFn: () => fetchOpenRouterModels(apiKey || undefined),
    enabled: enabledForKind('openrouter'),
    staleTime: 10 * 60 * 1000,
    retry: 1,
  })

  const geminiModels = useQuery({
    queryKey: ['profile-modal', 'gemini-models', apiKey],
    queryFn: () => fetchGeminiModels(apiKey),
    enabled: enabledForKind('gemini'),
    staleTime: 10 * 60 * 1000,
    retry: 1,
  })

  const localModels = useQuery({
    queryKey: ['profile-modal', 'local-models', debouncedApiUrl],
    queryFn: () => fetchLocalModels(debouncedApiUrl),
    enabled: enabledForKind('local'),
    staleTime: 30 * 1000,
    retry: 0,
  })

  const openaiModels = useQuery({
    queryKey: ['profile-modal', 'openai-models', apiKey, debouncedApiUrl],
    queryFn: () => fetchOpenAiModels(apiKey, debouncedApiUrl),
    enabled: enabledForKind('openai'),
    staleTime: 10 * 60 * 1000,
    retry: 1,
  })

  const anthropicModels = useQuery({
    queryKey: ['profile-modal', 'anthropic-models', apiKey],
    queryFn: () => fetchAnthropicModels(apiKey),
    enabled: enabledForKind('anthropic'),
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
          trailing: m.ownedBy && m.ownedBy !== 'system' ? m.ownedBy : undefined,
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
  const trimmedName = name.trim()
  const trimmedNameLower = trimmedName.toLowerCase()
  const duplicate = useMemo(
    () =>
      existingProfiles.find(
        (p) => p.name.trim().toLowerCase() === trimmedNameLower,
      ),
    [existingProfiles, trimmedNameLower],
  )
  // Block rename-into-existing immediately so the Save button reflects
  // the error state without waiting for click-then-alert.
  const renameCollision =
    !!initial && !!duplicate && duplicate.id !== initial.id
  const valid =
    trimmedName.length > 0 && modelName.trim().length > 0 && !renameCollision

  const save = async () => {
    if (!valid) return
    setFormError(null)

    const payload = {
      name: trimmedName,
      provider: meta.dbProvider,
      modelName: modelName.trim(),
      apiUrl: apiUrl.trim() || null,
      apiKey: apiKey.trim() || null,
    }

    // Overwrite path: Add (no `initial`) collides with an existing
    // name → ask whether to merge into that row instead of creating
    // a second one. Edit path doesn't ask (renameCollision blocks the
    // button outright; the user has to pick a unique name first).
    if (!initial && duplicate) {
      const confirmOverwrite = confirm(
        `พบโปรไฟล์ชื่อ "${trimmedName}" อยู่แล้วในระบบ\nคุณต้องการบันทึกเขียนทับ (Overwrite) ข้อมูลของโปรไฟล์เดิมด้วยค่าใหม่นี้ใช่หรือไม่?\n\nA profile named "${trimmedName}" already exists. Overwrite it with these new values?`,
      )
      if (!confirmOverwrite) return
      setSaving(true)
      try {
        const updated = await api.providerProfileUpdate({
          id: duplicate.id,
          ...payload,
        })
        // TOCTOU guard: profile may have been deleted from another
        // tab / by an external write between the list fetch and our
        // update. `updated == null` is how the backend signals
        // "no row matched".
        if (!updated) {
          setFormError(
            'ไม่สามารถเขียนทับได้: โปรไฟล์เป้าหมายอาจถูกลบไปแล้ว — ปิดและเปิด modal อีกครั้งเพื่อ refresh.\n\nOverwrite target no longer exists. Close and reopen this dialog to refresh.',
          )
          setSaving(false)
          return
        }
        const prefs = usePreferencesStore.getState()
        prefs.setCloudProvider(meta.dbProvider as any)
        prefs.setCloudModelName(payload.modelName)
        prefs.setActiveProfileId(duplicate.id)
        if (payload.apiUrl) prefs.setCloudApiUrl(payload.apiUrl)
        if (payload.apiKey) prefs.setCloudApiKey(payload.apiKey)
        await onSaved()
        return
      } catch (err: any) {
        setFormError(err?.message ?? String(err))
        setSaving(false)
        return
      }
    }

    setSaving(true)
    try {
      let savedId: number
      if (initial) {
        const updated = await api.providerProfileUpdate({
          id: initial.id,
          ...payload,
        })
        if (!updated) {
          setFormError(
            'ไม่สามารถอัปเดตได้: โปรไฟล์อาจถูกลบไปแล้ว.\n\nUpdate failed: this profile may have been deleted from another tab.',
          )
          setSaving(false)
          return
        }
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
      await onSaved()
    } catch (err: any) {
      setFormError(err?.message ?? String(err))
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
  // Disabled iff the model list would not currently fetch — keeps the
  // SearchableSelect's disabled state in lockstep with the query's
  // `enabled` flag. canLoadModels returns true when fetching is
  // possible; flip for disabled.
  const modelDisabled = !canLoadModels({
    kind,
    apiKey,
    apiUrl: debouncedApiUrl,
    apiKeyLoaded,
  })

  return (
    <div
      className='bg-background/80 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm'
      onClick={(e) => {
        // Click outside the dialog body = dismiss. Buttons inside
        // stopPropagation by default at this level.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className='bg-card border-border w-[26rem] max-w-[95vw] overflow-hidden rounded-lg border p-4 shadow-lg'
        role='dialog'
        aria-modal='true'
      >
        <h3 className='text-foreground mb-3 text-sm font-bold'>
          {initial ? `Edit "${initial.name}" ` : 'Add LLM profile'}
          {initial && (
            <span className='text-muted-foreground/60 font-mono text-[10px] font-normal'>
              · id {initial.id}
            </span>
          )}
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
              ref={firstFieldRef}
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && valid && !saving) void save()
              }}
              placeholder='e.g. Gemini work, OpenRouter free, …'
              className={
                'h-8 text-xs ' + (renameCollision ? 'border-amber-500/60' : '')
              }
            />
            {renameCollision && (
              <p className='mt-1 text-[10px] text-amber-600 dark:text-amber-400'>
                Another profile already uses this name. Pick a different name to
                continue.
              </p>
            )}
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
              <div className='flex gap-1'>
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
                  className='h-8 flex-1 text-xs'
                />
                {/* Retry button surfaces when keyring fetch failed so the
                    user can try again without closing the dialog (e.g.
                    after granting keyring access in OS prefs). */}
                {initial &&
                  (apiKeyStatus === 'keyring-error' ||
                    apiKeyStatus === 'keyring-miss') && (
                    <Button
                      type='button'
                      variant='outline'
                      size='xs'
                      className='h-8 shrink-0 px-2'
                      title='Retry reading from OS keyring'
                      onClick={() => setKeyringFetchSeq((s) => s + 1)}
                    >
                      <RefreshCwIcon
                        className={
                          'size-3 ' + (!apiKeyLoaded ? 'animate-spin' : '')
                        }
                      />
                    </Button>
                  )}
              </div>
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
                    'Saved keyring entry could not be read (entry missing or wiped externally). Re-enter to repair, or click Retry. Saving with this field blank will NOT erase the keyring.'}
                  {apiKeyStatus === 'keyring-error' &&
                    'Could not access OS keyring (permission denied?). Click Retry, or re-enter the key. Saving with blank field leaves the keyring untouched.'}
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

        {/* Inline error banner — replaces blocking alert() for save
            failures. Auto-clears when the user changes any field
            (next save attempt re-runs and re-sets if still bad). */}
        {formError && (
          <div className='border-destructive/40 bg-destructive/10 text-destructive mt-3 flex items-start gap-2 rounded-md border p-2 text-[10px]'>
            <AlertCircleIcon className='mt-0.5 size-3 shrink-0' />
            <span className='whitespace-pre-line'>{formError}</span>
          </div>
        )}

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
              title={
                renameCollision
                  ? 'Pick a unique name first'
                  : !trimmedName
                    ? 'Profile name required'
                    : !modelName.trim()
                      ? 'Pick a model first'
                      : undefined
              }
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
