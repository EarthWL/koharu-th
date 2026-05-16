'use client'

import { useEffect, useState, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  AlignVerticalJustifyCenterIcon,
  ArrowDownToLineIcon,
  ArrowUpToLineIcon,
  BoldIcon,
  ItalicIcon,
  LanguagesIcon,
  MinusIcon,
  PlusIcon,
  SquareIcon,
} from 'lucide-react'
import { useTextBlocks } from '@/hooks/useTextBlocks'
import {
  RenderEffect,
  RenderStroke,
  RgbaColor,
  TextAlign,
  TextStyle,
} from '@/types'
import { Button } from '@/components/ui/button'
import { ColorPicker } from '@/components/ui/color-picker'
import { Input } from '@/components/ui/input'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import { useFontsQuery } from '@/lib/query/hooks'
import { useTextBlockMutations } from '@/lib/query/mutations'
import { cn } from '@/lib/utils'

const DEFAULT_COLOR: RgbaColor = [0, 0, 0, 255]
const DEFAULT_FONT_FAMILIES = ['Arial']
const DEFAULT_EFFECT: RenderEffect = {
  italic: false,
  bold: false,
}
const DEFAULT_STROKE: RenderStroke = {
  enabled: true,
  color: [255, 255, 255, 255],
  widthPx: undefined,
}
const DEFAULT_STROKE_WIDTH = 1.6
const MIN_STROKE_WIDTH = 0.2
const MAX_STROKE_WIDTH = 24
const STROKE_WIDTH_STEP = 0.1
const LATIN_ONLY_PATTERN =
  /^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]*$/u

const clampByte = (value: number) =>
  Math.max(0, Math.min(255, Math.round(value)))

const clampStrokeWidth = (value: number) =>
  Number(
    Math.max(MIN_STROKE_WIDTH, Math.min(MAX_STROKE_WIDTH, value)).toFixed(1),
  )

const colorToHex = (color: RgbaColor) =>
  `#${color
    .slice(0, 3)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`

const hexToColor = (value: string, alpha: number): RgbaColor => {
  const normalized = value.replace('#', '')
  if (normalized.length !== 6) {
    return [0, 0, 0, clampByte(alpha)]
  }

  const r = Number.parseInt(normalized.slice(0, 2), 16)
  const g = Number.parseInt(normalized.slice(2, 4), 16)
  const b = Number.parseInt(normalized.slice(4, 6), 16)

  if ([r, g, b].some((channel) => Number.isNaN(channel))) {
    return [0, 0, 0, clampByte(alpha)]
  }

  return [r, g, b, clampByte(alpha)]
}

const uniqueStrings = (values: string[]) => {
  const seen = new Set<string>()
  return values.filter((value) => {
    if (!value || seen.has(value)) return false
    seen.add(value)
    return true
  })
}

const normalizeEffect = (effect?: Partial<RenderEffect>): RenderEffect => ({
  italic: effect?.italic ?? false,
  bold: effect?.bold ?? false,
})

const normalizeStroke = (stroke?: Partial<RenderStroke>): RenderStroke => ({
  enabled: stroke?.enabled ?? true,
  color: stroke?.color ?? DEFAULT_STROKE.color,
  widthPx: stroke?.widthPx,
})

const resolveStyleColor = (
  style: TextStyle | undefined,
  block:
    | {
        fontPrediction?: {
          text_color: [number, number, number]
        }
      }
    | undefined,
  fallbackColor: RgbaColor,
): RgbaColor =>
  style?.color ??
  (block?.fontPrediction?.text_color
    ? [
        block.fontPrediction.text_color[0],
        block.fontPrediction.text_color[1],
        block.fontPrediction.text_color[2],
        255,
      ]
    : fallbackColor)

const resolveEffectiveTextAlign = (
  block:
    | {
        style?: TextStyle
        translation?: string
      }
    | undefined,
): TextAlign => {
  if (block?.style?.textAlign) {
    return block.style.textAlign
  }

  if (block?.translation && LATIN_ONLY_PATTERN.test(block.translation)) {
    return 'center'
  }

  return 'left'
}

export function RenderControlsPanel() {
  const renderEffect = useEditorUiStore((state) => state.renderEffect)
  const renderStroke = useEditorUiStore((state) => state.renderStroke)
  const setRenderEffect = useEditorUiStore((state) => state.setRenderEffect)
  const setRenderStroke = useEditorUiStore((state) => state.setRenderStroke)
  const { updateTextBlocks } = useTextBlockMutations()
  const { data: availableFonts = [] } = useFontsQuery()
  const fontFamily = usePreferencesStore((state) => state.fontFamily)
  const setFontFamily = usePreferencesStore((state) => state.setFontFamily)
  const { textBlocks, selectedBlockIndex, replaceBlock } = useTextBlocks()
  const { t } = useTranslation()
  const selectedBlock =
    selectedBlockIndex !== undefined
      ? textBlocks[selectedBlockIndex]
      : undefined
  const firstBlock = textBlocks[0]
  const hasBlocks = textBlocks.length > 0
  const fallbackFontFamilies =
    availableFonts.length > 0 ? [availableFonts[0]] : DEFAULT_FONT_FAMILIES
  const fallbackColor = firstBlock?.style?.color ?? DEFAULT_COLOR
  const fontCandidates =
    availableFonts.length > 0
      ? availableFonts
      : [
          ...(fontFamily ? [fontFamily] : []),
          ...(selectedBlock?.style?.fontFamilies?.slice(0, 1) ?? []),
          ...DEFAULT_FONT_FAMILIES,
        ]
  const fontOptions = uniqueStrings(fontCandidates)
  const currentFont =
    selectedBlock?.style?.fontFamilies?.[0] ??
    fontFamily ??
    firstBlock?.style?.fontFamilies?.[0] ??
    (hasBlocks ? fallbackFontFamilies[0] : '')
  const currentEffect = normalizeEffect(
    selectedBlock?.style?.effect ?? renderEffect,
  )
  const currentStroke = normalizeStroke(
    selectedBlock?.style?.stroke ?? renderStroke,
  )
  const currentColor =
    selectedBlock?.style?.color ?? (hasBlocks ? fallbackColor : DEFAULT_COLOR)
  const currentColorHex = colorToHex(currentColor)
  const currentStrokeColorHex = colorToHex(currentStroke.color)
  const currentStrokeWidth = currentStroke.widthPx ?? DEFAULT_STROKE_WIDTH
  // New layout controls. When no block is selected the panel is in
  // "global" mode — pick up the firstBlock's values for display so
  // the stepper doesn't appear to "reset" after an apply-all.
  const currentFontSize =
    selectedBlock?.style?.fontSize ?? firstBlock?.style?.fontSize
  const currentLineHeight =
    selectedBlock?.style?.lineHeight ?? firstBlock?.style?.lineHeight ?? 1.0
  const currentLetterSpacing =
    selectedBlock?.style?.letterSpacingPx ??
    firstBlock?.style?.letterSpacingPx ??
    0
  const currentMinFontSize =
    selectedBlock?.style?.minFontSize ?? firstBlock?.style?.minFontSize
  const currentVerticalAlign =
    selectedBlock?.style?.verticalAlign ??
    firstBlock?.style?.verticalAlign ??
    'top'
  const fontLabel = t('render.fontLabel')
  const effectLabel = t('render.effectLabel')
  const strokeLabel = t('render.effectBorder')
  const strokeColorLabel = t('render.strokeColorLabel', {
    defaultValue: 'Stroke color',
  })
  const strokeWidthLabel = t('render.strokeWidthLabel', {
    defaultValue: 'Stroke width',
  })
  const alignLabel = t('render.alignLabel', {
    defaultValue: 'Align',
  })
  const currentTextAlign = resolveEffectiveTextAlign(
    selectedBlock ?? firstBlock,
  )
  const scopeLabel =
    selectedBlockIndex !== undefined
      ? t('render.fontScopeBlockIndex', {
          index: selectedBlockIndex + 1,
          defaultValue: `Block ${selectedBlockIndex + 1}`,
        })
      : t('render.fontScopeGlobal', {
          defaultValue: 'Global',
        })
  const scopeToneClass =
    selectedBlockIndex !== undefined
      ? 'border-primary/20 bg-primary/10 text-primary'
      : 'border-border/60 bg-muted text-muted-foreground'

  const buildStyle = (
    block:
      | {
          style?: TextStyle
          fontPrediction?: {
            text_color: [number, number, number]
          }
        }
      | undefined,
    style: TextStyle | undefined,
    updates: Partial<TextStyle>,
  ): TextStyle => ({
    fontFamilies: updates.fontFamilies ?? style?.fontFamilies ?? [],
    fontSize:
      'fontSize' in updates ? updates.fontSize : style?.fontSize,
    color: updates.color ?? resolveStyleColor(style, block, fallbackColor),
    effect: updates.effect ?? style?.effect,
    stroke: updates.stroke ?? style?.stroke,
    textAlign: updates.textAlign ?? style?.textAlign,
    lineHeight:
      'lineHeight' in updates ? updates.lineHeight : style?.lineHeight,
    letterSpacingPx:
      'letterSpacingPx' in updates
        ? updates.letterSpacingPx
        : style?.letterSpacingPx,
    minFontSize:
      'minFontSize' in updates ? updates.minFontSize : style?.minFontSize,
    verticalAlign:
      'verticalAlign' in updates ? updates.verticalAlign : style?.verticalAlign,
  })

  const applyStyleToSelected = (updates: Partial<TextStyle>) => {
    if (selectedBlockIndex === undefined) return false
    const nextStyle = buildStyle(selectedBlock, selectedBlock?.style, updates)
    void replaceBlock(selectedBlockIndex, { style: nextStyle })
    return true
  }

  const applyStyleToAll = (updates: Partial<TextStyle>) => {
    if (!hasBlocks) return
    const nextBlocks = textBlocks.map((block) => ({
      ...block,
      style: buildStyle(block, block.style, updates),
    }))
    void updateTextBlocks(nextBlocks)
  }

  const mergeFontFamilies = (
    nextFont: string,
    current: string[] | undefined,
  ) => {
    const base = current?.length ? current : fallbackFontFamilies
    return [nextFont, ...base.filter((family) => family !== nextFont)]
  }

  const applyStrokeSetting = (nextStroke: RenderStroke) => {
    const normalized = normalizeStroke(nextStroke)
    if (applyStyleToSelected({ stroke: normalized })) return
    setRenderStroke(normalized)
  }

  const updateStrokeWidth = (value: number) => {
    applyStrokeSetting({
      ...currentStroke,
      widthPx: clampStrokeWidth(value),
    })
  }

  const effectItems: {
    key: keyof RenderEffect
    label: string
    Icon: ComponentType<{ className?: string }>
  }[] = [
    { key: 'italic', label: t('render.effectItalic'), Icon: ItalicIcon },
    { key: 'bold', label: t('render.effectBold'), Icon: BoldIcon },
  ]

  const textAlignItems: {
    value: TextAlign
    label: string
    Icon: ComponentType<{ className?: string }>
  }[] = [
    {
      value: 'left',
      label: t('render.alignLeft', { defaultValue: 'Align left' }),
      Icon: AlignLeftIcon,
    },
    {
      value: 'center',
      label: t('render.alignCenter', { defaultValue: 'Align center' }),
      Icon: AlignCenterIcon,
    },
    {
      value: 'right',
      label: t('render.alignRight', { defaultValue: 'Align right' }),
      Icon: AlignRightIcon,
    },
  ]

  return (
    <div className='flex w-full min-w-0 flex-col gap-1.5'>
      <div className='flex items-center justify-end'>
        <span
          data-testid='render-scope-indicator'
          className={cn(
            'rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase',
            scopeToneClass,
          )}
        >
          {scopeLabel}
        </span>
      </div>

      <div className='grid w-full min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-1.5'>
        <span className='text-muted-foreground text-[10px] font-medium tracking-wide uppercase'>
          {fontLabel}
        </span>

        <div className='flex min-w-0 items-center gap-1.5'>
          <div className='min-w-0 flex-1'>
            <Select
              value={currentFont}
              onValueChange={(value) => {
                const nextFamilies = mergeFontFamilies(
                  value,
                  selectedBlock?.style?.fontFamilies,
                )
                if (applyStyleToSelected({ fontFamilies: nextFamilies })) return
                setFontFamily(value)
                if (!hasBlocks) return
                const nextBlocks = textBlocks.map((block) => ({
                  ...block,
                  style: buildStyle(block, block.style, {
                    fontFamilies: mergeFontFamilies(
                      value,
                      block.style?.fontFamilies,
                    ),
                  }),
                }))
                void updateTextBlocks(nextBlocks)
              }}
              disabled={fontOptions.length === 0}
            >
              <SelectTrigger
                data-testid='render-font-select'
                size='sm'
                className='h-8 w-full min-w-0 text-sm'
                style={currentFont ? { fontFamily: currentFont } : undefined}
              >
                <SelectValue placeholder={t('render.fontPlaceholder')} />
              </SelectTrigger>
              <SelectContent position='popper' className='max-h-80'>
                {fontOptions.map((font, index) => (
                  <SelectItem
                    key={font}
                    value={font}
                    style={{ fontFamily: font, fontSize: '14px', lineHeight: '20px' }}
                    data-testid={`render-font-option-${index}`}
                  >
                    {font}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <ColorPicker
                  value={currentColorHex}
                  disabled={!hasBlocks}
                  triggerTestId='render-color-trigger'
                  pickerTestId='render-color-picker'
                  swatchTestId='render-color-swatch'
                  inputTestId='render-color-input'
                  pickButtonTestId='render-color-pick'
                  onChange={(hex) => {
                    const nextColor = hexToColor(hex, currentColor[3] ?? 255)
                    if (applyStyleToSelected({ color: nextColor })) return
                    applyStyleToAll({ color: nextColor })
                  }}
                  className='h-7 w-7'
                />
              </div>
            </TooltipTrigger>
            <TooltipContent side='bottom' sideOffset={4}>
              {t('render.fontColorLabel')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className='grid w-full min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-1.5'>
        <span className='text-muted-foreground text-[10px] font-medium tracking-wide uppercase'>
          {effectLabel}
        </span>

        <div className='flex min-w-0 flex-wrap items-center gap-1'>
          {effectItems.map((item) => {
            const active = currentEffect[item.key]
            const Icon = item.Icon
            return (
              <Tooltip key={item.key}>
                <TooltipTrigger asChild>
                  <Button
                    variant='outline'
                    size='icon-sm'
                    aria-label={item.label}
                    data-testid={`render-effect-toggle-${item.key}`}
                    className={cn(
                      'size-7',
                      active &&
                        'bg-primary text-primary-foreground border-primary hover:bg-primary/90',
                    )}
                    onClick={() => {
                      const nextEffect = {
                        ...DEFAULT_EFFECT,
                        ...currentEffect,
                        [item.key]: !active,
                      }
                      if (applyStyleToSelected({ effect: nextEffect })) return
                      setRenderEffect(nextEffect)
                    }}
                  >
                    <Icon className='size-3.5' />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side='bottom' sideOffset={4}>
                  {item.label}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      </div>

      <div className='grid w-full min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-1.5'>
        <span className='text-muted-foreground text-[10px] font-medium tracking-wide uppercase'>
          {alignLabel}
        </span>

        <div className='flex min-w-0 flex-wrap items-center gap-1'>
          {textAlignItems.map((item) => {
            const active = currentTextAlign === item.value
            const Icon = item.Icon
            return (
              <Tooltip key={item.value}>
                <TooltipTrigger asChild>
                  <Button
                    variant='outline'
                    size='icon-sm'
                    aria-label={item.label}
                    data-testid={`render-align-${item.value}`}
                    disabled={!hasBlocks}
                    className={cn(
                      'size-7',
                      active &&
                        'bg-primary text-primary-foreground border-primary hover:bg-primary/90',
                    )}
                    onClick={() => {
                      if (applyStyleToSelected({ textAlign: item.value }))
                        return
                      applyStyleToAll({ textAlign: item.value })
                    }}
                  >
                    <Icon className='size-3.5' />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side='bottom' sideOffset={4}>
                  {item.label}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      </div>

      <div className='grid w-full min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-1.5'>
        <span className='text-muted-foreground text-[10px] font-medium tracking-wide uppercase'>
          {strokeLabel}
        </span>

        <div className='flex min-w-0 flex-wrap items-center gap-1'>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant='outline'
                size='icon-sm'
                aria-label={strokeLabel}
                data-testid='render-stroke-enable'
                className={cn(
                  'size-7 shrink-0',
                  currentStroke.enabled &&
                    'bg-primary text-primary-foreground border-primary hover:bg-primary/90',
                )}
                onClick={() =>
                  applyStrokeSetting({
                    ...currentStroke,
                    enabled: !currentStroke.enabled,
                  })
                }
              >
                <SquareIcon className='size-3.5' />
              </Button>
            </TooltipTrigger>
            <TooltipContent side='bottom' sideOffset={4}>
              {strokeLabel}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <ColorPicker
                  value={currentStrokeColorHex}
                  disabled={!hasBlocks}
                  triggerTestId='render-stroke-color-trigger'
                  pickerTestId='render-stroke-color-picker'
                  swatchTestId='render-stroke-color-swatch'
                  inputTestId='render-stroke-color-input'
                  pickButtonTestId='render-stroke-color-pick'
                  onChange={(hex) => {
                    applyStrokeSetting({
                      ...currentStroke,
                      color: hexToColor(hex, currentStroke.color[3] ?? 255),
                    })
                  }}
                  className='h-7 w-7'
                />
              </div>
            </TooltipTrigger>
            <TooltipContent side='bottom' sideOffset={4}>
              {strokeColorLabel}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <div className='border-input bg-background flex w-auto min-w-0 shrink-0 items-center rounded-md border shadow-xs'>
                <Button
                  type='button'
                  variant='ghost'
                  size='icon-sm'
                  aria-label={`${strokeWidthLabel} -`}
                  className='size-7 rounded-r-none border-r'
                  onClick={() =>
                    updateStrokeWidth(currentStrokeWidth - STROKE_WIDTH_STEP)
                  }
                >
                  <MinusIcon className='size-3' />
                </Button>

                <Input
                  type='number'
                  step={String(STROKE_WIDTH_STEP)}
                  min={String(MIN_STROKE_WIDTH)}
                  max={String(MAX_STROKE_WIDTH)}
                  inputMode='decimal'
                  className='h-7 w-14 min-w-0 [appearance:textfield] rounded-none border-0 px-1.5 text-center text-[11px] shadow-none focus-visible:ring-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'
                  data-testid='render-stroke-width'
                  value={
                    Number.isFinite(currentStrokeWidth)
                      ? currentStrokeWidth
                      : DEFAULT_STROKE_WIDTH
                  }
                  onChange={(event) => {
                    const parsed = Number.parseFloat(event.target.value)
                    if (!Number.isFinite(parsed)) return
                    updateStrokeWidth(parsed)
                  }}
                />

                <Button
                  type='button'
                  variant='ghost'
                  size='icon-sm'
                  aria-label={`${strokeWidthLabel} +`}
                  className='size-7 rounded-l-none border-l'
                  onClick={() =>
                    updateStrokeWidth(currentStrokeWidth + STROKE_WIDTH_STEP)
                  }
                >
                  <PlusIcon className='size-3' />
                </Button>
              </div>
            </TooltipTrigger>
            <TooltipContent side='bottom' sideOffset={4}>
              {strokeWidthLabel}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* ============================================================ */}
      {/* Layout controls — Thai-friendly text shaping                  */}
      {/* ============================================================ */}
      <div className='grid w-full min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-1.5'>
        <span className='text-muted-foreground text-[10px] font-medium tracking-wide uppercase'>
          {t('render.sizeLabel', 'Size')}
        </span>
        <div className='flex items-center gap-1.5'>
          <NumericStepper
            value={currentFontSize}
            min={6}
            max={300}
            step={1}
            placeholder='auto'
            ariaLabel='Font size'
            disabled={!hasBlocks}
            onChange={(v) =>
              applyStyleToSelected({ fontSize: v }) ||
              applyStyleToAll({ fontSize: v })
            }
          />
          <span className='text-muted-foreground text-[10px]'>
            {t(
              'render.sizeHint',
              'Empty = auto-fit; set a number to lock the font size.',
            )}
          </span>
        </div>
      </div>

      <div className='grid w-full min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-1.5'>
        <span className='text-muted-foreground text-[10px] font-medium tracking-wide uppercase'>
          {t('render.lineHeightLabel', 'Line ht')}
        </span>
        <div className='flex items-center gap-1.5'>
          <NumericStepper
            value={currentLineHeight}
            min={0.8}
            max={2.0}
            step={0.05}
            decimals={2}
            ariaLabel='Line height'
            disabled={!hasBlocks}
            onChange={(v) =>
              applyStyleToSelected({ lineHeight: v }) ||
              applyStyleToAll({ lineHeight: v })
            }
          />
          <NumericStepper
            value={currentLetterSpacing}
            min={-2}
            max={8}
            step={0.5}
            decimals={1}
            ariaLabel='Letter spacing'
            disabled={!hasBlocks}
            onChange={(v) =>
              applyStyleToSelected({ letterSpacingPx: v }) ||
              applyStyleToAll({ letterSpacingPx: v })
            }
          />
          <span className='text-muted-foreground text-[10px]'>
            {t('render.lineHeightLetterHint', 'mult · px tracking')}
          </span>
        </div>
      </div>

      <div className='grid w-full min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-1.5'>
        <span className='text-muted-foreground text-[10px] font-medium tracking-wide uppercase'>
          {t('render.vAlignLabel', 'V-align')}
        </span>
        <div className='flex items-center gap-1.5'>
          <div className='border-input bg-background inline-flex rounded-md border shadow-xs'>
            {(
              [
                { value: 'top', icon: ArrowUpToLineIcon, label: 'Top' },
                {
                  value: 'middle',
                  icon: AlignVerticalJustifyCenterIcon,
                  label: 'Middle',
                },
                {
                  value: 'bottom',
                  icon: ArrowDownToLineIcon,
                  label: 'Bottom',
                },
              ] as const
            ).map(({ value, icon: Icon, label }, i) => (
              <Tooltip key={value}>
                <TooltipTrigger asChild>
                  <Button
                    type='button'
                    variant='ghost'
                    size='icon-sm'
                    disabled={!hasBlocks}
                    aria-label={label}
                    data-active={currentVerticalAlign === value}
                    className={cn(
                      'size-7 rounded-none data-[active=true]:bg-accent data-[active=true]:text-foreground',
                      i === 0 && 'rounded-l-md',
                      i === 2 && 'rounded-r-md',
                      i !== 0 && 'border-l',
                    )}
                    onClick={() => {
                      applyStyleToSelected({ verticalAlign: value }) ||
                        applyStyleToAll({ verticalAlign: value })
                    }}
                  >
                    <Icon className='size-3.5' />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side='bottom' sideOffset={4}>
                  {label}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type='button'
                variant='outline'
                size='sm'
                disabled={!hasBlocks}
                className='h-7 px-2 text-[10px]'
                onClick={() => {
                  const thaiPreset: Partial<TextStyle> = {
                    lineHeight: 1.35,
                    letterSpacingPx: 0.5,
                    minFontSize: 14,
                    verticalAlign: 'middle',
                  }
                  applyStyleToSelected(thaiPreset) ||
                    applyStyleToAll(thaiPreset)
                }}
              >
                <LanguagesIcon className='size-3' />
                {t('render.thaiPreset', 'Thai preset')}
              </Button>
            </TooltipTrigger>
            <TooltipContent side='bottom' sideOffset={4}>
              {t(
                'render.thaiPresetHint',
                'line height 1.35 · spacing 0.5 px · min size 14 · middle align',
              )}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className='grid w-full min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-1.5'>
        <span className='text-muted-foreground text-[10px] font-medium tracking-wide uppercase'>
          {t('render.minSizeLabel', 'Min size')}
        </span>
        <div className='flex items-center gap-1.5'>
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <NumericStepper
                  value={currentMinFontSize}
                  min={6}
                  max={48}
                  step={1}
                  placeholder='—'
                  ariaLabel='Min font size for auto-fit'
                  disabled={!hasBlocks}
                  onChange={(v) =>
                    applyStyleToSelected({ minFontSize: v }) ||
                    applyStyleToAll({ minFontSize: v })
                  }
                />
              </div>
            </TooltipTrigger>
            <TooltipContent side='bottom' sideOffset={4} className='max-w-72'>
              {t(
                'render.minSizeHint',
                'Auto-fit floor in pixels. Only matters when the bubble is too small for the text — without this, auto-fit can shrink to ~6 px and Thai becomes unreadable. Setting 14 forces text ≥ 14 px even if it has to overflow the bubble.',
              )}
            </TooltipContent>
          </Tooltip>
          <span className='text-muted-foreground text-[10px]'>
            {t(
              'render.minSizeShortHint',
              'Empty = no floor. Only kicks in when auto-fit wants to shrink below this.',
            )}
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * Compact +/- stepper used for the new numeric layout controls.
 *
 * Uses `type='text'` (not `number`) so the browser doesn't strip
 * intermediate "1." while the user is typing "1.35". A local draft
 * string holds the in-flight input; it commits to the parent on blur
 * or when +/- is clicked, and is re-synced from the prop value
 * whenever the input is not focused.
 */
function NumericStepper({
  value,
  min,
  max,
  step,
  decimals = 0,
  placeholder = '',
  ariaLabel,
  disabled,
  onChange,
}: {
  value: number | undefined
  min: number
  max: number
  step: number
  decimals?: number
  placeholder?: string
  ariaLabel: string
  disabled?: boolean
  onChange: (next: number | undefined) => void
}) {
  const clamp = (v: number) =>
    Number(Math.max(min, Math.min(max, v)).toFixed(decimals))
  const canonical = (v: number | undefined) =>
    v === undefined || !Number.isFinite(v) ? '' : clamp(v).toString()

  const [focused, setFocused] = useState(false)
  const [draft, setDraft] = useState(() => canonical(value))

  // Keep the draft in sync with prop changes when the user isn't
  // actively typing — that way step buttons and parent re-renders
  // both show the latest value.
  useEffect(() => {
    if (!focused) setDraft(canonical(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused])

  const commit = (raw: string) => {
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed === '-' || trimmed === '.') {
      onChange(undefined)
      return
    }
    // Accept "1.", "1.3" mid-input — parseFloat handles both.
    const parsed = Number.parseFloat(trimmed)
    if (!Number.isFinite(parsed)) {
      // Bad input — fall back to current value.
      setDraft(canonical(value))
      return
    }
    onChange(clamp(parsed))
  }

  return (
    <div className='border-input bg-background inline-flex w-auto min-w-0 shrink-0 items-center rounded-md border shadow-xs'>
      <Button
        type='button'
        variant='ghost'
        size='icon-sm'
        aria-label={`${ariaLabel} -`}
        disabled={disabled}
        className='size-7 rounded-r-none border-r'
        onClick={() => onChange(clamp((value ?? min) - step))}
      >
        <MinusIcon className='size-3' />
      </Button>
      <Input
        type='text'
        inputMode='decimal'
        aria-label={ariaLabel}
        disabled={disabled}
        placeholder={placeholder}
        className='h-7 w-14 min-w-0 rounded-none border-0 px-1.5 text-center text-[11px] shadow-none focus-visible:ring-0'
        value={draft}
        onFocus={() => setFocused(true)}
        onChange={(e) => {
          // Allow only digits, one optional sign, and one decimal
          // point to land in the draft. Other chars are silently
          // dropped so typing a stray letter doesn't break flow.
          const filtered = e.target.value
            .replace(/[^0-9.\-]/g, '')
            .replace(/(?!^)-/g, '')
            .replace(/(\..*)\./g, '$1')
          setDraft(filtered)
        }}
        onBlur={() => {
          setFocused(false)
          commit(draft)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
      <Button
        type='button'
        variant='ghost'
        size='icon-sm'
        aria-label={`${ariaLabel} +`}
        disabled={disabled}
        className='size-7 rounded-l-none border-l'
        onClick={() => onChange(clamp((value ?? min) + step))}
      >
        <PlusIcon className='size-3' />
      </Button>
    </div>
  )
}
