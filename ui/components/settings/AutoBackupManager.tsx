'use client'

import { useEffect } from 'react'
import { api } from '@/lib/api'
import { useProjectStore } from '@/lib/stores/projectStore'

export function AutoBackupManager() {
  const projectInfo = useProjectStore((s) => s.info)

  useEffect(() => {
    if (!projectInfo) return

    // Auto backup every 15 minutes (15 * 60 * 1000)
    const INTERVAL_MS = 15 * 60 * 1000

    const runBackup = async () => {
      // Check if auto-backup preference is enabled in localStorage (defaults to true)
      const localValue = localStorage.getItem('koharu_auto_backup_enabled')
      const enabled = localValue === null ? true : localValue === 'true'
      if (!enabled) return

      try {
        console.log('[AutoBackupManager] Triggering silent background auto-backup...')
        const res = await api.projectBackupSilent()
        console.log('[AutoBackupManager] Auto-backup completed successfully:', res)
      } catch (err) {
        console.error('[AutoBackupManager] Auto-backup failed:', err)
      }
    }

    // Wait 1 minute after project boot before running the first backup, then run every 15 mins
    const initialTimer = setTimeout(runBackup, 60 * 1000)
    const interval = setInterval(runBackup, INTERVAL_MS)

    return () => {
      clearTimeout(initialTimer)
      clearInterval(interval)
    }
  }, [projectInfo])

  return null
}
