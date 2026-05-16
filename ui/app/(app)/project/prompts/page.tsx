'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeftIcon, PlusIcon, StarIcon, Trash2Icon } from 'lucide-react'
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
import {
  api,
  type PromptTemplateDto,
  type PromptUseCase,
} from '@/lib/api'
import { useProjectStore } from '@/lib/stores/projectStore'

const USE_CASES: { value: PromptUseCase; label: string }[] = [
  { value: 'translate', label: 'Translate' },
  { value: 'extract_entities', label: 'Extract entities' },
  { value: 'summarize_chapter', label: 'Summarize chapter' },
]

const TEMPLATE_VARS = [
  '{{source}}',
  '{{source_language}}',
  '{{target_language}}',
  '{{series_title}}',
  '{{series_title_original}}',
  '{{series_synopsis}}',
  '{{tone}}',
  '{{formality}}',
  '{{style_notes}}',
  '{{main_characters}}',
  '{{filtered_glossary}}',
  '{{rolling_summary}}',
]

export default function PromptsPage() {
  const info = useProjectStore((s) => s.info)
  const templates = useQuery({
    queryKey: ['project', 'prompts'],
    queryFn: () => api.promptTemplatesList(),
    enabled: !!info,
  })

  const [selectedId, setSelectedId] = useState<number | null>(null)

  const list = templates.data ?? []
  const selected = useMemo(
    () => list.find((t) => t.id === selectedId) ?? list[0],
    [list, selectedId],
  )
  useEffect(() => {
    if (selected && selectedId === null) setSelectedId(selected.id)
  }, [selected, selectedId])

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

  return (
    <ScrollArea className='flex-1'>
      <div className='px-4 py-6'>
        <div className='relative mx-auto max-w-5xl'>
          <div className='mb-6 flex items-center'>
            <Link
              href='/project'
              prefetch={false}
              className='text-muted-foreground hover:bg-accent hover:text-foreground absolute -left-14 flex size-10 items-center justify-center rounded-full transition'
            >
              <ChevronLeftIcon className='size-6' />
            </Link>
            <h1 className='text-foreground flex-1 text-2xl font-bold'>
              Prompts
            </h1>
            <AddTemplateButton onAdded={() => void templates.refetch()} />
          </div>

          <div className='grid grid-cols-[220px_1fr] gap-4'>
            {/* template list */}
            <div className='bg-card border-border h-fit overflow-hidden rounded-lg border'>
              {templates.isLoading ? (
                <div className='text-muted-foreground p-4 text-center text-xs'>
                  Loading…
                </div>
              ) : list.length === 0 ? (
                <div className='text-muted-foreground p-4 text-center text-xs'>
                  No templates.
                </div>
              ) : (
                <ul>
                  {list.map((t) => (
                    <li
                      key={t.id}
                      onClick={() => setSelectedId(t.id)}
                      className={`border-border hover:bg-accent/50 cursor-pointer border-b px-3 py-2 last:border-b-0 ${
                        selected?.id === t.id ? 'bg-accent/60' : ''
                      }`}
                    >
                      <div className='flex items-center gap-1'>
                        {t.isDefault && (
                          <StarIcon className='size-3 fill-amber-400 text-amber-400' />
                        )}
                        <span className='text-xs font-medium'>{t.name}</span>
                      </div>
                      <div className='text-muted-foreground text-[10px]'>
                        {USE_CASES.find((u) => u.value === t.useCase)?.label ??
                          t.useCase}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* editor */}
            {selected && (
              <TemplateEditor
                template={selected}
                key={selected.id}
                onSaved={() => void templates.refetch()}
                onRemoved={() => {
                  setSelectedId(null)
                  void templates.refetch()
                }}
              />
            )}
          </div>
        </div>
      </div>
    </ScrollArea>
  )
}

function TemplateEditor({
  template,
  onSaved,
  onRemoved,
}: {
  template: PromptTemplateDto
  onSaved: () => void
  onRemoved: () => void
}) {
  const [draft, setDraft] = useState(template)
  const [dirty, setDirty] = useState(false)

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
      description: draft.description,
      useCase: draft.useCase,
      template: draft.template,
      isDefault: draft.isDefault,
    })
    setDirty(false)
    onSaved()
  }

  const remove = async () => {
    if (!confirm(`Delete template "${template.name}"?`)) return
    await api.promptTemplateRemove(template.id)
    onRemoved()
  }

  const insertVar = (v: string) => {
    setDraft((d) => ({ ...d, template: d.template + v }))
    setDirty(true)
  }

  return (
    <div className='bg-card border-border space-y-4 rounded-lg border p-4'>
      <div className='grid grid-cols-2 gap-3'>
        <Field label='Name'>
          <Input
            value={draft.name}
            onChange={(e) => patch('name', e.target.value)}
            className='text-sm'
          />
        </Field>
        <Field label='Use case'>
          <Select
            value={draft.useCase}
            onValueChange={(v) => patch('useCase', v as PromptUseCase)}
          >
            <SelectTrigger className='w-full'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {USE_CASES.map((u) => (
                <SelectItem key={u.value} value={u.value}>
                  {u.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field label='Description'>
        <Input
          value={draft.description ?? ''}
          onChange={(e) => patch('description', e.target.value || null)}
          className='text-sm'
          placeholder='Optional one-liner'
        />
      </Field>
      <Field label='Template (Handlebars)'>
        <Textarea
          value={draft.template}
          onChange={(e) => patch('template', e.target.value)}
          className='min-h-72 font-mono text-xs'
        />
      </Field>
      <div>
        <div className='text-muted-foreground mb-1 text-[10px] font-semibold uppercase'>
          Insert variable
        </div>
        <div className='flex flex-wrap gap-1'>
          {TEMPLATE_VARS.map((v) => (
            <button
              key={v}
              onClick={() => insertVar(v)}
              className='bg-muted hover:bg-accent rounded px-1.5 py-0.5 font-mono text-[10px]'
            >
              {v}
            </button>
          ))}
        </div>
      </div>
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-2 text-xs'>
          <input
            type='checkbox'
            id='is-default'
            checked={draft.isDefault}
            onChange={(e) => patch('isDefault', e.target.checked)}
          />
          <label htmlFor='is-default'>Default for this use case</label>
        </div>
        <div className='flex gap-2'>
          <Button variant='ghost' size='sm' onClick={() => void remove()}>
            <Trash2Icon className='size-3.5' />
            Delete
          </Button>
          <Button
            variant='default'
            size='sm'
            disabled={!dirty}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}

function AddTemplateButton({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [useCase, setUseCase] = useState<PromptUseCase>('translate')

  const submit = async () => {
    if (!name.trim()) return
    await api.promptTemplateAdd({
      name: name.trim(),
      useCase,
      template:
        'You are a translator.\n\nSource: {{source}}\n\nTranslate to {{target_language}}.',
    })
    setOpen(false)
    setName('')
    setUseCase('translate')
    onAdded()
  }

  return (
    <>
      <Button variant='default' size='sm' onClick={() => setOpen(true)}>
        <PlusIcon className='size-3.5' />
        New template
      </Button>
      {open && (
        <div className='bg-background/80 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm'>
          <div className='bg-card border-border w-96 rounded-lg border p-5 shadow-lg'>
            <h3 className='text-foreground mb-3 text-sm font-bold'>
              New prompt template
            </h3>
            <div className='space-y-3'>
              <Field label='Name'>
                <Input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className='text-sm'
                  placeholder='my-custom-prompt'
                />
              </Field>
              <Field label='Use case'>
                <Select
                  value={useCase}
                  onValueChange={(v) => setUseCase(v as PromptUseCase)}
                >
                  <SelectTrigger className='w-full'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {USE_CASES.map((u) => (
                      <SelectItem key={u.value} value={u.value}>
                        {u.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <div className='mt-4 flex justify-end gap-2'>
              <Button variant='ghost' size='sm' onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant='default'
                size='sm'
                disabled={!name.trim()}
                onClick={() => void submit()}
              >
                Create
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className='flex flex-col gap-1.5'>
      <label className='text-foreground text-xs font-semibold'>{label}</label>
      {children}
    </div>
  )
}
