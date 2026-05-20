'use client'

import { useState, useEffect } from 'react'
import { ShieldAlert, ArrowLeftRight, Check, X, Edit3, ArrowRight } from 'lucide-react'
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
  onResolve: (decision: 'local' | 'remote' | 'merged', resolvedText: string) => void
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
      className='fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4 animate-in fade-in duration-200'
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className='bg-card border-border flex w-[54rem] max-w-[95vw] flex-col rounded-xl border shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200'>
        {/* Header */}
        <div className='border-b border-border bg-amber-500/5 px-6 py-4 flex items-center gap-3'>
          <div className='p-2 bg-amber-500/10 text-amber-500 rounded-lg border border-amber-500/20'>
            <ShieldAlert className='size-5 animate-pulse' />
          </div>
          <div>
            <h3 className='text-foreground text-sm font-bold flex items-center gap-1.5'>
              P2P Bubble Sync Conflict
            </h3>
            <p className='text-muted-foreground text-[10px] uppercase font-semibold tracking-wider mt-0.5'>
              {conflict.pageName} · {conflict.bubbleId}
            </p>
          </div>
          <button
            onClick={onClose}
            className='ml-auto text-muted-foreground hover:text-foreground p-1.5 hover:bg-muted rounded-full transition'
          >
            <X className='size-4' />
          </button>
        </div>

        {/* Content Comparison Grid */}
        <div className='p-6 space-y-6 max-h-[65vh] overflow-y-auto'>
          <div className='grid md:grid-cols-2 gap-6'>
            {/* Local Version Card */}
            <div className='flex flex-col border border-border/80 rounded-xl overflow-hidden bg-background/40 hover:border-primary/40 transition duration-300 shadow-sm'>
              <div className='bg-primary/5 px-4 py-2.5 border-b border-border flex items-center justify-between'>
                <span className='text-xs font-bold text-primary flex items-center gap-1.5'>
                  <span className='size-2 rounded-full bg-primary' />
                  Local Changes (Winner)
                </span>
                <span className='text-[9px] text-muted-foreground font-mono'>{conflict.local.lastModified}</span>
              </div>
              <div className='p-4 space-y-3 flex-1 flex flex-col justify-between'>
                <div className='space-y-2.5'>
                  <div className='flex flex-col gap-0.5'>
                    <span className='text-[8px] uppercase tracking-wider font-bold text-muted-foreground'>Raw Japanese Source</span>
                    <span className='text-xs font-medium font-sans text-foreground bg-muted/30 p-2 rounded border border-border/20'>{conflict.local.text}</span>
                  </div>
                  <div className='flex flex-col gap-0.5'>
                    <span className='text-[8px] uppercase tracking-wider font-bold text-muted-foreground'>Translation (TH)</span>
                    <span className='text-xs font-bold font-sans text-foreground bg-muted/40 p-2 rounded border border-border/30'>{conflict.local.translation}</span>
                  </div>
                  <div className='flex flex-col gap-0.5'>
                    <span className='text-[8px] uppercase tracking-wider font-bold text-muted-foreground'>Coordinates</span>
                    <span className='text-[10px] font-mono text-muted-foreground bg-muted/20 px-2 py-1 rounded'>{conflict.local.coord}</span>
                  </div>
                </div>
                <Button
                  onClick={() => onResolve('local', conflict.local.translation)}
                  className='w-full mt-4 bg-primary text-primary-foreground hover:bg-primary/95 text-xs font-semibold'
                  size='sm'
                >
                  <Check className='size-3.5 mr-1.5' /> Keep Local Version
                </Button>
              </div>
            </div>

            {/* Remote Version Card */}
            <div className='flex flex-col border border-border/80 rounded-xl overflow-hidden bg-background/40 hover:border-blue-500/40 transition duration-300 shadow-sm'>
              <div className='bg-blue-500/5 px-4 py-2.5 border-b border-border flex items-center justify-between'>
                <span className='text-xs font-bold text-blue-400 flex items-center gap-1.5'>
                  <span className='size-2 rounded-full bg-blue-500' />
                  Remote Changes (Winner)
                </span>
                <span className='text-[9px] text-muted-foreground font-mono'>{conflict.remote.lastModified}</span>
              </div>
              <div className='p-4 space-y-3 flex-1 flex flex-col justify-between'>
                <div className='space-y-2.5'>
                  <div className='flex flex-col gap-0.5'>
                    <span className='text-[8px] uppercase tracking-wider font-bold text-muted-foreground'>Raw Japanese Source</span>
                    <span className='text-xs font-medium font-sans text-foreground bg-muted/30 p-2 rounded border border-border/20'>{conflict.remote.text}</span>
                  </div>
                  <div className='flex flex-col gap-0.5'>
                    <span className='text-[8px] uppercase tracking-wider font-bold text-muted-foreground'>Translation (TH)</span>
                    <span className='text-xs font-bold font-sans text-foreground bg-muted/40 p-2 rounded border border-border/30'>{conflict.remote.translation}</span>
                  </div>
                  <div className='flex flex-col gap-0.5'>
                    <span className='text-[8px] uppercase tracking-wider font-bold text-muted-foreground'>Sync Source (User)</span>
                    <span className='text-[10px] font-mono text-muted-foreground bg-muted/20 px-2 py-1 rounded'>{conflict.remote.user} · {conflict.remote.coord}</span>
                  </div>
                </div>
                <Button
                  onClick={() => onResolve('remote', conflict.remote.translation)}
                  className='w-full mt-4 bg-blue-600 text-white hover:bg-blue-700 text-xs font-semibold border-0'
                  size='sm'
                >
                  <Check className='size-3.5 mr-1.5' /> Accept Remote Version
                </Button>
              </div>
            </div>
          </div>

          {/* Merge Option Section */}
          <div className='border border-border/60 rounded-xl overflow-hidden bg-muted/15 shadow-inner transition duration-300'>
            <div 
              onClick={() => setIsMerging(!isMerging)}
              className='px-5 py-3.5 bg-muted/35 border-b border-border/40 flex items-center justify-between cursor-pointer hover:bg-muted/50 transition'
            >
              <div className='flex items-center gap-2'>
                <Edit3 className='size-4 text-purple-400' />
                <span className='text-xs font-bold text-foreground'>
                  Resolve Conflict by Merging Manually
                </span>
              </div>
              <span className='text-[10px] text-muted-foreground font-semibold px-2 py-0.5 bg-background/50 rounded-full border border-border/50'>
                {isMerging ? 'Collapse' : 'Expand Editor'}
              </span>
            </div>
            
            {isMerging && (
              <div className='p-5 space-y-4 animate-in slide-in-from-top duration-300'>
                <p className='text-muted-foreground text-[10px] max-w-lg leading-relaxed'>
                  คุณสามารถรวมคำแปลของทั้งสองฝั่ง หรือปรับแต่งประโยคใหม่ด้วยตนเองด้านล่างเพื่อใช้เป็นคำตัดสินขั้นสุดท้าย
                </p>
                <div className='space-y-1.5'>
                  <span className='text-[8px] uppercase tracking-wider font-bold text-muted-foreground'>Final Merged Translation</span>
                  <Textarea
                    value={mergedText}
                    onChange={(e) => setMergedText(e.target.value)}
                    placeholder='พิมพ์ข้อความคำแปลที่รวมและปรับแต่งแล้วที่นี่...'
                    className='min-h-20 text-xs font-sans font-semibold'
                  />
                </div>
                <div className='flex justify-end'>
                  <Button
                    onClick={() => onResolve('merged', mergedText)}
                    disabled={!mergedText.trim()}
                    className='bg-purple-600 hover:bg-purple-700 text-white text-xs font-semibold border-0'
                    size='sm'
                  >
                    <ArrowLeftRight className='size-3.5 mr-1.5' />
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
