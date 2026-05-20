import { blobUrl } from '@/lib/backend'
import type { RgbaColor } from '@/types'

/**
 * Auto-contrast text colour: sample the background under a text block
 * and pick black or white for best legibility.
 *
 * The "background" is the inpainted page (text already removed) when
 * available, else the source image. We average Rec.601 perceived
 * luminance over the block's bbox; bright background → black text,
 * dark → white. The /blob route ships CORS headers so the canvas
 * isn't tainted by getImageData.
 */

const imageCache = new Map<string, Promise<HTMLImageElement>>()

function loadImage(hex: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(hex)
  if (cached) return cached
  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = (e) => {
      imageCache.delete(hex)
      reject(e)
    }
    img.src = blobUrl(hex)
  })
  imageCache.set(hex, promise)
  return promise
}

export type ContrastRegion = {
  x: number
  y: number
  width: number
  height: number
}

const BLACK: RgbaColor = [0, 0, 0, 255]
const WHITE: RgbaColor = [255, 255, 255, 255]

export async function autoContrastColor(
  sourceHex: string,
  region: ContrastRegion,
): Promise<RgbaColor> {
  const img = await loadImage(sourceHex)
  const sx = Math.max(0, Math.floor(region.x))
  const sy = Math.max(0, Math.floor(region.y))
  const sw = Math.max(1, Math.min(Math.floor(region.width), img.naturalWidth - sx))
  const sh = Math.max(
    1,
    Math.min(Math.floor(region.height), img.naturalHeight - sy),
  )

  const canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return BLACK
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)

  const { data } = ctx.getImageData(0, 0, sw, sh)
  let sum = 0
  let count = 0
  // Stride-sample so a huge box doesn't scan every pixel (~4k samples).
  const pixelStride = Math.max(1, Math.floor((sw * sh) / 4000))
  const step = pixelStride * 4
  for (let i = 0; i + 2 < data.length; i += step) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    count++
  }
  const avg = count ? sum / count : 255
  // 140 ≈ midpoint biased slightly toward black text (manga pages are
  // mostly light), tuned so screentone greys still pick black.
  return avg >= 140 ? BLACK : WHITE
}
