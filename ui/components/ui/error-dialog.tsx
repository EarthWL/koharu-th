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
  Activity,
  Cpu,
  Laptop,
  Code,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface ErrorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  code: string
  msgTh: string
  details?: string
  method?: string
  stack?: string
  platform?: {
    userAgent: string
    isTauri: boolean
    isDev: boolean
    timestamp: string
  }
  appState?: {
    currentDocumentIndex: number
    totalPages: number
    directMlEnabled: boolean
    smartPostProcessEnabled: boolean
    ocrEngine: string
    detectorEngine: string
    inpaintEngine: string
    animeYoloVariant: string
    inpaintMaxSide: number
    cloudProvider: string
    cloudModelName: string
    llmFailoverEnabled: boolean
    installedAddonsCount: number
  }
}

export function ErrorDialog({
  open,
  onOpenChange,
  code,
  msgTh,
  details,
  method,
  stack,
  platform,
  appState,
}: ErrorDialogProps) {
  const [copied, setCopied] = useState(false)
  const [showRawDetails, setShowRawDetails] = useState(false)
  const [activeTab, setActiveTab] = useState<'general' | 'debug'>('general')

  const handleCopy = async () => {
    const markdownReport = [
      `### 🤖 Koharu System Crash Diagnostic`,
      `*   **เวลาที่เกิด**: ${platform?.timestamp || new Date().toLocaleString()}`,
      `*   **รหัสข้อผิดพลาด**: \`${code}\``,
      `*   **คำสั่งประมวลผล (RPC Method)**: \`${method || 'N/A'}\``,
      `*   **ข้อความระบบ**: ${msgTh}`,
      `*   **รายละเอียดดิบ (Raw Details)**: ${details || 'N/A'}`,
      `\n#### 💻 สภาพแวดล้อมและรันไทม์ (Runtime Telemetry)`,
      `*   **Tauri App**: ${platform?.isTauri ? 'ใช่ (Native)' : 'ไม่ใช่ (Browser)'}`,
      `*   **โหมดนักพัฒนา (Dev Mode)**: ${platform?.isDev ? 'ใช่ (Development)' : 'ไม่ใช่ (Production)'}`,
      `*   **DirectML (การเร่งความเร็วการ์ดจอ)**: ${appState?.directMlEnabled ? 'เปิดการใช้งาน (ON)' : 'ปิดการใช้งาน (OFF)'}`,
      `*   **Smart Post-Process**: ${appState?.smartPostProcessEnabled ? 'เปิดใช้งาน' : 'ปิดใช้งาน'}`,
      `*   **เอกสารที่เปิดอยู่ (Active Doc)**: ดัชนีที่ ${appState?.currentDocumentIndex ?? 'N/A'} จากทั้งหมด ${appState?.totalPages ?? 0} หน้า`,
      `*   **User Agent**: \`${platform?.userAgent || 'Unknown'}\``,
      `\n#### 🧠 สถานะเครื่องประมวลผลเอไอ (ML Engines Diagnostics)`,
      `*   **OCR Engine**: \`${appState?.ocrEngine ?? 'N/A'}\``,
      `*   **Text Detector Engine**: \`${appState?.detectorEngine ?? 'N/A'}\` (YOLO Variant: \`${appState?.animeYoloVariant ?? 'N/A'}\`)`,
      `*   **Inpainting Engine**: \`${appState?.inpaintEngine ?? 'N/A'}\` (Max Crop Size: \`${appState?.inpaintMaxSide ?? 'N/A'}\`px)`,
      `*   **Cloud LLM Provider**: \`${appState?.cloudProvider ?? 'N/A'}\` (Model: \`${appState?.cloudModelName ?? 'N/A'}\`)`,
      `*   **LLM Failover**: ${appState?.llmFailoverEnabled ? 'เปิดใช้งาน (ENABLED)' : 'ปิดใช้งาน (DISABLED)'}`,
      `*   **ส่วนเสริมภายนอก (Installed Addons)**: ${appState?.installedAddonsCount ?? 0} รายการ`,
      stack ? `\n#### 📝 แฟ้มบันทึกความล้มเหลว (Stack Trace)\n\`\`\`\n${stack}\n\`\`\`` : '',
    ].filter(Boolean).join('\n')

    try {
      await navigator.clipboard.writeText(markdownReport)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy diagnostics: ', err)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        className={cn(
          'bg-card/90 max-w-2xl border border-red-500/25 p-6 shadow-2xl backdrop-blur-xl transition-all duration-300',
          'dark:border-red-900/40 dark:bg-zinc-950/90',
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
                  ตรวจพบข้อผิดพลาดระบบการแปล
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
              <AlertDialogDescription className='text-foreground/90 mt-1 text-xs leading-relaxed font-semibold'>
                ระบบประมวลผลตรวจพบปัญหาระหว่างดำเนินการ ด้านล่างนี้คือข้อมูลสำหรับการวิเคราะห์แบบสด
              </AlertDialogDescription>
            </div>
          </div>

          {/* Interactive Navigation Tabs */}
          <div className='flex border-b border-border/40 pb-px gap-1'>
            <button
              onClick={() => setActiveTab('general')}
              className={cn(
                'px-4 py-2 text-xs font-semibold border-b-2 transition-all duration-200 flex items-center gap-1.5',
                activeTab === 'general'
                  ? 'border-red-500 text-red-600 dark:text-red-400'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Activity className='h-3.5 w-3.5' />
              <span>ทั่วไป (General)</span>
            </button>
            <button
              onClick={() => setActiveTab('debug')}
              className={cn(
                'px-4 py-2 text-xs font-semibold border-b-2 transition-all duration-200 flex items-center gap-1.5',
                activeTab === 'debug'
                  ? 'border-red-500 text-red-600 dark:text-red-400'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Cpu className='h-3.5 w-3.5' />
              <span>ข้อมูลดีบั๊กเชิงลึก (Diagnostics)</span>
            </button>
          </div>

          {/* Tab 1: General Info */}
          {activeTab === 'general' && (
            <div className='flex flex-col gap-3 py-1'>
              <div className='rounded-xl border border-red-500/10 bg-red-500/5 p-4 text-sm font-medium leading-relaxed text-red-700/90 dark:text-red-200/90'>
                {msgTh}
              </div>

              {/* Technical Details Collapsible */}
              {details && (
                <div className='border-border/40 bg-muted/30 overflow-hidden rounded-xl border dark:bg-zinc-900/20'>
                  <button
                    onClick={() => setShowRawDetails(!showRawDetails)}
                    className='text-muted-foreground hover:bg-muted/50 flex w-full items-center justify-between px-4 py-2.5 text-xs font-semibold transition-colors'
                  >
                    <div className='flex items-center gap-2'>
                      <Terminal className='h-3.5 w-3.5' />
                      <span>รายละเอียดข้อมูลระบบแบบดิบ (Raw JSON Message)</span>
                    </div>
                    {showRawDetails ? (
                      <ChevronUp className='h-4 w-4' />
                    ) : (
                      <ChevronDown className='h-4 w-4' />
                    )}
                  </button>

                  {showRawDetails && (
                    <div className='border-border/40 border-t bg-zinc-950/70 px-4 py-3 dark:bg-black/80'>
                      <pre className='scrollbar-thin scrollbar-thumb-zinc-800 max-h-40 overflow-y-auto pr-1 font-mono text-[10px] leading-relaxed break-all whitespace-pre-wrap text-red-400 select-text'>
                        {details}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Tab 2: System Telemetry & Diagnostics */}
          {activeTab === 'debug' && (
            <div className='flex flex-col gap-3 py-1 animate-in fade-in duration-200'>
              {/* Telemetry Grid */}
              <div className='grid grid-cols-2 gap-3 text-xs'>
                {/* Platform info */}
                <div className='rounded-xl border border-border/40 bg-muted/20 p-3 flex flex-col gap-2 dark:bg-zinc-900/10'>
                  <div className='flex items-center gap-1.5 font-bold text-muted-foreground'>
                    <Laptop className='h-3.5 w-3.5 text-red-500' />
                    <span>ข้อมูลรันไทม์ (Platform)</span>
                  </div>
                  <div className='font-mono text-[10px] flex flex-col gap-1 text-foreground/80'>
                    <div>Tauri App: <span className='font-bold text-red-600 dark:text-red-400'>{platform?.isTauri ? 'YES' : 'NO'}</span></div>
                    <div>Dev Mode: <span className='font-semibold'>{platform?.isDev ? 'Development' : 'Production'}</span></div>
                    <div className='truncate'>Time: {platform?.timestamp || 'N/A'}</div>
                  </div>
                </div>

                {/* Engine Settings */}
                <div className='rounded-xl border border-border/40 bg-muted/20 p-3 flex flex-col gap-2 dark:bg-zinc-900/10'>
                  <div className='flex items-center gap-1.5 font-bold text-muted-foreground'>
                    <Cpu className='h-3.5 w-3.5 text-red-500' />
                    <span>สถานะของเครื่องยนต์ (Engine States)</span>
                  </div>
                  <div className='font-mono text-[10px] flex flex-col gap-1 text-foreground/80'>
                    <div>DirectML GPU: <span className={cn('font-bold', appState?.directMlEnabled ? 'text-emerald-500' : 'text-zinc-500')}>{appState?.directMlEnabled ? 'ACTIVE (ON)' : 'INACTIVE (OFF)'}</span></div>
                    <div>Post-Process: <span className='font-semibold'>{appState?.smartPostProcessEnabled ? 'ENABLED' : 'DISABLED'}</span></div>
                    <div>Active Page: <span className='font-semibold'>{appState?.currentDocumentIndex ?? 'N/A'} / {appState?.totalPages ?? 0}</span></div>
                  </div>
                </div>

                {/* AI & Translation Engines */}
                <div className='col-span-2 rounded-xl border border-border/40 bg-muted/20 p-3 flex flex-col gap-2 dark:bg-zinc-900/10'>
                  <div className='flex items-center gap-1.5 font-bold text-muted-foreground'>
                    <Code className='h-3.5 w-3.5 text-red-500' />
                    <span>ระบบปัญญาประดิษฐ์และการแปล (AI & Translation Engine Diagnostics)</span>
                  </div>
                  <div className='font-mono text-[10px] grid grid-cols-2 gap-x-4 gap-y-1 text-foreground/80'>
                    <div>OCR Engine: <span className='font-semibold text-red-600 dark:text-red-400'>{appState?.ocrEngine ?? 'N/A'}</span></div>
                    <div>Detector: <span className='font-semibold text-red-600 dark:text-red-400'>{appState?.detectorEngine ?? 'N/A'} ({appState?.animeYoloVariant ?? 'N/A'})</span></div>
                    <div>Inpaint Engine: <span className='font-semibold text-red-600 dark:text-red-400'>{appState?.inpaintEngine ?? 'N/A'} ({appState?.inpaintMaxSide ?? 'N/A'}px)</span></div>
                    <div>Cloud LLM: <span className='font-semibold text-red-600 dark:text-red-400'>{appState?.cloudProvider ?? 'N/A'} ({appState?.cloudModelName ?? 'N/A'})</span></div>
                    <div>LLM Failover: <span className='font-semibold'>{appState?.llmFailoverEnabled ? 'ENABLED' : 'DISABLED'}</span></div>
                    <div>Addons Installed: <span className='font-semibold'>{appState?.installedAddonsCount ?? 0} items</span></div>
                  </div>
                </div>
              </div>

              {/* RPC Method */}
              {method && (
                <div className='rounded-xl border border-border/40 bg-zinc-950/70 p-3 flex items-center justify-between text-xs font-semibold dark:bg-black/40'>
                  <div className='flex items-center gap-2 text-muted-foreground'>
                    <Code className='h-3.5 w-3.5 text-red-500' />
                    <span>คำสั่งที่เกิดปัญหา (Failed RPC Method):</span>
                  </div>
                  <span className='font-mono bg-red-950/40 text-red-400 border border-red-500/20 px-2 py-0.5 rounded-md'>
                    {method}
                  </span>
                </div>
              )}

              {/* Stack Trace */}
              {stack && (
                <div className='border-border/40 bg-zinc-950/70 overflow-hidden rounded-xl border p-3 dark:bg-black/50'>
                  <div className='flex items-center gap-2 mb-2 text-xs font-bold text-muted-foreground'>
                    <Terminal className='h-3.5 w-3.5 text-red-500' />
                    <span>ประวัติคิวงานล้มเหลว (Stack Trace)</span>
                  </div>
                  <pre className='scrollbar-thin scrollbar-thumb-zinc-800 max-h-36 overflow-y-auto pr-1 font-mono text-[10px] leading-relaxed break-all whitespace-pre-wrap text-red-400/80 select-text'>
                    {stack}
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
                  <span>คัดลอกรายงานดีบั๊ก (Copy)</span>
                </>
              )}
            </Button>

            <AlertDialogAction
              onClick={() => onOpenChange(false)}
              className='bg-red-600 px-5 py-1.5 text-xs font-semibold text-white shadow-[0_4px_12px_rgba(239,68,68,0.2)] hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600'
            >
              รับทราบและปิด
            </AlertDialogAction>
          </div>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}
