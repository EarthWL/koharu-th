'use client'

import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type ArtifactKind, type EngineProfile, type StoredValue } from '@/lib/api'

const PROFILE_KEY = ['engines', 'profile'] as const

/// React Query hook around the machine-wide engine profile.
///
/// **Audit #6 P2 fix**: replaced the previous "build a stale local
/// snapshot + debounce a full-profile replace" pattern with
/// granular `engineProfileSetActive` / `engineProfileSetSetting`
/// RPCs. The backend serialises each mutation under the
/// `EngineProfileStore` RwLock, so two hook instances rapidly
/// editing different keys (e.g. user changes active engine in
/// `EngineGroup` while `EngineSettingsForm` is debouncing a slider)
/// can't trample each other.
///
/// React Query handles the cache layer: each granular mutation
/// returns the new full profile, which we drop straight into
/// `queryClient.setQueryData(PROFILE_KEY, ...)`. The next
/// re-render reads the updated state immediately.
export function useEngineProfile() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: PROFILE_KEY,
    queryFn: () => api.engineProfileGet(),
    staleTime: 5 * 60_000,
  })

  const setActiveMutation = useMutation({
    mutationFn: ({
      artifact,
      engineId,
    }: {
      artifact: ArtifactKind
      engineId: string
    }) => api.engineProfileSetActive(artifact, engineId),
    onSuccess: (saved) => {
      queryClient.setQueryData(PROFILE_KEY, saved)
    },
  })

  const setSettingMutation = useMutation({
    mutationFn: ({
      engineId,
      settingId,
      value,
    }: {
      engineId: string
      settingId: string
      value: StoredValue
    }) => api.engineProfileSetSetting(engineId, settingId, value),
    onSuccess: (saved) => {
      queryClient.setQueryData(PROFILE_KEY, saved)
    },
  })

  const clearSettingMutation = useMutation({
    mutationFn: ({
      engineId,
      settingId,
    }: {
      engineId: string
      settingId: string
    }) => api.engineProfileClearSetting(engineId, settingId),
    onSuccess: (saved) => {
      queryClient.setQueryData(PROFILE_KEY, saved)
    },
  })

  const helpers = useMemo(
    () => ({
      /// Currently-active engine for an artifact slot.
      activeEngine(artifact: ArtifactKind): string | undefined {
        return query.data?.active[artifact]
      },
      /// Set the active engine — fires the granular RPC.
      setActiveEngine(artifact: ArtifactKind, engineId: string) {
        setActiveMutation.mutate({ artifact, engineId })
      },
      /// Read a single setting override. `undefined` = engine
      /// falls back to schema default.
      getSetting(engineId: string, settingId: string): StoredValue | undefined {
        return query.data?.settings[engineId]?.[settingId]
      },
      /// Set a single setting — fires the granular RPC.
      ///
      /// Note: there's no client-side debounce here. Slider drag
      /// fires `mutate` per change event (~10-30 calls/s during
      /// drag). The backend's atomic-rename persistence + the
      /// React Query mutation queue handle the burst — each
      /// mutation is fire-and-forget from the caller's POV, and
      /// the `setQueryData` in `onSuccess` keeps the UI showing
      /// the most-recently-committed value. If real users hit
      /// disk-I/O contention on long slider drags, the right fix
      /// is a debounce here (still safe under the granular RPC
      /// design since the LAST mutation's value wins, with no
      /// cross-key trampling).
      setSetting(engineId: string, settingId: string, value: StoredValue) {
        setSettingMutation.mutate({ engineId, settingId, value })
      },
      /// Drop one setting override → engine falls back to its
      /// SettingDescriptor default at next run. Used by the
      /// per-setting "reset to default" button.
      clearSetting(engineId: string, settingId: string) {
        clearSettingMutation.mutate({ engineId, settingId })
      },
      /// Does an override currently exist for this setting? UI
      /// uses this to gate the reset button visibility — no point
      /// showing it when the user is already at the default.
      hasOverride(engineId: string, settingId: string): boolean {
        return query.data?.settings[engineId]?.[settingId] !== undefined
      },
    }),
    [query.data, setActiveMutation, setSettingMutation, clearSettingMutation],
  )

  return {
    profile: query.data,
    loading: query.isLoading,
    saving:
      setActiveMutation.isPending ||
      setSettingMutation.isPending ||
      clearSettingMutation.isPending,
    ...helpers,
  }
}
