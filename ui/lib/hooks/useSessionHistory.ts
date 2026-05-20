'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type HistoryState } from '@/lib/api'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import { useUiErrorStore } from '@/lib/stores/uiErrorStore'
import { queryKeys } from '@/lib/query/keys'

/// Audit #8/P3: history state is per-doc — the key includes the
/// doc index so React Query refetches when the user switches docs
/// and the toolbar's enabled-state reflects the right session.
export const historyKey = (docIndex: number) =>
  ['session', 'historyState', docIndex] as const

/// Helper for engine mutation onSuccess paths — call after any
/// engine_bridge run (detect/ocr/inpaint/translate/render) so the
/// toolbar's undo/redo button enabled-state updates without
/// waiting for the next poll. Phase 5.5 wires this from
/// `useDocumentMutations` + `useLlmMutations` alongside the
/// existing `invalidateCurrentDocument` calls.
///
/// Invalidates all per-doc keys via prefix — cheap, and we don't
/// want a stale entry hanging around for a doc the user just
/// closed. Also invalidates the History popover's recent-summary
/// cache so the next open reflects post-engine-run state.
export async function invalidateSessionHistory(
  queryClient: import('@tanstack/react-query').QueryClient,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['session', 'historyState'] }),
    queryClient.invalidateQueries({ queryKey: ['session', 'historyRecent'] }),
  ])
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
    queryKey: historyKey(currentDocumentIndex),
    queryFn: () => api.sessionHistoryState(currentDocumentIndex),
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

  // The rendered composite is a derived view and is intentionally NOT
  // an undo step (see engine_bridge::apply_engine_result_dual). After an
  // undo/redo reverts the blocks, recompute the composite so the canvas
  // matches the restored geometry/translation. Best-effort: undo may go
  // back past the point where any translation exists, where the renderer
  // bails with "nothing to render" — that's fine, the blocks are still
  // correct and the next render catches up.
  const reRenderAfterHistory = useCallback(async () => {
    try {
      const { renderEffect, renderStroke } = useEditorUiStore.getState()
      const { fontFamily } = usePreferencesStore.getState()
      await api.render(currentDocumentIndex, {
        shaderEffect: renderEffect,
        shaderStroke: renderStroke,
        fontFamily,
      })
    } catch (e) {
      console.warn('[useSessionHistory] post-history re-render skipped', e)
    }
  }, [currentDocumentIndex])

  // Debounce the post-history render: holding Ctrl+Z walks the stack
  // fast, and a full-page render RPC per step would storm the backend.
  // The block data (panel + outline) updates immediately via
  // invalidateDocument in onSuccess; only the composite catch-up is
  // debounced (~180ms after the last undo/redo).
  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleReRender = useCallback(() => {
    if (renderTimerRef.current) clearTimeout(renderTimerRef.current)
    renderTimerRef.current = setTimeout(() => {
      renderTimerRef.current = null
      void reRenderAfterHistory().then(() => invalidateDocument())
    }, 180)
  }, [reRenderAfterHistory, invalidateDocument])
  useEffect(
    () => () => {
      if (renderTimerRef.current) clearTimeout(renderTimerRef.current)
    },
    [],
  )

  const showError = useUiErrorStore((s) => s.showError)

  const undoMutation = useMutation({
    mutationFn: () => api.sessionUndo(currentDocumentIndex),
    onSuccess: async (state) => {
      queryClient.setQueryData(historyKey(currentDocumentIndex), state)
      // Block data updates now; composite catches up on a debounced
      // render so rapid undo/redo doesn't storm the renderer.
      await invalidateDocument()
      scheduleReRender()
    },
    onError: (err) => {
      // Backend rejects when the session was built for a
      // different doc — surface a user-visible toast rather than
      // a silent console.error. Audit #8/P3 also disables the
      // button before this point, but a stale React Query cache
      // could still let the user click; the error toast catches
      // the race.
      showError(`Undo failed: ${String(err)}`)
    },
  })

  const redoMutation = useMutation({
    mutationFn: () => api.sessionRedo(currentDocumentIndex),
    onSuccess: async (state) => {
      queryClient.setQueryData(historyKey(currentDocumentIndex), state)
      // Block data updates now; composite catches up on a debounced
      // render so rapid undo/redo doesn't storm the renderer.
      await invalidateDocument()
      scheduleReRender()
    },
    onError: (err) => {
      showError(`Redo failed: ${String(err)}`)
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
