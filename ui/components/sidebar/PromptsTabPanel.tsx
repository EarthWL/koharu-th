'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { PlusIcon, StarIcon, Trash2Icon } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, type PromptTemplateDto, type PromptUseCase } from '@/lib/api'

const USE_CASES: { value: PromptUseCase; label: string }[] = [
  { value: 'translate', label: 'Translate' },
  { value: 'extract_entities', label: 'Extract' },
  { value: 'summarize_chapter', label: 'Summarize' },
]

export function PromptsTabPanel() {
  const templates = useQuery({
    queryKey: ['project', 'prompts'],
    queryFn: () => api.promptTemplatesList(),
  })
  const list = templates.data ?? []
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const selected = useMemo(
    () => list.find((t) => t.id === selectedId) ?? list[0],
    [list, selectedId],
  )
  useEffect(() => {
    if (selected && selectedId === null) setSelectedId(selected.id)
  }, [selected, selectedId])

  const refresh = () => void templates.refetch()

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <div className='border-border flex items-center justify-between border-b px-2 py-1.5'>
        <span className='text-muted-foreground text-[10px] font-bold tracking-wide uppercase'>
          Prompts ({list.length})
        </span>
        <Button
          variant='ghost'
          size='icon-xs'
          className='size-6'
          title='New template'
          onClick={async () => {
            const name = prompt('Template name?')
            if (!name) return
            await api.promptTemplateAdd({
              name,
              useCase: 'translate',
              template:
                'You are a translator.\n\nSource: {{source}}\n\nTranslate to {{target_language}}.',
            })
            refresh()
          }}
        >
          <PlusIcon className='size-3.5' />
        </Button>
      </div>
      <ScrollArea className='min-h-0 min-w-0 flex-1'>
        <div className='w-full min-w-0 space-y-1 p-2'>
          {templates.isLoading ? (
            <p className='text-muted-foreground p-2 text-center text-xs'>
              Loading…
            </p>
          ) : (
            list.map((tpl) => (
              <button
                key={tpl.id}
                onClick={() => setSelectedId(tpl.id)}
                className={
                  'hover:bg-accent/40 flex w-full items-center gap-1 rounded-md border px-2 py-1 text-left text-xs transition ' +
                  (selected?.id === tpl.id
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-card')
                }
              >
                {tpl.isDefault && (
                  <StarIcon className='fill-amber-400 size-3 text-amber-400' />
                )}
                <span className='min-w-0 flex-1 truncate font-medium'>
                  {tpl.name}
                </span>
                <span className='text-muted-foreground shrink-0 truncate text-[10px]'>
                  {tpl.useCase.replace('_', ' ')}
                </span>
              </button>
            ))
          )}
          {selected && (
            <TemplateEditor
              key={selected.id}
              template={selected}
              onSaved={refresh}
            />
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

function TemplateEditor({
  template,
  onSaved,
}: {
  template: PromptTemplateDto
  onSaved: () => void
}) {
  const [draft, setDraft] = useState(template)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    setDraft(template)
    setDirty(false)
  }, [template])

  const patch = <K extends keyof PromptTemplateDto>(
    key: K,
    value: PromptTemplateDto[K],
  ) => {
    setDraft((d) => ({ ...d, [key]: value }))
    setDirty(true)
  }

  const save = async () => {
    await api.promptTemplateUpdate({
      id: template.id,
      name: draft.name,
      useCase: draft.useCase,
      template: draft.template,
      isDefault: draft.isDefault,
    })
    setDirty(false)
    onSaved()
  }

  const remove = async () => {
    if (!confirm(`Delete "${template.name}"?`)) return
    await api.promptTemplateRemove(template.id)
    onSaved()
  }

  return (
    <div className='border-border bg-card mt-3 w-full min-w-0 space-y-2 overflow-hidden rounded-md border p-2'>
      <div className='grid grid-cols-2 gap-2'>
        <Input
          value={draft.name}
          onChange={(e) => patch('name', e.target.value)}
          className='h-6 text-xs'
        />
        <Select
          value={draft.useCase}
          onValueChange={(v) => patch('useCase', v as PromptUseCase)}
        >
          <SelectTrigger className='h-6 text-xs'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {USE_CASES.map((u) => (
              <SelectItem key={u.value} value={u.value} className='text-xs'>
                {u.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Textarea
        value={draft.template}
        onChange={(e) => patch('template', e.target.value)}
        style={{ fieldSizing: 'fixed' as any, width: '100%' }}
        className='block min-h-40 w-full resize-y font-mono text-[10px] whitespace-pre-wrap break-words'
      />
      <label className='flex items-center gap-1 text-[10px]'>
        <input
          type='checkbox'
          checked={draft.isDefault}
          onChange={(e) => patch('isDefault', e.target.checked)}
        />
        Default for this use case
      </label>
      <div className='flex justify-between gap-1'>
        <Button
          variant='ghost'
          size='sm'
          className='h-6 text-[10px]'
          onClick={() => void remove()}
        >
          <Trash2Icon className='size-3' />
          Delete
        </Button>
        <Button
          variant='default'
          size='sm'
          className='h-6 text-[10px]'
          disabled={!dirty}
          onClick={() => void save()}
        >
          Save
        </Button>
      </div>
    </div>
  )
}
