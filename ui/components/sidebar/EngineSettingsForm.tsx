'use client'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  RotateCcwIcon,
} from 'lucide-react'
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
import { Button } from '@/components/ui/button'
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
  const { getSetting, setSetting, clearSetting, hasOverride, saving } =
    useEngineProfile()

  if (schema.length === 0) {
    return null // Keep cards tight when the engine has no knobs.
  }

  const overrideCount = schema.filter((s) => hasOverride(engineId, s.id)).length

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
        {overrideCount > 0 && (
          <span
            className='ml-1 rounded bg-primary/15 px-1 text-[9px] font-medium text-primary normal-case'
            title={t(
              'engines.overrideCountTooltip',
              '{{count}} of {{total}} settings overridden from default',
              { count: overrideCount, total: schema.length },
            )}
          >
            {overrideCount} edited
          </span>
        )}
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
                hasOverride={hasOverride(engineId, s.id)}
                onChange={(v) =>
                  setSetting(engineId, s.id, v as StoredValue)
                }
                onReset={() => clearSetting(engineId, s.id)}
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
  hasOverride,
  onChange,
  onReset,
}: {
  setting: SettingDescriptor
  value: LocalValue
  hasOverride: boolean
  onChange: (v: LocalValue) => void
  onReset: () => void
}) {
  const { t } = useTranslation()
  const label = t(setting.labelI18nKey, setting.id)
  const help = setting.helpI18nKey ? t(setting.helpI18nKey, '') : ''
  const resetButton = hasOverride ? (
    <ResetButton onReset={onReset} default={formatDefault(setting)} />
  ) : null

  let control: React.ReactNode
  let header: React.ReactNode

  switch (setting.kind) {
    case 'slider': {
      const v = typeof value === 'number' ? value : setting.default
      header = (
        <FieldHeader label={label} hasOverride={hasOverride}>
          <span className='flex items-center gap-1'>
            <span className='font-mono text-[10px]'>
              {v.toFixed(numericPrecision(setting.step))}
            </span>
            {resetButton}
          </span>
        </FieldHeader>
      )
      control = (
        <Slider
          min={setting.min}
          max={setting.max}
          step={setting.step}
          value={[v]}
          onValueChange={(arr) => onChange(arr[0] ?? setting.default)}
        />
      )
      break
    }
    case 'number_input': {
      const v = typeof value === 'number' ? value : setting.default
      header = (
        <FieldHeader label={label} hasOverride={hasOverride}>
          {resetButton}
        </FieldHeader>
      )
      control = (
        <Input
          type='number'
          min={setting.min}
          max={setting.max}
          step={setting.step}
          value={v}
          onChange={(e) => {
            const raw = Number(e.target.value)
            if (!Number.isFinite(raw)) return
            // Clamp to schema bounds. Typing 99 into a 0-1 field
            // should pin to 1, not send 99 → backend would accept
            // any number, engine settings_schema validation isn't
            // backend-side. Clamp client-side so the persisted
            // value is always in-range.
            const clamped = Math.min(setting.max, Math.max(setting.min, raw))
            onChange(clamped)
          }}
          className='h-7 text-xs'
        />
      )
      break
    }
    case 'toggle': {
      const v = typeof value === 'boolean' ? value : setting.default
      // Toggle keeps the switch on the header row; help renders below.
      return (
        <div className='space-y-1'>
          <FieldHeader label={label} hasOverride={hasOverride}>
            <span className='flex items-center gap-1'>
              {resetButton}
              <Switch checked={v} onCheckedChange={onChange} />
            </span>
          </FieldHeader>
          <HelpText help={help} />
        </div>
      )
    }
    case 'select': {
      const v = typeof value === 'string' ? value : setting.default
      header = (
        <FieldHeader label={label} hasOverride={hasOverride}>
          {resetButton}
        </FieldHeader>
      )
      control = (
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
      )
      break
    }
  }

  return (
    <div className='space-y-1'>
      {header}
      {control}
      <HelpText help={help} />
    </div>
  )
}

/// Visible, wrapped help line under a control. Empty/missing help
/// (i18n key not translated) renders nothing so cards stay tight.
function HelpText({ help }: { help: string }) {
  if (!help) return null
  return (
    <p className='text-muted-foreground/70 text-[10px] leading-snug'>{help}</p>
  )
}

function ResetButton({
  onReset,
  default: defaultLabel,
}: {
  onReset: () => void
  default: string
}) {
  const { t } = useTranslation()
  return (
    <Button
      size='sm'
      variant='ghost'
      className='size-5 p-0 text-muted-foreground hover:text-foreground'
      onClick={onReset}
      title={t('engines.resetSettingTooltip', 'Reset to default ({{default}})', {
        default: defaultLabel,
      })}
      aria-label='Reset to default'
    >
      <RotateCcwIcon className='size-3' />
    </Button>
  )
}

function formatDefault(setting: SettingDescriptor): string {
  switch (setting.kind) {
    case 'slider':
    case 'number_input':
      return setting.default.toFixed(numericPrecision(setting.step))
    case 'toggle':
      return setting.default ? 'on' : 'off'
    case 'select':
      return String(setting.default)
  }
}

function FieldHeader({
  label,
  hasOverride,
  children,
}: {
  label: string
  hasOverride?: boolean
  children?: React.ReactNode
}) {
  return (
    <div className='flex items-center justify-between gap-2'>
      <Label className='flex items-center gap-1 text-[11px] font-medium'>
        {label}
        {hasOverride && (
          <span
            className='inline-block size-1.5 rounded-full bg-primary'
            title='Overridden from default'
          />
        )}
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
