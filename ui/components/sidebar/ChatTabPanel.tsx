'use client'

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import {
  BellOffIcon,
  BotIcon,
  ChevronDownIcon,
  ImagePlusIcon,
  Loader2Icon,
  Redo2Icon,
  ScanLineIcon,
  SendIcon,
  Trash2Icon,
  TriangleAlertIcon,
  Undo2Icon,
  UserIcon,
  WrenchIcon,
  XIcon,
  ZapIcon,
  CopyIcon,
  CheckIcon,
  RefreshCwIcon,
  SparklesIcon,
  BookOpenIcon,
  SlidersIcon,
  MicIcon,
  MicOffIcon,
  StarIcon,
  CoinsIcon,
  FileDiffIcon,
  PlusIcon,
  DownloadIcon,
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { getHttpUrl } from '@/lib/backend'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useCurrentDocumentState } from '@/lib/query/hooks'
import {
  api,
  type ChatAttachment,
  type ChatMessageDto,
  type GlossaryDto,
} from '@/lib/api'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'

import { useProjectStore } from '@/lib/stores/projectStore'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { useChatActivityStore } from '@/lib/stores/chatActivityStore'
import { runChatTurn, type ChatMessage } from '@/lib/services/chatWithTools'
import { expandSlash, SLASH_COMMANDS } from '@/lib/services/chatSlashCommands'
import { blobToAttachment, parseAttachments } from '@/lib/services/imageAttach'
import { supportsVision } from '@/lib/services/visionSupport'
import { KINDS, kindOf } from '@/lib/services/profileHelpers'
import i18n from '@/lib/i18n'
import { toArrayBuffer } from '@/lib/util'
import { ChatMarkdown } from '@/components/sidebar/chat-markdown'

const DISPLAY_LIMIT = 50

/** Map the app's i18next locale code to the natural-language name we
 *  pass to the model. The model recognises "Thai" much more reliably
 *  than the BCP-47 code "th-TH". */
const UI_LOCALE_TO_LANGUAGE: Record<string, string> = {
  'en-US': 'English',
  'th-TH': 'Thai',
  'ja-JP': 'Japanese',
  en: 'English',
  th: 'Thai',
  ja: 'Japanese',
}

function uiLanguageName(): string {
  const code = i18n.language || i18n.options?.fallbackLng?.toString() || 'en-US'
  return (
    UI_LOCALE_TO_LANGUAGE[code] ??
    UI_LOCALE_TO_LANGUAGE[code.split('-')[0]] ??
    'English'
  )
}

/** Build the system message injected at the top of every conversation —
 *  tells the assistant which project it's working on. */
async function buildSystemPrompt(agenticMode?: boolean): Promise<string> {
  const uiLang = uiLanguageName()
  const project = useProjectStore.getState().info
  if (!project) {
    return [
      'You are an AI assistant for manga translation. No project is currently open.',
      `Reply to the user in the same language they write their message in (e.g., if they chat in Thai, respond in Thai; if they chat in English, respond in English). Default to ${uiLang} if the language cannot be determined.`,
    ].join('\n')
  }
  let series: any = null
  try {
    series = await api.seriesMetaGet()
  } catch {}

  const baseInstructions = [
    'You are an AI assistant embedded in the Koharu manga translation editor.',
    `The user is working on project "${project.name}".`,
    `Reply to the user in the same language they write their message in (e.g., if they chat in Thai, respond in Thai; if they chat in English, respond in English). Default to ${uiLang} if the language cannot be determined.`,
    'You have tools to read and modify series metadata, characters, glossary, chapters, prompt templates, and to fetch web pages (wikis).',
    'When the user asks you to populate or update project data, propose changes first, wait for approval, then call the matching tool.',
    'Keep your replies concise. Use markdown tables for proposals.',
    'IMPORTANT: Do NOT call any tools (especially view_current_page or view_chapter_page) for generic greetings, simple messages, or casual chit-chat (e.g. "Hello", "สวัสดี", "Hi", "How are you?"). Just reply politely in a friendly tone and ask how you can help.',
    '',
    series
      ? `Current series_meta: ${JSON.stringify({
          title: series.title,
          synopsis: series.synopsis,
          tone: series.tone,
          styleNotes: series.styleNotes,
          sourceLanguage: series.sourceLanguage,
          targetLanguage: series.targetLanguage,
        })}`
      : '',
  ]

  if (agenticMode) {
    return [
      ...baseInstructions.filter(Boolean),
      '',
      'CRITICAL REQUEST - MULTI-STEP AGENTIC TRANSLATION CHAIN:',
      'You MUST structure your response inside a multi-step translation chain using exact boundaries as follows:',
      '---AGENTIC_CHAIN---',
      '[STEP 1: Literal Translation]',
      '(Provide a literal Japanese-to-Thai translation here, strictly matching word order and original structure to explain the syntax)',
      '',
      '[STEP 2: Context & Cultural Nuances]',
      '(Analyze the manga context, character status/relationship, pop-culture references, slang, idioms, or onomatopoeia)',
      '',
      '[STEP 3: Premium Polish]',
      '(Provide the final highly polished, contextualized, natural Thai translation suitable for typesetting inside the manga speech bubble. Only this output will be used on the canvas.)',
      '---END_AGENTIC_CHAIN---',
      'Make sure to output all three steps and use the exact bracket headers so the system can parse and display them in a stepper. Do not include any other markdown text outside the chain boundaries.',
    ].join('\n')
  }

  return baseInstructions.filter(Boolean).join('\n')
}

interface DiffChunk {
  type: 'added' | 'removed' | 'same'
  value: string
}

function computeDiff(oldText: string, newText: string): DiffChunk[] {
  const oldWords = oldText.split(/(\s+)/)
  const newWords = newText.split(/(\s+)/)

  const dp: number[][] = Array(oldWords.length + 1)
    .fill(null)
    .map(() => Array(newWords.length + 1).fill(0))

  for (let i = 1; i <= oldWords.length; i++) {
    for (let j = 1; j <= newWords.length; j++) {
      if (oldWords[i - 1] === newWords[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  const chunks: DiffChunk[] = []
  let i = oldWords.length
  let j = newWords.length

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
      chunks.push({ type: 'same', value: oldWords[i - 1] })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      chunks.push({ type: 'added', value: newWords[j - 1] })
      j--
    } else {
      chunks.push({ type: 'removed', value: oldWords[i - 1] })
      i--
    }
  }

  return chunks.reverse()
}

interface AgenticSteps {
  step1: string
  step2: string
  step3: string
  isAgentic: boolean
}

function parseAgenticChain(content: string): AgenticSteps {
  if (!content) return { step1: '', step2: '', step3: '', isAgentic: false }

  const hasAgenticToken =
    content.includes('---AGENTIC_CHAIN---') ||
    content.includes('[STEP 1:') ||
    content.includes('[STEP 2:') ||
    content.includes('[STEP 3:')

  if (!hasAgenticToken) {
    return { step1: '', step2: '', step3: content, isAgentic: false }
  }

  let step1 = ''
  let step2 = ''
  let step3 = ''

  const s1Index = content.indexOf('[STEP 1:')
  const s2Index = content.indexOf('[STEP 2:')
  const s3Index = content.indexOf('[STEP 3:')
  const endIndex = content.indexOf('---END_AGENTIC_CHAIN---')

  if (s1Index !== -1) {
    const end =
      s2Index !== -1
        ? s2Index
        : s3Index !== -1
          ? s3Index
          : endIndex !== -1
            ? endIndex
            : content.length
    step1 = content.slice(s1Index + 8, end).trim()
    if (step1.startsWith(']')) step1 = step1.slice(1).trim()
    if (step1.startsWith('Literal Translation]')) step1 = step1.slice(20).trim()
  }

  if (s2Index !== -1) {
    const end =
      s3Index !== -1 ? s3Index : endIndex !== -1 ? endIndex : content.length
    step2 = content.slice(s2Index + 8, end).trim()
    if (step2.startsWith(']')) step2 = step2.slice(1).trim()
    if (step2.startsWith('Context & Cultural Nuances]'))
      step2 = step2.slice(27).trim()
  }

  if (s3Index !== -1) {
    const end = endIndex !== -1 ? endIndex : content.length
    step3 = content.slice(s3Index + 8, end).trim()
    if (step3.startsWith(']')) step3 = step3.slice(1).trim()
    if (step3.startsWith('Premium Polish]')) step3 = step3.slice(15).trim()
  }

  if (!step1 && !step2 && !step3) {
    step3 = content
  }

  return { step1, step2, step3, isAgentic: true }
}

function calculateSimilarity(str1: string, str2: string): number {
  if (!str1 || !str2) return 0
  const s1 = str1.replace(/\s+/g, '')
  const s2 = str2.replace(/\s+/g, '')
  if (s1 === s2) return 1
  if (s1.length < 2 || s2.length < 2) {
    let matches = 0
    for (let i = 0; i < s1.length; i++) {
      if (s2.includes(s1[i])) matches++
    }
    return (2 * matches) / (s1.length + s2.length)
  }

  const getBigrams = (str: string) => {
    const bigrams = new Set<string>()
    for (let i = 0; i < str.length - 1; i++) {
      bigrams.add(str.slice(i, i + 2))
    }
    return bigrams
  }

  const bigrams1 = getBigrams(s1)
  const bigrams2 = getBigrams(s2)

  let intersection = 0
  bigrams1.forEach((b) => {
    if (bigrams2.has(b)) intersection++
  })

  return (2 * intersection) / (bigrams1.size + bigrams2.size)
}

function rowToChatMessage(row: ChatMessageDto): ChatMessage {
  let toolCalls
  if (row.toolCalls) {
    try {
      toolCalls = JSON.parse(row.toolCalls)
    } catch {}
  }
  return {
    role: row.role,
    content: row.content,
    toolCalls,
    toolCallId: row.toolCallId ?? undefined,
    attachments: parseAttachments(row.attachments),
  }
}

export function ChatTabPanel() {
  const { t } = useTranslation()
  const projectInfo = useProjectStore((s) => s.info)
  // Subscribe to each pref individually — Zustand re-renders only when
  // the specific selected slice changes, so 4 hooks is cheaper than one
  // hook reading a 4-key object (object identity flips every render).
  const provider = usePreferencesStore((s) => s.cloudProvider)
  const apiKey = usePreferencesStore((s) => s.cloudApiKey)
  const model = usePreferencesStore((s) => s.cloudModelName)
  const apiUrl = usePreferencesStore((s) => s.cloudApiUrl)

  const history = useQuery({
    queryKey: ['project', 'chat-messages'],
    queryFn: () => api.chatMessagesList({ limit: DISPLAY_LIMIT }),
    enabled: !!projectInfo,
    staleTime: 5_000,
  })

  const profilesQuery = useQuery({
    queryKey: ['project', 'profiles'],
    queryFn: () => api.providerProfilesList(),
    enabled: !!projectInfo,
  })

  const [input, setInput] = useState('')
  const [showSlash, setShowSlash] = useState(false)
  // Highlighted row in the slash picker (arrow-key navigation).
  const [slashIndex, setSlashIndex] = useState(0)
  // The command name being typed (text after `/`, before any space) and
  // the matching commands. Shared by the picker UI and the Textarea key
  // handler so ↑/↓/Tab/Enter operate on one source of truth.
  const slashQuery = input.startsWith('/') ? (input.slice(1).split(' ')[0] ?? '') : ''
  const slashMatches = useMemo(
    () =>
      SLASH_COMMANDS.filter((c) =>
        c.name.toLowerCase().includes(slashQuery.toLowerCase()),
      ),
    [slashQuery],
  )
  const completeSlash = (name: string) => {
    setInput(`/${name} `)
    setShowSlash(false)
    setSlashIndex(0)
  }
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>(
    [],
  )
  const [attaching, setAttaching] = useState(false)
  // Self-test fix: sending / streamingText / error / abort now live
  // in `useChatActivityStore`. The component used to host these as
  // local state, which meant switching the sidebar away from chat
  // unmounted the panel and dropped the in-flight stream from the
  // user's view (the DB writes survived but the live indicator was
  // gone). The store lifecycle is independent of the panel mount.
  const sending = useChatActivityStore((s) => s.sending)
  const streamingText = useChatActivityStore((s) => s.streamingText)
  const error = useChatActivityStore((s) => s.error)
  const startChat = useChatActivityStore((s) => s.start)
  const stopChat = useChatActivityStore((s) => s.stop)
  const clearChatError = useChatActivityStore((s) => s.clearError)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const currentDocIndex = useEditorUiStore((s) => s.currentDocumentIndex)

  const [temperature, setTemperature] = useState<number>(() => {
    const saved = localStorage.getItem('koharu_chat_temp')
    return saved !== null ? parseFloat(saved) : 0.7
  })
  const [maxTokens, setMaxTokens] = useState<number>(() => {
    const saved = localStorage.getItem('koharu_chat_max_tokens')
    return saved !== null ? parseInt(saved, 10) : 2048
  })
  const [enhancing, setEnhancing] = useState(false)
  const regeneratingUserMsgIdRef = useRef<number | null>(null)

  const [isListening, setIsListening] = useState(false)
  const [voiceLang, setVoiceLang] = useState('th-TH')
  const recognitionRef = useRef<any>(null)

  const toggleListening = () => {
    if (isListening) {
      if (recognitionRef.current) {
        recognitionRef.current.stop()
      }
      setIsListening(false)
      return
    }

    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition
    if (!SpeechRecognition) {
      setError('เบราว์เซอร์นี้ไม่รองรับ Speech Recognition (พิมพ์ด้วยเสียง)')
      return
    }

    try {
      const recognition = new SpeechRecognition()
      recognition.lang = voiceLang
      recognition.interimResults = false
      recognition.maxAlternatives = 1

      recognition.onstart = () => {
        setIsListening(true)
      }

      recognition.onresult = (event: any) => {
        const speechResult = event.results[0][0].transcript
        if (speechResult) {
          setInput((prev) => (prev ? prev + ' ' + speechResult : speechResult))
        }
      }

      recognition.onerror = (e: any) => {
        console.error('Speech recognition error', e.error)
        setIsListening(false)
      }

      recognition.onend = () => {
        setIsListening(false)
      }

      recognitionRef.current = recognition
      recognition.start()
    } catch (err: any) {
      console.error(err)
      setIsListening(false)
    }
  }

  const [starredSnippets, setStarredSnippets] = useState<
    { id: string; title: string; content: string }[]
  >(() => {
    try {
      return JSON.parse(localStorage.getItem('koharu_starred_snippets') || '[]')
    } catch {
      return []
    }
  })

  const saveStarredSnippet = (title: string, content: string) => {
    if (!title.trim() || !content.trim()) return
    const newSnippet = { id: String(Date.now()), title, content }
    const updated = [...starredSnippets, newSnippet]
    setStarredSnippets(updated)
    localStorage.setItem('koharu_starred_snippets', JSON.stringify(updated))
  }

  const deleteStarredSnippet = (id: string) => {
    const updated = starredSnippets.filter((s) => s.id !== id)
    setStarredSnippets(updated)
    localStorage.setItem('koharu_starred_snippets', JSON.stringify(updated))
  }

  const handleTempChange = (val: number) => {
    setTemperature(val)
    localStorage.setItem('koharu_chat_temp', String(val))
  }
  const handleMaxTokensChange = (val: number) => {
    setMaxTokens(val)
    localStorage.setItem('koharu_chat_max_tokens', String(val))
  }
  const sessionTokenStats = useMemo(() => {
    const messages = history.data ?? []
    let estInputTokens = 0
    let estOutputTokens = 0

    const estimateTokens = (text: string) => {
      if (!text) return 0
      const nonAscii = (text.match(/[^\x00-\x7F]/g) || []).length
      const ascii = text.length - nonAscii
      return Math.round(ascii * 0.25 + nonAscii * 1.5)
    }

    messages.forEach((m) => {
      const text = m.content ?? ''
      const tokens = estimateTokens(text)
      if (m.role === 'user') {
        estInputTokens += tokens
      } else if (m.role === 'assistant') {
        estOutputTokens += tokens
      }
    })

    if (streamingText) {
      estOutputTokens += estimateTokens(streamingText)
    }

    // Blended API rates (approximate GPT-4o / Claude 3.5 Sonnet blends):
    // Input: $2.50 per 1M tokens ($0.0000025 per token)
    // Output: $10.00 per 1M tokens ($0.0000100 per token)
    const costUsd = estInputTokens * 0.0000025 + estOutputTokens * 0.00001

    return {
      inputTokens: estInputTokens,
      outputTokens: estOutputTokens,
      totalTokens: estInputTokens + estOutputTokens,
      costUsd: costUsd,
    }
  }, [history.data, streamingText])

  const glossaryQuery = useQuery({
    queryKey: ['project', 'glossary'],
    queryFn: () => api.glossaryList(),
    enabled: !!projectInfo,
  })

  const activeSuggestions = useMemo(() => {
    if (!input.trim() || !glossaryQuery.data) return []
    const lowerInput = input.toLowerCase()
    return glossaryQuery.data
      .filter((item) => {
        if (!item.sourceText || item.sourceText.trim().length < 2) return false
        const words = lowerInput.split(/\s+/)
        const lastWord = words[words.length - 1]
        if (lastWord.length < 2) return false
        return (
          item.sourceText.toLowerCase().startsWith(lastWord) &&
          item.sourceText.toLowerCase() !== lastWord
        )
      })
      .slice(0, 5)
  }, [input, glossaryQuery.data])

  const applyGlossarySuggestion = (item: GlossaryDto) => {
    const words = input.split(/\s+/)
    words.pop()
    words.push(`${item.sourceText} (${item.targetText})`)
    setInput(words.join(' ') + ' ')
  }

  const enhancePrompt = async () => {
    if (!input.trim() || enhancing) return
    setEnhancing(true)
    setError(null)
    try {
      const enhancePromptText = [
        'You are an expert manga translation prompt engineer.',
        'The user has written a simple instruction for translating or refining manga text.',
        'Please expand this simple instruction into a highly professional, detailed translation instruction in Thai that instructs the LLM to preserve character voice, tone, formatting, and subtext.',
        'The output must contain ONLY the expanded instruction, ready to be sent to the LLM. Do NOT include any explanations, greetings, or backticks.',
        '',
        '--- SIMPLE INSTRUCTION ---',
        input,
      ].join('\n')

      const { callCloudOnce } = await import('@/lib/services/cloudLlm')
      const enhanced = await callCloudOnce({
        prompt: enhancePromptText,
        provider,
        apiKey,
        apiUrl,
        model,
        useCase: 'enhance_prompt',
      })

      setInput(enhanced.trim())
    } catch (err: any) {
      setError(`การขยายคำสั่งล้มเหลว: ${err?.message ?? String(err)}`)
    } finally {
      setEnhancing(false)
    }
  }

  // Context-Aware Selection
  const { currentDocument } = useCurrentDocumentState()
  const selectedBlockIndex = useEditorUiStore((s) => s.selectedBlockIndex)
  const selectedBlock = useMemo(() => {
    if (selectedBlockIndex === undefined || !currentDocument?.textBlocks)
      return null
    return currentDocument.textBlocks[selectedBlockIndex] ?? null
  }, [selectedBlockIndex, currentDocument])

  const documentsVersion = useEditorUiStore((s) => s.documentsVersion)
  const [croppedContextUrl, setCroppedContextUrl] = useState<string | null>(
    null,
  )
  const [croppedContextBlob, setCroppedContextBlob] = useState<Blob | null>(
    null,
  )

  const [agenticMode, setAgenticMode] = useState<boolean>(() => {
    return localStorage.getItem('koharu_chat_agentic_mode') === 'true'
  })

  const toggleAgenticMode = () => {
    setAgenticMode((prev) => {
      const next = !prev
      localStorage.setItem('koharu_chat_agentic_mode', String(next))
      return next
    })
  }

  // Visual Context Auto-Crop Logic
  useEffect(() => {
    if (!selectedBlock || currentDocIndex === undefined) {
      setCroppedContextUrl(null)
      setCroppedContextBlob(null)
      return
    }

    const { x, y, width, height } = selectedBlock
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      typeof width !== 'number' ||
      typeof height !== 'number'
    ) {
      setCroppedContextUrl(null)
      setCroppedContextBlob(null)
      return
    }

    let active = true

    const img = new Image()
    img.crossOrigin = 'anonymous'
    const baseUrl = `/api/image/${currentDocIndex}/base?v=${documentsVersion}`
    img.src = getHttpUrl(baseUrl)

    img.onload = () => {
      if (!active) return
      try {
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')
        if (!ctx) return

        const padding = 40
        const imgW = img.naturalWidth
        const imgH = img.naturalHeight

        const cropX = Math.max(0, x - padding)
        const cropY = Math.max(0, y - padding)
        const cropW = Math.min(imgW - cropX, width + padding * 2)
        const cropH = Math.min(imgH - cropY, height + padding * 2)

        if (cropW <= 0 || cropH <= 0) return

        canvas.width = cropW
        canvas.height = cropH

        ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH)

        canvas.toBlob(
          (blob) => {
            if (!active || !blob) return
            setCroppedContextBlob(blob)
            const dataUrl = URL.createObjectURL(blob)
            setCroppedContextUrl(dataUrl)
          },
          'image/jpeg',
          0.9,
        )
      } catch (err) {
        console.error('Failed to crop block visual context', err)
      }
    }

    img.onerror = (err) => {
      console.error('Failed to load image for cropping', err)
    }

    return () => {
      active = false
      if (croppedContextUrl) {
        URL.revokeObjectURL(croppedContextUrl)
      }
    }
  }, [selectedBlock, currentDocIndex, documentsVersion])

  // Translation Memory (TM) & Fuzzy Matching
  const translationMemoryMatches = useMemo(() => {
    if (!selectedBlock || !selectedBlock.text || !currentDocument?.textBlocks) {
      return []
    }
    const matches: { text: string; translation: string; similarity: number }[] =
      []

    currentDocument.textBlocks.forEach((block, idx) => {
      if (idx === selectedBlockIndex) return
      if (!block.text || !block.translation) return

      const similarity = calculateSimilarity(
        selectedBlock.text || '',
        block.text,
      )
      if (similarity >= 0.3) {
        matches.push({
          text: block.text,
          translation: block.translation,
          similarity,
        })
      }
    })

    return matches.sort((a, b) => b.similarity - a.similarity).slice(0, 3)
  }, [selectedBlock, selectedBlockIndex, currentDocument])

  // Multi-Model Arena Compare
  const [arenaMode, setArenaMode] = useState(false)
  const [arenaActive, setArenaActive] = useState(false)
  const [arenaProfiles, setArenaProfiles] = useState<any[]>([])
  const [selectedArenaProfileIds, setSelectedArenaProfileIds] = useState<
    number[]
  >([])
  const [arenaStreams, setArenaStreams] = useState<
    Record<
      number,
      {
        text: string
        sending: boolean
        error: string | null
        profileName: string
        provider: string
        modelName: string
      }
    >
  >({})
  const arenaAbortControllersRef = useRef<Record<number, AbortController>>({})

  const activeProfileId = usePreferencesStore((s) => s.activeProfileId)

  useEffect(() => {
    if (
      profilesQuery.data &&
      profilesQuery.data.length > 0 &&
      selectedArenaProfileIds.length === 0
    ) {
      const activeId = activeProfileId || profilesQuery.data[0].id
      const others = profilesQuery.data
        .filter((p) => p.id !== activeId)
        .slice(0, 2)
        .map((p) => p.id)
      setSelectedArenaProfileIds([activeId, ...others])
    }
  }, [profilesQuery.data, activeProfileId, selectedArenaProfileIds.length])

  // Snooze config (ESET-style):
  const [snoozeType, setSnoozeType] = useState<'restart' | 'messages' | null>(
    null,
  )
  const [snoozeTargetCount, setSnoozeTargetCount] = useState<number>(0)
  const [showSnoozeMenu, setShowSnoozeMenu] = useState(false)
  const [compacting, setCompacting] = useState(false)

  // Clear memory snoozes on project change or app reload
  useEffect(() => {
    setSnoozeType(null)
  }, [projectInfo?.id])

  const currentCount = history.data?.length ?? 0
  const isSnoozed = useMemo(() => {
    if (snoozeType === 'restart') return true
    if (snoozeType === 'messages' && currentCount < snoozeTargetCount)
      return true
    return false
  }, [snoozeType, snoozeTargetCount, currentCount])

  const showWarning = currentCount >= DISPLAY_LIMIT && !isSnoozed

  const compactChat = async () => {
    if (!projectInfo || !history.data || history.data.length < 2) return
    if (provider === 'none' || !apiKey) {
      setError('กรุณาเลือกและเซ็ตอัปโปรไฟล์ Cloud LLM ก่อนทำการบีบอัดแชท')
      return
    }

    setCompacting(true)
    setError(null)

    try {
      const firstHalf = history.data.slice(0, 25).map(rowToChatMessage)
      const secondHalf = history.data.slice(25).map(rowToChatMessage)

      const conversationText = firstHalf
        .map((m) => {
          let text = `${m.role.toUpperCase()}: ${m.content}`
          if (m.toolCalls && m.toolCalls.length > 0) {
            text += `\n[called tools: ${m.toolCalls.map((c) => c.name).join(', ')}]`
          }
          return text
        })
        .join('\n\n')

      const summaryPrompt = [
        'You are an expert manga translation coordinator. You are compacting an old chat history between the user and yourself.',
        'Please summarize the core decisions, style choices, character details, and glossary terms agreed upon in the following early chat log.',
        'Keep your summary extremely concise, in a single compact paragraph (less than 150 words) in Thai.',
        'Focus ONLY on facts and agreements. Do not include introductory or conversational filler.',
        '',
        '--- EARLY CHAT LOG ---',
        conversationText,
      ].join('\n')

      const { callCloudOnce } = await import('@/lib/services/cloudLlm')
      const summaryText = await callCloudOnce({
        prompt: summaryPrompt,
        provider,
        apiKey,
        apiUrl,
        model,
        useCase: 'compact_chat',
      })

      // Reconstruct the DB!
      await api.chatMessagesClear()

      const summaryMessage = `[สรุปข้อตกลงและการคุยก่อนหน้านี้: ${summaryText.trim()}]`
      await api.chatMessageAdd({
        role: 'assistant',
        content: summaryMessage,
        model: `${provider}:${model}`,
      })

      for (const m of secondHalf) {
        await api.chatMessageAdd({
          role: m.role,
          content: m.content,
          toolCalls: m.toolCalls ? JSON.stringify(m.toolCalls) : null,
          toolCallId: m.toolCallId ?? null,
          model: m.role === 'assistant' ? `${provider}:${model}` : null,
          attachments: m.attachments ? JSON.stringify(m.attachments) : null,
        })
      }

      await history.refetch()
    } catch (err: any) {
      setError(`การบีบอัดความจำล้มเหลว: ${err?.message ?? String(err)}`)
    } finally {
      setCompacting(false)
    }
  }

  // Vision-support check for the active LLM profile. Heuristic per
  // provider — see lib/services/visionSupport.ts. Used to disable
  // attach buttons + warn before send when the model is text-only.
  const vision = useMemo(
    () => supportsVision(provider, model || ''),
    [provider, model],
  )
  const canAttach = provider !== 'none' && vision.supported

  useEffect(() => {
    // Auto-scroll to bottom on new message or streamed delta
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [history.data?.length, sending, streamingText])

  const refresh = () => void history.refetch()

  // Self-test follow-up: thin compat shim so existing setError(...)
  // call sites (attachCurrentPage, attachFromFile, clearAll,
  // deleteMessage) keep working after the chat-state refactor that
  // moved `error` into useChatActivityStore. Pre-fix the local
  // setError was removed and these sites threw ReferenceError on
  // the first attach attempt — the throw fired BEFORE the try
  // block's finally, so attaching=true stayed pinned + the spinner
  // ran forever.
  const setError = (msg: string | null) =>
    useChatActivityStore.setState({ error: msg })

  const attachCurrentPage = async () => {
    setAttaching(true)
    setError(null)
    try {
      const doc = await api.getDocument(currentDocIndex)
      const blob = new Blob([toArrayBuffer(doc.image)], { type: 'image/png' })
      const att = await blobToAttachment(blob)
      setPendingAttachments((prev) => [...prev, att])
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setAttaching(false)
    }
  }

  const attachFromFile = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setAttaching(true)
    setError(null)
    try {
      const added: ChatAttachment[] = []
      for (const f of Array.from(files)) {
        if (!f.type.startsWith('image/')) continue
        added.push(await blobToAttachment(f))
      }
      setPendingAttachments((prev) => [...prev, ...added])
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setAttaching(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const removeAttachment = (i: number) => {
    setPendingAttachments((prev) => prev.filter((_, idx) => idx !== i))
  }

  const queryClient = useQueryClient()

  const triggerChatCompletion = async (
    sendContent: string,
    turnAttachments: ChatAttachment[],
    skipPersistUser?: boolean,
  ) => {
    await startChat({
      input: sendContent,
      attachments: turnAttachments,
      provider: { provider, apiKey, apiUrl, model },
      priorMessages: history.data ?? [],
      queryClient,
      skipPersistUser,
      regeneratingUserMsgId: regeneratingUserMsgIdRef.current,
      agenticMode,
      temperature,
      maxTokens,
    })
  }

  const send = async () => {
    // Allow attachment-only turns through — image-only QA ("what does
    // this bubble say?") is a legitimate flow and the Send button
    // (see disabled prop below) already enables itself for that case.
    if ((!input.trim() && pendingAttachments.length === 0) || sending) return
    if (provider === 'none') {
      // Local pre-flight guard surface — the store also no-ops on
      // empty input, but reporting "no provider" here keeps the
      // error in the component flow (cleared on next type).
      useChatActivityStore.setState({
        error: 'Cloud LLM not selected — pick a profile from the LLM badge or Profiles tab.',
      })
      return
    }
    const isLocal =
      kindOf({ provider: provider as any, modelName: model, apiUrl }) ===
      'local'
    if (!isLocal && !apiKey) {
      const keyUrl =
        KINDS.find((k) => k.dbProvider === provider)?.keyUrl ?? 'your provider'
      useChatActivityStore.setState({
        error: `No API key for the active "${provider}" profile. Open the Profiles tab, edit the profile, paste the key from ${keyUrl}, and click Save (which also re-applies it).`,
      })
      return
    }

    // Capture input + attachments BEFORE clearing the inputs so the
    // store has them even if the user types something else mid-stream.
    const inputSnapshot = input
    const attachmentsSnapshot = pendingAttachments
    setInput('')
    setPendingAttachments([])

    // Fire-and-forget — the store owns the lifecycle.
    void startChat({
      input: inputSnapshot,
      attachments: attachmentsSnapshot,
      provider: { provider, apiKey, apiUrl, model },
      priorMessages: history.data ?? [],
      queryClient,
      agenticMode,
      temperature,
      maxTokens,
    })
  }

  const cancelArena = () => {
    Object.values(arenaAbortControllersRef.current).forEach((c) => c.abort())
    arenaAbortControllersRef.current = {}
    setArenaActive(false)
    setSending(false)
    setArenaStreams({})
    refresh()
  }

  const selectArenaResponse = async (p: any) => {
    const stream = arenaStreams[p.id]
    if (!stream || !stream.text) return

    setSending(true)
    setError(null)

    try {
      Object.entries(arenaAbortControllersRef.current).forEach(([id, c]) => {
        if (id !== p.id) c.abort()
      })
      arenaAbortControllersRef.current = {}

      await api.chatMessageAdd({
        role: 'assistant',
        content: stream.text,
        model: `${p.provider}:${p.modelName}`,
      })

      setArenaActive(false)
      setArenaStreams({})
      setArenaMode(false)
      await history.refetch()
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setSending(false)
    }
  }

  const sendArena = async () => {
    if (selectedArenaProfileIds.length === 0 || !profilesQuery.data) return

    setSending(true)
    setError(null)
    setRedoStack([])

    const slash = expandSlash(input)
    const displayContent = slash ? slash.display : input
    const sendContent = slash ? slash.prompt : input
    const turnAttachments = pendingAttachments

    try {
      await api.chatMessageAdd({
        role: 'user',
        content: displayContent,
        attachments: turnAttachments.length
          ? JSON.stringify(turnAttachments)
          : null,
      })
    } catch (err: any) {
      setError(err?.message ?? String(err))
      setSending(false)
      return
    }

    setInput('')
    setPendingAttachments([])
    await history.refetch()

    setArenaActive(true)
    const targetProfiles = profilesQuery.data.filter((p) =>
      selectedArenaProfileIds.includes(p.id),
    )
    setArenaProfiles(targetProfiles)

    const initialStreams: Record<
      number,
      {
        text: string
        sending: boolean
        error: string | null
        profileName: string
        provider: string
        modelName: string
      }
    > = {}
    targetProfiles.forEach((p) => {
      initialStreams[p.id] = {
        text: '',
        sending: true,
        error: null,
        profileName: p.name,
        provider: p.provider,
        modelName: p.modelName,
      }
    })
    setArenaStreams(initialStreams)

    let systemContent = ''
    try {
      systemContent = await buildSystemPrompt(agenticMode)
    } catch {
      systemContent = 'You are an AI assistant for manga translation.'
    }

    const priorRows = (history.data ?? [])
      .filter((r) => r.role !== 'system')
      .map(rowToChatMessage)

    if (
      priorRows.length > 0 &&
      priorRows[priorRows.length - 1].role === 'user'
    ) {
      priorRows.pop()
    }

    const ROLLING_WINDOW_LIMIT = 12
    const rollingPriorRows =
      priorRows.length > ROLLING_WINDOW_LIMIT
        ? priorRows.slice(priorRows.length - ROLLING_WINDOW_LIMIT)
        : priorRows

    const lastUser: ChatMessage = {
      role: 'user',
      content: sendContent,
      attachments: turnAttachments.length ? turnAttachments : undefined,
    }

    const allMessages: ChatMessage[] = [
      { role: 'system', content: systemContent },
      ...rollingPriorRows,
      lastUser,
    ]

    const promises = targetProfiles.map(async (p) => {
      const controller = new AbortController()
      arenaAbortControllersRef.current[p.id] = controller

      try {
        let key = ''
        if (p.provider !== 'local') {
          try {
            const secret = await api.providerProfileSecretGet(p.id)
            key = secret.apiKey ?? ''
          } catch (err: any) {
            throw new Error(
              `ไม่สามารถดึง API Key สำหรับโปรไฟล์ "${p.name}" ได้: ${err.message}`,
            )
          }
        }

        const isLocal =
          p.provider === 'local' || (p.apiUrl && p.apiUrl.includes('localhost'))
        if (!isLocal && !key) {
          throw new Error(`โปรไฟล์ "${p.name}" ยังไม่มีการเซ็ตอัป API Key`)
        }

        await runChatTurn(
          {
            provider: p.provider,
            apiKey: key,
            apiUrl:
              p.apiUrl ??
              (p.provider === 'openai' ? 'https://api.openai.com/v1' : ''),
            model: p.modelName,
            signal: controller.signal,
            temperature,
            maxTokens,
          },
          allMessages,
          async (e) => {
            if (e.kind === 'text-delta') {
              setArenaStreams((prev) => {
                const existing = prev[p.id]
                if (!existing) return prev
                return {
                  ...prev,
                  [p.id]: {
                    ...existing,
                    text: existing.text + e.delta,
                  },
                }
              })
            } else if (e.kind === 'tool-call') {
              setArenaStreams((prev) => {
                const existing = prev[p.id]
                if (!existing) return prev
                const sep = existing.text ? '\n\n' : ''
                return {
                  ...prev,
                  [p.id]: {
                    ...existing,
                    text: `${existing.text}${sep}🔧 calling ${e.call.name}…`,
                  },
                }
              })
            } else if (e.kind === 'tool-result') {
              const result = e.result as { error?: string } | unknown
              const failed =
                result &&
                typeof result === 'object' &&
                'error' in (result as any)
              setArenaStreams((prev) => {
                const existing = prev[p.id]
                if (!existing) return prev
                return {
                  ...prev,
                  [p.id]: {
                    ...existing,
                    text: existing.text + (failed ? ' ✗' : ' ✓'),
                  },
                }
              })
            }
          },
        )

        setArenaStreams((prev) => {
          const existing = prev[p.id]
          if (!existing) return prev
          return {
            ...prev,
            [p.id]: {
              ...existing,
              sending: false,
            },
          }
        })
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          setArenaStreams((prev) => {
            const existing = prev[p.id]
            if (!existing) return prev
            return {
              ...prev,
              [p.id]: {
                ...existing,
                sending: false,
                error: 'ยกเลิกการประมวลผลแล้ว',
              },
            }
          })
        } else {
          setArenaStreams((prev) => {
            const existing = prev[p.id]
            if (!existing) return prev
            return {
              ...prev,
              [p.id]: {
                ...existing,
                sending: false,
                error: err?.message ?? String(err),
              },
            }
          })
        }
      } finally {
        delete arenaAbortControllersRef.current[p.id]
      }
    })

    Promise.all(promises).finally(() => {
      setSending(false)
    })
  }

  const send = async () => {
    // Allow attachment-only turns through — image-only QA ("what does
    // this bubble say?") is a legitimate flow and the Send button
    // (see disabled prop below) enables itself for that case.
    if (
      (!input.trim() && pendingAttachments.length === 0) ||
      sending ||
      arenaActive
    )
      return

    if (arenaMode) {
      await sendArena()
      return
    }

    if (provider === 'none') {
      setError(
        'Cloud LLM not selected — pick a profile from the LLM badge or Profiles tab.',
      )
      return
    }
    // Detect "local" profiles (Ollama / LM Studio / llama.cpp etc.) by
    // their apiUrl pointing at localhost. Those servers either accept
    // any token or none at all, so the API-key gate doesn't apply.
    // Without this, picking a local profile silently blocks every send
    // because cloudApiKey is empty by convention.
    const isLocal =
      kindOf({ provider: provider as any, modelName: model, apiUrl }) ===
      'local'
    if (!isLocal && !apiKey) {
      // OpenRouter used to be allowed through without a key because the
      // model picker works key-less for browsing — but chat completion
      // always requires Authorization. Letting the request through just
      // produced a confusing 401.
      // Pull the provider's key URL from the shared KINDS metadata so we
      // don't have to keep a parallel switch statement in sync.
      const keyUrl =
        KINDS.find((k) => k.dbProvider === provider)?.keyUrl ?? 'your provider'
      setError(
        `No API key for the active "${provider}" profile. Open the Profiles tab, edit the profile, paste the key from ${keyUrl}, and click Save (which also re-applies it).`,
      )
      return
    }
    setSending(true)
    setError(null)
    setRedoStack([])

    // Slash expansion: user sees the display, LLM gets the expanded prompt
    const slash = expandSlash(input)
    const displayContent = slash ? slash.display : input
    const sendContent = slash ? slash.prompt : input
    const turnAttachments = pendingAttachments

    // Persist user message (with attachments if any)
    try {
      await api.chatMessageAdd({
        role: 'user',
        content: displayContent,
        attachments: turnAttachments.length
          ? JSON.stringify(turnAttachments)
          : null,
      })
    } catch (err: any) {
      setError(err?.message ?? String(err))
      setSending(false)
      return
    }
    setInput('')
    setPendingAttachments([])
    await history.refetch()

    await triggerChatCompletion(sendContent, turnAttachments)
  }

  const switchMessageVersion = async (
    assistantMsgId: number,
    userMsgId: number,
    targetIdx: number,
  ) => {
    if (sending || clearing || revoking || !projectInfo) return
    setSending(true)
    setError(null)
    try {
      const key = `koharu_chat_branches_${projectInfo.id}_${userMsgId}`
      const branches = JSON.parse(localStorage.getItem(key) || '[]')
      if (targetIdx < 0 || targetIdx >= branches.length) return

      const targetBranch = branches[targetIdx]
      // Delete assistant message and everything after it from the DB
      await api.chatMessagesDeleteFrom(assistantMsgId)

      // Add the chosen branch message to the SQLite DB
      await api.chatMessageAdd({
        role: 'assistant',
        content: targetBranch.content,
        toolCalls: targetBranch.toolCalls ?? null,
        toolCallId: targetBranch.toolCallId ?? null,
        model: targetBranch.model ?? null,
      })

      // Update active branch index
      localStorage.setItem(
        `koharu_chat_active_branch_${projectInfo.id}_${userMsgId}`,
        String(targetIdx),
      )
      await history.refetch()
    } catch (err: any) {
      setError(`ไม่สามารถสลับกิ่งการตอบกลับได้: ${err?.message ?? String(err)}`)
    } finally {
      setSending(false)
    }
  }

  const regenerateFromMessage = async (assistantMsg: ChatMessageDto) => {
    if (
      !projectInfo ||
      !history.data ||
      history.data.length === 0 ||
      sending ||
      clearing ||
      revoking
    )
      return

    const targetIdx = history.data.findIndex(
      (item) => item.id === assistantMsg.id,
    )
    if (targetIdx === -1) return

    // Find the nearest preceding user message
    let userMsgIdx = -1
    for (let i = targetIdx - 1; i >= 0; i--) {
      if (history.data[i].role === 'user') {
        userMsgIdx = i
        break
      }
    }
    if (userMsgIdx === -1) return
    const userMsg = history.data[userMsgIdx]

    setSending(true)
    setError(null)
    setRedoStack([])

    try {
      // 1. Load branches for this user message
      const key = `koharu_chat_branches_${projectInfo.id}_${userMsg.id}`
      const currentBranches = JSON.parse(localStorage.getItem(key) || '[]')

      // If empty, initialize branch 0 with the current assistantMsg
      if (currentBranches.length === 0) {
        currentBranches.push({
          content: assistantMsg.content,
          model: assistantMsg.model,
          toolCalls: assistantMsg.toolCalls,
          toolCallId: assistantMsg.toolCallId,
        })
      }

      // Save key branches back
      localStorage.setItem(key, JSON.stringify(currentBranches))

      // 2. Set the target index for the new branch we are about to generate
      const newBranchIdx = currentBranches.length
      localStorage.setItem(
        `koharu_chat_active_branch_${projectInfo.id}_${userMsg.id}`,
        String(newBranchIdx),
      )

      // 3. Keep track of the preceding user message id
      regeneratingUserMsgIdRef.current = userMsg.id

      // 4. Delete assistant message and everything after it
      await api.chatMessagesDeleteFrom(assistantMsg.id)
      await history.refetch()

      const parsedAttachments = parseAttachments(userMsg.attachments)
      await triggerChatCompletion(userMsg.content, parsedAttachments)
    } catch (err: any) {
      setError(err?.message ?? String(err))
      setSending(false)
      regeneratingUserMsgIdRef.current = null
    }
  }

  const retryWithProfile = async (p: any) => {
    setError(null)
    setSending(true)

    try {
      let key = ''
      if (p.provider !== 'local') {
        const secret = await api.providerProfileSecretGet(p.id)
        key = secret.apiKey ?? ''
      }

      usePreferencesStore.setState({
        activeProfileId: p.id,
        cloudProvider: p.provider,
        cloudApiKey: key,
        cloudApiUrl:
          p.apiUrl ??
          (p.provider === 'openai' ? 'https://api.openai.com/v1' : ''),
        cloudModelName: p.modelName,
      })

      if (!history.data || history.data.length === 0) {
        setSending(false)
        return
      }

      const lastUser = [...history.data]
        .reverse()
        .find((m) => m.role === 'user')
      if (!lastUser) {
        setSending(false)
        return
      }

      const parsedAttachments = parseAttachments(lastUser.attachments)
      await triggerChatCompletion(lastUser.content, parsedAttachments)
    } catch (err: any) {
      setError(err?.message ?? String(err))
      setSending(false)
    }
  }

  const stop = () => {
    stopChat()
  }

  const [clearing, setClearing] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [redoStack, setRedoStack] = useState<ChatMessageDto[][]>([])

  const revokeFromMessage = async (m: ChatMessageDto) => {
    if (
      !projectInfo ||
      !history.data ||
      history.data.length === 0 ||
      revoking ||
      sending
    )
      return
    const targetIdx = history.data.findIndex((item) => item.id === m.id)
    if (targetIdx === -1) return
    const deletedMessages = history.data.slice(targetIdx)
    const targetUserMessage = history.data[targetIdx]
    setRevoking(true)
    setError(null)
    try {
      // ใช้ Batch Delete จาก Backend โตตรงแบบ O(1) รวดเร็วและเก็บรักษา timestamps ดั้งเดิมของข้อความ
      await api.chatMessagesDeleteFrom(m.id)
      setRedoStack((prev) => [...prev, deletedMessages])
      setInput(targetUserMessage.content)
      await history.refetch()
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setRevoking(false)
    }
  }

  const revokeLastTurn = async () => {
    if (
      !projectInfo ||
      !history.data ||
      history.data.length === 0 ||
      revoking ||
      sending
    )
      return
    const lastUserIdx = [...history.data]
      .reverse()
      .findIndex((m) => m.role === 'user')
    if (lastUserIdx === -1) return
    const actualUserIdx = history.data.length - 1 - lastUserIdx
    await revokeFromMessage(history.data[actualUserIdx])
  }

  const redoLastTurn = async () => {
    if (!projectInfo || redoStack.length === 0 || revoking || sending) return
    const nextChunk = redoStack[redoStack.length - 1]
    setRevoking(true)
    setError(null)
    try {
      for (const msg of nextChunk) {
        await api.chatMessageAdd({
          role: msg.role as any,
          content: msg.content,
          toolCalls: msg.toolCalls,
          toolCallId: msg.toolCallId,
          model: msg.model,
          attachments: msg.attachments,
        })
      }
      setRedoStack((prev) => prev.slice(0, -1))
      setInput('')
      await history.refetch()
    } catch (err: any) {
      setError(`ไม่สามารถกู้คืนข้อความได้: ${err?.message ?? String(err)}`)
    } finally {
      setRevoking(false)
    }
  }

  const exportChatHistory = () => {
    if (!history.data || history.data.length === 0) return

    const uiLang = uiLanguageName()
    const project = projectInfo ? projectInfo.name : 'Unknown Project'

    let md = `# Koharu Chat Session Export\n\n`
    md += `* **Project**: ${project}\n`
    md += `* **Export Date**: ${new Date().toLocaleString()}\n`
    md += `* **UI Language**: ${uiLang}\n`
    md += `* **Active Model**: ${provider}:${model}\n`
    md += `* **Session Cost Estimate**: $${sessionTokenStats.costUsd.toFixed(5)} (${sessionTokenStats.totalTokens} tokens)\n\n`
    md += `---\n\n`

    const sorted = [...history.data].reverse()
    sorted.forEach((m) => {
      const roleStr = m.role.toUpperCase()
      const timestampStr = m.createdAt
        ? new Date(m.createdAt).toLocaleString()
        : ''
      const attachments = parseAttachments(m.attachments)

      md += `### 👤 **${roleStr}** *${timestampStr}*\n`
      if (m.model) {
        md += `*Model used: ${m.model}*\n`
      }
      md += `\n${m.content ?? ''}\n\n`

      if (attachments && attachments.length > 0) {
        md += `**Attachments (${attachments.length}):**\n`
        attachments.forEach((a, index) => {
          md += `- Attachment ${index + 1}: [Image URL (${a.width}x${a.height})](${a.dataUrl.slice(0, 100)}...)\n`
        })
        md += `\n`
      }

      if (m.toolCalls) {
        let calls = []
        try {
          calls = JSON.parse(m.toolCalls)
        } catch {}
        if (calls.length > 0) {
          md += `**Tool Calls:**\n`
          calls.forEach((c: any) => {
            md += `- \`${c.name}\` with arguments \`${JSON.stringify(c.args)}\`\n`
          })
          md += `\n`
        }
      }

      md += `---\n\n`
    })

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.setAttribute('href', url)
    link.setAttribute(
      'download',
      `koharu_chat_${projectInfo?.id ?? 'session'}_${Date.now()}.md`,
    )
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  const clearAll = async () => {
    if (clearing) return
    if (
      !confirm(
        'ต้องการล้างประวัติแชททั้งหมดของโปรเจกต์นี้หรือไม่? (ข้อมูลทั้งหมดจะถูกลบถาวร)',
      )
    )
      return
    setClearing(true)
    try {
      await api.chatMessagesClear()
      setSnoozeType(null)
      setSnoozeTargetCount(0)
      setError(null)
      setRedoStack([])
      await history.refetch()
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setClearing(false)
    }
  }

  // Per-message delete (#24). Confirm before destructive; refetch on
  // success. Errors surface in the same inline banner as send / clear.
  const deleteMessage = async (id: number) => {
    if (!confirm('Delete this message from chat history?')) return
    try {
      await api.chatMessageDelete(id)
      await history.refetch()
    } catch (err: any) {
      setError(err?.message ?? String(err))
    }
  }

  return (
    <div className='flex h-full min-h-0 flex-1 flex-col'>
      <div className='border-border flex items-center justify-between border-b px-2 py-1.5'>
        <span className='text-muted-foreground flex items-center gap-1.5 text-[10px] font-bold tracking-wide uppercase'>
          AI Chat ({history.data?.length ?? 0})
          {isSnoozed && (
            <button
              onClick={() => {
                setSnoozeType(null)
              }}
              title='การแจ้งเตือนความจำไหลผ่านเริ่มจำศีลอยู่ (คลิกเพื่อกู้คืนการแจ้งเตือนกลับมาปกติ)'
              className='bg-muted text-muted-foreground/60 border-border inline-flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-semibold transition hover:bg-amber-500/10 hover:text-amber-600 dark:hover:text-amber-400'
            >
              <BellOffIcon className='size-2.5' />
              ปิดเตือนอยู่
            </button>
          )}
        </span>
        <div className='flex items-center gap-1'>
          <Button
            variant='ghost'
            size='sm'
            className='flex h-6 items-center gap-1 px-2 text-[10px] disabled:opacity-40'
            title='ดึงคืนข้อความล่าสุดและคำตอบของ AI กลับมาแก้ไขใหม่'
            disabled={!history.data?.length || sending || clearing || revoking}
            onClick={() => void revokeLastTurn()}
          >
            {revoking ? (
              <Loader2Icon className='size-3 animate-spin' />
            ) : (
              <Undo2Icon className='size-3' />
            )}
            ดึงคืน
          </Button>
          <Button
            variant='ghost'
            size='sm'
            className='flex h-6 items-center gap-1 px-2 text-[10px] disabled:opacity-40'
            title='ทำซ้ำข้อความที่ดึงคืนล่าสุด'
            disabled={!redoStack.length || sending || clearing || revoking}
            onClick={() => void redoLastTurn()}
          >
            {revoking ? (
              <Loader2Icon className='size-3 animate-spin' />
            ) : (
              <Redo2Icon className='size-3' />
            )}
            ทำซ้ำ
          </Button>
          <Button
            variant='ghost'
            size='sm'
            className='hover:text-primary flex h-6 items-center gap-1 px-2 text-[10px] transition-colors duration-150 disabled:opacity-40'
            title='ส่งออกประวัติการแชทเป็นไฟล์ Markdown'
            disabled={!history.data?.length || sending}
            onClick={exportChatHistory}
          >
            <DownloadIcon className='size-3' />
            ส่งออก
          </Button>
          <Button
            variant='ghost'
            size='sm'
            className='flex h-6 items-center gap-1 px-2 text-[10px] disabled:opacity-40'
            title='ล้างประวัติแชททั้งหมดสำหรับโปรเจกต์นี้'
            disabled={!history.data?.length || sending || clearing}
            onClick={() => void clearAll()}
          >
            {clearing ? (
              <Loader2Icon className='size-3 animate-spin' />
            ) : (
              <Trash2Icon className='size-3' />
            )}
            ล้างประวัติ
          </Button>
        </div>
      </div>

      {/* Provider status */}
      <div className='border-border text-muted-foreground flex items-center gap-2 border-b px-2 py-1 text-[10px]'>
        {provider === 'none' ? (
          <span className='flex items-center gap-1 text-amber-600 dark:text-amber-400'>
            <TriangleAlertIcon className='size-3' />
            No cloud profile active — pick one via LLM badge
          </span>
        ) : (
          <span className='min-w-0 flex-1 truncate'>
            via{' '}
            <span className='text-foreground font-semibold'>{provider}</span> ·{' '}
            {model || '(no model)'}
          </span>
        )}
        {provider !== 'none' && (
          <span
            className={
              'shrink-0 rounded px-1 py-0.5 font-semibold ' +
              (vision.supported
                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                : 'bg-muted text-muted-foreground/70')
            }
            title={vision.reason}
          >
            {vision.supported ? '👁 vision' : 'text only'}
          </span>
        )}
      </div>

      {/* Warn if attachments queued but active model is text-only */}
      {!vision.supported && pendingAttachments.length > 0 && (
        <div className='border-b border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-700 dark:text-amber-400'>
          {t(
            'chat.textOnlyWarning',
            '⚠ {{count}} image attachment(s) queued but the active model is text-only — switch profile to a vision-capable model (e.g. gpt-4o, claude-haiku, gemini-1.5+) or remove the attachments before sending.',
            { count: pendingAttachments.length },
          )}
        </div>
      )}

      {/* Messages Wrapper for Floating Overlays */}
      <div className='relative flex min-h-0 min-w-0 flex-1 flex-col'>
        <ScrollArea className='flex-1' viewportRef={scrollRef}>
          <div className='w-full min-w-0 space-y-2 p-2 pb-24'>
            {!history.data?.length ? (
              <EmptyState />
            ) : (
              history.data.map((m, idx) => {
                let precedingUserMsgId: number | undefined
                if (m.role === 'assistant' && history.data) {
                  for (let i = idx - 1; i >= 0; i--) {
                    if (history.data[i].role === 'user') {
                      precedingUserMsgId = history.data[i].id
                      break
                    }
                  }
                }
                return (
                  <MessageRow
                    key={m.id}
                    message={m}
                    projectId={projectInfo?.id}
                    precedingUserMsgId={precedingUserMsgId}
                    glossaryList={glossaryQuery.data ?? []}
                    selectedTranslation={
                      selectedBlock?.translation ?? undefined
                    }
                    onDelete={() => void deleteMessage(m.id)}
                    onUndoFromHere={() => void revokeFromMessage(m)}
                    onRegenerate={
                      m.role === 'assistant'
                        ? () => void regenerateFromMessage(m)
                        : undefined
                    }
                    onSwitchBranch={(newIdx) => {
                      if (precedingUserMsgId !== undefined) {
                        void switchMessageVersion(
                          m.id,
                          precedingUserMsgId,
                          newIdx,
                        )
                      }
                    }}
                  />
                )
              })
            )}
            {sending && !arenaActive && (
              <StreamingBubble streamingText={streamingText} onStop={stop} />
            )}
            {arenaActive && (
              <div className='mt-4 space-y-3 border-t border-dashed border-amber-500/20 pt-4'>
                <div className='flex items-center justify-between px-1'>
                  <div className='flex items-center gap-1.5 text-[10px] font-bold tracking-wider text-amber-600 uppercase dark:text-amber-400'>
                    <ZapIcon className='size-3.5 animate-pulse text-amber-500' />
                    โหมดประชันค่ายกำลังประมวลผล...
                  </div>
                  <Button
                    variant='destructive'
                    size='sm'
                    onClick={cancelArena}
                    className='h-6 px-2 text-[9px]'
                  >
                    ยกเลิกทั้งหมด (Cancel)
                  </Button>
                </div>
                <div className='grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3'>
                  {arenaProfiles.map((p) => {
                    const stream = arenaStreams[p.id]
                    if (!stream) return null
                    return (
                      <div
                        key={p.id}
                        className={`bg-card flex flex-col overflow-hidden rounded-lg border text-xs shadow-sm transition-all duration-300 ${
                          stream.sending
                            ? 'border-amber-500/50 bg-amber-500/[0.01] shadow-md shadow-amber-500/5'
                            : stream.error
                              ? 'border-destructive/40 bg-destructive/[0.01]'
                              : 'border-emerald-500/40 bg-emerald-500/[0.01]'
                        }`}
                      >
                        <div
                          className={`flex items-center justify-between border-b px-2.5 py-1.5 text-[10px] font-semibold ${
                            stream.sending
                              ? 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                              : stream.error
                                ? 'bg-destructive/10 text-destructive border-destructive/20'
                                : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                          }`}
                        >
                          <div className='flex max-w-[70%] items-center gap-1 truncate'>
                            <BotIcon className='size-3 shrink-0' />
                            <span className='truncate'>{p.name}</span>
                          </div>
                          <div className='flex shrink-0 items-center gap-1'>
                            {stream.sending ? (
                              <Loader2Icon className='size-2.5 animate-spin' />
                            ) : stream.error ? (
                              <TriangleAlertIcon className='size-2.5' />
                            ) : (
                              <CheckIcon className='size-2.5' />
                            )}
                            <span className='max-w-[60px] truncate font-mono text-[8px] tracking-tighter'>
                              {p.modelName}
                            </span>
                          </div>
                        </div>

                        <div className='max-h-72 flex-1 overflow-y-auto p-2.5 select-text'>
                          {stream.error ? (
                            <div className='text-destructive font-sans text-[10px] leading-relaxed font-medium'>
                              เกิดข้อผิดพลาด: {stream.error}
                            </div>
                          ) : stream.text ? (
                            <div className='min-w-0 font-sans text-[11px] leading-relaxed break-words whitespace-pre-wrap select-text'>
                              <ChatMarkdown>{stream.text}</ChatMarkdown>
                            </div>
                          ) : (
                            <div className='text-muted-foreground flex animate-pulse items-center gap-1 font-sans text-[10px] italic'>
                              กำลังรอการตอบกลับ...
                            </div>
                          )}
                        </div>

                        {!stream.sending && !stream.error && stream.text && (
                          <div className='bg-muted/30 border-border flex items-center justify-between gap-1 border-t p-2'>
                            <Button
                              onClick={() => void selectArenaResponse(p)}
                              className='h-6 w-full bg-emerald-600 px-2 text-[10px] font-medium text-white shadow-sm transition hover:bg-emerald-700'
                            >
                              เลือกคำตอบนี้ (Keep)
                            </Button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            {error && (
              <div className='border-destructive/30 text-destructive bg-destructive/5 space-y-1.5 rounded-md border p-2 text-[10px]'>
                <div className='flex items-center gap-1.5 font-semibold'>
                  <TriangleAlertIcon className='size-3 shrink-0' />
                  ข้อผิดพลาด: {error}
                </div>
                {profilesQuery.data && profilesQuery.data.length > 1 && (
                  <div className='border-destructive/20 space-y-1 border-t pt-1.5'>
                    <div className='text-muted-foreground text-[9px] font-medium'>
                      สลับโปรไฟล์ลองอีกครั้ง (Retry with another profile):
                    </div>
                    <div className='flex flex-wrap gap-1'>
                      {profilesQuery.data
                        .filter(
                          (p) =>
                            p.id !==
                            usePreferencesStore.getState().activeProfileId,
                        )
                        .map((p) => (
                          <Button
                            key={p.id}
                            variant='outline'
                            size='sm'
                            className='border-destructive/20 hover:bg-destructive/10 text-muted-foreground hover:text-foreground h-5 px-1.5 text-[9px]'
                            onClick={() => void retryWithProfile(p)}
                          >
                            {p.name}
                          </Button>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </ScrollArea>

        {/* ESET-style Compact Memory Warning Floating Card */}
        {showWarning && (
          <div className='bg-background/95 animate-in fade-in slide-in-from-bottom-2 absolute right-2 bottom-2 left-2 z-40 flex flex-col gap-1.5 rounded-lg border border-amber-500/30 p-2.5 text-xs text-amber-900 shadow-lg backdrop-blur-sm duration-200 dark:text-amber-300'>
            <div className='flex items-center justify-between font-semibold'>
              <span className='flex items-center gap-1.5'>
                <TriangleAlertIcon className='size-3 shrink-0 text-amber-600 dark:text-amber-400' />
                ความทรงจำของ AI เริ่มจะไม่แน่นอนแล้ว
              </span>
              <button
                onClick={() => setSnoozeType('restart')}
                className='cursor-pointer text-[10px] opacity-50 transition hover:opacity-100'
                title='ปิดชั่วคราวจนกว่าจะรีสตาร์ท'
              >
                ✕
              </button>
            </div>
            <p className='text-muted-foreground text-[10px] leading-relaxed'>
              ความจำช่วงเริ่มต้นกำลังจะเลือนหายเนื่องจากประวัติแชทเริ่มยาวเกินกำหนด
              แนะนำให้บีบอัดแชทเพื่อรักษาบริบทสำคัญไว้
            </p>
            <div className='relative mt-1 flex items-center gap-2'>
              <Button
                variant='outline'
                size='sm'
                disabled={compacting || sending}
                onClick={compactChat}
                className='flex h-6 items-center border-amber-500/30 bg-amber-500/10 px-2.5 text-[10px] text-amber-800 hover:bg-amber-500/20 dark:text-amber-300'
              >
                {compacting ? (
                  <>
                    <Loader2Icon className='mr-1 size-3 animate-spin' />
                    กำลังบีบอัด...
                  </>
                ) : (
                  <>
                    <ZapIcon className='mr-1 size-2.5 text-amber-600 dark:text-amber-400' />
                    บีบอัดแชทตอนนี้
                  </>
                )}
              </Button>
              <div className='relative'>
                <Button
                  variant='ghost'
                  size='sm'
                  disabled={compacting || sending}
                  onClick={() => setShowSnoozeMenu(!showSnoozeMenu)}
                  className='text-muted-foreground hover:bg-muted h-6 px-2 text-[10px]'
                >
                  ปิดเตือนชั่วคราว ▾
                </Button>
                {showSnoozeMenu && (
                  <div className='border-border bg-popover text-popover-foreground absolute bottom-full left-0 z-50 mb-1 w-60 rounded-md border p-1 font-sans text-[10px] shadow-lg'>
                    <button
                      onClick={() => {
                        setSnoozeType('messages')
                        setSnoozeTargetCount(currentCount + 50)
                        setShowSnoozeMenu(false)
                      }}
                      className='hover:bg-accent hover:text-accent-foreground w-full cursor-pointer rounded-sm px-2 py-1.5 text-left transition'
                    >
                      ปิดเตือนถัดไปอีก 50 ข้อความ
                    </button>
                    <button
                      onClick={() => {
                        setSnoozeType('restart')
                        setShowSnoozeMenu(false)
                      }}
                      className='hover:bg-accent hover:text-accent-foreground w-full cursor-pointer rounded-sm px-2 py-1.5 text-left transition'
                    >
                      ปิดเตือนจนกว่าจะเปิดโปรแกรมใหม่
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className='border-border relative shrink-0 border-t p-2'>
        {showSlash && slashMatches.length > 0 && (
          <SlashPicker
            items={slashMatches}
            selectedIndex={Math.min(slashIndex, slashMatches.length - 1)}
            onPick={completeSlash}
            onClose={() => setShowSlash(false)}
          />
        )}

        {/* Selected Block Context Panel */}
        {selectedBlock && (
          <div className='bg-muted/65 border-border animate-in fade-in slide-in-from-bottom-2 mb-2 flex flex-col gap-1.5 rounded-lg border p-2 text-xs shadow-sm backdrop-blur-sm'>
            <div className='flex items-center justify-between'>
              <span className='text-muted-foreground flex items-center gap-1 text-[10px] font-bold tracking-wider uppercase'>
                <ScanLineIcon className='text-primary size-3' />
                กรอบข้อความที่เลือก (Selected Block)
              </span>
              <Button
                variant='ghost'
                size='icon-xs'
                className='h-4 w-4 opacity-60 hover:opacity-100'
                onClick={() => {
                  useEditorUiStore.getState().setSelectedBlockIndex(undefined)
                }}
                title='ปิด (Close)'
              >
                <XIcon className='size-3' />
              </Button>
            </div>
            <div className='flex items-center gap-2 rounded bg-black/5 p-1.5 dark:bg-white/5'>
              {/* Cropped Context Thumbnail Preview */}
              {croppedContextUrl && (
                <div className='group/thumb border-border/80 bg-background/50 relative h-14 w-14 shrink-0 overflow-hidden rounded border shadow-sm'>
                  <img
                    src={croppedContextUrl}
                    alt='Crop Context'
                    className='h-full w-full object-cover transition-transform duration-200 group-hover/thumb:scale-105'
                  />
                  <div className='absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity duration-150 group-hover/thumb:opacity-100'>
                    <button
                      type='button'
                      onClick={async (e) => {
                        e.stopPropagation()
                        if (!croppedContextBlob) return
                        try {
                          const att = await blobToAttachment(croppedContextBlob)
                          setPendingAttachments((prev) => [...prev, att])
                        } catch (err: any) {
                          setError(
                            `แนบภาพไม่สำเร็จ: ${err?.message ?? String(err)}`,
                          )
                        }
                      }}
                      className='bg-primary text-primary-foreground rounded px-1 py-0.5 text-[8px] font-bold transition-transform duration-100 hover:scale-105 active:scale-95'
                    >
                      แนบภาพ (Attach)
                    </button>
                  </div>
                </div>
              )}

              <div className='flex min-w-0 flex-1 flex-col gap-1'>
                {selectedBlock.text && (
                  <div className='flex min-w-0 items-start gap-1'>
                    <span className='bg-primary/10 text-primary border-primary/20 shrink-0 rounded border px-1 text-[8px] font-semibold uppercase'>
                      JP
                    </span>
                    <p className='flex-1 truncate text-[10px] italic select-text'>
                      {selectedBlock.text}
                    </p>
                  </div>
                )}
                {selectedBlock.translation && (
                  <div className='flex min-w-0 items-start gap-1'>
                    <span className='shrink-0 rounded border border-emerald-500/20 bg-emerald-500/10 px-1 text-[8px] font-semibold text-emerald-600 uppercase dark:text-emerald-400'>
                      TH
                    </span>
                    <p className='flex-1 truncate text-[10px] font-medium select-text'>
                      {selectedBlock.translation}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Translation Memory (TM) Matches */}
            {translationMemoryMatches.length > 0 && (
              <div className='border-border/40 mt-1.5 space-y-1 border-t pt-1.5'>
                <span className='text-muted-foreground flex items-center gap-1 text-[9px] font-bold tracking-wider uppercase'>
                  <BookOpenIcon className='size-2.5 animate-pulse text-amber-500' />
                  ความจำคำแปลคล้ายกัน (Translation Memory)
                </span>
                <div className='max-h-24 space-y-1 overflow-y-auto pr-0.5'>
                  {translationMemoryMatches.map((m, idx) => (
                    <div
                      key={idx}
                      className='bg-primary/5 hover:bg-primary/10 border-border/40 flex items-center justify-between gap-2 rounded border p-1 transition duration-150'
                    >
                      <div className='min-w-0 flex-1 space-y-0.5'>
                        <p className='text-muted-foreground truncate text-[9px] italic'>
                          {m.text}
                        </p>
                        <p className='text-foreground truncate text-[10px] font-medium'>
                          {m.translation}
                        </p>
                      </div>
                      <div className='flex shrink-0 items-center gap-1.5'>
                        <span className='py-0.2 rounded border border-amber-500/20 bg-amber-500/10 px-1 font-mono text-[8px] font-bold text-amber-600 dark:text-amber-400'>
                          {Math.round(m.similarity * 100)}%
                        </span>
                        <Button
                          variant='outline'
                          size='xs'
                          onClick={() => {
                            setInput(
                              (prev) =>
                                prev + (prev ? ' ' : '') + m.translation,
                            )
                          }}
                          className='bg-background border-border/60 h-4.5 px-1 text-[8px] font-semibold shadow-sm'
                        >
                          ดึงคำแปล (Use)
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className='flex gap-1'>
              {selectedBlock.text && (
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() =>
                    setInput(
                      (prev) => prev + (prev ? ' ' : '') + selectedBlock.text,
                    )
                  }
                  className='h-5.5 px-2 text-[9px]'
                >
                  วางข้อความดิบ
                </Button>
              )}
              {selectedBlock.translation && (
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() =>
                    setInput(
                      (prev) =>
                        prev + (prev ? ' ' : '') + selectedBlock.translation,
                    )
                  }
                  className='h-5.5 px-2 text-[9px]'
                >
                  วางคำแปล
                </Button>
              )}
              <Button
                variant='outline'
                size='sm'
                onClick={async () => {
                  const queryText = `ช่วยอธิบายความหมายและเกลาประโยคของข้อความนี้ที:\nต้นฉบับญี่ปุ่น: "${selectedBlock.text ?? ''}"\nคำแปลปัจจุบัน: "${selectedBlock.translation ?? ''}"`
                  setInput('')
                  setSending(true)
                  setError(null)
                  setRedoStack([])
                  try {
                    await api.chatMessageAdd({
                      role: 'user',
                      content: `ขอคำแปล/เกลาคำ สำหรับกรอบข้อความที่เลือก`,
                    })
                    await history.refetch()
                    await triggerChatCompletion(queryText, [])
                  } catch (err: any) {
                    setError(err?.message ?? String(err))
                    setSending(false)
                  }
                }}
                className='bg-primary/5 border-primary/20 text-primary hover:bg-primary/10 h-5.5 px-2 text-[9px]'
              >
                <SparklesIcon className='mr-0.5 size-2.5' />
                ขอเกลาแปล (Ask AI)
              </Button>
            </div>
          </div>
        )}

        {/* Arena Mode Setup Profile Selector */}
        {arenaMode && !arenaActive && profilesQuery.data && (
          <div className='border-border/60 animate-in fade-in slide-in-from-bottom-1 mb-2 rounded-lg border bg-amber-500/5 p-2 text-[10px] shadow-sm duration-200'>
            <div className='mb-1 flex items-center justify-between font-semibold text-amber-600 dark:text-amber-400'>
              <span className='flex items-center gap-1'>
                <ZapIcon className='size-3 text-amber-500' />
                เลือกโปรไฟล์ประชันค่าย (เลือกได้สูงสุด 3 ค่าย)
              </span>
              <span className='text-muted-foreground text-[9px] font-normal'>
                * จะทำการส่งแบบขนานไปยังทุกโมเดลที่เลือก
              </span>
            </div>
            <div className='mt-1 flex flex-wrap gap-1.5'>
              {profilesQuery.data.map((p) => {
                const isSelected = selectedArenaProfileIds.includes(p.id)
                return (
                  <button
                    key={p.id}
                    onClick={() => {
                      setSelectedArenaProfileIds((prev) => {
                        if (isSelected) {
                          if (prev.length <= 1) return prev
                          return prev.filter((id) => id !== p.id)
                        } else {
                          if (prev.length >= 3) return prev
                          return [...prev, p.id]
                        }
                      })
                    }}
                    className={`flex h-5.5 items-center gap-1 rounded border px-2 py-0.5 font-medium transition ${
                      isSelected
                        ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                        : 'bg-muted/40 text-muted-foreground border-border/40 hover:bg-muted/70'
                    }`}
                  >
                    {isSelected && <CheckIcon className='size-2.5' />}
                    {p.name}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Pending attachments row */}
        {pendingAttachments.length > 0 && (
          <div className='mb-1.5 flex flex-wrap gap-1.5'>
            {pendingAttachments.map((a, i) => (
              <div
                key={i}
                className='border-border bg-card relative h-14 w-14 overflow-hidden rounded border'
              >
                <img
                  src={a.dataUrl}
                  alt={`attachment ${i + 1}`}
                  className='h-full w-full object-cover'
                />
                <button
                  onClick={() => removeAttachment(i)}
                  className='absolute top-0.5 right-0.5 rounded-full bg-black/70 p-0.5 text-white hover:bg-black'
                  title='Remove'
                >
                  <XIcon className='size-2.5' />
                </button>
                <div className='absolute right-0 bottom-0 left-0 bg-black/50 px-1 py-0.5 text-center text-[8px] text-white'>
                  {a.width}×{a.height}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Glossary live suggestions */}
        {activeSuggestions.length > 0 && (
          <div className='animate-in fade-in slide-in-from-bottom-1 mb-1.5 flex flex-wrap gap-1 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-1.5 text-[9px] duration-150'>
            <span className='mr-1 flex items-center gap-1 py-0.5 font-semibold text-emerald-600 dark:text-emerald-400'>
              <BookOpenIcon className='size-2.5' />
              แนะนำคำศัพท์:
            </span>
            {activeSuggestions.map((item) => (
              <button
                key={item.id}
                type='button'
                onClick={() => applyGlossarySuggestion(item)}
                className='flex items-center gap-1 rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 font-medium text-emerald-700 transition hover:bg-emerald-500/25 dark:text-emerald-400'
                title={`คลิกเพื่อเติม: ${item.sourceText} → ${item.targetText}`}
              >
                <span>{item.sourceText}</span>
                <span className='opacity-60'>→</span>
                <span>{item.targetText}</span>
              </button>
            ))}
          </div>
        )}
        <Textarea
          value={input}
          onChange={(e) => {
            const v = e.target.value
            setInput(v)
            // Show the picker only while the user is typing the
            // command name itself — i.e. starts with `/` and has
            // no whitespace yet. As soon as a space appears the
            // user has committed the command and any following
            // text is argument input, so the picker hides. Pre-
            // fix the picker reappeared every keystroke after the
            // space because the predicate only checked
            // `startsWith('/')` — even "/translate-page extra"
            // would re-open it.
            const stillTypingCommand =
              v.startsWith('/') && !v.includes('\n') && !v.includes(' ')
            setShowSlash(stillTypingCommand)
            // Reset the highlight to the top as the query changes.
            setSlashIndex(0)
          }}
          onKeyDown={(e) => {
            // Slash picker is open with matches → arrow keys navigate,
            // Tab/Enter complete the highlighted command, Esc closes —
            // matching Claude Code's CLI. These intercept before the
            // normal Enter-to-send below.
            if (showSlash && slashMatches.length > 0) {
              const len = slashMatches.length
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSlashIndex((i) => (i + 1) % len)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSlashIndex((i) => (i - 1 + len) % len)
                return
              }
              if (e.key === 'Tab') {
                e.preventDefault()
                const idx = Math.min(slashIndex, len - 1)
                completeSlash(slashMatches[idx].name)
                return
              }
              // Enter while the picker is open does NOT send — guards
              // against accidentally firing a half-typed command. Press
              // Tab to complete first; once the picker closes, Enter
              // sends as usual.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setShowSlash(false)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              setShowSlash(false)
              void send()
            }
            if (e.key === 'Escape') setShowSlash(false)
          }}
          placeholder='Ask the assistant…  / for slash commands · Shift+Enter for newline'
          style={{ fieldSizing: 'fixed' as any, width: '100%' }}
          className='block min-h-14 w-full resize-none text-xs'
          disabled={sending}
        />
        <div className='mt-1 flex items-center justify-between gap-1'>
          <div className='flex items-center gap-1'>
            <Button
              variant='ghost'
              size='icon-xs'
              className='size-6'
              disabled={attaching || currentDocIndex < 0 || !canAttach}
              onClick={() => void attachCurrentPage()}
              title={
                !canAttach
                  ? `Image attach disabled — ${vision.reason}`
                  : 'Attach the current canvas page (downsized to ≤1024px JPEG)'
              }
            >
              {attaching ? (
                <Loader2Icon className='size-3 animate-spin' />
              ) : (
                <ScanLineIcon className='size-3' />
              )}
            </Button>
            <Button
              variant='ghost'
              size='icon-xs'
              className='size-6'
              disabled={attaching || !canAttach}
              onClick={() => fileInputRef.current?.click()}
              title={
                !canAttach
                  ? `Image attach disabled — ${vision.reason}`
                  : 'Upload image file from disk'
              }
            >
              <ImagePlusIcon className='size-3' />
            </Button>
            <input
              ref={fileInputRef}
              type='file'
              accept='image/*'
              multiple
              hidden
              onChange={(e) => void attachFromFile(e.target.files)}
            />

            {/* Multi-Step Agentic Translation Chain (Stepped CoT) Button */}
            <Button
              variant='ghost'
              size='icon-xs'
              className={`relative size-6 transition-all duration-300 ${
                agenticMode
                  ? 'bg-purple-500/10 text-purple-500 shadow-[0_0_8px_rgba(168,85,247,0.25)] hover:bg-purple-500/20 hover:text-purple-600'
                  : 'hover:bg-accent text-primary'
              }`}
              onClick={toggleAgenticMode}
              title='โหมดเกลาขั้นบันได (Agentic Chain: แปลตรงตัว -> วิเคราะห์บริบท -> เกลาภาษา)'
            >
              {agenticMode ? (
                <>
                  <span className='absolute inset-0 animate-pulse rounded-full bg-purple-500/20' />
                  <SparklesIcon className='relative z-10 size-3 animate-spin [animation-duration:8s]' />
                </>
              ) : (
                <SparklesIcon className='size-3 text-purple-500' />
              )}
            </Button>

            {/* Voice Dictation Microphone Button */}
            <Button
              variant='ghost'
              size='icon-xs'
              className={`relative size-6 transition-all duration-300 ${
                isListening
                  ? 'bg-red-500/10 text-red-500 hover:bg-red-500/20 hover:text-red-600'
                  : 'hover:bg-accent text-primary'
              }`}
              onClick={toggleListening}
              title='พิมพ์ด้วยเสียงภาษาไทย (Voice Dictation)'
            >
              {isListening ? (
                <>
                  <span className='absolute inset-0 animate-ping rounded-full bg-red-500/30' />
                  <MicOffIcon className='relative z-10 size-3' />
                </>
              ) : (
                <MicIcon className='size-3 text-red-500' />
              )}
            </Button>

            {/* Starred Prompts Popover */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant='ghost'
                  size='icon-xs'
                  className='hover:bg-accent hover:text-accent-foreground text-primary size-6'
                  title='คลังคำสั่งโปรด (Starred Prompts)'
                >
                  <StarIcon className='size-3 fill-amber-500/30 text-amber-500' />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align='start'
                side='top'
                className='bg-background/95 border-border/80 z-[100] w-64 rounded-lg p-2.5 font-sans text-xs shadow-lg backdrop-blur-md'
              >
                <div className='border-border/60 mb-2 flex items-center justify-between border-b px-1 pb-1'>
                  <span className='text-foreground flex items-center gap-1 text-[10px] font-bold tracking-wider uppercase'>
                    <StarIcon className='size-2.5 text-amber-500' />
                    คลังคำสั่งโปรด
                  </span>
                </div>
                <div className='max-h-64 space-y-3 overflow-auto'>
                  {/* Save active input as snippet */}
                  <div className='bg-primary/5 border-primary/10 space-y-1.5 rounded-md border p-1.5'>
                    <div className='text-muted-foreground text-[8px] font-bold tracking-wider uppercase'>
                      บันทึกข้อความปัจจุบัน
                    </div>
                    <div className='flex gap-1'>
                      <input
                        id='starred-title-input'
                        placeholder='ชื่อคำสั่ง (เช่น แปลเสียงลุย)'
                        className='bg-background border-border min-w-0 flex-1 rounded border px-1.5 py-0.5 text-[10px]'
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const inputEl = e.currentTarget
                            if (inputEl.value.trim() && input.trim()) {
                              saveStarredSnippet(inputEl.value, input)
                              inputEl.value = ''
                            }
                          }
                        }}
                      />
                      <Button
                        size='sm'
                        className='h-5 px-1.5 text-[8px] font-bold'
                        onClick={() => {
                          const inputEl = document.getElementById(
                            'starred-title-input',
                          ) as HTMLInputElement
                          if (inputEl && inputEl.value.trim() && input.trim()) {
                            saveStarredSnippet(inputEl.value, input)
                            inputEl.value = ''
                          }
                        }}
                      >
                        บันทึก
                      </Button>
                    </div>
                  </div>

                  {/* Starred list */}
                  <div className='space-y-1'>
                    <div className='text-muted-foreground px-1 text-[8px] font-bold tracking-wider uppercase'>
                      คำสั่งส่วนตัว ({starredSnippets.length})
                    </div>
                    {starredSnippets.length === 0 ? (
                      <div className='text-muted-foreground px-1.5 py-1 text-[10px] italic'>
                        ยังไม่มีคำสั่งที่บันทึกไว้
                      </div>
                    ) : (
                      starredSnippets.map((s) => (
                        <div
                          key={s.id}
                          className='hover:bg-accent hover:border-border group flex items-start justify-between gap-1.5 rounded-md border border-transparent p-1.5 transition-colors duration-150'
                        >
                          <button
                            onClick={() => setInput(s.content)}
                            className='flex-1 truncate text-left text-[10px] leading-tight font-medium'
                            title={s.content}
                          >
                            {s.title}
                          </button>
                          <button
                            onClick={() => deleteStarredSnippet(s.id)}
                            className='text-muted-foreground hover:text-destructive opacity-0 transition-opacity group-hover:opacity-100'
                            title='Delete'
                          >
                            <XIcon className='size-3' />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </PopoverContent>
            </Popover>

            {/* Quick Prompts Popover */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant='ghost'
                  size='icon-xs'
                  className='hover:bg-accent hover:text-accent-foreground text-primary size-6'
                  title='เทมเพลตคำสั่งด่วน (Quick Prompts)'
                >
                  <SparklesIcon className='size-3 animate-pulse text-amber-500' />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align='start'
                side='top'
                className='bg-background/95 border-border/80 z-[100] w-64 rounded-lg p-2 shadow-lg backdrop-blur-md'
              >
                <div className='border-border/60 mb-1.5 border-b px-1 pb-1'>
                  <span className='text-foreground flex items-center gap-1 text-[10px] font-bold tracking-wider uppercase'>
                    <SparklesIcon className='size-2.5 text-amber-500' />
                    เทมเพลตคำสั่งด่วน
                  </span>
                </div>
                <div className='max-h-60 space-y-2 overflow-auto font-sans text-xs'>
                  {/* Tones */}
                  <div>
                    <div className='text-muted-foreground mb-1 px-1 text-[9px] font-semibold tracking-wider uppercase'>
                      🎭 ปรับโทนเสียง (Tone)
                    </div>
                    <div className='grid grid-cols-1 gap-1'>
                      {[
                        {
                          label: 'เป็นกันเองวัยรุ่น 🧑‍🎤',
                          prompt:
                            'ปรับคำแปลนี้ให้ใช้โทนเสียงเป็นกันเอง สไตล์วัยรุ่นพูดคุยกัน: ',
                        },
                        {
                          label: 'ทางการสุภาพ 🤵',
                          prompt:
                            'ปรับคำแปลนี้ให้ใช้โทนเสียงสุภาพ เป็นทางการ และเป็นผู้ใหญ่ขึ้น: ',
                        },
                        {
                          label: 'กวนๆ สไตล์ตัวร้าย 😈',
                          prompt:
                            'ปรับคำแปลนี้ให้เป็นโทนเสียงกวนๆ เจ้าเล่ห์ สมกับเป็นสไตล์ตัวร้ายในมังงะ: ',
                        },
                      ].map((t) => (
                        <button
                          key={t.label}
                          onClick={() => {
                            setInput(
                              (prev) => prev + (prev ? ' ' : '') + t.prompt,
                            )
                          }}
                          className='hover:bg-accent w-full rounded px-1.5 py-1 text-left text-[10px] transition'
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* Refine */}
                  <div>
                    <div className='text-muted-foreground mb-1 px-1 text-[9px] font-semibold tracking-wider uppercase'>
                      🪄 เกลาภาษา (Refine)
                    </div>
                    <div className='grid grid-cols-1 gap-1'>
                      {[
                        {
                          label: 'เกลาให้อ่านลื่นสไตล์ไทย 🍃',
                          prompt:
                            'ช่วยเกลาคำแปลนี้ให้ลื่นไหล เป็นธรรมชาติ สมบูรณ์แบบตามสำนวนภาษาไทยดั้งเดิม: ',
                        },
                        {
                          label: 'ทำให้กระชับเข้ากรอบ 📦',
                          prompt:
                            'คำแปลนี้ยาวเกินไปสำหรับกรอบข้อความมังงะ ช่วยย่อและเกลาให้กระชับแต่ความหมายยังครบถ้วนที: ',
                        },
                      ].map((t) => (
                        <button
                          key={t.label}
                          onClick={() => {
                            setInput(
                              (prev) => prev + (prev ? ' ' : '') + t.prompt,
                            )
                          }}
                          className='hover:bg-accent w-full rounded px-1.5 py-1 text-left text-[10px] transition'
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* Context */}
                  <div>
                    <div className='text-muted-foreground mb-1 px-1 text-[9px] font-semibold tracking-wider uppercase'>
                      📖 ตรวจสอบบริบท (Context)
                    </div>
                    <div className='grid grid-cols-1 gap-1'>
                      {[
                        {
                          label: 'ตรวจสอบมุกตลก/วัฒนธรรม 🏮',
                          prompt:
                            'ช่วยวิเคราะห์วัฒนธรรม ธรรมเนียม หรือมุกตลกญี่ปุ่นในประโยคนี้ และแนะแนวทางแปลให้คนไทยเข้าใจที: ',
                        },
                        {
                          label: 'วิเคราะห์ความหมายแฝง 🔍',
                          prompt:
                            'ประโยคนี้มีความหมายแฝง คติพจน์ หรือคำสแลงญี่ปุ่นอะไรที่ซ่อนอยู่ไหม? อธิบายที: ',
                        },
                      ].map((t) => (
                        <button
                          key={t.label}
                          onClick={() => {
                            setInput(
                              (prev) => prev + (prev ? ' ' : '') + t.prompt,
                            )
                          }}
                          className='hover:bg-accent w-full rounded px-1.5 py-1 text-left text-[10px] transition'
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </PopoverContent>
            </Popover>

            {/* Creative Parameter Tuning Popover */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant='ghost'
                  size='icon-xs'
                  className='hover:bg-accent hover:text-accent-foreground text-primary size-6'
                  title='ปรับแต่งค่าโมเดล (LLM Parameters)'
                >
                  <SlidersIcon className='size-3 text-sky-500' />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align='start'
                side='top'
                className='bg-background/95 border-border/80 z-[100] w-64 rounded-lg p-3 shadow-lg backdrop-blur-md'
              >
                <div className='border-border/60 mb-2 border-b px-1 pb-1'>
                  <span className='text-foreground flex items-center gap-1 text-[10px] font-bold tracking-wider uppercase'>
                    <SlidersIcon className='size-2.5 text-sky-500' />
                    ปรับแต่งโมเดล (Creative Tuning)
                  </span>
                </div>
                <div className='space-y-4 font-sans text-xs'>
                  {/* Temperature Slider */}
                  <div className='space-y-1.5'>
                    <div className='flex items-center justify-between'>
                      <span className='text-muted-foreground text-[10px] font-medium'>
                        อุณหภูมิสร้างสรรค์ (Temperature)
                      </span>
                      <span className='rounded bg-sky-500/10 px-1 font-mono text-[10px] font-semibold text-sky-600 dark:text-sky-400'>
                        {temperature.toFixed(1)}
                      </span>
                    </div>
                    <input
                      type='range'
                      min='0.0'
                      max='2.0'
                      step='0.1'
                      value={temperature}
                      onChange={(e) =>
                        handleTempChange(parseFloat(e.target.value))
                      }
                      className='bg-muted h-1 w-full cursor-pointer appearance-none rounded-lg accent-sky-500'
                    />
                    <div className='text-muted-foreground flex justify-between text-[8px]'>
                      <span>0.0 (คงเส้นคงวา)</span>
                      <span>2.0 (สร้างสรรค์สูงสุด)</span>
                    </div>
                  </div>

                  {/* Max Tokens Slider */}
                  <div className='space-y-1.5'>
                    <div className='flex items-center justify-between'>
                      <span className='text-muted-foreground text-[10px] font-medium'>
                        ความยาวสูงสุด (Max Tokens)
                      </span>
                      <span className='rounded bg-sky-500/10 px-1 font-mono text-[10px] font-semibold text-sky-600 dark:text-sky-400'>
                        {maxTokens}
                      </span>
                    </div>
                    <input
                      type='range'
                      min='256'
                      max='4096'
                      step='128'
                      value={maxTokens}
                      onChange={(e) =>
                        handleMaxTokensChange(parseInt(e.target.value, 10))
                      }
                      className='bg-muted h-1 w-full cursor-pointer appearance-none rounded-lg accent-sky-500'
                    />
                    <div className='text-muted-foreground flex justify-between text-[8px]'>
                      <span>256</span>
                      <span>4096</span>
                    </div>
                  </div>

                  {/* Token Tracker & Cost Estimator */}
                  <div className='animate-in fade-in space-y-2 border-t border-sky-500/10 pt-3 duration-200'>
                    <div className='flex items-center gap-1 text-[10px] font-bold tracking-wider text-sky-600 uppercase dark:text-sky-400'>
                      <CoinsIcon className='size-3 text-sky-500' />
                      ประเมินปริมาณ Token & ค่าบริการสะสม
                    </div>
                    <div className='text-muted-foreground space-y-1 rounded-lg border border-sky-500/10 bg-sky-500/5 p-2 text-[9px] dark:bg-sky-500/[0.02]'>
                      <div className='flex justify-between'>
                        <span>Tokens ขาเข้า (Input):</span>
                        <span className='text-foreground font-mono font-semibold'>
                          {sessionTokenStats.inputTokens.toLocaleString()}
                        </span>
                      </div>
                      <div className='flex justify-between'>
                        <span>Tokens ขาออก (Output):</span>
                        <span className='text-foreground font-mono font-semibold'>
                          {sessionTokenStats.outputTokens.toLocaleString()}
                        </span>
                      </div>
                      <div className='text-foreground my-1 flex justify-between border-t border-sky-500/10 pt-1 text-[10px] font-bold'>
                        <span>รวมทั้งสิ้น (Total):</span>
                        <span className='font-mono'>
                          {sessionTokenStats.totalTokens.toLocaleString()}
                        </span>
                      </div>
                      <div className='flex justify-between text-[10px] font-bold text-amber-600 dark:text-amber-400'>
                        <span>ค่าบริการประเมิน (USD):</span>
                        <span className='font-mono'>
                          ${sessionTokenStats.costUsd.toFixed(5)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </PopoverContent>
            </Popover>

            {/* SFX Helper Popover */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant='ghost'
                  size='icon-xs'
                  className='hover:bg-accent hover:text-accent-foreground text-primary size-6'
                  title='พจนานุกรมเสียงเอฟเฟกต์มังงะ (Manga SFX)'
                >
                  <BookOpenIcon className='size-3 text-emerald-500' />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align='start'
                side='top'
                className='bg-background/95 border-border/80 z-[100] w-80 rounded-lg p-2.5 shadow-lg backdrop-blur-md'
              >
                <div className='border-border/60 mb-1.5 flex items-center justify-between border-b px-1 pb-1'>
                  <span className='text-foreground flex items-center gap-1 text-[10px] font-bold tracking-wider uppercase'>
                    <BookOpenIcon className='size-3 text-emerald-500' />
                    คลังคำศัพท์เสียงมังงะ (SFX Dictionary)
                  </span>
                </div>
                <div className='max-h-72 space-y-3 overflow-auto font-sans text-xs'>
                  {/* Category: Action */}
                  <div>
                    <div className='text-muted-foreground mb-1 px-1 text-[9px] font-semibold tracking-wider uppercase'>
                      💥 แอ็กชัน & การเคลื่อนไหว (Action)
                    </div>
                    <div className='grid grid-cols-2 gap-1'>
                      {[
                        {
                          sfx: 'ゴゴゴ',
                          romaji: 'Gogogo',
                          desc: 'บรรยากาศกดดัน/คุกคาม',
                        },
                        {
                          sfx: 'ドドド',
                          romaji: 'Dododo',
                          desc: 'เสียงฝีเท้ารัว/วิ่งตะลุย',
                        },
                        {
                          sfx: 'バキッ',
                          romaji: 'Baki',
                          desc: 'เสียงหัก/กระแทกแรง',
                        },
                        {
                          sfx: 'シュッ',
                          romaji: 'Shu',
                          desc: 'เคลื่อนไหวเร็ว/ฟุ่บ',
                        },
                      ].map((x) => (
                        <button
                          key={x.sfx}
                          onClick={() => {
                            const query = `ช่วยอธิบายเสียงเอฟเฟกต์ญี่ปุ่น "${x.sfx}" (${x.romaji}) ในมังงะ ซึ่งมักจะสื่อถึง "${x.desc}" และช่วยแนะนำคำแปลภาษาไทยหรือคำบรรยายที่เข้ากันกับบริบทให้หน่อยที`
                            setInput((prev) => prev + (prev ? ' ' : '') + query)
                          }}
                          className='hover:bg-accent border-border/40 flex w-full flex-col items-start rounded border p-1 text-left transition'
                        >
                          <span className='text-primary text-[10px] font-bold'>
                            {x.sfx} ({x.romaji})
                          </span>
                          <span className='text-muted-foreground w-full truncate text-[8px]'>
                            {x.desc}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* Category: Emotion */}
                  <div>
                    <div className='text-muted-foreground mb-1 px-1 text-[9px] font-semibold tracking-wider uppercase'>
                      💖 อารมณ์ & ความรู้สึก (Emotion)
                    </div>
                    <div className='grid grid-cols-2 gap-1'>
                      {[
                        {
                          sfx: 'ニコニコ',
                          romaji: 'Nikoniko',
                          desc: 'ยิ้มแย้มมีความสุข',
                        },
                        {
                          sfx: 'ドキドキ',
                          romaji: 'Dokidoki',
                          desc: 'ใจเต้นตึกตัก (ตื่นเต้น)',
                        },
                        {
                          sfx: 'イライラ',
                          romaji: 'Iraira',
                          desc: 'หงุดหงิด/โมโห',
                        },
                        {
                          sfx: 'เดเระเดเระ',
                          romaji: 'Deredere',
                          desc: 'เขินอาย/หลงเสน่ห์',
                        },
                      ].map((x) => (
                        <button
                          key={x.sfx}
                          onClick={() => {
                            const query = `ช่วยอธิบายเสียงเอฟเฟกต์ญี่ปุ่น "${x.sfx}" (${x.romaji}) ในมังงะ ซึ่งมักจะสื่อถึง "${x.desc}" และช่วยแนะนำคำแปลภาษาไทยหรือคำบรรยายที่เข้ากันกับบริบทให้หน่อยที`
                            setInput((prev) => prev + (prev ? ' ' : '') + query)
                          }}
                          className='hover:bg-accent border-border/40 flex w-full flex-col items-start rounded border p-1 text-left transition'
                        >
                          <span className='text-[10px] font-bold text-emerald-600 dark:text-emerald-400'>
                            {x.sfx} ({x.romaji})
                          </span>
                          <span className='text-muted-foreground w-full truncate text-[8px]'>
                            {x.desc}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* Category: Nature */}
                  <div>
                    <div className='text-muted-foreground mb-1 px-1 text-[9px] font-semibold tracking-wider uppercase'>
                      🍃 ธรรมชาติ & สิ่งแวดล้อม (Nature)
                    </div>
                    <div className='grid grid-cols-2 gap-1'>
                      {[
                        {
                          sfx: 'ざわざわ',
                          romaji: 'Zawazawa',
                          desc: 'เสียงซุบซิบ/บรรยากาศไม่ดี',
                        },
                        {
                          sfx: 'しーん',
                          romaji: 'Shiin',
                          desc: 'ความเงียบสงัด/เดดแอร์',
                        },
                        {
                          sfx: 'ザーザー',
                          romaji: 'Zaazaa',
                          desc: 'ฝนตกหนัก/ซู่ๆ',
                        },
                        {
                          sfx: 'パチパチ',
                          romaji: 'Pachipachi',
                          desc: 'เสียงไฟเปรี๊ยะ/ปรบมือ',
                        },
                      ].map((x) => (
                        <button
                          key={x.sfx}
                          onClick={() => {
                            const query = `ช่วยอธิบายเสียงเอฟเฟกต์ญี่ปุ่น "${x.sfx}" (${x.romaji}) ในมังงะ ซึ่งมักจะสื่อถึง "${x.desc}" และช่วยแนะนำคำแปลภาษาไทยหรือคำบรรยายที่เข้ากันกับบริบทให้หน่อยที`
                            setInput((prev) => prev + (prev ? ' ' : '') + query)
                          }}
                          className='hover:bg-accent border-border/40 flex w-full flex-col items-start rounded border p-1 text-left transition'
                        >
                          <span className='text-[10px] font-bold text-amber-600 dark:text-amber-400'>
                            {x.sfx} ({x.romaji})
                          </span>
                          <span className='text-muted-foreground w-full truncate text-[8px]'>
                            {x.desc}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </div>
          <div className='flex min-w-0 flex-1 items-center justify-between truncate'>
            <span className='text-muted-foreground mr-2 hidden truncate text-[10px] sm:inline'>
              {input.startsWith('/') ? (
                <>type to filter commands · ↵ to send</>
              ) : (
                <>↵ send · Shift+↵ newline</>
              )}
            </span>
            <div className='mr-2 flex shrink-0 items-center gap-1.5'>
              <button
                onClick={() => {
                  if (
                    !arenaMode &&
                    profilesQuery.data &&
                    profilesQuery.data.length < 2
                  ) {
                    setError(
                      'ต้องมีโปรไฟล์ LLM อย่างน้อย 2 โปรไฟล์ขึ้นไปเพื่อใช้งานโหมดประชันค่าย',
                    )
                    return
                  }
                  setArenaMode(!arenaMode)
                }}
                className={`flex h-5.5 items-center gap-1 rounded-full border px-2 text-[9px] font-semibold transition ${
                  arenaMode
                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-500'
                    : 'bg-muted text-muted-foreground border-border/40 hover:bg-muted/80'
                }`}
                title='เปรียบเทียบคำตอบจากหลายโปรไฟล์โมเดลพร้อมกันแบบเคียงข้างกัน'
              >
                <ZapIcon className='size-2.5 animate-pulse' />
                {arenaMode ? 'ประชันค่ายเปิด' : 'ประชันค่าย (Arena)'}
              </button>
            </div>
          </div>
          {input.trim() && (
            <Button
              size='sm'
              variant='outline'
              className='h-6 shrink-0 gap-1 border-amber-500/25 bg-amber-500/10 px-2 text-[10px] text-amber-600 hover:bg-amber-500/20 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300'
              disabled={enhancing || sending}
              onClick={enhancePrompt}
              title='ขยายคำสั่งด้วย AI (Enhance Prompt with AI)'
            >
              {enhancing ? (
                <Loader2Icon className='size-3 animate-spin' />
              ) : (
                <SparklesIcon className='size-3 animate-pulse text-amber-500' />
              )}
              ขยายคำสั่ง
            </Button>
          )}
          <Button
            size='sm'
            className='h-6 shrink-0 px-2 text-[10px]'
            disabled={
              (!input.trim() && pendingAttachments.length === 0) ||
              sending ||
              arenaActive
            }
            onClick={() => void send()}
          >
            {sending ? (
              <Loader2Icon className='size-3 animate-spin' />
            ) : (
              <SendIcon className='size-3' />
            )}
            Send
          </Button>
        </div>
      </div>
    </div>
  )
}

function EmptyState() {
  const { t } = useTranslation()
  return (
    <div className='border-border rounded-md border border-dashed p-3 text-center text-xs'>
      <BotIcon className='text-muted-foreground/40 mx-auto mb-2 size-6' />
      <p className='text-muted-foreground mb-2'>
        {t(
          'chat.emptyPrompt',
          'Ask anything about translation — the AI sees your project context and can call tools to update glossary, characters, and series metadata.',
        )}
      </p>
      <p
        className='text-muted-foreground/70 text-[10px]'
        // Slash-command suggestions are formatted with inline <code/>; use
        // the i18n value as raw HTML to preserve the styling without
        // forcing translators to compose JSX.
        dangerouslySetInnerHTML={{
          __html: t(
            'chat.emptySlashHint',
            'Try <code class="bg-muted rounded px-1">/fetch-wiki &lt;url&gt;</code> or <code class="bg-muted rounded px-1">/draft-synopsis</code>',
          ),
        }}
      />
    </div>
  )
}

/**
 * Memoised streaming-assistant bubble. Re-renders only when the
 * `streamingText` actually changes (which it does once per token);
 * crucially the surrounding `MessageRow` list re-renders for each
 * token in the previous (non-memoised) layout because the parent's
 * `streamingText` state was a sibling. Extracting + memoising means
 * the markdown parse only runs for THIS bubble, not for every message
 * in the chat history on each delta.
 */
const StreamingBubble = memo(function StreamingBubble({
  streamingText,
  onStop,
}: {
  streamingText: string
  onStop: () => void
}) {
  const steps = parseAgenticChain(streamingText)
  const [activeTab, setActiveTab] = useState<
    'step1' | 'step2' | 'step3' | null
  >(null)

  const latestStep = steps.step3 ? 'step3' : steps.step2 ? 'step2' : 'step1'
  const currentTab = activeTab ?? latestStep

  return (
    <div className='border-border bg-card rounded-md border p-2 text-xs'>
      <div className='text-muted-foreground mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase'>
        <BotIcon className='size-3' />
        assistant {steps.isAgentic && '(โหมดเกลาขั้นบันได)'}
        <Loader2Icon className='ml-auto size-3 animate-spin' />
      </div>

      {steps.isAgentic ? (
        <div className='mt-1.5 space-y-2'>
          {/* Gorgeous glassmorphic tab selector */}
          <div className='border-border/40 grid grid-cols-3 gap-1 rounded-md border bg-black/5 p-1 dark:bg-white/5'>
            <button
              type='button'
              onClick={() => setActiveTab('step1')}
              className={`flex items-center justify-center gap-1 rounded py-1 text-[9px] font-medium transition duration-150 ${
                currentTab === 'step1'
                  ? 'bg-background text-foreground border-border/40 border font-semibold shadow-sm'
                  : 'text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5'
              }`}
            >
              <span>1️⃣ แปลตรงตัว</span>
              {latestStep === 'step1' && (
                <span className='size-1.5 animate-pulse rounded-full bg-purple-500' />
              )}
            </button>
            <button
              type='button'
              onClick={() => setActiveTab('step2')}
              className={`flex items-center justify-center gap-1 rounded py-1 text-[9px] font-medium transition duration-150 ${
                currentTab === 'step2'
                  ? 'bg-background text-foreground border-border/40 border font-semibold shadow-sm'
                  : 'text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5'
              }`}
            >
              <span>2️⃣ บริบทมังงะ</span>
              {latestStep === 'step2' && (
                <span className='size-1.5 animate-pulse rounded-full bg-purple-500' />
              )}
            </button>
            <button
              type='button'
              onClick={() => setActiveTab('step3')}
              className={`flex items-center justify-center gap-1 rounded py-1 text-[9px] font-medium transition duration-150 ${
                currentTab === 'step3'
                  ? 'bg-background text-foreground border-border/40 border font-semibold shadow-sm'
                  : 'text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5'
              }`}
            >
              <span>3️⃣ เกลาเกรด A</span>
              {latestStep === 'step3' && (
                <span className='size-1.5 animate-pulse rounded-full bg-purple-500' />
              )}
            </button>
          </div>

          {/* Stepped content container */}
          <div className='bg-muted/20 border-border/30 relative min-w-0 rounded-md border p-2'>
            {currentTab === 'step1' && (
              <div className='animate-in fade-in duration-150'>
                <div className='mb-1 text-[8px] font-semibold tracking-wider text-purple-600 uppercase dark:text-purple-400'>
                  Step 1: แปลตรงตัวอักษร
                </div>
                {steps.step1 ? (
                  <ChatMarkdown>{steps.step1}</ChatMarkdown>
                ) : (
                  <p className='text-muted-foreground text-[9px] italic'>
                    กำลังแปลตรงตัวอักษร...
                  </p>
                )}
              </div>
            )}
            {currentTab === 'step2' && (
              <div className='animate-in fade-in duration-150'>
                <div className='mb-1 text-[8px] font-semibold tracking-wider text-purple-600 uppercase dark:text-purple-400'>
                  Step 2: วิเคราะห์บริบทมังงะและวัฒนธรรม
                </div>
                {steps.step2 ? (
                  <ChatMarkdown>{steps.step2}</ChatMarkdown>
                ) : (
                  <p className='text-muted-foreground text-[9px] italic'>
                    กำลังวิเคราะห์อารมณ์และบริบทตัวละคร...
                  </p>
                )}
              </div>
            )}
            {currentTab === 'step3' && (
              <div className='animate-in fade-in duration-150'>
                <div className='mb-1 text-[8px] font-semibold tracking-wider text-purple-600 uppercase dark:text-purple-400'>
                  Step 3: ผลลัพธ์เกลาภาษาขั้นสมบูรณ์
                </div>
                {steps.step3 ? (
                  <ChatMarkdown>{steps.step3}</ChatMarkdown>
                ) : (
                  <p className='text-muted-foreground text-[9px] italic'>
                    กำลังเกลาประโยคขั้นสุดท้าย...
                  </p>
                )}
              </div>
            )}
            <span className='ml-0.5 inline-block h-3 w-1 animate-pulse bg-purple-500 align-middle' />
          </div>
        </div>
      ) : (
        <div className='min-w-0'>
          <ChatMarkdown>{streamingText}</ChatMarkdown>
          <span className='ml-0.5 inline-block h-3 w-1 animate-pulse bg-current align-middle' />
        </div>
      )}

      <button
        onClick={onStop}
        className='text-muted-foreground hover:text-destructive mt-2 text-[10px] underline'
      >
        Stop
      </button>
    </div>
  )
})

function MessageRow({
  message: m,
  onDelete,
  onUndoFromHere,
  onRegenerate,
  projectId,
  precedingUserMsgId,
  glossaryList,
  onSwitchBranch,
  selectedTranslation,
}: {
  message: ChatMessageDto
  onDelete: () => void
  onUndoFromHere?: () => void
  onRegenerate?: () => void
  projectId?: string
  precedingUserMsgId?: number
  glossaryList?: GlossaryDto[]
  onSwitchBranch?: (newIdx: number) => void
  selectedTranslation?: string
}) {
  const steps = useMemo(() => parseAgenticChain(m.content ?? ''), [m.content])
  const [activeStepTab, setActiveStepTab] = useState<
    'step1' | 'step2' | 'step3'
  >('step3')
  const [copied, setCopied] = useState(false)
  const [showDiff, setShowDiff] = useState(false)

  const handleCopy = async () => {
    if (!m.content) return
    try {
      const copyText = steps.isAgentic ? steps.step3 : m.content
      await navigator.clipboard.writeText(copyText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.warn('Failed to copy text', err)
    }
  }

  const branches = useMemo(() => {
    if (!projectId || !precedingUserMsgId) return []
    const key = `koharu_chat_branches_${projectId}_${precedingUserMsgId}`
    try {
      return JSON.parse(localStorage.getItem(key) || '[]')
    } catch {
      return []
    }
  }, [projectId, precedingUserMsgId])

  const activeBranchIndex = useMemo(() => {
    if (!projectId || !precedingUserMsgId) return 0
    const key = `koharu_chat_active_branch_${projectId}_${precedingUserMsgId}`
    try {
      const saved = localStorage.getItem(key)
      return saved !== null ? parseInt(saved, 10) : 0
    } catch {
      return 0
    }
  }, [projectId, precedingUserMsgId])

  const matchedGlossary = useMemo(() => {
    if (m.role !== 'assistant' || !m.content || !glossaryList) return []
    const contentLower = m.content.toLowerCase()
    return glossaryList.filter((item) => {
      if (!item.sourceText || item.sourceText.trim().length < 2) return false
      return contentLower.includes(item.sourceText.toLowerCase())
    })
  }, [m.role, m.content, glossaryList])

  if (m.role === 'tool') {
    return (
      <ToolResultRow
        message={m}
        onDelete={onDelete}
        onUndoFromHere={onUndoFromHere}
      />
    )
  }
  const isUser = m.role === 'user'
  const attachments = parseAttachments(m.attachments)
  return (
    <div
      className={
        'group relative rounded-md border p-2 text-xs ' +
        (isUser ? 'border-primary/30 bg-primary/5' : 'border-border bg-card')
      }
    >
      <div className='text-muted-foreground mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase'>
        {isUser ? (
          <UserIcon className='size-3' />
        ) : (
          <BotIcon className='size-3' />
        )}
        <span>{m.role}</span>

        {!isUser && branches.length > 1 && (
          <div className='bg-primary/5 border-primary/20 text-muted-foreground/80 hover:text-foreground animate-in fade-in zoom-in-95 ml-2 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-bold shadow-sm transition duration-155 select-none'>
            <button
              type='button'
              onClick={() => onSwitchBranch?.(activeBranchIndex - 1)}
              disabled={activeBranchIndex === 0}
              className='disabled:hover:text-muted-foreground px-0.5 transition-colors hover:text-amber-500 disabled:opacity-30'
              title='ย้อนกลับไปคำตอบก่อนหน้า'
            >
              &lt;
            </button>
            <span className='px-0.5 font-mono'>
              {activeBranchIndex + 1} / {branches.length}
            </span>
            <button
              type='button'
              onClick={() => onSwitchBranch?.(activeBranchIndex + 1)}
              disabled={activeBranchIndex === branches.length - 1}
              className='disabled:hover:text-muted-foreground px-0.5 transition-colors hover:text-amber-500 disabled:opacity-30'
              title='สลับไปคำตอบถัดไป'
            >
              &gt;
            </button>
          </div>
        )}

        {/* Actions container pushed to the right */}
        <div className='ml-auto flex items-center gap-1.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100'>
          {/* Copy button */}
          {m.content && (
            <button
              type='button'
              onClick={handleCopy}
              title='คัดลอกข้อความ (Copy)'
              className='text-muted-foreground hover:text-foreground transition'
            >
              {copied ? (
                <CheckIcon className='size-3 text-emerald-500 dark:text-emerald-400' />
              ) : (
                <CopyIcon className='size-3' />
              )}
            </button>
          )}

          {/* Diff Toggle button */}
          {!isUser && selectedTranslation && m.content && (
            <button
              type='button'
              onClick={() => setShowDiff(!showDiff)}
              title='เปรียบเทียบการเกลาแปลกับข้อความเดิมบนแคนวาส (Compare with original)'
              className={`text-muted-foreground transition hover:text-amber-500 ${
                showDiff ? 'rounded bg-amber-500/10 px-0.5 text-amber-500' : ''
              }`}
            >
              <FileDiffIcon className='size-3' />
            </button>
          )}

          {/* Regenerate button (only for assistant messages) */}
          {!isUser && onRegenerate && (
            <button
              type='button'
              onClick={onRegenerate}
              title='สร้างคำตอบใหม่ (Regenerate)'
              className='text-muted-foreground transition hover:text-amber-500'
            >
              <RefreshCwIcon className='size-3' />
            </button>
          )}

          {/* Undo from here button */}
          {onUndoFromHere && (
            <button
              type='button'
              onClick={onUndoFromHere}
              aria-label='Undo from this message'
              title='ลบประวัติตั้งแต่ข้อความนี้ย้อนหลัง (Undo from here)'
              className='text-muted-foreground transition hover:text-amber-500'
            >
              <Undo2Icon className='size-3' />
            </button>
          )}

          {/* Delete button */}
          <button
            type='button'
            onClick={onDelete}
            aria-label='Delete this message'
            title='Delete this message'
            className='text-muted-foreground hover:text-destructive transition'
          >
            <XIcon className='size-3' />
          </button>
        </div>
      </div>
      {/* Don't render an "(empty)" placeholder when the assistant
       *  turn has tool_calls — Claude / Gemini often dispatch a tool
       *  without preamble text, and showing "(empty)" makes it look
       *  like a failure. The tool badge below already tells the user
       *  what's happening. (Dropped the `toolCalls === 'null'`
       *  literal-string branch — `rowToChatMessage` parses the JSON
       *  via try/catch and would leave `toolCalls` as `undefined` on
       *  the string "null", never produce the literal string itself.) */}
      {(m.content || !m.toolCalls) && (
        <div className='min-w-0'>
          {m.content ? (
            isUser ? (
              <div className='text-xs leading-relaxed break-words whitespace-pre-wrap select-text'>
                {m.content}
              </div>
            ) : (
              <>
                {steps.isAgentic ? (
                  <div className='my-1.5 space-y-2 border-l-2 border-purple-500/30 py-0.5 pl-2'>
                    {/* Gorgeous glassmorphic tab selector */}
                    <div className='border-border/40 grid grid-cols-3 gap-1 rounded-md border bg-black/5 p-1 dark:bg-white/5'>
                      <button
                        type='button'
                        onClick={() => setActiveStepTab('step1')}
                        className={`flex items-center justify-center gap-1 rounded py-1 text-[9px] font-medium transition duration-150 ${
                          activeStepTab === 'step1'
                            ? 'bg-background text-foreground border-border/40 border font-semibold shadow-sm'
                            : 'text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5'
                        }`}
                      >
                        <span>1️⃣ แปลตรงตัว</span>
                      </button>
                      <button
                        type='button'
                        onClick={() => setActiveStepTab('step2')}
                        className={`flex items-center justify-center gap-1 rounded py-1 text-[9px] font-medium transition duration-150 ${
                          activeStepTab === 'step2'
                            ? 'bg-background text-foreground border-border/40 border font-semibold shadow-sm'
                            : 'text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5'
                        }`}
                      >
                        <span>2️⃣ บริบทมังงะ</span>
                      </button>
                      <button
                        type='button'
                        onClick={() => setActiveStepTab('step3')}
                        className={`flex items-center justify-center gap-1 rounded py-1 text-[9px] font-medium transition duration-150 ${
                          activeStepTab === 'step3'
                            ? 'bg-background text-foreground border-border/40 border font-semibold shadow-sm'
                            : 'text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5'
                        }`}
                      >
                        <span>3️⃣ เกลาเกรด A</span>
                      </button>
                    </div>

                    {/* Stepped content container */}
                    <div className='bg-muted/10 border-border/20 min-w-0 rounded-md border p-2'>
                      {activeStepTab === 'step1' && (
                        <div className='animate-in fade-in duration-150'>
                          <div className='mb-1 text-[8px] font-semibold tracking-wider text-purple-600 uppercase dark:text-purple-400'>
                            Step 1: แปลตรงตัวอักษร
                          </div>
                          {steps.step1 ? (
                            <ChatMarkdown>{steps.step1}</ChatMarkdown>
                          ) : (
                            <p className='text-muted-foreground text-[9px] italic'>
                              ไม่มีข้อมูลการแปลตรงตัว
                            </p>
                          )}
                        </div>
                      )}
                      {activeStepTab === 'step2' && (
                        <div className='animate-in fade-in duration-150'>
                          <div className='mb-1 text-[8px] font-semibold tracking-wider text-purple-600 uppercase dark:text-purple-400'>
                            Step 2: วิเคราะห์บริบทมังงะและวัฒนธรรม
                          </div>
                          {steps.step2 ? (
                            <ChatMarkdown>{steps.step2}</ChatMarkdown>
                          ) : (
                            <p className='text-muted-foreground text-[9px] italic'>
                              ไม่มีข้อมูลการวิเคราะห์บริบท
                            </p>
                          )}
                        </div>
                      )}
                      {activeStepTab === 'step3' && (
                        <div className='animate-in fade-in duration-150'>
                          <div className='mb-1 flex items-center justify-between text-[8px] font-semibold tracking-wider text-purple-600 uppercase dark:text-purple-400'>
                            <span>Step 3: ผลลัพธ์เกลาภาษาขั้นสมบูรณ์</span>
                            <span className='py-0.2 rounded border border-purple-500/20 bg-purple-500/10 px-1 text-[8px] font-bold text-purple-600 select-none dark:text-purple-400'>
                              Premium
                            </span>
                          </div>
                          {steps.step3 ? (
                            <ChatMarkdown>{steps.step3}</ChatMarkdown>
                          ) : (
                            <p className='text-muted-foreground text-[9px] italic'>
                              ไม่มีข้อมูลการเกลาภาษา
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <ChatMarkdown>{m.content}</ChatMarkdown>
                )}

                {showDiff && selectedTranslation && (
                  <div className='bg-muted/40 border-border/50 animate-in fade-in slide-in-from-top-1 mt-2 space-y-1.5 rounded-md border p-2 font-sans text-[11px] leading-relaxed break-words whitespace-pre-wrap duration-200 select-text'>
                    <div className='text-muted-foreground border-border/30 mb-1 flex items-center gap-1 border-b pb-0.5 text-[8px] font-bold tracking-wider uppercase'>
                      <FileDiffIcon className='size-2.5 text-amber-500' />
                      เปรียบเทียบคำแปลเดิม (ชมพู) → คำแปล AI (เขียว)
                    </div>
                    <div className='flex flex-wrap gap-x-0.5 gap-y-1'>
                      {computeDiff(
                        selectedTranslation,
                        steps.isAgentic ? steps.step3 : (m.content ?? ''),
                      ).map((c, i) => (
                        <span
                          key={i}
                          className={
                            c.type === 'added'
                              ? 'rounded-sm bg-emerald-500/15 px-0.5 font-medium text-emerald-700 dark:text-emerald-400'
                              : c.type === 'removed'
                                ? 'rounded-sm bg-rose-500/15 px-0.5 font-medium text-rose-700 line-through dark:text-rose-400'
                                : 'text-foreground'
                          }
                        >
                          {c.value}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {matchedGlossary.length > 0 && (
                  <div className='animate-in fade-in mt-2 flex flex-wrap gap-1.5 border-t border-emerald-500/10 pt-1.5 duration-200'>
                    {matchedGlossary.map((item) => (
                      <div
                        key={item.id}
                        className='flex items-center gap-1 rounded-md border border-emerald-500/15 bg-emerald-500/5 px-1.5 py-0.5 font-sans text-[9px] text-emerald-700 shadow-sm transition-colors duration-150 hover:bg-emerald-500/10 dark:text-emerald-400'
                        title={item.contextNote || 'คำศัพท์จากพจนานุกรมโครงการ'}
                      >
                        <BookOpenIcon className='size-2.5 text-emerald-500' />
                        <span className='font-semibold'>{item.sourceText}</span>
                        <span className='font-mono opacity-50'>→</span>
                        <span className='font-medium'>{item.targetText}</span>
                        {item.category && (
                          <span className='rounded-sm bg-emerald-500/10 px-1 text-[8px] opacity-40'>
                            {item.category}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )
          ) : (
            <span className='text-muted-foreground italic'>
              {m.role === 'assistant' ? '(no reply)' : '(empty)'}
            </span>
          )}
        </div>
      )}
      {attachments.length > 0 && (
        <div className='mt-1.5 flex flex-wrap gap-1'>
          {attachments.map((a, i) => (
            <a
              key={i}
              href={a.dataUrl}
              target='_blank'
              rel='noreferrer'
              className='border-border hover:ring-primary/40 block h-16 w-16 overflow-hidden rounded border transition hover:ring-2'
              title={`${a.width}×${a.height} · click to enlarge`}
            >
              <img
                src={a.dataUrl}
                alt={`attachment ${i + 1}`}
                className='h-full w-full object-cover'
              />
            </a>
          ))}
        </div>
      )}
      {m.toolCalls && <ToolCallsBadge raw={m.toolCalls} />}
    </div>
  )
}

function ToolCallsBadge({ raw }: { raw: string }) {
  let calls: any[] = []
  try {
    calls = JSON.parse(raw)
  } catch {}
  if (!calls.length) return null
  return (
    <div className='mt-1.5 space-y-0.5'>
      {calls.map((c, i) => (
        <div
          key={i}
          className='text-muted-foreground bg-muted/50 flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px]'
        >
          <WrenchIcon className='size-2.5' />
          {/* Defensive: a malformed persisted toolCalls JSON (e.g. from
              an older app version) might be missing `name`; render a
              placeholder instead of `undefined`. */}
          {c?.name ?? '(unknown tool)'}
        </div>
      ))}
    </div>
  )
}

function ToolResultRow({
  message: m,
  onDelete,
  onUndoFromHere,
}: {
  message: ChatMessageDto
  onDelete: () => void
  onUndoFromHere?: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className='group border-border/60 bg-muted/30 rounded-md border p-1.5 text-[10px]'>
      <div className='flex items-center gap-1'>
        <button
          onClick={() => setOpen((v) => !v)}
          className='text-muted-foreground hover:text-foreground flex flex-1 items-center gap-1 font-mono'
        >
          <ChevronDownIcon
            className={'size-2.5 transition ' + (open ? '' : '-rotate-90')}
          />
          <WrenchIcon className='size-2.5' />
          tool result · {m.toolCallId?.slice(0, 12) ?? ''}
        </button>
        {onUndoFromHere && (
          <button
            type='button'
            onClick={onUndoFromHere}
            aria-label='Undo from this tool result'
            title='ลบประวัติตั้งแต่ผลลัพธ์เครื่องมือนี้ย้อนหลัง (Undo from here)'
            className='text-muted-foreground mr-1.5 opacity-0 transition group-hover:opacity-100 hover:text-amber-500 focus:opacity-100'
          >
            <Undo2Icon className='size-2.5' />
          </button>
        )}
        <button
          type='button'
          onClick={onDelete}
          aria-label='Delete this tool result'
          title='Delete this tool result'
          className='text-muted-foreground hover:text-destructive opacity-0 transition group-hover:opacity-100 focus:opacity-100'
        >
          <XIcon className='size-2.5' />
        </button>
      </div>
      {open && (
        <pre className='mt-1 max-h-48 overflow-auto rounded bg-black/30 p-1.5 text-[10px] break-all whitespace-pre-wrap select-text'>
          {m.content}
        </pre>
      )}
    </div>
  )
}

function SlashPicker({
  items,
  selectedIndex,
  onPick,
  onClose,
}: {
  items: (typeof SLASH_COMMANDS)[number][]
  selectedIndex: number
  onPick: (name: string) => void
  onClose: () => void
}) {
  // Keep the highlighted row visible as the user arrows through.
  const selectedRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])
  if (!items.length) return null
  return (
    <div className='border-border bg-card absolute right-2 bottom-full left-2 mb-1 rounded-md border shadow-lg'>
      <div className='max-h-48 overflow-auto p-1'>
        {items.map((c, i) => {
          const active = i === selectedIndex
          return (
            <button
              key={c.name}
              ref={active ? selectedRef : undefined}
              // Mouse hover does not move the keyboard selection — keep
              // the two independent so a stray hover doesn't fight ↑/↓.
              onClick={() => onPick(c.name)}
              className={`flex w-full flex-col items-start gap-0.5 rounded px-2 py-1 text-left text-xs transition ${
                active ? 'bg-accent' : 'hover:bg-accent'
              }`}
            >
              <div className='flex items-center gap-1'>
                <code className='text-primary font-mono'>/{c.name}</code>
                {c.argsHint && (
                  <span className='text-muted-foreground text-[10px]'>
                    {c.argsHint}
                  </span>
                )}
              </div>
              <span className='text-muted-foreground text-[10px]'>
                {c.description}
              </span>
            </button>
          )
        })}
      </div>
      <button
        className='text-muted-foreground hover:bg-accent w-full border-t px-2 py-1 text-left text-[10px]'
        onClick={onClose}
      >
        ↑↓ select · Tab complete · Esc close
      </button>
    </div>
  )
}
