'use client'

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  PlusIcon,
  SparklesIcon,
  StarIcon,
  Trash2Icon,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { api, type CharacterDto } from '@/lib/api'
import { ExtractEntitiesModal } from '@/components/project/ExtractEntitiesModal'

export function CharactersTabPanel() {
  const queryClient = useQueryClient()
  const characters = useQuery({
    queryKey: ['project', 'characters'],
    queryFn: () => api.charactersList(),
  })
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const [extractOpen, setExtractOpen] = useState(false)
  const refresh = () => {
    void characters.refetch()
    void queryClient.invalidateQueries({ queryKey: ['project', 'glossary'] })
  }

  const filtered = useMemo(() => {
    const all = characters.data ?? []
    if (!query.trim()) return all
    const q = query.toLowerCase()
    return all.filter((c) =>
      (
        c.originalName +
        ' ' +
        c.translatedName +
        ' ' +
        (c.role ?? '')
      )
        .toLowerCase()
        .includes(q),
    )
  }, [characters.data, query])

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <div className='border-border border-b px-2 py-1.5'>
        <div className='mb-1 flex items-center justify-between'>
          <span className='text-muted-foreground text-[10px] font-bold tracking-wide uppercase'>
            Characters{' '}
            <span className='text-muted-foreground/60'>
              ({characters.data?.length ?? 0})
            </span>
          </span>
          <div className='flex gap-1'>
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
              title='Add character'
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

      <ScrollArea className='flex-1'>
        <div className='space-y-1 p-2'>
          {characters.isLoading ? (
            <p className='text-muted-foreground p-2 text-center text-xs'>
              Loading…
            </p>
          ) : !characters.data?.length ? (
            <div className='border-border rounded-md border border-dashed p-3 text-center text-xs'>
              <p className='text-muted-foreground'>
                No characters yet — main characters get injected into every
                translation prompt.
              </p>
            </div>
          ) : (
            filtered.map((c) => (
              <CharacterRow
                key={c.id}
                character={c}
                onChanged={refresh}
                onEdit={() => setEditing(c.id)}
              />
            ))
          )}
        </div>
      </ScrollArea>

      {editing != null && (
        <CharacterEditModal
          characterId={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            refresh()
          }}
        />
      )}
      {adding && (
        <CharacterAddModal
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
    </div>
  )
}

function CharacterRow({
  character,
  onChanged,
  onEdit,
}: {
  character: CharacterDto
  onChanged: () => void
  onEdit: () => void
}) {
  const toggleMain = async () => {
    await api.characterUpdate({ id: character.id, isMain: !character.isMain })
    onChanged()
  }
  const remove = async () => {
    if (!confirm(`Delete "${character.originalName}"?`)) return
    await api.characterRemove(character.id)
    onChanged()
  }
  return (
    <div className='border-border bg-card group rounded-md border p-1.5'>
      <div className='flex items-start gap-1.5'>
        <button
          onClick={() => void toggleMain()}
          className='shrink-0 hover:text-amber-500'
          title={character.isMain ? 'Demote' : 'Pin as main'}
        >
          <StarIcon
            className={
              character.isMain
                ? 'fill-amber-400 size-3 text-amber-400'
                : 'text-muted-foreground/50 size-3'
            }
          />
        </button>
        <button
          onClick={onEdit}
          className='min-w-0 flex-1 text-left text-xs'
        >
          <div className='truncate font-semibold'>
            {character.originalName} → {character.translatedName}
          </div>
          {(character.role || character.speechStyle) && (
            <div className='text-muted-foreground truncate text-[10px]'>
              {character.role}
              {character.role && character.speechStyle && ' · '}
              {character.speechStyle}
            </div>
          )}
        </button>
        <Button
          variant='ghost'
          size='icon-xs'
          className='size-5 opacity-0 group-hover:opacity-100'
          onClick={() => void remove()}
        >
          <Trash2Icon className='size-3' />
        </Button>
      </div>
    </div>
  )
}

function CharacterEditModal({
  characterId,
  onClose,
  onSaved,
}: {
  characterId: number
  onClose: () => void
  onSaved: () => void
}) {
  const { data: list } = useQuery({
    queryKey: ['project', 'characters'],
    queryFn: () => api.charactersList(),
  })
  const character = list?.find((c) => c.id === characterId)
  const [draft, setDraft] = useState<CharacterDto | null>(character ?? null)

  if (!draft) return null

  const patch = <K extends keyof CharacterDto>(
    key: K,
    value: CharacterDto[K],
  ) => setDraft((d) => (d ? { ...d, [key]: value } : d))

  const save = async () => {
    await api.characterUpdate({
      id: draft.id,
      originalName: draft.originalName,
      translatedName: draft.translatedName,
      role: draft.role,
      gender: draft.gender,
      age: draft.age,
      speechStyle: draft.speechStyle,
      personality: draft.personality,
      notes: draft.notes,
    })
    onSaved()
  }

  return (
    <div className='bg-background/80 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm'>
      <div className='bg-card border-border w-96 max-w-[90vw] rounded-lg border p-4 shadow-lg'>
        <h3 className='text-foreground mb-3 text-sm font-bold'>Edit character</h3>
        <div className='space-y-2'>
          <div className='grid grid-cols-2 gap-2'>
            <Input
              value={draft.originalName}
              onChange={(e) => patch('originalName', e.target.value)}
              placeholder='Original'
              className='text-xs'
            />
            <Input
              value={draft.translatedName}
              onChange={(e) => patch('translatedName', e.target.value)}
              placeholder='Translated'
              className='text-xs'
            />
          </div>
          <div className='grid grid-cols-3 gap-2'>
            <Input
              value={draft.role ?? ''}
              onChange={(e) => patch('role', e.target.value || null)}
              placeholder='Role'
              className='text-xs'
            />
            <Input
              value={draft.gender ?? ''}
              onChange={(e) => patch('gender', e.target.value || null)}
              placeholder='Gender'
              className='text-xs'
            />
            <Input
              value={draft.age ?? ''}
              onChange={(e) => patch('age', e.target.value || null)}
              placeholder='Age'
              className='text-xs'
            />
          </div>
          <Input
            value={draft.speechStyle ?? ''}
            onChange={(e) => patch('speechStyle', e.target.value || null)}
            placeholder='Speech style'
            className='text-xs'
          />
          <Textarea
            value={draft.notes ?? ''}
            onChange={(e) => patch('notes', e.target.value || null)}
            placeholder='Notes'
            className='min-h-16 text-xs'
          />
        </div>
        <div className='mt-3 flex justify-end gap-2'>
          <Button variant='ghost' size='sm' onClick={onClose}>
            Cancel
          </Button>
          <Button variant='default' size='sm' onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}

function CharacterAddModal({
  onClose,
  onAdded,
}: {
  onClose: () => void
  onAdded: () => void
}) {
  const [original, setOriginal] = useState('')
  const [translated, setTranslated] = useState('')
  const [isMain, setIsMain] = useState(false)

  const submit = async () => {
    if (!original.trim() || !translated.trim()) return
    await api.characterAdd({
      originalName: original.trim(),
      translatedName: translated.trim(),
      isMain,
    })
    onAdded()
  }

  return (
    <div className='bg-background/80 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm'>
      <div className='bg-card border-border w-96 rounded-lg border p-4 shadow-lg'>
        <h3 className='text-foreground mb-3 text-sm font-bold'>Add character</h3>
        <div className='space-y-2'>
          <Input
            autoFocus
            value={original}
            onChange={(e) => setOriginal(e.target.value)}
            placeholder='Original name (e.g. 健太)'
            className='text-xs'
          />
          <Input
            value={translated}
            onChange={(e) => setTranslated(e.target.value)}
            placeholder='Translated name (e.g. เคนตะ)'
            className='text-xs'
          />
          <label className='flex items-center gap-1 text-xs'>
            <input
              type='checkbox'
              checked={isMain}
              onChange={(e) => setIsMain(e.target.checked)}
            />
            Pin as main (always injected into prompt)
          </label>
        </div>
        <div className='mt-3 flex justify-end gap-2'>
          <Button variant='ghost' size='sm' onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant='default'
            size='sm'
            disabled={!original.trim() || !translated.trim()}
            onClick={() => void submit()}
          >
            Add
          </Button>
        </div>
      </div>
    </div>
  )
}
