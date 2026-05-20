'use client'

import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useCurrentDocumentState } from '@/lib/query/hooks'
import { useTextBlockMutations } from '@/lib/query/mutations'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { TextBlock } from '@/types'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query/keys'

const TEXT_BLOCK_RENDER_DEBOUNCE_MS = 250

const shouldRenderSprite = (updates: Partial<TextBlock>) =>
  Object.prototype.hasOwnProperty.call(updates, 'width') ||
  Object.prototype.hasOwnProperty.call(updates, 'height') ||
  Object.prototype.hasOwnProperty.call(updates, 'translation') ||
  Object.prototype.hasOwnProperty.call(updates, 'style')

const shouldRenderSpriteImmediately = (updates: Partial<TextBlock>) =>
  Object.prototype.hasOwnProperty.call(updates, 'width') ||
  Object.prototype.hasOwnProperty.call(updates, 'height')

const hasGeometryChange = (updates: Partial<TextBlock>) =>
  Object.prototype.hasOwnProperty.call(updates, 'x') ||
  Object.prototype.hasOwnProperty.call(updates, 'y') ||
  Object.prototype.hasOwnProperty.call(updates, 'width') ||
  Object.prototype.hasOwnProperty.call(updates, 'height') ||
  Object.prototype.hasOwnProperty.call(updates, 'rotationDeg')

export function useTextBlocks() {
  const queryClient = useQueryClient()
  const { currentDocument: document, currentDocumentIndex } =
    useCurrentDocumentState()
  const textBlocks = document?.textBlocks ?? []
  const selectedBlockIndex = useEditorUiStore(
    (state) => state.selectedBlockIndex,
  )
  const setSelectedBlockIndex = useEditorUiStore(
    (state) => state.setSelectedBlockIndex,
  )
  const initHistory = useEditorUiStore((state) => state.initHistory)
  const pushHistory = useEditorUiStore((state) => state.pushHistory)

  const lastDocIdRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (document && document.id !== lastDocIdRef.current) {
      lastDocIdRef.current = document.id
      initHistory(document.textBlocks ?? [])
    }
  }, [document, initHistory])

  const { updateTextBlocks, renderTextBlock } = useTextBlockMutations()
  const renderTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(
    new Map(),
  )

  useEffect(() => {
    const timers = renderTimersRef.current
    return () => {
      timers.forEach((timer) => clearTimeout(timer))
      timers.clear()
    }
  }, [])

  const clearScheduledRender = (index: number) => {
    const timer = renderTimersRef.current.get(index)
    if (!timer) return
    clearTimeout(timer)
    renderTimersRef.current.delete(index)
  }

  const scheduleRender = (index: number) => {
    clearScheduledRender(index)
    const timer = setTimeout(() => {
      renderTimersRef.current.delete(index)
      void renderTextBlock(undefined, currentDocumentIndex, index)
    }, TEXT_BLOCK_RENDER_DEBOUNCE_MS)
    renderTimersRef.current.set(index, timer)
  }

  const replaceBlock = async (index: number, updates: Partial<TextBlock>) => {
    const currentBlocks = document?.textBlocks ?? []
    const nextBlocks = currentBlocks.map((block, idx) =>
      idx === index ? { ...block, ...updates } : block,
    )

    let actionName = 'Modify Block'
    if ('x' in updates || 'y' in updates) {
      actionName = 'Move Block'
    } else if ('width' in updates || 'height' in updates) {
      actionName = 'Resize Block'
    } else if ('translation' in updates) {
      actionName = 'Edit Translation'
    } else if ('text' in updates) {
      actionName = 'Edit OCR'
    } else if ('style' in updates) {
      actionName = 'Change Style'
      if (updates.style?.fontSize) {
        actionName = 'Change Font Size'
      } else if (updates.style?.lineHeight) {
        actionName = 'Change Line Height'
      } else if (updates.style?.letterSpacingPx) {
        actionName = 'Change Letter Spacing'
      }
    } else if ('rotationDeg' in updates) {
      actionName = 'Rotate Block'
    }

    pushHistory(actionName, nextBlocks)
    await updateTextBlocks(nextBlocks)

    if (hasGeometryChange(updates)) {
      const ui = useEditorUiStore.getState()
      ui.setShowRenderedImage(false)
      ui.setShowTextBlocksOverlay(true)
    }

    if (shouldRenderSprite(updates)) {
      if (shouldRenderSpriteImmediately(updates)) {
        clearScheduledRender(index)
        void renderTextBlock(undefined, currentDocumentIndex, index)
      } else {
        scheduleRender(index)
      }
    }
  }

  const appendBlock = async (block: TextBlock) => {
    const currentBlocks = document?.textBlocks ?? []
    const nextBlocks = [...currentBlocks, block]
    pushHistory('Add Block', nextBlocks)
    await updateTextBlocks(nextBlocks)
    setSelectedBlockIndex(nextBlocks.length - 1)
  }

  const removeBlock = async (index: number) => {
    clearScheduledRender(index)
    const currentBlocks = document?.textBlocks ?? []
    const nextBlocks = currentBlocks.filter((_, idx) => idx !== index)
    pushHistory('Delete Block', nextBlocks)
    await updateTextBlocks(nextBlocks)
    setSelectedBlockIndex(undefined)
  }

  const clearSelection = () => {
    setSelectedBlockIndex(undefined)
  }

  const replaceAllBlocks = async (blocks: TextBlock[]) => {
    pushHistory('Modify Layout', blocks)
    await updateTextBlocks(blocks)
    setSelectedBlockIndex(undefined)
  }

  /** Ask the backend to expand a block's bbox to match the bubble it
   *  sits in (flood-fill of white pixels on the original image), then
   *  refresh the document cache so the new bbox appears on canvas, and
   *  re-render the block so the text reflows into the new shape. */
  const fitBlockToBubble = async (index: number) => {
    clearScheduledRender(index)
    try {
      await api.textBlockFitToBubble(currentDocumentIndex, index)
    } catch (err: any) {
      console.error('[useTextBlocks] fitBlockToBubble failed', err)
      alert(err?.message ?? String(err))
      return
    }
    await queryClient.invalidateQueries({
      queryKey: queryKeys.documents.current(currentDocumentIndex),
    })
    
    // Now get the updated blocks from cache to push as the new history state
    const updatedDoc = queryClient.getQueryData<any>(
      queryKeys.documents.current(currentDocumentIndex)
    )
    if (updatedDoc?.textBlocks) {
      pushHistory('Fit to Bubble', updatedDoc.textBlocks)
    }

    const ui = useEditorUiStore.getState()
    ui.setShowRenderedImage(false)
    ui.setShowTextBlocksOverlay(true)
    void renderTextBlock(undefined, currentDocumentIndex, index)
  }

  return {
    document,
    textBlocks,
    selectedBlockIndex,
    setSelectedBlockIndex,
    clearSelection,
    replaceBlock,
    replaceAllBlocks,
    appendBlock,
    removeBlock,
    fitBlockToBubble,
  }
}
