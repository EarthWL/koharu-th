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
import { applySmartPostProcessToBlocks } from '@/lib/util/postProcess'
import i18n from '@/lib/i18n'
import { toast } from 'sonner'
import {
  applySmartPostProcess,
  detectDominantLanguage,
} from '@/lib/smartPostProcess'

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
 * or local llm_generate), run the smart post-process pass over the
 * persisted text_blocks if the user has it enabled. No-op if disabled
 * or if no content needs it (regex skips it). Cheap — single doc
 * fetch + at most one updateTextBlocks if anything changed.
 * Issue #21.
 */
const maybeApplySmartPostProcess = async (index: number) => {
  if (!usePreferencesStore.getState().smartPostProcessEnabled) return
  try {
    const doc = await api.getDocument(index)
    if (!doc?.textBlocks?.length) return
    const cleaned = applySmartPostProcessToBlocks(doc.textBlocks)
    if (cleaned !== doc.textBlocks) {
      await api.updateTextBlocks(index, cleaned)
    }
  } catch (err) {
    // Post-process is cosmetic — never block the translation flow if
    // it fails. Log once and continue.
    console.warn('[smart-postprocess] skipped:', err)
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
      const resolvedIndex =
        index ?? useEditorUiStore.getState().currentDocumentIndex
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
  const { updateTextBlocks } = useTextBlockMutations()

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
        // Force-fetch the document directly instead of invalidating.
        // invalidateQueries only triggers a background refetch when there
        // is an active React Query observer — if the user clicks Detect
        // immediately after opening an image, openDocuments' prefetchQuery
        // may still be in-flight or have just completed with pre-detect
        // data, leaving no active observer at the time of invalidation.
        // fetchQuery bypasses the observer/enabled check and always waits
        // for fresh data, so text blocks are guaranteed to be in the cache
        // before setShowTextBlocksOverlay(true) is called.
        await queryClient.fetchQuery({
          queryKey: queryKeys.documents.current(resolvedIndex),
          queryFn: () => api.getDocument(resolvedIndex),
        })
        await invalidateThumbnailAtIndex(queryClient, resolvedIndex)
        useEditorUiStore.getState().setShowRenderedImage(false)
        useEditorUiStore.getState().setShowTextBlocksOverlay(true)
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
          ocrSmartCloudFallback,
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
            const { texts } = await ocrPageViaCloud(
              resolved.profile,
              resolved.apiKey,
              doc.image,
              doc.textBlocks,
            )
            const updated = doc.textBlocks.map((b, i) => ({
              ...b,
              text: texts[i] ?? b.text,
            }))
            await api.updateTextBlocks(resolvedIndex, updated)
          }
        } else {
          // Local OCR or Auto OCR
          let finalEngine = ocrEngine
          if (ocrEngine === 'auto') {
            const series = queryClient.getQueryData<{
              sourceLanguage?: string
            }>(['project', 'series-meta'])
            const sourceLang = series?.sourceLanguage ?? ''
            const isJapanese =
              sourceLang.toLowerCase().includes('ja') ||
              sourceLang.toLowerCase().includes('jp') ||
              sourceLang.toLowerCase().includes('日本語')
            finalEngine = isJapanese ? 'manga' : 'cloud'
          }

          // Trigger OCR using the final chosen local engine
          await api.ocr(resolvedIndex, { ocrEngine: finalEngine })

          // Post-local OCR: Smart Cloud Fallback logic!
          if (ocrEngine === 'auto' && ocrSmartCloudFallback) {
            let doc = await api.getDocument(resolvedIndex)
            if (doc.textBlocks.length > 0) {
              const fallbackIndices = doc.textBlocks
                .map((b, idx) => ({ block: b, idx }))
                .filter(({ block }) => {
                  const text = block.text ?? ''
                  return text.trim() === ''
                })
                .map(({ idx }) => idx)

              if (fallbackIndices.length > 0) {
                const profiles = await api.providerProfilesList()
                const resolved = await resolveOcrCloudProfile(
                  ocrCloudProfileId,
                  profiles,
                  cloudProvider,
                  cloudModelName,
                  cloudApiKey,
                )
                if (resolved) {
                  const subsetBlocks = fallbackIndices.map(
                    (idx) => doc.textBlocks[idx],
                  )
                  const { texts } = await ocrPageViaCloud(
                    resolved.profile,
                    resolved.apiKey,
                    doc.image,
                    subsetBlocks,
                  )
                  const updatedBlocks = [...doc.textBlocks]
                  for (let i = 0; i < fallbackIndices.length; i++) {
                    const origIdx = fallbackIndices[i]
                    const cloudText = texts[i]
                    if (cloudText && cloudText.trim() !== '') {
                      updatedBlocks[origIdx].text = cloudText
                    }
                  }
                  await api.updateTextBlocks(resolvedIndex, updatedBlocks)
                }
              }
            }
          }
        }
        await invalidateCurrentDocument(queryClient, resolvedIndex)
        await invalidateThumbnailAtIndex(queryClient, resolvedIndex)
        useEditorUiStore.getState().setShowTextBlocksOverlay(true)
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
        const { inpaintEngine, inpaintMaxSide } = usePreferencesStore.getState()
        await api.inpaint(resolvedIndex, { inpaintEngine, inpaintMaxSide })
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
        inpaintMaxSide,
        inpaintEngine,
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
            const { texts } = await ocrPageViaCloud(
              resolved.profile,
              resolved.apiKey,
              doc.image,
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
            inpaintMaxSide,
            inpaintEngine,
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
            inpaintMaxSide,
            inpaintEngine,
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
    const effectiveEngine: 'mit48px' | 'manga' | 'auto' =
      ocrEngine === 'cloud' ? 'mit48px' : ocrEngine
    // Cloud Vision OCR is not supported in batch mode; falls back to MIT-48px.
    // Use "Process current page" for Cloud Vision on individual pages.
    startOperation({
      type: 'process-all',
      cancellable: true,
      current: 0,
      total: totalPages,
    })
    try {
      const {
        detectorEngine,
        animeYoloVariant,
        animeYoloConfidence,
        inpaintEngine,
        inpaintMaxSide,
      } = usePreferencesStore.getState()
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
        inpaintEngine,
        inpaintMaxSide,
      })
    } catch (error) {
      console.error('Failed to start processing:', error)
      finishOperation()
      await clearProgress()
    }
  }, [clearProgress])

  // Re-translate โดยไม่รอ inpaint ซ้ำ — ใช้ผลลัพธ์ inpaint เดิม
  const retranslateImage = useCallback(
    async (_?: any, index?: number) => {
      const resolvedIndex =
        index ?? useEditorUiStore.getState().currentDocumentIndex
      const { selectedModel, selectedLanguage } = useLlmUiStore.getState()
      const { renderEffect, renderStroke } = useEditorUiStore.getState()
      const {
        cloudProvider,
        cloudTargetLanguage,
        fontFamily,
        inpaintMaxSide,
        smartPostProcess,
      } = usePreferencesStore.getState()
      const { startOperation, finishOperation } = useOperationStore.getState()
      startOperation({
        type: 'process-current',
        cancellable: true,
        current: 0,
        total: 2,
      })
      try {
        if (cloudProvider !== 'none') {
          // Cloud path: skip Rust LLM step entirely — Rust pipeline has no
          // knowledge of cloud providers. Instead: re-translate all blocks
          // that have OCR text (force — no existing-translation filter) then
          // render via the normal Rust render step.
          const queryKey = queryKeys.documents.current(resolvedIndex)
          const cached = queryClient.getQueryData<any>(queryKey)
          const doc = cached ?? (await api.getDocument(resolvedIndex))
          const blocks: any[] = doc?.textBlocks ?? []

          const blocksToTranslate = blocks
            .map((b: any, i: number) => ({ index: i, text: b.text ?? '' }))
            .filter((b) => b.text) // force: no !translation filter

          if (blocksToTranslate.length > 0) {
            const { generateCloudBatchTranslation } =
              await import('@/lib/services/cloudLlm')
            const language = cloudTargetLanguage || 'Thai'
            const context = await getTranslationContext(
              queryClient,
              resolvedIndex,
            )
            const translatedResult = await generateCloudBatchTranslation(
              blocksToTranslate,
              language,
              context,
            )
            const nextBlocks = [...blocks]
            for (const result of translatedResult) {
              if (
                result &&
                typeof result.index === 'number' &&
                typeof result.translation === 'string'
              ) {
                const b = nextBlocks[result.index]
                if (b) {
                  nextBlocks[result.index] = {
                    ...b,
                    translation: result.translation,
                  }
                }
              }
            }
            const processed = smartPostProcess
              ? applySmartPostProcessToBlocks(nextBlocks)
              : nextBlocks
            await updateTextBlocks(processed, resolvedIndex)
          }

          // Render with existing inpaint (skip inpaint in Rust)
          await api.render(resolvedIndex, {
            shaderEffect: renderEffect,
            shaderStroke: renderStroke,
            fontFamily,
          })
        } else {
          // Local LLM path — Rust pipeline handles translate + render
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
            inpaintMaxSide,
          })
          // Apply Thai post-processing ถ้าเปิดใช้งาน
          if (smartPostProcess) {
            const doc = await api.getDocument(resolvedIndex)
            if (doc.textBlocks.some((b: any) => b.translation)) {
              const updated = doc.textBlocks.map((b: any) => ({
                ...b,
                translation: b.translation
                  ? applysmartPostProcess(b.translation)
                  : b.translation,
              }))
              await api.updateTextBlocks(resolvedIndex, updated)
            }
          }
        }
        await invalidateCurrentDocument(queryClient, resolvedIndex)
        await invalidateThumbnailAtIndex(queryClient, resolvedIndex)
        useEditorUiStore.getState().setShowRenderedImage(true)
      } catch (error) {
        console.error('Failed to retranslate:', error)
        await clearProgress()
      } finally {
        finishOperation()
      }
    },
    [queryClient, clearProgress, updateTextBlocks],
  )

  // Stream-translate ทีละ block — แปลและแสดงผลแต่ละ bubble ทันทีที่เสร็จ
  // ปลอดภัย: ใช้ api.llmGenerate() ที่มีอยู่แล้ว ไม่แตะ main pipeline
  const streamTranslateImage = useCallback(
    async (_?: any, index?: number) => {
      const resolvedIndex =
        index ?? useEditorUiStore.getState().currentDocumentIndex
      const { selectedLanguage } = useLlmUiStore.getState()
      const { smartPostProcess } = usePreferencesStore.getState()
      const { startOperation, finishOperation } = useOperationStore.getState()

      const doc = await api.getDocument(resolvedIndex)
      const blocks = doc.textBlocks ?? []
      const total = blocks.length
      if (total === 0) return

      startOperation({
        type: 'process-current',
        cancellable: false,
        current: 0,
        total,
      })
      try {
        for (let i = 0; i < total; i++) {
          await api.llmGenerate(resolvedIndex, i, selectedLanguage ?? undefined)
          // Apply Thai post-processing ต่อ block นี้
          if (smartPostProcess) {
            const updated = await api.getDocument(resolvedIndex)
            const block = updated.textBlocks[i]
            if (block?.translation) {
              const patched = updated.textBlocks.map((b: any, idx: number) =>
                idx === i
                  ? { ...b, translation: applysmartPostProcess(b.translation) }
                  : b,
              )
              await api.updateTextBlocks(resolvedIndex, patched)
            }
          }
          // อัปเดต UI หลังแต่ละ block
          await invalidateCurrentDocument(queryClient, resolvedIndex)
        }
      } catch (error) {
        console.error('Stream translate error:', error)
      } finally {
        finishOperation()
      }
    },
    [queryClient],
  )

  // ตรวจจับภาษาต้นฉบับจากผล OCR อัตโนมัติ และตั้งค่า selectedLanguage ใน LLM UI
  const autoDetectSourceLanguage = useCallback(
    async (_?: any, index?: number): Promise<string | null> => {
      const resolvedIndex =
        index ?? useEditorUiStore.getState().currentDocumentIndex
      try {
        // Strategy: use whichever source actually has OCR text.
        // - Cloud OCR: cache is updated immediately via setQueryData but
        //   the sync queue to Rust may still be in-flight → prefer cache.
        // - Local Rust OCR: Rust has the text but cache may still be stale
        //   (not yet re-fetched) → fall back to api.getDocument().
        const cached = queryClient.getQueryData<{
          textBlocks?: { text?: string | null }[]
        }>(queryKeys.documents.current(resolvedIndex))
        const cacheHasText = (cached?.textBlocks ?? []).some((b: any) => b.text)
        const doc = cacheHasText
          ? cached!
          : await api.getDocument(resolvedIndex)
        const texts = (doc.textBlocks ?? [])
          .map((b: any) => b.text ?? '')
          .filter(Boolean)
        return detectDominantLanguage(texts)
      } catch {
        return null
      }
    },
    [queryClient],
  )

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

    exportDocument,
    exportAllInpainted,
    exportAllRendered,
    cancelOperation,
    setProgress,
    clearProgress,
    retranslateImage,
    streamTranslateImage,
    autoDetectSourceLanguage,
  }
}

const getTranslationContext = async (
  queryClient: QueryClient,
  resolvedIndex: number,
  textBlockIndex?: number,
): Promise<string | undefined> => {
  const contextParts: string[] = []

  // 1. Gather previous page translations
  if (resolvedIndex > 0) {
    const prevKey = queryKeys.documents.current(resolvedIndex - 1)
    let prevDoc = queryClient.getQueryData<any>(prevKey)
    if (!prevDoc) {
      try {
        prevDoc = await api.getDocument(resolvedIndex - 1)
      } catch (e) {
        console.warn(
          '[getTranslationContext] Failed to fetch previous document context',
          e,
        )
      }
    }
    if (prevDoc?.textBlocks) {
      const prevTranslations = prevDoc.textBlocks
        .map((b: any) => b.translation?.trim())
        .filter((t: any) => t)
      if (prevTranslations.length > 0) {
        contextParts.push(
          `Previous Page Translations:\n` + prevTranslations.join('\n'),
        )
      }
    }
  }

  // 2. Gather current page already-translated blocks (if translating a single block)
  if (typeof textBlockIndex === 'number') {
    const currentKey = queryKeys.documents.current(resolvedIndex)
    const currentDoc = queryClient.getQueryData<any>(currentKey)
    if (currentDoc?.textBlocks) {
      const currentTranslations = currentDoc.textBlocks
        .map((b: any, idx: number) => {
          if (idx !== textBlockIndex && b.translation?.trim()) {
            return b.translation.trim()
          }
          return null
        })
        .filter((t: any) => t)
      if (currentTranslations.length > 0) {
        contextParts.push(
          `Same Page Other Translations:\n` + currentTranslations.join('\n'),
        )
      }
    }
  }

  return contextParts.length > 0 ? contextParts.join('\n\n') : undefined
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

  /**
   * [llmGenerate] — จุดรวมศูนย์การเรียก LLM ทั้ง local และ cloud
   *
   * ทำงาน 2 โหมด:
   *  - Cloud Provider (cloudProvider !== 'none'): ส่งตรงไปยัง cloudLlm.ts
   *    โดย inject `style` เข้า prompt ก่อนยิง API
   *  - Local LLM (cloudProvider === 'none'): เรียก Rust backend ผ่าน api.llmGenerate()
   *    ไม่รองรับ style parameter (Rust pipeline ไม่รู้จัก style)
   *
   * @param style - น้ำเสียงการแปล ('standard' | 'shonen' | 'polite')
   *   ใช้ได้เฉพาะ cloud provider — local LLM ไม่ได้รับ parameter นี้
   *   ถ้าไม่ส่ง (undefined) → cloud path ใช้ prompt แบบ default
   */
  const llmGenerate = useCallback(
    async (
      _?: any,
      index?: number,
      textBlockIndex?: number,
      style?: 'standard' | 'shonen' | 'polite',
    ) => {
      const resolvedIndex =
        index ?? useEditorUiStore.getState().currentDocumentIndex

      const { cloudProvider, cloudTargetLanguage, smartPostProcess } =
        usePreferencesStore.getState()
      const selectedLanguage = useLlmUiStore.getState().selectedLanguage

      if (cloudProvider !== 'none') {
        const queryKey = queryKeys.documents.current(resolvedIndex)
        const currentDocument = queryClient.getQueryData<any>(queryKey)
        const { generateCloudTranslation } =
          await import('@/lib/services/cloudLlm')
        const language = cloudTargetLanguage || 'Thai'

        if (typeof textBlockIndex === 'number') {
          // [Single block] แปลแค่ bubble เดียวที่ผู้ใช้กดปุ่ม
          // ส่ง style ไปด้วยเพื่อให้ cloudLlm.ts inject style instruction ลง prompt
          const block = currentDocument?.textBlocks?.[textBlockIndex]
          if (block?.text) {
            try {
              const context = await getTranslationContext(
                queryClient,
                resolvedIndex,
                textBlockIndex,
              )
              const translation = await generateCloudTranslation(
                block.text,
                language,
                undefined,
                style,
                context,
              )
              const nextBlocks = (currentDocument?.textBlocks ?? []).map(
                (b: any, i: number) =>
                  i === textBlockIndex ? { ...b, translation } : b,
              )
              // Issue #21 — Thai post-process before save (no extra
              // round-trip vs the local-LLM path; we have the blocks
              // in-memory already).
              const processed = smartPostProcess
                ? applySmartPostProcessToBlocks(nextBlocks)
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
              toast.error(e.message || 'Translation failed')
            }
          }
        } else if (currentDocument?.textBlocks) {
          // Batch translation utilizing structured JSON
          try {
            // Generate = Inpaint first so bubble backgrounds are cleared
            // before translations are painted. Re-translate skips this step.
            await api.inpaint(resolvedIndex)

            const nextBlocks = [...currentDocument.textBlocks]

            // Prefer untranslated blocks. If every block already has a
            // translation (user re-clicked Generate), force-retranslate all
            // so the button never silently does nothing.
            const untranslated = nextBlocks
              .map((b, i) => ({ index: i, text: b.text || '' }))
              .filter((b) => b.text && !nextBlocks[b.index].translation)
            const blocksToTranslate =
              untranslated.length > 0
                ? untranslated
                : nextBlocks
                    .map((b, i) => ({ index: i, text: b.text || '' }))
                    .filter((b) => b.text)

            if (blocksToTranslate.length > 0) {
              const { generateCloudBatchTranslation } =
                await import('@/lib/services/cloudLlm')
              const context = await getTranslationContext(
                queryClient,
                resolvedIndex,
              )
              const translatedResult = await generateCloudBatchTranslation(
                blocksToTranslate,
                language,
                context,
              )

              // Map the returned JSON translations back to the blocks array
              for (const result of translatedResult) {
                if (
                  result &&
                  typeof result.index === 'number' &&
                  typeof result.translation === 'string'
                ) {
                  const b = nextBlocks[result.index]
                  if (b) {
                    nextBlocks[result.index] = {
                      ...b,
                      translation: result.translation,
                    }
                  }
                }
              }

              // Issue #21 — Thai post-process before save.
              const processed = smartPostProcess
                ? applySmartPostProcessToBlocks(nextBlocks)
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
            toast.error(
              e.message ||
                'Batch JSON translation failed. The AI or API might have failed to return a proper JSON structure.',
            )
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

        if (typeof textBlockIndex === 'number') {
          // Single block — translate only (inpaint per-block is not meaningful)
          const context = await getTranslationContext(
            queryClient,
            resolvedIndex,
            textBlockIndex,
          )
          await api.llmGenerate(
            resolvedIndex,
            textBlockIndex,
            language,
            context,
          )
        } else {
          // Batch mode: Generate = Inpaint + Translate + Render via Rust pipeline.
          // api.process() with skipDetect+skipOcr runs inpaint then LLM then render
          // in one shot — Re-translate uses skipInpaint:true to skip this step.
          const { renderEffect, renderStroke } = useEditorUiStore.getState()
          const { fontFamily, inpaintMaxSide } = usePreferencesStore.getState()
          await api.process({
            index: resolvedIndex,
            llmModelId: selectedModel,
            language,
            shaderEffect: renderEffect,
            shaderStroke: renderStroke,
            fontFamily,
            skipDetect: true,
            skipOcr: true,
            inpaintMaxSide,
          })
        }
        // Issue #21 — local LLM writes translations directly via Rust
        // pipeline, so we post-process server-side state via the helper
        // (fetch + apply + save back if changed).
        await maybeApplySmartPostProcess(resolvedIndex)
        await invalidateCurrentDocument(queryClient, resolvedIndex)
      }

      useEditorUiStore.getState().setShowTextBlocksOverlay(true)
      if (typeof textBlockIndex === 'number') {
        await renderTextBlock(undefined, resolvedIndex, textBlockIndex)
      } else {
        // Auto-render the full page after batch translate so the new
        // translations paint immediately. Without this, blocks sit
        // in the data model but the canvas doesn't repaint until
        // the user clicks Render or twiddles a font setting.
        try {
          const { renderEffect, renderStroke } = useEditorUiStore.getState()
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
