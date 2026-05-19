'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import {
  ScanIcon,
  ScanTextIcon,
  Wand2Icon,
  TypeIcon,
  LoaderCircleIcon,
  LanguagesIcon,
} from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useLlmUiStore } from '@/lib/stores/llmUiStore'
import { useLlmModelsQuery, useLlmReadyQuery } from '@/lib/query/hooks'
import { useDocumentMutations, useLlmMutations } from '@/lib/query/mutations'
import { useOperationStore } from '@/lib/stores/operationStore'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import { useQuery } from '@tanstack/react-query'
import { api, type ProviderProfileDto } from '@/lib/api'
import { effectiveDbProvider } from '@/lib/services/profileHelpers'

const PROVIDER_LABEL: Record<string, string> = {
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  gemini: 'Gemini',
  anthropic: 'Claude',
}

// Sentinel value used by the Select to represent "no cloud profile,
// use the local LLM engine". Profile rows render with their numeric
// `id` as the SelectItem value, so a literal underscore-bracketed
// string can't collide with a real profile id (ids are u64 from the
// SQLite autoincrement column — always parseable as Number).
const LOCAL_VALUE = '__local__'

export function CanvasToolbar() {
  return (
    <div className='border-border/60 bg-card text-foreground flex items-center gap-2 border-b px-3 py-2 text-xs'>
      <WorkflowButtons />
      <div className='flex-1' />
      <LlmStatusPopover />
    </div>
  )
}

function WorkflowButtons() {
  const { inpaint, detect, ocr, render } = useDocumentMutations()
  const { llmGenerate } = useLlmMutations()
  const { data: llmReady = false } = useLlmReadyQuery()
  const { cloudProvider } = usePreferencesStore()
  const [generating, setGenerating] = useState(false)
  const isLlmAvailable = llmReady || cloudProvider !== 'none'
  const { t } = useTranslation()
  const operation = useOperationStore((state) => state.operation)

  const isDetecting =
    operation?.type === 'process-current' && operation?.step === 'detect'
  const isOcr =
    operation?.type === 'process-current' && operation?.step === 'ocr'
  const isInpainting =
    operation?.type === 'process-current' && operation?.step === 'inpaint'
  const isRendering =
    operation?.type === 'process-current' && operation?.step === 'render'
  // Disable all pipeline buttons while a document is still loading so the
  // user cannot trigger detect/ocr/etc before the document is ready.
  const isLoading = operation?.type === 'load-khr'

  const handleTranslate = async () => {
    setGenerating(true)
    try {
      await llmGenerate(null)
    } catch (error) {
      console.error(error)
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className='flex items-center gap-0.5'>
      <Button
        variant='ghost'
        size='xs'
        onClick={detect}
        data-testid='toolbar-detect'
        disabled={isDetecting || isLoading}
      >
        {isDetecting ? (
          <LoaderCircleIcon className='size-4 animate-spin' />
        ) : (
          <ScanIcon className='size-4' />
        )}
        {t('processing.detect')}
      </Button>

      <Separator orientation='vertical' className='mx-0.5 h-4' />

      <Button
        variant='ghost'
        size='xs'
        onClick={ocr}
        data-testid='toolbar-ocr'
        disabled={isOcr || isLoading}
      >
        {isOcr ? (
          <LoaderCircleIcon className='size-4 animate-spin' />
        ) : (
          <ScanTextIcon className='size-4' />
        )}
        {t('processing.ocr')}
      </Button>

      <Separator orientation='vertical' className='mx-0.5 h-4' />

      <Button
        variant='ghost'
        size='xs'
        onClick={handleTranslate}
        disabled={!isLlmAvailable || generating || isLoading}
        data-testid='toolbar-translate'
      >
        {generating ? (
          <LoaderCircleIcon className='size-4 animate-spin' />
        ) : (
          <LanguagesIcon className='size-4' />
        )}
        {t('llm.generate')}
      </Button>

      <Separator orientation='vertical' className='mx-0.5 h-4' />

      <Button
        variant='ghost'
        size='xs'
        onClick={inpaint}
        data-testid='toolbar-inpaint'
        disabled={isInpainting || isLoading}
      >
        {isInpainting ? (
          <LoaderCircleIcon className='size-4 animate-spin' />
        ) : (
          <Wand2Icon className='size-4' />
        )}
        {t('mask.inpaint')}
      </Button>

      <Separator orientation='vertical' className='mx-0.5 h-4' />

      <Button
        variant='ghost'
        size='xs'
        onClick={render}
        data-testid='toolbar-render'
        disabled={isRendering || isLoading}
      >
        {isRendering ? (
          <LoaderCircleIcon className='size-4 animate-spin' />
        ) : (
          <TypeIcon className='size-4' />
        )}
        {t('llm.render')}
      </Button>
    </div>
  )
}

function LlmStatusPopover() {
  const { data: llmModels = [] } = useLlmModelsQuery()
  const llmSelectedModel = useLlmUiStore((state) => state.selectedModel)
  const llmSelectedLanguage = useLlmUiStore((state) => state.selectedLanguage)
  const llmLoading = useLlmUiStore((state) => state.loading)
  const { data: llmReady = false } = useLlmReadyQuery()
  const { llmSetSelectedModel, llmSetSelectedLanguage, llmToggleLoadUnload } =
    useLlmMutations()
  const { autoDetectSourceLanguage } = useDocumentMutations()
  const {
    cloudProvider,
    setCloudProvider,
    cloudModelName,
    setCloudModelName,
    setCloudApiKey,
    setCloudApiUrl,
    cloudTargetLanguage,
    setCloudTargetLanguage,
  } = usePreferencesStore()
  const { t } = useTranslation()
  const isCloudActive = cloudProvider !== 'none'

  // Profiles drive the engine picker — local engine is always available;
  // each saved profile becomes one option.
  const profiles = useQuery({
    queryKey: ['project', 'profiles'],
    queryFn: () => api.providerProfilesList(),
  })
  const profileList = profiles.data ?? []

  // Provider resolution comes from the shared `profileHelpers` so
  // legacy-OpenRouter compat (slash-form modelName saved as
  // provider='openai' before backend b3d4c7f3) lands on the right
  // dispatcher. Last inline copy of this heuristic — the 3 others
  // were consolidated in earlier audit passes.

  const activeProfileId = useMemo(() => {
    if (!isCloudActive) return LOCAL_VALUE
    const match = profileList.find(
      (p) =>
        effectiveDbProvider(p) === cloudProvider &&
        p.modelName === cloudModelName,
    )
    return match ? String(match.id) : LOCAL_VALUE
  }, [isCloudActive, profileList, cloudProvider, cloudModelName])

  // Apply-in-flight tracker. Each `applyProfile()` call captures the
  // post-bump sequence; any earlier in-flight secret fetch that
  // resolves later finds its `myGen < applyGen.current` and skips
  // writing the (now-stale) API key into the prefs store. Closes the
  // race when the user rapidly switches profiles before the keyring
  // round-trip for the first pick completes.
  const applyGen = useRef(0)
  const [applying, setApplying] = useState(false)
  const applyProfile = async (p: ProviderProfileDto) => {
    const myGen = ++applyGen.current
    setApplying(true)
    // Synchronously stamp the prefs that don't need the network so the
    // UI flips immediately. The async key fetch is the only thing
    // guarded against a later apply.
    setCloudProvider(effectiveDbProvider(p) as any)
    setCloudModelName(p.modelName)
    usePreferencesStore.getState().setActiveProfileId(p.id)
    if (p.apiUrl) setCloudApiUrl(p.apiUrl)
    try {
      const { apiKey } = await api.providerProfileSecretGet(p.id)
      if (myGen !== applyGen.current) return
      if (apiKey) setCloudApiKey(apiKey)
    } catch (err) {
      if (myGen === applyGen.current) {
        console.warn('[toolbar] profile secret fetch failed', err)
      }
    } finally {
      if (myGen === applyGen.current) setApplying(false)
    }
  }

  const onEngineChange = (value: string) => {
    if (value === LOCAL_VALUE) {
      setCloudProvider('none' as any)
      usePreferencesStore.getState().setActiveProfileId(null)
      return
    }
    const id = Number(value)
    const profile = profileList.find((p) => p.id === id)
    if (profile) void applyProfile(profile)
  }

  const activeLanguages = useMemo(
    () =>
      llmModels.find((model) => model.id === llmSelectedModel)?.languages ?? [],
    [llmModels, llmSelectedModel],
  )

  useEffect(() => {
    if (llmModels.length === 0) return
    const hasCurrent = llmModels.some((model) => model.id === llmSelectedModel)
    const nextModel = hasCurrent ? llmSelectedModel : llmModels[0]?.id
    if (!nextModel) return
    const languages =
      llmModels.find((model) => model.id === nextModel)?.languages ?? []
    const nextLanguage =
      llmSelectedLanguage && languages.includes(llmSelectedLanguage)
        ? llmSelectedLanguage
        : languages[0]
    const currentState = useLlmUiStore.getState()
    if (
      currentState.selectedModel === nextModel &&
      currentState.selectedLanguage === nextLanguage
    ) {
      return
    }
    useLlmUiStore.setState((state) => ({
      selectedModel: nextModel,
      selectedLanguage: nextLanguage,
      loading: state.loading,
    }))
  }, [llmModels, llmSelectedLanguage, llmSelectedModel])

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          data-testid='llm-trigger'
          data-llm-ready={llmReady || isCloudActive ? 'true' : 'false'}
          data-llm-loading={llmLoading ? 'true' : 'false'}
          className={`flex h-6 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium shadow-sm transition hover:opacity-80 ${
            llmReady || isCloudActive
              ? 'bg-rose-400 text-white ring-1 ring-rose-400/30'
              : 'bg-muted text-muted-foreground ring-border/50 ring-1'
          }`}
        >
          <motion.span
            className={`size-1.5 rounded-full ${
              llmReady || isCloudActive ? 'bg-white' : 'bg-muted-foreground/40'
            }`}
            animate={llmReady || isCloudActive ? { opacity: [1, 0.5, 1] } : { opacity: 1 }}
            transition={
              llmReady || isCloudActive
                ? { duration: 2, repeat: Infinity, ease: 'easeInOut' }
                : {}
            }
          />
          LLM
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-72' data-testid='llm-popover'>
        <div className='space-y-3 text-sm'>
          <p className='text-muted-foreground text-xs font-medium uppercase'>
            {t('panels.llm')}
          </p>

          <Select
            value={activeProfileId}
            onValueChange={onEngineChange}
            disabled={applying}
          >
            <SelectTrigger className='w-full'>
              <SelectValue placeholder='AI Engine' />
            </SelectTrigger>
            <SelectContent position='popper'>
              <SelectItem value={LOCAL_VALUE}>Local Engine (GGUF)</SelectItem>
              {profileList.length > 0 && (
                <div className='text-muted-foreground px-2 pt-2 pb-1 text-[10px] font-semibold uppercase'>
                  Cloud Profiles
                </div>
              )}
              {profileList.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  <span className='flex items-center gap-1.5'>
                    {p.isDefault && (
                      <span className='text-amber-500' title='default'>
                        ★
                      </span>
                    )}
                    <span>{p.name}</span>
                    <span className='text-muted-foreground text-[10px]'>
                      · {PROVIDER_LABEL[p.provider] ?? p.provider} ·{' '}
                      {p.modelName || 'no model'}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {profileList.length === 0 && (
            <p className='text-muted-foreground text-[10px]'>
              {t(
                'llm.noProfilesHint',
                'Create a Cloud profile in the Profiles sidebar tab to use it here.',
              )}
            </p>
          )}

          {!isCloudActive ? (
            <>
              <Select value={llmSelectedModel} onValueChange={llmSetSelectedModel}>
                <SelectTrigger data-testid='llm-model-select' className='w-full'>
                  <SelectValue placeholder={t('llm.selectPlaceholder')} />
                </SelectTrigger>
                <SelectContent position='popper'>
                  {llmModels.map((model, index) => (
                    <SelectItem
                      key={model.id}
                      value={model.id}
                      data-testid={`llm-model-option-${index}`}
                    >
                      {model.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {activeLanguages.length > 0 && (
                <Select
                  value={llmSelectedLanguage ?? activeLanguages[0]}
                  onValueChange={llmSetSelectedLanguage}
                >
                  <SelectTrigger
                    data-testid='llm-language-select'
                    className='w-full'
                  >
                    <SelectValue placeholder={t('llm.languagePlaceholder')} />
                  </SelectTrigger>
                  <SelectContent position='popper'>
                    {activeLanguages.map((language, index) => (
                      <SelectItem
                        key={language}
                        value={language}
                        data-testid={`llm-language-option-${index}`}
                      >
                        {language}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {activeLanguages.length > 0 && (
                <Button
                  type='button'
                  variant='secondary'
                  size='sm'
                  onClick={async () => {
                    const detected = await autoDetectSourceLanguage()
                    if (detected && activeLanguages.includes(detected)) {
                      llmSetSelectedLanguage(detected)
                    } else if (detected) {
                      alert(`Detected: ${detected}, but model doesn't support it.`)
                    } else {
                      alert('Could not detect language.')
                    }
                  }}
                  className='h-6 w-full text-[10px]'
                >
                  Auto-detect Source
                </Button>
              )}

              <Button
                data-testid='llm-load-toggle'
                data-llm-ready={llmReady ? 'true' : 'false'}
                data-llm-loading={llmLoading ? 'true' : 'false'}
                variant='outline'
                size='sm'
                onClick={llmToggleLoadUnload}
                disabled={!llmSelectedModel || llmLoading}
                className='w-full gap-1.5 text-xs'
              >
                {llmLoading && (
                  <LoaderCircleIcon className='size-3.5 animate-spin' />
                )}
                {!llmReady ? t('llm.load') : t('llm.unload')}
              </Button>
            </>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="space-y-1">
                <label className="text-muted-foreground text-[10px] font-semibold uppercase">Target Language</label>
                <Select value={cloudTargetLanguage} onValueChange={setCloudTargetLanguage}>
                  <SelectTrigger className='w-full'>
                    <SelectValue placeholder="Language" />
                  </SelectTrigger>
                  <SelectContent position='popper'>
                    <SelectItem value="Thai">Thai</SelectItem>
                    <SelectItem value="English">English</SelectItem>
                    <SelectItem value="Japanese">Japanese</SelectItem>
                    <SelectItem value="Chinese">Chinese</SelectItem>
                    <SelectItem value="Korean">Korean</SelectItem>
                  </SelectContent>
                </Select>

              </div>
              <div className='bg-muted text-muted-foreground rounded border p-3 text-center text-xs'>
                <p className='text-foreground mb-1 font-semibold'>
                  Cloud AI is active
                </p>
                <p>
                  {cloudModelName ? (
                    <>
                      <span className='font-medium'>
                        {PROVIDER_LABEL[cloudProvider] ?? cloudProvider}
                      </span>{' '}
                      · {cloudModelName}
                    </>
                  ) : (
                    <>No profile applied</>
                  )}
                </p>
                <p className='text-muted-foreground/70 mt-1 text-[10px]'>
                  {t('llm.editProfilesHint', 'Edit profiles in the Profiles sidebar tab.')}
                </p>
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
