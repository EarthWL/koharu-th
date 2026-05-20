'use client'

import { useState, useEffect } from 'react'
import {
  Activity,
  Users,
  ShieldAlert,
  Wifi,
  Check,
  Sparkles,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ConflictResolutionModal,
  type TextBlockConflict,
} from './ConflictResolutionModal'

type LogEvent = {
  id: string
  time: string
  user: string
  avatar: string
  action: string
  color: string
}

const USERS_LIST = [
  {
    name: 'HetCreep (Lead)',
    role: 'Owner',
    active: true,
    color: 'border-rose-400 bg-rose-500/10 text-rose-400',
  },
  {
    name: 'EarthWL (Upstream)',
    role: 'Maintainer',
    active: true,
    color: 'border-blue-400 bg-blue-500/10 text-blue-400',
  },
  {
    name: 'Koharu AI Engine',
    role: 'Copilot',
    active: true,
    color: 'border-emerald-400 bg-emerald-500/10 text-emerald-400',
  },
  {
    name: 'Claude-4.7-Opus',
    role: 'Auditor',
    active: false,
    color: 'border-purple-400 bg-purple-500/10 text-purple-400',
  },
]

const EVENT_ACTIONS = [
  {
    action: 'edited Speech Bubble #14 on Page 3',
    user: 'HetCreep (Lead)',
    color: 'text-rose-400',
  },
  {
    action: 'approved Manga Glossary term "コハル"',
    user: 'EarthWL (Upstream)',
    color: 'text-blue-400',
  },
  {
    action: 'completed parallel inpainting on Page 5',
    user: 'Koharu AI Engine',
    color: 'text-emerald-400',
  },
  {
    action: 'updated character details for "Sayaka"',
    user: 'HetCreep (Lead)',
    color: 'text-rose-400',
  },
  {
    action: 'triggered Cloud Vision OCR check on Page 12',
    user: 'Koharu AI Engine',
    color: 'text-emerald-400',
  },
  {
    action: 're-routed Translation failover strategy to backup provider',
    user: 'EarthWL (Upstream)',
    color: 'text-blue-400',
  },
]

const MOCK_CONFLICT: TextBlockConflict = {
  bubbleId: 'Speech Bubble #14',
  pageName: 'Page 3',
  local: {
    text: 'この戦いが終わったら、一緒に帰ろう。',
    translation: 'ถ้าการต่อสู้ครั้งนี้จบลง พวกเรากลับด้วยกันนะ...',
    coord: 'x: 142, y: 580, w: 210, h: 90',
    lastModified: 'Just now by HetCreep',
  },
  remote: {
    text: 'この戦いが終わったら、一緒に帰ろう。',
    translation: 'พอสงครามครั้งนี้สิ้นสุดลง กลับบ้านด้วยกันเถอะนะ...',
    coord: 'x: 140, y: 582, w: 215, h: 92',
    lastModified: '3 seconds ago',
    user: 'EarthWL (Upstream)',
  },
}

export function CollaborativeSessionHUD() {
  const [latency, setLatency] = useState<number>(12)
  const [events, setEvents] = useState<LogEvent[]>([
    {
      id: '1',
      time: '20:42:01',
      user: 'HetCreep (Lead)',
      avatar: 'H',
      action: 'initialized collaboration session room #8472',
      color: 'text-rose-400',
    },
    {
      id: '2',
      time: '20:42:05',
      user: 'EarthWL (Upstream)',
      avatar: 'E',
      action: 'joined translation room',
      color: 'text-blue-400',
    },
    {
      id: '3',
      time: '20:42:15',
      user: 'Koharu AI Engine',
      avatar: 'K',
      action: 'connected to active LLM provider pipeline',
      color: 'text-emerald-400',
    },
  ])

  // Conflict state
  const [conflictOpen, setConflictOpen] = useState(false)
  const [currentConflict, setCurrentConflict] =
    useState<TextBlockConflict>(MOCK_CONFLICT)

  // Latency micro-variance simulation to feel "alive"
  useEffect(() => {
    const latInterval = setInterval(() => {
      setLatency((prev) => {
        const delta = Math.floor(Math.random() * 5) - 2
        const next = prev + delta
        return next < 5 ? 5 : next > 25 ? 25 : next
      })
    }, 2500)
    return () => clearInterval(latInterval)
  }, [])

  // Event stream simulation
  useEffect(() => {
    const eventInterval = setInterval(() => {
      const randomAction =
        EVENT_ACTIONS[Math.floor(Math.random() * EVENT_ACTIONS.length)]
      const now = new Date()
      const timeString = now.toTimeString().split(' ')[0]
      const newEvent: LogEvent = {
        id: String(Date.now()),
        time: timeString,
        user: randomAction.user,
        avatar: randomAction.user[0],
        action: randomAction.action,
        color: randomAction.color,
      }
      setEvents((prev) => [newEvent, ...prev.slice(0, 4)])
    }, 8000)
    return () => clearInterval(eventInterval)
  }, [])

  const triggerConflict = () => {
    setCurrentConflict(MOCK_CONFLICT)
    setConflictOpen(true)
  }

  const handleResolveConflict = (
    decision: 'local' | 'remote' | 'merged',
    resolvedText: string,
  ) => {
    setConflictOpen(false)
    const now = new Date()
    const timeString = now.toTimeString().split(' ')[0]

    let decisionText = ''
    let userColor = 'text-purple-400'
    if (decision === 'local') {
      decisionText =
        'resolved bubble sync conflict on Speech Bubble #14: KEPT LOCAL'
      userColor = 'text-rose-400'
    } else if (decision === 'remote') {
      decisionText =
        'resolved bubble sync conflict on Speech Bubble #14: ACCEPTED REMOTE'
      userColor = 'text-blue-400'
    } else {
      decisionText = `resolved bubble sync conflict on Speech Bubble #14: MERGED to "${resolvedText}"`
      userColor = 'text-purple-400'
    }

    const resolutionLog: LogEvent = {
      id: String(Date.now()),
      time: timeString,
      user: 'HetCreep (Lead)',
      avatar: 'H',
      action: decisionText,
      color: userColor,
    }

    setEvents((prev) => [resolutionLog, ...prev])
  }

  return (
    <div className='text-foreground flex flex-col gap-4 font-sans text-xs'>
      {/* Session Header Status */}
      <div className='border-border/50 grid grid-cols-2 gap-2 border-b pb-3'>
        <div className='bg-background/30 border-border/30 flex flex-col gap-0.5 rounded-lg border p-2'>
          <span className='text-muted-foreground text-[8px] font-bold tracking-wider uppercase'>
            Active Room ID
          </span>
          <span className='text-primary flex items-center gap-1.5 font-mono text-xs font-bold'>
            <Wifi className='text-primary size-3 animate-pulse' />
            #8472 (P2P Mesh)
          </span>
        </div>
        <div className='bg-background/30 border-border/30 flex flex-col gap-0.5 rounded-lg border p-2'>
          <span className='text-muted-foreground text-[8px] font-bold tracking-wider uppercase'>
            P2P Connection Latency
          </span>
          <span className='flex items-center gap-1.5 font-mono text-xs font-bold text-emerald-400'>
            <Activity className='size-3 animate-pulse text-emerald-400' />
            {latency} ms (Stable)
          </span>
        </div>
      </div>

      {/* Active Team list */}
      <div className='flex flex-col gap-2'>
        <div className='flex items-center justify-between'>
          <span className='text-muted-foreground flex items-center gap-1.5 text-[9px] font-semibold tracking-wide uppercase'>
            <Users className='text-primary size-3.5' />
            Active Team Editors ({
              USERS_LIST.filter((u) => u.active).length
            } / {USERS_LIST.length})
          </span>
          {/* Conflict Simulator Trigger */}
          <Button
            onClick={triggerConflict}
            size='sm'
            variant='outline'
            className='flex h-6 items-center gap-1 border border-amber-500/20 bg-amber-500/10 text-[9px] text-amber-500 transition-all duration-300 hover:bg-amber-500/20'
          >
            <AlertTriangle className='size-3 animate-bounce' />
            Simulate Bubble Conflict
          </Button>
        </div>
        <div className='grid grid-cols-2 gap-2'>
          {USERS_LIST.map((user) => (
            <div
              key={user.name}
              className={`flex items-center gap-2 rounded-lg border p-2 backdrop-blur-sm transition-all duration-300 ${
                user.active
                  ? 'border-border/60 bg-card/65'
                  : 'border-border/30 bg-muted/20 opacity-40'
              }`}
            >
              <div
                className={`flex size-5 items-center justify-center rounded-full border font-mono text-[9px] font-bold ${user.color}`}
              >
                {user.name[0]}
              </div>
              <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
                <span className='text-foreground truncate text-[10px] leading-none font-bold'>
                  {user.name.split(' ')[0]}
                </span>
                <span className='text-muted-foreground text-[8px] leading-none uppercase'>
                  {user.role}
                </span>
              </div>
              {user.active && (
                <span className='size-1.5 shrink-0 animate-ping rounded-full bg-emerald-500' />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Live Activity Log Stream */}
      <div className='flex flex-col gap-2'>
        <span className='text-muted-foreground flex items-center gap-1.5 text-[9px] font-semibold tracking-wide uppercase'>
          <RefreshCw className='text-primary animate-spin-slow size-3.5' />
          Live Session Event Feed (Real-time P2P Sync)
        </span>
        <div className='border-border/50 flex max-h-[150px] flex-col gap-1.5 overflow-y-auto rounded-lg border bg-black/45 p-3 pr-2 font-mono text-[9px] leading-relaxed shadow-inner backdrop-blur-lg'>
          {events.map((e) => (
            <div
              key={e.id}
              className='border-border/20 animate-in fade-in flex items-start gap-2 border-b pb-1.5 duration-300 last:border-0 last:pb-0'
            >
              <span className='text-muted-foreground/60 shrink-0 font-medium select-none'>
                {e.time}
              </span>
              <div className='flex-1 leading-normal break-words'>
                <span className={`font-bold ${e.color}`}>
                  {e.user.split(' ')[0]}
                </span>
                <span className='text-foreground/90 ml-1'>{e.action}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Conflict Resolution Dialog Overlay */}
      <ConflictResolutionModal
        open={conflictOpen}
        conflict={currentConflict}
        onClose={() => setConflictOpen(false)}
        onResolve={handleResolveConflict}
      />
    </div>
  )
}
