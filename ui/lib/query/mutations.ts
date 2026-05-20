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
import { useTextStylePresetsStore } from '@/lib/stores/textStylePresetsStore'
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
import { invalidateSessionHistory } from '@/lib/hooks/useSessionHistory'
import { applyThaiPostProcessToBlocks } from '@/lib/util/thaiPostProcess'
import i18n from '@/lib/i18n'

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

/// Engine id of the Cloud Vision OCR pseudo-engine (mirrors
/// koharu-pipeline cloud_vision_ocr::ENGINE_ID). When it's the active
/// OcrText engine, OCR runs on the frontend (cloudOcr.ts) instead of the
/// local backend engine.
const CLOUD_VISION_OCR_ID = 'cloud_vision_ocr'

/// Resolve the cloud-OCR choice from the machine-wide engine profile:
/// is Cloud Vision the active OCR engine, and which provider profile id
/// did the user pick in its `vision_profile` setting (`null` = use the
/// active translation profile). Reads fresh so a just-changed Engines-tab
/// selection is honoured; falls back to "local" on any error.
async function readCloudOcrChoice(): Promise<{
  isCloud: boolean
  profileId: number | null
}> {
  try {
    const profile = await api.engineProfileGet()
    const isCloud = profile.active['ocr_text'] === CLOUD_VISION_OCR_ID
    const raw = profile.settings?.[CLOUD_VISION_OCR_ID]?.['vision_profile']
    let profileId: number | null = null
    if (typeof raw === 'number') profileId = raw
    else if (typeof raw === 'string' && raw !== 'active' && raw !== '') {
      const n = Number(raw)
      profileId = Number.isFinite(n) ? n : null
    }
    return { isCloud, profileId }
  } catch {
    return { isCloud: false, profileId: null }
  }
}

/// The full Process / batch pipeline (`run_pipeline`) runs detect + OCR
/// through the LEGACY ML facade keyed off `ProcessRequest.{detector_engine,
/// ocr_engine, anime_yolo_*}` — it does NOT consult the v2 engine profile.
/// So to make Process respect the Engines-tab selection (which only the
/// standalone Detect/OCR buttons read via run_engine_for_artifact), we
/// translate the profile's active engines + anime-yolo settings into the
/// legacy enums and pass them to `api.process`. Cloud OCR is handled by the
/// frontend cloud branch (skipDetect/skipOcr); cloud → local-default here.
/// Note: the legacy pipeline can't carry nms/containment, so full Process
/// applies only variant + confidence for anime_yolo (the standalone Detect
/// button gets all four via the engine path).
async function readPipelineEngines(): Promise<{
  detectorEngine: 'default' | 'anime_yolo'
  animeYoloVariant?: 'n' | 's' | 'm' | 'l' | 'x'
  animeYoloConfidence?: number
  ocrEngine: 'mit48px' | 'manga'
}> {
  try {
    const profile = await api.engineProfileGet()
    const detectorEngine =
      profile.active['detection_boxes'] === 'anime_yolo_detector'
        ? 'anime_yolo'
        : 'default'
    const ocrEngine =
      profile.active['ocr_text'] === 'manga_ocr' ? 'manga' : 'mit48px'
    const ay = profile.settings?.['anime_yolo_detector'] ?? {}
    const variantRaw = ay['variant']
    const confRaw = ay['confidence_threshold']
    return {
      detectorEngine,
      ocrEngine,
      animeYoloVariant:
        typeof variantRaw === 'string'
          ? (variantRaw as 'n' | 's' | 'm' | 'l' | 'x')
          : undefined,
      animeYoloConfidence:
        typeof confRaw === 'number' ? confRaw : undefined,
    }
  } catch {
    return { detectorEngine: 'default', ocrEngine: 'mit48px' }
  }
}

const invalidateCurrentDocument = async (
  queryClient: QueryClient,
  index: number,
) => {
  await queryClient.invalidateQueries({
    queryKey: queryKeys.documents.current(index),
  })
  // Phase 5.5: every doc invalidate also bumps the session
  // history query so the toolbar's undo/redo enabled-state
  // refetches without waiting for the staleTime tick. For
  // mutation paths that DON'T touch session.scene (text-block
  // edits via direct RPC), this is a benign no-op refetch that
  // returns the same HistoryState.
  await invalidateSessionHistory(queryClient)
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
      // Audit #9/B1 follow-up: Backend `update_text_blocks` calls
      // `SessionSlot::invalidate_if_doc` to drop the undo/redo
      // session for this doc (NodeId↔array mapping is broken by
      // bulk replace). Invalidate the frontend's history cache so
      // the toolbar refetches `session_history_state` and sees the
      // empty session → audit #8/P3 doc-index gate kicks in →
      // Undo button disables itself. Pre-this-fix the cached
      // undoLen stayed > 0 and the user could click Undo + hit a
      // confusing "no session" error toast.
      await invalidateSessionHistory(queryClient)
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

      // v2 blob transport: Document.segment is a hex BlobId (string),
      // not raw bytes. The stroke is already painted locally on the
      // brush canvas inside useMaskDrawing — we don't need to mirror
      // the bytes into React-Query state. Once the backend round-trip
      // finishes, inpaintPartial → invalidateCurrentDocument refetches
      // and the new hex BlobId arrives; useMaskDrawing's segment-dep
      // effect then re-fetches the bitmap and repaints the canvas with
      // the server-side truth. (Writing `segment: mask` here would have
      // shoved a Uint8Array into a string-typed field, then served as
      // `/blob/1,2,3,...` on the next render — broken URL.)

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
        // Engine choice + per-engine settings come from the machine-wide
        // engine profile (Sidebar → Engines tab). Dispatch with no engine
        // override so the backend resolves the active DetectionBoxes engine
        // from the profile — one source of truth, no Settings-page duplicate.
        await api.detect(resolvedIndex, {})
        await invalidateCurrentDocument(queryClient, resolvedIndex)
        await invalidateThumbnailAtIndex(queryClient, resolvedIndex)

        // Seed freshly-detected blocks with the user's default style
        // preset (if one is starred) so they match the chosen house
        // style without manual styling. Only touches blocks that have
        // no style yet, so a re-detect won't stomp existing edits.
        const defaultStyle =
          useTextStylePresetsStore.getState().getDefaultStyle()
        if (defaultStyle) {
          const doc = queryClient.getQueryData<any>(
            queryKeys.documents.current(resolvedIndex),
          )
          const blocks: any[] = doc?.textBlocks ?? []
          if (blocks.some((b) => !b.style)) {
            const next = blocks.map((b) =>
              b.style ? b : { ...b, style: { ...defaultStyle } },
            )
            queryClient.setQueryData(
              queryKeys.documents.current(resolvedIndex),
              { ...doc, textBlocks: next },
            )
            await enqueueTextBlockSync(resolvedIndex, next)
          }
        }

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
        const { isCloud, profileId } = await readCloudOcrChoice()
        if (isCloud) {
          // Cloud Vision OCR is the active OCR engine (Sidebar → Engines).
          // Run detect first if no text_blocks yet (user expectation is
          // "OCR this page"), then dispatch each bubble to the chosen
          // vision profile on the frontend.
          const { cloudProvider, cloudModelName, cloudApiKey } =
            usePreferencesStore.getState()
          const profiles = await api.providerProfilesList()
          const resolved = await resolveOcrCloudProfile(
            profileId,
            profiles,
            cloudProvider,
            cloudModelName,
            cloudApiKey,
          )
          if (!resolved) {
            throw new Error(
              'Cloud Vision OCR is selected but no vision-capable profile is available. Pick one in the Engines tab (Cloud Vision OCR → Vision profile) or add a vision-capable profile in Sidebar → Profiles.',
            )
          }
          let doc = await api.getDocument(resolvedIndex)
          if (doc.textBlocks.length === 0) {
            await api.detect(resolvedIndex, {})
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
          // Local OCR — engine (MIT-48px vs Manga OCR) is resolved from
          // the machine-wide engine profile (Sidebar → Engines tab), so
          // dispatch with no override. Cloud Vision stays a frontend path
          // (above) since it isn't a v2 engine yet.
          await api.ocr(resolvedIndex, {})
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
      const { fontFamily } = usePreferencesStore.getState()
      const { startOperation, finishOperation } = useOperationStore.getState()
      const { isCloud, profileId } = await readCloudOcrChoice()
      startOperation({
        type: 'process-current',
        cancellable: true,
        current: 0,
        total: 5,
      })
      try {
        if (isCloud) {
          // Cloud Vision OCR is the active OCR engine: detect first
          // ourselves, OCR via the chosen cloud profile, then ask the
          // Rust pipeline to skip detect+OCR and run the rest.
          const { cloudProvider, cloudModelName, cloudApiKey } =
            usePreferencesStore.getState()
          const profiles = await api.providerProfilesList()
          const resolved = await resolveOcrCloudProfile(
            profileId,
            profiles,
            cloudProvider,
            cloudModelName,
            cloudApiKey,
          )
          if (!resolved) {
            throw new Error(
              'Cloud Vision OCR is selected but no vision-capable profile is available. Pick one in the Engines tab (Cloud Vision OCR → Vision profile) or add a vision-capable profile in Sidebar → Profiles.',
            )
          }
          await api.detect(resolvedIndex, {})
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
          // Local pipeline: bridge the Engines-tab selection into the
          // legacy ProcessRequest fields the pipeline reads (it doesn't
          // consult the engine profile itself).
          const eng = await readPipelineEngines()
          await api.process({
            index: resolvedIndex,
            llmModelId: selectedModel,
            language: selectedLanguage,
            shaderEffect: renderEffect,
            shaderStroke: renderStroke,
            fontFamily,
            detectorEngine: eng.detectorEngine,
            animeYoloVariant: eng.animeYoloVariant,
            animeYoloConfidence: eng.animeYoloConfidence,
            ocrEngine: eng.ocrEngine,
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
    const { fontFamily } = usePreferencesStore.getState()
    const { startOperation, finishOperation } = useOperationStore.getState()
    if (!totalPages) return
    // Cloud Vision OCR runs page-by-page from the frontend (no Rust
    // worker support yet — see roadmap Tier B #3) which would burn
    // tokens fast across many pages, so batch uses the engine profile's
    // local OCR engine instead. Let the user know once.
    const { isCloud: cloudOcrActive } = await readCloudOcrChoice()
    if (cloudOcrActive) {
      console.info(
        '[processAll] Cloud Vision OCR is not used for batch — the Engines-tab local OCR engine is used instead. Use Process current for individual pages with Cloud Vision.',
      )
    }
    startOperation({
      type: 'process-all',
      cancellable: true,
      current: 0,
      total: totalPages,
    })
    try {
      // Bridge the Engines-tab selection into the legacy pipeline fields
      // (the pipeline doesn't read the engine profile). Cloud OCR maps to
      // the local default here — batch never uses Cloud Vision.
      const eng = await readPipelineEngines()
      await api.process({
        llmModelId: selectedModel,
        language: selectedLanguage,
        shaderEffect: renderEffect,
        shaderStroke: renderStroke,
        fontFamily,
        detectorEngine: eng.detectorEngine,
        animeYoloVariant: eng.animeYoloVariant,
        animeYoloConfidence: eng.animeYoloConfidence,
        ocrEngine: eng.ocrEngine,
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
