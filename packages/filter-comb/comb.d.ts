type Buf = Float32Array | Float64Array

export interface CombParams {
  /**
   * Delay, milliseconds, converted to sample frames at `fs`. A whole number
   * given with no `fs` is read as whole frames (the historical convention); a
   * fractional delay reads between its two adjacent frames. Under one frame is
   * an error. Non-finite or negative values throw.
   */
  delay: number
  /** sample rate, Hz, default 44100; changing it on a reused params object restarts the delay glide */
  fs?: number
  /** feedforward/feedback gain, default 0.5; |gain| ≥ 1 is held just inside 1 so feedback stays bounded */
  gain?: number
  /** `'feedforward'` (FIR, dips): H(z) = 1 + gain·z⁻ᴰ. `'feedback'` (IIR, peaks): H(z) = 1 / (1 − gain·z⁻ᴰ). Default `'feedforward'` */
  type?: 'feedforward' | 'feedback'
  [key: string]: unknown
}

/**
 * Comb filter — delayed copy of the signal added to itself, notches/peaks at harmonics of fs/delay. In-place; the ring
 * buffer persists on `params` across calls. The delay is given in milliseconds and converted at `fs`. A new delay is
 * reached from the last call's, the read moving at most half a frame longer and a frame shorter per frame — never a
 * jump; a delay longer than the ring holds makes a new one, empty.
 */
declare function comb(data: Buf, params: CombParams): Buf
export default comb

/**
 * The delay in samples a time in seconds asks for at `fs`, at least 1: within a Float32 step (2^-23) of a whole frame, that
 * frame (@audio/effect's delay reads the same way)
 */
export function delaySamples(time: number, fs: number): number

/**
 * One block in place, allocating nothing: what the `/audio` manifest calls. `buf` the ring, at least floor(delay) + 2
 * long; `s` a `Float64Array` of the write position, the delay the last call ended on and where its read was (NaN, NaN
 * before the first call); `set` a `Float64Array` of the delay in samples, the gain, and 1 for feedback, 0 feedforward;
 * `gains`, when given, the gain each frame in place of `set`'s (the manifest's glide while the gain moves).
 */
export function combBlock(data: Buf, buf: Float64Array, s: Float64Array, set: Float64Array, gains?: Float64Array): Buf
