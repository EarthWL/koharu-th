'use client'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDownIcon, ChevronRightIcon, InfoIcon } from 'lucide-react'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import type { SettingDescriptor, StoredValue } from '@/lib/api'
import { useEngineProfile } from '@/lib/hooks/useEngineProfile'

/// Phase 4.7b + F4.C — auto-generated settings form for one engine.
///
/// Reads the engine's `settingsSchema`, renders the matching control
/// per `kind` (Slider / NumberInput / Toggle / Select). Each value
/// is sourced from the engine profile (with the schema default as
/// fallback); edits persist via `useEngineProfile` (debounced ~300ms
/// to coalesce slider drags into one RPC call).

type LocalValue = number | boolean | string

export function EngineSettingsForm({
  engineId,
  schema,
}: {
  engineId: string
  schema: SettingDescriptor[]
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const { getSetting, setSetting, saving } = useEngineProfile()

  if (schema.length === 0) {
    return null // Keep cards tight when the engine has no knobs.
  }

  return (
    <div className='mt-1 border-t pt-1.5'>
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        className='text-muted-foreground hover:text-foreground flex w-full items-center gap-1 text-[10px] font-semibold uppercase tracking-wide transition-colors'
      >
        {open ? (
          <ChevronDownIcon className='size-3' />
        ) : (
          <ChevronRightIcon className='size-3' />
        )}
        {t('engines.settings', 'Settings')} ({schema.length})
        {saving && (
          <span className='text-muted-foreground ml-1 text-[10px] normal-case'>
            …saving
          </span>
        )}
      </button>

      {open && (
        <div className='mt-1.5 space-y-2 rounded bg-muted/20 p-2'>
          {schema.map((s) => {
            const stored = getSetting(engineId, s.id)
            const value: LocalValue =
              stored !== undefined ? (stored as LocalValue) : (s.default as LocalValue)
            return (
              <SettingControl
                key={s.id}
                setting={s}
                value={value}
                onChange={(v) =>
                  setSetting(engineId, s.id, v as StoredValue)
                }
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function SettingControl({
  setting,
  value,
  onChange,
}: {
  setting: SettingDescriptor
  value: LocalValue
  onChange: (v: LocalValue) => void
}) {
  const { t } = useTranslation()
  const label = t(setting.labelI18nKey, setting.id)
  const help = setting.helpI18nKey
    ? t(setting.helpI18nKey, '')
    : ''

  switch (setting.kind) {
    case 'slider': {
      const v = typeof value === 'number' ? value : setting.default
      return (
        <div className='space-y-1'>
          <FieldHeader label={label} help={help}>
            <span className='font-mono text-[10px]'>
              {v.toFixed(numericPrecision(setting.step))}
            </span>
          </FieldHeader>
          <Slider
            min={setting.min}
            max={setting.max}
            step={setting.step}
            value={[v]}
            onValueChange={(arr) => onChange(arr[0] ?? setting.default)}
          />
        </div>
      )
    }
    case 'number_input': {
      const v = typeof value === 'number' ? value : setting.default
      return (
        <div className='space-y-1'>
          <FieldHeader label={label} help={help} />
          <Input
            type='number'
            min={setting.min}
            max={setting.max}
            step={setting.step}
            value={v}
            onChange={(e) => {
              const next = Number(e.target.value)
              if (Number.isFinite(next)) onChange(next)
            }}
            className='h-7 text-xs'
          />
        </div>
      )
    }
    case 'toggle': {
      const v = typeof value === 'boolean' ? value : setting.default
      return (
        <div className='flex items-center justify-between gap-2'>
          <FieldHeader label={label} help={help} />
          <Switch checked={v} onCheckedChange={onChange} />
        </div>
      )
    }
    case 'select': {
      const v = typeof value === 'string' ? value : setting.default
      return (
        <div className='space-y-1'>
          <FieldHeader label={label} help={help} />
          <Select value={v} onValueChange={onChange}>
            <SelectTrigger className='h-7 text-xs'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {setting.options.map(([optValue, optLabelKey]) => (
                <SelectItem key={optValue} value={optValue}>
                  {t(optLabelKey, optValue)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )
    }
  }
}

function FieldHeader({
  label,
  help,
  children,
}: {
  label: string
  help: string
  children?: React.ReactNode
}) {
  return (
    <div className='flex items-center justify-between gap-2'>
      <Label
        className='flex items-center gap-1 text-[11px] font-medium'
        title={help || undefined}
      >
        {label}
        {help && <InfoIcon className='text-muted-foreground size-2.5' />}
      </Label>
      {children}
    </div>
  )
}

/// `0.01` step → 2 decimals; `0.1` → 1; integer → 0.
/// Cheap pragmatic mapping, no log10 — handles the cases we
/// actually emit from `SettingDescriptor::Slider`.
function numericPrecision(step: number): number {
  if (step >= 1) return 0
  if (step >= 0.1) return 1
  if (step >= 0.01) return 2
  return 3
}

