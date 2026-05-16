'use client'

import { useTranslation } from 'react-i18next'
import { LayersIcon, SlidersHorizontalIcon } from 'lucide-react'
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
} from 'react-resizable-panels'
import { LayersPanel } from '@/components/panels/LayersPanel'
import { RenderControlsPanel } from '@/components/panels/RenderControlsPanel'
import { TextBlocksPanel } from '@/components/panels/TextBlocksPanel'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'

const SUBLAYOUT_ID = 'koharu-right-panel-v1'

export function Panels() {
  const { t } = useTranslation()
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: SUBLAYOUT_ID,
    panelIds: ['top', 'bottom'],
  })

  return (
    <div className='bg-muted/50 flex h-full min-h-0 w-full flex-col border-l'>
      <Group
        orientation='vertical'
        id={SUBLAYOUT_ID}
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
        className='flex min-h-0 flex-1'
      >
        <Panel id='top' defaultSize={260} minSize={140} maxSize={600}>
          <Tabs
            defaultValue='layers'
            className='flex h-full min-h-0 flex-col gap-0'
            data-testid='panels-settings-tabs'
          >
            <TabsList className='bg-muted/70 m-2 mb-0 grid w-[calc(100%-1rem)] grid-cols-2'>
              <TabsTrigger
                value='layers'
                data-testid='panels-tab-layers'
                className='gap-1'
              >
                <LayersIcon className='size-3.5' />
                <span className='text-xs font-semibold tracking-wide uppercase'>
                  {t('layers.title')}
                </span>
              </TabsTrigger>
              <TabsTrigger
                value='layout'
                data-testid='panels-tab-layout'
                className='gap-1'
              >
                <SlidersHorizontalIcon className='size-3.5' />
                <span className='text-xs font-semibold tracking-wide uppercase'>
                  {t('panels.render')}
                </span>
              </TabsTrigger>
            </TabsList>

            <TabsContent
              value='layers'
              className='min-h-0 flex-1 px-1 pb-2 data-[state=inactive]:hidden'
              data-testid='panels-layers'
            >
              <ScrollArea className='h-full' viewportClassName='pr-1'>
                <LayersPanel />
              </ScrollArea>
            </TabsContent>

            <TabsContent
              value='layout'
              className='min-h-0 flex-1 px-2 pb-2 data-[state=inactive]:hidden'
              data-testid='panels-layout'
            >
              <ScrollArea className='h-full' viewportClassName='pr-1'>
                <div className='pt-1'>
                  <RenderControlsPanel />
                </div>
              </ScrollArea>
            </TabsContent>
          </Tabs>
        </Panel>

        <Separator className='bg-border/40 hover:bg-border h-1 transition-colors' />

        <Panel id='bottom' minSize={140}>
          <TextBlocksPanel />
        </Panel>
      </Group>
    </div>
  )
}
