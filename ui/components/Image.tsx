'use client'

import type { CSSProperties } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { blobUrl } from '@/lib/backend'

// ────────────────────────────────────────────────────────────────────
// Image — v2 blob transport version (Phase 2 per #33)
//
// Renders a binary that the backend has registered with `BlobStore`.
// Pass the hex `BlobId` as `blob={hex}`; the component renders
// `<img src="/blob/{hex}">` and the browser handles fetch + native
// decode + HTTP cache (Cache-Control: private, max-age=31536000,
// immutable — safe because the URL IS the content hash).
//
// Pre-v2 this component took `data: Uint8Array`, built an ObjectURL
// per render, and tracked cleanup via `revokeObjectUrl`. All of that
// goes away — the browser cache replaces it.
//
// The cross-fade logic stays. When `blob` changes:
//   1. Preload via a new `Image()` against the new URL.
//   2. On preload load → set `nextSrc`, set crossfade flag two rAFs
//      later (so the layout commits before opacity starts ticking).
//   3. After the CSS transition (or a fallback timeout), promote
//      `next → current`.
// ────────────────────────────────────────────────────────────────────

type ImageProps = {
  /// Hex BlobId from a `DocumentDto` field. Renders as
  /// `<img src="/blob/{blob}">`. `undefined` = nothing rendered.
  blob?: string
  visible?: boolean
  opacity?: number
  transition?: boolean
  /// Optional extra key to force a re-render when the blob hash
  /// hasn't changed but the underlying content semantics did
  /// (e.g. moving to a different page that happens to be a
  /// byte-identical re-import). Default behavior keys on `blob`.
  dataKey?: string | number
} & Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'>

const FADE_DURATION_MS = 180

function toBlobSrc(hex: string | undefined): string | null {
  if (!hex) return null
  return blobUrl(hex)
}

export function Image({
  blob,
  visible = true,
  opacity = 1,
  transition = true,
  dataKey,
  style,
  alt = '',
  ...props
}: ImageProps) {
  // Both branches key on `blob` (or the override `dataKey`) — when
  // it changes the effect re-runs.
  const dep = dataKey ?? blob

  // ── Non-transition path (used by the canvas base image to avoid
  //    extra paints; same shape as before, just URL instead of
  //    ObjectURL). ─────────────────────────────────────────────
  const src = toBlobSrc(blob)
  if (!transition) {
    if (!visible || !src) return null
    return (
      <img
        {...props}
        alt={alt}
        src={src}
        draggable={false}
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          userSelect: 'none',
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          ...style,
          opacity,
        }}
      />
    )
  }

  // ── Cross-fade path ────────────────────────────────────────────
  const [currentSrc, setCurrentSrc] = useState<string | null>(null)
  const [nextSrc, setNextSrc] = useState<string | null>(null)
  const [crossfade, setCrossfade] = useState(false)

  const currentSrcRef = useRef<string | null>(null)
  const nextSrcRef = useRef<string | null>(null)

  useEffect(() => {
    currentSrcRef.current = currentSrc
  }, [currentSrc])

  useEffect(() => {
    nextSrcRef.current = nextSrc
  }, [nextSrc])

  const promoteNext = useCallback(() => {
    const incoming = nextSrcRef.current
    if (!incoming) return
    currentSrcRef.current = incoming
    setCurrentSrc(incoming)
    setNextSrc(null)
    setCrossfade(false)
  }, [])

  useEffect(() => {
    if (!src) {
      currentSrcRef.current = null
      nextSrcRef.current = null
      setCurrentSrc(null)
      setNextSrc(null)
      setCrossfade(false)
      return
    }

    let cancelled = false
    const preload = new window.Image()
    preload.onload = () => {
      if (cancelled) return

      // First image: render immediately, no fade.
      if (!currentSrcRef.current) {
        currentSrcRef.current = src
        setCurrentSrc(src)
        return
      }

      // Subsequent images: queue + cross-fade. If preload picked
      // up a URL identical to the current one (same blob hash) we
      // don't actually need to swap — but harmless to set and
      // promote, the fade collapses to a no-op since both <img>s
      // point at the same src.
      setNextSrc(src)
      setCrossfade(false)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setCrossfade(true))
      })
    }

    preload.src = src

    return () => {
      cancelled = true
    }
  }, [src, dep])

  useEffect(() => {
    if (!nextSrc || !crossfade) return
    const timeout = window.setTimeout(
      promoteNext,
      // Safety fallback in case `transitionend` doesn't fire
      // (e.g. the element was unmounted mid-fade).
      FADE_DURATION_MS + 50,
    )
    return () => window.clearTimeout(timeout)
  }, [nextSrc, crossfade, promoteNext])

  if (!visible || (!currentSrc && !nextSrc)) return null

  const baseStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    userSelect: 'none',
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    ...style,
  }

  return (
    <>
      {currentSrc && (
        <img
          {...props}
          alt={alt}
          src={currentSrc}
          draggable={false}
          style={{
            ...baseStyle,
            opacity: nextSrc ? (crossfade ? 0 : opacity) : opacity,
            transition:
              nextSrc && crossfade
                ? `opacity ${FADE_DURATION_MS}ms ease`
                : undefined,
          }}
        />
      )}
      {nextSrc && (
        <img
          {...props}
          alt={alt}
          src={nextSrc}
          draggable={false}
          onTransitionEnd={promoteNext}
          style={{
            ...baseStyle,
            opacity: crossfade ? opacity : 0,
            transition: `opacity ${FADE_DURATION_MS}ms ease`,
          }}
        />
      )}
    </>
  )
}
