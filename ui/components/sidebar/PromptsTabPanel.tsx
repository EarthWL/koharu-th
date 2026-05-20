'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  CheckIcon,
  Loader2Icon,
  PlusIcon,
  StarIcon,
  Trash2Icon,
} from 'lucide-react'
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
import { toast } from 'sonner'

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
            try {
              await api.promptTemplateAdd({
                name,
                useCase: 'translate',
                template:
                  'You are a translator.\n\nSource: {{source}}\n\nTranslate to {{target_language}}.',
              })
              refresh()
            } catch (err: any) {
              // No inline error surface for the new-template button —
              // alert is acceptable here since the button isn't part of
              // any open form. Keeps the user aware that creation failed
              // instead of silently doing nothing.
              toast.error(`Failed to create template: ${err?.message ?? err}`)
            }
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
                  <StarIcon className='size-3 fill-amber-400 text-amber-400' />
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
              siblings={list}
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
  siblings,
  onSaved,
}: {
  template: PromptTemplateDto
  /** All templates from the parent — needed for the "multiple defaults
   *  per use_case" warning when the user ticks Default. */
  siblings: PromptTemplateDto[]
  onSaved: () => void
}) {
  const [draft, setDraft] = useState(template)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveOk, setSaveOk] = useState(false)

  useEffect(() => {
    // Re-init only when the user has no in-flight edits — otherwise a
    // background refetch of `['project', 'prompts']` would silently
    // overwrite the draft. Same pattern as the ProjectTabPanel /
    // CharactersTabPanel audits.
    if (!dirty) {
      setDraft(template)
      setSaveError(null)
      setSaveOk(false)
    }
  }, [template, dirty])

  const patch = <K extends keyof PromptTemplateDto>(
    key: K,
    value: PromptTemplateDto[K],
  ) => {
    setDraft((d) => ({ ...d, [key]: value }))
    setDirty(true)
    if (saveOk) setSaveOk(false)
    if (saveError) setSaveError(null)
  }

  const setIsDefault = (checked: boolean) => {
    // Warn the user when ticking Default and there's already another
    // template flagged for the same use_case. Backend doesn't enforce
    // single-default-per-use-case today, so without this prompt the
    // user can quietly end up with two "default" entries and the
    // dispatch picks whichever the SQL ORDER BY returns first. The
    // confirm flow makes the override deliberate.
    if (checked) {
      const existing = siblings.find(
        (s) => s.id !== draft.id && s.useCase === draft.useCase && s.isDefault,
      )
      if (
        existing &&
        !confirm(
          `"${existing.name}" is currently the default for ${draft.useCase}. Make THIS template the default instead?`,
        )
      ) {
        return
      }
    }
    patch('isDefault', checked)
  }

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    setSaveOk(false)
    try {
      await api.promptTemplateUpdate({
        id: template.id,
        name: draft.name,
        useCase: draft.useCase,
        template: draft.template,
        isDefault: draft.isDefault,
      })
      setDirty(false)
      setSaveOk(true)
      window.setTimeout(() => setSaveOk(false), 2500)
      onSaved()
    } catch (err: any) {
      setSaveError(err?.message ?? String(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (
      !confirm(
        `Delete "${template.name}"?\n\nExisting translations that used this template are NOT affected — only future ones will fall back to the next default.`,
      )
    )
      return
    try {
      await api.promptTemplateRemove(template.id)
      onSaved()
    } catch (err: any) {
      setSaveError(err?.message ?? String(err))
    }
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
        className='block min-h-40 w-full resize-y font-mono text-[10px] break-words whitespace-pre-wrap'
      />
      <label className='flex items-center gap-1 text-[10px]'>
        <input
          type='checkbox'
          checked={draft.isDefault}
          onChange={(e) => setIsDefault(e.target.checked)}
        />
        Default for this use case
      </label>
      {saveError && (
        <p className='text-destructive text-[10px] leading-relaxed'>
          Failed: {saveError}
        </p>
      )}
      <div className='flex items-center justify-between gap-1'>
        <Button
          variant='ghost'
          size='sm'
          className='h-6 text-[10px]'
          onClick={() => void remove()}
        >
          <Trash2Icon className='size-3' />
          Delete
        </Button>
        <div className='flex items-center gap-2'>
          {saveOk && !dirty && !saving && (
            <span className='flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400'>
              <CheckIcon className='size-3' /> Saved
            </span>
          )}
          <Button
            variant='default'
            size='sm'
            className='h-6 text-[10px]'
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving && <Loader2Icon className='size-3 animate-spin' />}
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}
