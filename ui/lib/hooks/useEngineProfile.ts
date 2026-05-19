'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type ArtifactKind, type EngineProfile, type StoredValue } from '@/lib/api'

const PROFILE_KEY = ['engines', 'profile'] as const

/// React Query hook around the machine-wide engine profile.
///
/// Returns the current snapshot + helpers that locally update +
/// debounce-persist via `engine_profile_set` RPC. Slider drags fire
/// `setSetting` rapidly; the debounce coalesces those into one
/// RPC call per ~300ms quiet period so we don't pin the SQLite-
/// alongside JSON write under a tight loop.
export function useEngineProfile() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: PROFILE_KEY,
    queryFn: () => api.engineProfileGet(),
    staleTime: 5 * 60_000,
  })

  // Local mutable shadow so rapid edits coalesce. React Query's
  // setQueryData feeds the cache; the debounced `saveTimer` syncs
  // to disk via RPC.
  const localRef = useRef<EngineProfile | null>(null)
  useEffect(() => {
    if (query.data && localRef.current === null) {
      localRef.current = query.data
    }
  }, [query.data])

  const mutation = useMutation({
    mutationFn: (profile: EngineProfile) => api.engineProfileSet(profile),
    onSuccess: (saved) => {
      queryClient.setQueryData(PROFILE_KEY, saved)
    },
  })

  // Debounce — coalesce many rapid edits (slider drag) into one
  // mutation call after the user stops touching the control.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const schedulePersist = (profile: EngineProfile) => {
    queryClient.setQueryData(PROFILE_KEY, profile)
    localRef.current = profile
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      mutation.mutate(profile)
      saveTimer.current = null
    }, 300)
  }

  const helpers = useMemo(
    () => ({
      /// Look up the currently-active engine for an artifact slot.
      /// Returns `undefined` when the user hasn't picked one yet.
      activeEngine(artifact: ArtifactKind): string | undefined {
        return query.data?.active[artifact]
      },
      /// Replace the active engine for an artifact. Debounced
      /// persist; query cache updates immediately for UI feedback.
      setActiveEngine(artifact: ArtifactKind, engineId: string) {
        const prev = localRef.current ?? query.data ?? { active: {}, settings: {} }
        const next: EngineProfile = {
          ...prev,
          active: { ...prev.active, [artifact]: engineId },
        }
        schedulePersist(next)
      },
      /// Read a single setting override for an engine. `undefined` =
      /// not overridden — engine falls back to schema default.
      getSetting(engineId: string, settingId: string): StoredValue | undefined {
        return query.data?.settings[engineId]?.[settingId]
      },
      /// Write a single setting override. Triggers debounced persist.
      setSetting(engineId: string, settingId: string, value: StoredValue) {
        const prev = localRef.current ?? query.data ?? { active: {}, settings: {} }
        const engineSettings = { ...(prev.settings[engineId] ?? {}), [settingId]: value }
        const next: EngineProfile = {
          ...prev,
          settings: { ...prev.settings, [engineId]: engineSettings },
        }
        schedulePersist(next)
      },
    }),
    [query.data, queryClient],
  )

  return {
    profile: query.data,
    loading: query.isLoading,
    saving: mutation.isPending,
    ...helpers,
  }
}
