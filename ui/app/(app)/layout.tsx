'use client'

import { MenuBar } from '@/components/MenuBar'
import { WelcomeGate } from '@/components/Welcome'
import { CommandPalette } from '@/components/CommandPalette'
import { QueueWidget } from '@/components/QueueWidget'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className='bg-background flex h-screen w-screen flex-col overflow-hidden'>
      <MenuBar />
      {children}
      <WelcomeGate />
      <CommandPalette />
      <QueueWidget />
    </div>
  )
}
