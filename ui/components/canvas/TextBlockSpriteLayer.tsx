'use client'

import { memo } from 'react'
import { TextBlock } from '@/types'
import {
  cancelObjectUrlRevoke,
  convertToBlob,
  revokeObjectUrlLater,
} from '@/lib/util'

type TextBlockSpriteLayerProps = {
  blocks?: TextBlock[]
  documentWidth: number
  documentHeight: number
  visible: boolean
  style?: React.CSSProperties
}

class SpriteCache {
  private cache = new Map<Uint8Array, string>()
  private keys: Uint8Array[] = []
  private maxItems = 100

  get(bytes: Uint8Array): string {
    const existing = this.cache.get(bytes)
    if (existing) return existing

    const blob = convertToBlob(bytes)
    const url = URL.createObjectURL(blob)
    cancelObjectUrlRevoke(url)

    this.cache.set(bytes, url)
    this.keys.push(bytes)

    if (this.keys.length > this.maxItems) {
      const oldest = this.keys.shift()!
      const oldestUrl = this.cache.get(oldest)
      if (oldestUrl) {
        this.cache.delete(oldest)
        revokeObjectUrlLater(oldestUrl)
      }
    }
    return url
  }
}

const spriteCache = new SpriteCache()

export function TextBlockSpriteLayer({
  blocks,
  documentWidth,
  documentHeight,
  visible,
  style,
}: TextBlockSpriteLayerProps) {
  const renderBlocks = blocks ?? []

  return (
    <div
      data-text-sprite-layer
      aria-hidden
      style={{
        ...style,
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        opacity: visible ? 1 : 0,
      }}
    >
      {renderBlocks.map((block, index) => (
        <TextBlockSprite
          key={`${block.x}-${block.y}-${index}`}
          block={block}
          documentWidth={documentWidth}
          documentHeight={documentHeight}
        />
      ))}
    </div>
  )
}

const TextBlockSprite = memo(function TextBlockSprite({
  block,
  documentWidth,
  documentHeight,
}: {
  block: TextBlock
  documentWidth: number
  documentHeight: number
}) {
  const sprite = block.rendered
  if (block.visible === false || !sprite?.length || documentWidth <= 0 || documentHeight <= 0) {
    return null
  }

  const src = spriteCache.get(sprite)

  return (
    <img
      alt=''
      src={src}
      draggable={false}
      style={{
        position: 'absolute',
        left: `${(block.x / documentWidth) * 100}%`,
        top: `${(block.y / documentHeight) * 100}%`,
        width: `${(block.width / documentWidth) * 100}%`,
        height: `${(block.height / documentHeight) * 100}%`,
        transformOrigin: 'center',
        transform: `rotate(${block.rotationDeg ?? 0}deg)`,
        userSelect: 'none',
        pointerEvents: 'none',
        opacity: block.style?.opacity ?? 1.0,
      }}
    />
  )
})
