'use client'

import { create } from 'zustand'

export type Collaborator = {
  name: string
  color: string
  cursor?: { x: number; y: number }
  activePage?: number
  lastActive: number
}

type CollabState = {
  sessionId: string
  userName: string
  collaborators: Record<string, Collaborator>
  updateCollaborator: (id: string, data: Partial<Collaborator> & { name?: string }) => void
  removeCollaborator: (id: string) => void
  setUserName: (name: string) => void
  clearExpiredCollaborators: () => void
}

// Helper to generate a stable, beautiful HSL color from a session ID hash
function getStableColor(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash)
  }
  const hue = Math.abs(hash % 360)
  // Curated premium HSL: 85% saturation, 65% lightness for beautiful glassmorphism contrast
  return `hsl(${hue}, 85%, 65%)`
}

// Defensive helper to generate a random 8-character session ID
function generateSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().slice(0, 8)
  }
  return Math.random().toString(36).substring(2, 10)
}

// Pick a default fun artist/collaborator name
const defaultNames = [
  'Kira', 'Hana', 'Ren', 'Yuki', 'Aoi', 
  'Haru', 'Momo', 'Sora', 'Kaito', 'Sakura'
]
const randomDefaultName = defaultNames[Math.floor(Math.random() * defaultNames.length)]

export const useCollabStore = create<CollabState>((set) => ({
  sessionId: generateSessionId(),
  userName: typeof window !== 'undefined' ? (localStorage.getItem('collab_username') || randomDefaultName) : randomDefaultName,
  collaborators: {},

  updateCollaborator: (id, data) =>
    set((state) => {
      const existing = state.collaborators[id]
      const updated = {
        name: data.name || existing?.name || `User-${id}`,
        color: existing?.color || getStableColor(id),
        cursor: data.cursor !== undefined ? data.cursor : existing?.cursor,
        activePage: data.activePage !== undefined ? data.activePage : existing?.activePage,
        lastActive: Date.now(),
      }
      return {
        collaborators: {
          ...state.collaborators,
          [id]: updated,
        },
      }
    }),

  removeCollaborator: (id) =>
    set((state) => {
      const next = { ...state.collaborators }
      delete next[id]
      return { collaborators: next }
    }),

  setUserName: (name) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('collab_username', name)
    }
    set({ userName: name })
  },

  clearExpiredCollaborators: () =>
    set((state) => {
      const now = Date.now()
      const next: Record<string, Collaborator> = {}
      let changed = false

      for (const [id, collab] of Object.entries(state.collaborators)) {
        // Expire after 12 seconds of complete inactivity
        if (now - collab.lastActive < 12000) {
          next[id] = collab
        } else {
          changed = true
        }
      }

      return changed ? { collaborators: next } : {}
    }),
}))
