/**
 * Comb filter — feedforward (FIR) and feedback (IIR)
 *
 * The delay is given in milliseconds and converted to sample frames at `params.fs`
 * (44100 when absent). The delay line is allocated once for the longest delay and
 * shorter delays reuse it; it is rebuilt (and its state cleared) only when a delay
 * asks for more frames than the ring currently holds.
 *
 * The delay line is read as @audio/effect's delay reads its line: d samples back,
 * between two samples where d is not a whole frame; a new d glides from where the
 * last call ended, the read moving no faster than a tape head allows — at most half
 * a frame of extra delay and at most a frame less per frame, never a jump.
 *
 * A delay given as a whole number with no `fs` is read as whole frames, the
 * historical calling convention (`{ delay: 3 }` = three frames).
 *
 * @module  audio-filter/effect/comb
 */

// The delay in samples a time (seconds) asks for, at least one so the feedback loop stays causal: @audio/effect's
// delaySamples. A host passes a time as a Float32: 10 ms arrives as 0.009999999776, 479.99999 frames at 48 kHz. Within a
// Float32 step (2^-23 of it) of a whole frame it is that frame, so such a time reads one sample, bit for bit as a line
// of whole frames read it; any other time reads between two samples
export function delaySamples (time, fs) {
	let d = time * fs, r = Math.round(d)
	if (Math.abs(d - r) <= r * 2 ** -23) d = r
	return Math.max(1, d)
}

// How far the read may move in a frame while the delay moves (@audio/effect's delay): no slower than half speed and no
// faster than double, a bend of an octave at most
const GROW = 0.5, SHRINK = 1

const DEFAULT_FS = 44100

// A delay in milliseconds, at the rate, as the frames the line reads. Below a frame it cannot be honored: a sub-frame
// delay is not causal for the feedback loop, so it is an error rather than a silent clamp to one frame. A non-finite or
// negative time is an error for the same reason — the caller asked for a line that does not exist.
function delayOf (params) {
	let ms = params.delay
	if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
		throw new TypeError(`comb: delay must be a finite non-negative number of milliseconds, got ${ms}`)
	}
	let fs = params.fs == null ? DEFAULT_FS : params.fs
	if (typeof fs !== 'number' || !Number.isFinite(fs) || fs <= 0) {
		throw new RangeError(`comb: fs must be a finite positive sample rate, got ${fs}`)
	}
	// No fs given and a whole number: the historical convention read such a delay as whole frames.
	if (params.fs == null && Number.isInteger(ms)) return { d: Math.max(1, ms), fs }
	let raw = ms / 1000 * fs
	if (raw < 1) throw new RangeError(`comb: delay ${ms} ms at ${fs} Hz is under one frame (${1000 / fs} ms); give at least one frame of delay`)
	let d = delaySamples(ms / 1000, fs)
	return { d, fs }
}

export default function comb (data, params) {
	if (!params || typeof params !== 'object') throw new TypeError('comb: params object is required')
	let { d, fs } = delayOf(params)
	let gain = params.gain == null ? .5 : params.gain
	if (typeof gain !== 'number' || !Number.isFinite(gain)) {
		throw new TypeError(`comb: gain must be finite, got ${gain}`)
	}
	// |gain| at or above one is an unbounded feedback loop; hold it just inside, so no call can feed the line Infinity
	if (gain >= 1) gain = 1 - 1e-6
	else if (gain <= -1) gain = -1 + 1e-6
	let type = params.type == null ? 'feedforward' : params.type
	if (type !== 'feedforward' && type !== 'feedback') {
		throw new TypeError(`comb: type must be 'feedforward' or 'feedback', got ${type}`)
	}

	// a ring made for a longer delay holds this one; one too short is made anew, empty
	let glide = params._glide ??= new Float64Array(2).fill(NaN)
	if (!params.buffer || params.buffer.length < Math.floor(d) + 2) {
		params.buffer = new Float64Array(Math.floor(d) + 2)
		params.ptr = 0
		glide[0] = glide[1] = NaN
	}
	// the rate changed: the held delay is a frame count of the old rate, so it cannot continue as this rate's. Clear the
	// glide (the ring and its contents stay, and still bound the read), never carrying a stale trajectory across rates
	if (params._fs !== fs) {
		params._fs = fs
		glide[0] = glide[1] = NaN
	}

	let st = Float64Array.of(params.ptr, glide[0], glide[1])
	let set = Float64Array.of(d, gain, type === 'feedback' ? 1 : 0)
	combBlock(data, params.buffer, st, set)
	params.ptr = st[0]; glide[0] = st[1]; glide[1] = st[2]

	return data
}

/**
 * One block in place, allocating nothing: `buf` the ring, at least floor(d) + 2 long (made for the longest delay), `s` a
 * Float64Array of the write position, the delay the last call ended on and where its read was (NaN, NaN before the first
 * call), kept from call to call; `set` one of the delay in samples (≥ 1), the gain, and 1 for feedback, 0 feedforward.
 * The read follows the new delay at tape-head speed, at most GROW frames longer and SHRINK frames shorter in a frame; a
 * move farther than that continues over the following calls. `gains`, when given, is the gain each frame, in its place
 */
export function combBlock (data, buf, s, set, gains) {
	let N = buf.length, ptr = s[0], d = set[0], gain = set[1], fb = set[2] === 1, G = gains !== undefined
	let at = s[2] >= 1 ? s[2] : (s[1] >= 1 ? s[1] : d)

	for (let i = 0, l = data.length; i < l; i++) {
		// the read follows the new delay d at tape-head speed: at most GROW frames longer and SHRINK frames shorter in a
		// frame, so a move farther than that continues over the following calls instead of arriving within this block
		at = d > at + GROW ? at + GROW : d < at - SHRINK ? at - SHRINK : d
		let D = Math.floor(at), f = at - D
		let r = ptr - D
		if (r < 0) r += N
		let delayed = buf[r]
		if (f) delayed += f * (buf[r ? r - 1 : N - 1] - delayed)
		let x = data[i], y = x + (G ? gains[i] : gain) * delayed
		// feedback keeps its output in the line, feedforward its input
		buf[ptr] = fb ? y : x
		if (++ptr === N) ptr = 0
		data[i] = y
	}

	s[0] = ptr
	s[1] = d
	s[2] = at

	return data
}
