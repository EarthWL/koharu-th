'use client'

import React from 'react'
import { useCollabStore } from '@/lib/stores/collabStore'

export function CollaboratorsList() {
  const collaborators = useCollabStore((state) => state.collaborators)
  const list = Object.entries(collaborators)

  if (list.length === 0) return null

  return (
    <div className='bg-background/40 absolute top-4 right-4 z-50 flex items-center gap-1.5 rounded-full border border-white/20 p-1.5 shadow-lg backdrop-blur-md transition-all duration-300'>
      {/* Active collaborators avatar ring */}
      <div className='flex -space-x-2 overflow-hidden'>
        {list.map(([id, info]) => {
          const initials = info.name
            ? info.name.substring(0, 2).toUpperCase()
            : '?'
          return (
            <div
              key={id}
              className='group border-background relative flex h-8 w-8 cursor-help items-center justify-center rounded-full border-2 font-semibold text-white shadow transition-transform duration-200 hover:z-30 hover:-translate-y-1 hover:scale-110'
              style={{
                backgroundColor: info.color,
                zIndex: 10,
              }}
            >
              <span className='text-xs tracking-wider'>{initials}</span>

              {/* Tooltip on hover */}
              <div className='bg-popover/90 text-popover-foreground pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 scale-75 rounded border border-white/10 px-2 py-1 text-[10px] whitespace-nowrap opacity-0 shadow-md backdrop-blur transition-all duration-200 group-hover:scale-100 group-hover:opacity-100'>
                <p className='font-semibold'>{info.name}</p>
                <p className='text-muted-foreground'>
                  หน้า:{' '}
                  {info.activePage !== undefined ? info.activePage + 1 : '-'}
                </p>
              </div>
            </div>
          )
        })}
      </div>

      {/* Pulse indicator of online session */}
      <div className='flex items-center gap-1 px-2 pr-2.5'>
        <span className='relative flex h-2 w-2'>
          <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75'></span>
          <span className='relative inline-flex h-2 w-2 rounded-full bg-emerald-500'></span>
        </span>
        <span className='text-[10px] font-medium tracking-wide text-emerald-500/90 select-none'>
          COLLAB ACTIVE
        </span>
      </div>
    </div>
  )
}
