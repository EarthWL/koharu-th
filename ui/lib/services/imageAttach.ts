/**
 * Image attachment prep for the AI Chat panel.
 *
 * Multi-modal cloud LLM calls charge per image and bloat both the
 * request body and our SQLite — so we downsize every attachment to
 * ≤1024px on the long edge and re-encode as JPEG q85 before sending /
 * persisting. Aspect ratio preserved. Returns a base64 data URL ready
 * to drop into provider message blocks.
 */

import type { ChatAttachment } from '@/lib/api'

const MAX_DIMENSION = 1024
const JPEG_QUALITY = 0.85

export async function blobToAttachment(blob: Blob): Promise<ChatAttachment> {
  const bitmap = await createImageBitmap(blob)
  const { width: srcW, height: srcH } = bitmap
  const scale = Math.min(1, MAX_DIMENSION / Math.max(srcW, srcH))
  const dstW = Math.max(1, Math.round(srcW * scale))
  const dstH = Math.max(1, Math.round(srcH * scale))

  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(dstW, dstH)
      : (() => {
          const c = document.createElement('canvas')
          c.width = dstW
          c.height = dstH
          return c
        })()
  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null
  if (!ctx) throw new Error('Could not get 2D context for downsizing')
  ctx.drawImage(bitmap, 0, 0, dstW, dstH)
  bitmap.close?.()

  let outBlob: Blob
  if ('convertToBlob' in canvas) {
    outBlob = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: JPEG_QUALITY,
    })
  } else {
    outBlob = await new Promise<Blob>((resolve, reject) => {
      ;(canvas as HTMLCanvasElement).toBlob(
        (b) =>
          b ? resolve(b) : reject(new Error('Canvas toBlob returned null')),
        'image/jpeg',
        JPEG_QUALITY,
      )
    })
  }

  const dataUrl = await blobToDataUrl(outBlob)
  return {
    dataUrl,
    mimeType: 'image/jpeg',
    width: dstW,
    height: dstH,
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error ?? new Error('FileReader failed'))
    r.readAsDataURL(blob)
  })
}

/** Parse the JSON string stored in `chat_messages.attachments`. */
export function parseAttachments(raw: string | null | undefined): ChatAttachment[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
