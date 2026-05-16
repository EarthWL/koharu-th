'use client'

import { QueryClient } from '@tanstack/react-query'
import { persistQueryClient } from '@tanstack/react-query-persist-client'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'

const PERSIST_KEY = 'koharu-rq-v1'
const PERSIST_MAX_AGE = 24 * 60 * 60 * 1000

let client: QueryClient | null = null
let persistenceSetup = false

const shouldPersistQueryKey = (queryKey: readonly unknown[]) => {
  const root = queryKey[0]
  const second = queryKey[1]
  if (root === 'fonts') return true
  if (root === 'llm' && second === 'models') return true
  return false
}

/**
 * The backend rejects every RPC with "Resources not initialized" until
 * the Tauri setup hook finishes loading the ML pipeline (a few seconds
 * on first launch, longer with CUDA dylib download). Queries that fire
 * during that window — `llm_list`, `device`, etc. — would normally hit
 * react-query's `retry: 1` default and then permanently fail. We
 * detect this specific case and back off with short polling so they
 * eventually succeed without manual refresh.
 */
const isBackendBooting = (err: unknown) => {
  const msg = (err instanceof Error ? err.message : String(err)) ?? ''
  return msg.includes('Resources not initialized')
}

const createClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: 5 * 60 * 1000,
        retry: (failureCount, error) => {
          if (isBackendBooting(error)) return failureCount < 60
          return failureCount < 1
        },
        retryDelay: (failureCount, error) => {
          if (isBackendBooting(error)) return Math.min(2_000, 250 * (failureCount + 1))
          return Math.min(30_000, 1_000 * 2 ** failureCount)
        },
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: (failureCount, error) =>
          isBackendBooting(error) && failureCount < 60,
        retryDelay: (failureCount) => Math.min(2_000, 250 * (failureCount + 1)),
      },
    },
  })

const setupPersistence = (queryClient: QueryClient) => {
  if (persistenceSetup || typeof window === 'undefined') return
  persistenceSetup = true

  const persister = createSyncStoragePersister({
    key: PERSIST_KEY,
    storage: window.localStorage,
  })

  persistQueryClient({
    queryClient,
    persister,
    maxAge: PERSIST_MAX_AGE,
    dehydrateOptions: {
      shouldDehydrateQuery: (query) => shouldPersistQueryKey(query.queryKey),
    },
  })
}

export const getQueryClient = () => {
  if (!client) {
    client = createClient()
    setupPersistence(client)
  }
  return client
}
