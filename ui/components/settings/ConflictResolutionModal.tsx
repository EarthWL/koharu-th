'use client'

import { useState, useEffect } from 'react'
import {
  ShieldAlert,
  ArrowLeftRight,
  Check,
  X,
  Edit3,
  ArrowRight,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

export type TextBlockConflict = {
  bubbleId: string
  pageName: string
  local: {
    text: string
    translation: string
    coord: string
    lastModified: string
  }
  remote: {
    text: string
    translation: string
    coord: string
    lastModified: string
    user: string
  }
}

interface ConflictResolutionModalProps {
  open: boolean
  conflict: TextBlockConflict
  onClose: () => void
  onResolve: (
    decision: 'local' | 'remote' | 'merged',
    resolvedText: string,
  ) => void
}

export function ConflictResolutionModal({
  open,
  conflict,
  onClose,
  onResolve,
}: ConflictResolutionModalProps) {
  const [mergedText, setMergedText] = useState(conflict.remote.translation)
  const [isMerging, setIsMerging] = useState(false)

  useEffect(() => {
    if (open) {
      setMergedText(conflict.remote.translation)
      setIsMerging(false)
    }
  }, [open, conflict])

  // Escape to close
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      role='dialog'
      aria-modal='true'
      className='animate-in fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-md duration-200'
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className='bg-card border-border animate-in zoom-in-95 flex w-[54rem] max-w-[95vw] flex-col overflow-hidden rounded-xl border shadow-2xl duration-200'>
        {/* Header */}
        <div className='border-border flex items-center gap-3 border-b bg-amber-500/5 px-6 py-4'>
          <div className='rounded-lg border border-amber-500/20 bg-amber-500/10 p-2 text-amber-500'>
            <ShieldAlert className='size-5 animate-pulse' />
          </div>
          <div>
            <h3 className='text-foreground flex items-center gap-1.5 text-sm font-bold'>
              P2P Bubble Sync Conflict
            </h3>
            <p className='text-muted-foreground mt-0.5 text-[10px] font-semibold tracking-wider uppercase'>
              {conflict.pageName} · {conflict.bubbleId}
            </p>
          </div>
          <button
            onClick={onClose}
            className='text-muted-foreground hover:text-foreground hover:bg-muted ml-auto rounded-full p-1.5 transition'
          >
            <X className='size-4' />
          </button>
        </div>

        {/* Content Comparison Grid */}
        <div className='max-h-[65vh] space-y-6 overflow-y-auto p-6'>
          <div className='grid gap-6 md:grid-cols-2'>
            {/* Local Version Card */}
            <div className='border-border/80 bg-background/40 hover:border-primary/40 flex flex-col overflow-hidden rounded-xl border shadow-sm transition duration-300'>
              <div className='bg-primary/5 border-border flex items-center justify-between border-b px-4 py-2.5'>
                <span className='text-primary flex items-center gap-1.5 text-xs font-bold'>
                  <span className='bg-primary size-2 rounded-full' />
                  Local Changes (Winner)
                </span>
                <span className='text-muted-foreground font-mono text-[9px]'>
                  {conflict.local.lastModified}
                </span>
              </div>
              <div className='flex flex-1 flex-col justify-between space-y-3 p-4'>
                <div className='space-y-2.5'>
                  <div className='flex flex-col gap-0.5'>
                    <span className='text-muted-foreground text-[8px] font-bold tracking-wider uppercase'>
                      Raw Japanese Source
                    </span>
                    <span className='text-foreground bg-muted/30 border-border/20 rounded border p-2 font-sans text-xs font-medium'>
                      {conflict.local.text}
                    </span>
                  </div>
                  <div className='flex flex-col gap-0.5'>
                    <span className='text-muted-foreground text-[8px] font-bold tracking-wider uppercase'>
                      Translation (TH)
                    </span>
                    <span className='text-foreground bg-muted/40 border-border/30 rounded border p-2 font-sans text-xs font-bold'>
                      {conflict.local.translation}
                    </span>
                  </div>
                  <div className='flex flex-col gap-0.5'>
                    <span className='text-muted-foreground text-[8px] font-bold tracking-wider uppercase'>
                      Coordinates
                    </span>
                    <span className='text-muted-foreground bg-muted/20 rounded px-2 py-1 font-mono text-[10px]'>
                      {conflict.local.coord}
                    </span>
                  </div>
                </div>
                <Button
                  onClick={() => onResolve('local', conflict.local.translation)}
                  className='bg-primary text-primary-foreground hover:bg-primary/95 mt-4 w-full text-xs font-semibold'
                  size='sm'
                >
                  <Check className='mr-1.5 size-3.5' /> Keep Local Version
                </Button>
              </div>
            </div>

            {/* Remote Version Card */}
            <div className='border-border/80 bg-background/40 flex flex-col overflow-hidden rounded-xl border shadow-sm transition duration-300 hover:border-blue-500/40'>
              <div className='border-border flex items-center justify-between border-b bg-blue-500/5 px-4 py-2.5'>
                <span className='flex items-center gap-1.5 text-xs font-bold text-blue-400'>
                  <span className='size-2 rounded-full bg-blue-500' />
                  Remote Changes (Winner)
                </span>
                <span className='text-muted-foreground font-mono text-[9px]'>
                  {conflict.remote.lastModified}
                </span>
              </div>
              <div className='flex flex-1 flex-col justify-between space-y-3 p-4'>
                <div className='space-y-2.5'>
                  <div className='flex flex-col gap-0.5'>
                    <span className='text-muted-foreground text-[8px] font-bold tracking-wider uppercase'>
                      Raw Japanese Source
                    </span>
                    <span className='text-foreground bg-muted/30 border-border/20 rounded border p-2 font-sans text-xs font-medium'>
                      {conflict.remote.text}
                    </span>
                  </div>
                  <div className='flex flex-col gap-0.5'>
                    <span className='text-muted-foreground text-[8px] font-bold tracking-wider uppercase'>
                      Translation (TH)
                    </span>
                    <span className='text-foreground bg-muted/40 border-border/30 rounded border p-2 font-sans text-xs font-bold'>
                      {conflict.remote.translation}
                    </span>
                  </div>
                  <div className='flex flex-col gap-0.5'>
                    <span className='text-muted-foreground text-[8px] font-bold tracking-wider uppercase'>
                      Sync Source (User)
                    </span>
                    <span className='text-muted-foreground bg-muted/20 rounded px-2 py-1 font-mono text-[10px]'>
                      {conflict.remote.user} · {conflict.remote.coord}
                    </span>
                  </div>
                </div>
                <Button
                  onClick={() =>
                    onResolve('remote', conflict.remote.translation)
                  }
                  className='mt-4 w-full border-0 bg-blue-600 text-xs font-semibold text-white hover:bg-blue-700'
                  size='sm'
                >
                  <Check className='mr-1.5 size-3.5' /> Accept Remote Version
                </Button>
              </div>
            </div>
          </div>

          {/* Merge Option Section */}
          <div className='border-border/60 bg-muted/15 overflow-hidden rounded-xl border shadow-inner transition duration-300'>
            <div
              onClick={() => setIsMerging(!isMerging)}
              className='bg-muted/35 border-border/40 hover:bg-muted/50 flex cursor-pointer items-center justify-between border-b px-5 py-3.5 transition'
            >
              <div className='flex items-center gap-2'>
                <Edit3 className='size-4 text-purple-400' />
                <span className='text-foreground text-xs font-bold'>
                  Resolve Conflict by Merging Manually
                </span>
              </div>
              <span className='text-muted-foreground bg-background/50 border-border/50 rounded-full border px-2 py-0.5 text-[10px] font-semibold'>
                {isMerging ? 'Collapse' : 'Expand Editor'}
              </span>
            </div>

            {isMerging && (
              <div className='animate-in slide-in-from-top space-y-4 p-5 duration-300'>
                <p className='text-muted-foreground max-w-lg text-[10px] leading-relaxed'>
                  คุณสามารถรวมคำแปลของทั้งสองฝั่ง
                  หรือปรับแต่งประโยคใหม่ด้วยตนเองด้านล่างเพื่อใช้เป็นคำตัดสินขั้นสุดท้าย
                </p>
                <div className='space-y-1.5'>
                  <span className='text-muted-foreground text-[8px] font-bold tracking-wider uppercase'>
                    Final Merged Translation
                  </span>
                  <Textarea
                    value={mergedText}
                    onChange={(e) => setMergedText(e.target.value)}
                    placeholder='พิมพ์ข้อความคำแปลที่รวมและปรับแต่งแล้วที่นี่...'
                    className='min-h-20 font-sans text-xs font-semibold'
                  />
                </div>
                <div className='flex justify-end'>
                  <Button
                    onClick={() => onResolve('merged', mergedText)}
                    disabled={!mergedText.trim()}
                    className='border-0 bg-purple-600 text-xs font-semibold text-white hover:bg-purple-700'
                    size='sm'
                  >
                    <ArrowLeftRight className='mr-1.5 size-3.5' />
                    Apply Merged Decision
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
