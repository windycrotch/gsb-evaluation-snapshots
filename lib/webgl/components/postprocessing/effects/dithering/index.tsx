'use client'

import { useEffect, useRef, useState } from 'react'
import { Color } from 'three'
import { useStore } from '@/lib/store'
import { DitheringEffect } from './effect'
import { createMatrixTextureManager } from './matrix-texture'

/**
 * Owns a single DitheringEffect instance and keeps its uniforms in sync with
 * the zustand store (driven by the DOM control panel).
 *
 * Matrix-texture ownership is delegated to {@link createMatrixTextureManager},
 * which guarantees each mode switch disposes the previous GPU texture before
 * binding the new one (and that RANDOM releases the last ordered matrix).
 */
export function useDitheringEffect() {
  const [effect] = useState(() => new DitheringEffect())

  const gammaCorrection = useStore((state) => state.gammaCorrection)
  const granularity = useStore((state) => state.granularity)
  const opacity = useStore((state) => state.opacity)
  const color = useStore((state) => state.color)
  const mode = useStore((state) => state.mode)

  useEffect(() => {
    effect.gammaCorrection = gammaCorrection
  }, [effect, gammaCorrection])

  useEffect(() => {
    effect.granularity = granularity
  }, [effect, granularity])

  useEffect(() => {
    effect.opacity = opacity
  }, [effect, opacity])

  const colorRef = useRef(new Color())
  useEffect(() => {
    colorRef.current.setRGB(color.r, color.g, color.b)
    effect.color = colorRef.current
  }, [effect, color])

  useEffect(() => {
    const manager = createMatrixTextureManager(effect)
    manager.setMode(mode)
    // Unmount (or an effect re-run, which cannot happen with these deps) frees
    // the matrix texture currently on the GPU.
    return () => manager.dispose()
  }, [effect, mode])

  return effect
}
