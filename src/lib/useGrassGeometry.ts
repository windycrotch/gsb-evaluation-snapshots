import { useCallback, useEffect, useRef, useState } from 'react'
import type { BufferGeometry } from 'three'
import {
  createGrassGeometryBuilder,
  GrassGeometryError,
  type GrassBladeParams,
  type GrassGeometryBuilder,
} from '@/shaders/grass/grass'

export type GrassGeometryStatus = 'idle' | 'pending' | 'building' | 'ready' | 'error'

export type UseGrassGeometryOptions = {
  /** Grid the blades are scattered on. Generation fails if it has no position/normal attributes. */
  sourceGeometry: BufferGeometry | null | undefined
  /** Baked-in blade parameters. Any value change triggers a rebuild. */
  bladeParams: GrassBladeParams
  /** Seed for the deterministic random generator. */
  seed: number
  /** Delay before starting a rebuild, so rapid drags cancel each other before doing any work. */
  debounceMs?: number
  /** Time budget per animation frame spent generating blades. */
  frameBudgetMs?: number
}

export type UseGrassGeometryResult = {
  /** Latest fully generated geometry. Kept while a rebuild is pending or running. */
  geometry: BufferGeometry | null
  status: GrassGeometryStatus
  progress: number
  error: string | null
  /** Re-runs the current request, which is how a failed rebuild is recovered. */
  retry: () => void
}

const getErrorMessage = (error: unknown) => {
  if (error instanceof GrassGeometryError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

/** Serializes the baked-in parameters so callers can pass fresh objects on every render. */
const getBladeParamsKey = (params: GrassBladeParams) =>
  [
    params.colorA,
    params.colorB,
    params.colorSamples,
    params.bladesPerPoint,
    params.clusterRadius,
    params.heightVariation.min,
    params.heightVariation.max,
    params.widthVariation.min,
    params.widthVariation.max,
    params.baseDarkness,
  ].join('|')

/** How many percent of progress must change before re-rendering during a build. */
const progressStep = 2

/**
 * Owns the grass geometry lifecycle:
 *
 * - A new build starts only when `sourceGeometry`, `seed` or a baked-in
 *   `bladeParams` value changes. Wind parameters are deliberately absent here,
 *   so tweaking them never rebuilds geometry.
 * - Builds run incrementally across animation frames, so dragging a slider
 *   stays responsive instead of freezing for one long synchronous build.
 * - A newer request cancels the in-flight one immediately. A cancelled build
 *   never replaces the current geometry, and anything it had already produced
 *   is disposed.
 * - If generation fails (for example a grid without normals), the previous
 *   geometry stays in place and the error is surfaced.
 * - Replaced geometry is disposed, and the current geometry plus the in-flight
 *   builder are cleaned up on unmount.
 */
export const useGrassGeometry = ({
  sourceGeometry,
  bladeParams,
  seed,
  debounceMs = 100,
  frameBudgetMs = 6,
}: UseGrassGeometryOptions): UseGrassGeometryResult => {
  const [geometry, setGeometry] = useState<BufferGeometry | null>(null)
  const [status, setStatus] = useState<GrassGeometryStatus>('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const builderRef = useRef<GrassGeometryBuilder | null>(null)
  const frameRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastProgressRef = useRef(-1)
  // Read inside the rebuild effect without making the committed geometry a
  // dependency, which would otherwise restart the build when one completes.
  const hasGeometryRef = useRef(false)

  const bladeParamsKey = getBladeParamsKey(bladeParams)
  const bladeParamsRef = useRef(bladeParams)
  const [retryToken, setRetryToken] = useState(0)

  // Declared before the rebuild effect so the latter always reads the latest
  // values without depending on the (possibly fresh) params object identity.
  useEffect(() => {
    bladeParamsRef.current = bladeParams
  }, [bladeParams])

  const cancelPendingWork = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }

    const builder = builderRef.current
    builderRef.current = null
    // Disposes anything the cancelled build had already produced.
    builder?.cancel()
  }, [])

  useEffect(() => {
    // Any previous request is superseded by this one.
    cancelPendingWork()

    if (!sourceGeometry) {
      setStatus('idle')
      setProgress(0)
      return
    }

    const runBuild = () => {
      let builder: GrassGeometryBuilder

      try {
        builder = createGrassGeometryBuilder({
          geometry: sourceGeometry,
          seed: Math.round(seed),
          ...bladeParamsRef.current,
        })
      } catch (buildError) {
        // Keep whatever geometry is currently displayed.
        setStatus('error')
        setError(getErrorMessage(buildError))
        setProgress(0)
        return
      }

      builderRef.current = builder
      lastProgressRef.current = -1
      setStatus('building')
      setProgress(0)
      setError(null)

      const tick = () => {
        frameRef.current = null

        const activeBuilder = builderRef.current
        if (!activeBuilder || activeBuilder.cancelled) return

        const done = activeBuilder.step(frameBudgetMs)

        if (activeBuilder.cancelled) return

        const percent = Math.round(activeBuilder.progress * 100)
        if (percent !== lastProgressRef.current && percent - lastProgressRef.current >= progressStep) {
          lastProgressRef.current = percent
          setProgress(percent / 100)
        }

        if (!done) {
          frameRef.current = requestAnimationFrame(tick)
          return
        }

        builderRef.current = null
        const nextGeometry = activeBuilder.takeGeometry()

        if (!nextGeometry) {
          setStatus('error')
          setError('Grass geometry generation finished without producing a geometry.')
          return
        }

        // Atomic swap: the previous geometry keeps rendering until this commit,
        // and is disposed by the effect below right after the new one lands.
        hasGeometryRef.current = true
        setGeometry(nextGeometry)
        setProgress(1)
        setStatus('ready')
        setError(null)
      }

      frameRef.current = requestAnimationFrame(tick)
    }

    if (hasGeometryRef.current) {
      // A usable geometry already exists: debounce so only the last request of
      // a rapid drag actually starts a build.
      setStatus('pending')
      setProgress(0)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        runBuild()
      }, debounceMs)
    } else {
      // First build: show progress immediately instead of an empty scene.
      runBuild()
    }

    return cancelPendingWork
  }, [sourceGeometry, bladeParamsKey, seed, retryToken, debounceMs, frameBudgetMs, cancelPendingWork])

  const retry = useCallback(() => {
    setRetryToken(token => token + 1)
  }, [])

  // Release a geometry as soon as it has been replaced. The effect body (not
  // its cleanup) does the disposal, so StrictMode's mount/unmount/mount cycle
  // can never dispose the geometry that is still attached to the mesh.
  const displayedGeometryRef = useRef<BufferGeometry | null>(null)

  useEffect(() => {
    const previous = displayedGeometryRef.current

    if (previous && previous !== geometry) {
      previous.dispose()
    }

    displayedGeometryRef.current = geometry
    hasGeometryRef.current = geometry !== null
  }, [geometry])

  // Dispose the geometry still on screen when the page unmounts. The microtask
  // guard makes StrictMode's immediate re-mount keep it alive, while a real
  // unmount still releases it.
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false

      queueMicrotask(() => {
        if (mountedRef.current) return

        displayedGeometryRef.current?.dispose()
        displayedGeometryRef.current = null
      })
    }
  }, [])

  return { geometry, status, progress, error, retry }
}
