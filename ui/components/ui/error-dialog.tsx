'use client'

import * as React from 'react'
import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  AlertTriangle,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  Terminal,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface ErrorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  code: string
  msgTh: string
  details?: string
}

export function ErrorDialog({
  open,
  onOpenChange,
  code,
  msgTh,
  details,
}: ErrorDialogProps) {
  const [copied, setCopied] = useState(false)
  const [showDetails, setShowDetails] = useState(false)

  const handleCopy = async () => {
    const textToCopy = `[Koharu Diagnostic Error]\nCode: ${code}\nMessage: ${msgTh}\nDetails: ${details || 'N/A'}`
    try {
      await navigator.clipboard.writeText(textToCopy)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy text: ', err)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        className={cn(
          'bg-card/85 max-w-lg border border-red-500/25 p-6 shadow-2xl backdrop-blur-xl transition-all duration-300',
          'dark:border-red-900/30 dark:bg-zinc-950/85',
        )}
      >
        <div className='flex flex-col gap-4'>
          {/* Header & Icon */}
          <div className='flex items-start gap-4'>
            <div
              className={cn(
                'flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-red-500/10 text-red-500 shadow-[0_0_15px_rgba(239,68,68,0.15)]',
                'dark:bg-red-950/20 dark:text-red-400',
              )}
            >
              <AlertTriangle className='h-6 w-6 animate-pulse' />
            </div>

            <div className='min-w-0 flex-1'>
              <div className='flex flex-wrap items-center gap-2'>
                <AlertDialogTitle className='text-lg font-bold text-red-700 dark:text-red-400'>
                  ตรวจพบข้อผิดพลาดระบบ
                </AlertDialogTitle>
                <span
                  className={cn(
                    'rounded-full border border-red-200/50 bg-red-100 px-2.5 py-0.5 text-xs font-semibold tracking-wider text-red-800 uppercase',
                    'dark:border-red-900/40 dark:bg-red-950/50 dark:text-red-300',
                  )}
                >
                  {code}
                </span>
              </div>
              <AlertDialogDescription className='text-foreground/90 mt-2 text-sm leading-relaxed font-medium'>
                {msgTh}
              </AlertDialogDescription>
            </div>
          </div>

          {/* Technical Details Collapsible */}
          {details && (
            <div className='border-border/40 bg-muted/40 mt-1 overflow-hidden rounded-xl border dark:bg-zinc-900/30'>
              <button
                onClick={() => setShowDetails(!showDetails)}
                className='text-muted-foreground hover:bg-muted/60 flex w-full items-center justify-between px-4 py-2.5 text-xs font-semibold transition-colors'
              >
                <div className='flex items-center gap-2'>
                  <Terminal className='h-3.5 w-3.5' />
                  <span>รายละเอียดทางเทคนิค (Technical Details)</span>
                </div>
                {showDetails ? (
                  <ChevronUp className='h-4 w-4' />
                ) : (
                  <ChevronDown className='h-4 w-4' />
                )}
              </button>

              {showDetails && (
                <div className='border-border/40 border-t bg-zinc-950/50 px-4 py-3 dark:bg-black/60'>
                  <pre className='scrollbar-thin scrollbar-thumb-zinc-800 max-h-48 overflow-y-auto pr-1 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-red-400/90 select-text dark:text-red-400/80'>
                    {details}
                  </pre>
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className='mt-2 flex items-center justify-end gap-3'>
            <Button
              variant='outline'
              size='sm'
              onClick={handleCopy}
              className={cn(
                'border-border/50 bg-background/50 hover:bg-muted gap-2 text-xs font-semibold transition-all duration-200',
                copied &&
                  'border-emerald-500/30 bg-emerald-50 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-400',
              )}
            >
              {copied ? (
                <>
                  <Check className='h-3.5 w-3.5 text-emerald-500' />
                  <span>คัดลอกสำเร็จแล้ว</span>
                </>
              ) : (
                <>
                  <Copy className='h-3.5 w-3.5' />
                  <span>คัดลอกรายละเอียด</span>
                </>
              )}
            </Button>

            <AlertDialogAction
              onClick={() => onOpenChange(false)}
              className='bg-red-600 px-4 py-1.5 text-xs font-semibold text-white shadow-[0_4px_12px_rgba(239,68,68,0.2)] hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600'
            >
              รับทราบและปิด
            </AlertDialogAction>
          </div>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}
