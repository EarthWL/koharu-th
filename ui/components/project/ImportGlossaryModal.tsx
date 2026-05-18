'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Loader2Icon, UploadIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, type GlossaryAddInput, type GlossaryCategory } from '@/lib/api'

type Format = 'json' | 'csv'
type Parsed =
  | { ok: true; items: GlossaryAddInput[]; skippedIncomplete: number }
  | { ok: false; error: string }

/** Strip a UTF-8 BOM if present. Excel and Google Sheets prefix CSV
 *  exports with one, which otherwise corrupts the first header name
 *  (e.g. "﻿source") and breaks the required-column check. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

const CATEGORIES: GlossaryCategory[] = [
  'term',
  'place',
  'skill',
  'honorific',
  'item',
  'org',
  'sfx',
]

const SAMPLE_JSON = `[
  {"source": "魔法剣", "target": "ดาบเวทย์", "category": "term"},
  {"source": "京都", "target": "เกียวโต", "category": "place"},
  {"source": "さん", "target": "-san", "category": "honorific"}
]`

const SAMPLE_CSV = `source,target,category,aliases,notes
魔法剣,ดาบเวทย์,term,,Main character's weapon
京都,เกียวโต,place,京の都,
さん,-san,honorific,,Keep romanized`

function normaliseCategory(s: string): GlossaryCategory {
  const v = s.toLowerCase().trim()
  return (CATEGORIES.includes(v as GlossaryCategory) ? v : 'term') as GlossaryCategory
}

/** Split a CSV line respecting quoted commas. Minimal but correct for
 *  "a,b","c, d",e style rows. */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') {
        inQuote = false
      } else {
        cur += ch
      }
    } else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else if (ch === '"' && cur === '') {
      inQuote = true
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

function parseCsv(text: string, t: TFunction): Parsed {
  const lines = stripBom(text)
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
  if (lines.length === 0)
    return { ok: false, error: t('glossaryImport.csvEmpty') }
  const header = splitCsvLine(lines[0]).map((s) => s.toLowerCase())
  const required = ['source', 'target', 'category']
  for (const k of required) {
    if (!header.includes(k))
      return {
        ok: false,
        error: t('glossaryImport.csvMissingColumn', { column: k }),
      }
  }
  const idx = {
    source: header.indexOf('source'),
    target: header.indexOf('target'),
    category: header.indexOf('category'),
    aliases: header.indexOf('aliases'),
    notes: header.indexOf('notes'),
  }
  const items: GlossaryAddInput[] = []
  let skippedIncomplete = 0
  for (let l = 1; l < lines.length; l++) {
    const cells = splitCsvLine(lines[l])
    const source = cells[idx.source]?.trim()
    const target = cells[idx.target]?.trim()
    const category = cells[idx.category]?.trim()
    if (!source || !target || !category) {
      skippedIncomplete++
      continue
    }
    items.push({
      sourceText: source,
      targetText: target,
      category: normaliseCategory(category),
      aliases:
        idx.aliases >= 0 && cells[idx.aliases]
          ? cells[idx.aliases]
              .split(/[|;]/)
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
      contextNote:
        idx.notes >= 0 && cells[idx.notes] ? cells[idx.notes] : null,
      confidence: 'manual',
      approved: true,
    })
  }
  return { ok: true, items, skippedIncomplete }
}

function parseJson(text: string, t: TFunction): Parsed {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripBom(text))
  } catch (err: any) {
    return {
      ok: false,
      error: t('glossaryImport.jsonInvalid', {
        message: err?.message ?? String(err),
      }),
    }
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: t('glossaryImport.jsonMustArray') }
  }
  const items: GlossaryAddInput[] = []
  let skippedIncomplete = 0
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') {
      skippedIncomplete++
      continue
    }
    const r = raw as any
    const source = String(r.source ?? r.sourceText ?? '').trim()
    const target = String(r.target ?? r.targetText ?? r.translation ?? '').trim()
    const category = String(r.category ?? 'term').trim()
    if (!source || !target) {
      skippedIncomplete++
      continue
    }
    const aliases = Array.isArray(r.aliases)
      ? r.aliases.map((a: any) => String(a).trim()).filter(Boolean)
      : []
    items.push({
      sourceText: source,
      targetText: target,
      category: normaliseCategory(category),
      aliases,
      contextNote: r.notes ?? r.contextNote ?? null,
      confidence: 'manual',
      approved: true,
    })
  }
  return { ok: true, items, skippedIncomplete }
}

export function ImportGlossaryModal({
  open,
  onClose,
  onImported,
}: {
  open: boolean
  onClose: () => void
  onImported: (result: { inserted: number; skipped: number }) => void
}) {
  const { t } = useTranslation()
  const [format, setFormat] = useState<Format>('json')
  const [text, setText] = useState('')
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<{ inserted: number; skipped: number } | null>(
    null,
  )
  const [importError, setImportError] = useState<string | null>(null)

  const parsed = useMemo(() => {
    if (!text.trim()) return null
    return format === 'csv' ? parseCsv(text, t) : parseJson(text, t)
  }, [text, format, t])

  // Esc-to-close — matches the modal a11y pattern used in Welcome /
  // CommandPalette. Listener only mounts while the modal is open to
  // avoid leaking global keydowns.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const itemCount = parsed?.ok ? parsed.items.length : 0
  const skippedIncomplete = parsed?.ok ? parsed.skippedIncomplete : 0

  const submit = async () => {
    if (!parsed?.ok || parsed.items.length === 0) return
    setImporting(true)
    setImportError(null)
    try {
      const r = await api.glossaryBulkAdd(parsed.items)
      setResult(r)
      onImported(r)
    } catch (err: any) {
      // Backend rejected the batch (schema mismatch / disk / SQLite
      // constraint). Surface inline so the user knows the spinner
      // stopped for a reason, not a silent success.
      setImportError(err?.message ?? String(err))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div
      role='dialog'
      aria-modal='true'
      aria-labelledby='import-glossary-title'
      className='bg-background/80 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm'
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className='bg-card border-border flex w-[42rem] max-w-[90vw] flex-col rounded-lg border shadow-lg'>
        <div className='border-border flex items-center gap-2 border-b p-4'>
          <UploadIcon className='text-primary size-4' />
          <h3
            id='import-glossary-title'
            className='text-foreground text-sm font-bold'
          >
            {t('glossaryImport.title')}
          </h3>
        </div>

        <div className='space-y-3 p-4'>
          <div className='flex items-center gap-2'>
            <span className='text-foreground text-xs font-semibold'>
              {t('glossaryImport.formatLabel')}
            </span>
            <Select value={format} onValueChange={(v) => setFormat(v as Format)}>
              <SelectTrigger className='w-32'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='json'>JSON</SelectItem>
                <SelectItem value='csv'>CSV</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant='ghost'
              size='sm'
              onClick={() => setText(format === 'csv' ? SAMPLE_CSV : SAMPLE_JSON)}
            >
              {t('glossaryImport.insertExample')}
            </Button>
          </div>

          <Textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setResult(null)
              setImportError(null)
            }}
            placeholder={
              format === 'csv'
                ? t('glossaryImport.placeholderCsv')
                : t('glossaryImport.placeholderJson')
            }
            className='min-h-40 font-mono text-xs'
          />

          {parsed && !parsed.ok && (
            <div className='border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-2 text-xs'>
              {parsed.error}
            </div>
          )}
          {parsed?.ok && (
            <p className='text-muted-foreground text-xs'>
              {t('glossaryImport.parsedSummary', { count: itemCount })}
            </p>
          )}
          {parsed?.ok && skippedIncomplete > 0 && (
            <div className='border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 rounded-md border p-2 text-xs'>
              ⚠{' '}
              {t('glossaryImport.skippedIncomplete', {
                count: skippedIncomplete,
              })}
            </div>
          )}
          {result && (
            <div className='border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 rounded-md border p-2 text-xs'>
              {t('glossaryImport.resultSuccess', {
                inserted: result.inserted,
                skipped: result.skipped,
              })}
            </div>
          )}
          {importError && (
            <div className='border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-2 text-xs'>
              {t('glossaryImport.importFailed', { message: importError })}
            </div>
          )}
        </div>

        {parsed?.ok && parsed.items.length > 0 && (
          <div className='border-border border-t'>
            <ScrollArea className='max-h-56'>
              <table className='w-full text-left text-xs'>
                <thead className='bg-muted/50 text-muted-foreground'>
                  <tr>
                    <th className='px-3 py-1 font-medium'>
                      {t('glossaryImport.thSource')}
                    </th>
                    <th className='px-3 py-1 font-medium'>
                      {t('glossaryImport.thTarget')}
                    </th>
                    <th className='px-3 py-1 font-medium'>
                      {t('glossaryImport.thCategory')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.items.slice(0, 50).map((it, i) => (
                    <tr key={i} className='border-border border-t'>
                      <td className='px-3 py-1 font-medium'>{it.sourceText}</td>
                      <td className='px-3 py-1'>{it.targetText}</td>
                      <td className='text-muted-foreground px-3 py-1'>
                        {it.category}
                      </td>
                    </tr>
                  ))}
                  {parsed.items.length > 50 && (
                    <tr>
                      <td
                        colSpan={3}
                        className='text-muted-foreground px-3 py-1 text-center text-[10px] italic'
                      >
                        {t('glossaryImport.moreRows', {
                          count: parsed.items.length - 50,
                        })}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </ScrollArea>
          </div>
        )}

        <div className='border-border flex justify-end gap-2 border-t p-3'>
          <Button variant='ghost' size='sm' onClick={onClose}>
            {t('glossaryImport.close')}
          </Button>
          <Button
            variant='default'
            size='sm'
            disabled={importing || itemCount === 0}
            onClick={() => void submit()}
          >
            {importing && <Loader2Icon className='size-3.5 animate-spin' />}
            {t('glossaryImport.importButton', { count: itemCount })}
          </Button>
        </div>
      </div>
    </div>
  )
}
