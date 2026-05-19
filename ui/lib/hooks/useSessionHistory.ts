'use client'

import { useCallback, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type HistoryState } from '@/lib/api'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { queryKeys } from '@/lib/query/keys'

export const HISTORY_KEY = ['session', 'historyState'] as const

/// Helper for engine mutation onSuccess paths — call after any
/// engine_bridge run (detect/ocr/inpaint/translate/render) so the
/// toolbar's undo/redo button enabled-state updates without
/// waiting for the next poll. Phase 5.5 wires this from
/// `useDocumentMutations` + `useLlmMutations` alongside the
/// existing `invalidateCurrentDocument` calls.
export async function invalidateSessionHistory(
  queryClient: import('@tanstack/react-query').QueryClient,
): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: HISTORY_KEY })
}

const EMPTY_STATE: HistoryState = {
  undoLen: 0,
  redoLen: 0,
  capacity: 0,
}

/// React-Query-backed hook around `ProjectSession::History`.
///
/// - Caches the latest `HistoryState` (undoLen / redoLen / capacity)
///   for the toolbar's enabled-state + dev-mode op-count badge.
/// - Exposes `undo()` / `redo()` mutations that hit the backend
///   RPCs + invalidate the current document query so the canvas
///   re-renders against the post-undo Document snapshot.
/// - Registers a global keyboard handler for Ctrl/Cmd+Z (undo) +
///   Ctrl/Cmd+Shift+Z (redo). Uses `event.code === 'KeyZ'` —
///   NOT `event.key` — so the shortcut fires on Thai keyboards
///   too (Thai layout maps physical Z to `ผ`, breaking
///   `event.key === 'z'` matchers).
export function useSessionHistory() {
  const queryClient = useQueryClient()
  const currentDocumentIndex = useEditorUiStore(
    (s) => s.currentDocumentIndex,
  )

  const query = useQuery({
    queryKey: HISTORY_KEY,
    queryFn: () => api.sessionHistoryState(),
    staleTime: 5_000,
  })

  const invalidateDocument = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.documents.current(currentDocumentIndex),
    })
    await queryClient.invalidateQueries({
      queryKey: queryKeys.documents.thumbnailRoot,
      predicate: (q) => q.queryKey[3] === currentDocumentIndex,
    })
  }, [currentDocumentIndex, queryClient])

  const undoMutation = useMutation({
    mutationFn: () => api.sessionUndo(currentDocumentIndex),
    onSuccess: async (state) => {
      queryClient.setQueryData(HISTORY_KEY, state)
      await invalidateDocument()
    },
  })

  const redoMutation = useMutation({
    mutationFn: () => api.sessionRedo(currentDocumentIndex),
    onSuccess: async (state) => {
      queryClient.setQueryData(HISTORY_KEY, state)
      await invalidateDocument()
    },
  })

  const undo = useCallback(() => {
    if (undoMutation.isPending) return
    undoMutation.mutate()
  }, [undoMutation])

  const redo = useCallback(() => {
    if (redoMutation.isPending) return
    redoMutation.mutate()
  }, [redoMutation])

  const state = query.data ?? EMPTY_STATE
  const canUndo = state.undoLen > 0 && !undoMutation.isPending
  const canRedo = state.redoLen > 0 && !redoMutation.isPending

  // Global keyboard handler. Match physical Z so Thai layout
  // (`ผ`) doesn't break the shortcut. Skip when the user is
  // typing in a form field — the input's own undo/redo wins.
  useEffect(() => {
    const isTypingInForm = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target.isContentEditable
      )
    }
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey
      if (!cmd) return
      if (e.code !== 'KeyZ') return
      if (isTypingInForm(e.target)) return
      e.preventDefault()
      if (e.shiftKey) {
        if (canRedo) redo()
      } else {
        if (canUndo) undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canUndo, canRedo, undo, redo])

  return {
    state,
    canUndo,
    canRedo,
    undo,
    redo,
    pending: undoMutation.isPending || redoMutation.isPending,
  }
}
