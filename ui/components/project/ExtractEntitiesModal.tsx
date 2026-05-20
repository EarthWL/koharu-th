'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DownloadIcon,
  Loader2Icon,
  SparklesIcon,
  WandSparklesIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
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

type Proposed = ExtractedEntity & {
  selected: boolean
  // Category as picked by the user — may be edited from what the model proposed.
  appliedCategory: 'character' | GlossaryCategory
}

type ApplyResult =
  | { kind: 'success'; inserted: number; skipped: number }
  | { kind: 'mixed'; inserted: number; skipped: number; failed: number }
  | { kind: 'error'; message: string }

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

const CATEGORY_LABEL_KEY: Record<'character' | GlossaryCategory, string> = {
  character: 'extractEntities.catCharacter',
  place: 'extractEntities.catPlace',
  term: 'extractEntities.catTerm',
  skill: 'extractEntities.catSkill',
  honorific: 'extractEntities.catHonorific',
  item: 'extractEntities.catItem',
  org: 'extractEntities.catOrg',
  sfx: 'extractEntities.catSfx',
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
  const { t } = useTranslation()
  const [text, setText] = useState(initialText)
  const [items, setItems] = useState<Proposed[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingDocs, setLoadingDocs] = useState(false)
  const [ocrProgress, setOcrProgress] = useState<{
    done: number
    total: number
    label: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null)
  // Generation counter — increments on every new extract / OCR+extract
  // attempt. The async resolver checks `gen === genRef.current` before
  // writing state; if the user closed the modal or restarted, the
  // stale resolver bails instead of clobbering fresh state on an
  // unmounted (or now-different) modal.
  const genRef = useRef(0)

  // Esc-to-close + reset gen counter on unmount. Listener only mounts
  // while the modal is open so it doesn't leak when closed.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      // Bump the gen counter on unmount/close so any in-flight LLM
      // resolver sees a stale generation and skips its setItems().
      genRef.current++
    }
  }, [open, onClose])

  if (!open) return null

  const loadFromWorkspace = async () => {
    setLoadingDocs(true)
    setError(null)
    try {
      const loaded = await loadCurrentWorkspaceText()
      if (!loaded) {
        setError(t('extractEntities.noLoadedText'))
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
    const gen = ++genRef.current
    setLoadingDocs(true)
    setError(null)
    setItems(null)
    setApplyResult(null)
    try {
      const loaded = await ocrAllOpenPages((done, total, label) => {
        if (gen !== genRef.current) return
        setOcrProgress({ done, total, label })
      })
      if (gen !== genRef.current) return
      setOcrProgress(null)
      if (!loaded) {
        setError(t('extractEntities.noRecognisedText'))
        return
      }
      setText(loaded)
      setLoading(true)
      const proposed = await extractEntitiesFromText(loaded)
      if (gen !== genRef.current) return
      setItems(
        proposed.map((p) => ({
          ...p,
          selected: true,
          appliedCategory: normaliseCategory(p.category),
        })),
      )
    } catch (e: any) {
      if (gen !== genRef.current) return
      setError(e?.message || String(e))
    } finally {
      if (gen === genRef.current) {
        setLoadingDocs(false)
        setLoading(false)
        setOcrProgress(null)
      }
    }
  }

  const runExtract = async () => {
    if (!text.trim()) return
    const gen = ++genRef.current
    setLoading(true)
    setError(null)
    setItems(null)
    setApplyResult(null)
    try {
      const proposed = await extractEntitiesFromText(text)
      if (gen !== genRef.current) return
      setItems(
        proposed.map((p) => ({
          ...p,
          selected: true,
          appliedCategory: normaliseCategory(p.category),
        })),
      )
    } catch (e: any) {
      if (gen !== genRef.current) return
      setError(e?.message || String(e))
    } finally {
      if (gen === genRef.current) setLoading(false)
    }
  }

  const applySelected = async () => {
    if (!items) return
    setApplying(true)
    setApplyResult(null)
    const selected = items.filter((i) => i.selected)
    // Split by category: characters lack a bulk endpoint so we loop
    // with per-row try/catch; glossary rows go through glossaryBulkAdd
    // for one atomic round-trip + a server-side dedup report.
    const characters = selected.filter((i) => i.appliedCategory === 'character')
    const glossaryRows = selected.filter(
      (i) => i.appliedCategory !== 'character',
    )

    let inserted = 0
    let skipped = 0
    let failed = 0

    for (const c of characters) {
      try {
        await api.characterAdd({
          originalName: c.original,
          translatedName: c.translation,
          isMain: false,
        })
        inserted++
      } catch {
        failed++
      }
    }

    if (glossaryRows.length > 0) {
      try {
        const r = await api.glossaryBulkAdd(
          glossaryRows.map((g) => ({
            sourceText: g.original,
            targetText: g.translation,
            category: g.appliedCategory as GlossaryCategory,
            confidence: 'extracted',
            approved: true,
          })),
        )
        inserted += r.inserted
        skipped += r.skipped
      } catch (err: any) {
        // Bulk failed wholesale — count every glossary row as failed
        // and surface the message so user knows the cause.
        failed += glossaryRows.length
        setApplying(false)
        setApplyResult({
          kind: 'error',
          message: err?.message ?? String(err),
        })
        return
      }
    }

    setApplying(false)
    onApplied?.()
    if (failed > 0) {
      // Partial success — keep the modal open with a summary so the
      // user can adjust the failed rows and retry.
      setApplyResult({ kind: 'mixed', inserted, skipped, failed })
    } else {
      // All clear — close on a tick so user briefly sees the success
      // banner, but reset state for the next open.
      setApplyResult({ kind: 'success', inserted, skipped })
      onClose()
      setItems(null)
      setText('')
    }
  }

  const selectedCount = items?.filter((i) => i.selected).length ?? 0

  return (
    <div
      role='dialog'
      aria-modal='true'
      aria-labelledby='extract-entities-title'
      className='bg-background/80 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm'
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className='bg-card border-border flex max-h-[90vh] w-[42rem] max-w-[90vw] flex-col overflow-hidden rounded-lg border shadow-lg'>
        <div className='border-border flex shrink-0 items-center gap-2 border-b p-4'>
          <SparklesIcon className='text-primary size-4' />
          <h3
            id='extract-entities-title'
            className='text-foreground text-sm font-bold'
          >
            {t('extractEntities.title')}
          </h3>
        </div>

        <div className='min-h-0 flex-1 space-y-3 overflow-y-auto p-4'>
          <p className='text-muted-foreground text-xs'>
            {t('extractEntities.intro')}
          </p>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('extractEntities.placeholder')}
            style={{ fieldSizing: 'fixed' as any }}
            className='block max-h-48 min-h-32 w-full resize-y overflow-auto text-xs break-words whitespace-pre-wrap'
          />
          <div className='flex items-center justify-between gap-2'>
            <div className='flex items-center gap-2'>
              <Button
                variant='outline'
                size='sm'
                disabled={loadingDocs}
                onClick={() => void loadFromWorkspace()}
                title={t('extractEntities.loadFromPagesTooltip')}
              >
                {loadingDocs && !ocrProgress ? (
                  <Loader2Icon className='size-3.5 animate-spin' />
                ) : (
                  <DownloadIcon className='size-3.5' />
                )}
                {t('extractEntities.loadFromPages')}
              </Button>
              <Button
                variant='outline'
                size='sm'
                disabled={loadingDocs || loading}
                onClick={() => void autoOcrAndExtract()}
                title={t('extractEntities.autoOcrExtractTooltip')}
              >
                {loadingDocs && ocrProgress ? (
                  <Loader2Icon className='size-3.5 animate-spin' />
                ) : (
                  <WandSparklesIcon className='size-3.5' />
                )}
                {t('extractEntities.autoOcrExtract')}
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
              {t('extractEntities.extract')}
            </Button>
          </div>
          {ocrProgress && (
            <div className='border-border bg-muted/40 rounded-md border p-2 text-[10px]'>
              <div className='mb-1 flex items-center justify-between'>
                <span className='text-foreground font-semibold'>
                  {t('extractEntities.ocrRunning')}
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
          {applyResult?.kind === 'mixed' && (
            <div className='rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300'>
              {t('extractEntities.applyDoneMixed', {
                inserted: applyResult.inserted,
                failed: applyResult.failed,
                skipped: applyResult.skipped,
              })}
            </div>
          )}
          {applyResult?.kind === 'error' && (
            <div className='border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-2 text-xs'>
              {t('extractEntities.applyFailedAll', {
                message: applyResult.message,
              })}
            </div>
          )}

          {items && (
            <div className='border-border -mx-4 mt-2 border-t'>
              <table className='w-full text-left text-xs'>
                <thead className='bg-muted/50 text-muted-foreground'>
                  <tr>
                    <th className='w-8 px-2 py-1'></th>
                    <th className='px-2 py-1 font-medium'>
                      {t('extractEntities.thOriginal')}
                    </th>
                    <th className='px-2 py-1 font-medium'>
                      {t('extractEntities.thTranslation')}
                    </th>
                    <th className='px-2 py-1 font-medium'>
                      {t('extractEntities.thCategory')}
                    </th>
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
                                {t(CATEGORY_LABEL_KEY[c])}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Single footer — combines selection count + action buttons when
            items present, otherwise just the Close button. Sticky at the
            bottom of the modal, never scrolls. */}
        <div className='border-border flex shrink-0 items-center justify-between gap-2 border-t p-3'>
          {items ? (
            <>
              <span className='text-muted-foreground text-xs'>
                {t('extractEntities.selectedCount', {
                  selected: selectedCount,
                  total: items.length,
                })}
              </span>
              <div className='flex gap-2'>
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={() => {
                    const allSelected = items.every((i) => i.selected)
                    setItems(
                      items.map((i) => ({ ...i, selected: !allSelected })),
                    )
                  }}
                >
                  {t('extractEntities.toggleAll')}
                </Button>
                <Button variant='ghost' size='sm' onClick={onClose}>
                  {t('extractEntities.close')}
                </Button>
                <Button
                  variant='default'
                  size='sm'
                  disabled={applying || selectedCount === 0}
                  onClick={() => void applySelected()}
                >
                  {applying && (
                    <Loader2Icon className='size-3.5 animate-spin' />
                  )}
                  {t('extractEntities.applyButton', { count: selectedCount })}
                </Button>
              </div>
            </>
          ) : (
            <Button
              variant='ghost'
              size='sm'
              onClick={onClose}
              className='ml-auto'
            >
              {t('extractEntities.close')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
