'use client'

import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArchiveIcon, Loader2Icon, LogOutIcon } from 'lucide-react'
import { CostDashboard } from '@/components/project/CostDashboard'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { api, type SeriesMetaDto } from '@/lib/api'
import { useProjectMutations } from '@/lib/query/projectMutations'
import { useProjectStore } from '@/lib/stores/projectStore'

export function ProjectTabPanel() {
  const info = useProjectStore((s) => s.info)
  const { closeProject } = useProjectMutations()
  const queryClient = useQueryClient()
  const seriesMeta = useQuery({
    queryKey: ['project', 'series-meta'],
    queryFn: () => api.seriesMetaGet(),
  })

  const [draft, setDraft] = useState<Partial<SeriesMetaDto>>({})
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (seriesMeta.data) {
      setDraft(seriesMeta.data)
      setDirty(false)
    }
  }, [seriesMeta.data])

  const patch = <K extends keyof SeriesMetaDto>(
    key: K,
    value: SeriesMetaDto[K],
  ) => {
    setDraft((d) => ({ ...d, [key]: value }))
    setDirty(true)
  }

  const save = async () => {
    setSaving(true)
    try {
      await api.seriesMetaUpdate(draft)
      await queryClient.invalidateQueries({ queryKey: ['project', 'series-meta'] })
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  const backup = async () => {
    const r = await api.projectBackupPicker().catch((e) => {
      alert(e?.message ?? String(e))
      return null
    })
    if (r?.path) {
      alert(`✓ ${r.fileCount} files → ${r.path.split(/[\\/]/).pop()}`)
    }
  }

  if (!info) return null

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <div className='border-border border-b px-2 py-1.5'>
        <span className='text-muted-foreground text-[10px] font-bold tracking-wide uppercase'>
          Project
        </span>
        <div className='text-foreground mt-0.5 truncate text-xs font-semibold'>
          {info.name}
        </div>
        <div className='text-muted-foreground truncate text-[10px]'>
          {info.root}
        </div>
      </div>
      <ScrollArea className='flex-1'>
        <div className='space-y-3 p-2'>
          {seriesMeta.isLoading ? (
            <p className='text-muted-foreground p-2 text-center text-xs'>
              Loading…
            </p>
          ) : (
            <>
              <Field label='Title'>
                <Input
                  value={draft.title ?? ''}
                  onChange={(e) => patch('title', e.target.value)}
                  className='h-7 text-xs'
                />
              </Field>
              <Field label='Original title'>
                <Input
                  value={draft.titleOriginal ?? ''}
                  onChange={(e) =>
                    patch('titleOriginal', e.target.value || null)
                  }
                  placeholder='e.g. 陰陽師物語'
                  className='h-7 text-xs'
                />
              </Field>
              <Field label='Synopsis'>
                <Textarea
                  value={draft.synopsis ?? ''}
                  onChange={(e) => patch('synopsis', e.target.value || null)}
                  placeholder='2-3 sentences the model sees every page'
                  className='min-h-16 text-xs'
                />
              </Field>
              <div className='grid grid-cols-2 gap-2'>
                <Field label='Source lang'>
                  <Input
                    value={draft.sourceLanguage ?? ''}
                    onChange={(e) => patch('sourceLanguage', e.target.value)}
                    className='h-7 text-xs'
                  />
                </Field>
                <Field label='Target lang'>
                  <Input
                    value={draft.targetLanguage ?? ''}
                    onChange={(e) => patch('targetLanguage', e.target.value)}
                    className='h-7 text-xs'
                  />
                </Field>
              </div>
              <div className='grid grid-cols-2 gap-2'>
                <Field label='Tone'>
                  <Input
                    value={draft.tone ?? ''}
                    onChange={(e) => patch('tone', e.target.value || null)}
                    placeholder='casual / formal'
                    className='h-7 text-xs'
                  />
                </Field>
                <Field label='Formality'>
                  <Input
                    value={draft.formalityLevel ?? ''}
                    onChange={(e) =>
                      patch('formalityLevel', e.target.value || null)
                    }
                    placeholder='low / medium / high'
                    className='h-7 text-xs'
                  />
                </Field>
              </div>
              <Field label='Style notes'>
                <Textarea
                  value={draft.styleNotes ?? ''}
                  onChange={(e) => patch('styleNotes', e.target.value || null)}
                  className='min-h-12 text-xs'
                />
              </Field>
              <Button
                variant='default'
                size='sm'
                disabled={!dirty || saving}
                onClick={() => void save()}
                className='h-7 w-full text-xs'
              >
                {saving && <Loader2Icon className='size-3 animate-spin' />}
                Save changes
              </Button>
            </>
          )}

          <div className='border-border space-y-2 border-t pt-3'>
            <div className='text-muted-foreground grid grid-cols-3 gap-1 text-center text-[10px]'>
              <div>
                <div className='text-foreground text-sm font-bold'>
                  {info.chapterCount}
                </div>
                chapters
              </div>
              <div>
                <div className='text-foreground text-sm font-bold'>
                  {info.characterCount}
                </div>
                characters
              </div>
              <div>
                <div className='text-foreground text-sm font-bold'>
                  {info.glossaryCount}
                </div>
                glossary
              </div>
            </div>
            <Button
              variant='outline'
              size='sm'
              onClick={() => void backup()}
              className='h-7 w-full text-xs'
            >
              <ArchiveIcon className='size-3' />
              Backup project…
            </Button>
            <Button
              variant='ghost'
              size='sm'
              onClick={() => void closeProject()}
              className='h-7 w-full text-xs'
            >
              <LogOutIcon className='size-3' />
              Close project
            </Button>
          </div>

          <div className='border-border border-t pt-3'>
            <CostDashboard />
          </div>
        </div>
      </ScrollArea>
    </div>
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
    <div className='flex flex-col gap-1'>
      <label className='text-muted-foreground text-[10px] font-semibold uppercase tracking-wide'>
        {label}
      </label>
      {children}
    </div>
  )
}
