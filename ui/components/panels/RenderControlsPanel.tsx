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
  RefreshCwIcon,
  SquareIcon,
  StarIcon,
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
  SearchableSelect,
  type SearchableSelectOption,
} from '@/components/ui/searchable-select'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import { useFontsQuery } from '@/lib/query/hooks'
import { useTextBlockMutations, useDocumentMutations } from '@/lib/query/mutations'
import { cn } from '@/lib/utils'

const DEFAULT_COLOR: RgbaColor = [0, 0, 0, 255]
const DEFAULT_FONT_FAMILIES = ['Arial']
const DEFAULT_EFFECT: RenderEffect = {
  italic: false,
  bold: false,
  fauxItalic: false,
  fauxBold: false,
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
  fauxItalic: effect?.fauxItalic ?? false,
  fauxBold: effect?.fauxBold ?? false,
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
  const { retranslateImage } = useDocumentMutations()
  const { data: availableFonts = [] } = useFontsQuery()
  const fontFamily = usePreferencesStore((state) => state.fontFamily)
  const setFontFamily = usePreferencesStore((state) => state.setFontFamily)
  const favoriteFonts = usePreferencesStore((state) => state.favoriteFonts) || []
  const toggleFavoriteFont = usePreferencesStore((state) => state.toggleFavoriteFont)
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
  const currentBaselineShift =
    selectedBlock?.style?.baselineShiftPx ??
    firstBlock?.style?.baselineShiftPx ??
    0
  const currentHorizontalScale =
    selectedBlock?.style?.horizontalScale ??
    firstBlock?.style?.horizontalScale ??
    1.0
  const fontLabel = t('render.fontLabel')
  const effectLabel = t('render.effectLabel')
  const strokeLabel = t('render.effectBorder')
  const strokeColorLabel = t('render.strokeColorLabel')
  const strokeWidthLabel = t('render.strokeWidthLabel')
  const alignLabel = t('render.alignLabel')
  const currentTextAlign = resolveEffectiveTextAlign(
    selectedBlock ?? firstBlock,
  )
  const scopeLabel =
    selectedBlockIndex !== undefined
      ? t('render.fontScopeBlockIndex', { index: selectedBlockIndex + 1 })
      : t('render.fontScopeGlobal')
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
    baselineShiftPx:
      'baselineShiftPx' in updates
        ? updates.baselineShiftPx
        : style?.baselineShiftPx,
    horizontalScale:
      'horizontalScale' in updates
        ? updates.horizontalScale
        : style?.horizontalScale,
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
    element?: React.ReactNode
    Icon?: ComponentType<{ className?: string }>
  }[] = [
    { key: 'italic', label: t('render.effectItalic'), Icon: ItalicIcon },
    { key: 'bold', label: t('render.effectBold'), Icon: BoldIcon },
    {
      key: 'fauxItalic',
      label: t('render.effectFauxItalic', { defaultValue: 'Faux Italic (Slant)' }),
      element: <span className='text-[10px] font-bold italic tracking-tighter'>I+</span>,
    },
    {
      key: 'fauxBold',
      label: t('render.effectFauxBold', { defaultValue: 'Faux Bold (Thicken)' }),
      element: <span className='text-[10px] font-extrabold tracking-tighter'>B+</span>,
    },
  ]

  const textAlignItems: {
    value: TextAlign
    label: string
    Icon: ComponentType<{ className?: string }>
  }[] = [
    { value: 'left', label: t('render.alignLeft'), Icon: AlignLeftIcon },
    { value: 'center', label: t('render.alignCenter'), Icon: AlignCenterIcon },
    { value: 'right', label: t('render.alignRight'), Icon: AlignRightIcon },
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

        <div className='flex min-w-0 items-start gap-1.5'>
          <div className='min-w-0 flex-1 flex flex-col gap-1.5'>
            <div className='flex items-center gap-1 w-full'>
              <SearchableSelect
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
                options={fontOptions.map(
                  (font): SearchableSelectOption => ({
                    value: font,
                    label: (
                      <span style={{ fontFamily: font }}>{font}</span>
                    ),
                    searchText: font,
                  }),
                )}
                placeholder={t('render.fontPlaceholder')}
                searchPlaceholder={t('render.fontSearchPlaceholder')}
                emptyMessage={t('render.fontEmptyMessage')}
                disabled={fontOptions.length === 0}
                className='h-8 w-full min-w-0'
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant='ghost'
                    size='icon-sm'
                    onClick={() => toggleFavoriteFont(currentFont)}
                    disabled={!currentFont}
                    className={cn(
                      'size-7 shrink-0 transition-colors',
                      favoriteFonts.includes(currentFont) && 'text-amber-400 hover:text-amber-500 bg-amber-400/10'
                    )}
                  >
                    <StarIcon className={cn('size-3.5', favoriteFonts.includes(currentFont) && 'fill-current')} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side='bottom' sideOffset={4}>
                  {favoriteFonts.includes(currentFont) ? t('render.unfavoriteFont', 'Remove from Favorites') : t('render.favoriteFont', 'Add to Favorites')}
                </TooltipContent>
              </Tooltip>
            </div>
            
            {favoriteFonts.length > 0 && (
              <div className='flex flex-wrap gap-1 mt-0.5'>
                {favoriteFonts.map(font => (
                  <Button
                    key={font}
                    variant='outline'
                    size='sm'
                    className={cn(
                      'h-5 px-1.5 text-[9px] font-medium border-border/60 hover:bg-accent/50 transition-colors',
                      currentFont === font && 'bg-primary/10 border-primary/30 text-primary'
                    )}
                    style={{ fontFamily: font }}
                    onClick={() => {
                      const nextFamilies = mergeFontFamilies(font, selectedBlock?.style?.fontFamilies)
                      if (applyStyleToSelected({ fontFamilies: nextFamilies })) return
                      setFontFamily(font)
                      if (!hasBlocks) return
                      const nextBlocks = textBlocks.map((block) => ({
                        ...block,
                        style: buildStyle(block, block.style, {
                          fontFamilies: mergeFontFamilies(font, block.style?.fontFamilies),
                        }),
                      }))
                      void updateTextBlocks(nextBlocks)
                    }}
                    title={font}
                  >
                    {font}
                  </Button>
                ))}
              </div>
            )}
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
                    {Icon ? <Icon className='size-3.5' /> : item.element}
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
        <span 
          className='text-muted-foreground text-[10px] font-medium tracking-wide uppercase cursor-ew-resize select-none hover:text-primary transition-colors'
          title='Drag to adjust size'
          onMouseDown={(e) => {
            if (!hasBlocks) return
            e.preventDefault()
            const startX = e.clientX
            const startVal = currentFontSize ?? 16
            const handleMouseMove = (moveEvent: MouseEvent) => {
              const deltaX = moveEvent.clientX - startX
              const nextVal = Math.max(6, Math.min(300, startVal + Math.round(deltaX / 2)))
              applyStyleToSelected({ fontSize: nextVal }) || applyStyleToAll({ fontSize: nextVal })
            }
            const handleMouseUp = () => {
              window.removeEventListener('mousemove', handleMouseMove)
              window.removeEventListener('mouseup', handleMouseUp)
            }
            window.addEventListener('mousemove', handleMouseMove)
            window.addEventListener('mouseup', handleMouseUp)
          }}
        >
          {t('render.sizeLabel')}
        </span>
        <div className='flex items-center gap-1.5'>
          <NumericStepper
            value={currentFontSize}
            min={6}
            max={300}
            step={1}
            placeholder={t('render.fontSizeAutoPlaceholder')}
            ariaLabel={t('render.ariaFontSize')}
            disabled={!hasBlocks}
            onChange={(v) =>
              applyStyleToSelected({ fontSize: v }) ||
              applyStyleToAll({ fontSize: v })
            }
          />
          <span className='text-muted-foreground text-[10px]'>
            {t('render.sizeHint')}
          </span>
        </div>
      </div>

      <div className='grid w-full min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-1.5'>
        <span 
          className='text-muted-foreground text-[10px] font-medium tracking-wide uppercase cursor-ew-resize select-none hover:text-primary transition-colors'
          title='Drag to adjust line height'
          onMouseDown={(e) => {
            if (!hasBlocks) return
            e.preventDefault()
            const startX = e.clientX
            const startVal = currentLineHeight
            const handleMouseMove = (moveEvent: MouseEvent) => {
              const deltaX = moveEvent.clientX - startX
              const nextVal = Number(Math.max(0.8, Math.min(2.0, startVal + deltaX * 0.005)).toFixed(2))
              applyStyleToSelected({ lineHeight: nextVal }) || applyStyleToAll({ lineHeight: nextVal })
            }
            const handleMouseUp = () => {
              window.removeEventListener('mousemove', handleMouseMove)
              window.removeEventListener('mouseup', handleMouseUp)
            }
            window.addEventListener('mousemove', handleMouseMove)
            window.addEventListener('mouseup', handleMouseUp)
          }}
        >
          {t('render.lineHeightLabel')}
        </span>
        <div className='flex items-center gap-1.5'>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className='flex items-center gap-1'>
                <span 
                  className='text-muted-foreground/70 bg-muted/40 border-border/60 flex size-7 flex-col items-center justify-center rounded-md border text-[9px] font-bold leading-none shrink-0 cursor-ew-resize select-none hover:bg-accent hover:text-primary transition-colors'
                  title='Drag to adjust line height'
                  onMouseDown={(e) => {
                    if (!hasBlocks) return
                    e.preventDefault()
                    const startX = e.clientX
                    const startVal = currentLineHeight
                    const handleMouseMove = (moveEvent: MouseEvent) => {
                      const deltaX = moveEvent.clientX - startX
                      const nextVal = Number(Math.max(0.8, Math.min(2.0, startVal + deltaX * 0.005)).toFixed(2))
                      applyStyleToSelected({ lineHeight: nextVal }) || applyStyleToAll({ lineHeight: nextVal })
                    }
                    const handleMouseUp = () => {
                      window.removeEventListener('mousemove', handleMouseMove)
                      window.removeEventListener('mouseup', handleMouseUp)
                    }
                    window.addEventListener('mousemove', handleMouseMove)
                    window.addEventListener('mouseup', handleMouseUp)
                  }}
                >
                  <span className='translate-y-[1px]'>A</span>
                  <span className='border-t border-muted-foreground/30 w-3 my-[1px]'></span>
                  <span className='-translate-y-[1px]'>A</span>
                </span>
                <NumericStepper
                  value={currentLineHeight}
                  min={0.8}
                  max={2.0}
                  step={0.05}
                  decimals={2}
                  ariaLabel={t('render.ariaLineHeight')}
                  disabled={!hasBlocks}
                  onChange={(v) =>
                    applyStyleToSelected({ lineHeight: v }) ||
                    applyStyleToAll({ lineHeight: v })
                  }
                />
              </div>
            </TooltipTrigger>
            <TooltipContent side='bottom' sideOffset={4}>
              {t('render.lineHeightTooltip', { defaultValue: 'ระยะห่างบรรทัด (Leading A/A) - ตัวคูณความสูง' })}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <div className='flex items-center gap-1'>
                <span 
                  className='text-muted-foreground/70 bg-muted/40 border-border/60 flex size-7 items-center justify-center rounded-md border text-[8px] font-extrabold tracking-tighter shrink-0 cursor-ew-resize select-none hover:bg-accent hover:text-primary transition-colors'
                  title='Drag to adjust letter spacing'
                  onMouseDown={(e) => {
                    if (!hasBlocks) return
                    e.preventDefault()
                    const startX = e.clientX
                    const startVal = currentLetterSpacing
                    const handleMouseMove = (moveEvent: MouseEvent) => {
                      const deltaX = moveEvent.clientX - startX
                      const nextVal = Number(Math.max(-2, Math.min(8, startVal + deltaX * 0.05)).toFixed(1))
                      applyStyleToSelected({ letterSpacingPx: nextVal }) || applyStyleToAll({ letterSpacingPx: nextVal })
                    }
                    const handleMouseUp = () => {
                      window.removeEventListener('mousemove', handleMouseMove)
                      window.removeEventListener('mouseup', handleMouseUp)
                    }
                    window.addEventListener('mousemove', handleMouseMove)
                    window.addEventListener('mouseup', handleMouseUp)
                  }}
                >
                  VA
                </span>
                <NumericStepper
                  value={currentLetterSpacing}
                  min={-2}
                  max={8}
                  step={0.5}
                  decimals={1}
                  ariaLabel={t('render.ariaLetterSpacing')}
                  disabled={!hasBlocks}
                  onChange={(v) =>
                    applyStyleToSelected({ letterSpacingPx: v }) ||
                    applyStyleToAll({ letterSpacingPx: v })
                  }
                />
              </div>
            </TooltipTrigger>
            <TooltipContent side='bottom' sideOffset={4}>
              {t('render.letterSpacingTooltip', { defaultValue: 'ระยะห่างตัวอักษร (Tracking VA) - พิกเซล' })}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className='grid w-full min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-1.5'>
        <span 
          className='text-muted-foreground text-[10px] font-medium tracking-wide uppercase cursor-ew-resize select-none hover:text-primary transition-colors'
          title='Drag to adjust baseline shift'
          onMouseDown={(e) => {
            if (!hasBlocks) return
            e.preventDefault()
            const startX = e.clientX
            const startVal = currentBaselineShift
            const handleMouseMove = (moveEvent: MouseEvent) => {
              const deltaX = moveEvent.clientX - startX
              const nextVal = Math.max(-100, Math.min(100, startVal + Math.round(deltaX / 2)))
              applyStyleToSelected({ baselineShiftPx: nextVal }) || applyStyleToAll({ baselineShiftPx: nextVal })
            }
            const handleMouseUp = () => {
              window.removeEventListener('mousemove', handleMouseMove)
              window.removeEventListener('mouseup', handleMouseUp)
            }
            window.addEventListener('mousemove', handleMouseMove)
            window.addEventListener('mouseup', handleMouseUp)
          }}
        >
          {t('render.baselineShiftLabel', { defaultValue: 'Shift/Scale' })}
        </span>
        <div className='flex items-center gap-1.5'>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className='flex items-center gap-1'>
                <span 
                  className='text-muted-foreground/70 bg-muted/40 border-border/60 flex size-7 items-center justify-center rounded-md border text-[9px] font-bold shrink-0 cursor-ew-resize select-none hover:bg-accent hover:text-primary transition-colors'
                  title='Drag to adjust baseline shift'
                  onMouseDown={(e) => {
                    if (!hasBlocks) return
                    e.preventDefault()
                    const startX = e.clientX
                    const startVal = currentBaselineShift
                    const handleMouseMove = (moveEvent: MouseEvent) => {
                      const deltaX = moveEvent.clientX - startX
                      const nextVal = Math.max(-100, Math.min(100, startVal + Math.round(deltaX / 2)))
                      applyStyleToSelected({ baselineShiftPx: nextVal }) || applyStyleToAll({ baselineShiftPx: nextVal })
                    }
                    const handleMouseUp = () => {
                      window.removeEventListener('mousemove', handleMouseMove)
                      window.removeEventListener('mouseup', handleMouseUp)
                    }
                    window.addEventListener('mousemove', handleMouseMove)
                    window.addEventListener('mouseup', handleMouseUp)
                  }}
                >
                  ΔY
                </span>
                <NumericStepper
                  value={currentBaselineShift}
                  min={-100}
                  max={100}
                  step={1}
                  ariaLabel={t('render.ariaBaselineShift', { defaultValue: 'Baseline Shift' })}
                  disabled={!hasBlocks}
                  onChange={(v) =>
                    applyStyleToSelected({ baselineShiftPx: v }) ||
                    applyStyleToAll({ baselineShiftPx: v })
                  }
                />
              </div>
            </TooltipTrigger>
            <TooltipContent side='bottom' sideOffset={4}>
              {t('render.baselineShiftTooltip', { defaultValue: 'เลื่อนตำแหน่งแนวตั้ง (Baseline Shift) - พิกเซล' })}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <div className='flex items-center gap-1'>
                <span 
                  className='text-muted-foreground/70 bg-muted/40 border-border/60 flex size-7 items-center justify-center rounded-md border text-[9px] font-bold shrink-0 cursor-ew-resize select-none hover:bg-accent hover:text-primary transition-colors'
                  title='Drag to adjust horizontal scale'
                  onMouseDown={(e) => {
                    if (!hasBlocks) return
                    e.preventDefault()
                    const startX = e.clientX
                    const startVal = currentHorizontalScale
                    const handleMouseMove = (moveEvent: MouseEvent) => {
                      const deltaX = moveEvent.clientX - startX
                      const nextVal = Number(Math.max(0.2, Math.min(3.0, startVal + deltaX * 0.005)).toFixed(2))
                      applyStyleToSelected({ horizontalScale: nextVal }) || applyStyleToAll({ horizontalScale: nextVal })
                    }
                    const handleMouseUp = () => {
                      window.removeEventListener('mousemove', handleMouseMove)
                      window.removeEventListener('mouseup', handleMouseUp)
                    }
                    window.addEventListener('mousemove', handleMouseMove)
                    window.addEventListener('mouseup', handleMouseUp)
                  }}
                >
                  ↔
                </span>
                <NumericStepper
                  value={currentHorizontalScale}
                  min={0.2}
                  max={3.0}
                  step={0.05}
                  decimals={2}
                  ariaLabel={t('render.ariaHorizontalScale', { defaultValue: 'Horizontal Scale' })}
                  disabled={!hasBlocks}
                  onChange={(v) =>
                    applyStyleToSelected({ horizontalScale: v }) ||
                    applyStyleToAll({ horizontalScale: v })
                  }
                />
              </div>
            </TooltipTrigger>
            <TooltipContent side='bottom' sideOffset={4}>
              {t('render.horizontalScaleTooltip', { defaultValue: 'ยืด/หดตัวอักษรแนวนอน (Horizontal Scale) - ตัวคูณ' })}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className='grid w-full min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-1.5'>
        <span className='text-muted-foreground text-[10px] font-medium tracking-wide uppercase'>
          {t('render.vAlignLabel')}
        </span>
        <div className='flex items-center gap-1.5'>
          <div className='border-input bg-background inline-flex rounded-md border shadow-xs'>
            {(
              [
                {
                  value: 'top',
                  icon: ArrowUpToLineIcon,
                  label: t('render.vAlignTop'),
                },
                {
                  value: 'middle',
                  icon: AlignVerticalJustifyCenterIcon,
                  label: t('render.vAlignMiddle'),
                },
                {
                  value: 'bottom',
                  icon: ArrowDownToLineIcon,
                  label: t('render.vAlignBottom'),
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
                {t('render.thaiPreset')}
              </Button>
            </TooltipTrigger>
            <TooltipContent side='bottom' sideOffset={4}>
              {t('render.thaiPresetHint')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className='grid w-full min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-1.5'>
        <span className='text-muted-foreground text-[10px] font-medium tracking-wide uppercase'>
          {t('render.minSizeLabel')}
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
                  placeholder={t('render.minSizePlaceholder')}
                  ariaLabel={t('render.ariaMinFontSize')}
                  disabled={!hasBlocks}
                  onChange={(v) =>
                    applyStyleToSelected({ minFontSize: v }) ||
                    applyStyleToAll({ minFontSize: v })
                  }
                />
              </div>
            </TooltipTrigger>
            <TooltipContent side='bottom' sideOffset={4} className='max-w-72'>
              {t('render.minSizeHint')}
            </TooltipContent>
          </Tooltip>
          <span className='text-muted-foreground text-[10px]'>
            {t('render.minSizeShortHint')}
          </span>
        </div>
      </div>

      {/* Re-translate ปุ่มด่วน — ข้าม detect/OCR/inpaint ใช้ผลลัพธ์เดิม */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type='button'
            variant='outline'
            size='sm'
            disabled={!hasBlocks}
            data-testid='render-retranslate'
            className='mt-1 h-7 w-full gap-1.5 px-2 text-[10px]'
            onClick={() => void retranslateImage()}
          >
            <RefreshCwIcon className='size-3' />
            {t('render.retranslate', 'Re-translate (skip inpaint)')}
          </Button>
        </TooltipTrigger>
        <TooltipContent side='bottom' sideOffset={4} className='max-w-64'>
          {t(
            'render.retranslateHint',
            'แปลใหม่โดยไม่รอ inpaint ซ้ำ — ใช้ผลลัพธ์ inpaint เดิม เหมาะสำหรับเปลี่ยน LLM หรือปรับ prompt',
          )}
        </TooltipContent>
      </Tooltip>
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
