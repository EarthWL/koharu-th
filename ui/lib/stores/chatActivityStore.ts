'use client'

import type { QueryClient } from '@tanstack/react-query'
import { create } from 'zustand'

import { api, type ChatAttachment, type ChatMessageDto } from '@/lib/api'
import { useProjectStore } from '@/lib/stores/projectStore'
import {
  runChatTurn,
  type ChatMessage,
} from '@/lib/services/chatWithTools'
import { expandSlash } from '@/lib/services/chatSlashCommands'
import i18n from '@/lib/i18n'

/// Self-test: ChatTabPanel previously held `sending` / `streamingText`
/// / `error` / abortRef as component-local state. Switching the
/// sidebar away from chat unmounted the panel, which:
///
///   - Lost the streaming text mid-progress (setStreamingText calls
///     hit a dead component and React no-ops them)
///   - Made the user think the call dropped, even though the DB
///     writes inside `runChatTurn`'s `done` event continued
///
/// This store lifts the activity state out of the component lifecycle.
/// `start()` owns the AbortController + the run lifecycle; the
/// component subscribes for display only. Switching tabs no longer
/// interrupts anything — when the user comes back, they see exactly
/// where the run is (mid-stream, awaiting tool result, finished).

const CHAT_HISTORY_QUERY_KEY = ['project', 'chat-messages'] as const

const UI_LOCALE_TO_LANGUAGE: Record<string, string> = {
  'en-US': 'English',
  'th-TH': 'Thai',
  'ja-JP': 'Japanese',
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  'ru-RU': 'Russian',
  'es-ES': 'Spanish',
}

function uiLanguageName(): string {
  const code = i18n.language || i18n.options?.fallbackLng?.toString() || 'en-US'
  return UI_LOCALE_TO_LANGUAGE[code] ?? 'English'
}

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
  }
}

export type ChatProviderConfig = {
  provider: string
  apiKey: string
  apiUrl: string
  model: string
}

export type StartArgs = {
  /** Raw user input — may include a leading slash that gets expanded. */
  input: string
  /** Image / file attachments for THIS turn only. */
  attachments: ChatAttachment[]
  /** Active LLM profile config. */
  provider: ChatProviderConfig
  /** Prior turns to pass to the model (system message NOT included —
   *  the store builds the system prompt fresh each turn). The caller
   *  passes the contents of the chat-messages query so the store
   *  doesn't have to second-guess the cache state. */
  priorMessages: ChatMessageDto[]
  /** React Query client for invalidating the chat-messages list once
   *  new turns land in the DB. */
  queryClient: QueryClient
  /** If true, the user message is already in the DB and should not be persisted again. */
  skipPersistUser?: boolean
  /** Preceding user message ID if we are regenerating an assistant reply for a virtual branch. */
  regeneratingUserMsgId?: number | null
  /** Enable multi-step agentic translation prompts. */
  agenticMode?: boolean
  /** Temperature configuration. */
  temperature?: number
  /** Max output tokens configuration. */
  maxTokens?: number
}

type ChatActivityState = {
  /** True while a turn is in flight (request sent, awaiting full
   *  response). Disables the Send button + drives the spinner. */
  sending: boolean
  /** Live streamed assistant text. Cleared when the turn finishes. */
  streamingText: string
  /** Last error message, if any. Clears on next successful start. */
  error: string | null

  /** Begin a chat turn. Persists the user message, runs the model
   *  turn (with tool round-trips), and persists each assistant /
   *  tool message in the `done` event's tail. */
  start: (args: StartArgs) => Promise<void>
  /** Abort the in-flight run. Sets `sending` to false; partial
   *  streamingText is dropped. */
  stop: () => void
  /** Clear the error banner (e.g. when the user starts typing again). */
  clearError: () => void
}

let abortController: AbortController | null = null

export const useChatActivityStore = create<ChatActivityState>((set, get) => ({
  sending: false,
  streamingText: '',
  error: null,

  async start({
    input,
    attachments,
    provider,
    priorMessages,
    queryClient,
    skipPersistUser,
    regeneratingUserMsgId,
    agenticMode,
    temperature,
    maxTokens,
  }) {
    if (get().sending) return
    if (!input.trim() && attachments.length === 0) return

    set({ sending: true, error: null, streamingText: '' })

    // Slash expansion: user sees the display, LLM gets the expanded
    // prompt. expandSlash returns null when input isn't a known
    // slash command — we send the literal text in that case.
    const slash = expandSlash(input)
    const displayContent = slash ? slash.display : input
    const sendContent = slash ? slash.prompt : input

    // Persist user message first (with attachments if any) so it
    // appears in the chat list immediately on the subscriber side.
    if (!skipPersistUser) {
      try {
        await api.chatMessageAdd({
          role: 'user',
          content: displayContent,
          attachments: attachments.length ? JSON.stringify(attachments) : null,
        })
      } catch (err: any) {
        set({ error: err?.message ?? String(err), sending: false })
        return
      }
      // Refetch so subscribers (the chat panel, when visible) see the
      // just-added user turn before the assistant reply starts streaming.
      await queryClient.invalidateQueries({ queryKey: CHAT_HISTORY_QUERY_KEY })
    }

    // Build the message list sent to the LLM: system + prior turns
    // (from DB) + the just-sent user (expanded slash prompt).
    let systemContent = ''
    try {
      systemContent = await buildSystemPrompt(agenticMode)
    } catch {
      systemContent = 'You are an AI assistant for manga translation.'
    }

    const priorRows = priorMessages
      .filter((r) => r.role !== 'system')
      .map(rowToChatMessage)

    // If the last message in priorRows is a user message, we pop it to avoid duplicate user turns.
    if (
      priorRows.length > 0 &&
      priorRows[priorRows.length - 1].role === 'user'
    ) {
      priorRows.pop()
    }

    // Rolling Window Context: Keep only the most recent 12 turns to speed up responses and save context window tokens
    const ROLLING_WINDOW_LIMIT = 12
    const rollingPriorRows =
      priorRows.length > ROLLING_WINDOW_LIMIT
        ? priorRows.slice(priorRows.length - ROLLING_WINDOW_LIMIT)
        : priorRows

    const lastUser: ChatMessage = {
      role: 'user',
      content: sendContent,
      attachments: attachments.length ? attachments : undefined,
    }
    const allMessages: ChatMessage[] = [
      { role: 'system', content: systemContent },
      ...rollingPriorRows,
      lastUser,
    ]

    abortController = new AbortController()

    try {
      await runChatTurn(
        {
          provider: provider.provider,
          apiKey: provider.apiKey,
          apiUrl: provider.apiUrl,
          model: provider.model,
          signal: abortController.signal,
          temperature,
          maxTokens,
        },
        allMessages,
        async (e) => {
          if (e.kind === 'text-delta') {
            set((s) => ({ streamingText: s.streamingText + e.delta }))
          } else if (e.kind === 'tool-call') {
            // Don't blank the bubble — append a progress line so the
            // user sees the model is dispatching a tool. Otherwise the
            // bubble looks empty during tool-dispatch + round-N latency
            // and the user thinks the chat is hung.
            set((s) => {
              const sep = s.streamingText ? '\n\n' : ''
              return {
                streamingText: `${s.streamingText}${sep}🔧 calling ${e.call.name}…`,
              }
            })
          } else if (e.kind === 'tool-result') {
            const result = e.result as { error?: string } | unknown
            const failed =
              result && typeof result === 'object' && 'error' in (result as any)
            set((s) => ({
              streamingText: s.streamingText + (failed ? ' ✗' : ' ✓'),
            }))
          } else if (e.kind === 'done') {
            // Persist each new assistant + tool message from the
            // suffix that came after our `lastUser`. Skip messages
            // tagged `_synthetic` — those are tool-image follow-ups
            // for the model's eyes only and shouldn't show in user-
            // facing chat history.
            const before = allMessages.length
            const tail = e.finalMessages.slice(before)
            let lastAssistantMsg: ChatMessage | null = null
            for (const m of tail) {
              if ((m as any)._synthetic) continue
              await api.chatMessageAdd({
                role: m.role,
                content: m.content,
                toolCalls: m.toolCalls ? JSON.stringify(m.toolCalls) : null,
                toolCallId: m.toolCallId ?? null,
                model: `${provider.provider}:${provider.model}`,
              })
              if (m.role === 'assistant') {
                lastAssistantMsg = m
              }
            }

            // Save to virtual branch if we are regenerating
            if (regeneratingUserMsgId && lastAssistantMsg) {
              const projectInfo = useProjectStore.getState().info
              if (projectInfo) {
                const key = `koharu_chat_branches_${projectInfo.id}_${regeneratingUserMsgId}`
                const currentBranches = JSON.parse(
                  localStorage.getItem(key) || '[]',
                )

                currentBranches.push({
                  content: lastAssistantMsg.content,
                  model: `${provider.provider}:${provider.model}`,
                  toolCalls: lastAssistantMsg.toolCalls
                    ? JSON.stringify(lastAssistantMsg.toolCalls)
                    : null,
                  toolCallId: lastAssistantMsg.toolCallId ?? null,
                })

                localStorage.setItem(key, JSON.stringify(currentBranches))
              }
            }
          }
        },
      )
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        // User clicked Stop — don't surface as a hard error.
      } else {
        set({ error: err?.message ?? String(err) })
      }
    } finally {
      abortController = null
      set({ streamingText: '', sending: false })
      await queryClient.invalidateQueries({ queryKey: CHAT_HISTORY_QUERY_KEY })
    }
  },

  stop() {
    abortController?.abort()
  },

  clearError() {
    set({ error: null })
  },
}))
