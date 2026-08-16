'use client'

import { useRef, useEffect } from 'react'
import { Panels } from '@/components/Panels'
import { Workspace, StatusBar } from '@/components/Canvas'
import { SidebarTabs } from '@/components/SidebarTabs'
import { ActivityBubble } from '@/components/ActivityBubble'
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  type PanelImperativeHandle,
} from 'react-resizable-panels'
import { AppErrorBoundary } from '@/components/AppErrorBoundary'

const LAYOUT_ID = 'koharu-main-layout-v3'

export default function Page() {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: LAYOUT_ID,
    panelIds: ['left', 'center', 'right'],
  })

  const leftPanelRef = useRef<PanelImperativeHandle>(null)
  const rightPanelRef = useRef<PanelImperativeHandle>(null)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Avoid toggling sidebars when typing in text fields
      const activeEl = document.activeElement
      if (
        activeEl &&
        (activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.getAttribute('contenteditable') === 'true')
      ) {
        return
      }

      const key = e.key.toLowerCase()
      if (e.ctrlKey && key === 'b') {
        e.preventDefault()
        const panel = leftPanelRef.current
        if (panel) {
          if (panel.isCollapsed()) {
            panel.expand()
          } else {
            panel.collapse()
          }
        }
      }

      if (e.ctrlKey && key === 'j') {
        e.preventDefault()
        const panel = rightPanelRef.current
        if (panel) {
          if (panel.isCollapsed()) {
            panel.expand()
          } else {
            panel.collapse()
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <ActivityBubble />
      <Group
        orientation='horizontal'
        id={LAYOUT_ID}
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
        className='flex min-h-0 flex-1'
      >
        <Panel
          id='left'
          panelRef={leftPanelRef}
          collapsible={true}
          defaultSize={320}
          minSize={300}
          maxSize={520}
        >
          <SidebarTabs />
        </Panel>
        <Separator className='bg-border/40 hover:bg-border w-1 transition-colors' />
        <Panel id='center' minSize={480}>
          <AppErrorBoundary>
            <div className='flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden'>
              <Workspace />
              <WorkspaceStatusBar leftPanelRef={leftPanelRef} rightPanelRef={rightPanelRef} />
            </div>
          </AppErrorBoundary>
        </Panel>
        <Separator className='bg-border/40 hover:bg-border w-1 transition-colors' />
        <Panel
          id='right'
          panelRef={rightPanelRef}
          collapsible={true}
          defaultSize={340}
          minSize={300}
          maxSize={560}
        >
          <AppErrorBoundary>
            <Panels />
          </AppErrorBoundary>
        </Panel>
      </Group>
    </div>
  )
}

/**
 * A tiny bar that sits just above the main canvas status bar, adding VS Code-style
 * floating sidebar toggle controls for both the mouse-driven users and keyboard hint discovery.
 */
function WorkspaceStatusBar({
  leftPanelRef,
  rightPanelRef,
}: {
  leftPanelRef: React.RefObject<PanelImperativeHandle | null>
  rightPanelRef: React.RefObject<PanelImperativeHandle | null>
}) {
  const toggleLeft = () => {
    const p = leftPanelRef.current
    if (p) (p.isCollapsed() ? p.expand() : p.collapse())
  }
  const toggleRight = () => {
    const p = rightPanelRef.current
    if (p) (p.isCollapsed() ? p.expand() : p.collapse())
  }

  return (
    <div className='bg-muted/40 border-t border-border flex items-center justify-between px-3 py-1 text-xs shrink-0 select-none'>
      <button
        onClick={toggleLeft}
        title="Toggle Left Sidebar (Ctrl+B)"
        className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 transition px-1.5 py-0.5 rounded bg-muted/60 border border-border/40 shadow-sm"
      >
        <span className="font-semibold text-[10px] tracking-wide">📂 LEFT SIDEBAR</span>
        <span className="text-[9px] opacity-60 font-mono">Ctrl+B</span>
      </button>
      <StatusBar />
      <button
        onClick={toggleRight}
        title="Toggle Right Panel (Ctrl+J)"
        className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 transition px-1.5 py-0.5 rounded bg-muted/60 border border-border/40 shadow-sm"
      >
        <span className="text-[9px] opacity-60 font-mono">Ctrl+J</span>
        <span className="font-semibold text-[10px] tracking-wide">PANELS RIGHT 📂</span>
      </button>
    </div>
  )
}
