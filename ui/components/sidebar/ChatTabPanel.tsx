'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BotIcon,
  ChevronDownIcon,
  ImagePlusIcon,
  Loader2Icon,
  ScanLineIcon,
  SendIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UserIcon,
  WrenchIcon,
  XIcon,
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
import i18n from '@/lib/i18n'

const DISPLAY_LIMIT = 50

/** Map the app's i18next locale code to the natural-language name we
 *  pass to the model. The model recognises "Thai" much more reliably
 *  than the BCP-47 code "th-TH". */
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
    attachments: parseAttachments(row.attachments),
  }
}

export function ChatTabPanel() {
  const projectInfo = useProjectStore((s) => s.info)
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
      const blob = new Blob([doc.image], { type: 'image/png' })
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
    if (!input.trim() || sending) return
    if (provider === 'none') {
      setError('Cloud LLM not selected — pick a profile from the LLM badge or Profiles tab.')
      return
    }
    if (!apiKey && provider !== 'openrouter') {
      setError('No API key for active profile.')
      return
    }
    setSending(true)
    setError(null)

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
      ...priorRows,
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
            // suffix that came after our `lastUser`.
            const before = allMessages.length
            const tail = e.finalMessages.slice(before)
            for (const m of tail) {
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

  const clearAll = async () => {
    if (!confirm('Clear all chat history for this project?')) return
    await api.chatMessagesClear()
    refresh()
  }

  return (
    <div className='flex h-full min-h-0 flex-1 flex-col'>
      <div className='border-border flex items-center justify-between border-b px-2 py-1.5'>
        <span className='text-muted-foreground text-[10px] font-bold tracking-wide uppercase'>
          AI Chat ({history.data?.length ?? 0})
        </span>
        <div className='flex items-center gap-1'>
          <Button
            variant='ghost'
            size='icon-xs'
            className='size-6'
            title='Clear chat history'
            onClick={() => void clearAll()}
          >
            <Trash2Icon className='size-3' />
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
          ⚠ {pendingAttachments.length} image attachment(s) queued but the
          active model is text-only — switch profile to a vision-capable
          model (e.g. gpt-4o, claude-haiku, gemini-1.5+) or remove the
          attachments before sending.
        </div>
      )}

      {/* Messages */}
      <ScrollArea className='min-h-0 min-w-0 flex-1' viewportRef={scrollRef}>
        <div className='w-full min-w-0 space-y-2 p-2'>
          {!history.data?.length ? (
            <EmptyState />
          ) : (
            history.data.map((m) => <MessageRow key={m.id} message={m} />)
          )}
          {sending && (
            <div className='border-border bg-card rounded-md border p-2 text-xs'>
              <div className='text-muted-foreground mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase'>
                <BotIcon className='size-3' />
                assistant
                <Loader2Icon className='ml-auto size-3 animate-spin' />
              </div>
              <div className='whitespace-pre-wrap break-words text-xs leading-relaxed'>
                {streamingText}
                <span className='ml-0.5 inline-block h-3 w-1 animate-pulse bg-current align-middle' />
              </div>
              <button
                onClick={stop}
                className='text-muted-foreground hover:text-destructive mt-1 text-[10px] underline'
              >
                Stop
              </button>
            </div>
          )}
          {error && (
            <div className='text-destructive border-destructive/30 rounded border p-2 text-[10px]'>
              {error}
            </div>
          )}
        </div>
      </ScrollArea>

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
  return (
    <div className='border-border rounded-md border border-dashed p-3 text-center text-xs'>
      <BotIcon className='text-muted-foreground/40 mx-auto mb-2 size-6' />
      <p className='text-muted-foreground mb-2'>
        ถามอะไรเกี่ยวกับการแปลก็ได้ — AI เห็น project context และเรียก tool
        แก้ไขข้อมูลให้ได้
      </p>
      <p className='text-muted-foreground/70 text-[10px]'>
        เริ่มจาก <code className='bg-muted rounded px-1'>/fetch-wiki &lt;url&gt;</code>
        {' '}หรือ{' '}
        <code className='bg-muted rounded px-1'>/draft-synopsis</code>
      </p>
    </div>
  )
}

function MessageRow({ message: m }: { message: ChatMessageDto }) {
  if (m.role === 'tool') {
    return <ToolResultRow message={m} />
  }
  const isUser = m.role === 'user'
  const attachments = parseAttachments(m.attachments)
  return (
    <div
      className={
        'rounded-md border p-2 text-xs ' +
        (isUser
          ? 'border-primary/30 bg-primary/5'
          : 'border-border bg-card')
      }
    >
      <div className='text-muted-foreground mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase'>
        {isUser ? <UserIcon className='size-3' /> : <BotIcon className='size-3' />}
        {m.role}
      </div>
      {/* Don't render an "(empty)" placeholder when the assistant
       *  turn has tool_calls — Claude / Gemini often dispatch a tool
       *  without preamble text, and showing "(empty)" makes it look
       *  like a failure. The tool badge below already tells the
       *  user what's happening. */}
      {(m.content ||
        !m.toolCalls ||
        (typeof m.toolCalls === 'string' && m.toolCalls === 'null')) && (
        <div className='whitespace-pre-wrap break-words text-xs leading-relaxed'>
          {m.content || (
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
          {c.name}
        </div>
      ))}
    </div>
  )
}

function ToolResultRow({ message: m }: { message: ChatMessageDto }) {
  const [open, setOpen] = useState(false)
  return (
    <div className='border-border/60 bg-muted/30 rounded-md border p-1.5 text-[10px]'>
      <button
        onClick={() => setOpen((v) => !v)}
        className='text-muted-foreground hover:text-foreground flex w-full items-center gap-1 font-mono'
      >
        <ChevronDownIcon
          className={'size-2.5 transition ' + (open ? '' : '-rotate-90')}
        />
        <WrenchIcon className='size-2.5' />
        tool result · {m.toolCallId?.slice(0, 12) ?? ''}
      </button>
      {open && (
        <pre className='mt-1 max-h-48 overflow-auto rounded bg-black/30 p-1.5 text-[10px]'>
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
