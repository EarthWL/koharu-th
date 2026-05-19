'use client'

import { useState } from 'react'
import { Slider } from '@/components/ui/slider'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Zap, Wrench, Settings, Play, Database } from 'lucide-react'

// Define the SettingDescriptor structure locked in v2-arch.md
export type SettingDescriptor =
  | { type: 'slider'; key: string; label: string; min: number; max: number; step: number; defaultValue: number }
  | { type: 'toggle'; key: string; label: string; defaultValue: boolean }
  | { type: 'select'; key: string; label: string; choices: string[]; defaultValue: string }
  | { type: 'number'; key: string; label: string; min?: number; max?: number; defaultValue: number }

const MOCK_SCHEMAS: Record<string, SettingDescriptor[]> = {
  'Anime Text YOLO (Detection)': [
    { type: 'select', key: 'variant', label: 'Model Variant', choices: ['Nano (10MB)', 'Small (30MB)', 'Medium (80MB)', 'Large (150MB)', 'XLarge (250MB)'], defaultValue: 'Small (30MB)' },
    { type: 'slider', key: 'confidence', label: 'Detection Confidence', min: 0.05, max: 0.95, step: 0.05, defaultValue: 0.25 },
    { type: 'toggle', key: 'smart_fallback', label: 'Enable Cloud OCR Fallback', defaultValue: true },
  ],
  'LaMa Inpainting (Clean-up)': [
    { type: 'slider', key: 'max_side', label: 'Max Inpainting Crop Side', min: 256, max: 1024, step: 128, defaultValue: 512 },
    { type: 'toggle', key: 'dynamic_limits', label: 'Enable Parallel Workers (Inpaint Parallel)', defaultValue: true },
    { type: 'number', key: 'cooldown_ms', label: 'GPU Cooling Interval (ms)', min: 100, max: 5000, defaultValue: 500 },
  ],
  'LLM Translate (Translation)': [
    { type: 'select', key: 'fallback_strategy', label: 'Failover Auto-Switch Strategy', choices: ['Sequential', 'Latency-Optimized', 'Cost-Optimized'], defaultValue: 'Sequential' },
    { type: 'number', key: 'max_retries', label: 'Maximum API Retries', min: 1, max: 10, defaultValue: 3 },
    { type: 'toggle', key: 'zeroize_protection', label: 'Zeroize RAM secure cache', defaultValue: true },
  ]
}

export function DynamicEngineSettingsForm() {
  const [activeEngine, setActiveEngine] = useState<string>('Anime Text YOLO (Detection)')
  const [settingsValues, setSettingsValues] = useState<Record<string, any>>(() => {
    const initial: Record<string, any> = {}
    Object.keys(MOCK_SCHEMAS).forEach((engineName) => {
      MOCK_SCHEMAS[engineName].forEach((desc) => {
        initial[`${engineName}_${desc.key}`] = desc.defaultValue
      })
    })
    return initial
  })

  const currentSchema = MOCK_SCHEMAS[activeEngine]

  const updateValue = (key: string, val: any) => {
    setSettingsValues((prev) => ({
      ...prev,
      [`${activeEngine}_${key}`]: val,
    }))
  }

  const getActiveValue = (key: string) => {
    return settingsValues[`${activeEngine}_${key}`]
  }

  // Generate current JSON representation of active profile
  const currentEngineJSON = currentSchema.reduce((acc, desc) => {
    acc[desc.key] = getActiveValue(desc.key)
    return acc;
  }, {} as Record<string, any>);

  return (
    <div className='flex flex-col gap-4 text-xs text-foreground'>
      {/* Header section with engine profiles dropdown */}
      <div className='flex flex-col gap-1.5 border-b border-border/50 pb-3'>
        <label className='text-muted-foreground font-semibold flex items-center gap-1.5 uppercase text-[10px] tracking-wide'>
          <Settings className='size-3 text-primary animate-spin-slow' />
          AI Engine Profile selector (Phase 4 Spec)
        </label>
        <Select value={activeEngine} onValueChange={(v) => setActiveEngine(v)}>
          <SelectTrigger className='w-full bg-background/50 border-primary/20 hover:border-primary/40 transition'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.keys(MOCK_SCHEMAS).map((name) => (
              <SelectItem key={name} value={name} className='text-xs'>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Dynamic Form Controls */}
      <div className='flex flex-col gap-4 min-h-[180px] bg-background/30 rounded-lg p-3.5 border border-border/40 backdrop-blur-sm'>
        {currentSchema.map((desc) => {
          const val = getActiveValue(desc.key)

          return (
            <div key={desc.key} className='flex flex-col gap-1.5 border-b border-border/30 pb-3 last:border-0 last:pb-0'>
              <div className='flex items-center justify-between'>
                <span className='font-medium text-foreground'>{desc.label}</span>
                {desc.type === 'slider' && (
                  <span className='font-mono font-bold text-primary text-[10px] px-1.5 py-0.5 bg-primary/10 rounded border border-primary/10 tabular-nums'>
                    {val}
                  </span>
                )}
                {desc.type === 'number' && (
                  <span className='font-mono font-bold text-accent text-[10px] px-1.5 py-0.5 bg-accent/10 rounded border border-accent/10 tabular-nums'>
                    {val}
                  </span>
                )}
              </div>

              {desc.type === 'slider' && (
                <div className='flex items-center gap-4 py-1'>
                  <Slider
                    min={desc.min}
                    max={desc.max}
                    step={desc.step}
                    value={[val]}
                    onValueChange={(vals) => updateValue(desc.key, vals[0])}
                    className='flex-1'
                  />
                </div>
              )}

              {desc.type === 'toggle' && (
                <div className='flex items-center gap-2 py-1'>
                  <button
                    type='button'
                    role='switch'
                    aria-checked={val}
                    onClick={() => updateValue(desc.key, !val)}
                    className={[
                      'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring duration-200',
                      val ? 'bg-primary' : 'bg-muted-foreground/30',
                    ].join(' ')}
                  >
                    <span
                      className={[
                        'pointer-events-none inline-block size-4 rounded-full bg-background shadow-lg ring-0 transition-transform duration-200',
                        val ? 'translate-x-4' : 'translate-x-0',
                      ].join(' ')}
                    />
                  </button>
                  <span className='text-muted-foreground/70 text-[10px] font-semibold'>
                    {val ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
              )}

              {desc.type === 'select' && (
                <div className='py-0.5'>
                  <Select value={val} onValueChange={(v) => updateValue(desc.key, v)}>
                    <SelectTrigger className='w-full h-8 text-[11px] bg-background/30'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {desc.choices.map((choice) => (
                        <SelectItem key={choice} value={choice} className='text-xs'>
                          {choice}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {desc.type === 'number' && (
                <div className='flex items-center gap-2 py-0.5'>
                  <input
                    type='number'
                    min={desc.min}
                    max={desc.max}
                    value={val}
                    onChange={(e) => updateValue(desc.key, Number(e.target.value))}
                    className='w-full h-8 px-2 border border-border/50 rounded bg-background/20 font-mono text-[11px] focus:outline-none focus:border-primary/50'
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Real-time Setting JSON Output console */}
      <div className='flex flex-col gap-1'>
        <div className='text-muted-foreground font-mono flex items-center gap-1 uppercase text-[8px] tracking-wider'>
          <Zap className='size-2.5 text-amber-500 animate-pulse' />
          Active Engine JSON Profile (Tauri RPC Output)
        </div>
        <pre className='bg-black/55 backdrop-blur-lg border border-border/50 rounded-lg p-3 font-mono text-[9px] text-emerald-400 select-all overflow-x-auto shadow-inner leading-relaxed'>
          {JSON.stringify(currentEngineJSON, null, 2)}
        </pre>
      </div>
    </div>
  )
}
