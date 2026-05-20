'use client'

import { useTranslation } from 'react-i18next'
import { UndoIcon, RedoIcon, RotateCcwIcon } from 'lucide-react'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { useTextBlockMutations } from '@/lib/query/mutations'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'

export function HistoryPanel() {
  const { t } = useTranslation()
  const historyPast = useEditorUiStore((state) => state.historyPast)
  const historyFuture = useEditorUiStore((state) => state.historyFuture)
  const undo = useEditorUiStore((state) => state.undo)
  const redo = useEditorUiStore((state) => state.redo)
  const jumpToHistory = useEditorUiStore((state) => state.jumpToHistory)
  const { updateTextBlocks } = useTextBlockMutations()

  const allSteps = [...historyPast, ...historyFuture]
  const currentIdx = historyPast.length - 1

  return (
    <div className='flex h-full flex-col gap-2 p-1'>
      {/* Scrollable List of History Steps */}
      <ScrollArea className='bg-card/45 max-h-[calc(100vh-320px)] min-h-[140px] flex-1 rounded border'>
        {allSteps.length === 0 ? (
          <div className='text-muted-foreground flex flex-col items-center justify-center gap-1 p-6 text-xs'>
            <span>No Actions Yet</span>
          </div>
        ) : (
          <div className='flex flex-col'>
            {allSteps.map((step, idx) => {
              const isFuture = idx > currentIdx
              const isActive = idx === currentIdx

              return (
                <button
                  key={step.id}
                  onClick={() => jumpToHistory(step.id, updateTextBlocks)}
                  className={`border-border/30 flex w-full items-center gap-2.5 border-b px-3 py-2 text-left text-[11px] transition-colors last:border-b-0 ${
                    isActive
                      ? 'bg-primary/10 border-l-primary text-foreground border-l-2 font-bold'
                      : isFuture
                        ? 'text-muted-foreground/40 decoration-muted-foreground/20 hover:bg-accent/20 line-through opacity-60'
                        : 'text-foreground hover:bg-accent/40'
                  }`}
                >
                  {/* Step Icon / Index */}
                  <span
                    className={`w-3 shrink-0 text-center font-mono text-[9px] ${
                      isActive ? 'text-primary' : 'text-muted-foreground/50'
                    }`}
                  >
                    {idx === 0 ? (
                      <RotateCcwIcon className='inline size-2.5' />
                    ) : (
                      idx
                    )}
                  </span>

                  {/* Step Description */}
                  <span className='flex-1 truncate'>{step.name}</span>
                </button>
              )
            })}
          </div>
        )}
      </ScrollArea>

      {/* Undo / Redo buttons */}
      <div className='flex shrink-0 gap-2'>
        <Button
          type='button'
          variant='outline'
          size='sm'
          disabled={historyPast.length <= 1}
          onClick={() => undo(updateTextBlocks)}
          className='h-8 flex-1 gap-1 text-[11px]'
        >
          <UndoIcon className='size-3' />
          {t('history.undo', 'Undo')}
        </Button>

        <Button
          type='button'
          variant='outline'
          size='sm'
          disabled={historyFuture.length === 0}
          onClick={() => redo(updateTextBlocks)}
          className='h-8 flex-1 gap-1 text-[11px]'
        >
          <RedoIcon className='size-3' />
          {t('history.redo', 'Redo')}
        </Button>
      </div>
    </div>
  )
}
