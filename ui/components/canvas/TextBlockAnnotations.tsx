'use client'

import { useEffect, useState } from 'react'
import { Rnd, type RndResizeCallback, type RndDragCallback } from 'react-rnd'
import { useHotkeys } from 'react-hotkeys-hook'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { TextBlock } from '@/types'
import { useTextBlocks } from '@/hooks/useTextBlocks'

type TextBlockAnnotationsProps = {
  selectedIndex?: number
  onSelect: (index?: number) => void
  style?: React.CSSProperties
}

export function TextBlockAnnotations({
  selectedIndex,
  onSelect,
  style,
}: TextBlockAnnotationsProps) {
  const { textBlocks, replaceBlock, removeBlock } = useTextBlocks()
  const mode = useEditorUiStore((state) => state.mode)
  const interactive = mode === 'select' || mode === 'block'

  useHotkeys(
    'backspace,delete',
    (event) => {
      if (!interactive || selectedIndex === undefined) return
      const target = event.target as HTMLElement | null
      const isEditable = target?.closest('input, textarea, [contenteditable]')
      if (isEditable) return
      event.preventDefault()
      void removeBlock(selectedIndex)
    },
    {
      enabled: interactive,
      preventDefault: true,
      enableOnFormTags: false,
    },
    [interactive, removeBlock, selectedIndex],
  )

  const activeXLine = useEditorUiStore((state) => state.activeXLine)
  const activeYLine = useEditorUiStore((state) => state.activeYLine)

  return (
    <div
      data-testid='workspace-annotations'
      className='absolute inset-0'
      data-annotation-layer
      style={{
        ...style,
        pointerEvents: 'none',
      }}
    >
      {/* Smart Guide vertical line */}
      {activeXLine !== null && (
        <div
          className="absolute top-0 bottom-0 border-l border-dashed border-[#e91e63] z-50 opacity-90"
          style={{ left: activeXLine, width: '1px' }}
        />
      )}
      {/* Smart Guide horizontal line */}
      {activeYLine !== null && (
        <div
          className="absolute left-0 right-0 border-t border-dashed border-[#e91e63] z-50 opacity-90"
          style={{ top: activeYLine, height: '1px' }}
        />
      )}

      {textBlocks.map((block, index) => (
        <TextBlockAnnotation
          key={`${block.x}-${block.y}-${index}`}
          block={block}
          index={index}
          selected={index === selectedIndex}
          onSelect={onSelect}
          interactive={interactive}
          onUpdate={(updates) => void replaceBlock(index, updates)}
        />
      ))}
    </div>
  )
}

type TextBlockAnnotationProps = {
  block: TextBlock
  index: number
  selected: boolean
  interactive: boolean
  onSelect: (index: number) => void
  onUpdate: (updates: Partial<TextBlock>) => void
}

function TextBlockAnnotation({
  block,
  index,
  selected,
  interactive,
  onSelect,
  onUpdate,
}: TextBlockAnnotationProps) {
  const scale = useEditorUiStore((state) => state.scale)
  const scaleRatio = scale / 100
  const showHud = useEditorUiStore((state) => state.showHud)
  const copiedStyle = useEditorUiStore((state) => state.copiedStyle)
  const setCopiedStyle = useEditorUiStore((state) => state.setCopiedStyle)

  const scaledSize = {
    width: Math.max(0, block.width * scaleRatio),
    height: Math.max(0, block.height * scaleRatio),
  }

  const scaledPosition = {
    x: block.x * scaleRatio,
    y: block.y * scaleRatio,
  }

  const [size, setSize] = useState(scaledSize)
  const [position, setPosition] = useState(scaledPosition)

  // Keyboard nudge position (Arrow keys)
  useHotkeys(
    'up,down,left,right,shift+up,shift+down,shift+left,shift+right',
    (event) => {
      if (!interactive || !selected) return
      const target = event.target as HTMLElement | null
      const isEditable = target?.closest('input, textarea, [contenteditable]')
      if (isEditable) return

      event.preventDefault()

      const step = event.shiftKey ? 10 : 1
      let dx = 0
      let dy = 0

      const key = event.key
      if (key === 'ArrowLeft') dx = -step
      else if (key === 'ArrowRight') dx = step
      else if (key === 'ArrowUp') dy = -step
      else if (key === 'ArrowDown') dy = step

      onUpdate({
        x: block.x + dx,
        y: block.y + dy,
      })
      showHud(`X: ${block.x + dx}px  Y: ${block.y + dy}px`)
    },
    {
      enabled: selected && interactive,
      preventDefault: true,
      enableOnFormTags: false,
    },
    [selected, interactive, block.x, block.y, onUpdate]
  )

  // Keyboard adjust font size ([ and ])
  useHotkeys(
    '[,],shift+[,shift+]',
    (event) => {
      if (!interactive || !selected) return
      const target = event.target as HTMLElement | null
      const isEditable = target?.closest('input, textarea, [contenteditable]')
      if (isEditable) return

      event.preventDefault()

      const step = event.shiftKey ? 5 : 1
      const currentStyle = block.style || { fontFamilies: [] }
      const currentSize = currentStyle.fontSize ?? block.detectedFontSizePx ?? 16
      const delta = event.key === ']' ? step : -step
      const nextSize = Math.max(6, Math.min(300, currentSize + delta))

      onUpdate({
        style: {
          ...currentStyle,
          fontSize: nextSize
        }
      })
      showHud(`Font Size: ${nextSize}px`)
    },
    {
      enabled: selected && interactive,
      preventDefault: true,
      enableOnFormTags: false,
    },
    [selected, interactive, block.style, block.detectedFontSizePx, onUpdate]
  )

  // Keyboard adjust typography settings (Alt + Arrows for Leading/Tracking)
  useHotkeys(
    'alt+up,alt+down,alt+left,alt+right',
    (event) => {
      if (!interactive || !selected) return
      const target = event.target as HTMLElement | null
      const isEditable = target?.closest('input, textarea, [contenteditable]')
      if (isEditable) return

      event.preventDefault()

      const currentStyle = block.style || { fontFamilies: [] }

      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const currentLineHeight = currentStyle.lineHeight ?? 1.0
        const delta = event.key === 'ArrowDown' ? 0.05 : -0.05
        const nextVal = Number(Math.max(0.8, Math.min(2.0, currentLineHeight + delta)).toFixed(2))
        onUpdate({
          style: {
            ...currentStyle,
            lineHeight: nextVal
          }
        })
        showHud(`Line Height: ${nextVal}`)
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const currentLetterSpacing = currentStyle.letterSpacingPx ?? 0
        const delta = event.key === 'ArrowRight' ? 0.5 : -0.5
        const nextVal = Number(Math.max(-2, Math.min(8, currentLetterSpacing + delta)).toFixed(1))
        onUpdate({
          style: {
            ...currentStyle,
            letterSpacingPx: nextVal
          }
        })
        showHud(`Letter Spacing: ${nextVal}px`)
      }
    },
    {
      enabled: selected && interactive,
      preventDefault: true,
      enableOnFormTags: false,
    },
    [selected, interactive, block.style, onUpdate]
  )

  // Keyboard adjust rotation (Alt + [ and ])
  useHotkeys(
    'alt+[,alt+],alt+shift+[,alt+shift+]',
    (event) => {
      if (!interactive || !selected) return
      const target = event.target as HTMLElement | null
      const isEditable = target?.closest('input, textarea, [contenteditable]')
      if (isEditable) return

      event.preventDefault()

      const step = event.shiftKey ? 15 : 1
      const currentRotation = block.rotationDeg ?? 0
      const delta = event.key === ']' ? step : -step
      let nextRotation = currentRotation + delta
      if (nextRotation > 180) nextRotation -= 360
      if (nextRotation < -180) nextRotation += 360

      onUpdate({
        rotationDeg: nextRotation
      })
      showHud(`Angle: ${nextRotation}°`)
    },
    {
      enabled: selected && interactive,
      preventDefault: true,
      enableOnFormTags: false,
    },
    [selected, interactive, block.rotationDeg, onUpdate]
  )

  // Keyboard copy-paste style
  useHotkeys(
    'ctrl+alt+c,ctrl+shift+c',
    (event) => {
      if (!interactive || !selected) return
      event.preventDefault()
      if (block.style) {
        setCopiedStyle(block.style)
        showHud('Copied Style')
      } else {
        showHud('No Style to Copy')
      }
    },
    {
      enabled: selected && interactive,
      preventDefault: true,
      enableOnFormTags: false,
    },
    [selected, interactive, block.style, setCopiedStyle, showHud]
  )

  useHotkeys(
    'ctrl+alt+v,ctrl+shift+v',
    (event) => {
      if (!interactive || !selected) return
      event.preventDefault()
      if (copiedStyle) {
        onUpdate({
          style: {
            ...block.style,
            ...copiedStyle
          }
        })
        showHud('Pasted Style')
      } else {
        showHud('No Copied Style')
      }
    },
    {
      enabled: selected && interactive,
      preventDefault: true,
      enableOnFormTags: false,
    },
    [selected, interactive, block.style, copiedStyle, onUpdate, showHud]
  )

  useEffect(() => {
    setSize(scaledSize)
    setPosition(scaledPosition)
  }, [scaledPosition.x, scaledPosition.y, scaledSize.width, scaledSize.height])

  const setActiveGuides = useEditorUiStore((state) => state.setActiveGuides)
  const { textBlocks } = useTextBlocks()

  const handleDrag: RndDragCallback = (_, data) => {
    if (!interactive) return

    const threshold = 6
    let snapX = data.x
    let snapY = data.y
    let activeX: number | null = null
    let activeY: number | null = null

    const currentLeft = data.x
    const currentWidth = size.width
    const currentRight = currentLeft + currentWidth
    const currentCenterX = currentLeft + currentWidth / 2

    const currentTop = data.y
    const currentHeight = size.height
    const currentBottom = currentTop + currentHeight
    const currentCenterY = currentTop + currentHeight / 2

    for (let i = 0; i < textBlocks.length; i++) {
      if (i === index) continue
      const other = textBlocks[i]
      const otherLeft = other.x * scaleRatio
      const otherWidth = other.width * scaleRatio
      const otherRight = otherLeft + otherWidth
      const otherCenterX = otherLeft + otherWidth / 2

      const otherTop = other.y * scaleRatio
      const otherHeight = other.height * scaleRatio
      const otherBottom = otherTop + otherHeight
      const otherCenterY = otherTop + otherHeight / 2

      // Snapping vertically (X-axis alignment)
      if (Math.abs(currentLeft - otherLeft) < threshold) {
        snapX = otherLeft
        activeX = otherLeft
      } else if (Math.abs(currentRight - otherRight) < threshold) {
        snapX = otherRight - currentWidth
        activeX = otherRight
      } else if (Math.abs(currentCenterX - otherCenterX) < threshold) {
        snapX = otherCenterX - currentWidth / 2
        activeX = otherCenterX
      } else if (Math.abs(currentLeft - otherRight) < threshold) {
        snapX = otherRight
        activeX = otherRight
      } else if (Math.abs(currentRight - otherLeft) < threshold) {
        snapX = otherLeft - currentWidth
        activeX = otherLeft
      }

      // Snapping horizontally (Y-axis alignment)
      if (Math.abs(currentTop - otherTop) < threshold) {
        snapY = otherTop
        activeY = otherTop
      } else if (Math.abs(currentBottom - otherBottom) < threshold) {
        snapY = otherBottom - currentHeight
        activeY = otherBottom
      } else if (Math.abs(currentCenterY - otherCenterY) < threshold) {
        snapY = otherCenterY - currentHeight / 2
        activeY = otherCenterY
      } else if (Math.abs(currentTop - otherBottom) < threshold) {
        snapY = otherBottom
        activeY = otherBottom
      } else if (Math.abs(currentBottom - otherTop) < threshold) {
        snapY = otherTop - currentHeight
        activeY = otherTop
      }
    }

    setPosition({ x: snapX, y: snapY })
    setActiveGuides(activeX, activeY)
  }

  const handleDragStop: RndDragCallback = (_, data) => {
    if (!interactive) return
    
    const threshold = 6
    let snapX = data.x
    let snapY = data.y

    const currentLeft = data.x
    const currentWidth = size.width
    const currentRight = currentLeft + currentWidth
    const currentCenterX = currentLeft + currentWidth / 2

    const currentTop = data.y
    const currentHeight = size.height
    const currentBottom = currentTop + currentHeight
    const currentCenterY = currentTop + currentHeight / 2

    for (let i = 0; i < textBlocks.length; i++) {
      if (i === index) continue
      const other = textBlocks[i]
      const otherLeft = other.x * scaleRatio
      const otherWidth = other.width * scaleRatio
      const otherRight = otherLeft + otherWidth
      const otherCenterX = otherLeft + otherWidth / 2

      const otherTop = other.y * scaleRatio
      const otherHeight = other.height * scaleRatio
      const otherBottom = otherTop + otherHeight
      const otherCenterY = otherTop + otherHeight / 2

      if (Math.abs(currentLeft - otherLeft) < threshold) {
        snapX = otherLeft
      } else if (Math.abs(currentRight - otherRight) < threshold) {
        snapX = otherRight - currentWidth
      } else if (Math.abs(currentCenterX - otherCenterX) < threshold) {
        snapX = otherCenterX - currentWidth / 2
      } else if (Math.abs(currentLeft - otherRight) < threshold) {
        snapX = otherRight
      } else if (Math.abs(currentRight - otherLeft) < threshold) {
        snapX = otherLeft - currentWidth
      }

      if (Math.abs(currentTop - otherTop) < threshold) {
        snapY = otherTop
      } else if (Math.abs(currentBottom - otherBottom) < threshold) {
        snapY = otherBottom - currentHeight
      } else if (Math.abs(currentCenterY - otherCenterY) < threshold) {
        snapY = otherCenterY - currentHeight / 2
      } else if (Math.abs(currentTop - otherBottom) < threshold) {
        snapY = otherBottom
      } else if (Math.abs(currentBottom - otherTop) < threshold) {
        snapY = otherTop - currentHeight
      }
    }

    const finalPosition = { x: snapX, y: snapY }
    setPosition(finalPosition)
    setActiveGuides(null, null)

    onUpdate({
      x: Math.round(finalPosition.x / scaleRatio),
      y: Math.round(finalPosition.y / scaleRatio),
    })
  }

  const handleResize: RndResizeCallback = (_, __, ref, ___, nextPosition) => {
    if (!interactive || !selected) return
    setSize({
      width: parseFloat(ref.style.width),
      height: parseFloat(ref.style.height),
    })
    setPosition(nextPosition)
  }

  const handleResizeStop: RndResizeCallback = (_, __, ref, ___, position) => {
    if (!interactive || !selected) return
    const widthPx = parseFloat(ref.style.width)
    const heightPx = parseFloat(ref.style.height)
    const nextSize = {
      width: widthPx,
      height: heightPx,
    }
    setSize(nextSize)
    setPosition(position)
    onUpdate({
      x: Math.round(position.x / scaleRatio),
      y: Math.round(position.y / scaleRatio),
      width: Math.max(4, Math.round(nextSize.width / scaleRatio)),
      height: Math.max(4, Math.round(nextSize.height / scaleRatio)),
    })
  }

  return (
    <Rnd
      size={size}
      position={position}
      bounds='parent'
      disableDragging={!interactive}
      enableResizing={
        selected && interactive
          ? {
              bottom: true,
              bottomLeft: true,
              bottomRight: true,
              left: true,
              right: true,
              top: true,
              topLeft: true,
              topRight: true,
            }
          : false
      }
      onDragStart={() => {
        if (!interactive) return
        onSelect(index)
      }}
      onDrag={handleDrag}
      onDragStop={handleDragStop}
      onResizeStart={() => {
        if (!interactive) return
        onSelect(index)
      }}
      onResize={handleResize}
      onResizeStop={handleResizeStop}
      onMouseDown={(event) => {
        if (!interactive) return
        event.stopPropagation()
        onSelect(index)
      }}
      onPointerDown={(event) => {
        if (!interactive) return
        event.stopPropagation()
        onSelect(index)
      }}
      style={{
        zIndex: selected ? 20 : 10,
        pointerEvents: interactive ? 'auto' : 'none',
        transform: `rotate(${block.rotationDeg ?? 0}deg)`,
        transformOrigin: 'center',
      }}
      className='absolute'
    >
      <div 
        className='relative h-full w-full select-none'
        onDoubleClick={(event) => {
          if (!interactive) return
          event.stopPropagation()
          onSelect(index)
          
          setTimeout(() => {
            const el = window.document.querySelector(
              `[data-testid="textblock-translation-${index}"]`
            ) as HTMLTextAreaElement | null
            if (el) {
              el.focus()
              el.select()
            }
          }, 150)
        }}
      >
        <div
          className={`absolute inset-0 rounded ${
            selected
              ? 'border-primary bg-primary/15 border-[3px]'
              : 'border-2 border-rose-400/60 bg-rose-400/5'
          }`}
        />
        <div
          className={`pointer-events-none absolute -top-1.5 -left-1.5 flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold text-white shadow ${
            selected ? 'bg-primary' : 'bg-rose-400'
          }`}
        >
          {index + 1}
        </div>
      </div>
    </Rnd>
  )
}
