'use client'

import { WsRpcClient } from './ws'
import { fileOpen, fileSave } from 'browser-fs-access'
import { toArrayBuffer } from './util'
import { reportRpcError } from './errors'
import type { RpcMethodMap, RpcNotificationMap, FileResult } from './rpc-types'

// --- Singleton client ---

let client: WsRpcClient | null = null

function getClient(): WsRpcClient {
  if (client) return client

  let url: string
  const isDev = process.env.NODE_ENV === 'development'

  if (isDev) {
    const proto =
      typeof location !== 'undefined' && location.protocol === 'https:'
        ? 'wss:'
        : 'ws:'
    url = `${proto}//127.0.0.1:9999/ws`
  } else if (
    typeof window !== 'undefined' &&
    (window as any).__KOHARU_WS_PORT__
  ) {
    const port = (window as any).__KOHARU_WS_PORT__ as number
    url = `ws://127.0.0.1:${port}/ws`
  } else {
    // Browser / headless mode: derive from current location
    const proto =
      typeof location !== 'undefined' && location.protocol === 'https:'
        ? 'wss:'
        : 'ws:'
    const host = typeof location !== 'undefined' ? location.host : '127.0.0.1'
    url = `${proto}//${host}/ws`
  }

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

// These commands are registered with `tauri::generate_handler!` in
// koharu/src/app.rs and are NOT exposed by the WebSocket RPC layer.
// They have to be invoked through Tauri's native IPC (window.__TAURI_INTERNALS__)
// or they come back with a generic `ERR_SYSTEM_UNKNOWN` from the WS dispatcher
// because the method name simply doesn't exist there.
const TAURI_ONLY_METHODS: ReadonlySet<keyof RpcMethodMap> = new Set([
  'get_ml_device_config',
  'set_ml_device_config',
  'enumerate_cuda_devices',
  'relaunch_app',
] as const)

export async function invoke<M extends keyof RpcMethodMap>(
  method: M,
  ...args: RpcMethodMap[M][0] extends void ? [] : [RpcMethodMap[M][0]]
): Promise<RpcMethodMap[M][1]> {
  const params = args[0]

  // Route Tauri-native commands through the native IPC, not WS RPC.
  if (TAURI_ONLY_METHODS.has(method)) {
    if (!isTauriEnv()) {
      throw new Error(`${method} is only available in the Tauri runtime`)
    }
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
    return (await tauriInvoke(
      method as string,
      (params ?? {}) as Record<string, unknown>,
    )) as RpcMethodMap[M][1]
  }

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
  // Use zero-copy native file dialog on the Rust backend side.
  // This bypasses browser-fs-access and transferring large binary buffers over WebSocket.
  try {
    return await getClient().invoke<number>(method, { files: [] })
  } catch (error) {
    reportRpcError(method, error)
    return 0
  }
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

export function subscribeCollabSync(
  cb: (p: RpcNotificationMap['collab_sync']) => void,
): () => void {
  return getClient().onNotification<RpcNotificationMap['collab_sync']>(
    'collab_sync',
    cb,
  )
}

export async function publishCollab(
  event: RpcNotificationMap['collab_sync'],
): Promise<boolean> {
  return getClient().invoke<boolean>('collab_publish', event)
}

export function getHttpUrl(path: string): string {
  const isDev = process.env.NODE_ENV === 'development'
  if (isDev) {
    return `http://127.0.0.1:9999${path}`
  } else if (
    typeof window !== 'undefined' &&
    (window as any).__KOHARU_WS_PORT__
  ) {
    const port = (window as any).__KOHARU_WS_PORT__ as number
    return `http://127.0.0.1:${port}${path}`
  } else {
    const proto =
      typeof location !== 'undefined' && location.protocol === 'https:'
        ? 'https:'
        : 'http:'
    const host = typeof location !== 'undefined' ? location.host : '127.0.0.1'
    return `${proto}//${host}${path}`
  }
}
