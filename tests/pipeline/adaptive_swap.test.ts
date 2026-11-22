// End-to-end swap-chain test: the REAL AdaptiveController decision path
// (fetchWeights → swapPreset → AdaptiveController commit) wired to a REAL
// Renderer on a real GPU backend. Only the stats source and weight bytes are
// faked — no piece of the actual swap path is mocked:
//
//   AdaptiveController.swap() → opts.swapPreset → renderer.setPreset()
//     → TierModel/RenderOp rebuilt → process() skip cadence → getStats()
//
// The shipped fixture tests/fixtures/tier_small.bin is a valid weight pack
// for the small encoder. xs and small share that encoder and a one-stage
// wrapper (variants B vs A differ only in stride, not weight structure), so
// the same pack loads as a stand-in for both tiers — enough to exercise the
// genuine setPreset reconstruction. A truncated pack stands in for a failed
// weight download.
//
// Covers the acceptance chain:
//   1. one real downgrade; stats.preset/skipFrames track the new tier and
//      the frame cadence follows its skipFrames from the next frame;
//   2. a failed fetch leaves the renderer on the old preset, reports a
//      recoverable onError, and the controller retries once healthy;
//   3. repeated triggers inside the cooldown produce exactly one fetch;
//   4. hidden-page ticks neither swap nor consume the observation window;
//   5. the old tier's skip counter/count leaves no residue after a swap —
//      the new cadence starts from frame 0 of the new preset.

import { describe, it, expect, afterEach } from 'vitest'
import { AdaptiveController } from '~/pipeline/adaptive'
import { Renderer } from '~/pipeline/worker/renderer'
import { PRESETS, type ManualPreset, type ModelName } from '~/pipeline/presets'
import type { RendererStats, PipelineError } from '~/pipeline/messages'
import type { Backend } from '~/model/backend'
import { WebGPUBackend } from '~/model/backends/webgpu/index'
import binUrl from '../fixtures/tier_small.bin?url'

const T0 = 1_000_000
const POLL = 2000

function makeFrame(t: number): VideoFrame {
  const c = new OffscreenCanvas(384, 240)
  const ctx = c.getContext('2d')!
  ctx.fillStyle = `rgb(${(t * 40) % 255}, 120, 80)`
  ctx.fillRect(0, 0, 384, 240)
  ctx.fillStyle = '#222'
  ctx.fillRect(40 + (t * 5) % 200, 30, 120, 140)
  return new VideoFrame(c, { timestamp: t * 33_000 })
}

function processN(renderer: Renderer, n: number, t0: number): void {
  for (let t = t0; t < t0 + n; t++) {
    const f = makeFrame(t)
    try { renderer.process(f) } finally { f.close() }
  }
}

// Truncated-but-plausible pack: a header that promises more than the buffer
// holds, so loadWeightsFromBinary rejects — the same failure class as a
// corrupt / partial weight download.
function truncatedWeights(): ArrayBuffer {
  const buf = new ArrayBuffer(8)
  new DataView(buf).setUint32(0, 999, true)
  return buf
}

interface SwapHarness {
  c: AdaptiveController
  renderer: Renderer
  backend: Backend
  errors: PipelineError[]
  results: { ok: boolean; from: ModelName; to: ModelName }[]
  fetchCountFor: (model: ModelName) => number
  setHidden: (hidden: boolean) => void
  tick: (now: number) => Promise<void>
}

async function makeSwapHarness(opts: {
  initial: ManualPreset
  goodWeights: ArrayBuffer
  // Returning a rejected promise simulates a failed weight download.
  fetchImpl: (model: ModelName) => Promise<ArrayBuffer>
  renderedFps: () => number
}): Promise<SwapHarness> {
  const canvas = new OffscreenCanvas(384, 240)
  const backend = await WebGPUBackend.create({ canvas, dtype: 'f32' })
  const renderer = new Renderer({
    backend, backendKind: 'webgpu', canvas,
    background: { kind: 'color', rgb: [0, 1, 0] },
    enabled: true,
    topology: { input: 'postmessage', output: 'bitmap-shuttle' } as any,
  })
  // Real initial attach through the production entry point.
  renderer.setPreset(opts.initial, opts.goodWeights.slice(0))

  const errors: PipelineError[] = []
  const results: SwapHarness['results'] = []
  const fetchCounts = new Map<ModelName, number>()
  const c = new AdaptiveController({
    backendKind: 'webgl',                 // fps-driven downgrades only; no upgrade branch
    initialModel: opts.initial.model,
    getInputFps: () => 30,
    fetchWeights: (model) => {
      fetchCounts.set(model, (fetchCounts.get(model) ?? 0) + 1)
      return opts.fetchImpl(model)
    },
    // Stats come from the REAL renderer, with only fps overlaid so the
    // controller sees an overloaded device.
    getStats: async () => {
      const s = renderer.getStats() as RendererStats
      return { ...s, fps: opts.renderedFps() }
    },
    // The production swap call: worker/index.ts handleSetPreset does exactly
    // renderer.setPreset(resolved, weights).
    swapPreset: async (preset, weights) => {
      const manual = typeof preset === 'string' ? preset : preset
      if (typeof manual === 'string') throw new Error('test expects ManualPreset')
      renderer.setPreset(manual, weights)
    },
    onError: (e) => errors.push(e),
    onSwap:  (r) => results.push({ ok: r.ok, from: r.from, to: r.to }),
  }, T0)

  return {
    c, renderer, backend, errors, results,
    fetchCountFor: (m) => fetchCounts.get(m) ?? 0,
    setHidden: (hidden) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' })
    },
    tick: async (now) => { await c.tick(now); await new Promise(r => setTimeout(r, 0)) },
  }
}

afterEach(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
})

describe('AdaptiveController ↔ Renderer real swap chain (WebGPU)', () => {
  it('performs one real downgrade: stats track the new preset and skip cadence restarts clean', async () => {
    const good = await (await fetch(binUrl)).arrayBuffer()
    const h = await makeSwapHarness({
      initial: PRESETS[1],                       // small, skipFrames 1
      goodWeights: good,
      fetchImpl: async () => good.slice(0),     // xs stand-in pack
      renderedFps: () => 15,                    // below 20 → overloaded
    })
    try {
      // Baseline: 9 frames on small (run, skip, run, skip, … → 4 skips).
      processN(h.renderer, 9, 0)
      const before = h.renderer.getStats()
      expect(before.preset).toBe('small')
      expect(before.skipFrames).toBe(1)
      expect(before.skipped).toBe(4)

      // Drive the controller through the overshoot window (opens at 2s,
      // first eligible poll at 8s).
      for (let t = POLL; t <= 8000; t += POLL) await h.tick(T0 + t)

      expect(h.c.currentModel).toBe('xs')
      expect(h.results).toEqual([{ ok: true, from: 'small', to: 'xs' }])
      expect(h.errors).toEqual([])
      expect(h.fetchCountFor('xs')).toBe(1)

      // Stats must agree with the NEW tier immediately.
      const after = h.renderer.getStats()
      expect(after.preset).toBe('xs')
      expect(after.skipFrames).toBe(2)

      // Next frame onward follows the xs cadence (run every 3rd frame), and
      // no residue from small's skip counter: of 9 fresh frames, frames
      // 0/3/6 run and the other 6 are skipped.
      const skippedAtSwap = after.skipped
      processN(h.renderer, 9, 9)
      const later = h.renderer.getStats()
      expect(later.preset).toBe('xs')
      expect(later.skipFrames).toBe(2)
      expect(later.skipped - skippedAtSwap).toBe(6)
    } finally {
      h.renderer.destroy()
    }
  })

  it('keeps the old preset on a failed fetch, reports a recoverable error, and retries after cooldown', async () => {
    const good = await (await fetch(binUrl)).arrayBuffer()
    let failNext = true
    const h = await makeSwapHarness({
      initial: PRESETS[1],
      goodWeights: good,
      fetchImpl: async () => {
        if (failNext) throw new Error('network 500 for model_xs.bin')
        return good.slice(0)
      },
      renderedFps: () => 15,
    })
    try {
      processN(h.renderer, 6, 0)
      const baseline = h.renderer.getStats()
      expect(baseline.preset).toBe('small')
      const skippedBefore = baseline.skipped

      for (let t = POLL; t <= 8000; t += POLL) await h.tick(T0 + t)

      // Failed swap: controller AND renderer stay on small.
      expect(h.c.currentModel).toBe('small')
      expect(h.renderer.getStats().preset).toBe('small')
      expect(h.renderer.getStats().skipFrames).toBe(1)
      expect(h.results).toEqual([{ ok: false, from: 'small', to: 'xs' }])
      expect(h.errors).toHaveLength(1)
      expect(h.errors[0]).toMatchObject({ type: 'adaptive', fatal: false, recoverable: true })
      expect(h.errors[0].message).toMatch(/model_xs\.bin|swap failed/)

      // The old tier keeps rendering on its own cadence.
      processN(h.renderer, 3, 6)
      const stillSmall = h.renderer.getStats()
      expect(stillSmall.preset).toBe('small')
      expect(stillSmall.skipped - skippedBefore).toBeGreaterThan(0)

      // Cooldown (10s) + a fresh 5s window: the next eligible attempt is at
      // 24s. With the network healed it completes — repeated failure did not
      // wedge the controller.
      failNext = false
      for (let t = 10_000; t <= 24_000; t += POLL) await h.tick(T0 + t)
      expect(h.c.currentModel).toBe('xs')
      expect(h.renderer.getStats().preset).toBe('xs')
      const ok = h.results.filter(r => r.ok)
      expect(ok).toEqual([{ ok: true, from: 'small', to: 'xs' }])
      // Exactly one failed attempt preceded the success — no retry storm.
      expect(h.fetchCountFor('xs')).toBe(2)
    } finally {
      h.renderer.destroy()
    }
  })

  it('repeated triggers inside the cooldown produce exactly one weight fetch', async () => {
    const good = await (await fetch(binUrl)).arrayBuffer()
    let fetchInFlight = 0
    let maxConcurrent = 0
    const h = await makeSwapHarness({
      initial: PRESETS[1],
      goodWeights: good,
      fetchImpl: () => {
        fetchInFlight++
        maxConcurrent = Math.max(maxConcurrent, fetchInFlight)
        // Hold the fetch open across several poll ticks.
        return new Promise<ArrayBuffer>(resolve => setTimeout(() => {
          fetchInFlight--
          resolve(good.slice(0))
        }, 60))
      },
      renderedFps: () => 15,
    })
    try {
      // Poll densely through the decision window and beyond; ticks that land
      // while the 60ms fetch is pending must not start a second one.
      for (let t = POLL; t <= 12_000; t += POLL) await h.tick(T0 + t)
      // The fetch holds for 60ms of real wall-clock time; let it settle.
      const end = performance.now() + 2000
      while (h.c.isSwapping && performance.now() < end) await new Promise(r => setTimeout(r, 10))
      expect(h.c.isSwapping).toBe(false)
      expect(h.fetchCountFor('xs')).toBe(1)
      expect(maxConcurrent).toBe(1)
      expect(h.c.currentModel).toBe('xs')

      // Further polls inside the cooldown stay quiet.
      for (let t = 14_000; t <= 16_000; t += POLL) await h.tick(T0 + t)
      expect(h.fetchCountFor('xs')).toBe(1)
    } finally {
      h.renderer.destroy()
    }
  })

  it('never swaps while the page is hidden and re-accumulates the window after visibility returns', async () => {
    const good = await (await fetch(binUrl)).arrayBuffer()
    const h = await makeSwapHarness({
      initial: PRESETS[1],
      goodWeights: good,
      fetchImpl: async () => good.slice(0),
      renderedFps: () => 15,
    })
    try {
      // Accumulate most of an overshoot window while visible.
      for (let t = POLL; t <= 6000; t += POLL) await h.tick(T0 + t)
      expect(h.fetchCountFor('xs')).toBe(0)

      // Hidden through what would otherwise be several swap opportunities.
      h.setHidden(true)
      for (let t = 8000; t <= 30_000; t += POLL) await h.tick(T0 + t)
      expect(h.fetchCountFor('xs')).toBe(0)
      expect(h.c.currentModel).toBe('small')
      expect(h.renderer.getStats().preset).toBe('small')

      // Visible again: pre-hidden accumulation was discarded. The fresh
      // window opens on the first visible poll (32s), so the polls through
      // 36s span only 4s and still must not swap.
      h.setHidden(false)
      for (let t = 32_000; t <= 36_000; t += POLL) await h.tick(T0 + t)
      expect(h.fetchCountFor('xs')).toBe(0)
      expect(h.c.currentModel).toBe('small')

      // The fresh window matures on the 38s poll → one real downgrade.
      await h.tick(T0 + 38_000)
      expect(h.fetchCountFor('xs')).toBe(1)
      expect(h.c.currentModel).toBe('xs')
      expect(h.renderer.getStats().preset).toBe('xs')
    } finally {
      h.renderer.destroy()
    }
  })

  it('a renderer-rejected swap (corrupt weights) leaves stats on the old preset and stays recoverable', async () => {
    const good = await (await fetch(binUrl)).arrayBuffer()
    let serveCorrupt = true
    const h = await makeSwapHarness({
      initial: PRESETS[1],
      goodWeights: good,
      // A successful download that the renderer cannot parse: exercises the
      // swapPreset rejection half of the chain (not just fetchWeights).
      fetchImpl: async () => serveCorrupt ? truncatedWeights() : good.slice(0),
      renderedFps: () => 15,
    })
    try {
      for (let t = POLL; t <= 8000; t += POLL) await h.tick(T0 + t)
      expect(h.c.currentModel).toBe('small')
      const s = h.renderer.getStats()
      expect(s.preset).toBe('small')
      expect(s.skipFrames).toBe(1)
      expect(h.errors).toHaveLength(1)
      expect(h.errors[0].recoverable).toBe(true)
      expect(h.results[0]).toMatchObject({ ok: false, from: 'small', to: 'xs' })

      // Healing: good weights on the next cooldown-spaced attempt.
      serveCorrupt = false
      for (let t = 10_000; t <= 24_000; t += POLL) await h.tick(T0 + t)
      expect(h.c.currentModel).toBe('xs')
      expect(h.renderer.getStats().preset).toBe('xs')
    } finally {
      h.renderer.destroy()
    }
  })
})
