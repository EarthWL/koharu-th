'use client'

import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useCurrentDocumentState } from '@/lib/query/hooks'
import {
  useDocumentMutations,
  useTextBlockMutations,
} from '@/lib/query/mutations'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { useTextStylePresetsStore } from '@/lib/stores/textStylePresetsStore'
import { TextBlock } from '@/types'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query/keys'

const TEXT_BLOCK_RENDER_DEBOUNCE_MS = 250

const shouldRenderSprite = (updates: Partial<TextBlock>) =>
  Object.prototype.hasOwnProperty.call(updates, 'width') ||
  Object.prototype.hasOwnProperty.call(updates, 'height') ||
  Object.prototype.hasOwnProperty.call(updates, 'translation') ||
  Object.prototype.hasOwnProperty.call(updates, 'style') ||
  // Self-test fix #3: rotation slider on TextBlocksPanel updates
  // `block.rotationDeg`. Pre-fix the annotation CSS rotated but
  // the rendered text sprite stayed unrotated — user saw the
  // outline tilt while the text glyphs sat flat. The renderer
  // honours `rotation_deg`; we just need to re-bake the sprite
  // when rotation changes.
  Object.prototype.hasOwnProperty.call(updates, 'rotationDeg')

// Self-test follow-up: width/height USED to be in the immediate
// branch so resize drags would render every mousemove. In practice
// that fires ~30 HTTP roundtrips/sec each ~40-60ms — they queue,
// the cache propagation lags the drag, and the final sprite that
// lands often reflects an interior drag value instead of the
// release value (the "size doesn't follow even after Render"
// symptom). Move resize to the debounced path: one re-bake fires
// ~250ms after the user stops dragging. Rotation already lives
// here for the same reason.
//
// Nothing is left in the immediate branch right now — kept as a
// function (returning false) so a future immediate-trigger field
// can re-enable it without restructuring the call site.
const shouldRenderSpriteImmediately = (_updates: Partial<TextBlock>) => false

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
  const { updateTextBlocks, renderTextBlock } = useTextBlockMutations()
  const { render: renderFullPage } = useDocumentMutations()
  const renderTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(
    new Map(),
  )
  // Self-test follow-up: shared timer for the FULL-page composite
  // re-bake. Triggered after any geometry change (move / resize /
  // rotate) so doc.rendered refreshes with the new block state.
  // Without this the composite stays frozen at the last manual
  // Render until the user clicks Render again — even though
  // per-block sprites re-render via `scheduleRender` above, those
  // aren't what the canvas displays once Render has been clicked.
  const fullPageRenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
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

  const scheduleFullPageRender = () => {
    if (fullPageRenderTimerRef.current) {
      clearTimeout(fullPageRenderTimerRef.current)
    }
    fullPageRenderTimerRef.current = setTimeout(() => {
      fullPageRenderTimerRef.current = null
      void renderFullPage(undefined, currentDocumentIndex)
    }, TEXT_BLOCK_RENDER_DEBOUNCE_MS)
  }

  const replaceBlock = async (index: number, updates: Partial<TextBlock>) => {
    const currentBlocks = document?.textBlocks ?? []
    const nextBlocks = currentBlocks.map((block, idx) =>
      idx === index ? { ...block, ...updates } : block,
    )
    await updateTextBlocks(nextBlocks)

    // Self-test follow-up: do NOT toggle showRenderedImage to false
    // here. Full Render produces doc.rendered (page composite) but
    // doesn't populate per-block `block.rendered` — so hiding the
    // composite + showing the SpriteLayer used to result in a blank
    // canvas (no per-block sprites existed). Keep the composite
    // visible during editing — annotation handles overlay on top —
    // and rely on the debounced full-page re-bake below to refresh
    // the composite once the user stops dragging. The composite
    // shows stale translation positions mid-drag but that beats
    // a fully-blank canvas.
    // Self-test follow-up #3: ANY change that alters the rendered
    // output — geometry OR content (translation / style / rotation) —
    // must schedule a full-page composite re-bake. Pre-fix only
    // geometry changes triggered scheduleFullPageRender; a
    // translation edit re-baked the per-block sprite (invisible,
    // since the canvas shows the composite) but never refreshed
    // doc.rendered, so the edit didn't appear until the user pressed
    // Render manually.
    if (hasGeometryChange(updates) || shouldRenderSprite(updates)) {
      scheduleFullPageRender()
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
    // Inherit the user's default style preset (if set) when the new
    // block doesn't already carry a style. Lets the translator pick a
    // house style once and have every block they draw match it.
    const defaultStyle = useTextStylePresetsStore.getState().getDefaultStyle()
    const seeded =
      block.style || !defaultStyle
        ? block
        : { ...block, style: { ...defaultStyle } }
    const nextBlocks = [...currentBlocks, seeded]
    await updateTextBlocks(nextBlocks)
    setSelectedBlockIndex(nextBlocks.length - 1)
  }

  const removeBlock = async (index: number) => {
    clearScheduledRender(index)
    const currentBlocks = document?.textBlocks ?? []
    const nextBlocks = currentBlocks.filter((_, idx) => idx !== index)
    await updateTextBlocks(nextBlocks)
    setSelectedBlockIndex(undefined)
  }

  const clearSelection = () => {
    setSelectedBlockIndex(undefined)
  }

  const replaceAllBlocks = async (blocks: TextBlock[]) => {
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
