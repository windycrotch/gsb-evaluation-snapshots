/**
 * Variable-bandwidth filter with per-sample smoothed coefficient trajectory.
 * fc/Q are exponentially smoothed toward their target values (~5ms time
 * constant) and coefficients recomputed every sample from the smoothed
 * values — so a mid-stream parameter change doesn't produce the coefficient
 * jump (click) that plain lowpass.js/highpass.js would. This smoothing is
 * the filter's reason to exist vs those.
 *
 * @module  audio-filter/effect/variable-bandwidth
 */

import { lowpass } from '@audio/biquad'

let TAU = 0.005 // parameter smoothing time constant, seconds
let FADE = 0.02 // type-switch crossfade, seconds (the /audio processor fades over the same 20 ms)

const PI2 = Math.PI * 2
const TYPES = ['lowpass', 'highpass', 'bandpass']

/**
 * @param {Float64Array} data - Input (modified in-place)
 * @param {object} params - { fc, Q, fs, type: 'lowpass'|'highpass'|'bandpass' }
 */
export default function variableBandwidth (data, params) {
	if (!params || typeof params !== 'object') throw new TypeError('variableBandwidth: params object is required')
	let fs = params.fs == null ? 44100 : params.fs
	if (typeof fs !== 'number' || !Number.isFinite(fs) || fs <= 0) {
		throw new RangeError(`variableBandwidth: fs must be a finite positive sample rate, got ${fs}`)
	}
	let fc = params.fc == null ? 1000 : params.fc
	// a non-finite cutoff is no frequency: say so rather than feed NaN into the coefficients
	if (typeof fc !== 'number' || !Number.isFinite(fc)) {
		throw new TypeError(`variableBandwidth: fc must be a finite frequency, got ${fc}`)
	}
	let Q = params.Q == null ? 0.707 : params.Q
	// a non-positive Q divides by zero in alpha = sin(w)/(2Q); hold it at a safe positive value, so no output is NaN
	if (typeof Q !== 'number' || !Number.isFinite(Q) || Q <= 0) Q = 0.707
	let type = params.type == null ? 'lowpass' : params.type
	if (!TYPES.includes(type)) {
		throw new TypeError(`variableBandwidth: type must be one of ${TYPES.join(', ')}, got ${type}`)
	}
	// the poles leave the unit circle past 0.49 of the rate: hold the target there from the first sample, never run an
	// unstable section
	fc = Math.min(fc, fs * 0.49)

	// the section's two states and the smoothed fc and Q, kept from call to call; NaN fc and Q start at the held targets
	if (!params._state || params._state.length !== 4) params._state = new Float64Array([0, 0, NaN, NaN])
	let s = params._state
	if (s[2] !== s[2]) { s[2] = fc; s[3] = Q }

	// a rate change invalidates every cached number: the smoothed trajectory and coefficients are of the old rate, so
	// restart the smoothing at this rate's targets and drop any fade under way (its step was 1/(0.02·oldFs))
	if (params._fs !== fs) {
		params._fs = fs
		s[2] = fc; s[3] = Q
		params._type = undefined
		if (params._fade) params._fade[0] = 1
	}

	// a new type fades over ~20 ms; a switch while a fade is under way restarts from the blend the output currently has
	let fade = params._fade
	if (params._type !== type) {
		if (params._type !== undefined) {
			let fromK = params._type === 'highpass' ? 1 : params._type === 'bandpass' ? 2 : 0
			if (!fade) {
				// a fresh fade begins from the type in force: its origin weights are that type alone, not the zeros a new
				// Float64Array carries (a zero blend would fade in from silence)
				fade = params._fade = Float64Array.of(1, 1 / (FADE * fs), fromK === 0 ? 1 : 0, fromK === 1 ? 1 : 0, fromK === 2 ? 1 : 0, 0)
			}
			fade[1] = 1 / (FADE * fs)
			variableFade(fade, params._type)
		}
		params._type = type
	}
	if (fade && fade[0] >= 1) fade = undefined

	let set = Float64Array.of(fc, Q, fs)
	let c = params._section ??= lowpass(1000)
	variableBlock(data, s, set, c, type, fade)

	return data
}

/**
 * One block in place, allocating nothing: `s` a Float64Array of the section's two states and the smoothed fc and Q
 * (kept from call to call; NaN fc and Q start at the targets), `set` a Float64Array of the target fc (held to 0.49 of the
 * rate), Q and fs, `c` a section the last sample's coefficients are written into, `type` lowpass, highpass or bandpass.
 * `fade`, when given and under way (variableFade starts one), moves the output from the blend of types it had to this
 * type over its course
 */
export function variableBlock (data, s, set, c, type, fade) {
	let fs = set[2], fc = Math.min(set[0], fs * 0.49), Q = set[1]   // above 0.49 of the rate held there, as the ladders hold it
	let k = type === 'highpass' ? 1 : type === 'bandpass' ? 2 : 0
	if (s[2] !== s[2]) { s[2] = fc; s[3] = Q }

	let F = fade && fade[0] < 1 ? fade : null
	// a fade under way runs the section in direct form II: its two states are then the all-pole history the three types
	// share (they have one denominator), each type's output its numerator on them, the output the blend of those
	if (F !== null && F[5] === 0) { toPoles(s, set, F); F[5] = 1 }

	let smooth = Math.exp(-1 / (TAU * fs))
	let z1 = s[0], z2 = s[1], f = s[2], q = s[3]
	let b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0

	for (let i = 0, n = data.length; i < n; i++) {
		f += (fc - f) * (1 - smooth)
		q += (Q - q) * (1 - smooth)
		// @audio/biquad's lowpass, highpass and bandpass, the same arithmetic, written here so that no number crosses a
		// call each sample: a call the engine leaves uninlined is handed its numbers boxed, an allocation each
		let w = PI2 * f / fs, cw = Math.cos(w), alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha
		a1 = -2 * cw / a0; a2 = (1 - alpha) / a0
		let x = data[i]
		if (F === null) {
			if (k === 0) { b0 = (1 - cw) / 2 / a0; b1 = (1 - cw) / a0; b2 = (1 - cw) / 2 / a0 }
			else if (k === 1) { b0 = (1 + cw) / 2 / a0; b1 = -(1 + cw) / a0; b2 = (1 + cw) / 2 / a0 }
			else { b0 = alpha / a0; b1 = 0 / a0; b2 = -alpha / a0 }
			let y = b0 * x + z1
			z1 = b1 * x - a1 * y + z2
			z2 = b2 * x - a2 * y
			data[i] = y
			continue
		}
		// the weights move along t²(3 − 2t) from those the fade began with to this type's, as the ladders' taps do
		let t = F[0], e = t * t * (3 - 2 * t), lo = (1 - cw) / 2 / a0, hi = (1 + cw) / 2 / a0, bp = alpha / a0
		let wl = F[2] + e * ((k === 0 ? 1 : 0) - F[2]), wh = F[3] + e * ((k === 1 ? 1 : 0) - F[3]), wb = F[4] + e * ((k === 2 ? 1 : 0) - F[4])
		b0 = wl * lo + wh * hi + wb * bp; b1 = 2 * (wl * lo - wh * hi); b2 = wl * lo + wh * hi - wb * bp
		let v = x - a1 * z1 - a2 * z2
		data[i] = b0 * v + b1 * z1 + b2 * z2
		z2 = z1; z1 = v
		F[0] = t + F[1] < 1 ? t + F[1] : 1
		if (F[0] === 1) {
			// the fade done: back to the transposed form, its states this type's numerator on the history (toPoles, inverted)
			if (k === 0) { b0 = lo; b1 = (1 - cw) / a0; b2 = lo }
			else if (k === 1) { b0 = hi; b1 = -(1 + cw) / a0; b2 = hi }
			else { b0 = bp; b1 = 0 / a0; b2 = -alpha / a0 }
			let m = b2 - b0 * a2, w1 = z1
			z1 = (b1 - b0 * a1) * w1 + m * z2
			z2 = m * w1 - (b1 * a2 - a1 * b2) * z2
			F[5] = 0
			F = null
		}
	}

	s[0] = z1; s[1] = z2; s[2] = f; s[3] = q
	c.b0 = b0; c.b1 = b1; c.b2 = b2; c.a1 = a1; c.a2 = a2

	return data
}

// The transposed form's states (s[0], s[1]) as the all-pole history w1, w2 they hold, under the numerator of the blend
// the fade begins from (F[2…4], the weights of lowpass, highpass, bandpass) at the smoothed fc and Q the last sample had
// (s[2], s[3]): z1 = (b1 − b0·a1)·w1 + (b2 − b0·a2)·w2, z2 = (b2 − b0·a2)·w1 − (b1·a2 − a1·b2)·w2, solved for w1, w2.
// Only typed arrays cross the call
function toPoles (s, set, F) {
	let w = PI2 * s[2] / set[2], cw = Math.cos(w), alpha = Math.sin(w) / (2 * s[3]), a0 = 1 + alpha, a1 = -2 * cw / a0, a2 = (1 - alpha) / a0
	let lo = (1 - cw) / 2 / a0, hi = (1 + cw) / 2 / a0, bp = alpha / a0
	let b0 = F[2] * lo + F[3] * hi + F[4] * bp, b1 = 2 * (F[2] * lo - F[3] * hi), b2 = F[2] * lo + F[3] * hi - F[4] * bp
	let m11 = b1 - b0 * a1, m12 = b2 - b0 * a2, m22 = a1 * b2 - a2 * b1, det = m11 * m22 - m12 * m12
	let w1 = (m22 * s[0] - m12 * s[1]) / det, w2 = (m11 * s[1] - m12 * s[0]) / det
	s[0] = Math.abs(w1) < Infinity ? w1 : 0
	s[1] = Math.abs(w2) < Infinity ? w2 : 0
}

/**
 * Starts a fade, or restarts one under way, toward the type variableBlock is next given, from the blend the output has:
 * `type` (the last given) alone, or the blend of a fade under way. `fade` a Float64Array(6) of where it is (0 to 1), its
 * step a sample (1 / the samples it lasts), the weights of lowpass, highpass and bandpass it begins from, and 1 while the
 * section runs in direct form (variableBlock keeps it)
 */
export function variableFade (fade, type) {
	let k = type === 'highpass' ? 1 : type === 'bandpass' ? 2 : 0, t = fade[0], e = t * t * (3 - 2 * t)
	for (let j = 0; j < 3; j++) fade[2 + j] = t < 1 ? fade[2 + j] + e * ((j === k ? 1 : 0) - fade[2 + j]) : j === k ? 1 : 0
	fade[0] = 0
	return fade
}
