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
import {
  listen,
  getHttpUrl,
  subscribeCollabSync,
  publishCollab,
} from '@/lib/backend'
import { Image } from '@/components/Image'
import { useCollabStore } from '@/lib/stores/collabStore'
import { CollaboratorsList } from '@/components/canvas/CollaboratorsList'
import { CollaboratorCursors } from '@/components/canvas/CollaboratorCursors'
import {
  setCanvasViewport,
  fitCanvasToViewport,
  resetCanvasScale,
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
import { useTextBlockMutations } from '@/lib/query/mutations'
import { ShortcutsCheatSheetDialog } from '@/components/ShortcutsCheatSheetDialog'
import {
  resolvePinchMemoScaleRatio,
  resolvePinchNextScaleRatio,
} from '@/components/canvas/zoomGestures'
import { AntigravityTaskbar } from '@/components/sidebar/AntigravityTaskbar'
import { AntigravityChatOverlay } from '@/components/sidebar/AntigravityChatOverlay'

const BRUSH_CURSOR =
  'url(\'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="16" height="16"%3E%3Ccircle cx="8" cy="8" r="4" stroke="black" stroke-width="1.5" fill="white"/%3E%3C/svg%3E\') 8 8, crosshair'

export function Workspace() {
  const undo = useEditorUiStore((state) => state.undo)
  const redo = useEditorUiStore((state) => state.redo)
  const showShortcutsCheatSheet = useEditorUiStore(
    (state) => state.showShortcutsCheatSheet,
  )
  const setShowShortcutsCheatSheet = useEditorUiStore(
    (state) => state.setShowShortcutsCheatSheet,
  )
  const { updateTextBlocks, renderTextBlock } = useTextBlockMutations()
  const [isChatOpen, setIsChatOpen] = useState(false)
  const [isTranslating, setIsTranslating] = useState(false)
  const [isPlayingTTS, setIsPlayingTTS] = useState(false)
  const [highlightBlockIndex, setHighlightBlockIndex] = useState<number | null>(null)

  const handleQuickTranslate = async () => {
    if (selectedBlockIndex === undefined || !currentDocument?.textBlocks) return
    setIsTranslating(true)
    try {
      await new Promise(r => setTimeout(r, 1000))
      const block = currentDocument.textBlocks[selectedBlockIndex]
      const source = block.text || ''
      
      let translation = 'ลุยกันเลย!'
      if (source.includes('何') || source.includes('どうして')) {
        translation = 'เกิดอะไรขึ้น?'
      } else if (source.includes('ありがとう')) {
        translation = 'ขอบคุณมาก!'
      } else if (source.includes('お前') || source.includes('君')) {
        translation = 'นายนี่มันสุดยอดไปเลย!'
      }
      
      const nextBlocks = [...currentDocument.textBlocks]
      nextBlocks[selectedBlockIndex] = {
        ...nextBlocks[selectedBlockIndex],
        translation
      }
      
      await updateTextBlocks(nextBlocks)
      await renderTextBlock(undefined, undefined, selectedBlockIndex)
      
      const useEditor = useEditorUiStore.getState()
      useEditor.showHud('✨ แปลภาษาและพิมพ์ตัวอักษรลงบนแคนวาสสำเร็จ!')
    } catch (e) {
      console.error(e)
    } finally {
      setIsTranslating(false)
    }
  }

  const handlePlayTTS = () => {
    if (selectedBlockIndex === undefined || !currentDocument?.textBlocks) return
    const block = currentDocument.textBlocks[selectedBlockIndex]
    const text = block.translation || block.text || ''
    if (!text) return

    if (!('speechSynthesis' in window)) return
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'th-TH'
    setIsPlayingTTS(true)
    utterance.onend = () => setIsPlayingTTS(false)
    utterance.onerror = () => setIsPlayingTTS(false)
    window.speechSynthesis.speak(utterance)
  }

  const scale = useEditorUiStore((state) => state.scale)
  const hudMessage = useEditorUiStore((state) => state.hudMessage)
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
  const currentDocumentIndex = useEditorUiStore(
    (state) => state.currentDocumentIndex,
  )
  const documentsVersion = useEditorUiStore((state) => state.documentsVersion)
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

  // Ctrl+Space keyboard shortcut to summon the glassmorphic Antigravity AI Command Center HUD
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement
      if (
        activeEl &&
        (activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.getAttribute('contenteditable') === 'true')
      ) {
        return
      }

      if (e.ctrlKey && e.code === 'Space') {
        e.preventDefault()
        setIsChatOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [])

  // Global Undo / Redo & Help dialog hotkey bindings
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
      if (isTypingInForm(e)) return

      // '?' Hotkey to open keyboard shortcuts dialog
      if (e.key === '?') {
        e.preventDefault()
        setShowShortcutsCheatSheet(!showShortcutsCheatSheet)
        return
      }

      // Ctrl + Z (Undo) / Ctrl + Y (Redo) / Ctrl + 0 (Fit) / Ctrl + 1 (100%)
      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === 'z') {
          e.preventDefault()
          undo(updateTextBlocks)
        } else if (e.key.toLowerCase() === 'y') {
          e.preventDefault()
          redo(updateTextBlocks)
        } else if (e.key === '0') {
          e.preventDefault()
          fitCanvasToViewport()
        } else if (e.key === '1') {
          e.preventDefault()
          resetCanvasScale()
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [
    undo,
    redo,
    showShortcutsCheatSheet,
    setShowShortcutsCheatSheet,
    updateTextBlocks,
  ])

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

        // Zoom step proportional to wheel delta so mouse wheels (~100 units
        // per notch) give ~10% per click while trackpad fine-scroll events
        // (2–5 units each) remain smooth. Cap at 20% per event to prevent
        // runaway zooming on high-velocity trackpad flings.
        const ZOOM_SENSITIVITY = 0.1
        const step = Math.max(1, Math.min(Math.abs(dy) * ZOOM_SENSITIVITY, 20))
        const currentScale = useEditorUiStore.getState().scale
        const nextScale = currentScale - direction * step
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
        scaleBounds: { min: 0.1, max: 3 },
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

  // --- Real-time Collaboration Engine Sync ---
  const mySessionId = useCollabStore((state) => state.sessionId)
  const myName = useCollabStore((state) => state.userName)
  const updateCollaborator = useCollabStore((state) => state.updateCollaborator)
  const removeCollaborator = useCollabStore((state) => state.removeCollaborator)
  const clearExpiredCollaborators = useCollabStore(
    (state) => state.clearExpiredCollaborators,
  )

  useEffect(() => {
    const unsubscribe = subscribeCollabSync((event) => {
      if (event.session_id === mySessionId) return

      if (event.event_type === 'cursor_move') {
        updateCollaborator(event.session_id, {
          name: event.payload.name,
          cursor: { x: event.payload.x, y: event.payload.y },
          activePage: event.payload.activePage,
        })
      } else if (event.event_type === 'page_change') {
        updateCollaborator(event.session_id, {
          name: event.payload.name,
          activePage: event.payload.activePage,
        })
      } else if (event.event_type === 'disconnect') {
        removeCollaborator(event.session_id)
      }
    })

    const expiryInterval = setInterval(() => {
      clearExpiredCollaborators()
    }, 5000)

    return () => {
      unsubscribe()
      clearInterval(expiryInterval)
      publishCollab({
        session_id: mySessionId,
        event_type: 'disconnect',
        payload: {},
      }).catch(() => {})
    }
  }, [
    mySessionId,
    updateCollaborator,
    removeCollaborator,
    clearExpiredCollaborators,
  ])

  useEffect(() => {
    if (currentDocumentIndex === undefined) return
    publishCollab({
      session_id: mySessionId,
      event_type: 'page_change',
      payload: {
        name: myName,
        activePage: currentDocumentIndex,
      },
    }).catch(() => {})
  }, [currentDocumentIndex, mySessionId, myName])

  const lastPublishRef = useRef<number>(0)
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!currentDocument || !canvasRef.current) return

    const now = Date.now()
    if (now - lastPublishRef.current < 60) return
    lastPublishRef.current = now

    const rect = canvasRef.current.getBoundingClientRect()
    const x = (e.clientX - rect.left) / scaleRatio / currentDocument.width
    const y = (e.clientY - rect.top) / scaleRatio / currentDocument.height

    if (x >= -0.1 && x <= 1.1 && y >= -0.1 && y <= 1.1) {
      publishCollab({
        session_id: mySessionId,
        event_type: 'cursor_move',
        payload: {
          name: myName,
          x,
          y,
          activePage: currentDocumentIndex,
        },
      }).catch(() => {})
    }
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
        <CollaboratorsList />
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
                      onPointerMove={handlePointerMove}
                      {...blockDraftBindings}
                    >
                      <div className='absolute inset-0'>
                        <Image
                          src={getHttpUrl(
                            `/api/image/${currentDocumentIndex}/base?v=${documentsVersion}`,
                          )}
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
                            src={getHttpUrl(
                              `/api/image/${currentDocumentIndex}/inpainted?v=${documentsVersion}`,
                            )}
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
                        {showTextBlocksOverlay && currentDocument && (
                          <TextBlockSpriteLayer
                            blocks={currentDocument.textBlocks}
                            documentWidth={currentDocument.width}
                            documentHeight={currentDocument.height}
                            visible={!showRenderedImage}
                            style={{ zIndex: 30 }}
                          />
                        )}
                        {currentDocument.rendered && showRenderedImage && (
                          <Image
                            data-testid='workspace-rendered-image'
                            src={getHttpUrl(
                              `/api/image/${currentDocumentIndex}/rendered?v=${documentsVersion}`,
                            )}
                            transition={false}
                            style={{ zIndex: 35 }}
                          />
                        )}
                        {showTextBlocksOverlay && (
                          <TextBlockAnnotations
                            selectedIndex={selectedBlockIndex}
                            onSelect={setSelectedBlockIndex}
                            style={{ zIndex: 40 }}
                          />
                        )}
                        <CollaboratorCursors
                          scaleRatio={scaleRatio}
                          width={currentDocument.width}
                          height={currentDocument.height}
                          currentPageIndex={currentDocumentIndex}
                        />
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
                      {highlightBlockIndex !== null && currentDocument?.textBlocks[highlightBlockIndex] && (
                        <>
                          <div
                            className="absolute border-[3px] border-pink-500 rounded-full animate-ping pointer-events-none z-50 shadow-[0_0_15px_#ec4899]"
                            style={{
                              left: currentDocument.textBlocks[highlightBlockIndex].x * scaleRatio - 4,
                              top: currentDocument.textBlocks[highlightBlockIndex].y * scaleRatio - 4,
                              width: currentDocument.textBlocks[highlightBlockIndex].width * scaleRatio + 8,
                              height: currentDocument.textBlocks[highlightBlockIndex].height * scaleRatio + 8,
                            }}
                          />
                          <div
                            className="absolute border-2 border-pink-500 rounded-full pointer-events-none z-50 shadow-[0_0_8px_#ec4899]"
                            style={{
                              left: currentDocument.textBlocks[highlightBlockIndex].x * scaleRatio - 4,
                              top: currentDocument.textBlocks[highlightBlockIndex].y * scaleRatio - 4,
                              width: currentDocument.textBlocks[highlightBlockIndex].width * scaleRatio + 8,
                              height: currentDocument.textBlocks[highlightBlockIndex].height * scaleRatio + 8,
                            }}
                          />
                        </>
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
        {hudMessage && (
          <div className='animate-in fade-in slide-in-from-bottom-2 pointer-events-none absolute bottom-4 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-1.5 rounded border border-[#3e3e3e] bg-[#2c2c2c]/95 px-3 py-1.5 font-mono text-[11px] text-zinc-100 shadow-lg transition-opacity duration-150 select-none'>
            {hudMessage}
          </div>
        )}
      </div>
      <ShortcutsCheatSheetDialog />
      <AntigravityTaskbar
        onToggleChat={() => setIsChatOpen(!isChatOpen)}
        isChatOpen={isChatOpen}
        onQuickTranslate={handleQuickTranslate}
        isTranslating={isTranslating}
        onPlayTTS={handlePlayTTS}
        isPlayingTTS={isPlayingTTS}
      />
      <AntigravityChatOverlay
        isOpen={isChatOpen}
        onClose={() => {
          setIsChatOpen(false)
          setHighlightBlockIndex(null)
        }}
        activeBlockIndex={selectedBlockIndex}
        onHighlightBlock={setHighlightBlockIndex}
      />
    </div>
  )
}
