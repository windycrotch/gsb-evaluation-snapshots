// AdaptiveController swap-lifecycle tests.
//
// These drive the controller with an injected clock, fake stats and fake
// weight fetches — the decision/cooldown/retry state machine is pure logic.
// The REAL renderer swap path (fetchWeights → Renderer.setPreset → stats /
// skip cadence) is covered in adaptive_swap.test.ts, which wires this same
// controller to a real WebGPU/WebGL Renderer; nothing here mocks the swap
// itself, only the stats/weight inputs.
//
// Timing constants mirrored from adaptive.ts (not exported):
//   POLL 2s, COOLDOWN 10s, OVERSHOOT 5s, HEADROOM 15s, MIN_FPS_FRAC 2/3.

import { describe, it, expect, afterEach } from 'vitest'
import { AdaptiveController } from '~/pipeline/adaptive'
import { PRESETS, type ManualPreset, type ModelName } from '~/pipeline/presets'
import type { RendererStats, PipelineError } from '~/pipeline/messages'

const T0 = 1_000_000
const POLL = 2000

// Stats as the renderer would report them for `model`: preset/skipFrames
// always agree with the tier (that invariant is asserted end-to-end in
// adaptive_swap.test.ts).
function statsFor(model: ModelName, fps: number, modelMs = 20): RendererStats {
  const idx = PRESETS.findIndex(p => p.model === model)
  const p = PRESETS[idx]
  return {
    fps, modelFps: fps / (p.skipFrames + 1), modelMs, displayMs: 1, skipped: 0,
    preset: p.model, skipFrames: p.skipFrames,
    enabled: true, inputPath: 'mstp', outputPath: 'mstg', backend: 'webgpu',
  }
}

interface Harness {
  c: AdaptiveController
  swaps: ModelName[]
  swapAt: number[]
  fetches: ModelName[]
  errors: PipelineError[]
  swapEvents: { ok: boolean; from: ModelName; to: ModelName }[]
  clock: number
  tick: () => Promise<void>
  advance: (ms: number) => Promise<void>
  settle: () => Promise<void>
  setHidden: (hidden: boolean) => void
}

// Flush promise/microtask queues (fake fetch resolves on a microtask; the
// controller's swap() continues after it asynchronously).
const settle = () => new Promise(r => setTimeout(r, 0))

// Wait until any swap the controller started has fully settled (fetches with
// a real timer delay, e.g. fetchDelayMs, need more than one microtask flush).
async function settleController(c: AdaptiveController, timeoutMs = 2000): Promise<void> {
  const end = performance.now() + timeoutMs
  while (c.isSwapping && performance.now() < end) await new Promise(r => setTimeout(r, 5))
  await settle()
}

// Build a controller around a manual fake. `fpsFor(model)` lets the fake
// stats follow the current tier; failing models reject the weight fetch.
function makeHarness(opts: {
  initial?: ModelName
  backendKind?: 'webgpu' | 'webgl'
  fpsFor: (model: ModelName) => number
  modelMsFor?: (model: ModelName) => number
  failFetch?: (model: ModelName) => boolean
  failSwap?: (model: ModelName) => boolean
  fetchDelayMs?: number
}): Harness {
  const swaps: Harness['swaps'] = []
  const swapAt: Harness['swapAt'] = []
  const fetches: Harness['fetches'] = []
  const errors: PipelineError[] = []
  const swapEvents: Harness['swapEvents'] = []
  let clock = T0
  const h: Harness = {
    c: null as unknown as AdaptiveController,
    swaps, swapAt, fetches, errors, swapEvents,
    get clock() { return clock },
    tick: async () => { await h.c.tick(clock); await settleController(h.c) },
    advance: async (ms) => {
      // Inclusive of the boundary tick at exactly `ms` (the poll that can
      // first satisfy an overshoot/cooldown deadline lands on the boundary).
      for (let t = POLL; t <= ms; t += POLL) { clock += POLL; await h.c.tick(clock); await settleController(h.c) }
    },
    settle: async () => { await settleController(h.c) },
    setHidden: (hidden) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' })
    },
  }
  h.c = new AdaptiveController({
    backendKind:  opts.backendKind ?? 'webgpu',
    initialModel: opts.initial ?? 'medium',
    getInputFps:  () => 30,
    fetchWeights: async (model) => {
      fetches.push(model)
      if (opts.fetchDelayMs) await new Promise(r => setTimeout(r, opts.fetchDelayMs))
      if (opts.failFetch?.(model)) throw new Error(`simulated fetch failure for ${model}`)
      return new ArrayBuffer(8)
    },
    getStats: async () => statsFor(h.c.currentModel, opts.fpsFor(h.c.currentModel), opts.modelMsFor?.(h.c.currentModel) ?? 20),
    swapPreset: async (p: ManualPreset | string) => {
      const model = typeof p === 'string' ? (p as ModelName) : p.model
      if (opts.failSwap?.(model)) throw new Error(`simulated renderer swap failure for ${model}`)
      swaps.push(model)
      swapAt.push(clock)
    },
    onError: (e) => errors.push(e),
    onSwap:  (r) => swapEvents.push({ ok: r.ok, from: r.from, to: r.to }),
  }, T0)
  return h
}

afterEach(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
})

describe('AdaptiveController downgrade lifecycle', () => {
  it('downgrades exactly once once low fps has persisted OVERSHOOT_MS, and commits the new tier', async () => {
    const h = makeHarness({ fpsFor: () => 15 })   // 15 < 30 * 2/3 = 20
    // The first low-fps poll (t=2s) opens the overshoot window at 2s.
    // Ticks at 4s/6s are still inside the 5s window: no swap.
    await h.advance(6000)
    expect(h.swaps).toEqual([])
    expect(h.c.state).toBe('idle')
    // t=8s: now - overshootStart = 6s ≥ 5s → one swap medium → small.
    await h.advance(2000)
    expect(h.swaps).toEqual(['small'])
    expect(h.fetches).toEqual(['small'])
    expect(h.c.currentModel).toBe('small')
    expect(h.swapEvents).toEqual([{ ok: true, from: 'medium', to: 'small' }])
    expect(h.errors).toEqual([])
    expect(h.c.state).toBe('idle')
  })

  it('cooldown suppresses a second swap even while low fps persists', async () => {
    const h = makeHarness({ fpsFor: () => 15 })
    await h.advance(30_000)
    // First swap at 8s starts the 10s cooldown; a fresh 5s overshoot window
    // can only accumulate after 18s and first fires on the 24s poll. Only
    // two swaps in 30s, never back-to-back ticks.
    expect(h.swaps).toEqual(['small', 'xs'])
    expect(h.swapAt).toEqual([T0 + 8000, T0 + 24_000])
    // The hard requirement: no second swap may start within the cooldown.
    expect(h.swapAt[1] - h.swapAt[0]).toBeGreaterThanOrEqual(10_000)
    expect(h.c.currentModel).toBe('xs')
  })

  it('never downgrades below the cheapest tier', async () => {
    const h = makeHarness({ initial: 'xs', fpsFor: () => 1 })
    await h.advance(30_000)
    expect(h.swaps).toEqual([])
    expect(h.c.currentModel).toBe('xs')
  })
})

describe('AdaptiveController single-flight: no concurrent weight fetches', () => {
  it('ticks landing while a slow fetch is in flight never start a second swap', async () => {
    // A fetch that stays pending across several poll ticks.
    let resolveFetch: (b: ArrayBuffer) => void = () => {}
    const fetches: ModelName[] = []
    const swaps: ModelName[] = []
    const c = new AdaptiveController({
      backendKind: 'webgl', initialModel: 'medium', getInputFps: () => 30,
      fetchWeights: (model) => {
        fetches.push(model)
        return new Promise<ArrayBuffer>(res => { resolveFetch = res })
      },
      getStats: async () => statsFor(c.currentModel, 15),
      swapPreset: async (p) => { swaps.push(typeof p === 'string' ? p as ModelName : p.model) },
    }, T0)

    // Drive to the first downgrade decision (overshoot window opened at 2s,
    // fires on the 8s poll).
    for (let t = 2000; t <= 8000; t += POLL) await c.tick(T0 + t)
    expect(fetches).toEqual(['small'])
    expect(c.isSwapping).toBe(true)
    expect(c.state).toBe('swapping')

    // Many more ticks — including past the cooldown boundary and with the
    // downgrade condition still true — must not fetch anything else.
    for (let t = 10_000; t <= 30_000; t += POLL) await c.tick(T0 + t)
    expect(fetches).toEqual(['small'])
    expect(swaps).toEqual([])

    // Once the pending fetch settles, the single swap completes.
    resolveFetch(new ArrayBuffer(4))
    await new Promise(r => setTimeout(r, 0))
    expect(swaps).toEqual(['small'])
    expect(c.currentModel).toBe('small')
    expect(c.isSwapping).toBe(false)

    // The condition is re-judged on later ticks, not queued: a further
    // downgrade needs a fresh overshoot window + cooldown.
    await c.tick(T0 + 32_000)
    expect(fetches).toEqual(['small'])
  })

  it('a tick immediately after a settled swap stays inside the cooldown', async () => {
    const h = makeHarness({ fpsFor: () => 15, fetchDelayMs: 10 })
    await h.advance(8000)                       // first swap starts & settles
    expect(h.fetches).toEqual(['small'])
    // Immediately tick again inside cooldown: noop, no second fetch.
    await h.tick()
    expect(h.fetches).toEqual(['small'])
    expect(h.c.state).toBe('idle')
  })
})

describe('AdaptiveController weight-fetch failure: keep tier, report recoverable, retry later', () => {
  it('stays on the current preset and emits a recoverable adaptive error', async () => {
    const h = makeHarness({ fpsFor: () => 15, failFetch: () => true })
    await h.advance(8000)                       // window opens at 2s → fetch fails on the 8s poll
    expect(h.c.currentModel).toBe('medium')
    expect(h.swaps).toEqual([])
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]).toMatchObject({ type: 'adaptive', fatal: false, recoverable: true, source: 'adaptive' })
    expect(h.errors[0].message).toMatch(/adaptive preset swap failed/)
    expect(h.swapEvents).toEqual([{ ok: false, from: 'medium', to: 'small' }])
    expect(h.c.state).toBe('idle')
  })

  it('retries after the cooldown and a run of failures never wedges the controller', async () => {
    let failUntil = 4                       // first 4 fetch attempts fail
    const h = makeHarness({
      fpsFor: () => 15,
      failFetch: () => h.fetches.length <= failUntil,
    })
    await h.advance(8000)                   // attempt #1 on the 8s poll fails
    expect(h.c.currentModel).toBe('medium')
    expect(h.fetches).toHaveLength(1)

    // Each retry needs the cooldown (10s) plus a fresh 5s overshoot window.
    // Advance through several failing cycles.
    await h.advance(40_000)
    const failedAttempts = h.fetches.length
    expect(failedAttempts).toBeGreaterThanOrEqual(3)
    expect(h.c.currentModel).toBe('medium')        // still on the old tier
    expect(h.errors).toHaveLength(failedAttempts)  // every failure reported
    expect(h.errors.every(e => e.recoverable && !e.fatal)).toBe(true)

    // Let the next attempt succeed — the controller is still alive and swaps.
    failUntil = -1
    await h.advance(20_000)
    expect(h.swaps).toContain('small')
    expect(h.c.currentModel).toBe('small')
    const ok = h.swapEvents.filter(e => e.ok)
    expect(ok).toHaveLength(1)
    expect(ok[0]).toEqual({ ok: true, from: 'medium', to: 'small' })
  })

  it('a renderer-level swap failure is handled the same as a fetch failure', async () => {
    const h = makeHarness({ fpsFor: () => 15, failSwap: () => true })
    await h.advance(8000)
    expect(h.fetches).toEqual(['small'])          // weights fetched fine…
    expect(h.swaps).toEqual([])                   // …but the renderer refused them
    expect(h.c.currentModel).toBe('medium')       // old index retained
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0].recoverable).toBe(true)
    expect(h.swapEvents).toEqual([{ ok: false, from: 'medium', to: 'small' }])
    expect(h.c.state).toBe('idle')
  })
})

describe('AdaptiveController hidden page', () => {
  it('never swaps while document.hidden, even with a fully accumulated overshoot', async () => {
    const h = makeHarness({ fpsFor: () => 15 })
    h.setHidden(true)
    await h.advance(30_000)
    expect(h.fetches).toEqual([])
    expect(h.swaps).toEqual([])
    expect(h.errors).toEqual([])
    expect(h.c.currentModel).toBe('medium')
  })

  it('resets the observation window while hidden and re-accumulates from visibility', async () => {
    const h = makeHarness({ fpsFor: () => 15 })
    // 6s of low fps visible: the overshoot window opened at 2s and would
    // fire on the 8s poll — still no swap while we stay under it.
    await h.advance(6000)
    expect(h.swaps).toEqual([])
    // Hidden for a long stretch — would have crossed the 5s window many
    // times over, but hidden ticks neither decide nor accumulate.
    h.setHidden(true)
    await h.advance(20_000)
    expect(h.swaps).toEqual([])
    expect(h.fetches).toEqual([])
    // Visible again: the window starts from zero. 6 more visible seconds
    // still must NOT swap (a fresh window opens on the first visible poll
    // and needs 5s; 6s of polls only spans 4s past that opening), proving
    // the pre-hidden accumulation was discarded rather than resumed.
    h.setHidden(false)
    await h.advance(6000)
    expect(h.swaps).toEqual([])
    // Two further polls cross the fresh 5s window → the swap fires.
    await h.advance(4000)
    expect(h.swaps).toEqual(['small'])
    expect(h.c.currentModel).toBe('small')
  })
})

describe('AdaptiveController upgrade path (WebGPU only)', () => {
  it('upgrades after sustained headroom but never into xl', async () => {
    // High fps (no downgrade) + tiny modelMs (well under the 30% budget).
    const h = makeHarness({ initial: 'large', fpsFor: () => 30, modelMsFor: () => 0.1 })
    await h.advance(20_000)   // HEADROOM_MS = 15s
    expect(h.swaps).not.toContain('xl')
    // large is idx 3; the only higher allowed tier would be xl, which is
    // blocked — so no swap at all.
    expect(h.swaps).toEqual([])
    expect(h.c.currentModel).toBe('large')
  })

  it('WebGL never upgrades regardless of headroom', async () => {
    const h = makeHarness({
      backendKind: 'webgl', initial: 'small', fpsFor: () => 30, modelMsFor: () => 0.1,
    })
    await h.advance(30_000)
    expect(h.swaps).toEqual([])
    expect(h.c.currentModel).toBe('small')
  })
})
