'use client'

import React, { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { TextBlock } from '@/types'
import {
  AlertTriangleIcon,
  ArrowDown,
  ArrowUp,
  Download,
  ExpandIcon,
  Languages,
  LoaderCircleIcon,
  Lock,
  Unlock,
  Upload,
  Eye,
  EyeOff,
} from 'lucide-react'
import { bubbleFitWarning } from '@/lib/services/bubbleFit'
import { fileSave } from 'browser-fs-access'
import { useTextBlocks } from '@/hooks/useTextBlocks'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { useLlmReadyQuery } from '@/lib/query/hooks'
import { useLlmMutations } from '@/lib/query/mutations'
import { flushAllSyncQueues } from '@/lib/services/syncQueues'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query/keys'
import { api } from '@/lib/api'
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
import { DraftTextarea } from '@/components/ui/draft-textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Slider } from '@/components/ui/slider'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

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
  const viewportRef = useRef<HTMLDivElement>(null)

  const rowVirtualizer = useVirtualizer({
    count: textBlocks.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => 36,
    overscan: 10,
  })

  React.useEffect(() => {
    if (selectedBlockIndex !== undefined && selectedBlockIndex >= 0 && selectedBlockIndex < textBlocks.length) {
      rowVirtualizer.scrollToIndex(selectedBlockIndex, { align: 'auto' })
    }
  }, [selectedBlockIndex, textBlocks.length, rowVirtualizer])
  const { t } = useTranslation()
  const { llmGenerate } = useLlmMutations()
  const { data: llmReady = false } = useLlmReadyQuery()
  const { cloudProvider } = usePreferencesStore()
  const { readingOrder, setReadingOrder, currentDocumentIndex } =
    useEditorUiStore()
  const queryClient = useQueryClient()
  const [generatingIndex, setGeneratingIndex] = useState<number | null>(null)

  const handleMoveBlock = async (index: number, direction: 'up' | 'down') => {
    const nextIndex = direction === 'up' ? index - 1 : index + 1
    if (nextIndex < 0 || nextIndex >= textBlocks.length) return
    const updatedBlocks = [...textBlocks]
    const temp = updatedBlocks[index]
    updatedBlocks[index] = updatedBlocks[nextIndex]
    updatedBlocks[nextIndex] = temp
    await replaceAllBlocks(updatedBlocks)
    setSelectedBlockIndex(nextIndex)
  }

  const handleMoveBlockToIndex = async (fromIndex: number, toIndex: number) => {
    if (
      fromIndex < 0 ||
      fromIndex >= textBlocks.length ||
      toIndex < 0 ||
      toIndex >= textBlocks.length
    )
      return
    if (fromIndex === toIndex) return
    const targetBlock = textBlocks[fromIndex]
    if (targetBlock.locked) return
    const updatedBlocks = [...textBlocks]
    updatedBlocks.splice(fromIndex, 1)
    updatedBlocks.splice(toIndex, 0, targetBlock)
    await replaceAllBlocks(updatedBlocks)
    setSelectedBlockIndex(toIndex)
  }

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

  /**
   * [handleGenerate] — เรียก LLM แปล bubble เดียว พร้อมส่ง style
   *
   * เป็น wrapper บาง ๆ รอบ llmGenerate() เพื่อจัดการสถานะ generating
   * (แสดง spinner ระหว่างรอ, ซ่อนเมื่อเสร็จ) โดยไม่ต้องยุ่งกับ
   * logic การแปลโดยตรง — ทุกอย่างเดินทางผ่าน mutations.ts → cloudLlm.ts
   *
   * @param style - ถ้าผู้ใช้กด '⚔️ โชเน็น' จะส่ง 'shonen' มา
   *   ถ้ากด '💬 ทั่วไป' ส่ง 'standard', ถ้ากด '👔 สุภาพ' ส่ง 'polite'
   *   ปุ่ม Languages icon (🌐) จะส่ง 'standard' เป็น default
   */
  const handleGenerate = async (
    blockIndex: number,
    style?: 'standard' | 'shonen' | 'polite',
  ) => {
    setGeneratingIndex(blockIndex)
    try {
      await llmGenerate(undefined, undefined, blockIndex, style)
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
      translation: block.translation || '',
    }))
    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: 'application/json',
    })

    try {
      await fileSave(blob, {
        fileName: `khr_textblocks_${document.id}.json`,
        extensions: ['.json'],
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
      toast.error(t('textBlocks.importTooLarge', { max: 10 }))
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
          toast.error(t('textBlocks.importBadShape'))
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
          toast.error(t('textBlocks.importBadShape'))
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
        toast.error(
          t('textBlocks.importFailed', {
            message: err?.message ?? String(err),
          }),
        )
      } finally {
        resetInput()
      }
    }
    reader.readAsText(file)
  }

  const handleReadingOrderChange = async (val: string) => {
    const order = val as 'rtl' | 'ltr' | 'custom'
    setReadingOrder(order)
    if ((order === 'rtl' || order === 'ltr') && document) {
      try {
        await api.reorderTextBlocks(currentDocumentIndex, order)
        await queryClient.invalidateQueries({
          queryKey: queryKeys.documents.current(currentDocumentIndex),
        })
      } catch (err) {
        console.error('Failed to reorder text blocks:', err)
      }
    }
  }

  return (
    <div
      className='flex min-h-0 flex-1 flex-col'
      data-testid='panels-textblocks'
    >
      <div className='border-border text-muted-foreground flex items-center justify-between border-b px-2 py-1.5 text-xs font-semibold tracking-wide uppercase'>
        <div className='flex items-center gap-2'>
          <span data-testid='textblocks-count' data-count={textBlocks.length}>
            {t('textBlocks.title', { count: textBlocks.length })}
          </span>
          <Select value={readingOrder} onValueChange={handleReadingOrderChange}>
            <SelectTrigger className='bg-background/50 border-border/40 hover:bg-accent/50 h-6 w-24 px-2 py-0 text-[10px] backdrop-blur transition-colors'>
              <SelectValue placeholder={t('textBlocks.readingOrder')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='rtl' className='text-xs'>
                {t('textBlocks.readingOrderRtl', 'RTL')}
              </SelectItem>
              <SelectItem value='ltr' className='text-xs'>
                {t('textBlocks.readingOrderLtr', 'LTR')}
              </SelectItem>
              <SelectItem value='custom' className='text-xs'>
                {t('textBlocks.readingOrderCustom', 'Custom')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
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
            <TooltipContent side='bottom'>
              {t('textBlocks.exportJson')}
            </TooltipContent>
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
            <TooltipContent side='bottom'>
              {t('textBlocks.importJson')}
            </TooltipContent>
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
        viewportRef={viewportRef}
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
              className='relative w-full'
              style={{
                height: `${rowVirtualizer.getTotalSize()}px`,
              }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualItem) => {
                const index = virtualItem.index
                const block = textBlocks[index]
                if (!block) return null
                return (
                  <div
                    key={virtualItem.key}
                    data-index={index}
                    ref={rowVirtualizer.measureElement}
                    className='absolute top-0 left-0 w-full'
                    style={{
                      transform: `translateY(${virtualItem.start}px)`,
                    }}
                  >
                    <BlockCard
                      key={`${document.id}-${index}`}
                      block={block}
                      index={index}
                      selected={index === selectedBlockIndex}
                      onChange={(updates) => void replaceBlock(index, updates)}
                      onGenerate={(style) => void handleGenerate(index, style)}
                      onFitToBubble={() => void fitBlockToBubble(index)}
                      onMoveBlock={(direction) =>
                        void handleMoveBlock(index, direction)
                      }
                      onMoveBlockToIndex={handleMoveBlockToIndex}
                      isFirst={index === 0}
                      isLast={index === textBlocks.length - 1}
                      generating={generatingIndex === index}
                      llmReady={isLlmAvailable}
                    />
                  </div>
                )
              })}
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
  onGenerate: (style?: 'standard' | 'shonen' | 'polite') => void | Promise<void>
  onFitToBubble: () => void | Promise<void>
  onMoveBlock: (direction: 'up' | 'down') => void
  onMoveBlockToIndex: (fromIndex: number, toIndex: number) => void
  isFirst: boolean
  isLast: boolean
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
  onMoveBlock,
  onMoveBlockToIndex,
  isFirst,
  isLast,
  generating,
  llmReady,
}: BlockCardProps) {
  const { t } = useTranslation()
  const showHud = useEditorUiStore((state) => state.showHud)
  const hideHud = useEditorUiStore((state) => state.hideHud)
  const hasOcr = !!block.text?.trim()
  const hasTranslation = !!block.translation?.trim()
  const preview = block.translation?.trim() || block.text?.trim()
  const fit = bubbleFitWarning(block)

  const [isEditingName, setIsEditingName] = useState(false)
  const [editedName, setEditedName] = useState(
    block.name || `Block #${index + 1}`,
  )
  const [isDragOver, setIsDragOver] = useState(false)

  React.useEffect(() => {
    setEditedName(block.name || `Block #${index + 1}`)
  }, [block.name, index])

  return (
    <motion.div
      data-testid={`textblock-card-${index}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index, 5) * 0.03 }}
    >
      <div
        draggable={!block.locked}
        onDragStart={(e) => {
          if (block.locked) return
          e.dataTransfer.setData('text/plain', index.toString())
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragOver={(e) => {
          e.preventDefault()
          if (!block.locked) {
            setIsDragOver(true)
          }
        }}
        onDragLeave={() => {
          setIsDragOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setIsDragOver(false)
          const fromIndexStr = e.dataTransfer.getData('text/plain')
          if (fromIndexStr === '') return
          const fromIndex = parseInt(fromIndexStr, 10)
          onMoveBlockToIndex(fromIndex, index)
        }}
        className={`transition-all duration-150 ${
          isDragOver
            ? 'ring-primary scale-[0.98] rounded-sm ring-2 ring-offset-1'
            : ''
        }`}
      >
        <AccordionItem
          value={index.toString()}
          data-selected={selected}
          className={`bg-card/90 ring-border data-[selected=true]:ring-primary overflow-hidden rounded text-xs ring-1 transition-opacity ${
            block.visible === false ? 'opacity-60' : ''
          }`}
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

            {isEditingName ? (
              <input
                type='text'
                value={editedName}
                onChange={(e) => setEditedName(e.target.value)}
                onBlur={() => {
                  setIsEditingName(false)
                  if (editedName.trim() && editedName !== block.name) {
                    onChange({ name: editedName.trim() })
                  }
                }}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') {
                    setIsEditingName(false)
                    if (editedName.trim() && editedName !== block.name) {
                      onChange({ name: editedName.trim() })
                    }
                  } else if (e.key === 'Escape') {
                    setIsEditingName(false)
                    setEditedName(block.name || `Block #${index + 1}`)
                  }
                }}
                onClick={(e) => e.stopPropagation()}
                className='border-input bg-background focus:ring-primary h-5 w-28 shrink-0 rounded border px-1 text-[10px] font-medium focus:ring-1 focus:outline-none'
                autoFocus
              />
            ) : (
              <span
                className='shrink-0 cursor-pointer truncate text-[10px] font-semibold select-none hover:underline'
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  setIsEditingName(true)
                }}
                title='ดับเบิลคลิกเพื่อเปลี่ยนชื่อบล็อก'
              >
                {block.name || `Block #${index + 1}`}
              </span>
            )}

            <div className='ml-1 flex min-w-0 flex-1 items-center gap-1 overflow-hidden'>
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
                  <TooltipContent
                    side='top'
                    className='max-w-[260px] text-[10px]'
                  >
                    {fit.reason}
                  </TooltipContent>
                </Tooltip>
              )}
              {preview && (
                <p className='text-muted-foreground ml-1 line-clamp-1 min-w-0 flex-1 text-[10px]'>
                  {preview}
                </p>
              )}
            </div>

            <Button
              variant='ghost'
              size='icon-xs'
              className='hover:bg-accent/80 hover:text-foreground text-muted-foreground/60 ml-auto size-5 shrink-0'
              onClick={(e) => {
                e.stopPropagation()
                onChange({ visible: block.visible === false })
              }}
              title={
                block.visible === false
                  ? 'แสดงบล็อกข้อความ'
                  : 'ซ่อนบล็อกข้อความ'
              }
            >
              {block.visible === false ? (
                <EyeOff className='size-3 text-rose-500' />
              ) : (
                <Eye className='size-3 opacity-40 hover:opacity-100' />
              )}
            </Button>

            <Button
              variant='ghost'
              size='icon-xs'
              className='hover:bg-accent/80 hover:text-foreground text-muted-foreground/60 size-5 shrink-0'
              onClick={(e) => {
                e.stopPropagation()
                onChange({ locked: !block.locked })
              }}
              title={block.locked ? 'ปลดล็อกบล็อกข้อความ' : 'ล็อกบล็อกข้อความ'}
            >
              {block.locked ? (
                <Lock className='size-3 fill-rose-500/10 text-rose-500' />
              ) : (
                <Unlock className='size-3 opacity-40 hover:opacity-100' />
              )}
            </Button>
          </AccordionTrigger>
          <AccordionContent className='px-2 pt-1.5 pb-2 shadow-[inset_0_1px_0_0_var(--color-border)]'>
            <div className='space-y-1.5'>
              <div className='flex flex-col gap-0.5'>
                <div className='flex items-center justify-between'>
                  <span className='text-muted-foreground text-[10px] uppercase'>
                    {t('textBlocks.ocrLabel')}
                  </span>
                  {block.locked && (
                    <span className='flex items-center gap-0.5 text-[9px] font-medium text-rose-500/70'>
                      <Lock className='size-2.5' /> ล็อกอยู่
                    </span>
                  )}
                </div>
                <DraftTextarea
                  data-testid={`textblock-ocr-${index}`}
                  value={block.text ?? ''}
                  placeholder={t('textBlocks.addOcrPlaceholder')}
                  rows={2}
                  disabled={block.locked}
                  onValueChange={(value) => onChange({ text: value })}
                  className='min-h-0 resize-none px-1.5 py-1 text-xs'
                />
              </div>
              <div className='flex flex-col gap-0.5'>
                <div className='flex items-center justify-between gap-1'>
                  <span className='text-muted-foreground text-[10px] uppercase'>
                    {t('textBlocks.translationLabel')}
                  </span>

                  {llmReady && (
                    <div className='bg-muted/60 border-border/40 flex items-center gap-0.5 rounded border p-0.5 select-none'>
                      <button
                        type='button'
                        disabled={generating || block.locked}
                        onClick={() => onGenerate('standard')}
                        className='hover:bg-background/80 text-muted-foreground hover:text-foreground rounded px-1 py-0.5 text-[9px] transition disabled:opacity-40'
                        title='แปลสไตล์ทั่วไป (Standard)'
                      >
                        💬 ทั่วไป
                      </button>
                      <button
                        type='button'
                        disabled={generating || block.locked}
                        onClick={() => onGenerate('shonen')}
                        className='hover:bg-background/80 text-muted-foreground hover:text-foreground rounded px-1 py-0.5 text-[9px] font-medium transition disabled:opacity-40'
                        title='แปลสไตล์ต่อสู้/โชเน็น (Shonen)'
                      >
                        ⚔️ โชเน็น
                      </button>
                      <button
                        type='button'
                        disabled={generating || block.locked}
                        onClick={() => onGenerate('polite')}
                        className='hover:bg-background/80 text-muted-foreground hover:text-foreground rounded px-1 py-0.5 text-[9px] transition disabled:opacity-40'
                        title='แปลสไตล์สุภาพ (Polite)'
                      >
                        👔 สุภาพ
                      </button>
                    </div>
                  )}

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        data-testid={`textblock-generate-${index}`}
                        variant='ghost'
                        size='icon-xs'
                        disabled={!llmReady || generating || block.locked}
                        onClick={() => onGenerate('standard')}
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
                  disabled={block.locked}
                  onValueChange={(value) => onChange({ translation: value })}
                  className='min-h-0 resize-none px-1.5 py-1 text-xs'
                />
              </div>
              <div className='flex flex-col gap-1.5 pt-1'>
                <div className='flex items-center justify-between'>
                  <span
                    className={`text-muted-foreground text-[10px] uppercase transition-colors select-none ${
                      block.locked
                        ? 'cursor-not-allowed'
                        : 'hover:text-primary cursor-ew-resize'
                    }`}
                    title={block.locked ? undefined : 'Drag to adjust rotation'}
                    onMouseDown={(e) => {
                      if (block.locked) return
                      e.preventDefault()
                      const startX = e.clientX
                      const startVal = block.rotationDeg ?? 0
                      const handleMouseMove = (moveEvent: MouseEvent) => {
                        const deltaX = moveEvent.clientX - startX
                        const nextVal = Math.max(
                          -180,
                          Math.min(180, startVal + deltaX),
                        )
                        onChange({ rotationDeg: nextVal })
                        showHud(`Angle: ${nextVal}°`)
                      }
                      const handleMouseUp = () => {
                        window.removeEventListener('mousemove', handleMouseMove)
                        window.removeEventListener('mouseup', handleMouseUp)
                        hideHud()
                      }
                      window.addEventListener('mousemove', handleMouseMove)
                      window.addEventListener('mouseup', handleMouseUp)
                    }}
                  >
                    {t('textBlocks.rotationLabel')}
                  </span>
                  <span className='text-muted-foreground text-[10px] tabular-nums'>
                    {block.rotationDeg ?? 0}°
                  </span>
                </div>
                <Slider
                  value={[block.rotationDeg ?? 0]}
                  min={-180}
                  max={180}
                  step={1}
                  disabled={block.locked}
                  onValueChange={([val]) => onChange({ rotationDeg: val })}
                  className='py-2'
                />
              </div>
              <div className='flex gap-1.5 pt-1'>
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => onMoveBlock('up')}
                  disabled={isFirst || block.locked}
                  className='h-7 flex-1 gap-1 text-[10px]'
                >
                  <ArrowUp className='size-3' />
                  เลื่อนขึ้น
                </Button>
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => onMoveBlock('down')}
                  disabled={isLast || block.locked}
                  className='h-7 flex-1 gap-1 text-[10px]'
                >
                  <ArrowDown className='size-3' />
                  เลื่อนลง
                </Button>
              </div>
              <Button
                variant='outline'
                size='sm'
                onClick={() => void onFitToBubble()}
                disabled={block.locked}
                className='h-7 w-full gap-1 text-[10px]'
                title={t('textBlocks.fitToBubbleTooltip')}
              >
                <ExpandIcon className='size-3' />
                {t('textBlocks.fitToBubble')}
              </Button>
            </div>
          </AccordionContent>
        </AccordionItem>
      </div>
    </motion.div>
  )
}
