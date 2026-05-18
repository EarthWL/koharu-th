'use client'

import { useUpdateStore, startAutoDownload } from '@/lib/services/autoUpdater'
import { AlertCircleIcon, ArrowDownToLineIcon, LoaderIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function UpdateDialog() {
  const { t } = useTranslation()
  const {
    isOpen,
    isDownloading,
    progress,
    downloadedSize,
    totalSize,
    latestVersion,
    releaseNotes,
    error,
    reset,
  } = useUpdateStore()

  if (!isOpen) return null

  const formatSize = (bytes?: number) => {
    if (!bytes) return '—'
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm transition-all duration-300'>
      <div className='border-border/80 bg-background/90 text-foreground relative flex w-full max-w-md flex-col rounded-xl border p-6 shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95 duration-200'>
        {/* Header */}
        <div className='mb-4 flex items-center gap-3'>
          <div className='bg-primary/10 text-primary flex size-10 items-center justify-center rounded-full'>
            <ArrowDownToLineIcon className='size-5' />
          </div>
          <div>
            <h2 className='text-lg font-bold tracking-tight'>
              {t('settings.updaterTitle', 'มีเวอร์ชันใหม่พร้อมอัปเดต!')}
            </h2>
            <p className='text-muted-foreground text-xs'>
              {t('settings.aboutVersion', 'เวอร์ชัน')} v{latestVersion}
            </p>
          </div>
        </div>

        {/* Content */}
        {!isDownloading ? (
          <>
            {/* Release notes / info */}
            <div className='border-border/60 bg-muted/50 mb-6 max-h-48 overflow-y-auto rounded-lg border p-3 text-xs leading-relaxed'>
              <h3 className='mb-1.5 font-semibold text-foreground/90'>
                {t('settings.updateReleaseNotes', 'บันทึกการเปลี่ยนแปลง:')}
              </h3>
              <pre className='whitespace-pre-wrap font-sans text-muted-foreground'>
                {releaseNotes || t('settings.updateNoNotes', 'ไม่มีรายละเอียดเพิ่มเติมสำหรับเวอร์ชันนี้')}
              </pre>
            </div>

            {error && (
              <div className='border-destructive/30 bg-destructive/10 text-destructive mb-6 flex items-start gap-2.5 rounded-lg border p-3 text-xs'>
                <AlertCircleIcon className='size-4 shrink-0 mt-0.5' />
                <span className='font-medium leading-normal'>{error}</span>
              </div>
            )}

            {/* Buttons */}
            <div className='flex justify-end gap-2.5'>
              <button
                type='button'
                onClick={reset}
                className='border-border hover:bg-accent text-foreground inline-flex h-9 items-center justify-center rounded-lg border px-4 text-xs font-semibold transition'
              >
                {t('common.later', 'ไว้ทีหลัง')}
              </button>
              <button
                type='button'
                onClick={() => startAutoDownload(false)}
                className='bg-primary text-primary-foreground hover:bg-primary/95 inline-flex h-9 items-center justify-center rounded-lg px-4 text-xs font-semibold shadow-sm transition'
              >
                {t('settings.updateModeAuto', 'อัปเดตตอนนี้')}
              </button>
            </div>
          </>
        ) : (
          /* Downloading State */
          <div className='flex flex-col items-center py-4 text-center'>
            <LoaderIcon className='text-primary mb-4 size-8 animate-spin' />
            <h3 className='text-foreground mb-1 text-sm font-semibold'>
              {t('settings.updateDownloading', 'กำลังดาวน์โหลดและติดตั้ง...')}
            </h3>
            <p className='text-muted-foreground mb-4 text-xs leading-relaxed'>
              {t('settings.updateDontClose', 'กรุณาอย่าปิดโปรแกรม ระบบจะเปิดขึ้นใหม่เมื่อเสร็จสิ้น')}
            </p>

            {/* Progress bar container */}
            <div className='bg-muted/70 border-border/40 relative h-3 w-full rounded-full border overflow-hidden'>
              <div
                style={{ width: `${progress}%` }}
                className='bg-primary h-full rounded-full transition-all duration-300 ease-out'
              />
            </div>

            {/* Bytes indicator */}
            <div className='text-muted-foreground/75 mt-2 flex justify-between w-full text-[10px] font-mono'>
              <span>{progress}%</span>
              <span>
                {formatSize(downloadedSize)} / {formatSize(totalSize)}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
