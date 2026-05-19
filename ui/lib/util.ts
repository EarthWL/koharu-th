import { blobUrl } from '@/lib/backend'

/** Extract a standalone ArrayBuffer from a Uint8Array view (msgpack may return views into a shared decode buffer). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
}

/**
 * Fetch a content-addressed blob and decode it directly into an
 * `ImageBitmap` — skips the intermediate `Uint8Array` allocation
 * since `createImageBitmap` accepts a `Blob` directly and the
 * browser's GPU-accelerated decoder runs off the main thread.
 *
 * Use this from canvas drawing code that needs a bitmap (e.g.
 * mask + brush-layer overlays). For code that needs the raw bytes
 * (e.g. attachment wrapping, backend re-encode), use
 * {@link fetchBlobBytes} instead.
 */
export async function fetchBlobAsImageBitmap(
  hex: string,
): Promise<ImageBitmap> {
  const response = await fetch(blobUrl(hex))
  if (!response.ok) {
    throw new Error(
      `blob fetch ${hex.slice(0, 12)}… failed: HTTP ${response.status}`,
    )
  }
  const blob = await response.blob()
  return createImageBitmap(blob)
}

/**
 * Fetch a content-addressed blob's raw bytes by its hex `BlobId`.
 *
 * The backend's `/blob/:hex` route serves WebP-lossless-encoded
 * bytes with `Cache-Control: private, max-age=31536000, immutable`,
 * so the second call against the same hex returns from the browser
 * cache (zero network roundtrip). Use this when you need the raw
 * decoded bytes for code that can't consume an HTML `<img src>`
 * URL directly — examples: feeding the bytes into a `Blob` for an
 * AI Chat attachment, decoding to `ImageBitmap` for canvas drawing,
 * or sending to a backend op that expects a `Uint8Array`.
 *
 * Throws on non-2xx response. The route returns
 * `Cache-Control: no-store` on 4xx/5xx (see
 * `koharu-rpc/src/server.rs`) so error responses never get pinned.
 */
export async function fetchBlobBytes(hex: string): Promise<Uint8Array> {
  const response = await fetch(blobUrl(hex))
  if (!response.ok) {
    throw new Error(
      `blob fetch ${hex.slice(0, 12)}… failed: HTTP ${response.status}`,
    )
  }
  const arr = await response.arrayBuffer()
  return new Uint8Array(arr)
}

export function convertToBlob(bytes: Uint8Array): Blob {
  return new Blob([toArrayBuffer(bytes)])
}

export function convertToImageBitmap(bytes: Uint8Array): Promise<ImageBitmap> {
  const blob = convertToBlob(bytes)
  return createImageBitmap(blob)
}

export async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  const buffer = await blob.arrayBuffer()
  return new Uint8Array(buffer)
}

const pendingObjectUrlRevokes = new Map<string, ReturnType<typeof setTimeout>>()

export function revokeObjectUrlLater(
  url: string | null | undefined,
  delayMs = 30_000,
) {
  if (!url) return
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') {
    return
  }
  const pending = pendingObjectUrlRevokes.get(url)
  if (pending) {
    clearTimeout(pending)
  }
  const timer = setTimeout(() => {
    pendingObjectUrlRevokes.delete(url)
    try {
      URL.revokeObjectURL(url)
    } catch {}
  }, delayMs)
  pendingObjectUrlRevokes.set(url, timer)
}

export function cancelObjectUrlRevoke(url: string | null | undefined) {
  if (!url) return
  const pending = pendingObjectUrlRevokes.get(url)
  if (!pending) return
  clearTimeout(pending)
  pendingObjectUrlRevokes.delete(url)
}
