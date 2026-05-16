'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  CheckIcon,
  KeyRoundIcon,
  Loader2Icon,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, type ProviderProfileDto } from '@/lib/api'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import { testCloudConnection } from '@/lib/services/cloudLlm'
import { PROVIDER_PRESETS } from '@/lib/services/providerPresets'

const PROVIDER_LABEL: Record<string, string> = {
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  gemini: 'Gemini',
  anthropic: 'Anthropic',
}

export function ProfilesTabPanel() {
  const profiles = useQuery({
    queryKey: ['project', 'profiles'],
    queryFn: () => api.providerProfilesList(),
  })
  const list = profiles.data ?? []
  const [adding, setAdding] = useState(false)
  const refresh = () => void profiles.refetch()
  const setPrefs = usePreferencesStore.getState()

  const apply = async (p: ProviderProfileDto) => {
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
          onClick={() => setAdding(true)}
        >
          <PlusIcon className='size-3.5' />
        </Button>
      </div>
      <ScrollArea className='flex-1'>
        <div className='space-y-1 p-2'>
          {profiles.isLoading ? (
            <p className='text-muted-foreground p-2 text-center text-xs'>
              Loading…
            </p>
          ) : !list.length ? (
            <div className='border-border rounded-md border border-dashed p-3 text-center text-xs'>
              <KeyRoundIcon className='text-muted-foreground/40 mx-auto mb-2 size-6' />
              <p className='text-muted-foreground'>
                Save multiple cloud LLM configs and switch between them.
              </p>
            </div>
          ) : (
            list.map((p) => (
              <div
                key={p.id}
                className='border-border bg-card group rounded-md border p-1.5'
              >
                <div className='flex items-start gap-1.5'>
                  <button
                    onClick={() => void setDefault(p)}
                    className='shrink-0 hover:text-amber-500'
                    title='Mark default'
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
                      {PROVIDER_LABEL[p.provider] ?? p.provider} · {p.modelName}
                    </div>
                  </div>
                  <Button
                    variant='outline'
                    size='sm'
                    className='h-6 px-2 text-[10px]'
                    onClick={() => void apply(p)}
                  >
                    Apply
                  </Button>
                  <Button
                    variant='ghost'
                    size='icon-xs'
                    className='size-6 opacity-0 group-hover:opacity-100'
                    onClick={() => void remove(p)}
                  >
                    <Trash2Icon className='size-3' />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
      {adding && (
        <AddProfileModal
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false)
            refresh()
          }}
        />
      )}
    </div>
  )
}

function AddProfileModal({
  onClose,
  onAdded,
}: {
  onClose: () => void
  onAdded: () => void
}) {
  const [draft, setDraft] = useState({
    name: '',
    provider: 'openai',
    modelName: 'gpt-4o',
    apiUrl: '',
    apiKey: '',
  })
  const [testStatus, setTestStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'ok'; ms: number }
    | { kind: 'err'; msg: string }
  >({ kind: 'idle' })

  const submit = async () => {
    if (!draft.name.trim() || !draft.modelName.trim()) return
    await api.providerProfileAdd({
      name: draft.name.trim(),
      provider: draft.provider,
      modelName: draft.modelName.trim(),
      apiUrl: draft.apiUrl.trim() || null,
      apiKey: draft.apiKey.trim() || null,
    })
    onAdded()
  }

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

  const applyPreset = (id: string) => {
    const p = PROVIDER_PRESETS.find((x) => x.id === id)
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

  return (
    <div className='bg-background/80 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm'>
      <div className='bg-card border-border w-96 rounded-lg border p-4 shadow-lg'>
        <h3 className='text-foreground mb-3 text-sm font-bold'>
          Add provider profile
        </h3>
        <div className='space-y-2'>
          <Select value='' onValueChange={applyPreset}>
            <SelectTrigger>
              <SelectValue placeholder='Quick preset…' />
            </SelectTrigger>
            <SelectContent>
              {PROVIDER_PRESETS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            autoFocus
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder='Profile name'
            className='text-sm'
          />
          <Input
            value={draft.modelName}
            onChange={(e) =>
              setDraft((d) => ({ ...d, modelName: e.target.value }))
            }
            placeholder='Model'
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
            type='password'
            value={draft.apiKey}
            onChange={(e) =>
              setDraft((d) => ({ ...d, apiKey: e.target.value }))
            }
            placeholder='API key (stored in OS keyring)'
            className='text-sm'
          />
        </div>
        <div className='mt-3 flex items-center justify-between gap-2'>
          <div className='flex items-center gap-2'>
            <Button
              variant='outline'
              size='sm'
              disabled={!draft.apiKey || !draft.modelName || testStatus.kind === 'pending'}
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
              <span className='flex items-center gap-1 text-[10px] text-emerald-600'>
                <CheckIcon className='size-3' /> {testStatus.ms} ms
              </span>
            )}
            {testStatus.kind === 'err' && (
              <span
                className='text-destructive flex items-center gap-1 text-[10px]'
                title={testStatus.msg}
              >
                <XIcon className='size-3' /> {testStatus.msg.slice(0, 30)}
              </span>
            )}
          </div>
          <div className='flex gap-2'>
            <Button variant='ghost' size='sm' onClick={onClose}>
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
  )
}
