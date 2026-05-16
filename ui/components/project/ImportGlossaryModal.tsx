'use client'

import { useMemo, useState } from 'react'
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
  | { ok: true; items: GlossaryAddInput[] }
  | { ok: false; error: string }

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

function parseCsv(text: string): Parsed {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length === 0) return { ok: false, error: 'CSV is empty.' }
  const header = splitCsvLine(lines[0]).map((s) => s.toLowerCase())
  const required = ['source', 'target', 'category']
  for (const k of required) {
    if (!header.includes(k))
      return {
        ok: false,
        error: `Missing required column "${k}" in CSV header.`,
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
  for (let l = 1; l < lines.length; l++) {
    const cells = splitCsvLine(lines[l])
    const source = cells[idx.source]?.trim()
    const target = cells[idx.target]?.trim()
    const category = cells[idx.category]?.trim()
    if (!source || !target || !category) continue
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
  return { ok: true, items }
}

function parseJson(text: string): Parsed {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err: any) {
    return { ok: false, error: `Invalid JSON: ${err?.message ?? String(err)}` }
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'JSON must be an array.' }
  }
  const items: GlossaryAddInput[] = []
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as any
    const source = String(r.source ?? r.sourceText ?? '').trim()
    const target = String(r.target ?? r.targetText ?? r.translation ?? '').trim()
    const category = String(r.category ?? 'term').trim()
    if (!source || !target) continue
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
  return { ok: true, items }
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
  const [format, setFormat] = useState<Format>('json')
  const [text, setText] = useState('')
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<{ inserted: number; skipped: number } | null>(
    null,
  )

  const parsed = useMemo(() => {
    if (!text.trim()) return null
    return format === 'csv' ? parseCsv(text) : parseJson(text)
  }, [text, format])

  if (!open) return null

  const itemCount = parsed?.ok ? parsed.items.length : 0

  const submit = async () => {
    if (!parsed?.ok || parsed.items.length === 0) return
    setImporting(true)
    try {
      const r = await api.glossaryBulkAdd(parsed.items)
      setResult(r)
      onImported(r)
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className='bg-background/80 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm'>
      <div className='bg-card border-border flex w-[42rem] max-w-[90vw] flex-col rounded-lg border shadow-lg'>
        <div className='border-border flex items-center gap-2 border-b p-4'>
          <UploadIcon className='text-primary size-4' />
          <h3 className='text-foreground text-sm font-bold'>Import glossary</h3>
        </div>

        <div className='space-y-3 p-4'>
          <div className='flex items-center gap-2'>
            <span className='text-foreground text-xs font-semibold'>Format</span>
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
              Insert example
            </Button>
          </div>

          <Textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setResult(null)
            }}
            placeholder={
              format === 'csv'
                ? 'source,target,category[,aliases][,notes]'
                : '[ { "source": "…", "target": "…", "category": "term" } ]'
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
              Parsed {itemCount} entr{itemCount === 1 ? 'y' : 'ies'}. Duplicates
              (same source + category) are skipped silently.
            </p>
          )}
          {result && (
            <div className='border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 rounded-md border p-2 text-xs'>
              ✅ Imported {result.inserted} new entr
              {result.inserted === 1 ? 'y' : 'ies'} · skipped {result.skipped}{' '}
              duplicate{result.skipped === 1 ? '' : 's'}
            </div>
          )}
        </div>

        {parsed?.ok && parsed.items.length > 0 && (
          <div className='border-border border-t'>
            <ScrollArea className='max-h-56'>
              <table className='w-full text-left text-xs'>
                <thead className='bg-muted/50 text-muted-foreground'>
                  <tr>
                    <th className='px-3 py-1 font-medium'>Source</th>
                    <th className='px-3 py-1 font-medium'>Target</th>
                    <th className='px-3 py-1 font-medium'>Category</th>
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
                        … and {parsed.items.length - 50} more
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
            Close
          </Button>
          <Button
            variant='default'
            size='sm'
            disabled={importing || itemCount === 0}
            onClick={() => void submit()}
          >
            {importing && <Loader2Icon className='size-3.5 animate-spin' />}
            Import {itemCount} entr{itemCount === 1 ? 'y' : 'ies'}
          </Button>
        </div>
      </div>
    </div>
  )
}
