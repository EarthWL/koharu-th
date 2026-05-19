'use client'

import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'
import { useGesture } from '@use-gesture/react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { useTranslation } from 'react-i18next'
import { listen } from '@/lib/backend'
import { Image } from '@/components/Image'
import {
  setCanvasViewport,
  fitCanvasToViewport,
} from '@/components/canvas/canvasViewport'
import { ToolRail } from '@/components/canvas/ToolRail'
import { CanvasToolbar } from '@/components/canvas/CanvasToolbar'
import { TextBlockAnnotations } from '@/components/canvas/TextBlockAnnotations'
import { TextBlockSpriteLayer } from '@/components/canvas/TextBlockSpriteLayer'
import { useCanvasZoom } from '@/hooks/useCanvasZoom'
import { usePointerToDocument } from '@/hooks/usePointerToDocument'
import { useBlockDrafting } from '@/hooks/useBlockDrafting'
import { useBlockContextMenu } from '@/hooks/useBlockContextMenu'
import { useTextBlocks } from '@/hooks/useTextBlocks'
import { useMaskDrawing } from '@/hooks/useMaskDrawing'
import { useRenderBrushDrawing } from '@/hooks/useRenderBrushDrawing'
import { useBrushLayerDisplay } from '@/hooks/useBrushLayerDisplay'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import {
  resolvePinchMemoScaleRatio,
  resolvePinchNextScaleRatio,
} from '@/components/canvas/zoomGestures'

const BRUSH_CURSOR =
  'url(\'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="16" height="16"%3E%3Ccircle cx="8" cy="8" r="4" stroke="black" stroke-width="1.5" fill="white"/%3E%3C/svg%3E\') 8 8, crosshair'

export function Workspace() {
  const scale = useEditorUiStore((state) => state.scale)
  const showSegmentationMask = useEditorUiStore(
    (state) => state.showSegmentationMask,
  )
  const showInpaintedImage = useEditorUiStore(
    (state) => state.showInpaintedImage,
  )
  const showBrushLayer = useEditorUiStore((state) => state.showBrushLayer)
  const showRenderedImage = useEditorUiStore((state) => state.showRenderedImage)
  const showTextBlocksOverlay = useEditorUiStore(
    (state) => state.showTextBlocksOverlay,
  )
  const mode = useEditorUiStore((state) => state.mode)
  const autoFitEnabled = useEditorUiStore((state) => state.autoFitEnabled)
  const {
    document: currentDocument,
    selectedBlockIndex,
    setSelectedBlockIndex,
    clearSelection,
    appendBlock,
    removeBlock,
  } = useTextBlocks()
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const { setScale: applyScale } = useCanvasZoom()
  const scaleRatio = scale / 100
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const pointerToDocument = usePointerToDocument(scaleRatio, canvasRef)
  const { draftBlock, bind: bindBlockDraft } = useBlockDrafting({
    mode,
    currentDocument,
    pointerToDocument,
    clearSelection,
    onCreateBlock: (block) => {
      void appendBlock(block)
    },
  })
  const maskPointerEnabled =
    mode === 'repairBrush' ||
    (mode === 'eraser' && (showSegmentationMask || !showBrushLayer))
  const brushPointerEnabled =
    mode === 'brush' ||
    (mode === 'eraser' && !showSegmentationMask && showBrushLayer)
  const maskDrawing = useMaskDrawing({
    mode,
    currentDocument,
    pointerToDocument,
    showMask: showSegmentationMask,
    enabled: maskPointerEnabled,
  })
  const brushLayerDisplay = useBrushLayerDisplay({
    currentDocument,
    visible: showBrushLayer,
  })
  const brushDrawing = useRenderBrushDrawing({
    mode,
    currentDocument,
    pointerToDocument,
    enabled: brushPointerEnabled,
    action: mode === 'eraser' ? 'erase' : 'paint',
    targetCanvasRef: brushLayerDisplay.canvasRef,
  })
  const blockDraftBindings = bindBlockDraft()
  const maskBindings = maskDrawing.bind()
  const brushBindings = brushDrawing.bind()

  useEffect(() => {
    if (currentDocument && autoFitEnabled) {
      fitCanvasToViewport()
    }
  }, [currentDocument?.id, autoFitEnabled])
  const {
    contextMenuBlockIndex,
    handleContextMenu,
    handleDeleteBlock,
    clearContextMenu,
  } = useBlockContextMenu({
    currentDocument,
    pointerToDocument,
    selectBlock: setSelectedBlockIndex,
    removeBlock: (index) => {
      void removeBlock(index)
    },
  })
  const { t } = useTranslation()

  // Latest-state refs so the Tauri listener never sees stale captures
  // (would otherwise miss autoFitEnabled toggles and require tearing down
  //  on every document switch).
  const currentDocumentRef = useRef(currentDocument)
  const autoFitEnabledRef = useRef(autoFitEnabled)
  useEffect(() => {
    currentDocumentRef.current = currentDocument
  }, [currentDocument])
  useEffect(() => {
    autoFitEnabledRef.current = autoFitEnabled
  }, [autoFitEnabled])

  // Listen for Tauri resize events (stable across re-renders)
  useEffect(() => {
    let unlisten: (() => void) | undefined

    const setupListener = async () => {
      unlisten = await listen('tauri://resize', () => {
        if (currentDocumentRef.current && autoFitEnabledRef.current) {
          fitCanvasToViewport()
        }
      })
    }

    void setupListener()

    return () => {
      if (unlisten) {
        unlisten()
      }
    }
  }, [])

  const isBrushMode =
    mode === 'brush' || mode === 'repairBrush' || mode === 'eraser'

  // Photoshop-style Space-to-pan (#23). When the user holds Space
  // we let drag pan regardless of active tool — same convention every
  // graphics editor follows. Tracked via a window keydown/keyup so
  // the state is correct even if focus is elsewhere (sidebar etc.).
  const [spacePressed, setSpacePressed] = useState(false)
  useEffect(() => {
    const isTypingInForm = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return false
      const tag = target.tagName
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        target.isContentEditable === true
      )
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      if (isTypingInForm(e)) return
      if (e.repeat) return
      e.preventDefault() // stop page scroll while pan is armed
      setSpacePressed(true)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpacePressed(false)
    }
    // Some platforms drop keyup when the window blurs (e.g. user
    // alt-tabs away mid-pan). Reset on blur to avoid sticky-space.
    const onBlur = () => setSpacePressed(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  useGesture(
    {
      onDrag: ({ first, movement: [mx, my], memo, cancel, ctrlKey }) => {
        if (!currentDocument) return memo
        // Space+drag overrides brush — same affordance Photoshop / Figma
        // / Procreate use so a quick reposition doesn't need a tool
        // switch. Without Space, brush mode keeps the pointer.
        const panRequested = spacePressed || ctrlKey
        if (isBrushMode && !spacePressed) {
          if (first && cancel) cancel()
          return memo
        }
        if (!panRequested) {
          if (first && cancel) cancel()
          return memo
        }

        const viewport = viewportRef.current
        if (!viewport) return memo

        if (first) {
          return {
            scrollLeft: viewport.scrollLeft,
            scrollTop: viewport.scrollTop,
          }
        }

        if (!memo) return memo
        viewport.scrollLeft = memo.scrollLeft - mx
        viewport.scrollTop = memo.scrollTop - my
        return memo
      },
      onWheel: ({ ctrlKey, altKey, delta: [, dy], event }) => {
        if (!currentDocument) return
        const wantsZoom = ctrlKey || altKey
        if (!wantsZoom) return

        if (event.cancelable) {
          event.preventDefault()
        }

        const direction = Math.sign(dy)
        if (!direction) return

        const currentScale = useEditorUiStore.getState().scale
        const nextScale = currentScale - direction
        const viewport = viewportRef.current

        // Alt+wheel = Photoshop-style zoom-to-cursor: keep the canvas
        // point under the cursor stationary across the scale change.
        // Ctrl+wheel keeps the existing center-based zoom for muscle
        // memory.
        if (viewport && altKey && !ctrlKey) {
          const wheelEvent = event as WheelEvent
          const rect = viewport.getBoundingClientRect()
          const cx = wheelEvent.clientX - rect.left
          const cy = wheelEvent.clientY - rect.top
          const r1 = currentScale / 100
          const srcX = (viewport.scrollLeft + cx) / r1
          const srcY = (viewport.scrollTop + cy) / r1

          applyScale(nextScale)

          // applyScale resizes the canvas div via React state — wait
          // one frame for the new layout before adjusting scroll, so
          // the new scrollLeft/Top isn't clamped by stale content
          // dimensions.
          requestAnimationFrame(() => {
            const v = viewportRef.current
            if (!v) return
            const r2 = useEditorUiStore.getState().scale / 100
            v.scrollLeft = srcX * r2 - cx
            v.scrollTop = srcY * r2 - cy
          })
        } else {
          applyScale(nextScale)
        }
      },
      onPinch: ({ canceled, movement: [movementScale], memo }) => {
        if (!currentDocument || canceled) return memo
        const memoScaleRatio = resolvePinchMemoScaleRatio(
          memo,
          useEditorUiStore.getState().scale / 100,
        )
        const nextScaleRatio = resolvePinchNextScaleRatio(
          memoScaleRatio,
          movementScale,
        )
        applyScale(nextScaleRatio * 100)
        return memoScaleRatio
      },
    },
    {
      target: viewportRef,
      eventOptions: { passive: false },
      drag: {
        filterTaps: true,
      },
      wheel: {
        preventDefault: false,
      },
      pinch: {
        threshold: 0.1,
        enabled: true,
        pinchOnWheel: false,
        preventDefault: true,
        scaleBounds: { min: 0.1, max: 1 },
        from: () => [useEditorUiStore.getState().scale / 100, 0],
      },
    },
  )

  const handleCanvasPointerDownCapture = (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (mode !== 'block' && event.target === event.currentTarget) {
      clearSelection()
    }
  }

  const handleCanvasContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    handleContextMenu(event)
  }

  // Space-pan affordance takes priority — even brush mode shows the
  // grab cursor while Space is held so the user knows the gesture is
  // armed before they click.
  const canvasCursor = spacePressed
    ? 'grab'
    : isBrushMode
      ? BRUSH_CURSOR
      : mode === 'block'
        ? 'cell'
        : 'default'

  const canvasDimensions = currentDocument
    ? {
        width: currentDocument.width * scaleRatio,
        height: currentDocument.height * scaleRatio,
      }
    : { width: 0, height: 0 }

  return (
    <div className='bg-muted flex min-h-0 min-w-0 flex-1'>
      <ToolRail />
      <div className='relative flex min-h-0 min-w-0 flex-1 flex-col'>
        <CanvasToolbar />
        <ScrollAreaPrimitive.Root className='flex min-h-0 min-w-0 flex-1'>
          <ScrollAreaPrimitive.Viewport
            ref={(el) => {
              viewportRef.current = el
              setCanvasViewport(el)
            }}
            data-testid='workspace-viewport'
            className='grid size-full place-content-center-safe'
          >
            {currentDocument ? (
              <ContextMenu
                onOpenChange={(open) => {
                  if (!open) {
                    clearContextMenu()
                  }
                }}
              >
                <ContextMenuTrigger asChild>
                  <div className='grid place-items-center'>
                    <div
                      ref={canvasRef}
                      data-testid='workspace-canvas'
                      className='border-border bg-card relative rounded border shadow-sm'
                      style={{ ...canvasDimensions, cursor: canvasCursor }}
                      onPointerDownCapture={handleCanvasPointerDownCapture}
                      onContextMenuCapture={handleCanvasContextMenu}
                      {...blockDraftBindings}
                    >
                      <div className='absolute inset-0'>
                        <Image
                          blob={currentDocument.image}
                          dataKey={`${currentDocument.id}-base`}
                          transition={false}
                        />
                        <canvas
                          ref={maskDrawing.canvasRef}
                          data-testid='workspace-mask-canvas'
                          className='absolute inset-0 z-20'
                          style={{
                            width: '100%',
                            height: '100%',
                            opacity: showSegmentationMask ? 0.8 : 0,
                            pointerEvents: maskPointerEnabled ? 'auto' : 'none',
                            transition: 'opacity 120ms ease',
                          }}
                          {...maskBindings}
                        />
                        {currentDocument?.inpainted && (
                          <Image
                            data-testid='workspace-inpainted-image'
                            blob={currentDocument.inpainted}
                            visible={showInpaintedImage}
                            transition={false}
                          />
                        )}
                        <canvas
                          ref={brushLayerDisplay.canvasRef}
                          data-testid='workspace-brush-display-canvas'
                          className='absolute inset-0'
                          style={{
                            width: '100%',
                            height: '100%',
                            opacity: brushLayerDisplay.visible ? 1 : 0,
                            pointerEvents: 'none',
                            zIndex: 10,
                            transition: 'opacity 120ms ease',
                          }}
                        />
                        <canvas
                          ref={brushDrawing.canvasRef}
                          data-testid='workspace-brush-canvas'
                          className='absolute inset-0'
                          style={{
                            width: '100%',
                            height: '100%',
                            opacity: brushDrawing.visible ? 1 : 0,
                            pointerEvents: brushPointerEnabled
                              ? 'auto'
                              : 'none',
                            zIndex: 20,
                            transition: 'opacity 120ms ease',
                          }}
                          {...brushBindings}
                        />
                        {showTextBlocksOverlay && (
                          <TextBlockSpriteLayer
                            blocks={currentDocument?.textBlocks}
                            scale={scaleRatio}
                            visible={!showRenderedImage}
                            style={{ zIndex: 30 }}
                          />
                        )}
                        {showTextBlocksOverlay && (
                          <TextBlockAnnotations
                            selectedIndex={selectedBlockIndex}
                            onSelect={setSelectedBlockIndex}
                            style={{ zIndex: 30 }}
                          />
                        )}
                        {currentDocument.rendered && showRenderedImage && (
                          <Image
                            data-testid='workspace-rendered-image'
                            blob={currentDocument.rendered}
                            transition={false}
                            style={{ zIndex: 40 }}
                          />
                        )}
                      </div>
                      {draftBlock && (
                        <div
                          className='border-primary bg-primary/10 pointer-events-none absolute rounded border-2 border-dashed'
                          style={{
                            left: draftBlock.x * scaleRatio,
                            top: draftBlock.y * scaleRatio,
                            width: Math.max(0, draftBlock.width * scaleRatio),
                            height: Math.max(0, draftBlock.height * scaleRatio),
                          }}
                        />
                      )}
                    </div>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className='min-w-32'>
                  <ContextMenuItem
                    disabled={contextMenuBlockIndex === undefined}
                    onSelect={handleDeleteBlock}
                  >
                    {t('workspace.deleteBlock')}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ) : (
              <div className='text-muted-foreground flex h-full w-full items-center justify-center text-sm'>
                {t('workspace.importPrompt')}
              </div>
            )}
          </ScrollAreaPrimitive.Viewport>
          <ScrollAreaPrimitive.Scrollbar
            orientation='vertical'
            className='flex w-2 touch-none p-px select-none'
          >
            <ScrollAreaPrimitive.Thumb className='bg-muted-foreground/40 flex-1 rounded' />
          </ScrollAreaPrimitive.Scrollbar>
          <ScrollAreaPrimitive.Scrollbar
            orientation='horizontal'
            className='flex h-2 touch-none p-px select-none'
          >
            <ScrollAreaPrimitive.Thumb className='bg-muted-foreground/40 rounded' />
          </ScrollAreaPrimitive.Scrollbar>
        </ScrollAreaPrimitive.Root>
      </div>
    </div>
  )
}
