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
  UserIcon,
  WrenchIcon,
  XIcon,
  ZapIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { api, type ChatAttachment, type ChatMessageDto } from '@/lib/api'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import { useProjectStore } from '@/lib/stores/projectStore'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import {
  runChatTurn,
  type ChatMessage,
} from '@/lib/services/chatWithTools'
import {
  expandSlash,
  SLASH_COMMANDS,
} from '@/lib/services/chatSlashCommands'
import {
  blobToAttachment,
  parseAttachments,
} from '@/lib/services/imageAttach'
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
  'en': 'English',
  'th': 'Thai',
  'ja': 'Japanese',
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
async function buildSystemPrompt(): Promise<string> {
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
  return [
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
    .filter(Boolean)
    .join('\n')
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

  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showSlash, setShowSlash] = useState(false)
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>(
    [],
  )
  const [attaching, setAttaching] = useState(false)
  /** Partial assistant text that's currently streaming in. */
  const [streamingText, setStreamingText] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const currentDocIndex = useEditorUiStore((s) => s.currentDocumentIndex)

  // Snooze config (ESET-style):
  const [snoozeType, setSnoozeType] = useState<'restart' | 'messages' | null>(null)
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
    if (snoozeType === 'messages' && currentCount < snoozeTargetCount) return true
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

  const send = async () => {
    // Allow attachment-only turns through — image-only QA ("what does
    // this bubble say?") is a legitimate flow and the Send button
    // (see disabled prop below) already enables itself for that case.
    if ((!input.trim() && pendingAttachments.length === 0) || sending) return
    if (provider === 'none') {
      setError('Cloud LLM not selected — pick a profile from the LLM badge or Profiles tab.')
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

    // Build the message list sent to the LLM: system + prior turns
    // (from DB, oldest-first) + the just-sent user (use sendContent
    // which contains the expanded slash prompt).
    let systemContent = ''
    try {
      systemContent = await buildSystemPrompt()
    } catch {
      systemContent = 'You are an AI assistant for manga translation.'
    }
    const priorRows = (history.data ?? [])
      .filter((r) => r.role !== 'system')
      .map(rowToChatMessage)

    // The last message in priorRows is the one we just added (with displayContent).
    // We remove it from priorRows and replace it with lastUser (which has sendContent)
    // to avoid duplicating the user's message.
    if (priorRows.length > 0 && priorRows[priorRows.length - 1].role === 'user') {
      priorRows.pop()
    }

    // Rolling Window Context: Keep only the most recent 12 turns to speed up responses and save context window tokens
    const ROLLING_WINDOW_LIMIT = 12
    const rollingPriorRows = priorRows.length > ROLLING_WINDOW_LIMIT
      ? priorRows.slice(priorRows.length - ROLLING_WINDOW_LIMIT)
      : priorRows

    // Replace the just-persisted user message's display content with
    // the expanded prompt before sending. Attachments travel as-is —
    // provider adapters convert to native multi-modal blocks.
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

    const controller = new AbortController()
    abortRef.current = controller
    setStreamingText('')

    try {
      await runChatTurn(
        { provider, apiKey, apiUrl, model, signal: controller.signal },
        allMessages,
        async (e) => {
          if (e.kind === 'text-delta') {
            setStreamingText((prev) => prev + e.delta)
          } else if (e.kind === 'tool-call') {
            // Don't blank the bubble — append a progress line so the
            // user sees the model is dispatching a tool. Otherwise the
            // bubble looks empty during tool-dispatch + round-N latency
            // and the user thinks the chat is hung.
            setStreamingText((prev) => {
              const sep = prev ? '\n\n' : ''
              return `${prev}${sep}🔧 calling ${e.call.name}…`
            })
          } else if (e.kind === 'tool-result') {
            const result = e.result as { error?: string } | unknown
            const failed =
              result && typeof result === 'object' && 'error' in (result as any)
            setStreamingText((prev) => prev + (failed ? ' ✗' : ' ✓'))
          } else if (e.kind === 'done') {
            // Persist each new assistant + tool message from the
            // suffix that came after our `lastUser`. Skip messages
            // tagged `_synthetic` — those are tool-image follow-ups
            // the chat loop generated for the model's eyes only and
            // shouldn't appear in user-facing chat history (would
            // also dump base64 image bytes into SQLite).
            const before = allMessages.length
            const tail = e.finalMessages.slice(before)
            for (const m of tail) {
              if (m._synthetic) continue
              await api.chatMessageAdd({
                role: m.role,
                content: m.content,
                toolCalls: m.toolCalls ? JSON.stringify(m.toolCalls) : null,
                toolCallId: m.toolCallId ?? null,
                model: `${provider}:${model}`,
              })
            }
          }
        },
      )
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        // User clicked Stop — don't surface as a hard error.
      } else {
        setError(err?.message ?? String(err))
      }
    } finally {
      abortRef.current = null
      setStreamingText('')
      setSending(false)
      refresh()
    }
  }

  const stop = () => {
    abortRef.current?.abort()
  }

  const [clearing, setClearing] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [redoStack, setRedoStack] = useState<ChatMessageDto[][]>([])

  const revokeFromMessage = async (m: ChatMessageDto) => {
    if (!projectInfo || !history.data || history.data.length === 0 || revoking || sending) return
    const targetIdx = history.data.findIndex((item) => item.id === m.id)
    if (targetIdx === -1) return
    const retainedMessages = history.data.slice(0, targetIdx)
    const deletedMessages = history.data.slice(targetIdx)
    const targetUserMessage = history.data[targetIdx]
    setRevoking(true)
    setError(null)
    try {
      await api.chatMessagesClear()
      for (const msg of retainedMessages) {
        await api.chatMessageAdd({
          role: msg.role as any,
          content: msg.content,
          toolCalls: msg.toolCalls,
          toolCallId: msg.toolCallId,
          model: msg.model,
          attachments: msg.attachments,
        })
      }
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
    if (!projectInfo || !history.data || history.data.length === 0 || revoking || sending) return
    const lastUserIdx = [...history.data].reverse().findIndex((m) => m.role === 'user')
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

  const clearAll = async () => {
    if (clearing) return
    if (!confirm('ต้องการล้างประวัติแชททั้งหมดของโปรเจกต์นี้หรือไม่? (ข้อมูลทั้งหมดจะถูกลบถาวร)')) return
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
        <span className='text-muted-foreground text-[10px] font-bold tracking-wide uppercase flex items-center gap-1.5'>
          AI Chat ({history.data?.length ?? 0})
          {isSnoozed && (
            <button
              onClick={() => {
                setSnoozeType(null)
              }}
              title="การแจ้งเตือนความจำไหลผ่านเริ่มจำศีลอยู่ (คลิกเพื่อกู้คืนการแจ้งเตือนกลับมาปกติ)"
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted hover:bg-amber-500/10 text-muted-foreground/60 hover:text-amber-600 dark:hover:text-amber-400 text-[9px] font-semibold border border-border transition cursor-pointer"
            >
              <BellOffIcon className="size-2.5" />
              ปิดเตือนอยู่
            </button>
          )}
        </span>
        <div className='flex items-center gap-1'>
          <Button
            variant='ghost'
            size='sm'
            className='h-6 px-2 text-[10px] disabled:opacity-40 flex items-center gap-1'
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
            className='h-6 px-2 text-[10px] disabled:opacity-40 flex items-center gap-1'
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
            className='h-6 px-2 text-[10px] disabled:opacity-40 flex items-center gap-1'
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
            via <span className='text-foreground font-semibold'>{provider}</span>{' '}
            · {model || '(no model)'}
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
        <div className='border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400 border-b px-2 py-1.5 text-[10px]'>
          {t(
            'chat.textOnlyWarning',
            '⚠ {{count}} image attachment(s) queued but the active model is text-only — switch profile to a vision-capable model (e.g. gpt-4o, claude-haiku, gemini-1.5+) or remove the attachments before sending.',
            { count: pendingAttachments.length },
          )}
        </div>
      )}

      {/* Messages Wrapper for Floating Overlays */}
      <div className='relative min-h-0 min-w-0 flex-1 flex flex-col'>
        <ScrollArea className='flex-1' viewportRef={scrollRef}>
          <div className='w-full min-w-0 space-y-2 p-2 pb-24'>
            {!history.data?.length ? (
              <EmptyState />
            ) : (
              history.data.map((m) => (
                <MessageRow
                  key={m.id}
                  message={m}
                  onDelete={() => void deleteMessage(m.id)}
                />
              ))
            )}
            {sending && (
              <StreamingBubble streamingText={streamingText} onStop={stop} />
            )}
            {error && (
              <div className='text-destructive border-destructive/30 rounded border p-2 text-[10px]'>
                {error}
              </div>
            )}
          </div>
        </ScrollArea>

        {/* ESET-style Compact Memory Warning Floating Card */}
        {showWarning && (
          <div className="absolute bottom-2 left-2 right-2 border-amber-500/30 bg-background/95 backdrop-blur-sm text-amber-900 dark:text-amber-300 border rounded-lg p-2.5 shadow-lg text-xs flex flex-col gap-1.5 z-40 animate-in fade-in slide-in-from-bottom-2 duration-200">
            <div className="font-semibold flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <TriangleAlertIcon className="size-3 text-amber-600 dark:text-amber-400 shrink-0" />
                ความทรงจำของ AI เริ่มจะไม่แน่นอนแล้ว
              </span>
              <button 
                onClick={() => setSnoozeType('restart')} 
                className="opacity-50 hover:opacity-100 transition text-[10px] cursor-pointer"
                title="ปิดชั่วคราวจนกว่าจะรีสตาร์ท"
              >
                ✕
              </button>
            </div>
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              ความจำช่วงเริ่มต้นกำลังจะเลือนหายเนื่องจากประวัติแชทเริ่มยาวเกินกำหนด แนะนำให้บีบอัดแชทเพื่อรักษาบริบทสำคัญไว้
            </p>
            <div className="flex items-center gap-2 mt-1 relative">
              <Button
                variant="outline"
                size="sm"
                disabled={compacting || sending}
                onClick={compactChat}
                className="h-6 px-2.5 text-[10px] bg-amber-500/10 hover:bg-amber-500/20 border-amber-500/30 text-amber-800 dark:text-amber-300 flex items-center"
              >
                {compacting ? (
                  <>
                    <Loader2Icon className="mr-1 size-3 animate-spin" />
                    กำลังบีบอัด...
                  </>
                ) : (
                  <>
                    <ZapIcon className="size-2.5 mr-1 text-amber-600 dark:text-amber-400" />
                    บีบอัดแชทตอนนี้
                  </>
                )}
              </Button>
              <div className="relative">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={compacting || sending}
                  onClick={() => setShowSnoozeMenu(!showSnoozeMenu)}
                  className="h-6 px-2 text-[10px] text-muted-foreground hover:bg-muted"
                >
                  ปิดเตือนชั่วคราว ▾
                </Button>
                {showSnoozeMenu && (
                  <div className="absolute left-0 bottom-full z-50 mb-1 w-60 rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-1 text-[10px] font-sans">
                    <button
                      onClick={() => {
                        setSnoozeType('messages')
                        setSnoozeTargetCount(currentCount + 50)
                        setShowSnoozeMenu(false)
                      }}
                      className="w-full text-left px-2 py-1.5 hover:bg-accent hover:text-accent-foreground rounded-sm transition cursor-pointer"
                    >
                      ปิดเตือนถัดไปอีก 50 ข้อความ
                    </button>
                    <button
                      onClick={() => {
                        setSnoozeType('restart')
                        setShowSnoozeMenu(false)
                      }}
                      className="w-full text-left px-2 py-1.5 hover:bg-accent hover:text-accent-foreground rounded-sm transition cursor-pointer"
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
        {showSlash && (
          <SlashPicker
            query={input.slice(1).split(' ')[0] ?? ''}
            onPick={(name) => {
              setInput(`/${name} `)
              setShowSlash(false)
            }}
            onClose={() => setShowSlash(false)}
          />
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
        <Textarea
          value={input}
          onChange={(e) => {
            const v = e.target.value
            setInput(v)
            setShowSlash(v.startsWith('/') && !v.includes('\n'))
          }}
          onKeyDown={(e) => {
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
          </div>
          <span className='text-muted-foreground flex-1 truncate text-[10px]'>
            {input.startsWith('/') ? (
              <>type to filter commands · ↵ to send</>
            ) : (
              <>↵ send · Shift+↵ newline</>
            )}
          </span>
          <Button
            size='sm'
            className='h-6 px-2 text-[10px]'
            disabled={
              (!input.trim() && pendingAttachments.length === 0) || sending
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
  return (
    <div className='border-border bg-card rounded-md border p-2 text-xs'>
      <div className='text-muted-foreground mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase'>
        <BotIcon className='size-3' />
        assistant
        <Loader2Icon className='ml-auto size-3 animate-spin' />
      </div>
      <div className='min-w-0'>
        <ChatMarkdown>{streamingText}</ChatMarkdown>
        <span className='ml-0.5 inline-block h-3 w-1 animate-pulse bg-current align-middle' />
      </div>
      <button
        onClick={onStop}
        className='text-muted-foreground hover:text-destructive mt-1 text-[10px] underline'
      >
        Stop
      </button>
    </div>
  )
})

function MessageRow({
  message: m,
  onDelete,
}: {
  message: ChatMessageDto
  onDelete: () => void
}) {
  if (m.role === 'tool') {
    return <ToolResultRow message={m} onDelete={onDelete} />
  }
  const isUser = m.role === 'user'
  const attachments = parseAttachments(m.attachments)
  return (
    <div
      className={
        'group relative rounded-md border p-2 text-xs ' +
        (isUser
          ? 'border-primary/30 bg-primary/5'
          : 'border-border bg-card')
      }
    >
      <div className='text-muted-foreground mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase'>
        {isUser ? <UserIcon className='size-3' /> : <BotIcon className='size-3' />}
        {m.role}
        {/* Per-message delete (#24). Only visible on hover so it
         *  doesn't clutter the message list, and only on resolved
         *  rows (rendered ones, not the streaming bubble). */}
        <button
          type='button'
          onClick={onDelete}
          aria-label='Delete this message'
          title='Delete this message'
          className='text-muted-foreground hover:text-destructive ml-auto opacity-0 transition group-hover:opacity-100 focus:opacity-100'
        >
          <XIcon className='size-3' />
        </button>
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
              <div className='select-text break-words whitespace-pre-wrap text-xs leading-relaxed'>
                {m.content}
              </div>
            ) : (
              <ChatMarkdown>{m.content}</ChatMarkdown>
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
}: {
  message: ChatMessageDto
  onDelete: () => void
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
        <pre className='mt-1 max-h-48 overflow-auto rounded bg-black/30 p-1.5 text-[10px] select-text whitespace-pre-wrap break-all'>
          {m.content}
        </pre>
      )}
    </div>
  )
}

function SlashPicker({
  query,
  onPick,
  onClose,
}: {
  query: string
  onPick: (name: string) => void
  onClose: () => void
}) {
  const filtered = useMemo(
    () =>
      SLASH_COMMANDS.filter((c) =>
        c.name.toLowerCase().includes(query.toLowerCase()),
      ),
    [query],
  )
  if (!filtered.length) return null
  return (
    <div className='border-border bg-card absolute bottom-full left-2 right-2 mb-1 rounded-md border shadow-lg'>
      <div className='max-h-48 overflow-auto p-1'>
        {filtered.map((c) => (
          <button
            key={c.name}
            onClick={() => onPick(c.name)}
            className='hover:bg-accent flex w-full flex-col items-start gap-0.5 rounded px-2 py-1 text-left text-xs transition'
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
        ))}
      </div>
      <button
        className='text-muted-foreground hover:bg-accent w-full border-t px-2 py-1 text-left text-[10px]'
        onClick={onClose}
      >
        Esc to close
      </button>
    </div>
  )
}
