'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { subscribeDownloadProgress, type DownloadProgress } from '@/lib/backend'

type AggregateProgress = {
  filename: string
  percent?: number
}

export default function SplashScreen() {
  const { t } = useTranslation()
  const [progress, setProgress] = useState<AggregateProgress | null>(null)
  const filesRef = useRef<Map<string, { downloaded: number; total: number }>>(
    new Map(),
  )

  useEffect(() => {
    const unsub = subscribeDownloadProgress((msg: DownloadProgress) => {
      const files = filesRef.current

      if (msg.status === 'started') {
        files.set(msg.filename, { downloaded: 0, total: msg.total ?? 0 })
      } else if (msg.status === 'downloading') {
        const entry = files.get(msg.filename)
        if (entry) {
          entry.downloaded = msg.downloaded
          if (msg.total) entry.total = msg.total
        } else {
          files.set(msg.filename, {
            downloaded: msg.downloaded,
            total: msg.total ?? 0,
          })
        }
      } else {
        // Completed or Failed — lock this file at 100%
        const entry = files.get(msg.filename)
        if (entry) {
          entry.downloaded = entry.total
        }
      }

      // Compute aggregate
      let totalBytes = 0
      let downloadedBytes = 0
      for (const entry of files.values()) {
        totalBytes += entry.total
        downloadedBytes += entry.downloaded
      }

      // Find current active file (last non-completed)
      const activeFilename =
        msg.status === 'started' || msg.status === 'downloading'
          ? msg.filename
          : null

      const percent =
        totalBytes > 0
          ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
          : undefined

      if (activeFilename) {
        setProgress({ filename: activeFilename, percent })
      } else {
        // All done — keep showing 100% briefly
        setProgress((prev) =>
          prev ? { ...prev, percent: percent ?? 100 } : null,
        )
      }
    })

    return () => unsub()
  }, [])

  // Listen for the block-until-ready cuDNN install that runs during
  // startup (before ML init). Surface its download/extract progress on
  // the same splash bar so the user sees the ~700 MB fetch instead of a
  // frozen "Initializing…" screen on first launch.
  useEffect(() => {
    let unlisten: (() => void) | null = null
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event')
      unlisten = await listen<{
        kind: string
        version?: string
        bytes_done?: number
        bytes_total?: number | null
      }>('koharu://runtime/cudnn-progress', (e) => {
        const p = e.payload
        if (p.kind === 'downloading') {
          const percent =
            p.bytes_total && p.bytes_done
              ? Math.min(100, Math.round((p.bytes_done / p.bytes_total) * 100))
              : undefined
          setProgress({
            filename: `cuDNN GPU runtime v${p.version ?? ''}`,
            percent,
          })
        } else if (p.kind === 'extracting') {
          setProgress({ filename: 'Extracting cuDNN…', percent: undefined })
        } else if (p.kind === 'ready') {
          setProgress({ filename: 'cuDNN ready', percent: 100 })
        }
      })
    })()
    return () => {
      if (unlisten) unlisten()
    }
  }, [])

  return (
    <main className='bg-background flex min-h-screen flex-col items-center justify-center select-none'>
      <span className='text-primary text-2xl font-semibold'>Koharu</span>
      <span className='text-primary mt-2 text-lg'>
        {t('common.initializing')}
      </span>
      <div className='mt-4 flex h-12 w-48 flex-col items-center gap-1.5'>
        <span className='text-muted-foreground h-4 max-w-full truncate text-xs'>
          {progress ? progress.filename : '\u00a0'}
        </span>
        <div className='bg-muted relative h-1.5 w-full overflow-hidden rounded-full'>
          {progress && typeof progress.percent === 'number' ? (
            <div
              className='bg-primary h-full rounded-full transition-[width] duration-300'
              style={{ width: `${progress.percent}%` }}
            />
          ) : (
            <div className='activity-progress-indeterminate from-primary/40 via-primary to-primary/40 absolute inset-0 w-1/2 rounded-full bg-linear-to-r' />
          )}
        </div>
        <span className='text-muted-foreground h-4 text-[11px] tabular-nums'>
          {progress && typeof progress.percent === 'number'
            ? `${progress.percent}%`
            : '\u00a0'}
        </span>
      </div>
    </main>
  )
}
