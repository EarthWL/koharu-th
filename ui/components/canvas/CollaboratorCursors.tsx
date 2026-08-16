'use client'

import React from 'react'
import { useCollabStore } from '@/lib/stores/collabStore'

type CollaboratorCursorsProps = {
  scaleRatio: number
  width: number
  height: number
  currentPageIndex: number
}

export function CollaboratorCursors({
  scaleRatio,
  width,
  height,
  currentPageIndex,
}: CollaboratorCursorsProps) {
  const collaborators = useCollabStore((state) => state.collaborators)

  return (
    <div className='pointer-events-none absolute inset-0 z-40 overflow-hidden'>
      {Object.entries(collaborators).map(([id, info]) => {
        // Only render cursors on the same page index and having valid coordinate values
        if (
          info.activePage !== currentPageIndex ||
          !info.cursor ||
          typeof info.cursor.x !== 'number' ||
          typeof info.cursor.y !== 'number'
        ) {
          return null
        }

        // Project coordinate: fractional * width/height of the base canvas
        const posX = info.cursor.x * width * scaleRatio
        const posY = info.cursor.y * height * scaleRatio

        return (
          <div
            key={id}
            className='absolute transition-all duration-150 ease-out will-change-[transform,left,top]'
            style={{
              left: posX,
              top: posY,
            }}
          >
            {/* Figma-style beautiful pointing cursor arrow */}
            <svg
              width='24'
              height='24'
              viewBox='0 0 24 24'
              fill='none'
              xmlns='http://www.w3.org/2000/svg'
              className='drop-shadow-md'
            >
              <path
                d='M5.65376 12.3825L19.3458 4.90771C20.603 4.22171 22.0911 5.34023 21.7583 6.74542L18.1565 21.9566C17.8252 23.3562 15.932 23.7077 15.1169 22.5126L11.5173 17.2346L5.85695 14.5422C4.5714 13.9298 4.45524 13.0366 5.65376 12.3825Z'
                fill={info.color}
                stroke='white'
                strokeWidth='2'
                strokeLinejoin='round'
              />
            </svg>

            {/* Name bubble tag */}
            <div
              className='absolute top-4 left-4 rounded-md border border-white/20 px-2 py-0.5 text-[10px] font-bold text-white shadow-lg backdrop-blur-md transition-all duration-300 select-none'
              style={{
                backgroundColor: info.color,
              }}
            >
              {info.name}
            </div>
          </div>
        )
      })}
    </div>
  )
}
