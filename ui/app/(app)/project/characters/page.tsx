'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronLeftIcon,
  PlusIcon,
  StarIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { SearchableSelect } from '@/components/ui/searchable-select'
import {
  api,
  type CharacterAddInput,
  type CharacterDto,
  type NameAliasDto,
} from '@/lib/api'
import { useProjectStore } from '@/lib/stores/projectStore'
import { EmptyHint } from '@/components/project/EmptyHint'
import { UsersIcon } from 'lucide-react'

const ROLE_OPTIONS = [
  { value: 'protagonist', label: 'Protagonist' },
  { value: 'antagonist', label: 'Antagonist' },
  { value: 'supporting', label: 'Supporting' },
  { value: 'mob', label: 'Mob / extra' },
]

export default function CharactersPage() {
  const info = useProjectStore((s) => s.info)
  const [query, setQuery] = useState('')

  const characters = useQuery({
    queryKey: ['project', 'characters'],
    queryFn: () => api.charactersList(),
    enabled: !!info,
  })

  const refresh = () => void characters.refetch()

  const filtered = useMemo(() => {
    const all = characters.data ?? []
    if (!query.trim()) return all
    const q = query.toLowerCase()
    return all.filter((c) =>
      (c.originalName + ' ' + c.translatedName + ' ' + (c.role ?? '') +
        ' ' + c.aliases.map((a) => a.src + ' ' + a.tgt).join(' '))
        .toLowerCase()
        .includes(q),
    )
  }, [characters.data, query])

  const main = filtered.filter((c) => c.isMain)
  const supporting = filtered.filter((c) => !c.isMain)

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
              Characters
            </h1>
            <AddCharacterButton onAdded={refresh} />
          </div>

          <div className='mb-4'>
            <Input
              placeholder='Search by name, alias, or role'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className='text-sm'
            />
          </div>

          {characters.isLoading ? (
            <p className='text-muted-foreground text-sm'>Loading…</p>
          ) : (
            <>
              {main.length > 0 && (
                <Section title='⭐ Main' count={main.length}>
                  {main.map((c) => (
                    <CharacterCard key={c.id} character={c} onChanged={refresh} />
                  ))}
                </Section>
              )}
              {supporting.length > 0 && (
                <Section title='Supporting' count={supporting.length}>
                  {supporting.map((c) => (
                    <CharacterCard key={c.id} character={c} onChanged={refresh} />
                  ))}
                </Section>
              )}
              {filtered.length === 0 &&
                (query ? (
                  <div className='text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm'>
                    No characters match your search.
                  </div>
                ) : (
                  <EmptyHint
                    icon={UsersIcon}
                    title='No characters yet'
                    description='Character entries get injected into every translation prompt for this series, so names + speech styles stay consistent across chapters.'
                    steps={[
                      'Add main characters first (pin them with ⭐) — they appear in every prompt.',
                      'Supporting characters are only injected when their original_name appears in the current page text.',
                      'You can auto-extract entities from a translated chapter via the Glossary tab.',
                    ]}
                  />
                ))}
            </>
          )}
        </div>
      </div>
    </ScrollArea>
  )
}

function Section({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: React.ReactNode
}) {
  return (
    <section className='mb-6'>
      <h2 className='text-muted-foreground mb-2 text-xs font-bold uppercase tracking-wide'>
        {title} <span className='ml-1 font-normal'>({count})</span>
      </h2>
      <div className='space-y-2'>{children}</div>
    </section>
  )
}

function CharacterCard({
  character,
  onChanged,
}: {
  character: CharacterDto
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)

  const toggleMain = async () => {
    await api.characterUpdate({ id: character.id, isMain: !character.isMain })
    onChanged()
  }

  const remove = async () => {
    await api.characterRemove(character.id)
    onChanged()
  }

  return (
    <div className='bg-card border-border rounded-lg border p-3'>
      <div className='flex items-start gap-2'>
        <button
          onClick={() => void toggleMain()}
          className='hover:text-amber-500'
          title={character.isMain ? 'Demote to supporting' : 'Promote to main'}
        >
          <StarIcon
            className={
              'size-4 ' +
              (character.isMain
                ? 'fill-amber-400 text-amber-400'
                : 'text-muted-foreground')
            }
          />
        </button>
        <div className='min-w-0 flex-1'>
          <div className='text-sm font-semibold'>
            {character.originalName}
            <span className='text-muted-foreground'> → </span>
            {character.translatedName}
          </div>
          <div className='text-muted-foreground mt-0.5 flex flex-wrap gap-x-2 text-xs'>
            {character.role && <span>{character.role}</span>}
            {character.gender && <span>· {character.gender}</span>}
            {character.age && <span>· {character.age}</span>}
          </div>
          {character.speechStyle && (
            <div className='text-muted-foreground mt-1 text-xs italic'>
              💬 {character.speechStyle}
            </div>
          )}
          {character.aliases.length > 0 && (
            <div className='mt-2 flex flex-wrap gap-1'>
              {character.aliases.map((a, i) => (
                <span
                  key={i}
                  className='bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px]'
                >
                  {a.src} → {a.tgt}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className='flex items-center gap-1'>
          <Button
            variant='ghost'
            size='sm'
            onClick={() => setEditing(!editing)}
          >
            {editing ? 'Cancel' : 'Edit'}
          </Button>
          <Button
            variant='ghost'
            size='sm'
            onClick={() => void remove()}
            title='Delete'
          >
            <Trash2Icon className='size-3.5' />
          </Button>
        </div>
      </div>
      {editing && (
        <EditCharacterForm
          character={character}
          onSaved={() => {
            setEditing(false)
            onChanged()
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </div>
  )
}

function EditCharacterForm({
  character,
  onSaved,
  onCancel,
}: {
  character: CharacterDto
  onSaved: () => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<CharacterDto>(character)

  const patch = <K extends keyof CharacterDto>(
    key: K,
    value: CharacterDto[K],
  ) => setDraft((d) => ({ ...d, [key]: value }))

  const save = async () => {
    await api.characterUpdate({
      id: character.id,
      originalName: draft.originalName,
      translatedName: draft.translatedName,
      aliases: draft.aliases,
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
    <div className='border-border mt-3 space-y-3 border-t pt-3'>
      <div className='grid grid-cols-2 gap-2'>
        <Input
          value={draft.originalName}
          onChange={(e) => patch('originalName', e.target.value)}
          placeholder='Original name'
          className='text-sm'
        />
        <Input
          value={draft.translatedName}
          onChange={(e) => patch('translatedName', e.target.value)}
          placeholder='Translated name'
          className='text-sm'
        />
      </div>
      <div className='grid grid-cols-3 gap-2'>
        <SearchableSelect
          value={draft.role ?? ''}
          onValueChange={(v) => patch('role', v || null)}
          options={ROLE_OPTIONS}
          placeholder='Role'
          searchPlaceholder='Role…'
          clearable
        />
        <Input
          value={draft.gender ?? ''}
          onChange={(e) => patch('gender', e.target.value || null)}
          placeholder='Gender'
          className='text-sm'
        />
        <Input
          value={draft.age ?? ''}
          onChange={(e) => patch('age', e.target.value || null)}
          placeholder='Age'
          className='text-sm'
        />
      </div>
      <Input
        value={draft.speechStyle ?? ''}
        onChange={(e) => patch('speechStyle', e.target.value || null)}
        placeholder='Speech style — e.g. "uses ครับ, polite"'
        className='text-sm'
      />
      <AliasEditor
        aliases={draft.aliases}
        onChange={(aliases) => patch('aliases', aliases)}
      />
      <Textarea
        value={draft.notes ?? ''}
        onChange={(e) => patch('notes', e.target.value || null)}
        placeholder='Notes'
        className='min-h-16 text-sm'
      />
      <div className='flex justify-end gap-2'>
        <Button variant='ghost' size='sm' onClick={onCancel}>
          Cancel
        </Button>
        <Button variant='default' size='sm' onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  )
}

function AliasEditor({
  aliases,
  onChange,
}: {
  aliases: NameAliasDto[]
  onChange: (next: NameAliasDto[]) => void
}) {
  const [src, setSrc] = useState('')
  const [tgt, setTgt] = useState('')

  const add = () => {
    if (!src.trim()) return
    onChange([...aliases, { src: src.trim(), tgt: tgt.trim() }])
    setSrc('')
    setTgt('')
  }

  return (
    <div className='space-y-2'>
      <div className='text-foreground text-xs font-semibold'>Aliases</div>
      {aliases.length > 0 && (
        <div className='flex flex-wrap gap-1'>
          {aliases.map((a, i) => (
            <span
              key={i}
              className='bg-muted text-muted-foreground inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]'
            >
              {a.src} → {a.tgt}
              <button
                onClick={() => onChange(aliases.filter((_, j) => j !== i))}
                className='hover:text-foreground'
              >
                <XIcon className='size-3' />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className='flex gap-1'>
        <Input
          value={src}
          onChange={(e) => setSrc(e.target.value)}
          placeholder='Source form'
          className='h-7 text-xs'
        />
        <Input
          value={tgt}
          onChange={(e) => setTgt(e.target.value)}
          placeholder='Translation'
          className='h-7 text-xs'
        />
        <Button variant='outline' size='sm' onClick={add} disabled={!src.trim()}>
          <PlusIcon className='size-3.5' />
        </Button>
      </div>
    </div>
  )
}

function AddCharacterButton({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<CharacterAddInput>({
    originalName: '',
    translatedName: '',
    aliases: [],
    isMain: false,
  })

  const submit = async () => {
    if (!draft.originalName.trim() || !draft.translatedName.trim()) return
    await api.characterAdd(draft)
    setOpen(false)
    setDraft({
      originalName: '',
      translatedName: '',
      aliases: [],
      isMain: false,
    })
    onAdded()
  }

  return (
    <>
      <Button variant='default' size='sm' onClick={() => setOpen(true)}>
        <PlusIcon className='size-3.5' />
        Add character
      </Button>
      {open && (
        <div className='bg-background/80 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm'>
          <div className='bg-card border-border w-96 rounded-lg border p-5 shadow-lg'>
            <h3 className='text-foreground mb-3 text-sm font-bold'>
              Add character
            </h3>
            <div className='space-y-3'>
              <Input
                autoFocus
                value={draft.originalName}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, originalName: e.target.value }))
                }
                placeholder='Original name (e.g. 健太)'
                className='text-sm'
              />
              <Input
                value={draft.translatedName}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, translatedName: e.target.value }))
                }
                placeholder='Translated name (e.g. เคนตะ)'
                className='text-sm'
              />
              <div className='flex items-center gap-2 text-xs'>
                <input
                  type='checkbox'
                  id='is-main-new'
                  checked={!!draft.isMain}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, isMain: e.target.checked }))
                  }
                />
                <label htmlFor='is-main-new'>
                  Main character — include in always-on prompt context
                </label>
              </div>
            </div>
            <div className='mt-4 flex justify-end gap-2'>
              <Button variant='ghost' size='sm' onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant='default'
                size='sm'
                disabled={
                  !draft.originalName.trim() || !draft.translatedName.trim()
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
