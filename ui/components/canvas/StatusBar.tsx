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
    <div className='border-border bg-card text-foreground flex shrink-0 items-center justify-between border-t px-3 py-1 text-xs select-none shadow-sm'>
      {/* Canvas Summary Info (Left) */}
      <span className='text-muted-foreground font-medium text-[11px] flex items-center gap-1.5'>
        <span className='inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse' />
        {t('statusBar.canvas')}: <span className='text-foreground font-mono font-semibold'>{summary}</span>
      </span>

      {/* Advanced Zoom & Fit Controls (Right) */}
      <div className='flex items-center gap-2'>
        {/* Fit Options Dropdown / Group */}
        <div className='flex items-center border border-border/80 rounded bg-muted/40 p-0.5 shadow-sm'>
          <Button
            variant='ghost'
            size='icon'
            className='h-5 w-7 text-muted-foreground hover:text-foreground rounded-sm hover:bg-background/80 transition-colors'
            title="Fit Window (พอดีหน้าต่าง)"
            onClick={fitCanvasToViewport}
          >
            <Maximize2Icon className='size-3' />
          </Button>
          <Button
            variant='ghost'
            size='icon'
            className='h-5 w-7 text-muted-foreground hover:text-foreground rounded-sm hover:bg-background/80 transition-colors'
            title="Fit Width (พอดีความกว้าง)"
            onClick={fitCanvasWidthToViewport}
          >
            <MoveHorizontalIcon className='size-3' />
          </Button>
          <Button
            variant='ghost'
            size='icon'
            className='h-5 w-7 text-muted-foreground hover:text-foreground rounded-sm hover:bg-background/80 transition-colors'
            title="Fit Height (พอดีความสูง)"
            onClick={fitCanvasHeightToViewport}
          >
            <MoveVerticalIcon className='size-3' />
          </Button>
          <Button
            variant='ghost'
            className='h-5 px-1.5 text-[10px] font-bold text-muted-foreground hover:text-foreground rounded-sm hover:bg-background/80 transition-colors'
            title="Original Size (ขนาดดั้งเดิม 100%)"
            onClick={resetCanvasScale}
          >
            1:1
          </Button>
        </div>

        {/* Separator */}
        <div className='w-px h-3 bg-border' />

        {/* Zoom Slider and Increments */}
        <div className='flex items-center gap-1.5 bg-muted/30 px-2 py-0.5 rounded border border-border/40'>
          <Button
            variant='ghost'
            size='icon'
            className='size-5 text-muted-foreground hover:text-foreground rounded-sm hover:bg-background/80 transition-colors'
            onClick={handleZoomOut}
            title="Zoom Out (ซูมออก)"
          >
            <MinusIcon className='size-3' />
          </Button>
          
          <Slider
            data-testid='zoom-slider'
            className='[&_[data-slot=slider-range]]:bg-primary [&_[data-slot=slider-thumb]]:border-primary [&_[data-slot=slider-thumb]]:bg-primary [&_[data-slot=slider-track]]:bg-primary/20 w-32 [&_[data-slot=slider-thumb]]:size-2.5 cursor-pointer'
            min={10}
            max={300}
            step={5}
            value={[scale]}
            onValueChange={(v) => setScale(v[0] ?? scale)}
          />

          <Button
            variant='ghost'
            size='icon'
            className='size-5 text-muted-foreground hover:text-foreground rounded-sm hover:bg-background/80 transition-colors'
            onClick={handleZoomIn}
            title="Zoom In (ซูมเข้า)"
          >
            <PlusIcon className='size-3' />
          </Button>

          <span data-testid='zoom-value' className='w-11 text-right tabular-nums font-mono font-bold text-foreground/90 text-[11px] ml-1'>
            {scale}%
          </span>
        </div>
      </div>
    </div>
  )
}
