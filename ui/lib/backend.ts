'use client'

import { WsRpcClient } from './ws'
import { fileOpen, fileSave } from 'browser-fs-access'
import { toArrayBuffer } from './util'
import { reportRpcError } from './errors'
import type { RpcMethodMap, RpcNotificationMap, FileResult } from './rpc-types'

// --- Backend host resolver ---
//
// Both the WebSocket-RPC channel and the HTTP `/blob/:hex` route are
// served by the same Axum router. The exact host depends on where
// we're running:
//   - `next dev`:  Next is on :3000, Axum is on 127.0.0.1:9999
//                  (cross-origin → CORS on /blob).
//   - Tauri prod:  Both Next assets + /blob are served by Axum on
//                  127.0.0.1:{__KOHARU_WS_PORT__} (same-origin).
//   - Browser:     Single origin via location.host (same-origin).
//
// Centralising the resolver here so `blobUrl()` and the WS URL stay
// in lockstep — without this, a relative `/blob/{hex}` URL from an
// `<img>` or `fetch()` would hit the Next dev origin (which doesn't
// know about /blob) and 404.

type BackendHostInfo = { protocol: 'http:' | 'https:'; host: string }

function getBackendHostInfo(): BackendHostInfo {
  const isDev = process.env.NODE_ENV === 'development'
  const pageProtocol =
    typeof location !== 'undefined' && location.protocol === 'https:'
      ? ('https:' as const)
      : ('http:' as const)

  if (isDev) {
    return { protocol: pageProtocol, host: '127.0.0.1:9999' }
  }
  if (
    typeof window !== 'undefined' &&
    (window as any).__KOHARU_WS_PORT__
  ) {
    const port = (window as any).__KOHARU_WS_PORT__ as number
    return { protocol: 'http:', host: `127.0.0.1:${port}` }
  }
  const host = typeof location !== 'undefined' ? location.host : '127.0.0.1'
  return { protocol: pageProtocol, host }
}

function getHttpBase(): string {
  const { protocol, host } = getBackendHostInfo()
  return `${protocol}//${host}`
}

function getWsBase(): string {
  const { protocol, host } = getBackendHostInfo()
  const wsProto = protocol === 'https:' ? 'wss:' : 'ws:'
  return `${wsProto}//${host}`
}

/**
 * Build the URL for a content-addressed blob served by the backend's
 * `/blob/:hex` route. Always absolute (origin-qualified) so that a
 * dev-mode Next page at :3000 still hits the Axum server at :9999
 * instead of asking Next for a route it doesn't have. In Tauri prod
 * the same call collapses to same-origin since Axum serves both
 * frontend assets and `/blob`.
 *
 * Pass through `<img src={blobUrl(hex)}>` for native + GPU-decoded
 * image loading (no CORS needed for `<img>`), or `fetch(blobUrl(hex))`
 * for raw bytes (CORS needed cross-origin — handled by Axum sending
 * `Access-Control-Allow-Origin: *` on this route).
 */
export function blobUrl(hex: string): string {
  return `${getHttpBase()}/blob/${hex}`
}

// --- Singleton client ---

let client: WsRpcClient | null = null

function getClient(): WsRpcClient {
  if (client) return client

  const url = `${getWsBase()}/ws`
  client = new WsRpcClient(url)
  client.connect()
  return client
}

// --- Environment helpers ---

const isTauriEnv = (): boolean =>
  typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__

export const isTauri = isTauriEnv

export const isMacOS = (): boolean => {
  if (typeof window === 'undefined') return false
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
}

// --- Progress bar ---

export enum ProgressBarStatus {
  None = 'none',
  Normal = 'normal',
  Indeterminate = 'indeterminate',
  Paused = 'paused',
  Error = 'error',
}

type ProgressTarget = {
  setProgressBar: (options: {
    status?: ProgressBarStatus
    progress?: number
  }) => Promise<void>
}

export function getCurrentWindow(): ProgressTarget {
  if (isTauriEnv()) {
    return {
      async setProgressBar(options) {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        return getCurrentWindow().setProgressBar(options)
      },
    }
  }

  return {
    async setProgressBar() {
      return
    },
  }
}

// --- Window resize listener ---

export async function listen<T>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<() => void> {
  if (isTauriEnv()) {
    const { listen } = await import('@tauri-apps/api/event')
    return listen<T>(event, handler)
  }

  if (typeof window !== 'undefined' && event === 'tauri://resize') {
    const listener = () => handler({ payload: undefined as T })
    window.addEventListener('resize', listener)
    return async () => window.removeEventListener('resize', listener)
  }

  return async () => {}
}

// --- Window controls ---

export const windowControls = {
  async minimize() {
    if (isTauriEnv()) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      return getCurrentWindow().minimize()
    }
  },
  async toggleMaximize() {
    if (isTauriEnv()) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      return getCurrentWindow().toggleMaximize()
    }
  },
  async close() {
    if (isTauriEnv()) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      return getCurrentWindow().close()
    }
  },
  async isMaximized(): Promise<boolean> {
    if (isTauriEnv()) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      return getCurrentWindow().isMaximized()
    }
    return false
  },
}

// --- Typed RPC invoke ---

export async function invoke<M extends keyof RpcMethodMap>(
  method: M,
  ...args: RpcMethodMap[M][0] extends void ? [] : [RpcMethodMap[M][0]]
): Promise<RpcMethodMap[M][1]> {
  const params = args[0]

  // Browser-only: open_external in a new tab
  if (!isTauriEnv() && method === 'open_external') {
    const p = params as { url: string }
    if (p?.url) {
      window.open(p.url, '_blank', 'noopener,noreferrer')
    }
    return undefined as RpcMethodMap[M][1]
  }

  // Special file-pick flow for open_documents / add_documents
  if (method === 'open_documents' || method === 'add_documents') {
    return (await openDocumentsRpc(method)) as RpcMethodMap[M][1]
  }

  // Special file-save flow for save_documents / export_document
  if (method === 'save_documents' || method === 'export_document') {
    try {
      const result = await getClient().invoke<FileResult>(method, params)
      const blob = new Blob([toArrayBuffer(result.data)])
      try {
        await fileSave(blob, { fileName: result.filename })
      } catch (saveErr: any) {
        // `browser-fs-access` throws AbortError when the user
        // dismisses the system save dialog — that's not a failure,
        // just "no, thanks". Swallow it silently as before.
        //
        // Anything else (disk full, permission denied, parent dir
        // gone, quota exceeded, file in use, …) is a real failure —
        // surfacing it gives the user an actionable error instead of
        // a misleading "saved" confirmation when nothing reached disk.
        if (saveErr?.name !== 'AbortError') {
          reportRpcError(method, saveErr)
          throw saveErr
        }
      }
      return undefined as RpcMethodMap[M][1]
    } catch (error) {
      reportRpcError(method, error)
      throw error
    }
  }

  try {
    return await getClient().invoke<RpcMethodMap[M][1]>(method, params)
  } catch (error) {
    reportRpcError(method, error)
    throw error
  }
}

async function openDocumentsRpc(
  method: 'open_documents' | 'add_documents',
): Promise<number> {
  let files: File[]
  try {
    files = await fileOpen({
      description: 'Documents',
      mimeTypes: ['image/*'],
      extensions: ['.png', '.jpg', '.jpeg', '.webp'],
      multiple: true,
    })
  } catch {
    return 0
  }
  if (!files.length) return 0

  const entries = await Promise.all(
    files.map(async (file: File) => ({
      name: file.name,
      data: new Uint8Array(await file.arrayBuffer()),
    })),
  )

  return getClient().invoke<number>(method, { files: entries })
}

// --- Thumbnail fetch ---

export async function fetchThumbnail(index: number): Promise<Blob> {
  const result = await getClient().invoke<{
    data: Uint8Array
    contentType: string
  }>('get_thumbnail', { index })
  return new Blob([toArrayBuffer(result.data)], {
    type: result.contentType,
  })
}

// --- Notification subscriptions ---

export type { DownloadProgress, ProcessProgress } from './rpc-types'

export function subscribeDownloadProgress(
  cb: (p: RpcNotificationMap['download_progress']) => void,
): () => void {
  return getClient().onNotification<RpcNotificationMap['download_progress']>(
    'download_progress',
    cb,
  )
}

export function subscribeProcessProgress(
  cb: (p: RpcNotificationMap['process_progress']) => void,
): () => void {
  return getClient().onNotification<RpcNotificationMap['process_progress']>(
    'process_progress',
    cb,
  )
}
