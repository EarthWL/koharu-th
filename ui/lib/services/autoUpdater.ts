'use client'

import { create } from 'zustand'
import { isTauri, invoke } from '../backend'

export type UpdateState = {
  isOpen: boolean
  isChecking: boolean
  isDownloading: boolean
  progress: number
  totalSize?: number
  downloadedSize: number
  latestVersion?: string
  releaseNotes?: string
  error?: string

  openDialog: () => void
  closeDialog: () => void
  startChecking: () => void
  stopChecking: () => void
  setUpdateAvailable: (version: string, notes?: string) => void
  startDownloading: () => void
  setProgress: (downloaded: number, total?: number) => void
  setError: (err: string) => void
  reset: () => void
}

export const useUpdateStore = create<UpdateState>((set) => ({
  isOpen: false,
  isChecking: false,
  isDownloading: false,
  progress: 0,
  downloadedSize: 0,

  openDialog: () => set({ isOpen: true }),
  closeDialog: () => set({ isOpen: false }),
  startChecking: () => set({ isChecking: true, error: undefined }),
  stopChecking: () => set({ isChecking: false }),
  setUpdateAvailable: (version, notes) =>
    set({
      isOpen: true,
      latestVersion: version,
      releaseNotes: notes,
      error: undefined,
    }),
  startDownloading: () =>
    set({ isDownloading: true, progress: 0, downloadedSize: 0 }),
  setProgress: (downloaded, total) =>
    set((state) => {
      const totalBytes = total ?? state.totalSize ?? 0
      const pct =
        totalBytes > 0 ? Math.round((downloaded / totalBytes) * 100) : 0
      return {
        downloadedSize: downloaded,
        totalSize: totalBytes,
        progress: pct,
      }
    }),
  setError: (err) =>
    set({ error: err, isChecking: false, isDownloading: false }),
  reset: () =>
    set({
      isOpen: false,
      isChecking: false,
      isDownloading: false,
      progress: 0,
      downloadedSize: 0,
      latestVersion: undefined,
      releaseNotes: undefined,
      error: undefined,
    }),
}))

let activeUpdateObject: any = null

/**
 * Trigger update check using Tauri's official updater plugin.
 * @param manual Whether this check was manually requested by the user.
 */
export async function triggerUpdateCheck(manual: boolean = false) {
  if (!isTauri()) return

  const store = useUpdateStore.getState()
  if (store.isChecking || store.isDownloading) return

  store.startChecking()

  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()

    store.stopChecking()

    if (!update) {
      if (manual) {
        alert(
          'คุณใช้งานเวอร์ชันล่าสุดอยู่แล้ว! (You are on the latest version)',
        )
      }
      return
    }

    activeUpdateObject = update
    const version = update.version
    const notes = update.body ?? ''

    // Read autoUpdateMode from preferencesStore
    const { usePreferencesStore } = await import('../stores/preferencesStore')
    const mode = usePreferencesStore.getState().autoUpdateMode

    if (mode === 'auto' && !manual) {
      // Auto Mode: Download and install silently in background
      await startAutoDownload(true)
    } else {
      // Notify/Manual Mode: Prompt the user
      store.setUpdateAvailable(version, notes)
    }
  } catch (err: any) {
    store.setError(err?.message ?? String(err))
    if (manual) {
      alert(`ไม่สามารถตรวจสอบอัปเดตได้: ${err?.message ?? err}`)
    }
  }
}

/**
 * Start downloading and installing the update.
 * @param silent Whether to show the download dialog.
 */
export async function startAutoDownload(silent: boolean = false) {
  const store = useUpdateStore.getState()
  if (!activeUpdateObject) return

  if (!silent) {
    store.startDownloading()
  }

  try {
    let contentLength: number | undefined = undefined

    await activeUpdateObject.downloadAndInstall((event: any) => {
      switch (event.event) {
        case 'Started':
          contentLength = event.data.contentLength
          if (!silent) {
            store.setProgress(0, contentLength)
          }
          break
        case 'Progress':
          if (!silent) {
            // event.data.chunkLength accumulates, or is total downloaded bytes
            // Tauri v2 returns the current downloaded bytes in chunkLength or similar
            const downloaded = event.data.chunkLength
            store.setProgress(downloaded, contentLength)
          }
          break
        case 'Finished':
          if (!silent) {
            store.setProgress(contentLength ?? 100, contentLength)
          }
          break
      }
    })

    // Relaunch the app
    if (silent) {
      const confirmRestart = confirm(
        'การอัปเดต Koharu-TH เสร็จสมบูรณ์แล้ว!\n\nต้องการรีสตาร์ทโปรแกรมเพื่อเริ่มใช้งานเวอร์ชันใหม่ทันทีหรือไม่?',
      )
      if (confirmRestart) {
        await invoke('relaunch_app')
      }
    } else {
      // Relaunch immediately in manual/interactive mode after successful install
      await invoke('relaunch_app')
    }
  } catch (err: any) {
    store.setError(err?.message ?? String(err))
    if (!silent) {
      alert(`การดาวน์โหลด/ติดตั้งอัปเดตล้มเหลว: ${err?.message ?? err}`)
    }
  }
}
