'use client'

import { type ReactNode, useState } from 'react'
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary'
import { Button } from '@/components/ui/button'
import { getQueryClient } from '@/lib/query/client'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { useLlmUiStore } from '@/lib/stores/llmUiStore'
import { useOperationStore } from '@/lib/stores/operationStore'
import { AlertTriangle, Copy, Check, Download, RefreshCw, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'

function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  const [copied, setCopied] = useState(false)
  const errorMessage = error instanceof Error ? error.message : 'Unexpected error'
  const errorStack = error instanceof Error ? error.stack : 'No stack trace available'

  const handleCopy = async () => {
    const textToCopy = `[Koharu React Crash Diagnostic]\nMessage: ${errorMessage}\nStack: ${errorStack}`
    try {
      await navigator.clipboard.writeText(textToCopy)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy diagnostics: ', err)
    }
  }

  const handleDownload = () => {
    const textToDownload = `[Koharu React Crash Diagnostic]\nTimestamp: ${new Date().toISOString()}\nMessage: ${errorMessage}\nStack: ${errorStack}`
    const blob = new Blob([textToDownload], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `koharu_crash_report_${Date.now()}.txt`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  return (
    <div className='flex h-full min-h-screen w-full flex-col items-center justify-center bg-zinc-950 p-6 text-center select-none'>
      <div className='w-full max-w-2xl rounded-3xl border border-red-500/25 bg-zinc-900/60 p-8 shadow-[0_25px_80px_rgba(0,0,0,0.5)] backdrop-blur-xl'>
        {/* Animated Warning Icon */}
        <div className='mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-red-500/10 text-red-500 shadow-[0_0_20px_rgba(239,68,68,0.25)] mb-6'>
          <AlertTriangle className='h-8 w-8 animate-pulse text-red-500' />
        </div>

        <h1 className='text-2xl font-bold tracking-tight text-red-500 dark:text-red-400 mb-2'>
          แอปพลิเคชันขัดข้อง (Application Crashed)
        </h1>
        <p className='text-zinc-400 text-sm max-w-md mx-auto mb-6'>
          เกิดข้อผิดพลาดรุนแรงในการประมวลผลอินเทอร์เฟซ คุณสามารถลองกู้คืนระบบหรือส่งรายงานข้อผิดพลาดให้ทีมพัฒนา
        </p>

        {/* Diagnostic info */}
        <div className='mb-6 rounded-2xl border border-white/5 bg-black/40 overflow-hidden text-left'>
          <div className='flex items-center justify-between px-4 py-3 bg-white/5 border-b border-white/5'>
            <span className='text-xs font-semibold text-zinc-400 font-mono'>ERR_REACT_CRASH</span>
            <div className='flex gap-2'>
              <Button
                variant='ghost'
                size='icon-xs'
                onClick={handleCopy}
                className={cn(
                  'h-7 px-3 text-[11px] font-semibold transition-colors duration-200 text-zinc-400 hover:text-white',
                  copied && 'text-emerald-400 hover:text-emerald-300'
                )}
              >
                {copied ? <Check className='h-3.5 w-3.5 mr-1 text-emerald-400' /> : <Copy className='h-3.5 w-3.5 mr-1' />}
                {copied ? 'คัดลอกแล้ว' : 'คัดลอก'}
              </Button>
              <Button
                variant='ghost'
                size='icon-xs'
                onClick={handleDownload}
                className='h-7 px-3 text-[11px] font-semibold transition-colors duration-200 text-zinc-400 hover:text-white'
              >
                <Download className='h-3.5 w-3.5 mr-1' />
                ดาวน์โหลดรายงาน
              </Button>
            </div>
          </div>
          <div className='p-4 font-mono text-[11px] leading-relaxed text-red-400/90 max-h-48 overflow-y-auto whitespace-pre-wrap break-all pr-1 select-text scrollbar-thin scrollbar-thumb-zinc-800'>
            <div className='font-bold mb-1'>{errorMessage}</div>
            <div className='text-zinc-500 mt-2 border-t border-white/5 pt-2'>{errorStack}</div>
          </div>
        </div>

        {/* Action Controls */}
        <div className='flex flex-wrap items-center justify-center gap-3 border-t border-white/5 pt-6'>
          <Button 
            size='sm' 
            variant='default' 
            onClick={resetErrorBoundary}
            className='bg-red-600 hover:bg-red-700 text-white font-semibold text-xs py-1.5 px-4 shadow-[0_4px_12px_rgba(239,68,68,0.2)] dark:bg-red-700 dark:hover:bg-red-600'
          >
            <RotateCcw className='h-3.5 w-3.5 mr-1.5' />
            พยายามอีกครั้ง (Retry)
          </Button>
          
          <Button
            size='sm'
            variant='outline'
            className='border-white/10 hover:bg-white/5 text-zinc-300 hover:text-white font-semibold text-xs'
            onClick={() => {
              useEditorUiStore.getState().resetUiState()
              useLlmUiStore.getState().resetLlmUiState()
              useOperationStore.getState().resetOperationState()
              resetErrorBoundary()
            }}
          >
            <RefreshCw className='h-3.5 w-3.5 mr-1.5' />
            รีเซ็ตสถานะหน้าต่าง (Reset UI State)
          </Button>

          <Button
            size='sm'
            variant='outline'
            className='border-white/10 hover:bg-white/5 text-zinc-300 hover:text-white font-semibold text-xs'
            onClick={() => {
              getQueryClient().clear()
              resetErrorBoundary()
            }}
          >
            <RefreshCw className='h-3.5 w-3.5 mr-1.5' />
            ล้างแคชคิวรี (Reset Query Cache)
          </Button>
        </div>
      </div>
    </div>
  )
}

export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary FallbackComponent={ErrorFallback}>{children}</ErrorBoundary>
  )
}
