'use client'

// ported from mayocream/koharu — utility component that defers rendering
// until after client-side hydration to avoid SSR/hydration mismatches.

import { useEffect, useState, type ReactNode } from 'react'

export function ClientOnly({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  return mounted ? <>{children}</> : null
}

export default ClientOnly
