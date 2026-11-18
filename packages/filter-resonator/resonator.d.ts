type Buf = Float32Array | Float64Array

export interface ResonatorParams {
  /** center frequency, Hz — required; held to 0.49 of `fs` */
  fc: number
  /** sample rate, Hz, default 44100 */
  fs?: number
  /** bandwidth, Hz, default 50 — smaller bw = higher Q; bw → 0 gives the longest ring */
  bw?: number
  [key: string]: unknown
}

/**
 * Constant-peak-gain resonator (JOS two-zero form) — two zeros at z=±1 normalize the
 * pole peak to exactly 0 dB regardless of `fc`/`bw`, unlike a plain RBJ bandpass whose
 * peak gain shifts with Q. Used for modal synthesis (bells, drums) and formant banks.
 * In-place; stateful — pass the same `params` object across calls. Internal cache
 * fields are prefixed `_r*` so `params` can be shared with a caller-owned object
 * (e.g. one formant band's own state) without key collisions.
 *
 * `fc` is held to 0.49·`fs` (past Nyquist the resonance would sound at its alias, and
 * the /audio processors of the family keep the same rule). `fc` or `bw` that is
 * negative, NaN or Infinity — or an `fs` that is not a positive finite number —
 * throws an Error naming the function, rather than designing a section whose poles lie
 * on or outside the unit circle. A moved `fc`/`bw` is glided over 20 ms, not jumped:
 * the same object keeps the section's state through the move; a new object starts from
 * silence. A setting that does not move is the plain section, frame for frame.
 */
declare function resonator(data: Buf, params: ResonatorParams): Buf
export default resonator

/** Seconds a moved fc or bw takes to reach the value a call brings */
export const GLIDE: number

/** Throw unless fc, bw and fs can design a stable section: fc and bw finite >= 0, fs positive and finite. `name` prefixes the Error. */
export function checkResonator(name: string, fc: number, bw: number, fs: number): void

/** A section's glide memory, one per section (a channel): the values it is at and moving to, its frames run and its length. */
export function resonatorGlide(): Float64Array

/** One block in place through a section whose fc and bw glide to the call's values, allocating nothing. `set` is fc, bw, fs; see `resonatorRun`'s source for the glide's memory layout. */
export function resonatorRun(data: Buf, s: Float64Array, g: Float64Array, set: Float64Array): Buf

/** The resonator's section at `fc`, `bw` and `fs`: b0, b2, a1, a2 written into `c` (a `Float64Array(4)`, made if absent) and returned. fc is held to 0.49·fs; invalid values throw. */
export function resonatorCoefs(fc: number, bw: number, fs: number, c?: Float64Array): Float64Array

/** One block in place, allocating nothing: what the `/audio` manifest calls. `s` a `Float64Array` of x1, x2, y1, y2 kept from call to call, `c` the section `resonatorCoefs` writes. */
export function resonatorBlock(data: Buf, s: Float64Array, c: Float64Array): Buf
