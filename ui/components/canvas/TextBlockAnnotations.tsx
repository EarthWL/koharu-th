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
    },
    {
      enabled: selected && interactive,
      preventDefault: true,
      enableOnFormTags: false,
    },
    [selected, interactive, block.rotationDeg, onUpdate]
  )

  useEffect(() => {
    setSize(scaledSize)
    setPosition(scaledPosition)
  }, [scaledPosition.x, scaledPosition.y, scaledSize.width, scaledSize.height])

  const handleDrag: RndDragCallback = (_, data) => {
    if (!interactive) return
    setPosition({ x: data.x, y: data.y })
  }

  const handleDragStop: RndDragCallback = (_, data) => {
    if (!interactive) return
    const nextPosition = { x: data.x, y: data.y }
    setPosition(nextPosition)
    onUpdate({
      x: Math.round(nextPosition.x / scaleRatio),
      y: Math.round(nextPosition.y / scaleRatio),
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
      <div className='relative h-full w-full select-none'>
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
