'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeftIcon, PlusIcon, StarIcon, Trash2Icon } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, type ProviderProfileDto } from '@/lib/api'
import { useProjectStore } from '@/lib/stores/projectStore'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import { testCloudConnection } from '@/lib/services/cloudLlm'
import { PROVIDER_PRESETS } from '@/lib/services/providerPresets'
import { CheckIcon, KeyRoundIcon, Loader2Icon, XIcon, ZapIcon } from 'lucide-react'
import { EmptyHint } from '@/components/project/EmptyHint'

const PROVIDER_OPTIONS = [
  { value: 'openai', label: 'OpenAI (or compatible)' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'anthropic', label: 'Anthropic Claude' },
]

export default function ProfilesPage() {
  const info = useProjectStore((s) => s.info)
  const profiles = useQuery({
    queryKey: ['project', 'profiles'],
    queryFn: () => api.providerProfilesList(),
    enabled: !!info,
  })
  const refresh = () => void profiles.refetch()
  const setPrefs = usePreferencesStore.getState()

  if (!info) {
    return (
      <ScrollArea className='flex-1'>
        <div className='mx-auto max-w-3xl p-6'>
          <p className='text-muted-foreground text-sm'>
            No project is open.{' '}
            <Link href='/project' className='underline'>
              Go to dashboard
            </Link>
          </p>
        </div>
      </ScrollArea>
    )
  }

  const applyProfile = async (p: ProviderProfileDto) => {
    // Copy this profile's wire-config into the live preferences store
    // so the next cloud call uses it. The key comes from the OS keyring
    // via the secret_get RPC -- never persisted plaintext in the DB.
    setPrefs.setCloudProvider(p.provider as any)
    setPrefs.setCloudModelName(p.modelName)
    if (p.apiUrl) setPrefs.setCloudApiUrl(p.apiUrl)
    try {
      const { apiKey } = await api.providerProfileSecretGet(p.id)
      if (apiKey) setPrefs.setCloudApiKey(apiKey)
    } catch (err) {
      console.warn('[profiles] secret fetch failed', err)
    }
  }

  const setDefault = async (p: ProviderProfileDto) => {
    await api.providerProfileUpdate({ id: p.id, isDefault: true })
    refresh()
  }

  const remove = async (p: ProviderProfileDto) => {
    if (!confirm(`Delete profile "${p.name}"?`)) return
    await api.providerProfileRemove(p.id)
    refresh()
  }

  return (
    <ScrollArea className='flex-1'>
      <div className='px-4 py-6'>
        <div className='relative mx-auto max-w-3xl'>
          <div className='mb-6 flex items-center'>
            <Link
              href='/project'
              prefetch={false}
              className='text-muted-foreground hover:bg-accent hover:text-foreground absolute -left-14 flex size-10 items-center justify-center rounded-full transition'
            >
              <ChevronLeftIcon className='size-6' />
            </Link>
            <h1 className='text-foreground flex-1 text-2xl font-bold'>
              Provider profiles
            </h1>
            <AddProfileButton onAdded={refresh} />
          </div>

          <p className='text-muted-foreground mb-4 text-sm'>
            Save multiple cloud LLM configurations (personal vs free tier,
            different models, etc.) and apply one to the live Settings with
            a single click.
          </p>

          <div className='bg-card border-border overflow-hidden rounded-lg border'>
            {profiles.isLoading ? (
              <div className='text-muted-foreground p-6 text-center text-sm'>
                Loading…
              </div>
            ) : !profiles.data?.length ? (
              <div className='p-2'>
                <EmptyHint
                  icon={KeyRoundIcon}
                  title='No saved profiles yet'
                  description='Profiles store multiple cloud LLM setups so you can switch between (e.g.) GPT-4o for dialogue and a free Groq Llama for SFX with one click.'
                  steps={[
                    'Click "Add profile" and pick a quick-preset (OpenAI, OpenRouter, Groq, Together, DeepSeek, Mistral, xAI, Ollama, …).',
                    'API keys are stored in the OS keyring, never in plaintext on disk.',
                    'On the QA review page, every translate button has a profile picker so you can route specific blocks to specific models.',
                  ]}
                />
              </div>
            ) : (
              <ul>
                {profiles.data.map((p) => (
                  <li
                    key={p.id}
                    className='border-border flex items-center gap-3 border-b px-4 py-3 last:border-b-0'
                  >
                    <button
                      onClick={() => void setDefault(p)}
                      title='Mark as default'
                      className='hover:text-amber-500'
                    >
                      <StarIcon
                        className={
                          'size-4 ' +
                          (p.isDefault
                            ? 'fill-amber-400 text-amber-400'
                            : 'text-muted-foreground')
                        }
                      />
                    </button>
                    <div className='min-w-0 flex-1'>
                      <div className='text-sm font-semibold'>{p.name}</div>
                      <div className='text-muted-foreground text-xs'>
                        {p.provider} · {p.modelName}
                        {p.apiUrl && <span> · {p.apiUrl}</span>}
                      </div>
                    </div>
                    <Button
                      variant='outline'
                      size='sm'
                      onClick={() => void applyProfile(p)}
                    >
                      Apply
                    </Button>
                    <Button
                      variant='ghost'
                      size='sm'
                      onClick={() => void remove(p)}
                    >
                      <Trash2Icon className='size-3.5' />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </ScrollArea>
  )
}

function AddProfileButton({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState({
    name: '',
    provider: 'openai',
    modelName: 'gpt-4o',
    apiUrl: '',
    apiKey: '',
    isDefault: false,
  })
  const [testStatus, setTestStatus] = useState<
    { kind: 'idle' } | { kind: 'pending' } | { kind: 'ok'; ms: number } | { kind: 'err'; msg: string }
  >({ kind: 'idle' })

  const runTest = async () => {
    setTestStatus({ kind: 'pending' })
    const r = await testCloudConnection({
      provider: draft.provider,
      apiKey: draft.apiKey,
      apiUrl: draft.apiUrl || 'https://api.openai.com/v1',
      model: draft.modelName,
    })
    setTestStatus(
      r.ok
        ? { kind: 'ok', ms: r.durationMs }
        : { kind: 'err', msg: r.error.slice(0, 200) },
    )
  }

  const applyPreset = (presetId: string) => {
    const p = PROVIDER_PRESETS.find((x) => x.id === presetId)
    if (!p) return
    setDraft((d) => ({
      ...d,
      provider: p.provider,
      apiUrl: p.baseUrl || d.apiUrl,
      modelName: p.defaultModel || d.modelName,
      name: d.name || p.label,
    }))
    setTestStatus({ kind: 'idle' })
  }

  const submit = async () => {
    if (!draft.name.trim() || !draft.modelName.trim()) return
    await api.providerProfileAdd({
      name: draft.name.trim(),
      provider: draft.provider,
      modelName: draft.modelName.trim(),
      apiUrl: draft.apiUrl.trim() || null,
      apiKey: draft.apiKey.trim() || null,
      isDefault: draft.isDefault,
    })
    setOpen(false)
    setDraft({
      name: '',
      provider: 'openai',
      modelName: 'gpt-4o',
      apiUrl: '',
      apiKey: '',
      isDefault: false,
    })
    onAdded()
  }

  return (
    <>
      <Button variant='default' size='sm' onClick={() => setOpen(true)}>
        <PlusIcon className='size-3.5' />
        Add profile
      </Button>
      {open && (
        <div className='bg-background/80 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm'>
          <div className='bg-card border-border w-96 rounded-lg border p-5 shadow-lg'>
            <h3 className='text-foreground mb-3 text-sm font-bold'>
              Add provider profile
            </h3>
            <div className='space-y-3'>
              <Select value='' onValueChange={applyPreset}>
                <SelectTrigger className='w-full'>
                  <SelectValue placeholder='Quick preset — auto-fills fields below' />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_PRESETS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                      {p.hint && (
                        <span className='text-muted-foreground ml-1 text-[10px]'>
                          · {p.hint}
                        </span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                autoFocus
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder='Profile name (e.g. "OpenRouter free")'
                className='text-sm'
              />
              <Select
                value={draft.provider}
                onValueChange={(v) => setDraft((d) => ({ ...d, provider: v }))}
              >
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_OPTIONS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={draft.modelName}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, modelName: e.target.value }))
                }
                placeholder='Model name'
                className='text-sm'
              />
              <Input
                value={draft.apiUrl}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, apiUrl: e.target.value }))
                }
                placeholder='Base URL (optional)'
                className='text-sm'
              />
              <Input
                value={draft.apiKey}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, apiKey: e.target.value }))
                }
                placeholder='API key — stored in the OS keyring, not in the project DB'
                type='password'
                className='text-sm'
              />
              <div className='flex items-center gap-2 text-xs'>
                <input
                  type='checkbox'
                  id='profile-default'
                  checked={draft.isDefault}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, isDefault: e.target.checked }))
                  }
                />
                <label htmlFor='profile-default'>Mark as default profile</label>
              </div>
            </div>
            <div className='mt-4 flex items-center justify-between gap-2'>
              <div className='flex items-center gap-2'>
                <Button
                  variant='outline'
                  size='sm'
                  disabled={
                    !draft.apiKey ||
                    !draft.modelName ||
                    testStatus.kind === 'pending'
                  }
                  onClick={() => void runTest()}
                >
                  {testStatus.kind === 'pending' ? (
                    <Loader2Icon className='size-3.5 animate-spin' />
                  ) : (
                    <ZapIcon className='size-3.5' />
                  )}
                  Test
                </Button>
                {testStatus.kind === 'ok' && (
                  <span className='flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400'>
                    <CheckIcon className='size-3' /> {testStatus.ms} ms
                  </span>
                )}
                {testStatus.kind === 'err' && (
                  <span
                    className='flex items-start gap-1 text-[10px] text-rose-600 dark:text-rose-400'
                    title={testStatus.msg}
                  >
                    <XIcon className='size-3 shrink-0' />
                    {testStatus.msg.slice(0, 40)}
                  </span>
                )}
              </div>
              <div className='flex gap-2'>
                <Button variant='ghost' size='sm' onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant='default'
                  size='sm'
                  disabled={!draft.name.trim() || !draft.modelName.trim()}
                  onClick={() => void submit()}
                >
                  Save
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
