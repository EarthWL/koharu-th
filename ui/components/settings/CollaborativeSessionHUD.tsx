'use client'

import { useState, useEffect } from 'react'
import { Activity, Users, ShieldAlert, Wifi, Check, Sparkles, RefreshCw } from 'lucide-react'

type LogEvent = {
  id: string
  time: string
  user: string
  avatar: string
  action: string
  color: string
}

const USERS_LIST = [
  { name: 'HetCreep (Lead)', role: 'Owner', active: true, color: 'border-rose-400 bg-rose-500/10 text-rose-400' },
  { name: 'EarthWL (Upstream)', role: 'Maintainer', active: true, color: 'border-blue-400 bg-blue-500/10 text-blue-400' },
  { name: 'Koharu AI Engine', role: 'Copilot', active: true, color: 'border-emerald-400 bg-emerald-500/10 text-emerald-400' },
  { name: 'Claude-4.7-Opus', role: 'Auditor', active: false, color: 'border-purple-400 bg-purple-500/10 text-purple-400' },
]

const EVENT_ACTIONS = [
  { action: 'edited Speech Bubble #14 on Page 3', user: 'HetCreep (Lead)', color: 'text-rose-400' },
  { action: 'approved Manga Glossary term "コハル"', user: 'EarthWL (Upstream)', color: 'text-blue-400' },
  { action: 'completed parallel inpainting on Page 5', user: 'Koharu AI Engine', color: 'text-emerald-400' },
  { action: 'updated character details for "Sayaka"', user: 'HetCreep (Lead)', color: 'text-rose-400' },
  { action: 'triggered Cloud Vision OCR check on Page 12', user: 'Koharu AI Engine', color: 'text-emerald-400' },
  { action: 're-routed Translation failover strategy to backup provider', user: 'EarthWL (Upstream)', color: 'text-blue-400' },
]

export function CollaborativeSessionHUD() {
  const [latency, setLatency] = useState<number>(12)
  const [events, setEvents] = useState<LogEvent[]>([
    { id: '1', time: '20:42:01', user: 'HetCreep (Lead)', avatar: 'H', action: 'initialized collaboration session room #8472', color: 'text-rose-400' },
    { id: '2', time: '20:42:05', user: 'EarthWL (Upstream)', avatar: 'E', action: 'joined translation room', color: 'text-blue-400' },
    { id: '3', time: '20:42:15', user: 'Koharu AI Engine', avatar: 'K', action: 'connected to active LLM provider pipeline', color: 'text-emerald-400' },
  ])

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
      const randomAction = EVENT_ACTIONS[Math.floor(Math.random() * EVENT_ACTIONS.length)]
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
    }, 5000)
    return () => clearInterval(eventInterval)
  }, [])

  return (
    <div className='flex flex-col gap-4 text-xs font-sans text-foreground'>
      {/* Session Header Status */}
      <div className='grid grid-cols-2 gap-2 border-b border-border/50 pb-3'>
        <div className='flex flex-col gap-0.5 bg-background/30 rounded-lg p-2 border border-border/30'>
          <span className='text-muted-foreground uppercase text-[8px] tracking-wider font-bold'>Active Room ID</span>
          <span className='font-mono font-bold text-primary flex items-center gap-1.5 text-xs'>
            <Wifi className='size-3 text-primary animate-pulse' />
            #8472 (P2P Mesh)
          </span>
        </div>
        <div className='flex flex-col gap-0.5 bg-background/30 rounded-lg p-2 border border-border/30'>
          <span className='text-muted-foreground uppercase text-[8px] tracking-wider font-bold'>P2P Connection Latency</span>
          <span className='font-mono font-bold text-emerald-400 flex items-center gap-1.5 text-xs'>
            <Activity className='size-3 text-emerald-400 animate-pulse' />
            {latency} ms (Stable)
          </span>
        </div>
      </div>

      {/* Active Team list */}
      <div className='flex flex-col gap-2'>
        <span className='text-muted-foreground font-semibold flex items-center gap-1.5 uppercase text-[9px] tracking-wide'>
          <Users className='size-3.5 text-primary' />
          Active Team Editors ({USERS_LIST.filter(u => u.active).length} / {USERS_LIST.length})
        </span>
        <div className='grid grid-cols-2 gap-2'>
          {USERS_LIST.map((user) => (
            <div 
              key={user.name} 
              className={`flex items-center gap-2 rounded-lg border p-2 backdrop-blur-sm transition-all duration-300 ${
                user.active ? 'border-border/60 bg-card/65' : 'border-border/30 bg-muted/20 opacity-40'
              }`}
            >
              <div className={`size-5 rounded-full border flex items-center justify-center font-mono text-[9px] font-bold ${user.color}`}>
                {user.name[0]}
              </div>
              <div className='min-w-0 flex-1 flex flex-col gap-0.5'>
                <span className='font-bold text-[10px] truncate text-foreground leading-none'>{user.name.split(' ')[0]}</span>
                <span className='text-[8px] text-muted-foreground leading-none uppercase'>{user.role}</span>
              </div>
              {user.active && (
                <span className='size-1.5 bg-emerald-500 rounded-full animate-ping shrink-0' />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Live Activity Log Stream */}
      <div className='flex flex-col gap-2'>
        <span className='text-muted-foreground font-semibold flex items-center gap-1.5 uppercase text-[9px] tracking-wide'>
          <RefreshCw className='size-3.5 text-primary animate-spin-slow' />
          Live Session Event Feed (Real-time P2P Sync)
        </span>
        <div className='flex flex-col gap-1.5 max-h-[150px] overflow-y-auto bg-black/45 backdrop-blur-lg border border-border/50 rounded-lg p-3 font-mono text-[9px] shadow-inner leading-relaxed pr-2'>
          {events.map((e) => (
            <div key={e.id} className='flex items-start gap-2 border-b border-border/20 pb-1.5 last:border-0 last:pb-0 animate-in fade-in duration-300'>
              <span className='text-muted-foreground/60 select-none font-medium shrink-0'>{e.time}</span>
              <div className='flex-1 leading-normal break-words'>
                <span className={`font-bold ${e.color}`}>{e.user.split(' ')[0]}</span>
                <span className='text-foreground/90 ml-1'>{e.action}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
