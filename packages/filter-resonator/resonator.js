/**
 * Constant-peak-gain resonator (JOS two-zero form)
 * Two zeros at z=±1 normalize the pole peak to exactly 1, regardless of fc/bw.
 * Used for modal synthesis (bells, drums), formant synthesis.
 *
 * H(z) = ((1-R²)/2)·(1-z⁻²) / (1 - 2R*cos(w0)*z^-1 + R²*z^-2)
 * where R = exp(-π*bw/fs), w0 = 2π*fc/fs
 *
 * cf. Julius O. Smith III, "Introduction to Digital Filters", Two-Pole
 * section, "Constant Peak-Gain Resonator"
 *
 * Bounds. fc is held to 0.49 of the sample rate, as every /audio processor of
 * the family holds it: past Nyquist the resonance would sound at its alias.
 * An fc or bw that is negative, NaN or Infinity (or an fs that is not a
 * positive finite number) would design a section with its poles on or outside
 * the unit circle — bw < 0 makes R > 1 — so the call throws an Error naming
 * the function, instead of writing NaN or a runaway into the output.
 *
 * A moved fc or bw is glided, not jumped: over 20 ms, a coefficient set a
 * frame, from the values the last call ended on to the ones this call brings.
 * A jump in the coefficients of a ringing pole is a click; a glide is not. The
 * glide lives on the params object beside the section's state, so a caller
 * that edits the same object between blocks keeps both and hears one sweep;
 * a new params object carries neither, so it starts from silence at its own
 * values. Values held are reached exactly, and a steady block is then the
 * plain section, designed once and run frame by frame as before.
 *
 * @module  audio-filter/effect/resonator
 */

let {cos, exp, PI} = Math

/** fc is held at this fraction of the sample rate, as the /audio processors of the family hold it */
const HOLD = 0.49
/** seconds a moved fc or bw takes to reach the value a call brings */
export const GLIDE = 0.02

const C = new Float64Array(4), S = new Float64Array(4), SET = new Float64Array(3)   // a direct call's coefficients, state, and fc/bw/fs

/**
 * Throw unless fc, bw and fs can design a stable section: fc and bw a finite number >= 0, fs a positive finite number.
 * `name` is the called function's name, so the Error says which call a host got wrong.
 */
export function checkResonator (name, fc, bw, fs) {
	if (typeof fc !== 'number' || !Number.isFinite(fc) || fc < 0) throw new Error(`${name}: params.fc must be a finite number >= 0, got ${fc}`)
	if (typeof bw !== 'number' || !Number.isFinite(bw) || bw < 0) throw new Error(`${name}: params.bw must be a finite number >= 0, got ${bw}`)
	if (typeof fs !== 'number' || !Number.isFinite(fs) || fs <= 0) throw new Error(`${name}: params.fs must be a positive finite number, got ${fs}`)
}

/** The section at fc (held to 0.49·fs), bw and fs, written into c: b0, b2, a1, a2 */
function design (c, fc, bw, fs) {
	let f = fc > fs * HOLD ? fs * HOLD : fc
	let R = exp(-PI * bw / fs)
	let w0 = 2 * PI * f / fs
	c[0] = (1 - R * R) / 2
	c[1] = -c[0]
	c[2] = -2 * R * cos(w0)
	c[3] = R * R
	return c
}

/**
 * A glide's memory, one per section (a channel), made NaN and filled by the first run: the fc and bw the sound is at,
 * the fc and bw the call in force brought, the fc and bw the glide started from, the frames of it run, the fs it is
 * timed at and its length, then the section last designed (e[8], e[9] the fc and bw of it, NaN until designed). A NaN
 * fc: not started — the next call begins at its own values, with no glide.
 */
export function resonatorGlide () { return Float64Array.of(NaN, NaN, NaN, NaN, NaN, NaN, 0, NaN, NaN, NaN) }

export default function resonator (data, params) {
	params = params || {}
	let fc = params.fc, fs = params.fs == null ? 44100 : params.fs
	if (fc == null) throw new Error('resonator: params.fc is required')
	let bw = params.bw == null ? 50 : params.bw
	checkResonator('resonator', fc, bw, fs)
	if (fc > fs * HOLD) fc = fs * HOLD

	// A new params object has no glide and no state: it starts from silence at its own values
	let g = params._rGlide
	if (!g) g = params._rGlide = resonatorGlide()

	S[0] = params._rX1 != null ? params._rX1 : 0
	S[1] = params._rX2 != null ? params._rX2 : 0
	S[2] = params._rY1 != null ? params._rY1 : 0
	S[3] = params._rY2 != null ? params._rY2 : 0

	SET[0] = fc; SET[1] = bw; SET[2] = fs
	resonatorRun(data, S, g, SET)

	params._rX1 = S[0]
	params._rX2 = S[1]
	params._rY1 = S[2]
	params._rY2 = S[3]

	// the section in force at the block's end (the plain one once the glide has landed): what the tail and the
	// magnitude checks read
	design(C, g[0], g[1], fs)
	params._rB0 = C[0]; params._rB2 = C[1]; params._rA1 = C[2]; params._rA2 = C[3]
	params._rFc = g[0]; params._rBw = g[1]; params._rFs = fs

	return data
}

/**
 * One block in place through a section whose fc and bw glide to the call's values, allocating nothing: `s` x1, x2, y1,
 * y2 kept from call to call, `g` a resonatorGlide() kept beside it, `set` a Float64Array of this call's fc, bw and fs
 * (fc held to 0.49·fs; all three already validated by the caller — checkResonator). A value that did not move is
 * designed as it is; a value that moved is reached over GLIDE seconds, one section a frame, and then designed as it is.
 * The frames a call brings are the same however a host cut its calls: a glide runs a frame at a time, and its state is
 * the frames run. The values arrive in one array rather than as three arguments: a call the engine leaves uninlined is
 * handed its numbers boxed, an allocation each (as comb's glide notes).
 */
export function resonatorRun (data, s, g, set) {
	let fs = set[2], fc = set[0], bw = set[1]
	if (fc > fs * HOLD) fc = fs * HOLD
	let L = Math.max(1, Math.round(GLIDE * fs)), n = data.length
	if (!(g[0] === g[0]) || g[7] !== fs) {
		// first call at this rate: on this call's values, no glide
		g[0] = fc; g[1] = bw; g[2] = fc; g[3] = bw; g[4] = fc; g[5] = bw; g[6] = L; g[7] = fs
		g[8] = NaN; g[9] = NaN
	} else if (fc !== g[2] || bw !== g[3]) {
		// a value moved: glide from where the sound is, to the value this call brings
		g[4] = g[0]; g[5] = g[1]; g[2] = fc; g[3] = bw; g[6] = 0
	}

	let k = g[6], i = 0
	let x1 = s[0], x2 = s[1], y1 = s[2], y2 = s[3]

	if (k < L) {
		let fromF = g[4], fromB = g[5], toF = g[2], toB = g[3]
		for (let end = n < L - k ? n : L - k; i < end; i++, k++) {
			// the last frame of the glide is the value itself, bit for bit: not the interpolation's rounding of it
			let f = k + 1 === L ? toF : fromF + (toF - fromF) * (k + 1) / L
			let b = k + 1 === L ? toB : fromB + (toB - fromB) * (k + 1) / L
			// a section at this frame's value, designed into C — no number crosses a call: a call handed numbers is
			// handed them boxed where the engine leaves it uninlined, an allocation each (as comb's glide notes)
			design(C, f, b, fs)
			let x = data[i]
			let y = C[0] * x + C[1] * x2 - C[2] * y1 - C[3] * y2
			x2 = x1; x1 = x; y2 = y1; y1 = y
			data[i] = y
		}
		if (k < L) {
			// still moving: where the sound is, for the next call to start from
			g[0] = fromF + (toF - fromF) * k / L
			g[1] = fromB + (toB - fromB) * k / L
			g[6] = k
			s[0] = x1; s[1] = x2; s[2] = y1; s[3] = y2
			return data
		}
		// landed: the rest of the call is the plain section at the values in force
		g[0] = toF; g[1] = toB; g[6] = L
	}

	// steady (a value that did not move, or a glide that landed): the section designed once and kept while the values stay
	if (!(g[8] === g[2]) || !(g[9] === g[3])) { design(C, g[2], g[3], fs); g[8] = g[2]; g[9] = g[3] }
	let b0 = C[0], b2 = C[1], a1 = C[2], a2 = C[3]
	for (; i < n; i++) {
		let x = data[i]
		let y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2
		x2 = x1; x1 = x; y2 = y1; y1 = y
		data[i] = y
	}

	s[0] = x1; s[1] = x2; s[2] = y1; s[3] = y2
	return data
}

/**
 * The section of a resonator at fc, bw and fs, written into `c` (a Float64Array of b0, b2, a1, a2) and returned.
 * fc is held at 0.49·fs; a negative, NaN or Infinity fc/bw (or a non-positive fs) throws, naming this function.
 */
export function resonatorCoefs (fc, bw, fs, c = new Float64Array(4)) {
	checkResonator('resonatorCoefs', fc, bw, fs)
	return design(c, fc, bw, fs)
}

/**
 * One block in place, allocating nothing: `s` a Float64Array of x1, x2, y1, y2 (kept from call to call), `c` one of
 * b0, b2, a1, a2 (resonatorCoefs)
 */
export function resonatorBlock (data, s, c) {
	let b0 = c[0], b2 = c[1], a1 = c[2], a2 = c[3]
	let x1 = s[0], x2 = s[1], y1 = s[2], y2 = s[3]

	for (let i = 0, l = data.length; i < l; i++) {
		let x = data[i]
		let y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2
		x2 = x1
		x1 = x
		y2 = y1
		y1 = y
		data[i] = y
	}

	s[0] = x1; s[1] = x2; s[2] = y1; s[3] = y2

	return data
}
