// Adaptive preset switching. Polls the renderer's stats, downgrades when
// FPS drops below threshold, and (WebGPU only) upgrades when modelMs has
// consistent headroom. WebGL never upgrades because its per-frame
// modelMs sampling cost is too high — see renderer.ts MODEL_TIMING_SAMPLE_INTERVAL
// for the gating, and adaptive.ts in this file for the consequences.
//
// Decoupled from Pipeline via callbacks (getStats, swapPreset) so this
// module doesn't depend on WorkerController or Pipeline internals.
//
// Swap state machine (observable via `state`, notified via onSwap):
//
//   idle ──downgrade/upgrade condition met──▶ swapping
//   swapping ──fetchWeights + swapPreset ok──▶ idle   (onSwap {ok:true})
//   swapping ──either step throws───────────▶ idle   (onError + onSwap {ok:false})
//
// Invariants:
//   - At most ONE swap in flight. A tick that lands while `swapping` never
//     starts a second weight fetch; the pending condition is re-evaluated on
//     a later tick (after cooldown), never queued as a concurrent swap.
//   - Cooldown starts when the swap STARTS and gates every later tick, so a
//     slow fetch can't be overlapped by another decision.
//   - A failed swap changes nothing about the running tier: the renderer
//     keeps its old preset and the controller keeps its old preset index.
//     Failure is reported as a recoverable 'adaptive' error; once the
//     cooldown elapses the same condition can trigger a fresh attempt, so
//     repeated failures never wedge the controller.
//   - Hidden-page ticks are skipped AND reset the observation windows:
//     background throttling makes fps/modelMs unrepresentative, so no
//     decision may be made from stale samples. When the page becomes
//     visible again the overshoot/headroom windows accumulate from zero.

import type { ModelName, PresetName } from './presets'
import { PRESETS, ManualPreset } from './presets'
import type { RendererStats, PipelineError } from './messages'
import { createLogger } from './debug'

const log = createLogger('adaptive')

// Tunables. Hardcoded for v0.1; surface as PipelineOptions later if
// callers actually want to tune.
const POLL_INTERVAL_MS = 2000
const COOLDOWN_MS      = 10000   // min gap between any two swaps (measured from each swap's start)
const SOURCE_FPS       = 30      // configured target rate (cap) for budget calc
const MIN_FPS          = 20      // at a 30 fps target: fps below this for OVERSHOOT_MS → downgrade
const MIN_FPS_FRAC     = MIN_FPS / SOURCE_FPS   // …scaled to the actual target (2/3)
const OVERSHOOT_MS     = 5000
const HEADROOM_FRAC    = 0.3     // modelMs / frame budget below this for HEADROOM_MS → upgrade
const HEADROOM_MS      = 15000   // upgrade is more conservative than downgrade

// Lifecycle of one swap attempt. Exposed for tests / observability — the
// controller itself only branches on `idle` vs `swapping`.
export type AdaptiveSwapState = 'idle' | 'swapping'

export interface AdaptiveSwapResult {
  ok: boolean
  from: ModelName
  to: ModelName
  // Present when ok === false: the fetchWeights / swapPreset failure.
  error?: unknown
}

export interface AdaptiveOptions {
  backendKind:     'webgpu' | 'webgl'
  initialModel:    ModelName
  // Measured input (camera) fps, or null when unknown. The controller's
  // target is min(input fps, 30): a 15 fps camera rendering 15 fps is on
  // target, not overloaded. Omitted/null → assume a 30 fps source.
  getInputFps?:    () => number | null
  // Fetch weights for a model (resolves f16/f32 pack + fallback in the caller).
  fetchWeights:    (model: ModelName) => Promise<ArrayBuffer>
  getStats:        () => Promise<RendererStats>
  // Caller is responsible for the actual setPreset wire-up; adaptive
  // just hands over fresh weights and the new preset name.
  swapPreset:      (preset: PresetName | ManualPreset, weights: ArrayBuffer) => Promise<void>
  // Surfaced when a swap attempt fails (weights fetch 404, etc.).
  // Adaptive keeps running on the previous preset; cooldown still
  // applies so we don't immediately retry. Recoverable.
  onError?:        (err: PipelineError) => void
  // Observability hook for every swap attempt, success or failure. Fires
  // after the swap settles and the controller state is back to 'idle'.
  onSwap?:         (result: AdaptiveSwapResult) => void
}

export class AdaptiveController {
  private timer:            ReturnType<typeof setInterval> | null = null
  private currentPresetIdx: number
  // 0 until the first swap: a freshly-started controller must not serve a
  // phantom 10s cooldown that predates any decision (the observation window
  // already guards against an instant swap). Set to the swap's start time
  // inside swap(), which is what actually enforces the gap between swaps.
  private lastSwapAt:       number = 0
  private overshootStart:   number = 0    // first time fps < threshold; reset on recovery
  private headroomStart:    number = 0    // first time modelMs comfortable; reset on spike
  // Single-flight guard. A swap spans the async fetchWeights + swapPreset
  // pair; while true no tick may start another one (cooldown alone can't
  // guarantee this if a fetch outlasts the cooldown or ticks are driven
  // manually with injected clocks).
  private swapInFlight:     boolean = false

  constructor(private opts: AdaptiveOptions, _now: number = performance.now()) {
    this.currentPresetIdx = PRESETS.findIndex(p => p.model === opts.initialModel)
    // Intentionally no initial cooldown: lastSwapAt stays 0, so the first
    // decision is gated only by the overshoot/headroom observation window.
    // The injected clock parameter is retained for call-site/test symmetry.
  }

  get currentModel(): ModelName { return PRESETS[this.currentPresetIdx]?.model ?? this.opts.initialModel }

  // Observable swap lifecycle. 'swapping' between a decision and the
  // fetch/swap settling; 'idle' otherwise.
  get state(): AdaptiveSwapState { return this.swapInFlight ? 'swapping' : 'idle' }

  // True while weights are being fetched or the renderer swap is pending.
  get isSwapping(): boolean { return this.swapInFlight }

  start(): void {
    log(`started; backend=${this.opts.backendKind} initial=${this.opts.initialModel} idx=${this.currentPresetIdx}`)
    this.timer = setInterval(() => {
      this.tick().catch(err => log('tick failed:', err))
    }, POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // One poll. Public (with an injectable clock) so tests can drive it.
  async tick(now: number = performance.now()): Promise<void> {
    // Background tabs throttle setInterval/raf; modelMs/fps numbers are
    // unreliable. Skip the tick rather than risk a spurious downgrade — and
    // reset BOTH observation windows so time spent hidden can't satisfy the
    // overshoot/headroom duration on return. The window re-accumulates from
    // the first visible tick.
    if (typeof document !== 'undefined' && document.hidden) {
      this.overshootStart = 0
      this.headroomStart  = 0
      return
    }

    // A swap is already running (slow fetch / renderer swap): never start a
    // second one. The condition is re-judged on a later tick — there is no
    // queued second swap.
    if (this.swapInFlight) return

    if (now - this.lastSwapAt < COOLDOWN_MS) return

    const stats  = await this.opts.getStats()
    // The stats await is an async gap: a swap could theoretically have been
    // started by another caller path in the meantime. Re-check before acting.
    if (this.swapInFlight) return
    const target = this.targetFps()

    // Downgrade — both backends, FPS-based, relative to the input rate.
    if (stats.fps < target * MIN_FPS_FRAC) {
      if (this.overshootStart === 0) this.overshootStart = now
      if (now - this.overshootStart >= OVERSHOOT_MS) this.tryDowngrade(stats.fps, now)
    } else {
      this.overshootStart = 0
    }

    // Upgrade — WebGPU only, modelMs-based. WebGL stats don't have GPU
    // timing because per-frame fence sync is too heavy.
    if (this.opts.backendKind === 'webgpu' && stats.modelMs > 0) {
      const budgetMs = (1000 / target) * HEADROOM_FRAC
      if (stats.modelMs < budgetMs) {
        if (this.headroomStart === 0) this.headroomStart = now
        if (now - this.headroomStart >= HEADROOM_MS) this.tryUpgrade(stats.modelMs, budgetMs, now)
      } else {
        this.headroomStart = 0
      }
    }
  }

  // Effective target fps: the camera's measured rate, capped at SOURCE_FPS.
  // Tiny measured rates (paused / static screen share) are clamped so we
  // never "target" ~0 fps.
  targetFps(): number {
    const input = this.opts.getInputFps?.() ?? null
    if (input === null || !Number.isFinite(input) || input <= 0) return SOURCE_FPS
    return Math.max(5, Math.min(SOURCE_FPS, input))
  }

  private tryDowngrade(fps: number, now: number): void {
    if (this.currentPresetIdx <= 0) return
    if (this.swapInFlight) return
    const next = this.currentPresetIdx - 1
    log(`downgrade ${PRESETS[this.currentPresetIdx].model} → ${PRESETS[next].model} (fps=${fps}, target=${this.targetFps().toFixed(1)})`)
    void this.swap(next, now)
  }

  private tryUpgrade(modelMs: number, budgetMs: number, now: number): void {
    if (this.swapInFlight) return
    // Adaptive follows the same policy as autotune: never upgrade INTO xl —
    // it's the explicit opt-in tier ('quality' / manual preset only).
    if (PRESETS[this.currentPresetIdx + 1]?.model === 'xl') return
    if (this.currentPresetIdx >= PRESETS.length - 1) return
    const next = this.currentPresetIdx + 1
    log(`upgrade ${PRESETS[this.currentPresetIdx].model} → ${PRESETS[next].model} (modelMs=${modelMs.toFixed(1)} < ${budgetMs.toFixed(1)})`)
    void this.swap(next, now)
  }

  private async swap(idx: number, now: number): Promise<void> {
    // Hard single-flight guard: no concurrent weight fetches, ever.
    if (this.swapInFlight) return
    const preset  = PRESETS[idx]
    const from    = this.currentModel
    this.swapInFlight = true
    // Start cooldown immediately (before the async fetch) so the next
    // poll can't trigger another swap while this one is in flight.
    this.lastSwapAt     = now
    this.overshootStart = 0
    this.headroomStart  = 0
    try {
      const weights = await this.opts.fetchWeights(preset.model)
      // Pass the full ManualPreset (resolution / skipFrames included).
      await this.opts.swapPreset(preset, weights)
      // Commit the index only after the renderer accepted the swap. On a
      // renderer throw we keep the old index, so currentModel/stats stay on
      // the tier that is actually rendering.
      this.currentPresetIdx = idx
      log(`swap to ${preset.model} done`)
      this.opts.onSwap?.({ ok: true, from, to: preset.model })
    } catch (err) {
      log('swap failed:', err)
      // Leave currentPresetIdx unchanged; cooldown still applies so we
      // don't immediately retry, but nothing disables future attempts —
      // after COOLDOWN_MS the same condition triggers a fresh swap and a
      // run of failures can never wedge the controller.
      this.opts.onError?.({
        type:        'adaptive',
        fatal:       false,
        message:     `adaptive preset swap failed: ${(err as Error).message ?? String(err)}`,
        source:      'adaptive',
        recoverable: true,
        cause:       err,
      })
      this.opts.onSwap?.({ ok: false, from, to: preset.model, error: err })
    } finally {
      this.swapInFlight = false
    }
  }
}
