// The resonator's parameter edges, as a real-time host and a direct caller reach them: fc held at 0.49 of the rate,
// an fc/bw/fs that cannot design a stable section throwing instead of writing NaN, state kept on the params object while
// it is edited and restarted with a new one, a steady block equal to the plain section, and a moved fc smoothed rather
// than clicked. The plain section and the smooth ramp are both computed here, from H(z), so no test leans on the code it
// checks: y = b0·x + b2·x[n−2] − a1·y[n−1] − a2·y[n−2], R = e^(−π·bw/fs), w0 = 2π·fc/fs.
import test, { ok, is, throws } from 'tst'
import resonator, { resonatorCoefs } from '@audio/filter-resonator'
import { resonator as hosted } from '@audio/filter-resonator/audio'

const FS = 44100

// H(z)'s section at fc, bw and fs, as [b0, b2, a1, a2]
const section = (fc, bw, fs) => {
	let R = Math.exp(-Math.PI * bw / fs), w0 = 2 * Math.PI * fc / fs, b0 = (1 - R * R) / 2
	return [b0, -b0, -2 * R * Math.cos(w0), R * R]
}

// A block through a section, state carried in `s` = {x1, x2, y1, y2} (the plain JOS two-pole recursion, in Float64)
const plainBlock = (data, s, c) => {
	let [b0, b2, a1, a2] = c, x1 = s.x1 || 0, x2 = s.x2 || 0, y1 = s.y1 || 0, y2 = s.y2 || 0
	for (let i = 0; i < data.length; i++) {
		let x = data[i], y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2
		x2 = x1; x1 = x; y2 = y1; y1 = y
		data[i] = y
	}
	Object.assign(s, { x1, x2, y1, y2 })
	return data
}

// A sine through a plain resonator whose fc and bw are sampled once a block — the ramp a host with `smoothing` gives,
// and what a plain retune jumps. `fcAt(pos)` is the value at a block's first frame
const plainRunInPlace = (x, fs, fcAt, bwAt = () => 50, block = 128) => {
	let y = Float64Array.from(x), s = {}
	for (let pos = 0; pos < x.length; pos += block) {
		let n = Math.min(block, x.length - pos)
		plainBlock(y.subarray(pos, pos + n), s, section(fcAt(pos), bwAt(pos), fs))
	}
	return y
}

// A run through the /audio processor: `set(pos)` is the fc/bw at the first frame of each call, `cut(pos)` its frames; a
// call does not cross `at` (a host hands a new value at a call's first frame, so a call ending there is the well-formed
// cut of any block size — as test/audio.js cuts its fades). `bump` adds an impulse to the input at that frame
const host = (x, fs, set, cut = () => 128, at = Infinity, bump = -1) => {
	let proc = hosted({ sampleRate: fs, maxBlockSize: 4096, maxChannels: 1, params: {}, buffers: {} })
	let inp = Float32Array.from(x), out = new Float32Array(x.length), p = { fc: Float32Array.of(0), bw: Float32Array.of(0) }
	if (bump >= 0) inp[bump] += 1
	for (let pos = 0; pos < x.length; ) {
		let n = Math.min(cut(pos), x.length - pos)
		if (pos < at && pos + n > at) n = at - pos
		let { fc, bw } = set(pos)
		p.fc[0] = fc; p.bw[0] = bw
		proc([[inp.subarray(pos, pos + n)]], [[out.subarray(pos, pos + n)]], p)
		pos += n
	}
	return out
}

const sine = (n, f, fs = FS, amp = 0.5) => Float64Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * f * i / fs))
const maxAbs = (y, a = 0, b = y.length) => { let m = 0; for (let i = a; i < b; i++) m = Math.max(m, Math.abs(y[i])); return m }
const d2 = (y, a, b) => { let m = 0; for (let i = Math.max(a, 2); i < b; i++) m = Math.max(m, Math.abs(y[i] - 2 * y[i - 1] + y[i - 2])); return m }

// ── bounds: fc held at 0.49·fs, as the family's /audio processors hold it ───────────────────────────────────────

test('resonator — fc over 0.49·fs is held there: the same section and the same output, bit for bit', () => {
	for (let [fs, fc] of [[22050, 20000], [8000, 5000], [44100, 30000]]) {
		let top = 0.49 * fs
		// the section written by resonatorCoefs is the one at the held frequency
		let a = resonatorCoefs(fc, 50, fs), b = resonatorCoefs(top, 50, fs)
		ok(a.every((v, i) => Object.is(v, b[i])), `${fc} Hz at ${fs}: the section of ${top} Hz`)

		// a direct run sounds as one at the held frequency, every frame
		let x = sine(2048, 300, fs), y = Float64Array.from(x), z = Float64Array.from(x)
		let p = { fc, bw: 50, fs }, q = { fc: top, bw: 50, fs }
		for (let pos = 0; pos < x.length; pos += 128) { resonator(y.subarray(pos, pos + 128), p); resonator(z.subarray(pos, pos + 128), q) }
		ok(y.every((v, i) => Object.is(v, z[i])), `${fc} Hz: the direct call sounds as ${top} Hz, bit for bit`)
		ok(y.every(Number.isFinite), `${fc} Hz: finite output`)

		// the /audio processor holds it too, through its own path
		let h = host(x, fs, () => ({ fc, bw: 50 })), k = host(x, fs, () => ({ fc: top, bw: 50 }))
		ok(h.every((v, i) => Object.is(v, k[i])), `${fc} Hz hosted: as ${top} Hz, bit for bit`)
		ok(h.every(Number.isFinite), `${fc} Hz hosted: finite output`)
	}
	// far past the rate: still held, never an error (only a non-finite or negative value is)
	let x = sine(512, 300, 8000)
	let y = host(x, 8000, () => ({ fc: 1e9, bw: 50 }))
	ok(y.every(Number.isFinite), 'fc 1e9 Hz: held, finite')
})

// ── invalid values: an Error naming the function, never a silent run ────────────────────────────────────────────

test('resonator — a negative, NaN or Infinity fc/bw throws an Error naming the call, as does a bad fs', () => {
	let data = () => new Float64Array(16)
	for (let bad of [-1, -1e-3, NaN, Infinity]) {
		throws(() => resonator(data(), { fc: bad, bw: 50, fs: FS }), /resonator: params\.fc/, `direct: fc ${bad} throws, naming resonator`)
		throws(() => resonator(data(), { fc: 440, bw: bad, fs: FS }), /resonator: params\.bw/, `direct: bw ${bad} throws, naming resonator`)
		throws(() => resonatorCoefs(bad, 50, FS), /resonatorCoefs: params\.fc/, `resonatorCoefs: fc ${bad} throws, naming resonatorCoefs`)
		throws(() => resonatorCoefs(440, bad, FS), /resonatorCoefs: params\.bw/, `resonatorCoefs: bw ${bad} throws, naming resonatorCoefs`)
		// a host's float32 values take the same path
		throws(() => host(sine(64, 300), FS, () => ({ fc: bad, bw: 50 })), /resonator: params\.fc/, `hosted: fc ${bad} throws, naming resonator`)
		throws(() => host(sine(64, 300), FS, () => ({ fc: 440, bw: bad })), /resonator: params\.bw/, `hosted: bw ${bad} throws, naming resonator`)
	}
	for (let bad of [0, -1, NaN, Infinity]) {
		throws(() => resonator(data(), { fc: 440, bw: 50, fs: bad }), /resonator: params\.fs/, `direct: fs ${bad} throws, naming resonator`)
	}
	// the error says which parameter and what was asked, not a bare 'invalid'
	let err
	try { resonator(data(), { fc: -5, bw: 50 }) } catch (e) { err = e }
	ok(err instanceof Error && /resonator/.test(err.message) && /-5/.test(err.message), `the Error names the call and the value: ${err && err.message}`)

	// bw 0 is not negative: a resonator of unbounded Q, allowed (and finite for a while), not an error
	let y = Float64Array.from(sine(512, 440))
	resonator(y, { fc: 440, bw: 0, fs: FS })
	ok(y.slice(0, 64).every(Number.isFinite), 'bw 0 is allowed (infinite Q), not an error')
})

// ── state: kept on the same object, restarted with a new one ───────────────────────────────────────────────────

test('resonator — state is kept while the same params object is edited, and a new object starts from silence', () => {
	let fs = FS, x = Float64Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))
	let p = { fc: 1000, bw: 50, fs }, y = Float64Array.from(x)
	resonator(y.subarray(0, 512), p)   // rings
	p.fc = 1000                        // edited in place, same values: state must continue
	resonator(y.subarray(512), p)
	ok(maxAbs(y, 512) > 1e-3, 'the same object, edited, keeps the ring across the block boundary')

	// a new object at the same values starts from silence: the tail of the impulse is not heard
	let z = Float64Array.from(x)
	resonator(z.subarray(0, 512), { fc: 1000, bw: 50, fs })
	resonator(z.subarray(512), { fc: 1000, bw: 50, fs })
	is(maxAbs(z, 512), 0, 'a new params object starts a fresh section: no state carried')
	// and the first half is the same as the one that continued (the split itself does not change the sound)
	ok(y.subarray(0, 512).every((v, i) => Object.is(v, z[i])), 'the first block is the same either way')

	// the state kept is the section's: blocks of 1, 7 or 1000 frames give the same samples as one call
	let a = Float64Array.from(sine(4096, 440)), b = Float64Array.from(a), c = Float64Array.from(a)
	let pa = { fc: 800, bw: 90, fs }, pb = { fc: 800, bw: 90, fs }, pc = { fc: 800, bw: 90, fs }
	resonator(a, pa)
	for (let pos = 0, i = 0; pos < a.length; i++) { let n = Math.min(1 + (i * 7) % 250, a.length - pos); resonator(b.subarray(pos, pos + n), pb); pos += n }
	for (let pos = 0; pos < a.length; pos += 1000) resonator(c.subarray(pos, pos + 1000), pc)
	ok(a.every((v, i) => Object.is(v, b[i])), 'blocks of 1 to 250 frames: the same, bit for bit')
	ok(a.every((v, i) => Object.is(v, c[i])), 'blocks of 1000 frames: the same, bit for bit')
})

// ── steady state: the plain section, to 1e-6 ───────────────────────────────────────────────────────────────────

test('resonator — a steady setting is the plain JOS resonator at the same fc, bw, fs, within 1e-6', () => {
	for (let [fc, bw, fs] of [[440, 50, 44100], [2000, 50, 44100], [1000, 120, 48000], [100, 10, 22050], [15000, 200, 44100]]) {
		let x = sine(4096, fc, fs), want = plainRunInPlace(x, fs, () => fc, () => bw)

		// a direct call, one block
		let got = Float64Array.from(x)
		resonator(got, { fc, bw, fs })
		let err = 0
		for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(got[i] - want[i]))
		ok(err <= 1e-6, `direct ${fc} Hz/${bw} Hz at ${fs}: within ${err.toExponential(2)} of the plain section`)

		// the /audio processor, many blocks
		let h = host(x, fs, () => ({ fc, bw }))
		let herr = 0
		for (let i = 0; i < x.length; i++) herr = Math.max(herr, Math.abs(h[i] - want[i]))
		ok(herr <= 1e-6, `hosted ${fc} Hz/${bw} Hz at ${fs}: within ${herr.toExponential(2)} of the plain section`)
	}
})

// ── a moved fc: smoother than the plain retune's jump, whatever cut the host uses ──────────────────────────────

test('resonator — a 440 → 2000 Hz jump at a block boundary is a 20 ms glide, closer to the smooth ramp than a plain retune', () => {
	let fs = FS, N = 16384, at = 8192, x = sine(N, 440, fs)

	// the plain retune: fc steps at the boundary, state kept — the click this processor must not make
	let abrupt = plainRunInPlace(x, fs, pos => (pos < at ? 440 : 2000))
	// the smooth result: fc runs 440 → 2000 over 20 ms, one section a block (the ramp a host with smoothing gives)
	let L = Math.round(0.02 * fs)
	let smooth = plainRunInPlace(x, fs, pos => (pos < at ? 440 : pos < at + L ? 440 + (2000 - 440) * (pos - at) / L : 2000), () => 50, 32)

	// what the processor does, with the value changing between two calls of 4096 frames
	let got = host(x, fs, pos => (pos < at ? { fc: 440, bw: 50 } : { fc: 2000, bw: 50 }), () => 4096, at)

	// over the jump and the glide: the largest sample-to-sample difference from the smooth ramp
	let dev = (y, ref, a, b) => { let m = 0; for (let i = a; i < b; i++) m = Math.max(m, Math.abs(y[i] - ref[i])); return m }
	let [a, b] = [at - 256, at + Math.round(0.04 * fs)]
	let dGot = dev(got, smooth, a, b), dAbrupt = dev(abrupt, smooth, a, b)
	ok(dGot < dAbrupt, `closer to the smooth ramp (${dGot.toExponential(2)}) than the plain retune (${dAbrupt.toExponential(2)})`)
	ok(dGot < 0.5 * dAbrupt, `clearly closer: ${(dGot / dAbrupt).toFixed(2)} of the plain retune's deviation`)

	// and no step at the boundary: the second difference there stays with the signal's own, before and after the move
	let base = Math.max(d2(abrupt, at - 4096, at), d2(got, at + Math.round(0.04 * fs), at + Math.round(0.08 * fs)))
	let jump = d2(got, at, at + 1024)
	ok(jump < 2.5 * base, `second difference at the boundary ${(jump / base).toFixed(2)}x the steady one (a plain retune reads ${(d2(abrupt, at, at + 1024) / base).toFixed(1)}x)`)
	ok(d2(abrupt, at, at + 1024) > 2.5 * base, 'the plain retune does click, so the measure is not vacuous')

	// well-formed hosts: the frames do not depend on how the calls are cut, only on the values and the frames
	let ref = got
	for (let cut of [1, 7, 32, 128, 1000]) {
		let y = host(x, fs, pos => (pos < at ? { fc: 440, bw: 50 } : { fc: 2000, bw: 50 }), () => cut, at)
		ok(y.every((v, i) => Object.is(v, ref[i])), `calls of ${cut} frames: the same samples as calls of 4096, bit for bit`)
	}
	// ...and the glide lands: from 20 ms on the section is the plain one at 2000 Hz. Past a filter's settling, the history
	// before an instant is a constant added to its response, so the difference one impulse makes is that section's own
	// impulse response, whatever the sweep left in the state: an impulse 20 ms in must make the plain 2000 Hz response
	let tailFrom = at + L
	let withImpulse = host(x, fs, pos => (pos < at ? { fc: 440, bw: 50 } : { fc: 2000, bw: 50 }), () => 32, at, tailFrom)
	let without = host(x, fs, pos => (pos < at ? { fc: 440, bw: 50 } : { fc: 2000, bw: 50 }), () => 32, at)
	let imp = new Float64Array(512)
	imp[0] = 1
	resonator(imp, { fc: 2000, bw: 50, fs })
	let rerr = 0
	for (let i = 0; i < 512; i++) rerr = Math.max(rerr, Math.abs((withImpulse[tailFrom + i] - without[tailFrom + i]) - imp[i]))
	ok(rerr <= 1e-6, `landed: an impulse 20 ms in makes the plain 2000 Hz section's own response, within ${rerr.toExponential(2)}`)
	ok(maxAbs(got, at + L) <= 0.5 + 1e-3, `the glide lands: output stays within the 0.5 peak the section gives a 0.5 sine (largest ${maxAbs(got).toFixed(3)})`)
	ok(got.every(Number.isFinite), 'the whole sweep is finite')
})
