'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeftIcon, PlusIcon, Trash2Icon } from 'lucide-react'
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
import { api, type GlossaryCategory, type GlossaryDto } from '@/lib/api'
import { useProjectStore } from '@/lib/stores/projectStore'

const CATEGORY_OPTIONS: { value: GlossaryCategory; label: string }[] = [
  { value: 'term', label: 'Term' },
  { value: 'place', label: 'Place' },
  { value: 'skill', label: 'Skill' },
  { value: 'honorific', label: 'Honorific' },
  { value: 'item', label: 'Item' },
  { value: 'org', label: 'Organization' },
  { value: 'sfx', label: 'SFX' },
]

const CATEGORY_LABEL: Record<GlossaryCategory, string> = Object.fromEntries(
  CATEGORY_OPTIONS.map((o) => [o.value, o.label]),
) as Record<GlossaryCategory, string>

export default function GlossaryPage() {
  const info = useProjectStore((s) => s.info)
  const [query, setQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<'all' | GlossaryCategory>(
    'all',
  )

  const glossary = useQuery({
    queryKey: ['project', 'glossary'],
    queryFn: () => api.glossaryList(),
    enabled: !!info,
  })

  const refresh = () => void glossary.refetch()

  const filtered = useMemo(() => {
    const all = glossary.data ?? []
    return all.filter((e) => {
      if (categoryFilter !== 'all' && e.category !== categoryFilter) return false
      if (!query.trim()) return true
      const q = query.toLowerCase()
      return (
        (e.sourceText + ' ' + e.targetText + ' ' + (e.contextNote ?? '') +
          ' ' + e.aliases.join(' '))
          .toLowerCase()
          .includes(q)
      )
    })
  }, [glossary.data, query, categoryFilter])

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
              Glossary
              <span className='text-muted-foreground ml-2 text-sm font-normal'>
                ({glossary.data?.length ?? 0})
              </span>
            </h1>
            <AddGlossaryButton onAdded={refresh} />
          </div>

          <div className='mb-4 flex gap-2'>
            <Input
              placeholder='Search source / target / aliases'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className='text-sm'
            />
            <Select
              value={categoryFilter}
              onValueChange={(v) => setCategoryFilter(v as typeof categoryFilter)}
            >
              <SelectTrigger className='w-36'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='all'>All categories</SelectItem>
                {CATEGORY_OPTIONS.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className='bg-card border-border overflow-hidden rounded-lg border'>
            {glossary.isLoading ? (
              <div className='text-muted-foreground p-6 text-center text-sm'>
                Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div className='text-muted-foreground p-6 text-center text-sm'>
                {query || categoryFilter !== 'all'
                  ? 'No entries match your filter.'
                  : 'No entries yet — add one or extract them from a chapter.'}
              </div>
            ) : (
              <table className='w-full text-left text-xs'>
                <thead className='bg-muted/50 text-muted-foreground'>
                  <tr>
                    <th className='px-3 py-2 font-medium'>Source</th>
                    <th className='px-3 py-2 font-medium'>Target</th>
                    <th className='px-3 py-2 font-medium'>Category</th>
                    <th className='px-3 py-2 font-medium'>Used</th>
                    <th className='px-3 py-2 font-medium'>Notes</th>
                    <th className='px-3 py-2 font-medium'></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((e) => (
                    <GlossaryRow
                      key={e.id}
                      entry={e}
                      onChanged={refresh}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </ScrollArea>
  )
}

function GlossaryRow({
  entry,
  onChanged,
}: {
  entry: GlossaryDto
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<GlossaryDto>(entry)

  const save = async () => {
    await api.glossaryUpdate({
      id: entry.id,
      sourceText: draft.sourceText,
      targetText: draft.targetText,
      category: draft.category,
      aliases: draft.aliases,
      contextNote: draft.contextNote,
    })
    setEditing(false)
    onChanged()
  }

  const remove = async () => {
    await api.glossaryRemove(entry.id)
    onChanged()
  }

  if (editing) {
    return (
      <tr className='border-border border-t'>
        <td className='px-3 py-2'>
          <Input
            value={draft.sourceText}
            onChange={(e) => setDraft((d) => ({ ...d, sourceText: e.target.value }))}
            className='h-6 text-xs'
          />
        </td>
        <td className='px-3 py-2'>
          <Input
            value={draft.targetText}
            onChange={(e) => setDraft((d) => ({ ...d, targetText: e.target.value }))}
            className='h-6 text-xs'
          />
        </td>
        <td className='px-3 py-2'>
          <Select
            value={draft.category}
            onValueChange={(v) => setDraft((d) => ({ ...d, category: v as GlossaryCategory }))}
          >
            <SelectTrigger className='h-6 w-full'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORY_OPTIONS.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </td>
        <td className='text-muted-foreground px-3 py-2'>{entry.usageCount}</td>
        <td className='px-3 py-2'>
          <Input
            value={draft.contextNote ?? ''}
            onChange={(e) =>
              setDraft((d) => ({ ...d, contextNote: e.target.value || null }))
            }
            className='h-6 text-xs'
            placeholder='Notes'
          />
        </td>
        <td className='px-3 py-2 text-right'>
          <Button variant='ghost' size='sm' onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button variant='default' size='sm' onClick={() => void save()}>
            Save
          </Button>
        </td>
      </tr>
    )
  }

  return (
    <tr className='border-border hover:bg-accent/30 border-t'>
      <td className='px-3 py-2 font-medium'>{entry.sourceText}</td>
      <td className='px-3 py-2'>{entry.targetText}</td>
      <td className='text-muted-foreground px-3 py-2'>
        {CATEGORY_LABEL[entry.category]}
      </td>
      <td className='text-muted-foreground px-3 py-2'>{entry.usageCount}</td>
      <td className='text-muted-foreground truncate px-3 py-2'>
        {entry.contextNote ?? (
          <span className='opacity-50'>—</span>
        )}
      </td>
      <td className='px-3 py-2 text-right'>
        <Button variant='ghost' size='sm' onClick={() => setEditing(true)}>
          Edit
        </Button>
        <Button
          variant='ghost'
          size='sm'
          onClick={() => void remove()}
          title='Delete'
        >
          <Trash2Icon className='size-3.5' />
        </Button>
      </td>
    </tr>
  )
}

function AddGlossaryButton({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState({
    sourceText: '',
    targetText: '',
    category: 'term' as GlossaryCategory,
    contextNote: '',
  })

  const submit = async () => {
    if (!draft.sourceText.trim() || !draft.targetText.trim()) return
    await api.glossaryAdd({
      sourceText: draft.sourceText.trim(),
      targetText: draft.targetText.trim(),
      category: draft.category,
      contextNote: draft.contextNote.trim() || null,
    })
    setOpen(false)
    setDraft({ sourceText: '', targetText: '', category: 'term', contextNote: '' })
    onAdded()
  }

  return (
    <>
      <Button variant='default' size='sm' onClick={() => setOpen(true)}>
        <PlusIcon className='size-3.5' />
        Add entry
      </Button>
      {open && (
        <div className='bg-background/80 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm'>
          <div className='bg-card border-border w-96 rounded-lg border p-5 shadow-lg'>
            <h3 className='text-foreground mb-3 text-sm font-bold'>
              Add glossary entry
            </h3>
            <div className='space-y-3'>
              <Input
                autoFocus
                value={draft.sourceText}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, sourceText: e.target.value }))
                }
                placeholder='Source — e.g. 魔法剣'
                className='text-sm'
              />
              <Input
                value={draft.targetText}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, targetText: e.target.value }))
                }
                placeholder='Target — e.g. ดาบเวทย์'
                className='text-sm'
              />
              <Select
                value={draft.category}
                onValueChange={(v) =>
                  setDraft((d) => ({ ...d, category: v as GlossaryCategory }))
                }
              >
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORY_OPTIONS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={draft.contextNote}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, contextNote: e.target.value }))
                }
                placeholder='Notes (when/when-not to apply)'
                className='text-sm'
              />
            </div>
            <div className='mt-4 flex justify-end gap-2'>
              <Button variant='ghost' size='sm' onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant='default'
                size='sm'
                disabled={
                  !draft.sourceText.trim() || !draft.targetText.trim()
                }
                onClick={() => void submit()}
              >
                Add
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
