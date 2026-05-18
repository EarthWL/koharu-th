'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Loader2Icon,
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
  UploadIcon,
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
import { api, type GlossaryCategory, type GlossaryDto } from '@/lib/api'
import { ExtractEntitiesModal } from '@/components/project/ExtractEntitiesModal'
import { ImportGlossaryModal } from '@/components/project/ImportGlossaryModal'

const CATEGORIES: { value: GlossaryCategory; label: string }[] = [
  { value: 'term', label: 'Term' },
  { value: 'place', label: 'Place' },
  { value: 'skill', label: 'Skill' },
  { value: 'honorific', label: 'Honorific' },
  { value: 'item', label: 'Item' },
  { value: 'org', label: 'Org' },
  { value: 'sfx', label: 'SFX' },
]

export function GlossaryTabPanel() {
  const glossary = useQuery({
    queryKey: ['project', 'glossary'],
    queryFn: () => api.glossaryList(),
  })
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [extractOpen, setExtractOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const refresh = () => void glossary.refetch()

  const filtered = useMemo(() => {
    const all = glossary.data ?? []
    if (!query.trim()) return all
    const q = query.toLowerCase()
    return all.filter((e) =>
      (e.sourceText + ' ' + e.targetText + ' ' + (e.contextNote ?? ''))
        .toLowerCase()
        .includes(q),
    )
  }, [glossary.data, query])

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <div className='border-border border-b px-2 py-1.5'>
        <div className='mb-1 flex items-center justify-between'>
          <span className='text-muted-foreground text-[10px] font-bold tracking-wide uppercase'>
            Glossary{' '}
            <span className='text-muted-foreground/60'>
              ({glossary.data?.length ?? 0})
            </span>
          </span>
          <div className='flex gap-1'>
            <Button
              variant='ghost'
              size='icon-xs'
              className='size-6'
              title='Import CSV / JSON'
              onClick={() => setImportOpen(true)}
            >
              <UploadIcon className='size-3' />
            </Button>
            <Button
              variant='ghost'
              size='icon-xs'
              className='size-6'
              title='Extract from open pages'
              onClick={() => setExtractOpen(true)}
            >
              <SparklesIcon className='size-3' />
            </Button>
            <Button
              variant='ghost'
              size='icon-xs'
              className='size-6'
              title='Add entry'
              onClick={() => setAdding(true)}
            >
              <PlusIcon className='size-3.5' />
            </Button>
          </div>
        </div>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='Search…'
          className='h-6 text-xs'
        />
      </div>

      <ScrollArea className='min-h-0 min-w-0 flex-1'>
        <div className='space-y-1 p-2'>
          {glossary.isLoading ? (
            <p className='text-muted-foreground p-2 text-center text-xs'>
              Loading…
            </p>
          ) : !glossary.data?.length ? (
            <div className='border-border rounded-md border border-dashed p-3 text-center text-xs'>
              <p className='text-muted-foreground'>
                Locks specific terms to consistent translations across the
                series.
              </p>
            </div>
          ) : (
            filtered.map((e) => (
              <GlossaryRow key={e.id} entry={e} onChanged={refresh} />
            ))
          )}
        </div>
      </ScrollArea>

      {adding && (
        <AddEntryModal
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false)
            refresh()
          }}
        />
      )}
      <ExtractEntitiesModal
        open={extractOpen}
        onClose={() => setExtractOpen(false)}
        onApplied={refresh}
      />
      <ImportGlossaryModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => refresh()}
      />
    </div>
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
  const [src, setSrc] = useState(entry.sourceText)
  const [tgt, setTgt] = useState(entry.targetText)
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)

  const dirty = src !== entry.sourceText || tgt !== entry.targetText

  const cancelEdit = () => {
    if (dirty && !confirm('Discard changes?')) return
    setSrc(entry.sourceText)
    setTgt(entry.targetText)
    setEditing(false)
    setRowError(null)
  }

  const save = async () => {
    if (!dirty) {
      setEditing(false)
      return
    }
    setBusy('save')
    setRowError(null)
    try {
      await api.glossaryUpdate({
        id: entry.id,
        sourceText: src,
        targetText: tgt,
      })
      setEditing(false)
      onChanged()
    } catch (err: any) {
      // Backend can reject (unique constraint on source+category, etc.) —
      // keep the inline editor open with the message so the user can
      // adjust + retry without retyping.
      setRowError(err?.message ?? String(err))
    } finally {
      setBusy(null)
    }
  }
  const remove = async () => {
    if (!confirm(`Delete "${entry.sourceText}"?`)) return
    setBusy('remove')
    setRowError(null)
    try {
      await api.glossaryRemove(entry.id)
      onChanged()
    } catch (err: any) {
      setRowError(err?.message ?? String(err))
    } finally {
      setBusy(null)
    }
  }

  if (editing) {
    return (
      <div className='border-border bg-card space-y-1 rounded-md border p-1.5'>
        <Input
          value={src}
          onChange={(e) => setSrc(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) void save()
            if (e.key === 'Escape') cancelEdit()
          }}
          className='h-6 text-xs'
          autoFocus
        />
        <Input
          value={tgt}
          onChange={(e) => setTgt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) void save()
            if (e.key === 'Escape') cancelEdit()
          }}
          className='h-6 text-xs'
        />
        <div className='flex justify-end gap-1'>
          <Button
            variant='ghost'
            size='icon-xs'
            className='size-6'
            onClick={cancelEdit}
            disabled={busy !== null}
          >
            ✕
          </Button>
          <Button
            variant='default'
            size='icon-xs'
            className='size-6 text-[10px]'
            onClick={() => void save()}
            disabled={busy !== null}
          >
            {busy === 'save' ? (
              <Loader2Icon className='size-3 animate-spin' />
            ) : (
              '✓'
            )}
          </Button>
        </div>
        {rowError && (
          <p className='text-destructive text-[10px] leading-relaxed'>
            {rowError}
          </p>
        )}
      </div>
    )
  }

  return (
    <div
      className='border-border bg-card hover:bg-accent/30 group rounded-md border p-1.5'
      onClick={() => setEditing(true)}
    >
      <div className='flex items-start gap-1.5'>
        <span className='bg-muted text-muted-foreground rounded px-1 py-0.5 text-[9px]'>
          {entry.category}
        </span>
        <div className='min-w-0 flex-1 text-xs'>
          <div className='truncate'>
            <span className='font-medium'>{entry.sourceText}</span>
            <span className='text-muted-foreground'> → </span>
            <span>{entry.targetText}</span>
          </div>
          {entry.usageCount > 0 && (
            <div className='text-muted-foreground text-[10px]'>
              used {entry.usageCount}×
            </div>
          )}
        </div>
        <Button
          variant='ghost'
          size='icon-xs'
          className='size-5 opacity-0 group-hover:opacity-100'
          onClick={(e) => {
            e.stopPropagation()
            void remove()
          }}
          disabled={busy !== null}
        >
          <Trash2Icon className='size-3' />
        </Button>
      </div>
      {rowError && (
        <p className='text-destructive mt-1 text-[10px] leading-relaxed'>
          {rowError}
        </p>
      )}
    </div>
  )
}

function AddEntryModal({
  onClose,
  onAdded,
}: {
  onClose: () => void
  onAdded: () => void
}) {
  const [src, setSrc] = useState('')
  const [tgt, setTgt] = useState('')
  const [category, setCategory] = useState<GlossaryCategory>('term')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const canSubmit = !!src.trim() && !!tgt.trim() && !adding

  const submit = async () => {
    if (!src.trim() || !tgt.trim()) return
    setAdding(true)
    setAddError(null)
    try {
      await api.glossaryAdd({
        sourceText: src.trim(),
        targetText: tgt.trim(),
        category,
      })
      onAdded()
    } catch (err: any) {
      // Backend may reject duplicates (sourceText + category unique).
      // Stay open so user can edit + retry without re-typing.
      setAddError(err?.message ?? String(err))
    } finally {
      setAdding(false)
    }
  }

  // Esc to close (consistent with other modals across the audit)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className='bg-background/80 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm'
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className='bg-card border-border w-96 rounded-lg border p-4 shadow-lg'
        role='dialog'
        aria-modal='true'
      >
        <h3 className='text-foreground mb-3 text-sm font-bold'>
          Add glossary entry
        </h3>
        <div className='space-y-2'>
          <Input
            autoFocus
            value={src}
            onChange={(e) => setSrc(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit) void submit()
            }}
            placeholder='Source'
            className='text-sm'
          />
          <Input
            value={tgt}
            onChange={(e) => setTgt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit) void submit()
            }}
            placeholder='Target'
            className='text-sm'
          />
          <Select
            value={category}
            onValueChange={(v) => setCategory(v as GlossaryCategory)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {addError && (
          <p className='text-destructive mt-2 text-[10px] leading-relaxed'>
            Failed to add: {addError}
          </p>
        )}
        <div className='mt-3 flex justify-end gap-2'>
          <Button variant='ghost' size='sm' onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant='default'
            size='sm'
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {adding && <Loader2Icon className='size-3 animate-spin' />}
            Add
          </Button>
        </div>
      </div>
    </div>
  )
}
