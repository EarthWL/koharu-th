'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ZoomInIcon, ZoomOutIcon, CompassIcon } from 'lucide-react'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { useCurrentDocumentState } from '@/lib/query/hooks'
import { getHttpUrl } from '@/lib/backend'
import { getCanvasViewport } from '@/components/canvas/canvasViewport'
import { Slider } from '@/components/ui/slider'
import { Button } from '@/components/ui/button'

export function NavigatorWidget() {
  const { t } = useTranslation()
  const { currentDocument: doc, currentDocumentIndex } =
    useCurrentDocumentState()
  const scale = useEditorUiStore((state) => state.scale)
  const setScale = useEditorUiStore((state) => state.setScale)
  const documentsVersion = useEditorUiStore((state) => state.documentsVersion)

  const thumbnailRef = useRef<HTMLDivElement | null>(null)

  // Re-render when viewport scroll changes
  const [viewportState, setViewportState] = useState({
    scrollLeft: 0,
    scrollTop: 0,
    scrollWidth: 1,
    scrollHeight: 1,
    clientWidth: 1,
    clientHeight: 1,
  })

  useEffect(() => {
    const el = getCanvasViewport()
    if (!el) return

    const handleUpdate = () => {
      setViewportState({
        scrollLeft: el.scrollLeft,
        scrollTop: el.scrollTop,
        scrollWidth: el.scrollWidth,
        scrollHeight: el.scrollHeight,
        clientWidth: el.clientWidth,
        clientHeight: el.clientHeight,
      })
    }

    el.addEventListener('scroll', handleUpdate)
    handleUpdate()

    const observer = new ResizeObserver(handleUpdate)
    observer.observe(el)

    // Poll occasionally to handle zoom changes or other dynamic canvas layout shifts
    const timer = setInterval(handleUpdate, 350)

    return () => {
      el.removeEventListener('scroll', handleUpdate)
      observer.disconnect()
      clearInterval(timer)
    }
  }, [currentDocumentIndex, scale])

  const handleDrag = (e: React.MouseEvent | MouseEvent) => {
    const el = getCanvasViewport()
    const thumb = thumbnailRef.current
    if (!el || !thumb) return

    const rect = thumb.getBoundingClientRect()
    // Calculate click coordinates normalized [0, 1] relative to the actual image bounds in thumbnail
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))

    // Set scroll center
    el.scrollLeft = x * el.scrollWidth - el.clientWidth / 2
    el.scrollTop = y * el.scrollHeight - el.clientHeight / 2
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    handleDrag(e)

    const handleMouseMove = (moveEvent: MouseEvent) => {
      handleDrag(moveEvent)
    }
    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }

  if (!doc) {
    return (
      <div className='bg-card/40 text-muted-foreground flex flex-col items-center justify-center gap-2 rounded border p-6 text-xs'>
        <CompassIcon className='text-muted-foreground/50 size-5 animate-pulse' />
        <span>No Page Loaded</span>
      </div>
    )
  }

  // Width of the red frame
  const redFrameWidthPct = Math.max(
    5,
    Math.min(
      100,
      (viewportState.clientWidth / viewportState.scrollWidth) * 100,
    ),
  )
  const redFrameHeightPct = Math.max(
    5,
    Math.min(
      100,
      (viewportState.clientHeight / viewportState.scrollHeight) * 100,
    ),
  )
  const redFrameLeftPct = Math.max(
    0,
    Math.min(95, (viewportState.scrollLeft / viewportState.scrollWidth) * 100),
  )
  const redFrameTopPct = Math.max(
    0,
    Math.min(95, (viewportState.scrollTop / viewportState.scrollHeight) * 100),
  )

  const imageUrl = getHttpUrl(
    `/api/image/${currentDocumentIndex}/base?v=${documentsVersion}`,
  )

  return (
    <div className='bg-card/65 flex flex-col gap-2 rounded-lg border p-2.5 shadow-sm backdrop-blur-xs select-none'>
      {/* Aspect Ratio Box Wrapper */}
      <div
        ref={thumbnailRef}
        onMouseDown={handleMouseDown}
        className='bg-muted/30 border-border/40 group hover:border-primary/20 relative flex aspect-square max-h-[140px] w-full cursor-crosshair items-center justify-center overflow-hidden rounded border transition-colors'
      >
        <img
          src={imageUrl}
          alt='Navigator Thumbnail'
          className='pointer-events-none max-h-full max-w-full object-contain'
        />

        {/* Red Viewport Window Frame */}
        <div
          className='pointer-events-none absolute border-[1.5px] border-rose-500 bg-rose-500/5 shadow-[0_0_8px_rgba(239,68,68,0.25)] transition-[left,top,width,height] duration-75'
          style={{
            left: `${redFrameLeftPct}%`,
            top: `${redFrameTopPct}%`,
            width: `${redFrameWidthPct}%`,
            height: `${redFrameHeightPct}%`,
          }}
        />
      </div>

      {/* Zoom Slider and Percentage */}
      <div className='mt-1 flex items-center gap-2'>
        <Button
          variant='ghost'
          size='icon-sm'
          className='text-muted-foreground hover:text-primary size-6 shrink-0 transition-colors'
          onClick={() => setScale(Math.max(10, scale - 10))}
          title='Zoom Out'
        >
          <ZoomOutIcon className='size-3.5' />
        </Button>

        <Slider
          value={[scale]}
          min={10}
          max={300}
          step={5}
          onValueChange={(val) => setScale(val[0])}
          className='flex-1 cursor-pointer'
        />

        <Button
          variant='ghost'
          size='icon-sm'
          className='text-muted-foreground hover:text-primary size-6 shrink-0 transition-colors'
          onClick={() => setScale(Math.min(300, scale + 10))}
          title='Zoom In'
        >
          <ZoomInIcon className='size-3.5' />
        </Button>

        <span className='bg-muted/60 text-muted-foreground min-w-[34px] shrink-0 rounded border px-1.5 py-0.5 text-center font-mono text-[10px] font-bold'>
          {scale}%
        </span>
      </div>
    </div>
  )
}
