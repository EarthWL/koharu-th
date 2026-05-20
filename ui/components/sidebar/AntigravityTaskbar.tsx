'use client'

import React from 'react'
import { Sparkles, MessageSquare, Play, Languages } from 'lucide-react'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { useTextBlocks } from '@/hooks/useTextBlocks'
import { cn } from '@/lib/utils'

interface AntigravityTaskbarProps {
  onToggleChat: () => void
  isChatOpen: boolean
  onQuickTranslate: () => void
  isTranslating: boolean
  onPlayTTS: () => void
  isPlayingTTS: boolean
}

export function AntigravityTaskbar({
  onToggleChat,
  isChatOpen,
  onQuickTranslate,
  isTranslating,
  onPlayTTS,
  isPlayingTTS,
}: AntigravityTaskbarProps) {
  const { document: currentDoc, selectedBlockIndex } = useTextBlocks()
  const activeBlock =
    selectedBlockIndex !== undefined && currentDoc?.textBlocks
      ? currentDoc.textBlocks[selectedBlockIndex]
      : null

  if (!currentDoc) return null

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[45] pointer-events-none select-none flex justify-center items-center w-full max-w-xl px-4 animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="pointer-events-auto flex items-center justify-between gap-3 px-4 py-2.5 rounded-full border border-white/10 bg-zinc-950/80 backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.5)] text-zinc-100 w-full transition-all duration-300 hover:border-zinc-700/60">
        {/* Left: Indicator / Active Block Info */}
        <div className="flex items-center gap-2.5 min-w-0 flex-1 pl-1">
          <div className="relative flex size-2 shrink-0">
            <span className={cn(
              "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75",
              activeBlock ? "bg-pink-500" : "bg-emerald-500"
            )}></span>
            <span className={cn(
              "relative inline-flex rounded-full size-2",
              activeBlock ? "bg-pink-500" : "bg-emerald-500"
            )}></span>
          </div>
          
          <div className="flex flex-col min-w-0 text-left">
            <span className="text-[10px] text-zinc-400 font-medium tracking-wider uppercase font-mono">
              {activeBlock && selectedBlockIndex !== undefined ? `Block #${selectedBlockIndex + 1} Selected` : 'Antigravity HUD Active'}
            </span>
            <span className="text-xs font-semibold truncate text-zinc-200 pr-2">
              {activeBlock 
                ? (activeBlock.text || 'No source text') 
                : 'Press Ctrl+Space or Space to summon AI HUD'
              }
            </span>
          </div>
        </div>

        {/* Vertical Separator */}
        <div className="h-6 w-px bg-white/10 shrink-0" />

        {/* Right: Quick Command Buttons */}
        <div className="flex items-center gap-1.5 shrink-0">
          {activeBlock && (
            <>
              {/* Voice Guide (TTS) */}
              <button
                onClick={onPlayTTS}
                disabled={isPlayingTTS}
                title="Play AI Voice Guide (👦 Kenji / 👧 Haruka)"
                className={cn(
                  "p-1.5 rounded-full text-zinc-400 hover:text-zinc-100 hover:bg-white/10 transition-all active:scale-95 duration-200 relative",
                  isPlayingTTS && "text-pink-400 animate-pulse bg-white/5"
                )}
              >
                <Play className="size-4 fill-current" />
              </button>

              {/* Quick Translation */}
              <button
                onClick={onQuickTranslate}
                disabled={isTranslating}
                title="Quick Translate & Inpaint Bubble"
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all active:scale-95 duration-200",
                  isTranslating 
                    ? "bg-white/5 text-zinc-400 border border-white/5 cursor-wait" 
                    : "bg-emerald-600/20 text-emerald-300 border border-emerald-500/20 hover:bg-emerald-600/30 hover:border-emerald-500/40"
                )}
              >
                <Languages className={cn("size-3.5", isTranslating && "animate-spin")} />
                <span>{isTranslating ? 'Translating...' : 'Quick Translate'}</span>
              </button>
            </>
          )}

          {/* AI Command Center Toggle */}
          <button
            onClick={onToggleChat}
            className={cn(
              "flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all duration-200 active:scale-95 shadow-md",
              isChatOpen 
                ? "bg-pink-600 text-white hover:bg-pink-500 shadow-pink-900/30" 
                : "bg-zinc-800 text-zinc-100 hover:bg-zinc-700 hover:text-white"
            )}
          >
            <MessageSquare className="size-3.5" />
            <span>AI HUD</span>
          </button>
        </div>
      </div>
    </div>
  )
}
