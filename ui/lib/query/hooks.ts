'use client'

import { useEffect, useState } from 'react'
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query/keys'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { useLlmUiStore } from '@/lib/stores/llmUiStore'
import i18n from '@/lib/i18n'
import { getHttpUrl } from '@/lib/backend'

export const useDocumentsCountQuery = () =>
  useQuery({
    queryKey: queryKeys.documents.count,
    queryFn: () => api.getDocumentsCount(),
  })

export const useCurrentDocumentQuery = (index: number, enabled = true) =>
  useQuery({
    queryKey: queryKeys.documents.current(index),
    queryFn: () => api.getDocument(index),
    enabled,
    placeholderData: keepPreviousData,
    structuralSharing: false,
    refetchOnMount: false,
  })

export const useCurrentDocumentState = () => {
  const queryClient = useQueryClient()
  const currentDocumentIndex = useEditorUiStore(
    (state) => state.currentDocumentIndex,
  )
  const documentsVersion = useEditorUiStore((state) => state.documentsVersion)
  const { data: totalPages = 0 } = useDocumentsCountQuery()
  const currentDocumentQuery = useCurrentDocumentQuery(
    currentDocumentIndex,
    totalPages > 0,
  )

  useEffect(() => {
    if (totalPages <= 0) return

    const preloadImage = (url: string) => {
      if (typeof window !== 'undefined') {
        const img = new window.Image()
        img.src = url
      }
    }

    const preloadAdjacent = (idx: number) => {
      // 1. Prefetch query document metadata
      void queryClient.prefetchQuery({
        queryKey: queryKeys.documents.current(idx),
        queryFn: () => api.getDocument(idx),
      })

      // 2. Prefetch actual high-resolution images for base, inpainted, and rendered versions
      const baseUrl = getHttpUrl(`/api/image/${idx}/base?v=${documentsVersion}`)
      preloadImage(baseUrl)

      const inpaintedUrl = getHttpUrl(
        `/api/image/${idx}/inpainted?v=${documentsVersion}`,
      )
      preloadImage(inpaintedUrl)

      const renderedUrl = getHttpUrl(
        `/api/image/${idx}/rendered?v=${documentsVersion}`,
      )
      preloadImage(renderedUrl)

      // Also prefetch thumbnail
      const thumbUrl = getHttpUrl(`/api/thumbnail/${idx}?v=${documentsVersion}`)
      preloadImage(thumbUrl)
    }

    // Prefetch next page
    if (currentDocumentIndex + 1 < totalPages) {
      preloadAdjacent(currentDocumentIndex + 1)
    }

    // Prefetch previous page
    if (currentDocumentIndex - 1 >= 0) {
      preloadAdjacent(currentDocumentIndex - 1)
    }
  }, [currentDocumentIndex, totalPages, documentsVersion, queryClient])

  return {
    currentDocumentIndex,
    totalPages,
    currentDocument: currentDocumentQuery.data ?? null,
    currentDocumentLoading: currentDocumentQuery.isPending,
    refreshCurrentDocument: currentDocumentQuery.refetch,
  }
}

export const useThumbnailQuery = (index: number, documentsVersion: number) =>
  useQuery({
    queryKey: queryKeys.documents.thumbnail(documentsVersion, index),
    queryFn: () => api.getThumbnail(index),
    structuralSharing: false,
    staleTime: 60 * 1000,
  })

export const useFontsQuery = () =>
  useQuery({
    queryKey: queryKeys.fonts,
    queryFn: () => api.listFontFamilies(),
    staleTime: 10 * 60 * 1000,
  })

export const useLlmModelsQuery = () => {
  const [language, setLanguage] = useState(i18n.language)

  useEffect(() => {
    const handleLanguageChange = (nextLanguage: string) => {
      setLanguage(nextLanguage)
    }
    i18n.on('languageChanged', handleLanguageChange)
    return () => {
      i18n.off('languageChanged', handleLanguageChange)
    }
  }, [])

  return useQuery({
    queryKey: queryKeys.llm.models(language ?? 'default'),
    queryFn: () => api.llmList(language),
    staleTime: 5 * 60 * 1000,
  })
}

export const useLlmReadyQuery = () => {
  const selectedModel = useLlmUiStore((state) => state.selectedModel)
  return useQuery({
    queryKey: queryKeys.llm.ready(selectedModel),
    queryFn: () => api.llmReady(),
    enabled: !!selectedModel,
    refetchInterval: 1500,
  })
}

export const useDeviceInfoQuery = (enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.device.info,
    queryFn: () => api.deviceInfo(),
    enabled,
    staleTime: 10 * 60 * 1000,
  })

export const useAppVersionQuery = (enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.app.version,
    queryFn: () => api.appVersion(),
    enabled,
    staleTime: 10 * 60 * 1000,
  })
