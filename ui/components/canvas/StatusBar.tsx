'use client'

import { useTranslation } from 'react-i18next'
import { useCanvasZoom } from '@/hooks/useCanvasZoom'
import { Slider } from '@/components/ui/slider'
import { Button } from '@/components/ui/button'
import {
  MinusIcon,
  PlusIcon,
  Maximize2Icon,
  MoveHorizontalIcon,
  MoveVerticalIcon,
} from 'lucide-react'
import {
  fitCanvasToViewport,
  resetCanvasScale,
  fitCanvasWidthToViewport,
  fitCanvasHeightToViewport,
} from '@/components/Canvas'

export function StatusBar() {
  const { scale, setScale, summary } = useCanvasZoom()
  const { t } = useTranslation()

  const handleZoomOut = () => {
    setScale(Math.max(10, scale - 10))
  }

  const handleZoomIn = () => {
    setScale(Math.min(300, scale + 10))
  }

  return (
    <div className='border-border bg-card text-foreground flex shrink-0 items-center justify-between border-t px-3 py-1 text-xs shadow-sm select-none'>
      {/* Canvas Summary Info (Left) */}
      <span className='text-muted-foreground flex items-center gap-1.5 text-[11px] font-medium'>
        <span className='inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500' />
        {t('statusBar.canvas')}:{' '}
        <span className='text-foreground font-mono font-semibold'>
          {summary}
        </span>
      </span>

      {/* Advanced Zoom & Fit Controls (Right) */}
      <div className='flex items-center gap-2'>
        {/* Fit Options Dropdown / Group */}
        <div className='border-border/80 bg-muted/40 flex items-center rounded border p-0.5 shadow-sm'>
          <Button
            variant='ghost'
            size='icon'
            className='text-muted-foreground hover:text-foreground hover:bg-background/80 h-5 w-7 rounded-sm transition-colors'
            title='Fit Window (พอดีหน้าต่าง)'
            onClick={fitCanvasToViewport}
          >
            <Maximize2Icon className='size-3' />
          </Button>
          <Button
            variant='ghost'
            size='icon'
            className='text-muted-foreground hover:text-foreground hover:bg-background/80 h-5 w-7 rounded-sm transition-colors'
            title='Fit Width (พอดีความกว้าง)'
            onClick={fitCanvasWidthToViewport}
          >
            <MoveHorizontalIcon className='size-3' />
          </Button>
          <Button
            variant='ghost'
            size='icon'
            className='text-muted-foreground hover:text-foreground hover:bg-background/80 h-5 w-7 rounded-sm transition-colors'
            title='Fit Height (พอดีความสูง)'
            onClick={fitCanvasHeightToViewport}
          >
            <MoveVerticalIcon className='size-3' />
          </Button>
          <Button
            variant='ghost'
            className='text-muted-foreground hover:text-foreground hover:bg-background/80 h-5 rounded-sm px-1.5 text-[10px] font-bold transition-colors'
            title='Original Size (ขนาดดั้งเดิม 100%)'
            onClick={resetCanvasScale}
          >
            1:1
          </Button>
        </div>

        {/* Separator */}
        <div className='bg-border h-3 w-px' />

        {/* Zoom Slider and Increments */}
        <div className='bg-muted/30 border-border/40 flex items-center gap-1.5 rounded border px-2 py-0.5'>
          <Button
            variant='ghost'
            size='icon'
            className='text-muted-foreground hover:text-foreground hover:bg-background/80 size-5 rounded-sm transition-colors'
            onClick={handleZoomOut}
            title='Zoom Out (ซูมออก)'
          >
            <MinusIcon className='size-3' />
          </Button>

          <Slider
            data-testid='zoom-slider'
            className='[&_[data-slot=slider-range]]:bg-primary [&_[data-slot=slider-thumb]]:border-primary [&_[data-slot=slider-thumb]]:bg-primary [&_[data-slot=slider-track]]:bg-primary/20 w-32 cursor-pointer [&_[data-slot=slider-thumb]]:size-2.5'
            min={10}
            max={300}
            step={5}
            value={[scale]}
            onValueChange={(v) => setScale(v[0] ?? scale)}
          />

          <Button
            variant='ghost'
            size='icon'
            className='text-muted-foreground hover:text-foreground hover:bg-background/80 size-5 rounded-sm transition-colors'
            onClick={handleZoomIn}
            title='Zoom In (ซูมเข้า)'
          >
            <PlusIcon className='size-3' />
          </Button>

          <span
            data-testid='zoom-value'
            className='text-foreground/90 ml-1 w-11 text-right font-mono text-[11px] font-bold tabular-nums'
          >
            {scale}%
          </span>
        </div>
      </div>
    </div>
  )
}
