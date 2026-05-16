'use client'

import { useState } from 'react'
import { DownloadIcon, Loader2Icon, SparklesIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  extractEntitiesFromText,
  type ExtractedEntity,
} from '@/lib/services/cloudLlm'
import {
  loadCurrentWorkspaceText,
  ocrAllOpenPages,
} from '@/lib/services/chapterText'
import { api, type GlossaryCategory } from '@/lib/api'
import { WandSparklesIcon } from 'lucide-react'

type Proposed = ExtractedEntity & {
  selected: boolean
  // Category as picked by the user — may be edited from what the model proposed.
  appliedCategory: 'character' | GlossaryCategory
}

const ALL_CATEGORIES: ('character' | GlossaryCategory)[] = [
  'character',
  'place',
  'term',
  'skill',
  'honorific',
  'item',
  'org',
  'sfx',
]

const CATEGORY_LABEL: Record<'character' | GlossaryCategory, string> = {
  character: 'Character',
  place: 'Place',
  term: 'Term',
  skill: 'Skill',
  honorific: 'Honorific',
  item: 'Item',
  org: 'Organization',
  sfx: 'SFX',
}

/**
 * Normalise a model-supplied category string to one of our known buckets.
 * Anything unrecognised falls back to `term`.
 */
function normaliseCategory(s: string): 'character' | GlossaryCategory {
  const v = s.toLowerCase().trim()
  if (v === 'character' || v === 'char' || v === 'person') return 'character'
  if (v === 'place' || v === 'location' || v === 'setting') return 'place'
  if (v === 'skill' || v === 'attack' || v === 'technique') return 'skill'
  if (v === 'honorific' || v === 'suffix') return 'honorific'
  if (v === 'item' || v === 'object') return 'item'
  if (v === 'org' || v === 'organization' || v === 'group' || v === 'faction')
    return 'org'
  if (v === 'sfx' || v === 'soundeffect' || v === 'sound') return 'sfx'
  return 'term'
}

export function ExtractEntitiesModal({
  open,
  onClose,
  initialText = '',
  onApplied,
}: {
  open: boolean
  onClose: () => void
  initialText?: string
  onApplied?: () => void
}) {
  const [text, setText] = useState(initialText)
  const [items, setItems] = useState<Proposed[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingDocs, setLoadingDocs] = useState(false)
  const [ocrProgress, setOcrProgress] = useState<{ done: number; total: number; label: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)

  if (!open) return null

  const loadFromWorkspace = async () => {
    setLoadingDocs(true)
    setError(null)
    try {
      const loaded = await loadCurrentWorkspaceText()
      if (!loaded) {
        setError('No text in the loaded documents. Run OCR first.')
        return
      }
      setText(loaded)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoadingDocs(false)
    }
  }

  /** Run detect+OCR on all open pages (skipping pages that already have
   *  text), then auto-trigger the extract step. One-shot setup for a
   *  freshly imported chapter. */
  const autoOcrAndExtract = async () => {
    setLoadingDocs(true)
    setError(null)
    setItems(null)
    try {
      const loaded = await ocrAllOpenPages((done, total, label) =>
        setOcrProgress({ done, total, label }),
      )
      setOcrProgress(null)
      if (!loaded) {
        setError('No text recognised on any page. Try OCR manually.')
        return
      }
      setText(loaded)
      setLoading(true)
      const proposed = await extractEntitiesFromText(loaded)
      setItems(
        proposed.map((p) => ({
          ...p,
          selected: true,
          appliedCategory: normaliseCategory(p.category),
        })),
      )
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoadingDocs(false)
      setLoading(false)
      setOcrProgress(null)
    }
  }

  const runExtract = async () => {
    if (!text.trim()) return
    setLoading(true)
    setError(null)
    setItems(null)
    try {
      const proposed = await extractEntitiesFromText(text)
      setItems(
        proposed.map((p) => ({
          ...p,
          selected: true,
          appliedCategory: normaliseCategory(p.category),
        })),
      )
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  const applySelected = async () => {
    if (!items) return
    setApplying(true)
    try {
      for (const item of items) {
        if (!item.selected) continue
        if (item.appliedCategory === 'character') {
          await api.characterAdd({
            originalName: item.original,
            translatedName: item.translation,
            isMain: false,
          })
        } else {
          await api.glossaryAdd({
            sourceText: item.original,
            targetText: item.translation,
            category: item.appliedCategory,
            confidence: 'extracted',
            approved: true,
          })
        }
      }
      onApplied?.()
      onClose()
      setItems(null)
      setText('')
    } finally {
      setApplying(false)
    }
  }

  const selectedCount = items?.filter((i) => i.selected).length ?? 0

  return (
    <div className='bg-background/80 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm'>
      <div className='bg-card border-border flex max-h-[90vh] w-[42rem] max-w-[90vw] flex-col overflow-hidden rounded-lg border shadow-lg'>
        <div className='border-border flex shrink-0 items-center gap-2 border-b p-4'>
          <SparklesIcon className='text-primary size-4' />
          <h3 className='text-foreground text-sm font-bold'>Extract entities</h3>
        </div>

        <div className='min-h-0 flex-1 space-y-3 overflow-y-auto p-4'>
          <p className='text-muted-foreground text-xs'>
            Paste the chapter text (or any chunk you want analysed). The
            LLM will propose named entities and you pick which to keep.
          </p>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='Paste source text here, or load from the currently-loaded pages.'
            style={{ fieldSizing: 'fixed' as any }}
            className='block max-h-48 min-h-32 w-full resize-y overflow-auto text-xs whitespace-pre-wrap break-words'
          />
          <div className='flex items-center justify-between gap-2'>
            <div className='flex items-center gap-2'>
              <Button
                variant='outline'
                size='sm'
                disabled={loadingDocs}
                onClick={() => void loadFromWorkspace()}
                title='Load text from pages that have already been OCRed'
              >
                {loadingDocs && !ocrProgress ? (
                  <Loader2Icon className='size-3.5 animate-spin' />
                ) : (
                  <DownloadIcon className='size-3.5' />
                )}
                Load from open pages
              </Button>
              <Button
                variant='outline'
                size='sm'
                disabled={loadingDocs || loading}
                onClick={() => void autoOcrAndExtract()}
                title='Run detect+OCR on every open page, then extract entities — best for a freshly imported chapter'
              >
                {loadingDocs && ocrProgress ? (
                  <Loader2Icon className='size-3.5 animate-spin' />
                ) : (
                  <WandSparklesIcon className='size-3.5' />
                )}
                Auto OCR + Extract
              </Button>
            </div>
            <Button
              variant='default'
              size='sm'
              disabled={!text.trim() || loading}
              onClick={() => void runExtract()}
            >
              {loading && !ocrProgress ? (
                <Loader2Icon className='size-3.5 animate-spin' />
              ) : (
                <SparklesIcon className='size-3.5' />
              )}
              Extract
            </Button>
          </div>
          {ocrProgress && (
            <div className='border-border bg-muted/40 rounded-md border p-2 text-[10px]'>
              <div className='mb-1 flex items-center justify-between'>
                <span className='text-foreground font-semibold'>
                  Running OCR on chapter pages…
                </span>
                <span className='text-muted-foreground font-mono'>
                  {ocrProgress.done} / {ocrProgress.total}
                </span>
              </div>
              <div className='bg-muted h-1 overflow-hidden rounded'>
                <div
                  className='bg-primary h-full transition-all'
                  style={{
                    width: `${Math.round((ocrProgress.done / ocrProgress.total) * 100)}%`,
                  }}
                />
              </div>
              <div className='text-muted-foreground mt-1 truncate'>
                {ocrProgress.label}
              </div>
            </div>
          )}
          {error && (
            <div className='border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-2 text-xs'>
              {error}
            </div>
          )}
        </div>

        {items && (
          <>
            <div className='border-border shrink-0 border-t'>
              <ScrollArea className='max-h-72'>
                <table className='w-full text-left text-xs'>
                  <thead className='bg-muted/50 text-muted-foreground'>
                    <tr>
                      <th className='w-8 px-2 py-1'></th>
                      <th className='px-2 py-1 font-medium'>Original</th>
                      <th className='px-2 py-1 font-medium'>Translation</th>
                      <th className='px-2 py-1 font-medium'>Category</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, i) => (
                      <tr
                        key={i}
                        className='border-border hover:bg-accent/30 border-t'
                      >
                        <td className='px-2 py-1'>
                          <input
                            type='checkbox'
                            checked={it.selected}
                            onChange={(e) => {
                              const next = [...items]
                              next[i] = { ...it, selected: e.target.checked }
                              setItems(next)
                            }}
                          />
                        </td>
                        <td className='px-2 py-1'>
                          <Input
                            value={it.original}
                            onChange={(e) => {
                              const next = [...items]
                              next[i] = { ...it, original: e.target.value }
                              setItems(next)
                            }}
                            className='h-6 text-xs'
                          />
                        </td>
                        <td className='px-2 py-1'>
                          <Input
                            value={it.translation}
                            onChange={(e) => {
                              const next = [...items]
                              next[i] = { ...it, translation: e.target.value }
                              setItems(next)
                            }}
                            className='h-6 text-xs'
                          />
                        </td>
                        <td className='px-2 py-1'>
                          <Select
                            value={it.appliedCategory}
                            onValueChange={(v) => {
                              const next = [...items]
                              next[i] = {
                                ...it,
                                appliedCategory: v as Proposed['appliedCategory'],
                              }
                              setItems(next)
                            }}
                          >
                            <SelectTrigger className='h-6 w-full'>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ALL_CATEGORIES.map((c) => (
                                <SelectItem key={c} value={c}>
                                  {CATEGORY_LABEL[c]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollArea>
            </div>
            <div className='border-border flex shrink-0 items-center justify-between border-t p-3'>
              <span className='text-muted-foreground text-xs'>
                {selectedCount} of {items.length} selected
              </span>
              <div className='flex gap-2'>
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={() => {
                    const allSelected = items.every((i) => i.selected)
                    setItems(items.map((i) => ({ ...i, selected: !allSelected })))
                  }}
                >
                  Toggle all
                </Button>
                <Button
                  variant='default'
                  size='sm'
                  disabled={applying || selectedCount === 0}
                  onClick={() => void applySelected()}
                >
                  {applying && <Loader2Icon className='size-3.5 animate-spin' />}
                  Apply {selectedCount}
                </Button>
              </div>
            </div>
          </>
        )}

        <div className='border-border flex shrink-0 justify-end border-t p-3'>
          <Button variant='ghost' size='sm' onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  )
}
