'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronLeftCircleIcon,
  Loader2Icon,
  SparklesIcon,
} from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query/keys'
import { useTextBlockMutations } from '@/lib/query/mutations'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import {
  generateCloudTranslationDetailed,
  type ProviderOverride,
  type TranslationMeta,
} from '@/lib/services/cloudLlm'
import type { TextBlock } from '@/types'

type Filter = 'all' | 'untranslated' | 'translated'

/**
 * QA review page — paginates through every page in the current workspace
 * and shows a two-column table (source · translation) optimised for
 * proofreading. Edits save back to the document via the existing
 * text-block mutations.
 */
export default function QaPage() {
  const queryClient = useQueryClient()
  const [pageIdx, setPageIdx] = useState(() => useEditorUiStore.getState().currentDocumentIndex)
  const [filter, setFilter] = useState<Filter>('all')
  const { t } = useTranslation()

  const docsCount = useQuery({
    queryKey: queryKeys.documents.count,
    queryFn: () => api.getDocumentsCount(),
  })
  const totalPages = docsCount.data ?? 0

  // Clamp page index whenever the workspace size changes.
  useEffect(() => {
    if (totalPages === 0) setPageIdx(0)
    else if (pageIdx >= totalPages) setPageIdx(totalPages - 1)
  }, [totalPages, pageIdx])

  const currentDoc = useQuery({
    queryKey: queryKeys.documents.current(pageIdx),
    queryFn: () => api.getDocument(pageIdx),
    enabled: totalPages > 0,
  })

  const blocks: TextBlock[] = (currentDoc.data?.textBlocks ?? []) as TextBlock[]

  const filteredIndexes = useMemo(() => {
    return blocks
      .map((b, i) => ({ i, b }))
      .filter(({ b }) => {
        const hasTranslation = !!(b.translation && b.translation.trim())
        if (filter === 'translated') return hasTranslation
        if (filter === 'untranslated') return !hasTranslation
        return true
      })
      .map(({ i }) => i)
  }, [blocks, filter])

  // Reset editor's current document when navigating so other panels stay in sync.
  useEffect(() => {
    useEditorUiStore.getState().setCurrentDocumentIndex(pageIdx)
  }, [pageIdx])

  const translatedCount = blocks.filter((b) => b.translation?.trim()).length

  return (
    <div className='bg-muted flex flex-1 flex-col overflow-hidden'>
      <header className='border-border bg-background flex items-center gap-3 border-b px-4 py-2'>
        <Link
          href='/'
          prefetch={false}
          className='text-muted-foreground hover:bg-accent hover:text-foreground flex size-8 items-center justify-center rounded-full transition'
          title='Back to editor'
        >
          <ChevronLeftCircleIcon className='size-5' />
        </Link>
        <h1 className='text-foreground flex-1 text-sm font-bold'>
          {t('qa.title', 'QA review')}
          {totalPages > 0 && (
            <span className='text-muted-foreground ml-2 text-xs font-normal'>
              ·{' '}
              {t('qa.pageOf', {
                defaultValue: 'page {{current}} / {{total}}',
                current: pageIdx + 1,
                total: totalPages,
              })}{' '}
              ·{' '}
              {t('qa.translatedOf', {
                defaultValue: '{{translated}} / {{total}} translated',
                translated: translatedCount,
                total: blocks.length,
              })}
            </span>
          )}
        </h1>
        <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <SelectTrigger className='w-32'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>{t('qa.filterAll', 'All blocks')}</SelectItem>
            <SelectItem value='untranslated'>
              {t('qa.filterUntranslated', 'Untranslated')}
            </SelectItem>
            <SelectItem value='translated'>
              {t('qa.filterTranslated', 'Translated')}
            </SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant='ghost'
          size='sm'
          onClick={() => setPageIdx((p) => Math.max(0, p - 1))}
          disabled={pageIdx === 0}
        >
          <ChevronLeftIcon className='size-4' />
        </Button>
        <Button
          variant='ghost'
          size='sm'
          onClick={() => setPageIdx((p) => Math.min(totalPages - 1, p + 1))}
          disabled={pageIdx >= totalPages - 1}
        >
          <ChevronRightIcon className='size-4' />
        </Button>
      </header>

      <ScrollArea className='min-h-0 min-w-0 flex-1'>
        <div className='p-4'>
          {totalPages === 0 ? (
            <p className='text-muted-foreground text-center text-sm'>
              No documents loaded. Open a .khr or images via File menu.
            </p>
          ) : currentDoc.isLoading ? (
            <p className='text-muted-foreground text-center text-sm'>Loading…</p>
          ) : blocks.length === 0 ? (
            <p className='text-muted-foreground text-center text-sm'>
              No text blocks on this page. Run Detect / OCR first.
            </p>
          ) : filteredIndexes.length === 0 ? (
            <p className='text-muted-foreground text-center text-sm'>
              No blocks match filter "{filter}".
            </p>
          ) : (
            <table className='bg-card border-border w-full overflow-hidden rounded-lg border text-left text-xs'>
              <thead className='bg-muted/50 text-muted-foreground'>
                <tr>
                  <th className='w-10 px-3 py-2 font-medium'>#</th>
                  <th className='px-3 py-2 font-medium'>Source</th>
                  <th className='px-3 py-2 font-medium'>Translation</th>
                  <th className='w-12 px-3 py-2 font-medium'></th>
                </tr>
              </thead>
              <tbody>
                {filteredIndexes.map((i) => (
                  <QaRow
                    key={`${pageIdx}-${i}`}
                    block={blocks[i]}
                    blockIndex={i}
                    pageIdx={pageIdx}
                    onAfterChange={() =>
                      void queryClient.invalidateQueries({
                        queryKey: queryKeys.documents.current(pageIdx),
                      })
                    }
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

function QaRow({
  block,
  blockIndex,
  pageIdx,
  onAfterChange,
}: {
  block: TextBlock
  blockIndex: number
  pageIdx: number
  onAfterChange: () => void
}) {
  const { updateTextBlocks } = useTextBlockMutations()
  const [draft, setDraft] = useState(block.translation ?? '')
  const [generating, setGenerating] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [meta, setMeta] = useState<TranslationMeta | null>(null)
  const cloudProvider = usePreferencesStore((s) => s.cloudProvider)

  // Re-sync the draft if the block reloads with a different translation
  // (e.g. after re-translation), but don't overwrite mid-edit.
  useEffect(() => {
    if (!streaming) setDraft(block.translation ?? '')
  }, [block.translation, streaming])

  const saveDraft = async () => {
    if ((block.translation ?? '') === draft) return
    // Reuse the canonical update path so the renderer / sync queue fires.
    const allBlocks = await api.getDocument(pageIdx).then((d: any) => d.textBlocks ?? [])
    const next = allBlocks.map((b: TextBlock, j: number) =>
      j === blockIndex ? { ...b, translation: draft } : b,
    )
    await updateTextBlocks(next, pageIdx)
    onAfterChange()
  }

  const retranslate = async (override?: ProviderOverride) => {
    if (!block.text?.trim()) return
    setGenerating(true)
    setStreaming(true)
    try {
      if (cloudProvider !== 'none' || override) {
        // Stream directly into the textarea so the user sees text
        // arriving live, then persist once at the end.
        let acc = ''
        setDraft('')
        const result = await generateCloudTranslationDetailed(
          block.text,
          'auto',
          (delta) => {
            acc += delta
            setDraft(acc)
          },
          override,
        )
        setMeta(result.meta)
        const allBlocks = await api
          .getDocument(pageIdx)
          .then((d: any) => d.textBlocks ?? [])
        const next = allBlocks.map((b: TextBlock, j: number) =>
          j === blockIndex ? { ...b, translation: result.text } : b,
        )
        await updateTextBlocks(next, pageIdx)
        setDraft(result.text)
      } else {
        // Local LLM path: no streaming surface yet, just call the
        // existing pipeline and wait for it.
        await api.llmGenerate(pageIdx, blockIndex)
      }
      onAfterChange()
    } catch (err) {
      console.error(err)
    } finally {
      setStreaming(false)
      setGenerating(false)
    }
  }

  return (
    <tr className='border-border border-t'>
      <td className='text-muted-foreground px-3 py-2 align-top'>{blockIndex + 1}</td>
      <td className='px-3 py-2 align-top whitespace-pre-wrap'>
        {block.text ?? <span className='opacity-50'>—</span>}
      </td>
      <td className='px-3 py-2 align-top'>
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void saveDraft()}
          placeholder='(empty)'
          className='min-h-12 text-xs'
        />
        {meta && <ProvenanceBadges meta={meta} />}
      </td>
      <td className='px-3 py-2 align-top text-right'>
        <div className='inline-flex'>
          <Button
            variant='ghost'
            size='sm'
            disabled={generating}
            title='Re-translate with current provider'
            onClick={() => void retranslate()}
            className='rounded-r-none pr-1'
          >
            {generating ? (
              <Loader2Icon className='size-3.5 animate-spin' />
            ) : (
              <SparklesIcon className='size-3.5' />
            )}
          </Button>
          <TranslateProfilePicker
            onPick={(o) => void retranslate(o)}
            disabled={generating}
          />
        </div>
      </td>
    </tr>
  )
}

function TranslateProfilePicker({
  onPick,
  disabled,
}: {
  onPick: (override: ProviderOverride) => void
  disabled?: boolean
}) {
  const profiles = useQuery({
    queryKey: ['project', 'profiles'],
    queryFn: () => api.providerProfilesList(),
    staleTime: 60_000,
  })
  const list = profiles.data ?? []

  if (list.length === 0) {
    return null
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant='ghost'
          size='sm'
          disabled={disabled}
          title='Translate with a different saved profile'
          className='rounded-l-none border-l border-l-border/40 pl-1 pr-1.5'
        >
          <ChevronDownIcon className='size-3' />
        </Button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-56 p-1'>
        <div className='text-muted-foreground px-2 py-1 text-[10px] font-semibold uppercase tracking-wide'>
          Translate with…
        </div>
        {list.map((p) => (
          <button
            key={p.id}
            onClick={async () => {
              try {
                const { apiKey } = await api.providerProfileSecretGet(p.id)
                if (!apiKey) {
                  alert(`Profile "${p.name}" has no API key in keyring.`)
                  return
                }
                onPick({
                  provider: p.provider,
                  apiKey,
                  apiUrl: p.apiUrl ?? '',
                  model: p.modelName,
                })
              } catch (err: any) {
                alert(err?.message ?? String(err))
              }
            }}
            className='hover:bg-accent flex w-full items-start gap-1 rounded-sm px-2 py-1.5 text-left text-xs transition'
          >
            <span className='min-w-0 flex-1'>
              <span className='block truncate font-medium'>{p.name}</span>
              <span className='text-muted-foreground block truncate text-[10px]'>
                {p.provider} · {p.modelName}
              </span>
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

function ProvenanceBadges({ meta }: { meta: TranslationMeta }) {
  const badges: React.ReactNode[] = []
  if (meta.tmHit) {
    const pct =
      meta.tmSimilarity != null && meta.tmSimilarity < 1
        ? ` ${Math.round(meta.tmSimilarity * 100)}%`
        : ''
    const from =
      meta.tmFromChapterId != null ? ` · ch${meta.tmFromChapterId}` : ''
    badges.push(
      <span
        key='tm'
        className='rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] text-emerald-700 dark:text-emerald-300'
        title='Reused from translation memory — no API call was made'
      >
        ♻️ TM{pct}
        {from}
      </span>,
    )
  }
  if (meta.glossaryHitIds.length > 0) {
    badges.push(
      <span
        key='glossary'
        className='bg-sky-500/15 text-sky-700 dark:text-sky-300 rounded px-1.5 py-0.5 text-[9px]'
        title='Glossary entries injected into the prompt'
      >
        📖 {meta.glossaryHitIds.length} glossary
      </span>,
    )
  }
  if (meta.rollingContextUsed) {
    badges.push(
      <span
        key='roll'
        className='bg-violet-500/15 text-violet-700 dark:text-violet-300 rounded px-1.5 py-0.5 text-[9px]'
        title='Prior chapter summaries injected as rolling context'
      >
        📍 chapter ctx
      </span>,
    )
  }
  if (meta.usage?.promptTokens != null || meta.durationMs > 0) {
    const u = meta.usage
    const tokens =
      u?.promptTokens != null && u.completionTokens != null
        ? ` · ${u.promptTokens} in / ${u.completionTokens} out`
        : ''
    badges.push(
      <span
        key='timing'
        className='text-muted-foreground text-[9px]'
        title='Wall-clock duration and token usage'
      >
        ⏱ {meta.durationMs} ms{tokens}
      </span>,
    )
  }
  if (badges.length === 0) return null
  return (
    <div className='mt-1 flex flex-wrap items-center gap-1'>{badges}</div>
  )
}
