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
    <div className="flex h-full flex-col gap-2 p-1">
      {/* Scrollable List of History Steps */}
      <ScrollArea className="flex-1 border rounded bg-card/45 max-h-[calc(100vh-320px)] min-h-[140px]">
        {allSteps.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-6 text-muted-foreground text-xs gap-1">
            <span>No Actions Yet</span>
          </div>
        ) : (
          <div className="flex flex-col">
            {allSteps.map((step, idx) => {
              const isFuture = idx > currentIdx
              const isActive = idx === currentIdx
              
              return (
                <button
                  key={step.id}
                  onClick={() => jumpToHistory(step.id, updateTextBlocks)}
                  className={`flex items-center gap-2.5 px-3 py-2 text-left text-[11px] border-b border-border/30 last:border-b-0 transition-colors w-full ${
                    isActive
                      ? 'bg-primary/10 border-l-2 border-l-primary font-bold text-foreground'
                      : isFuture
                      ? 'text-muted-foreground/40 line-through decoration-muted-foreground/20 opacity-60 hover:bg-accent/20'
                      : 'text-foreground hover:bg-accent/40'
                  }`}
                >
                  {/* Step Icon / Index */}
                  <span className={`text-[9px] font-mono shrink-0 w-3 text-center ${
                    isActive ? 'text-primary' : 'text-muted-foreground/50'
                  }`}>
                    {idx === 0 ? <RotateCcwIcon className="size-2.5 inline" /> : idx}
                  </span>
                  
                  {/* Step Description */}
                  <span className="truncate flex-1">{step.name}</span>
                </button>
              )
            })}
          </div>
        )}
      </ScrollArea>

      {/* Undo / Redo buttons */}
      <div className="flex gap-2 shrink-0">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={historyPast.length <= 1}
          onClick={() => undo(updateTextBlocks)}
          className="flex-1 gap-1 h-8 text-[11px]"
        >
          <UndoIcon className="size-3" />
          {t('history.undo', 'Undo')}
        </Button>
        
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={historyFuture.length === 0}
          onClick={() => redo(updateTextBlocks)}
          className="flex-1 gap-1 h-8 text-[11px]"
        >
          <RedoIcon className="size-3" />
          {t('history.redo', 'Redo')}
        </Button>
      </div>
    </div>
  )
}
