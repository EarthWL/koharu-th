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

async function buildSystemPrompt(): Promise<string> {
  const uiLang = uiLanguageName()
  const project = useProjectStore.getState().info
  if (!project) {
    return [
      'You are an AI assistant for manga translation. No project is currently open.',
      `Reply to the user in ${uiLang}.`,
    ].join('\n')
  }
  let series: any = null
  try {
    series = await api.seriesMetaGet()
  } catch {}
  return [
    'You are an AI assistant embedded in the Koharu manga translation editor.',
    `The user is working on project "${project.name}".`,
    `Reply to the user in ${uiLang} unless they explicitly ask for another language.`,
    'You have tools to read and modify series metadata, characters, glossary, chapters, prompt templates, and to fetch web pages (wikis).',
    'When the user asks you to populate or update project data, propose changes first, wait for approval, then call the matching tool.',
    'Keep your replies concise. Use markdown tables for proposals.',
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

  async start({ input, attachments, provider, priorMessages, queryClient }) {
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

    // Build the message list sent to the LLM: system + prior turns
    // (from DB) + the just-sent user (expanded slash prompt).
    let systemContent = ''
    try {
      systemContent = await buildSystemPrompt()
    } catch {
      systemContent = 'You are an AI assistant for manga translation.'
    }
    // priorMessages is what the chat panel was showing pre-send,
    // EXCLUDING the user turn we just persisted (that turn lives
    // only in the DB at this point, since the panel hasn't refetched
    // yet). We append the expanded `sendContent` as the trailing
    // user turn directly.
    const priorRows = priorMessages
      .filter((r) => r.role !== 'system')
      .map(rowToChatMessage)
    const lastUser: ChatMessage = {
      role: 'user',
      content: sendContent,
      attachments: attachments.length ? attachments : undefined,
    }
    const allMessages: ChatMessage[] = [
      { role: 'system', content: systemContent },
      ...priorRows,
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
        },
        allMessages,
        async (e) => {
          if (e.kind === 'text-delta') {
            set((s) => ({ streamingText: s.streamingText + e.delta }))
          } else if (e.kind === 'tool-call') {
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
            for (const m of tail) {
              if ((m as any)._synthetic) continue
              await api.chatMessageAdd({
                role: m.role,
                // Tool-call-only assistant messages have no text
                // content (the model dispatched a tool without
                // narrating). Backend's `content: String` is required
                // — sending `undefined` here would serialize as
                // absent and serde would throw
                // "invalid type: unit value, expected a string"
                // (which previously aborted /translate-page after
                // it had already called 13 update_text_block tools
                // successfully). Default to empty string instead.
                content: m.content ?? '',
                toolCalls: m.toolCalls ? JSON.stringify(m.toolCalls) : null,
                toolCallId: m.toolCallId ?? null,
                model: `${provider.provider}:${provider.model}`,
              })
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
