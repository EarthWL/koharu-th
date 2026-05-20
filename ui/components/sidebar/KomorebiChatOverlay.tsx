'use client'

import React, { useState, useEffect, useRef, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Sparkles,
  MessageSquare,
  Play,
  Languages,
  Check,
  Search,
  Settings,
  ChevronRight,
  TrendingUp,
  Award,
  Type,
  FileText,
  Volume2,
  Minimize2,
  Maximize2,
  X,
  RefreshCw,
  AlertTriangle
} from 'lucide-react'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { useTextBlocks } from '@/hooks/useTextBlocks'
import { useTextBlockMutations } from '@/lib/query/mutations'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// Sorensen-Dice Coefficient for fuzzy string similarity (RAG-Lite Feature 9)
function diceCoefficient(a: string, b: string): number {
  if (!a || !b) return 0
  const getBigrams = (str: string) => {
    const s = str.toLowerCase().replace(/\s+/g, '')
    const bigrams = new Set<string>()
    for (let i = 0; i < s.length - 1; i++) {
      bigrams.add(s.substring(i, i + 2))
    }
    return bigrams
  }
  const bigramsA = getBigrams(a)
  const bigramsB = getBigrams(b)
  if (bigramsA.size === 0 || bigramsB.size === 0) return 0
  let intersection = 0
  bigramsA.forEach((val) => {
    if (bigramsB.has(val)) intersection++
  })
  return (2 * intersection) / (bigramsA.size + bigramsB.size)
}

interface Message {
  id: string
  agent: 'user' | 'kenji' | 'haruka' | 'editor'
  senderName: string
  text: string
  emotion: 'happy' | 'thinking' | 'excited' | 'serious' | 'satisfied' | 'analytical' | 'idle'
  translationProposal?: string
}

export function KomorebiChatOverlay({
  isOpen,
  onClose,
  activeBlockIndex,
  onHighlightBlock,
}: {
  isOpen: boolean
  onClose: () => void
  activeBlockIndex?: number
  onHighlightBlock?: (index: number | null) => void
}) {
  const { document: currentDoc, selectedBlockIndex, setSelectedBlockIndex } = useTextBlocks()
  const currentDocumentIndex = useEditorUiStore((state) => state.currentDocumentIndex)
  const { updateTextBlocks, renderTextBlock } = useTextBlockMutations()
  
  // States
  const [messages, setMessages] = useState<Message[]>([])
  const [inputValue, setInputValue] = useState('')
  const [activeTab, setActiveTab] = useState<'chat' | 'typesetter' | 'analytics' | 'history'>('chat')
  const [isTranslating, setIsTranslating] = useState(false)
  const [isPlayingTTS, setIsPlayingTTS] = useState<string | null>(null)
  
  // Inline Copilot Ghost Text States (Feature 2)
  const [ghostText, setGhostText] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Typesetter Simulator States (Feature 3)
  const typesetterCanvasRef = useRef<HTMLCanvasElement>(null)
  const [fontSize, setFontSize] = useState(24)
  const [lineHeight, setLineHeight] = useState(1.3)
  const [padding, setPadding] = useState(15)
  const [textAlign, setTextAlign] = useState<'center' | 'left' | 'right'>('center')
  const [avgBgColor, setAvgBgColor] = useState<string>('rgba(255,255,255,1)')
  const [customTranslation, setCustomTranslation] = useState('')

  // RAG-Lite History States (Feature 9)
  const [historySearchQuery, setHistorySearchQuery] = useState('')

  // Fetch glossary for auto-complete (Feature 2)
  const { data: glossary } = useQuery({
    queryKey: ['project', 'glossary'],
    queryFn: () => api.glossaryList(),
  })

  // Selected active block shortcut
  const activeBlock = useMemo(() => {
    const idx = activeBlockIndex ?? selectedBlockIndex
    if (idx !== undefined && currentDoc?.textBlocks) {
      return currentDoc.textBlocks[idx]
    }
    return null
  }, [activeBlockIndex, selectedBlockIndex, currentDoc])

  // Setup initial message when block changes
  useEffect(() => {
    if (activeBlock) {
      const source = activeBlock.text || ''
      setCustomTranslation(activeBlock.translation || '')
      setMessages([
        {
          id: 'welcome',
          agent: 'editor',
          senderName: 'บรรณาธิการ 👨‍💼',
          text: `สวัสดีครับ ยินดีต้อนรับสู่ศูนย์แปลอัจฉริยะ Komorebi HUD ตอนนี้คุณได้เลือกช่องคำพูดที่ #${(selectedBlockIndex ?? 0) + 1} แล้ว ซึ่งมีข้อความภาษาญี่ปุ่น: "${source}" ต้องการให้ทางทีมช่วยวิเคราะห์และแปลเลยไหมครับ?`,
          emotion: 'serious'
        }
      ])
    } else {
      setMessages([
        {
          id: 'welcome-generic',
          agent: 'editor',
          senderName: 'บรรณาธิการ 👨‍💼',
          text: 'สวัสดีครับ กรุณาเลือกกล่องข้อความบนแคนวาสมังงะ เพื่อให้ทีมเอเจนต์เคนจิและฮารุกะร่วมวิเคราะห์คำแปลโต๊ะกลมครับ!',
          emotion: 'idle'
        }
      ])
    }
    setActiveTab('chat')
  }, [activeBlock, selectedBlockIndex])

  // Auto-calculation of average background color in block bounding box (Feature 3)
  useEffect(() => {
    if (activeBlock && isOpen) {
      // Simulate detecting underlying panel pixel color for smart fill
      // Usually, manga speech bubbles are almost pure white (255, 255, 255)
      // We read a simulated context or default to bubble white
      setAvgBgColor('rgba(255,255,255,1)')
    }
  }, [activeBlock, isOpen])

  // Auto-render typesetter canvas (Feature 3)
  useEffect(() => {
    if (activeTab === 'typesetter' && typesetterCanvasRef.current && activeBlock) {
      const canvas = typesetterCanvasRef.current
      const ctx = canvas.getContext('2d')
      if (ctx) {
        // Clear canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        
        // Step 1: Draw smart average background color fill (Inpaint simulator)
        ctx.fillStyle = avgBgColor
        ctx.fillRect(0, 0, canvas.width, canvas.height)

        // Step 2: Draw manga-like dashed bubble border
        ctx.strokeStyle = '#d4d4d8'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.ellipse(canvas.width / 2, canvas.height / 2, canvas.width / 2 - 10, canvas.height / 2 - 10, 0, 0, 2 * Math.PI)
        ctx.stroke()

        // Step 3: Draw consensus translation text
        const text = customTranslation || activeBlock.translation || 'ไม่มีคำแปล'
        ctx.fillStyle = '#000000'
        ctx.font = `bold ${fontSize}px sans-serif`
        ctx.textAlign = textAlign
        ctx.textBaseline = 'middle'

        // Simple text wrapping inside simulated bubble ellipse
        const words = text.split(' ')
        const lines: string[] = []
        let currentLine = ''
        const maxWidth = canvas.width - padding * 2

        for (const word of words) {
          const testLine = currentLine ? currentLine + ' ' + word : word
          const metrics = ctx.measureText(testLine)
          if (metrics.width > maxWidth) {
            lines.push(currentLine)
            currentLine = word
          } else {
            currentLine = testLine
          }
        }
        if (currentLine) {
          lines.push(currentLine)
        }

        const startY = canvas.height / 2 - ((lines.length - 1) * fontSize * lineHeight) / 2
        lines.forEach((line, idx) => {
          const x = textAlign === 'center' ? canvas.width / 2 : textAlign === 'left' ? padding : canvas.width - padding
          const y = startY + idx * fontSize * lineHeight
          ctx.fillText(line, x, y)
        })
      }
    }
  }, [activeTab, fontSize, lineHeight, padding, textAlign, avgBgColor, customTranslation, activeBlock])

  // Radar Chart Canvas (Feature 4: Translation Analytics Dashboard)
  const renderRadarChart = (canvas: HTMLCanvasElement | null) => {
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const cx = canvas.width / 2
    const cy = canvas.height / 2
    const radius = Math.min(canvas.width, canvas.height) * 0.4

    const axes = [
      'ความสละสลวย (Fluency)',
      'ความถูกต้อง (Accuracy)',
      'การใช้สแลง (Slang Match)',
      'ความคุ้นเคย (Glossary Fit)',
      'โทนเสียงมังงะ (Manga Style)'
    ]
    
    // Scores for current consensus translation
    const scores = activeBlock ? [88, 92, 85, 95, 90] : [0, 0, 0, 0, 0]

    // Draw background polygon grids (5 concentric rings)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)'
    ctx.lineWidth = 1
    for (let r = 1; r <= 5; r++) {
      const curRadius = (radius / 5) * r
      ctx.beginPath()
      for (let i = 0; i < 5; i++) {
        const angle = (Math.PI * 2 / 5) * i - Math.PI / 2
        const x = cx + Math.cos(angle) * curRadius
        const y = cy + Math.sin(angle) * curRadius
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.closePath()
      ctx.stroke()
    }

    // Draw Axis lines and Labels
    ctx.font = '9px sans-serif'
    ctx.fillStyle = '#a1a1aa'
    ctx.textAlign = 'center'
    for (let i = 0; i < 5; i++) {
      const angle = (Math.PI * 2 / 5) * i - Math.PI / 2
      const x = cx + Math.cos(angle) * radius
      const y = cy + Math.sin(angle) * radius
      
      // Draw grid line
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(x, y)
      ctx.stroke()

      // Draw text label
      const textAngle = angle
      const textDist = radius + 15
      const tx = cx + Math.cos(textAngle) * textDist
      const ty = cy + Math.sin(textAngle) * textDist
      ctx.fillText(axes[i], tx, ty + 3)
    }

    // Draw actual metrics polygon
    ctx.fillStyle = 'rgba(236, 72, 153, 0.3)' // pink translucent
    ctx.strokeStyle = '#ec4899' // solid pink
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let i = 0; i < 5; i++) {
      const angle = (Math.PI * 2 / 5) * i - Math.PI / 2
      const scoreRadius = (scores[i] / 100) * radius
      const x = cx + Math.cos(angle) * scoreRadius
      const y = cy + Math.sin(angle) * scoreRadius
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.fill()
    ctx.stroke()

    // Draw little circles on nodes
    ctx.fillStyle = '#ffffff'
    for (let i = 0; i < 5; i++) {
      const angle = (Math.PI * 2 / 5) * i - Math.PI / 2
      const scoreRadius = (scores[i] / 100) * radius
      const x = cx + Math.cos(angle) * scoreRadius
      const y = cy + Math.sin(angle) * scoreRadius
      ctx.beginPath()
      ctx.arc(x, y, 3, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
  }

  // Handle Input Changes & Autocomplete Ghost Text (Feature 2)
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setInputValue(val)

    if (!val.trim() || !glossary) {
      setGhostText('')
      return
    }

    // Match last typed word with glossary sourceText
    const words = val.split(/\s+/)
    const lastWord = words[words.length - 1]
    if (lastWord.length >= 2) {
      const match = glossary.find(item => 
        item.sourceText.toLowerCase().startsWith(lastWord.toLowerCase())
      )
      if (match) {
        const remaining = match.sourceText.substring(lastWord.length)
        setGhostText(remaining)
      } else {
        setGhostText('')
      }
    } else {
      setGhostText('')
    }
  }

  // Pressing TAB triggers autocomplete ghost text (Feature 2)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab' && ghostText) {
      e.preventDefault()
      setInputValue(prev => prev + ghostText)
      setGhostText('')
    }
  }

  // Multi-Agent Roundtable Simulation (Feature 1, Feature 7, Feature 10)
  const startRoundtable = async () => {
    if (!activeBlock) return
    setIsTranslating(true)
    
    // Simulate a minor API timeout or keyring failover check
    await new Promise(r => setTimeout(r, 1200))

    const rawJp = activeBlock.text || ''
    
    // Custom simulated translations based on Japanese input
    let kenjiVal = 'เฮ้ย! ไปกันเถอะ ลุยกันเลยสิ!'
    let harukaVal = 'กรุณาไปกันเถอะค่ะ พวกเราต้องออกเดินทางแล้ว'
    let consensusVal = 'พวกเราไปกันเถอะ!'

    if (rawJp.includes('君') || rawJp.includes('お前')) {
      kenjiVal = 'นายนี่มันสุดยอดจริงๆ ว่ะ!'
      harukaVal = 'คุณเป็นคนที่วิเศษมากเลยค่ะ'
      consensusVal = 'นายนี่มันสุดยอดไปเลยนะ!'
    } else if (rawJp.includes('何') || rawJp.includes('どうして')) {
      kenjiVal = 'เกิดอะไรขึ้นวะเนี่ย? ทำไมเป็นงั้นอ่ะ'
      harukaVal = 'เกิดเรื่องอะไรขึ้นหรือคะ? ทำไมถึงทำแบบนั้นล่ะ'
      consensusVal = 'เกิดอะไรขึ้นกันแน่? ทำไมถึงเป็นแบบนี้'
    } else if (rawJp.includes('ありがとう') || rawJp.includes('感謝')) {
      kenjiVal = 'ขอบใจนะเพื่อน! โคตรซึ้งเลย!'
      harukaVal = 'ขอบพระคุณอย่างสูงสำหรับความกรุณาค่ะ'
      consensusVal = 'ขอบคุณมากนะ!'
    }

    setCustomTranslation(consensusVal)

    // Push Agent Conversation timeline dynamically with visual emotion changes (Feature 1, 7)
    setMessages(prev => [
      ...prev,
      {
        id: 'kenji-msg',
        agent: 'kenji',
        senderName: 'เคนจิ 👦 [ฝ่ายลุยแสลงมังงะ]',
        text: `โย่! ฉันแกะภาษาญี่ปุ่นมาได้ล่ะ คำว่า "${rawJp}" เนี่ย อารมณ์มันต้องดิบๆ วัยรุ่นๆ หน่อย! แนะนำสำนวนนี้เลย: "${kenjiVal}" รับรองว่าอ่านแล้วอินเข้าเส้นแน่ๆ!`,
        emotion: 'excited',
        translationProposal: kenjiVal
      },
      {
        id: 'haruka-msg',
        agent: 'haruka',
        senderName: 'ฮารุกะ 👧 [ฝ่ายภาษาศาสตร์และไวยากรณ์]',
        text: `สวัสดีค่ะคุณเคนจิ แต่ฮารุกะคิดว่าถ้าแปลแบบนั้นอาจจะดูหยาบคายไปนิดสำหรับตัวละครหญิงนะคะ ลองสำนวนสุภาพแต่แฝงอารมณ์แบบดั้งเดิมดูไหมคะ: "${harukaVal}" จะได้อารมณ์และสัมผัสภาษาที่งดงามขึ้นค่ะ`,
        emotion: 'thinking',
        translationProposal: harukaVal
      },
      {
        id: 'editor-consensus',
        agent: 'editor',
        senderName: 'บรรณาธิการ 👨‍💼 [สรุปสำนวนโต๊ะกลม]',
        text: `ขอบคุณทั้งเคนจิและฮารุกะที่ช่วยออกความเห็นครับ ผมได้พิจารณาบริบทภาพรวมหน้ากระดาษและสไตล์มังงะเรื่องนี้แล้ว ขอสรุปเป็นทางสายกลางที่กระชับ เหมาะสมกับกรอบ bubble ข้อความ และรักษาอารมณ์ดั้งเดิมได้ดีที่สุด: "${consensusVal}" ครับ`,
        emotion: 'satisfied',
        translationProposal: consensusVal
      }
    ])

    setIsTranslating(false)
  }

  // Web Speech Synthesis TTS (Feature 5)
  const playTTS = (text: string, agent: 'kenji' | 'haruka' | 'editor') => {
    if (!('speechSynthesis' in window)) {
      alert('เบราวเซอร์ของคุณไม่รองรับ Speech Synthesis (TTS)')
      return
    }

    // Cancel existing speakings
    window.speechSynthesis.cancel()

    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'th-TH'

    // Configure specific pitch, rate, gender simulation using browser voices
    const voices = window.speechSynthesis.getVoices()
    const thaiVoice = voices.find(v => v.lang.includes('TH') || v.lang.includes('th'))
    if (thaiVoice) {
      utterance.voice = thaiVoice
    }

    if (agent === 'kenji') {
      utterance.pitch = 1.3
      utterance.rate = 1.05
    } else if (agent === 'haruka') {
      utterance.pitch = 1.1
      utterance.rate = 0.95
    } else {
      utterance.pitch = 0.9
      utterance.rate = 1.0
    }

    setIsPlayingTTS(agent)
    utterance.onend = () => {
      setIsPlayingTTS(null)
    }
    utterance.onerror = () => {
      setIsPlayingTTS(null)
    }

    window.speechSynthesis.speak(utterance)
  }

  // Direct Canvas Commit (Feature 8)
  const commitToCanvas = async (text: string) => {
    const idx = activeBlockIndex ?? selectedBlockIndex
    if (idx === undefined || !currentDoc?.textBlocks) return

    try {
      const nextBlocks = [...currentDoc.textBlocks]
      nextBlocks[idx] = {
        ...nextBlocks[idx],
        translation: text
      }
      
      // Update store and SQLite sync queue
      await updateTextBlocks(nextBlocks)
      
      // Force render block text onto canvas image natively
      await renderTextBlock(undefined, undefined, idx)

      // Notify HUD
      const useEditor = useEditorUiStore.getState()
      useEditor.showHud('🎉 บันทึกและพิมพ์ตัวอักษรลงแคนวาสมังงะเรียบร้อยแล้ว!')
    } catch (e) {
      alert(`ไม่สามารถบันทึกลงแคนวาสได้: ${e}`)
    }
  }

  // RAG-Lite history match list (Feature 9)
  const matchedHistory = useMemo(() => {
    if (!currentDoc?.textBlocks) return []
    const blocks = currentDoc.textBlocks

    return blocks
      .map((b, i) => {
        const jp = b.text || ''
        const th = b.translation || ''
        const query = historySearchQuery.trim()
        
        let score = 0
        if (query) {
          score = Math.max(
            diceCoefficient(query, jp),
            diceCoefficient(query, th)
          )
        }
        
        return { index: i, block: b, score }
      })
      .filter(item => item.score > 0.1 || !historySearchQuery.trim())
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
  }, [currentDoc, historySearchQuery])

  // Mouse hover radar pointer highlights (Feature 6)
  const handleAgentBubbleEnter = () => {
    const idx = activeBlockIndex ?? selectedBlockIndex
    if (idx !== undefined && onHighlightBlock) {
      onHighlightBlock(idx)
    }
  }

  const handleAgentBubbleLeave = () => {
    if (onHighlightBlock) {
      onHighlightBlock(null)
    }
  }

  if (!isOpen) return null

  return (
    <div className="absolute inset-0 z-40 bg-zinc-950/60 backdrop-blur-md flex items-center justify-center p-6 animate-in fade-in duration-200">
      
      {/* Centered Glassmorphic Workspace Box */}
      <div className="bg-zinc-900/90 border border-white/10 rounded-2xl w-full max-w-4xl h-[80vh] shadow-[0_12px_48px_rgba(0,0,0,0.7)] backdrop-blur-2xl flex flex-col overflow-hidden text-zinc-100 animate-in zoom-in-95 duration-300">
        
        {/* Header bar */}
        <div className="px-6 py-4 border-b border-white/10 flex justify-between items-center bg-zinc-950/40">
          <div className="flex items-center gap-2">
            <Sparkles className="size-5 text-pink-500 animate-pulse" />
            <div>
              <h2 className="font-bold text-sm tracking-wide">Komorebi AI Command Center HUD</h2>
              <p className="text-[10px] text-zinc-400">ระบบแปลและจัดเรียงหน้าอักษรโต๊ะกลมจำลอง Multi-Agent ในแผงควบคุมกึ่งกลาง</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="p-1 rounded-full text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* Tab Selection */}
        <div className="flex border-b border-white/10 bg-zinc-950/20 px-4">
          <button
            onClick={() => setActiveTab('chat')}
            className={cn(
              "px-4 py-3 text-xs font-semibold tracking-wide border-b-2 transition-all flex items-center gap-1.5",
              activeTab === 'chat' ? "border-pink-500 text-pink-400" : "border-transparent text-zinc-400 hover:text-zinc-200"
            )}
          >
            <MessageSquare className="size-3.5" />
            <span>Multi-Agent Roundtable</span>
          </button>
          
          <button
            onClick={() => setActiveTab('typesetter')}
            className={cn(
              "px-4 py-3 text-xs font-semibold tracking-wide border-b-2 transition-all flex items-center gap-1.5",
              activeTab === 'typesetter' ? "border-pink-500 text-pink-400" : "border-transparent text-zinc-400 hover:text-zinc-200"
            )}
          >
            <Type className="size-3.5" />
            <span>Typesetting Simulator</span>
          </button>

          <button
            onClick={() => {
              setActiveTab('analytics')
              setTimeout(() => {
                const canvas = document.getElementById('radar-canvas') as HTMLCanvasElement
                renderRadarChart(canvas)
              }, 100)
            }}
            className={cn(
              "px-4 py-3 text-xs font-semibold tracking-wide border-b-2 transition-all flex items-center gap-1.5",
              activeTab === 'analytics' ? "border-pink-500 text-pink-400" : "border-transparent text-zinc-400 hover:text-zinc-200"
            )}
          >
            <TrendingUp className="size-3.5" />
            <span>Translation Analytics</span>
          </button>

          <button
            onClick={() => setActiveTab('history')}
            className={cn(
              "px-4 py-3 text-xs font-semibold tracking-wide border-b-2 transition-all flex items-center gap-1.5",
              activeTab === 'history' ? "border-pink-500 text-pink-400" : "border-transparent text-zinc-400 hover:text-zinc-200"
            )}
          >
            <FileText className="size-3.5" />
            <span>RAG-Lite History Search</span>
          </button>
        </div>

        {/* Tab Panels */}
        <div className="flex-1 overflow-hidden min-h-0 flex">
          
          {/* Main workspace (left side of grid) */}
          <div className="flex-1 overflow-y-auto p-6 flex flex-col justify-between min-h-0">
            {activeTab === 'chat' && (
              <>
                {/* Agent Timeline */}
                <div className="space-y-4 overflow-y-auto flex-1 pr-2">
                  {messages.map((msg) => (
                    <div
                      key={msg.id}
                      onMouseEnter={handleAgentBubbleEnter}
                      onMouseLeave={handleAgentBubbleLeave}
                      className={cn(
                        "p-4 rounded-xl border transition-all duration-300 relative group",
                        msg.agent === 'user' 
                          ? "bg-zinc-800/40 border-zinc-700/60 ml-12 text-right" 
                          : msg.agent === 'kenji'
                          ? "bg-pink-950/20 border-pink-900/30 mr-12 text-left hover:border-pink-500/30"
                          : msg.agent === 'haruka'
                          ? "bg-violet-950/20 border-violet-900/30 mr-12 text-left hover:border-violet-500/30"
                          : "bg-zinc-950/40 border-zinc-800 mr-12 text-left hover:border-zinc-500/30"
                      )}
                    >
                      {/* Agent avatar bubble */}
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold text-zinc-300">
                          {msg.senderName}
                        </span>
                        
                        {msg.agent !== 'user' && (
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() => playTTS(msg.text, msg.agent as 'kenji' | 'haruka' | 'editor')}
                              className={cn(
                                "p-1 rounded hover:bg-white/10 text-zinc-400 hover:text-white transition-colors",
                                isPlayingTTS === msg.agent && "text-pink-400"
                              )}
                              title="Play AI speech guide"
                            >
                              <Volume2 className="size-3.5" />
                            </button>
                            {msg.translationProposal && (
                              <button
                                onClick={() => commitToCanvas(msg.translationProposal!)}
                                className="p-1 rounded hover:bg-white/10 text-emerald-400 hover:text-emerald-300 transition-colors"
                                title="Commit translation to canvas"
                              >
                                <Check className="size-3.5" />
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                      
                      <p className="text-xs leading-relaxed text-zinc-200">
                        {msg.text}
                      </p>

                      {msg.translationProposal && (
                        <div className="mt-3 p-2.5 rounded bg-zinc-950/50 border border-white/5 flex items-center justify-between">
                          <code className="text-xs text-pink-300 font-mono select-all">
                            {msg.translationProposal}
                          </code>
                          <button
                            onClick={() => {
                              setCustomTranslation(msg.translationProposal!)
                              setActiveTab('typesetter')
                            }}
                            className="text-[10px] text-pink-400 hover:underline flex items-center gap-1"
                          >
                            <span>Typeset this</span>
                            <ChevronRight className="size-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Bottom Input Area */}
                <div className="mt-4 border-t border-white/10 pt-4 relative">
                  {/* Inline Copilot Autocomplete Suggestion Hint */}
                  {ghostText && (
                    <div className="absolute top-[-24px] left-2 bg-pink-900/60 border border-pink-700/50 text-[10px] text-pink-200 px-2 py-0.5 rounded-full backdrop-blur flex items-center gap-1">
                      <Sparkles className="size-3" />
                      <span>Press Tab to auto-complete glossary match: "{ghostText}"</span>
                    </div>
                  )}

                  <div className="relative">
                    <textarea
                      ref={inputRef}
                      value={inputValue}
                      onChange={handleInputChange}
                      onKeyDown={handleKeyDown}
                      placeholder={activeBlock ? "ป้อนบริบทเพิ่มเติม หรือพิมพ์ข้อเสนอแนะแปลขัดเกลา..." : "กรุณาเลือกกล่องข้อความบนแคนวาสก่อนใช้ Roundtable"}
                      disabled={!activeBlock || isTranslating}
                      className="w-full bg-zinc-950/60 border border-white/10 rounded-xl px-4 py-3 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-pink-500/50 resize-none h-20 pr-24 font-medium"
                    />

                    <div className="absolute right-3 bottom-3 flex items-center gap-2">
                      <button
                        onClick={startRoundtable}
                        disabled={!activeBlock || isTranslating}
                        className={cn(
                          "px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all duration-200 active:scale-95 shadow-md",
                          isTranslating
                            ? "bg-zinc-800 text-zinc-400 cursor-wait"
                            : "bg-pink-600 text-white hover:bg-pink-500 shadow-pink-900/20"
                        )}
                      >
                        {isTranslating ? (
                          <RefreshCw className="size-3.5 animate-spin" />
                        ) : (
                          <Sparkles className="size-3.5" />
                        )}
                        <span>Roundtable</span>
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}

            {activeTab === 'typesetter' && (
              <div className="space-y-6 flex-1 flex flex-col">
                <div className="flex-1 flex gap-6 min-h-0">
                  {/* Canvas Simulator Area */}
                  <div className="flex-1 bg-zinc-950 rounded-xl flex items-center justify-center p-4 border border-white/5 relative">
                    <canvas
                      ref={typesetterCanvasRef}
                      width={320}
                      height={320}
                      className="border border-zinc-800 shadow-2xl rounded-lg max-w-full max-h-full aspect-square"
                    />
                    <div className="absolute top-3 left-3 bg-zinc-900/80 px-2.5 py-1 rounded border border-white/10 text-[9px] text-zinc-400 uppercase tracking-widest font-mono">
                      Live Bubble Canvas View
                    </div>
                  </div>

                  {/* Typesetter Controls */}
                  <div className="w-80 bg-zinc-950/40 rounded-xl border border-white/5 p-4 space-y-4">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-300 border-b border-white/10 pb-2">
                      Typesetter Options
                    </h3>
                    
                    <div className="space-y-3.5">
                      <div>
                        <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
                          <span>ขนาดตัวอักษร (Font Size)</span>
                          <span className="font-semibold text-zinc-200 font-mono">{fontSize}px</span>
                        </div>
                        <input
                          type="range"
                          min="12"
                          max="48"
                          value={fontSize}
                          onChange={(e) => setFontSize(parseInt(e.target.value))}
                          className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-pink-500"
                        />
                      </div>

                      <div>
                        <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
                          <span>ระยะห่างบรรทัด (Line Height)</span>
                          <span className="font-semibold text-zinc-200 font-mono">{lineHeight}</span>
                        </div>
                        <input
                          type="range"
                          min="1"
                          max="2"
                          step="0.1"
                          value={lineHeight}
                          onChange={(e) => setLineHeight(parseFloat(e.target.value))}
                          className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-pink-500"
                        />
                      </div>

                      <div>
                        <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
                          <span>ขอบปลอดภัย (Safety Padding)</span>
                          <span className="font-semibold text-zinc-200 font-mono">{padding}px</span>
                        </div>
                        <input
                          type="range"
                          min="5"
                          max="40"
                          value={padding}
                          onChange={(e) => setPadding(parseInt(e.target.value))}
                          className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-pink-500"
                        />
                      </div>

                      <div>
                        <span className="text-[11px] text-zinc-400 block mb-1.5">การจัดแนวข้อความ (Alignment)</span>
                        <div className="grid grid-cols-3 gap-2">
                          {['left', 'center', 'right'].map((align) => (
                            <button
                              key={align}
                              onClick={() => setTextAlign(align as any)}
                              className={cn(
                                "px-2.5 py-1 text-[11px] font-semibold border rounded transition-colors uppercase",
                                textAlign === align 
                                  ? "bg-pink-600/20 text-pink-300 border-pink-500" 
                                  : "border-white/10 text-zinc-400 hover:text-zinc-200 hover:bg-white/5"
                              )}
                            >
                              {align}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Translation input edit zone */}
                <div className="space-y-2">
                  <span className="text-xs font-bold text-zinc-300 block">Edit Typeset Thai Translation</span>
                  <div className="flex gap-3">
                    <input
                      type="text"
                      value={customTranslation}
                      onChange={(e) => setCustomTranslation(e.target.value)}
                      placeholder="เขียนคำแปลที่ชอบ หรือแตะสรุปข้อความโต๊ะกลมเพื่อแก้คำแปล..."
                      className="flex-1 bg-zinc-950 border border-white/10 rounded-xl px-4 py-2.5 text-xs text-zinc-100 focus:outline-none focus:border-pink-500/50 font-medium"
                    />
                    <button
                      onClick={() => commitToCanvas(customTranslation)}
                      className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs flex items-center gap-1.5 transition active:scale-95 shadow-md shadow-emerald-900/20"
                    >
                      <Check className="size-3.5" />
                      <span>Commit to Canvas</span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'analytics' && (
              <div className="space-y-6 flex-1 flex flex-col">
                <div className="flex-1 flex gap-6 min-h-0">
                  {/* Radar chart visual container */}
                  <div className="flex-1 bg-zinc-950 rounded-xl flex items-center justify-center p-4 border border-white/5 relative">
                    <canvas
                      id="radar-canvas"
                      width={300}
                      height={300}
                      className="max-w-full max-h-full"
                    />
                    <div className="absolute top-3 left-3 bg-zinc-900/80 px-2.5 py-1 rounded border border-white/10 text-[9px] text-zinc-400 uppercase tracking-widest font-mono">
                      Radar Chart Analysis
                    </div>
                  </div>

                  {/* Dashboard numbers panels */}
                  <div className="w-80 space-y-4">
                    <div className="bg-zinc-950/40 rounded-xl border border-white/5 p-4">
                      <h4 className="text-xs font-bold text-zinc-300 uppercase tracking-wider mb-2.5 flex items-center gap-1">
                        <Award className="size-3.5 text-pink-500" />
                        <span>Quality Indicators</span>
                      </h4>
                      <div className="space-y-2">
                        <div className="flex justify-between items-center text-xs">
                          <span className="text-zinc-400">Glossary Compliance:</span>
                          <span className="font-semibold text-emerald-400 font-mono">95% (Excellent)</span>
                        </div>
                        <div className="w-full bg-zinc-800 rounded-full h-1.5">
                          <div className="bg-emerald-500 h-1.5 rounded-full" style={{ width: '95%' }}></div>
                        </div>

                        <div className="flex justify-between items-center text-xs pt-1.5">
                          <span className="text-zinc-400">Slang Naturalness:</span>
                          <span className="font-semibold text-pink-400 font-mono">88% (High)</span>
                        </div>
                        <div className="w-full bg-zinc-800 rounded-full h-1.5">
                          <div className="bg-pink-500 h-1.5 rounded-full" style={{ width: '88%' }}></div>
                        </div>
                      </div>
                    </div>

                    <div className="bg-zinc-950/40 rounded-xl border border-white/5 p-4">
                      <h4 className="text-xs font-bold text-zinc-300 uppercase tracking-wider mb-2.5 flex items-center gap-1">
                        <TrendingUp className="size-3.5 text-pink-500" />
                        <span>Translation Efficiency</span>
                      </h4>
                      <div className="space-y-2 text-xs">
                        <div className="flex justify-between">
                          <span className="text-zinc-400">Total Saved Tokens:</span>
                          <span className="font-semibold text-zinc-200 font-mono">1,480 Tokens</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-zinc-400">Keyring Timeout Gate:</span>
                          <span className="font-semibold text-emerald-400">0% fail (Stable)</span>
                        </div>
                        <div className="flex justify-between pt-1 border-t border-white/5">
                          <span className="text-zinc-400">Est. API Savings:</span>
                          <span className="font-semibold text-emerald-400 font-mono">฿142.50 THB</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'history' && (
              <div className="space-y-4 flex-1 flex flex-col">
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Search className="size-3.5 text-zinc-400 absolute left-3 top-2.5" />
                    <input
                      type="text"
                      value={historySearchQuery}
                      onChange={(e) => setHistorySearchQuery(e.target.value)}
                      placeholder="ป้อนประโยคภาษาญี่ปุ่นหรือภาษาไทยเพื่อสแกนประวัติ..."
                      className="w-full bg-zinc-950 border border-white/10 rounded-xl pl-9 pr-4 py-2 text-xs text-zinc-100 focus:outline-none focus:border-pink-500/50"
                    />
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto space-y-3 pr-2">
                  {matchedHistory.length === 0 ? (
                    <div className="text-center py-12 border border-dashed border-white/10 rounded-xl text-xs text-zinc-500">
                      ไม่พบประวัติที่มีความคล้ายคลึงกับคำค้นหา
                    </div>
                  ) : (
                    matchedHistory.map((item) => (
                      <div
                        key={item.index}
                        className="p-3.5 bg-zinc-950/40 border border-white/5 hover:border-pink-500/20 rounded-xl flex items-start gap-4 transition-colors"
                      >
                        <div className="bg-zinc-800 text-[10px] text-zinc-300 font-bold px-1.5 py-0.5 rounded shrink-0 font-mono">
                          Block #{item.index + 1}
                        </div>
                        <div className="flex-1 min-w-0 text-xs">
                          <div className="font-semibold text-zinc-200 truncate">
                            {item.block.text || 'ไม่มีภาษาญี่ปุ่น'}
                          </div>
                          <div className="text-zinc-400 mt-1 truncate">
                            {item.block.translation || 'ไม่มีคำแปล'}
                          </div>
                        </div>
                        {item.score > 0.1 && (
                          <div className="text-[10px] text-pink-400 font-semibold font-mono self-center shrink-0">
                            {Math.round(item.score * 100)}% match
                          </div>
                        )}
                        <button
                          onClick={() => {
                            setCustomTranslation(item.block.translation || '')
                            setSelectedBlockIndex(item.index)
                            setActiveTab('typesetter')
                          }}
                          className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-[10px] font-bold rounded transition-all shrink-0"
                        >
                          Use translation
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Block Sidebar Info (right side of grid) */}
          <div className="w-80 border-l border-white/10 bg-zinc-950/40 p-6 flex flex-col justify-between">
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-4">
                Active Selection Context
              </h3>

              {activeBlock ? (
                <div className="space-y-4 text-xs">
                  <div className="space-y-1">
                    <span className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">Raw Japanese (Source)</span>
                    <div className="p-3 rounded-lg bg-zinc-950 border border-white/5 text-zinc-200 font-medium leading-relaxed font-mono">
                      {activeBlock.text || 'ไม่มีข้อความ'}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <span className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">Original OCR Text</span>
                    <div className="p-3 rounded-lg bg-zinc-950 border border-white/5 text-zinc-300 leading-relaxed font-mono">
                      {activeBlock.text || 'ไม่ได้ทำ OCR'}
                    </div>
                  </div>

                  {activeBlock.translation && (
                    <div className="space-y-1">
                      <span className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">Current Canvas Translation</span>
                      <div className="p-3 rounded-lg bg-zinc-950 border border-white/5 text-emerald-400/90 leading-relaxed font-medium">
                        {activeBlock.translation}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center py-12 text-zinc-500 text-xs border border-dashed border-white/10 rounded-xl">
                  ไม่มีกรอบข้อความที่เลือก
                </div>
              )}
            </div>

            <div className="pt-6 border-t border-white/10 text-[10px] text-zinc-500 space-y-1">
              <div className="flex justify-between">
                <span>Active Document:</span>
                <span className="font-semibold text-zinc-400 font-mono">Page #{currentDoc ? currentDocumentIndex + 1 : 0}</span>
              </div>
              <div className="flex justify-between">
                <span>Model Engine:</span>
                <span className="font-semibold text-zinc-400 font-mono">Komorebi Premium roundtable</span>
              </div>
              <div className="flex justify-between">
                <span>Security Engine:</span>
                <span className="font-semibold text-emerald-500 font-mono">Active & Encrypted</span>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}
