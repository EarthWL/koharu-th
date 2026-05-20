'use client'

import React, { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { TextBlock } from '@/types'
import {
  AlertTriangleIcon,
  Download,
  ExpandIcon,
  Languages,
  LoaderCircleIcon,
  Upload,
} from 'lucide-react'
import { bubbleFitWarning } from '@/lib/services/bubbleFit'
import { fileSave } from 'browser-fs-access'
import { useTextBlocks } from '@/hooks/useTextBlocks'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import { useLlmReadyQuery } from '@/lib/query/hooks'
import { useLlmMutations } from '@/lib/query/mutations'
import { flushAllSyncQueues } from '@/lib/services/syncQueues'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { DraftTextarea } from '@/components/ui/draft-textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Slider } from '@/components/ui/slider'
import { Label } from '@/components/ui/label'

export function TextBlocksPanel() {
  const {
    document,
    textBlocks,
    selectedBlockIndex,
    setSelectedBlockIndex,
    replaceBlock,
    replaceAllBlocks,
    fitBlockToBubble,
  } = useTextBlocks()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { t } = useTranslation()
  const { llmGenerate } = useLlmMutations()
  const { data: llmReady = false } = useLlmReadyQuery()
  const { cloudProvider } = usePreferencesStore()
  const [generatingIndex, setGeneratingIndex] = useState<number | null>(null)
  
  const isLlmAvailable = llmReady || cloudProvider !== 'none'

  if (!document) {
    return (
      <div className='text-muted-foreground flex flex-1 items-center justify-center text-xs'>
        {t('textBlocks.emptyPrompt')}
      </div>
    )
  }

  const accordionValue =
    selectedBlockIndex !== undefined ? selectedBlockIndex.toString() : ''

  const handleGenerate = async (blockIndex: number) => {
    setGeneratingIndex(blockIndex)
    try {
      await llmGenerate(undefined, undefined, blockIndex)
    } catch (error) {
      console.error(error)
    } finally {
      setGeneratingIndex(null)
    }
  }

  const handleExportJson = async () => {
    if (!document) return
    const exportData = textBlocks.map((block, index) => ({
      index,
      text: block.text || '',
      translation: block.translation || ''
    }))
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
    
    try {
      await fileSave(blob, { 
        fileName: `khr_textblocks_${document.id}.json`,
        extensions: ['.json']
      })
    } catch (err) {
      console.error('Export cancelled or failed:', err)
    }
  }

  const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // 10 MB cap — a slim {index, text, translation} export of a normal
    // page tops out around 50 KB. Anything larger is almost certainly
    // the wrong file picked by mistake; bail before FileReader spends
    // memory on it.
    const MAX_BYTES = 10 * 1024 * 1024
    if (file.size > MAX_BYTES) {
      alert(t('textBlocks.importTooLarge', { max: 10 }))
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }

    const reader = new FileReader()
    reader.onload = async (event) => {
      const resetInput = () => {
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
      try {
        const text = event.target?.result as string
        const parsed = JSON.parse(text)
        if (!Array.isArray(parsed)) {
          alert(t('textBlocks.importBadShape'))
          return
        }
        // Validate the row shape so a malformed file doesn't quietly
        // overwrite blocks with `undefined ?? block.text` (which would
        // be a no-op) or — worse — `null ?? block.text` shenanigans.
        const validShape = parsed.every(
          (row: any) =>
            row && typeof row === 'object' && typeof row.index === 'number',
        )
        if (!validShape) {
          alert(t('textBlocks.importBadShape'))
          return
        }
        // Drain pending per-block edits before issuing the bulk write —
        // otherwise a debounced keystroke in flight from before the
        // import would land AFTER the bulk replace and silently clobber
        // the imported row.
        await flushAllSyncQueues().catch(() => {})
        const updatedBlocks = textBlocks.map((block, idx) => {
          const importedBlock = parsed.find((p: any) => p.index === idx)
          if (importedBlock) {
            return {
              ...block,
              text: importedBlock.text ?? block.text,
              translation: importedBlock.translation ?? block.translation,
            }
          }
          return block
        })
        await replaceAllBlocks(updatedBlocks)
      } catch (err: any) {
        alert(
          t('textBlocks.importFailed', { message: err?.message ?? String(err) }),
        )
      } finally {
        resetInput()
      }
    }
    reader.readAsText(file)
  }

  return (
    <div
      className='flex min-h-0 flex-1 flex-col'
      data-testid='panels-textblocks'
    >
      <div className='border-border text-muted-foreground flex items-center justify-between border-b px-2 py-1.5 text-xs font-semibold tracking-wide uppercase'>
        <span data-testid='textblocks-count' data-count={textBlocks.length}>
          {t('textBlocks.title', { count: textBlocks.length })}
        </span>
        <div className='flex items-center gap-1'>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant='ghost'
                size='icon-xs'
                className='size-5'
                onClick={handleExportJson}
              >
                <Download className='size-3' />
              </Button>
            </TooltipTrigger>
            <TooltipContent side='bottom'>{t('textBlocks.exportJson')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant='ghost'
                size='icon-xs'
                className='size-5'
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className='size-3' />
              </Button>
            </TooltipTrigger>
            <TooltipContent side='bottom'>{t('textBlocks.importJson')}</TooltipContent>
          </Tooltip>
          <input
            type='file'
            accept='.json'
            className='hidden'
            ref={fileInputRef}
            onChange={handleImportJson}
          />
        </div>
      </div>
      <ScrollArea
        className='min-h-0 flex-1'
        viewportClassName='pb-1'
        data-testid='textblocks-scroll'
      >
        <div className='p-2'>
          {textBlocks.length === 0 ? (
            <p className='border-border text-muted-foreground rounded border border-dashed p-2 text-xs'>
              {t('textBlocks.none')}
            </p>
          ) : (
            <Accordion
              data-testid='textblocks-accordion'
              type='single'
              collapsible
              value={accordionValue}
              onValueChange={(value) => {
                if (!value) {
                  setSelectedBlockIndex(undefined)
                  return
                }
                setSelectedBlockIndex(Number(value))
              }}
              className='flex flex-col gap-1'
            >
              {textBlocks.map((block, index) => (
                <BlockCard
                  key={`${document.id}-${index}`}
                  block={block}
                  index={index}
                  selected={index === selectedBlockIndex}
                  onChange={(updates) => void replaceBlock(index, updates)}
                  onGenerate={() => void handleGenerate(index)}
                  onFitToBubble={() => void fitBlockToBubble(index)}
                  generating={generatingIndex === index}
                  llmReady={isLlmAvailable}
                />
              ))}
            </Accordion>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

type BlockCardProps = {
  block: TextBlock
  index: number
  selected: boolean
  onChange: (updates: Partial<TextBlock>) => void
  onGenerate: () => void | Promise<void>
  onFitToBubble: () => void | Promise<void>
  generating: boolean
  llmReady: boolean
}

function BlockCard({
  block,
  index,
  selected,
  onChange,
  onGenerate,
  onFitToBubble,
  generating,
  llmReady,
}: BlockCardProps) {
  const { t } = useTranslation()
  const hasOcr = !!block.text?.trim()
  const hasTranslation = !!block.translation?.trim()
  const preview = block.translation?.trim() || block.text?.trim()
  const fit = bubbleFitWarning(block)

  return (
    <motion.div
      data-testid={`textblock-card-${index}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: index * 0.03 }}
    >
      <AccordionItem
        value={index.toString()}
        data-selected={selected}
        className='bg-card/90 ring-border data-[selected=true]:ring-primary overflow-hidden rounded text-xs ring-1'
      >
        <AccordionTrigger className='data-[state=open]:bg-accent flex w-full cursor-pointer items-center gap-1.5 px-2 py-1.5 text-left transition outline-none hover:no-underline [&>svg]:hidden'>
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-center text-[10px] font-medium text-white tabular-nums ${
              selected ? 'bg-primary' : 'bg-muted-foreground/60'
            }`}
            style={{ minWidth: '1.5rem' }}
          >
            {index + 1}
          </span>
          <div className='flex min-w-0 flex-1 items-center gap-1'>
            <span
              className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-medium uppercase ${
                hasOcr
                  ? 'bg-rose-400/80 text-white'
                  : 'bg-muted text-muted-foreground/50'
              }`}
            >
              {t('textBlocks.ocrBadge')}
            </span>
            <span
              className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-medium uppercase ${
                hasTranslation
                  ? 'bg-rose-400/80 text-white'
                  : 'bg-muted text-muted-foreground/50'
              }`}
            >
              {t('textBlocks.translationBadge')}
            </span>
            {fit && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={`flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium uppercase ${
                      fit.level === 'overflow'
                        ? 'bg-rose-500 text-white'
                        : 'bg-amber-400 text-black'
                    }`}
                  >
                    <AlertTriangleIcon className='size-2.5' />
                    {fit.level === 'overflow'
                      ? t('textBlocks.fitOverflow')
                      : t('textBlocks.fitTight')}
                  </span>
                </TooltipTrigger>
                <TooltipContent side='top' className='max-w-[260px] text-[10px]'>
                  {fit.reason}
                </TooltipContent>
              </Tooltip>
            )}
            {preview && (
              <p className='text-muted-foreground line-clamp-1 min-w-0 flex-1 text-xs'>
                {preview}
              </p>
            )}
          </div>
        </AccordionTrigger>
        <AccordionContent className='px-2 pt-1.5 pb-2 shadow-[inset_0_1px_0_0_var(--color-border)]'>
          <div className='space-y-1.5'>
            <div className='flex flex-col gap-0.5'>
              <span className='text-muted-foreground text-[10px] uppercase'>
                {t('textBlocks.ocrLabel')}
              </span>
              <DraftTextarea
                data-testid={`textblock-ocr-${index}`}
                value={block.text ?? ''}
                placeholder={t('textBlocks.addOcrPlaceholder')}
                rows={2}
                onValueChange={(value) => onChange({ text: value })}
                className='min-h-0 resize-none px-1.5 py-1 text-xs'
              />
            </div>
            <div className='flex flex-col gap-0.5'>
              <div className='flex items-center justify-between'>
                <span className='text-muted-foreground text-[10px] uppercase'>
                  {t('textBlocks.translationLabel')}
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      data-testid={`textblock-generate-${index}`}
                      variant='ghost'
                      size='icon-xs'
                      disabled={!llmReady || generating}
                      onClick={onGenerate}
                      className='size-5'
                      aria-label={t('textBlocks.generateAria')}
                    >
                      {generating ? (
                        <LoaderCircleIcon className='size-3 animate-spin' />
                      ) : (
                        <Languages className='size-3' />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side='left' sideOffset={4}>
                    {t('llm.generateTooltip')}
                  </TooltipContent>
                </Tooltip>
              </div>
              <DraftTextarea
                data-testid={`textblock-translation-${index}`}
                value={block.translation ?? ''}
                placeholder={t('textBlocks.addTranslationPlaceholder')}
                rows={2}
                onValueChange={(value) => onChange({ translation: value })}
                className='min-h-0 resize-none px-1.5 py-1 text-xs'
              />
            </div>
            <div className='flex flex-col gap-1.5 pt-1'>
              <div className='flex items-center justify-between gap-1'>
                <span className='text-muted-foreground text-[10px] uppercase'>
                  {t('textBlocks.rotationLabel')}
                </span>
                <div className='flex items-center gap-0.5'>
                  <Input
                    type='number'
                    min={-180}
                    max={180}
                    step={1}
                    value={block.rotationDeg ?? 0}
                    aria-label={t('textBlocks.rotationLabel')}
                    data-testid='block-rotation-input'
                    className='h-6 w-14 [appearance:textfield] px-1 text-center text-[11px] tabular-nums [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'
                    onChange={(e) => {
                      const parsed = Number.parseFloat(e.target.value)
                      if (!Number.isFinite(parsed)) return
                      // Wrap into (-180, 180] so typing 270 lands on -90.
                      let deg = ((parsed + 180) % 360 + 360) % 360 - 180
                      if (deg === -180) deg = 180
                      onChange({ rotationDeg: Math.round(deg) })
                    }}
                  />
                  <span className='text-muted-foreground text-[10px]'>°</span>
                </div>
              </div>
              <Slider
                value={[block.rotationDeg ?? 0]}
                min={-180}
                max={180}
                step={1}
                onValueChange={([val]) => onChange({ rotationDeg: val })}
                className='py-2'
              />
              {/* Snap-to-quadrant shortcuts (rotation slider is precise but
                  fiddly for exact 90° turns common with vertical SFX). */}
              <div className='flex items-center gap-0.5'>
                {[-90, 0, 90, 180].map((deg) => (
                  <Button
                    key={deg}
                    variant='outline'
                    size='sm'
                    data-testid={`block-rotation-snap-${deg}`}
                    className={cn(
                      'h-6 flex-1 px-0 text-[10px] tabular-nums',
                      (block.rotationDeg ?? 0) === deg &&
                        'bg-primary text-primary-foreground border-primary hover:bg-primary/90',
                    )}
                    onClick={() => onChange({ rotationDeg: deg })}
                  >
                    {deg}°
                  </Button>
                ))}
              </div>
            </div>
            <Button
              variant='outline'
              size='sm'
              onClick={() => void onFitToBubble()}
              className='h-7 w-full gap-1 text-[10px]'
              title={t('textBlocks.fitToBubbleTooltip')}
            >
              <ExpandIcon className='size-3' />
              {t('textBlocks.fitToBubble')}
            </Button>
          </div>
        </AccordionContent>
      </AccordionItem>
    </motion.div>
  )
}
