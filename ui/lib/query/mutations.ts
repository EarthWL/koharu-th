'use client'

import { useCallback } from 'react'
import { QueryClient, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { ProgressBarStatus, getCurrentWindow } from '@/lib/backend'
import { InpaintRegion, TextBlock } from '@/types'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { useLlmUiStore } from '@/lib/stores/llmUiStore'
import { useOperationStore } from '@/lib/stores/operationStore'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import { queryKeys } from '@/lib/query/keys'
import {
  ocrPageViaCloud,
  resolveOcrCloudProfile,
} from '@/lib/services/cloudOcr'
import {
  clearMaskSync,
  enqueueBrushPatch,
  enqueueMaskSync,
  enqueueTextBlockSync,
  flushMaskSync as flushMaskSyncQueue,
  flushTextBlockSync,
} from '@/lib/services/syncQueues'
import { fetchBlobBytes } from '@/lib/util'
import { applyThaiPostProcessToBlocks } from '@/lib/util/thaiPostProcess'
import i18n from '@/lib/i18n'

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

const invalidateCurrentDocument = async (
  queryClient: QueryClient,
  index: number,
) => {
  await queryClient.invalidateQueries({
    queryKey: queryKeys.documents.current(index),
  })
}

const invalidateThumbnailAtIndex = async (
  queryClient: QueryClient,
  index: number,
) => {
  await queryClient.invalidateQueries({
    queryKey: queryKeys.documents.thumbnailRoot,
    predicate: (query) => query.queryKey[3] === index,
  })
}

/**
 * After any translation flow lands on disk (Rust pipeline LLM step
 * or local llm_generate), run the Thai post-process pass over the
 * persisted text_blocks if the user has it enabled. No-op if disabled
 * or if no Thai content exists (regex skips it). Cheap — single doc
 * fetch + at most one updateTextBlocks if anything changed.
 * Issue #21.
 */
const maybeApplyThaiPostProcess = async (index: number) => {
  if (!usePreferencesStore.getState().thaiPostProcessEnabled) return
  try {
    const doc = await api.getDocument(index)
    if (!doc?.textBlocks?.length) return
    const cleaned = applyThaiPostProcessToBlocks(doc.textBlocks)
    if (cleaned !== doc.textBlocks) {
      await api.updateTextBlocks(index, cleaned)
    }
  } catch (err) {
    // Post-process is cosmetic — never block the translation flow if
    // it fails. Log once and continue.
    console.warn('[thai-postprocess] skipped:', err)
  }
}

const findModelLanguages = (
  models: { id: string; languages: string[] }[],
  modelId?: string,
) => models.find((model) => model.id === modelId)?.languages ?? []

const pickLanguage = (
  models: { id: string; languages: string[] }[],
  modelId?: string,
  preferred?: string,
) => {
  const languages = findModelLanguages(models, modelId)
  if (!languages.length) return undefined
  if (preferred && languages.includes(preferred)) return preferred
  return languages[0]
}

const getCachedLlmModels = (queryClient: QueryClient) =>
  (queryClient.getQueryData(queryKeys.llm.models(i18n.language)) ?? []) as {
    id: string
    languages: string[]
  }[]

export const useProgressActions = () => {
  const setProgress = useCallback(
    async (progress?: number, status?: ProgressBarStatus) => {
      await getCurrentWindow().setProgressBar({
        status: status ?? ProgressBarStatus.Normal,
        progress,
      })
    },
    [],
  )

  const clearProgress = useCallback(async () => {
    await getCurrentWindow().setProgressBar({
      status: ProgressBarStatus.None,
      progress: 0,
    })
  }, [])

  return {
    setProgress,
    clearProgress,
  }
}

export const useTextBlockMutations = () => {
  const queryClient = useQueryClient()

  const updateTextBlocks = useCallback(
    async (textBlocks: TextBlock[], index?: number) => {
      const resolvedIndex = index ?? useEditorUiStore.getState().currentDocumentIndex
      const queryKey = queryKeys.documents.current(resolvedIndex)
      const currentDocument = queryClient.getQueryData<any>(queryKey)
      if (!currentDocument) return
      queryClient.setQueryData(queryKey, {
        ...currentDocument,
        textBlocks,
      })
      await enqueueTextBlockSync(resolvedIndex, textBlocks)
    },
    [queryClient],
  )

  const renderTextBlock = useCallback(
    async (_?: any, index?: number, textBlockIndex?: number) => {
      const resolvedIndex =
        index ?? useEditorUiStore.getState().currentDocumentIndex
      if (typeof textBlockIndex !== 'number') return
      await flushTextBlockSync()
      const { renderEffect, renderStroke } = useEditorUiStore.getState()
      const { fontFamily } = usePreferencesStore.getState()
      await api.render(resolvedIndex, {
        textBlockIndex,
        shaderEffect: renderEffect,
        shaderStroke: renderStroke,
        fontFamily,
      })
      await invalidateCurrentDocument(queryClient, resolvedIndex)
      await invalidateThumbnailAtIndex(queryClient, resolvedIndex)
    },
    [queryClient],
  )

  return {
    updateTextBlocks,
    renderTextBlock,
  }
}

export const useMaskMutations = () => {
  const queryClient = useQueryClient()

  const updateMask = useCallback(
    async (
      mask: Uint8Array,
      options?: {
        sync?: boolean
        patch?: Uint8Array
        patchRegion?: InpaintRegion
      },
    ) => {
      const sync = options?.sync !== false
      const { currentDocumentIndex } = useEditorUiStore.getState()
      const queryKey = queryKeys.documents.current(currentDocumentIndex)
      const currentDocument = queryClient.getQueryData<any>(queryKey)
      if (!currentDocument) return

      queryClient.setQueryData(queryKey, {
        ...currentDocument,
        segment: mask,
      })

      if (sync) {
        const patchRegion =
          options?.patch && options.patchRegion
            ? options.patchRegion
            : undefined
        const payloadMask = patchRegion && options?.patch ? options.patch : mask
        enqueueMaskSync({
          index: currentDocumentIndex,
          mask: payloadMask,
          region: patchRegion,
        })
      }
    },
    [queryClient],
  )

  const flushMaskSync = useCallback(async () => {
    await flushMaskSyncQueue()
  }, [])

  const inpaintPartial = useCallback(
    async (
      region: InpaintRegion,
      options?: { index?: number; autoShowInpaintedImage?: boolean },
    ) => {
      const resolvedIndex =
        options?.index ?? useEditorUiStore.getState().currentDocumentIndex
      if (!region) return
      await flushMaskSyncQueue()
      await api.inpaintPartial(resolvedIndex, region)
      await invalidateCurrentDocument(queryClient, resolvedIndex)
      await invalidateThumbnailAtIndex(queryClient, resolvedIndex)
      if (options?.autoShowInpaintedImage !== false) {
        useEditorUiStore.getState().setShowInpaintedImage(true)
      }
    },
    [queryClient],
  )

  const paintRendered = useCallback(
    async (
      patch: Uint8Array,
      region: InpaintRegion,
      options?: { index?: number },
    ) => {
      const resolvedIndex =
        options?.index ?? useEditorUiStore.getState().currentDocumentIndex
      await enqueueBrushPatch({
        index: resolvedIndex,
        patch,
        region,
      })
      await invalidateCurrentDocument(queryClient, resolvedIndex)
      await invalidateThumbnailAtIndex(queryClient, resolvedIndex)
      useEditorUiStore.getState().setShowBrushLayer(true)
    },
    [queryClient],
  )

  return {
    updateMask,
    flushMaskSync,
    inpaintPartial,
    paintRendered,
  }
}

export const useDocumentMutations = () => {
  const queryClient = useQueryClient()
  const { setProgress, clearProgress } = useProgressActions()

  const refreshDocuments = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.documents.currentRoot,
    })
    await queryClient.invalidateQueries({
      queryKey: queryKeys.documents.thumbnailRoot,
    })
  }, [queryClient])

  const refreshCurrentDocument = useCallback(async () => {
    const { currentDocumentIndex } = useEditorUiStore.getState()
    await invalidateCurrentDocument(queryClient, currentDocumentIndex)
  }, [queryClient])

  const openDocuments = useCallback(async () => {
    const { startOperation, finishOperation } = useOperationStore.getState()
    startOperation({
      type: 'load-khr',
      cancellable: false,
    })
    try {
      const count = await api.openDocuments()
      useEditorUiStore.getState().setTotalPages(count)
      clearMaskSync()
      queryClient.setQueryData(queryKeys.documents.count, count)
      await refreshDocuments()
      if (count > 0) {
        await queryClient.prefetchQuery({
          queryKey: queryKeys.documents.current(0),
          queryFn: () => api.getDocument(0),
        })
      }
    } finally {
      finishOperation()
    }
  }, [clearMaskSync, queryClient, refreshDocuments])

  const addDocuments = useCallback(async () => {
    const { startOperation, finishOperation } = useOperationStore.getState()
    startOperation({
      type: 'load-khr',
      cancellable: false,
    })
    try {
      const editorUi = useEditorUiStore.getState()
      const previousCount = editorUi.totalPages
      const count = await api.addDocuments()
      if (count === previousCount) {
        return
      }

      clearMaskSync()
      queryClient.setQueryData(queryKeys.documents.count, count)
      await refreshDocuments()
      useEditorUiStore.setState((state) => ({
        totalPages: count,
        documentsVersion: state.documentsVersion + 1,
        currentDocumentIndex: previousCount > 0 ? previousCount : 0,
        selectedBlockIndex: undefined,
      }))

      if (count > previousCount) {
        await queryClient.prefetchQuery({
          queryKey: queryKeys.documents.current(previousCount),
          queryFn: () => api.getDocument(previousCount),
        })
      }
    } finally {
      finishOperation()
    }
  }, [queryClient, refreshDocuments])

  const saveDocuments = useCallback(async () => {
    const { startOperation, finishOperation } = useOperationStore.getState()
    startOperation({
      type: 'save-khr',
      cancellable: false,
    })
    try {
      await api.saveDocuments()
    } finally {
      finishOperation()
    }
  }, [])

  const openExternal = useCallback(async (url: string) => {
    await api.openExternal(url)
  }, [])

  const { startOperation, finishOperation } = useOperationStore.getState()

  const detect = useCallback(
    async (_?: any, index?: number) => {
      const resolvedIndex =
        index ?? useEditorUiStore.getState().currentDocumentIndex
      startOperation({
        type: 'process-current',
        step: 'detect',
        cancellable: true,
      })
      try {
        const { detectorEngine, animeYoloVariant, animeYoloConfidence } =
          usePreferencesStore.getState()
        await api.detect(resolvedIndex, {
          detectorEngine,
          animeYoloVariant,
          animeYoloConfidence,
        })
        await invalidateCurrentDocument(queryClient, resolvedIndex)
        await invalidateThumbnailAtIndex(queryClient, resolvedIndex)
        useEditorUiStore.getState().setShowRenderedImage(false)
      } finally {
        finishOperation()
      }
    },
    [queryClient, startOperation, finishOperation],
  )

  const ocr = useCallback(
    async (_?: any, index?: number) => {
      const resolvedIndex =
        index ?? useEditorUiStore.getState().currentDocumentIndex
      startOperation({
        type: 'process-current',
        step: 'ocr',
        cancellable: true,
      })
      try {
        const {
          ocrEngine,
          ocrCloudProfileId,
          cloudProvider,
          cloudModelName,
          cloudApiKey,
          detectorEngine,
          animeYoloVariant,
          animeYoloConfidence,
        } = usePreferencesStore.getState()
        if (ocrEngine === 'cloud') {
          // Standalone OCR button → also respect Cloud Vision choice.
          // Run detect first if no text_blocks yet (user expectation is
          // "OCR this page" — they shouldn't have to remember to click
          // Detect themselves), then dispatch to the cloud profile.
          const profiles = await api.providerProfilesList()
          const resolved = await resolveOcrCloudProfile(
            ocrCloudProfileId,
            profiles,
            cloudProvider,
            cloudModelName,
            cloudApiKey,
          )
          if (!resolved) {
            throw new Error(
              'Cloud Vision OCR is selected but no vision-capable profile is available. Configure one in Sidebar → Profiles or change OCR engine in Settings.',
            )
          }
          let doc = await api.getDocument(resolvedIndex)
          if (doc.textBlocks.length === 0) {
            await api.detect(resolvedIndex, {
              detectorEngine,
              animeYoloVariant,
              animeYoloConfidence,
            })
            doc = await api.getDocument(resolvedIndex)
          }
          if (doc.textBlocks.length > 0) {
            // v2 blob-transport: doc.image is now a hex BlobId.
            // Fetch the raw bytes for the cloud OCR call. Browser
            // cache short-circuits the second visit.
            const imageBytes = await fetchBlobBytes(doc.image)
            const { texts } = await ocrPageViaCloud(
              resolved.profile,
              resolved.apiKey,
              imageBytes,
              doc.textBlocks,
            )
            const updated = doc.textBlocks.map((b, i) => ({
              ...b,
              text: texts[i] ?? b.text,
            }))
            await api.updateTextBlocks(resolvedIndex, updated)
          }
        } else {
          // Local OCR — thread the engine choice through so the user's
          // Settings → OCR pick (Manga OCR vs MIT-48px) actually
          // applies. Same bug pattern as standalone Detect: without
          // this the backend silently defaults to MIT-48px and the
          // user sees garbage for Japanese vertical text even though
          // they explicitly chose Manga OCR.
          await api.ocr(resolvedIndex, { ocrEngine })
        }
        await invalidateCurrentDocument(queryClient, resolvedIndex)
        await invalidateThumbnailAtIndex(queryClient, resolvedIndex)
      } finally {
        finishOperation()
      }
    },
    [queryClient, startOperation, finishOperation],
  )

  const inpaint = useCallback(
    async (_?: any, index?: number) => {
      const resolvedIndex =
        index ?? useEditorUiStore.getState().currentDocumentIndex
      startOperation({
        type: 'process-current',
        step: 'inpaint',
        cancellable: true,
      })
      try {
        await flushTextBlockSync()
        await flushMaskSyncQueue()
        await api.inpaint(resolvedIndex)
        await invalidateCurrentDocument(queryClient, resolvedIndex)
        await invalidateThumbnailAtIndex(queryClient, resolvedIndex)
        useEditorUiStore.getState().setShowInpaintedImage(true)
      } finally {
        finishOperation()
      }
    },
    [queryClient, startOperation, finishOperation],
  )

  const render = useCallback(
    async (_?: any, index?: number) => {
      const resolvedIndex =
        index ?? useEditorUiStore.getState().currentDocumentIndex
      startOperation({
        type: 'process-current',
        step: 'render',
        cancellable: true,
      })
      try {
        const { renderEffect, renderStroke } = useEditorUiStore.getState()
        const { fontFamily } = usePreferencesStore.getState()
        await flushTextBlockSync()
        await api.render(resolvedIndex, {
          shaderEffect: renderEffect,
          shaderStroke: renderStroke,
          fontFamily,
        })
        await invalidateCurrentDocument(queryClient, resolvedIndex)
        await invalidateThumbnailAtIndex(queryClient, resolvedIndex)
        useEditorUiStore.getState().setShowRenderedImage(true)
      } finally {
        finishOperation()
      }
    },
    [queryClient, startOperation, finishOperation],
  )

  const inpaintAndRenderImage = useCallback(
    async (_?: any, index?: number) => {
      await inpaint(_, index)
      await render(_, index)
    },
    [inpaint, render],
  )

  // แปลใหม่โดยไม่ต้องรอ inpaint ซ้ำ — ใช้ผลลัพธ์ inpaint เดิม
  // เหมาะสำหรับเมื่อต้องการลอง LLM อื่นหรือเปลี่ยน prompt โดยไม่เสียเวลา
  const retranslateImage = useCallback(
    async (_?: any, index?: number) => {
      const resolvedIndex =
        index ?? useEditorUiStore.getState().currentDocumentIndex
      const { selectedModel, selectedLanguage } = useLlmUiStore.getState()
      const { renderEffect, renderStroke } = useEditorUiStore.getState()
      const { fontFamily } = usePreferencesStore.getState()
      const { startOperation, finishOperation } = useOperationStore.getState()
      startOperation({
        type: 'process-current',
        cancellable: true,
        current: 0,
        total: 2, // translate + render เท่านั้น
      })
      try {
        await api.process({
          index: resolvedIndex,
          llmModelId: selectedModel,
          language: selectedLanguage,
          shaderEffect: renderEffect,
          shaderStroke: renderStroke,
          fontFamily,
          skipDetect: true,
          skipOcr: true,
          skipInpaint: true,
        })
      } catch (error) {
        console.error('Failed to retranslate:', error)
        finishOperation()
        await clearProgress()
      }
    },
    [startOperation, finishOperation],
  )

  const processImage = useCallback(
    async (_?: any, index?: number) => {
      const resolvedIndex =
        index ?? useEditorUiStore.getState().currentDocumentIndex
      const { selectedModel, selectedLanguage } = useLlmUiStore.getState()
      const { renderEffect, renderStroke } = useEditorUiStore.getState()
      const {
        fontFamily,
        ocrEngine,
        ocrCloudProfileId,
        cloudProvider,
        cloudModelName,
        cloudApiKey,
        detectorEngine,
        animeYoloVariant,
        animeYoloConfidence,
      } = usePreferencesStore.getState()
      const { startOperation, finishOperation } = useOperationStore.getState()
      startOperation({
        type: 'process-current',
        cancellable: true,
        current: 0,
        total: 5,
      })
      try {
        if (ocrEngine === 'cloud') {
          // Cloud Vision OCR: detect first ourselves, OCR via cloud,
          // then ask the Rust pipeline to skip both steps and just
          // run inpaint + translate + render on the populated blocks.
          const profiles = await api.providerProfilesList()
          const resolved = await resolveOcrCloudProfile(
            ocrCloudProfileId,
            profiles,
            cloudProvider,
            cloudModelName,
            cloudApiKey,
          )
          if (!resolved) {
            throw new Error(
              'Cloud Vision OCR is selected but no vision-capable profile is available. Configure one in Sidebar → Profiles or change OCR engine in Settings.',
            )
          }
          await api.detect(resolvedIndex, {
            detectorEngine,
            animeYoloVariant,
            animeYoloConfidence,
          })
          const doc = await api.getDocument(resolvedIndex)
          if (doc.textBlocks.length > 0) {
            // v2 blob-transport: doc.image is now a hex BlobId.
            // Fetch the raw bytes for the cloud OCR call. Browser
            // cache short-circuits the second visit.
            const imageBytes = await fetchBlobBytes(doc.image)
            const { texts } = await ocrPageViaCloud(
              resolved.profile,
              resolved.apiKey,
              imageBytes,
              doc.textBlocks,
            )
            const updated = doc.textBlocks.map((b, i) => ({
              ...b,
              text: texts[i] ?? b.text,
            }))
            await api.updateTextBlocks(resolvedIndex, updated)
          }
          await api.process({
            index: resolvedIndex,
            llmModelId: selectedModel,
            language: selectedLanguage,
            shaderEffect: renderEffect,
            shaderStroke: renderStroke,
            fontFamily,
            skipDetect: true,
            skipOcr: true,
          })
        } else {
          await api.process({
            index: resolvedIndex,
            llmModelId: selectedModel,
            language: selectedLanguage,
            shaderEffect: renderEffect,
            shaderStroke: renderStroke,
            fontFamily,
            ocrEngine,
            detectorEngine,
            animeYoloVariant,
            animeYoloConfidence,
          })
        }
      } catch (error) {
        console.error('Failed to start processing:', error)
        finishOperation()
        await clearProgress()
      }
    },
    [clearProgress],
  )

  const processAllImages = useCallback(async () => {
    const { selectedModel, selectedLanguage } = useLlmUiStore.getState()
    const { renderEffect, renderStroke, totalPages } =
      useEditorUiStore.getState()
    const { fontFamily, ocrEngine } = usePreferencesStore.getState()
    const { startOperation, finishOperation } = useOperationStore.getState()
    if (!totalPages) return
    // Cloud Vision OCR runs page-by-page from the frontend (no Rust
    // worker support yet — see roadmap Tier B #3) which would burn
    // tokens fast across many pages. Fall back to MIT-48px for batch
    // and let the user know once.
    const effectiveEngine: 'mit48px' | 'manga' =
      ocrEngine === 'cloud' ? 'mit48px' : ocrEngine
    if (ocrEngine === 'cloud') {
      console.info(
        '[processAll] Cloud Vision OCR is not used for batch — falling back to MIT-48px. Use Process current for individual pages with Cloud Vision.',
      )
    }
    startOperation({
      type: 'process-all',
      cancellable: true,
      current: 0,
      total: totalPages,
    })
    try {
      const { detectorEngine, animeYoloVariant, animeYoloConfidence } =
        usePreferencesStore.getState()
      await api.process({
        llmModelId: selectedModel,
        language: selectedLanguage,
        shaderEffect: renderEffect,
        shaderStroke: renderStroke,
        fontFamily,
        ocrEngine: effectiveEngine,
        detectorEngine,
        animeYoloVariant,
        animeYoloConfidence,
      })
    } catch (error) {
      console.error('Failed to start processing:', error)
      finishOperation()
      await clearProgress()
    }
  }, [clearProgress])

  const exportDocument = useCallback(async () => {
    const { currentDocumentIndex } = useEditorUiStore.getState()
    await api.exportDocument(currentDocumentIndex)
  }, [])

  const exportAllInpainted = useCallback(async () => {
    await api.exportAllInpainted()
  }, [])

  const exportAllRendered = useCallback(async () => {
    await api.exportAllRendered()
  }, [])

  const cancelOperation = useCallback(async () => {
    useOperationStore.getState().cancelOperation()
    await api.processCancel().catch(() => {})
  }, [])

  return {
    refreshCurrentDocument,
    addDocuments,
    openDocuments,
    saveDocuments,
    openExternal,
    detect,
    ocr,
    inpaint,
    render,
    processImage,
    processAllImages,
    inpaintAndRenderImage,
    retranslateImage,

    exportDocument,
    exportAllInpainted,
    exportAllRendered,
    cancelOperation,
    setProgress,
    clearProgress,
  }
}

export const useLlmMutations = () => {
  const queryClient = useQueryClient()
  const { setProgress, clearProgress } = useProgressActions()
  const { renderTextBlock, updateTextBlocks } = useTextBlockMutations()

  const llmSetSelectedModel = useCallback(
    async (id: string) => {
      await api.llmOffload()
      const models = getCachedLlmModels(queryClient)
      const nextLanguage = pickLanguage(
        models,
        id,
        useLlmUiStore.getState().selectedLanguage,
      )
      useLlmUiStore.setState({
        selectedModel: id,
        selectedLanguage: nextLanguage,
        loading: false,
      })
      queryClient.setQueryData(queryKeys.llm.ready(id), false)
    },
    [queryClient],
  )

  const llmSetSelectedLanguage = useCallback(
    (language: string) => {
      const selectedModel = useLlmUiStore.getState().selectedModel
      const models = getCachedLlmModels(queryClient)
      const languages = findModelLanguages(models, selectedModel)
      if (!languages.includes(language)) return
      useLlmUiStore.setState({ selectedLanguage: language })
    },
    [queryClient],
  )

  const llmToggleLoadUnload = useCallback(async () => {
    const { selectedModel } = useLlmUiStore.getState()
    if (!selectedModel) return

    const readyKey = queryKeys.llm.ready(selectedModel)
    const ready = queryClient.getQueryData<boolean>(readyKey) === true

    if (ready) {
      await api.llmOffload()
      useLlmUiStore.getState().setLoading(false)
      queryClient.setQueryData(readyKey, false)
      return
    }

    const { startOperation, finishOperation } = useOperationStore.getState()
    startOperation({
      type: 'llm-load',
      cancellable: false,
    })

    let loaded = false
    useLlmUiStore.getState().setLoading(true)
    try {
      await api.llmLoad(selectedModel)
      await setProgress(100, ProgressBarStatus.Paused)

      let attempts = 0
      while (attempts++ < 300) {
        const readyNow = await queryClient.fetchQuery({
          queryKey: readyKey,
          queryFn: () => api.llmReady(),
        })
        if (readyNow) {
          loaded = true
          break
        }
        await sleep(100)
      }
    } finally {
      useLlmUiStore.getState().setLoading(false)
      if (!loaded) {
        queryClient.setQueryData(readyKey, false)
      }
      await clearProgress()
      finishOperation()
    }
  }, [clearProgress, queryClient, setProgress])

  const llmGenerate = useCallback(
    async (_?: any, index?: number, textBlockIndex?: number) => {
      const resolvedIndex =
        index ?? useEditorUiStore.getState().currentDocumentIndex
      
      const { cloudProvider, cloudTargetLanguage } = usePreferencesStore.getState()
      const selectedLanguage = useLlmUiStore.getState().selectedLanguage

      if (cloudProvider !== 'none') {
        const queryKey = queryKeys.documents.current(resolvedIndex)
        const currentDocument = queryClient.getQueryData<any>(queryKey)
        const { generateCloudTranslation } = await import('@/lib/services/cloudLlm')
        const language = cloudTargetLanguage || 'Thai'

        if (typeof textBlockIndex === 'number') {
          // Single block translation
          const block = currentDocument?.textBlocks?.[textBlockIndex]
          if (block?.text) {
            try {
              const translation = await generateCloudTranslation(block.text, language)
              const nextBlocks = currentDocument.textBlocks.map((b: any, i: number) =>
                 i === textBlockIndex ? { ...b, translation } : b
              )
              // Issue #21 — Thai post-process before save (no extra
              // round-trip vs the local-LLM path; we have the blocks
              // in-memory already).
              const processed = usePreferencesStore.getState().thaiPostProcessEnabled
                ? applyThaiPostProcessToBlocks(nextBlocks)
                : nextBlocks
              // Pass the resolved page index explicitly so a mid-flight
              // page switch can't redirect the save to the wrong doc.
              // Completes HetCreep's 002d6252 fix — the threading was
              // added on the signature side but two call sites in this
              // path still omitted the argument and silently fell back
              // to the store's currentDocumentIndex.
              await updateTextBlocks(processed, resolvedIndex)
            } catch (e: any) {
              console.error('Cloud LLM Generation failed:', e)
              alert(e.message || 'Translation failed')
            }
          }
        } else if (currentDocument?.textBlocks) {
          // Batch translation utilizing structured JSON
          try {
            const nextBlocks = [...currentDocument.textBlocks]
            
            // Collect only the blocks that need translation
            const blocksToTranslate = nextBlocks
              .map((b, i) => ({ index: i, text: b.text || '' }))
              .filter(b => b.text && !nextBlocks[b.index].translation)

            if (blocksToTranslate.length > 0) {
              const { generateCloudBatchTranslation } = await import('@/lib/services/cloudLlm')
              const translatedResult = await generateCloudBatchTranslation(blocksToTranslate, language)

              // Map the returned JSON translations back to the blocks array
              for (const result of translatedResult) {
                if (result && typeof result.index === 'number' && typeof result.translation === 'string') {
                  const b = nextBlocks[result.index]
                  if (b) {
                     nextBlocks[result.index] = { ...b, translation: result.translation }
                  }
                }
              }

              // Issue #21 — Thai post-process before save.
              const processed = usePreferencesStore.getState().thaiPostProcessEnabled
                ? applyThaiPostProcessToBlocks(nextBlocks)
                : nextBlocks
              // Pin to resolvedIndex (see comment on the single-block
              // path above — same race fix completion).
              await updateTextBlocks(processed, resolvedIndex)
              // Auto-render the full page after batch translate so the new
              // translations paint immediately. Without this, blocks sit
              // in the data model but the canvas doesn't repaint until
              // the user clicks Render or twiddles a font setting.
              try {
                const { renderEffect, renderStroke } =
                  useEditorUiStore.getState()
                const { fontFamily } = usePreferencesStore.getState()
                await api.render(resolvedIndex, {
                  shaderEffect: renderEffect,
                  shaderStroke: renderStroke,
                  fontFamily,
                })
                await invalidateCurrentDocument(queryClient, resolvedIndex)
                await invalidateThumbnailAtIndex(queryClient, resolvedIndex)
                useEditorUiStore.getState().setShowRenderedImage(true)
              } catch (renderErr) {
                console.warn(
                  '[llmGenerate] auto-render after batch translate failed',
                  renderErr,
                )
              }
            }
          } catch (e: any) {
            console.error('Cloud LLM Batch JSON Generation failed:', e)
            alert(e.message || 'Batch JSON translation failed. The AI or API might have failed to return a proper JSON structure.')
          }
        }
      } else {
        const selectedModel = useLlmUiStore.getState().selectedModel
        const models = getCachedLlmModels(queryClient)

        const languages = findModelLanguages(models, selectedModel)
        const language =
          languages.length > 0
            ? selectedLanguage && languages.includes(selectedLanguage)
              ? selectedLanguage
              : languages[0]
            : undefined

        await api.llmGenerate(resolvedIndex, textBlockIndex, language)
        // Issue #21 — local LLM writes translations directly via Rust
        // pipeline, so we post-process server-side state via the helper
        // (fetch + apply + save back if changed).
        await maybeApplyThaiPostProcess(resolvedIndex)
        await invalidateCurrentDocument(queryClient, resolvedIndex)
      }

      useEditorUiStore.getState().setShowTextBlocksOverlay(true)
      if (typeof textBlockIndex === 'number') {
        await renderTextBlock(undefined, resolvedIndex, textBlockIndex)
      }
    },
    [queryClient, renderTextBlock, updateTextBlocks],
  )

  const llmList = useCallback(async () => {
    const models = await api.llmList(i18n.language)
    queryClient.setQueryData(queryKeys.llm.models(i18n.language), models)
    const currentModel = useLlmUiStore.getState().selectedModel
    const currentLanguage = useLlmUiStore.getState().selectedLanguage
    const hasCurrent = models.some((model) => model.id === currentModel)
    const nextModel = hasCurrent
      ? (currentModel ?? models[0]?.id)
      : models[0]?.id
    const nextLanguage = pickLanguage(
      models,
      nextModel,
      hasCurrent ? currentLanguage : undefined,
    )
    useLlmUiStore.setState({
      selectedModel: nextModel,
      selectedLanguage: nextLanguage,
    })
  }, [queryClient])

  return {
    llmList,
    llmSetSelectedModel,
    llmSetSelectedLanguage,
    llmToggleLoadUnload,
    llmGenerate,
  }
}
