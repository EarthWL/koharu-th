'use client'

import type { CSSProperties } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  cancelObjectUrlRevoke,
  convertToBlob,
  revokeObjectUrlLater,
} from '@/lib/util'

type ImageProps = {
  data?: Uint8Array
  src?: string
  visible?: boolean
  opacity?: number
  transition?: boolean
  dataKey?: string | number
} & React.ImgHTMLAttributes<HTMLImageElement>

const FADE_DURATION_MS = 180

const TRANSPARENT_GIF =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

// Cross-fade between successive image buffers to avoid UI flicker when
// swapping inpaint results.
export function Image({
  data,
  src,
  visible = true,
  opacity = 1,
  transition = true,
  dataKey,
  style,
  alt = '',
  ...props
}: ImageProps) {
  const dataDep = dataKey ?? src ?? data

  const currentImgRef = useRef<HTMLImageElement>(null)
  const nextImgRef = useRef<HTMLImageElement>(null)
  const plainImgRef = useRef<HTMLImageElement>(null)

  useEffect(() => {
    return () => {
      // Force release texture memory on unmount
      if (currentImgRef.current) currentImgRef.current.src = TRANSPARENT_GIF
      if (nextImgRef.current) nextImgRef.current.src = TRANSPARENT_GIF
      if (plainImgRef.current) plainImgRef.current.src = TRANSPARENT_GIF
    }
  }, [])

  // Simple path without transitions (used for static base image to avoid extra paints)
  const [plainSrc, setPlainSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!transition) {
      if (src) {
        setPlainSrc(src)
        return
      }
      if (!dataDep || !data) {
        setPlainSrc(null)
        return
      }
      const blob = convertToBlob(data)
      const url = URL.createObjectURL(blob)
      cancelObjectUrlRevoke(url)
      setPlainSrc(url)
      return () => revokeObjectUrlLater(url)
    }
    setPlainSrc(null)
    return
  }, [data, dataDep, transition, src])

  if (!transition) {
    return (
      <img
        {...props}
        ref={plainImgRef}
        alt={alt}
        src={visible && plainSrc ? plainSrc : TRANSPARENT_GIF}
        draggable={false}
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          userSelect: 'none',
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          display: visible && plainSrc ? undefined : 'none',
          ...style,
          opacity,
        }}
      />
    )
  }

  const [currentSrc, setCurrentSrc] = useState<string | null>(null)
  const [nextSrc, setNextSrc] = useState<string | null>(null)
  const [crossfade, setCrossfade] = useState(false)

  const currentSrcRef = useRef<string | null>(null)
  const nextSrcRef = useRef<string | null>(null)

  const cleanupUrl = useCallback((url: string | null) => {
    if (url && !url.startsWith('http') && !url.startsWith('/')) {
      revokeObjectUrlLater(url)
    }
  }, [])

  useEffect(() => {
    currentSrcRef.current = currentSrc
  }, [currentSrc])

  useEffect(() => {
    nextSrcRef.current = nextSrc
  }, [nextSrc])

  useEffect(() => {
    return () => {
      cleanupUrl(currentSrcRef.current)
      cleanupUrl(nextSrcRef.current)
    }
  }, [cleanupUrl])

  const promoteNext = useCallback(() => {
    const incoming = nextSrcRef.current
    if (!incoming) return
    const outgoing = currentSrcRef.current

    currentSrcRef.current = incoming
    setCurrentSrc(incoming)
    setNextSrc(null)
    setCrossfade(false)

    if (outgoing && outgoing !== incoming) {
      cleanupUrl(outgoing)
    }
  }, [cleanupUrl])

  useEffect(() => {
    if (src) {
      const incoming = src
      const preload = new window.Image()
      let cancelled = false
      preload.onload = () => {
        if (cancelled) return

        if (!currentSrcRef.current) {
          currentSrcRef.current = incoming
          setCurrentSrc(incoming)
          return
        }

        setNextSrc((prev) => {
          if (prev && prev !== currentSrcRef.current) {
            cleanupUrl(prev)
          }
          return incoming
        })

        setCrossfade(false)
        requestAnimationFrame(() => {
          requestAnimationFrame(() => setCrossfade(true))
        })
      }
      preload.src = incoming
      return () => {
        cancelled = true
      }
    }

    if (!dataDep || !data) {
      cleanupUrl(currentSrcRef.current)
      cleanupUrl(nextSrcRef.current)
      currentSrcRef.current = null
      nextSrcRef.current = null
      setCurrentSrc(null)
      setNextSrc(null)
      setCrossfade(false)
      return
    }

    const blob = convertToBlob(data)
    const objectUrl = URL.createObjectURL(blob)
    cancelObjectUrlRevoke(objectUrl)
    let cancelled = false

    const preload = new window.Image()
    preload.onload = () => {
      if (cancelled) {
        cleanupUrl(objectUrl)
        return
      }

      // First image, render immediately
      if (!currentSrcRef.current) {
        currentSrcRef.current = objectUrl
        setCurrentSrc(objectUrl)
        return
      }

      // Subsequent images: queue and cross-fade
      setNextSrc((prev) => {
        if (prev && prev !== currentSrcRef.current) {
          cleanupUrl(prev)
        }
        return objectUrl
      })

      setCrossfade(false)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setCrossfade(true))
      })
    }

    preload.src = objectUrl

    return () => {
      cancelled = true
      if (
        objectUrl !== currentSrcRef.current &&
        objectUrl !== nextSrcRef.current
      ) {
        cleanupUrl(objectUrl)
      }
    }
  }, [data, dataDep, src, cleanupUrl])

  useEffect(() => {
    if (!nextSrc || !crossfade) return
    const timeout = window.setTimeout(
      promoteNext,
      FADE_DURATION_MS + 50, // safety fallback in case transitionend doesn't fire
    )
    return () => window.clearTimeout(timeout)
  }, [nextSrc, crossfade, promoteNext])

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
      <img
        {...props}
        ref={currentImgRef}
        alt={alt}
        src={visible && currentSrc ? currentSrc : TRANSPARENT_GIF}
        draggable={false}
        style={{
          ...baseStyle,
          display: visible && currentSrc ? undefined : 'none',
          opacity: nextSrc ? (crossfade ? 0 : opacity) : opacity,
          transition:
            nextSrc && crossfade
              ? `opacity ${FADE_DURATION_MS}ms ease`
              : undefined,
        }}
      />
      <img
        {...props}
        ref={nextImgRef}
        alt={alt}
        src={visible && nextSrc ? nextSrc : TRANSPARENT_GIF}
        draggable={false}
        onTransitionEnd={promoteNext}
        style={{
          ...baseStyle,
          display: visible && nextSrc ? undefined : 'none',
          opacity: crossfade ? opacity : 0,
          transition: `opacity ${FADE_DURATION_MS}ms ease`,
        }}
      />
    </>
  )
}
