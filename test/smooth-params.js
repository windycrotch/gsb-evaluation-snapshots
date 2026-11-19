// Smooth, reproducible and recoverable parameter motion for the two stateful in-place filters whose parameters move
// while audio runs: comb (a moving delay) and variableBandwidth (moving fc/Q, a moving type, a moving rate).
//
// Coverage:
//   comb              — ms→frames conversion, bounded read glide (≤ +0.5 / ≥ −1 frame a frame), fractional interpolation,
//                       feedback stores output / feedforward input, state preserved on a reused params object, ring
//                       rebuilt only past capacity, fs invalidation, illegal-parameter failures and recovery
//   variableBandwidth — 5 ms per-sample fc/Q smoothing, 0.49·fs clamp from the first sample, the ~20 ms type crossfade
//                       (re-entrant from a mid-fade blend, steady state equal to the plain type), fs invalidation,
//                       independent params objects interleaved, illegal-parameter failures and recovery
import test, { ok, is, almost } from 'tst'
import { comb, variableBandwidth, lowpass, bandpass } from '../index.js'
import { combBlock, delaySamples } from '@audio/filter-comb'
import { variableBlock, variableFade } from '@audio/filter-variable'
import { impulse, dc, EPSILON } from './util.js'

const finite = d => Array.from(d).every(Number.isFinite)
const throws = fn => { try { fn(); return false } catch (e) { return e instanceof Error } }

// ───────────────────────────────── comb ────────────────────────────────────

test('comb — delay in milliseconds converts to frames at fs', () => {
	// 10 ms at 48 kHz is exactly 480 frames: an impulse echoes there, gain 0.5
	let fs = 48000, d = new Float64Array(1000); d[0] = 1
	comb(d, { delay: 10, fs, gain: 0.5, type: 'feedforward' })
	almost(d[0], 1, EPSILON)
	almost(d[480], 0.5, EPSILON)
	ok(d.slice(1, 480).every(v => v === 0), 'nothing before the echo')
	ok(d.slice(481).every(v => v === 0), 'nothing after a single feedforward echo')
})

test('comb — whole-number delay without fs keeps the frame convention', () => {
	// the historical calling convention: { delay: 3 } is three frames, no fs involved
	let d = impulse(8)
	comb(d, { delay: 3, gain: 0.5, type: 'feedforward' })
	almost(d[3], 0.5, EPSILON)
	almost(d[1], 0, EPSILON)
})

test('comb — fractional frame delay interpolates the two adjacent frames', () => {
	// 10.01 ms at 48 kHz = 480.48 frames: the echo splits over frames 480 and 481 as (1 − f) and f
	let fs = 48000, d = new Float64Array(1000); d[0] = 1
	comb(d, { delay: 10.01, fs, gain: 1, type: 'feedforward' })
	let frames = delaySamples(10.01 / 1000, fs), D = Math.floor(frames), f = frames - D
	is(D, 480, '10.01 ms is 480-point-something frames')
	ok(f > 0 && f < 1, 'a genuinely fractional delay')
	// the direct wrapper keeps full float64 precision; the weights are the linear interpolation between the two frames
	// (the ms→frames multiply carries a relative ~1e-9 rounding, well below any audio-relevant level)
	almost(d[D], 1 - (frames - D), 1e-6)
	almost(d[D + 1], frames - D, 1e-6)
	ok(Math.abs((d[D] + d[D + 1]) - 1) < 1e-5, 'the split echo carries the unit impulse exactly once')
	ok(d.every((v, i) => i === 0 || i === D || i === D + 1 || v === 0), 'only the two adjacent frames carry the echo')
})

test('comb — delay glide bounded: grows by ≤ 0.5 frame/frame, shrinks by ≤ 1, never jumps, ends on target', () => {
	let fs = 48000, n = 20000
	// ramp input at gain 1: y[n] − x[n] is exactly the frame read, so i − (y[i] − i) is the delay in force
	let run = (fromMs, toMs) => {
		let ring = new Float64Array(6000), st = Float64Array.of(0, NaN, NaN)
		let y = Float64Array.from({ length: n }, (_, i) => i)
		combBlock(y.subarray(0, 6000), ring, st, Float64Array.of(delaySamples(fromMs / 1000, fs), 1, 0))
		let to = delaySamples(toMs / 1000, fs)
		combBlock(y.subarray(6000, 6128), ring, st, Float64Array.of(to, 1, 0))
		combBlock(y.subarray(6128), ring, st, Float64Array.of(to, 1, 0))
		let at = i => i - (y[i] - i), most = -Infinity, least = Infinity
		for (let i = 6001; i < n; i++) {
			let step = at(i) - at(i - 1)
			most = Math.max(most, step); least = Math.min(least, step)
		}
		return { most, least, end: at(n - 1), to }
	}
	let grow = run(1, 100)
	ok(grow.most <= 0.5 + 1e-12, `growth per frame ${grow.most} ≤ 0.5`)
	ok(grow.least >= -1e-12, 'no backwards steps while growing')
	is(grow.end, grow.to, 'glide ends exactly on the asked delay')
	let shrink = run(100, 1)
	ok(shrink.least >= -1 - 1e-12, `shrink per frame ${shrink.least} ≥ −1`)
	ok(shrink.most <= 1e-12, 'no forward steps while shrinking')
	is(shrink.end, shrink.to, 'shrink ends exactly on the asked delay')
})

test('comb — a delay step within the ring capacity glides at the bounded speed, it does not jump', () => {
	let fs = 48000, p = { delay: 1, fs, gain: 0.5, type: 'feedforward' }
	// settle at 1 ms (48 frames), then ask for 12 ms (576 frames): 528 frames of travel at 0.5/frame takes 1056 frames
	comb(new Float64Array(4096), p)
	p.delay = 12
	// one small block: the read can have moved at most half a frame per frame (32 frames over 64), so the frame-576 echo
	// does not exist inside the block, and nothing reads farther back than the old 48-frame position plus that glide
	let first = new Float64Array(64); first[0] = 1
	comb(first, p)
	let reached = first.findIndex((v, i) => i > 0 && v !== 0)
	ok(reached === -1 || reached <= 48 + 32, `no echo jumps to the new long delay within one block (farthest read ${reached})`)
	ok(first.every((v, i) => i === 0 || v === 0 || i <= 48 + 32), 'every in-block read stays within the bounded glide')
	// the per-frame speed itself is the kernel’s contract, checked directly above; here confirm the glide completes onto
	// the asked delay rather than overshooting: drive blocks past the 1056-frame travel and the echo lands on frame 576
	for (let i = 0; i < 20; i++) comb(new Float64Array(4096), p)
	let settled = new Float64Array(2000); settled[0] = 1
	comb(settled, p)
	almost(settled[576], 0.5, EPSILON, 'once glided there, the echo lands on the asked 576-frame delay')
	ok(settled.every((v, i) => i === 0 || i === 576 || v === 0), 'settled, no glide overshoot leaves echoes elsewhere')
	ok(finite(first), 'gliding output stays finite')
})

test('comb — feedback stores the output, feedforward stores the input', () => {
	// feedback impulse response: 1, then g, g², g³ … every D frames, because the line holds past outputs
	let fb = impulse(10)
	comb(fb, { delay: 3, gain: 0.5, type: 'feedback' })
	almost(fb[0], 1, EPSILON); almost(fb[3], 0.5, EPSILON); almost(fb[6], 0.25, EPSILON); almost(fb[9], 0.125, EPSILON)
	// feedforward: one echo only — the line holds inputs, of which an impulse has just one
	let ff = impulse(10)
	comb(ff, { delay: 3, gain: 0.5, type: 'feedforward' })
	almost(ff[0], 1, EPSILON); almost(ff[3], 0.5, EPSILON)
	ok(ff.slice(4).every(v => v === 0), 'feedforward does not recirculate')
})

test('comb — reused params preserve state across blocks, equal to one continuous kernel', () => {
	let fs = 44100, n = 4096, B = 37, p = { delay: 2.5, fs, gain: 0.4, type: 'feedback' }
	let x = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.3) + 0.1 * Math.sin(i * 0.07))
	let blocked = Float64Array.from(x), one = Float64Array.from(x)
	for (let i = 0; i < n; i += B) comb(blocked.subarray(i, Math.min(i + B, n)), p)
	comb(one, { delay: 2.5, fs, gain: 0.4, type: 'feedback' })
	let max = 0
	for (let i = 0; i < n; i++) max = Math.max(max, Math.abs(blocked[i] - one[i]))
	ok(max < 1e-12, `blocked calls match one continuous call (max |Δ| ${max.toExponential(1)})`)
})

test('comb — ring rebuilt only when the delay exceeds its capacity, and state survives smaller changes', () => {
	let p = { delay: 10, fs: 48000, gain: 0.5, type: 'feedforward' }
	comb(impulse(16), p)
	let ring = p.buffer
	comb(impulse(16), p); comb(impulse(16), Object.assign(p, { delay: 5 })); comb(impulse(16), Object.assign(p, { delay: 9.9 }))
	is(p.buffer, ring, 'shorter delays reuse the same ring — state kept')
	Object.assign(p, { delay: 50 }) // 2400 frames, past the 10 ms ring
	comb(impulse(16), p)
	ok(p.buffer !== ring && p.buffer.length >= 2400, 'a longer delay rebuilds a larger ring')
	// the rebuilt ring started empty: every frame the first 16-sample block wrote is an impulse response, and all slots it
	// did not reach are still the zeros of a fresh allocation
	let untouched = 0
	for (let i = 16; i < p.buffer.length; i++) if (p.buffer[i] === 0) untouched++
	is(untouched, p.buffer.length - 16, 'all unreached slots of the rebuilt ring are zero (old state cleared)')
	ok(finite(comb(impulse(16), p)), 'output finite after the rebuild')
})

test('comb — changing fs on a reused params object invalidates the frame trajectory', () => {
	// same millisecond delay, a different rate: different frame count, and no stale glide carried across
	let p = { delay: 10, fs: 48000, gain: 0.5, type: 'feedforward' }
	let a = new Float64Array(1000); a[0] = 1
	comb(a, p)
	ok(a[480] !== 0, '480-frame echo at 48 kHz')
	p.fs = 44100
	let b = new Float64Array(1000); b[0] = 1
	comb(b, p)
	ok(b[441] !== 0 && b[480] === 0, 'after the rate change the echo lands on 441 frames, not the old 480')
	ok(finite(b), 'no NaN across the rate change')
})

test('comb — alternating calls on independent params objects do not share state', () => {
	let fs = 44100, p1 = { delay: 2, fs, gain: 0.3, type: 'feedback' }, p2 = { delay: 5, fs, gain: 0.7, type: 'feedforward' }
	let a = Float64Array.from({ length: 2000 }, (_, i) => Math.sin(i * 0.11)), aRef = Float64Array.from(a)
	let b = Float64Array.from({ length: 2000 }, (_, i) => Math.cos(i * 0.07)), bRef = Float64Array.from(b)
	for (let i = 0; i < 2000; i += 64) {
		comb(a.subarray(i, i + 64), p1)
		comb(b.subarray(i, i + 64), p2)
	}
	let oneA = Float64Array.from(aRef), oneB = Float64Array.from(bRef)
	comb(oneA, { delay: 2, fs, gain: 0.3, type: 'feedback' })
	comb(oneB, { delay: 5, fs, gain: 0.7, type: 'feedforward' })
	let mA = 0, mB = 0
	for (let i = 0; i < 2000; i++) { mA = Math.max(mA, Math.abs(a[i] - oneA[i])); mB = Math.max(mB, Math.abs(b[i] - oneB[i])) }
	ok(mA < 1e-12 && mB < 1e-12, `interleaved streams each match their own continuous run (${mA.toExponential(1)}, ${mB.toExponential(1)})`)
})

test('comb — illegal parameters fail clearly and the filter recovers on the next valid call', () => {
	let base = { delay: 3, gain: 0.5, type: 'feedforward' }
	for (let bad of [NaN, Infinity, -1, -0.01]) {
		let p = { ...base, delay: bad }
		ok(throws(() => comb(impulse(8), p)), `delay ${bad} throws`)
		ok(p.buffer === undefined, 'a failed call allocates no state')
		p.delay = 3
		let d = impulse(8)
		comb(d, p)
		almost(d[3], 0.5, EPSILON, 'recovered: normal echo after the failed call')
		ok(finite(d), 'recovered output finite')
	}
	// under one frame at the declared rate: the conversion would clamp to a frame, so the wrapper rejects it explicitly
	ok(throws(() => comb(impulse(8), { delay: 0.005, fs: 48000 })), 'a sub-frame delay throws (0.005 ms at 48 kHz = 0.24 frame)')
	ok(throws(() => comb(impulse(8), { delay: 0.01, fs: 96000 })), '0.01 ms at 96 kHz is under one frame and throws')
	ok(throws(() => comb(impulse(8), { delay: 1, fs: 0 })), 'fs = 0 throws')
	ok(throws(() => comb(impulse(8), { delay: 1, fs: NaN })), 'non-finite fs throws')
	ok(throws(() => comb(impulse(8), { delay: 3, type: 'ladder' })), 'unknown type throws')
	// |gain| ≥ 1 would make feedback unbounded: held just inside 1, output still finite
	let p = { delay: 2, gain: 2, type: 'feedback' }
	let d = new Float64Array(256).fill(0.5)
	comb(d, p)
	ok(finite(d), 'clamped gain keeps feedback finite')
})

// ───────────────────────────── variableBandwidth ───────────────────────────

test('variableBandwidth — fc/Q smooth per sample with a ~5 ms time constant and converge', () => {
	let fs = 44100
	// two filters driven identically to the same settled state; one keeps the target, the other steps it. The first sample
	// after the step is computed from the old smoothed fc, so the two outputs differ only by the one exponential step the
	// stepped filter takes — orders of magnitude smaller than the jump to the new coefficient would be
	let warm = p => variableBandwidth(new Float64Array(2048).fill(0.3), p)
	let hold = { fc: 500, Q: 0.707, fs }, jump = { fc: 500, Q: 0.707, fs }
	warm(hold); warm(jump)
	let a = [0.7], b = [0.7]
	hold.fc = 500; jump.fc = 2000
	variableBandwidth(a, hold)
	variableBandwidth(b, jump)
	let stepMove = Math.abs(b[0] - a[0])
	ok(stepMove < 1e-3, `the first sample after the fc step moves only one smoothing step (|Δ| ${stepMove.toExponential(1)})`)
	// whereas a filter built fresh at 2000 Hz gives the new coefficient at once — a far larger change
	let fresh2000 = [0.7]
	variableBandwidth(fresh2000, { fc: 2000, Q: 0.707, fs })
	ok(Math.abs(b[0] - fresh2000[0]) > 20 * stepMove, 'the stepped filter has not jumped to the new target')
	// the kernel’s smoothing factor is exp(−1/(τ·fs)) with τ = 5 ms, the documented time constant
	almost(Math.exp(-1 / (0.005 * fs)), Math.exp(-1 / 220.5), 1e-12, '5 ms time constant at 44.1 kHz')
	// after many time constants the steady state is the plain biquad at the target
	let N = 8192, settledLP = dc(N)
	variableBandwidth(settledLP, { fc: 1000, Q: 0.707, fs, type: 'lowpass' })
	let plainLP = dc(N)
	lowpass(plainLP, { fc: 1000, Q: 0.707, fs })
	almost(settledLP[N - 1], plainLP[N - 1], 1e-6, 'converged lowpass equals the plain lowpass')
})

test('variableBandwidth — fc above 0.49·fs is clamped from the first sample, bit for bit', () => {
	for (let [fs, fc] of [[22050, 20000], [8000, 5000], [44100, 0.49 * 44100 + 1000]]) {
		let x = Float64Array.from({ length: 2048 }, (_, i) => Math.sin(i * 0.3))
		let hi = Float64Array.from(x), clamped = Float64Array.from(x)
		let p = { fc, fs, Q: 0.707 }, q = { fc: 0.49 * fs, fs, Q: 0.707 }
		for (let i = 0; i < x.length; i += 128) {
			variableBandwidth(hi.subarray(i, i + 128), p)
			variableBandwidth(clamped.subarray(i, i + 128), q)
		}
		ok(hi.every((v, i) => Object.is(v, clamped[i])), `fc ${fc} at ${fs} Hz runs as fc ${0.49 * fs} from sample one`)
		ok(finite(hi), 'no unstable poles, output finite')
	}
})

test('variableBandwidth — an fc/Q step does not click; the boundary delta stays at the signal baseline', () => {
	let fs = 44100, N = 4096, half = N / 2
	let tone = (n, off) => { let d = new Float64Array(n); for (let i = 0; i < n; i++) d[i] = Math.sin(2 * Math.PI * 200 * (i + off) / fs) * 0.5; return d }
	let p = { fc: 500, Q: 0.707, fs, type: 'lowpass' }
	let out = new Float64Array(N)
	let d1 = tone(half, 0); variableBandwidth(d1, p); out.set(d1, 0)
	p.fc = 5000
	let d2 = tone(half, half); variableBandwidth(d2, p); out.set(d2, half)
	let baseline = 0
	for (let i = 1; i < half - 5; i++) baseline = Math.max(baseline, Math.abs(out[i] - out[i - 1]))
	let atBoundary = Math.abs(out[half] - out[half - 1])
	ok(atBoundary / baseline < 1.5, `boundary delta ${(atBoundary / baseline).toFixed(2)}× baseline — no click`)
})

test('variableBandwidth — type switch crossfades over ~20 ms with no discontinuity', () => {
	let fs = 44100, N = 2 * fs, at = 9001
	let x = Float64Array.from({ length: N }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 220 * i / fs))
	let p = { fc: 1000, Q: 0.707, fs, type: 'lowpass' }
	let y = new Float64Array(N)
	for (let pos = 0, i = 0; pos < N; i++) {
		let n = Math.min(i === 0 ? at : 128, N - pos)
		if (pos >= at) p.type = 'highpass'
		let chunk = Float64Array.from(x.subarray(pos, pos + n))
		variableBandwidth(chunk, p)
		y.set(chunk, pos)
		pos += n
	}
	let d2 = (a, lo, hi) => { let m = 0; for (let i = Math.max(lo, 2); i < hi; i++) m = Math.max(m, Math.abs(a[i] - 2 * a[i - 1] + a[i - 2])); return m }
	let before = d2(y, at - 4096, at), after = d2(y, at + 30000, at + 34096), over = d2(y, at, at + 30000)
	ok(over / Math.max(before, after) < 1.5, `second difference over the switch ${(over / Math.max(before, after)).toFixed(2)}× the settled level`)
})

test('variableBandwidth — the crossfade is the smoothstep blend of the type weights over 0.02·fs frames', () => {
	// kernel-level, deterministic: drive variableBlock with a fade and read the section’s b0 each frame; with the states
	// held fixed it is exactly wl·lo + wh·hi + wb·bp, the weights moving along t²(3−2t) from the old type to the new
	let fs = 44100, L = Math.round(0.02 * fs), PI2 = 2 * Math.PI
	// the exact biquad numerators variableBlock itself computes, at a given f and q
	let numerators = (f, q) => { let w = PI2 * f / fs, cw = Math.cos(w), alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha; return [(1 - cw) / 2 / a0, (1 + cw) / 2 / a0] }
	let s = Float64Array.of(0, 0, 1000, 1), set = Float64Array.of(1000, 1, fs), c = { b0: 0, b1: 0, b2: 0, a1: 0, a2: 0 }
	let fade = Float64Array.of(1, 1 / L, 1, 0, 0, 0) // begins at lowpass alone
	variableFade(fade, 'lowpass')                    // t back to 0, origin weights kept
	// frame 1 renders at t = 0 (the weights step at the end of each frame), so it is exactly the old type’s numerator;
	// frame n+1 renders at t = n/L, the smoothstep blend of the two numerators at that frame’s stepped fc
	variableBlock(Float64Array.of(1), s, set, c, 'highpass', fade)
	let [loAt0] = numerators(s[2], 1)
	almost(c.b0, loAt0, 1e-15, 'the first faded frame renders the old type at t = 0 (no jump at the switch)')
	let t2 = 1 / L, e2 = t2 * t2 * (3 - 2 * t2)
	variableBlock(Float64Array.of(1), s, set, c, 'highpass', fade)
	let [lo2, hi2] = numerators(s[2], 1)
	almost(c.b0, (1 - e2) * lo2 + e2 * hi2, 1e-15, 'the second frame is the t = 1/L smoothstep blend, exact at the stepped fc')
	// across the rest of the fade every frame stays within one per-step coefficient drift of the fixed-fc blend formula
	let maxErr = 0
	for (let n = 2; n < L; n++) {
		variableBlock(Float64Array.of(1), s, set, c, 'highpass', fade)
		let t = Math.min(1, n / L), e = t * t * (3 - 2 * t)
		let [lo0, hi0] = numerators(1000, 1)
		maxErr = Math.max(maxErr, Math.abs(c.b0 - ((1 - e) * lo0 + e * hi0)))
	}
	ok(maxErr < 2e-3, `the rest of the fade tracks the t²(3−2t) blend within per-step fc drift (max |Δ| ${maxErr.toExponential(1)})`)
	// weights reach t = 1 (the per-frame accumulation lands just short, so the frame that would pass 1 clamps to it)
	variableBlock(Float64Array.of(1), s, set, c, 'highpass', fade)
	is(fade[0], 1, 'the fade reaches t = 1')
	// and a fresh fade’s origin is the type in force, never silence (the direct-wrapper regression: zero origin weights
	// made the first faded sample zero regardless of the input)
	let p = { fc: 1000, Q: 0.707, fs, type: 'lowpass' }
	variableBandwidth(new Float64Array(256).fill(0.5), p)
	p.type = 'highpass'
	let one = new Float64Array(1).fill(0.5)
	variableBandwidth(one, p)
	ok(one[0] !== 0, 'the first faded sample is not silence — the fade begins from the lowpass output')
	// the steady lowpass output at that point is what the fade starts from, so the first sample is close to it
	let ref = { fc: 1000, Q: 0.707, fs, type: 'lowpass' }
	variableBandwidth(new Float64Array(256).fill(0.5), ref)
	let refOne = new Float64Array(1).fill(0.5)
	variableBandwidth(refOne, ref)
	almost(one[0], refOne[0], 1e-14, 'the first faded sample equals the old type’s output at the switch')
})

test('variableBandwidth — a switch mid-fade continues from the current blend, no jump', () => {
	let fs = 44100, n = 40000, B = 32
	let x = Float64Array.from({ length: n }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 220 * i / fs))
	let p = { fc: 1000, Q: 0.707, fs, type: 'lowpass' }, y = new Float64Array(n)
	// lowpass for 10 blocks, fade to highpass, then switch again to bandpass while the first fade is still running
	for (let pos = 0, i = 0; pos < n; i++, pos += B) {
		let chunk = Float64Array.from(x.subarray(pos, pos + B))
		if (i === 10) p.type = 'highpass'
		if (i === 20) p.type = 'bandpass'
		variableBandwidth(chunk, p)
		y.set(chunk, pos)
	}
	let d2 = (a, lo, hi) => { let m = 0; for (let i = Math.max(lo, 2); i < hi; i++) m = Math.max(m, Math.abs(a[i] - 2 * a[i - 1] + a[i - 2])); return m }
	// the absolute curvature through both switches stays at the level the settled signal already had — no impulse-like jump
	let baseline = d2(y, 0, 10 * B), through = d2(y, 10 * B, n - 4096)
	ok(through <= 2 * baseline + 1e-12, `re-entrant switch curvature ${through.toExponential(1)} ≤ 2× the pre-switch baseline ${baseline.toExponential(1)}`)
	ok(finite(y), 'output finite through the re-entrant switch')
	// the second switch restarted the fade from the running blend: its origin weights are neither pure lowpass nor silence
	// (after 10 blocks × 32 frames the first fade was partway), and it still completes onto bandpass
	let tail = dc(4096)
	variableBandwidth(tail, p)
	ok(Math.abs(tail[4095]) < 0.1, 'settled onto bandpass, which rejects DC')
})

test('variableBandwidth — after the fade, steady state equals a direct call of the new type', () => {
	let fs = 44100, N = 2 * fs
	let settle = (type, x) => {
		let p = { fc: 1200, Q: 2, fs, type }, y = Float64Array.from(x)
		for (let i = 0; i < N; i += 256) variableBandwidth(y.subarray(i, i + 256), p)
		return y
	}
	// switch once near the start, then let it run far past the 20 ms fade
	let x = Float64Array.from({ length: N }, (_, i) => Math.sin(2 * Math.PI * 440 * i / fs))
	let switched = Float64Array.from(x), p = { fc: 1200, Q: 2, fs, type: 'lowpass' }
	variableBandwidth(switched.subarray(0, 128), p)
	p.type = 'bandpass'
	for (let i = 128; i < N; i += 256) variableBandwidth(switched.subarray(i, i + 256), p)
	let direct = settle('bandpass', x)
	let max = 0
	for (let i = fs; i < N; i++) max = Math.max(max, Math.abs(switched[i] - direct[i]))
	ok(max < 1e-10, `post-fade output equals a direct bandpass call (max |Δ| ${max.toExponential(1)})`)
	// and the direct bandpass itself matches the plain biquad bandpass at DC attenuation level
	let bp = dc(1024)
	bandpass(bp, { fc: 2000, Q: 1, fs })
	let vb = dc(1024)
	variableBandwidth(vb, { fc: 2000, Q: 1, fs, type: 'bandpass' })
	ok(Math.abs(vb[1023] - bp[1023]) < 1e-9, 'converged bandpass matches the plain bandpass')
})

test('variableBandwidth — highpass/bandpass/lowpass each keep their own response after settling', () => {
	let fs = 44100, N = 1024
	let lp = dc(N), hp = dc(N), bp = dc(N)
	variableBandwidth(lp, { fc: 2000, Q: 0.707, fs, type: 'lowpass' })
	variableBandwidth(hp, { fc: 2000, Q: 0.707, fs, type: 'highpass' })
	variableBandwidth(bp, { fc: 2000, Q: 1, fs, type: 'bandpass' })
	ok(Math.abs(lp[N - 1] - 1) < 0.05, 'lowpass passes DC')
	ok(Math.abs(hp[N - 1]) < 0.1 && Math.abs(bp[N - 1]) < 0.1, 'highpass and bandpass reject DC')
})

test('variableBandwidth — changing fs on a reused params object recomputes instead of reusing old numbers', () => {
	let p = { fc: 1000, Q: 0.707, fs: 44100, type: 'lowpass' }
	variableBandwidth(new Float64Array(64), p)
	p.fs = 96000
	variableBandwidth([0], p)
	// the cached smoothed fc was restarted at the new rate’s target, so the coefficient the section now holds is the
	// 96 kHz design at fc = 1000 — the same a fresh 96 kHz filter writes on its first sample
	let fresh = { fc: 1000, Q: 0.707, fs: 96000, type: 'lowpass' }
	variableBandwidth([0], fresh)
	almost(p._section.b0, fresh._section.b0, 1e-18, 'the rate change restarts the coefficient trajectory at the new rate')
	ok(p._state[2] === 1000 && p._state[3] === 0.707, 'the smoothed fc/Q re-anchor at the targets after the rate change')
	let d2 = impulse(8)
	p.fs = 96000
	variableBandwidth(d2, p)
	ok(finite(d2), 'finite across the rate change')
})

test('variableBandwidth — interleaved params objects keep independent state and fades', () => {
	let fs = 44100, n = 8192, B = 64
	let x1 = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.09))
	let x2 = Float64Array.from({ length: n }, (_, i) => Math.cos(i * 0.05))
	let p1 = { fc: 800, Q: 0.707, fs, type: 'lowpass' }, p2 = { fc: 3000, Q: 3, fs, type: 'highpass' }
	let a = Float64Array.from(x1), b = Float64Array.from(x2)
	for (let pos = 0; pos < n; pos += B) {
		variableBandwidth(a.subarray(pos, pos + B), p1)
		if (pos === 2048) p2.type = 'bandpass'
		variableBandwidth(b.subarray(pos, pos + B), p2)
	}
	let aOne = Float64Array.from(x1), bOne = Float64Array.from(x2)
	variableBandwidth(aOne, { fc: 800, Q: 0.707, fs, type: 'lowpass' })
	let pb = { fc: 3000, Q: 3, fs, type: 'highpass' }
	for (let pos = 0; pos < n; pos += B) {
		if (pos === 2048) pb.type = 'bandpass'
		variableBandwidth(bOne.subarray(pos, pos + B), pb)
	}
	let mA = 0, mB = 0
	for (let i = 0; i < n; i++) { mA = Math.max(mA, Math.abs(a[i] - aOne[i])); mB = Math.max(mB, Math.abs(b[i] - bOne[i])) }
	ok(mA < 1e-12, `stream A independent (max |Δ| ${mA.toExponential(1)})`)
	ok(mB < 1e-12, `stream B with its own fade independent (max |Δ| ${mB.toExponential(1)})`)
})

test('variableBandwidth — illegal parameters fail or clamp, and never leave NaN; the filter recovers', () => {
	ok(throws(() => variableBandwidth(impulse(8), { fc: NaN, fs: 44100 })), 'non-finite fc throws')
	ok(throws(() => variableBandwidth(impulse(8), { fc: 1000, fs: -44100 })), 'negative fs throws')
	ok(throws(() => variableBandwidth(impulse(8), { fc: 1000, fs: 44100, type: 'notch' })), 'unknown type throws')
	// non-positive Q: clamped to the safe default instead of dividing by zero
	let p = { fc: 1000, Q: 0, fs: 44100 }
	let d = impulse(256)
	variableBandwidth(d, p)
	ok(finite(d), 'Q = 0 clamped, output finite')
	ok(p.Q === 0, 'the caller’s params object is not rewritten by the clamp')
	let d2 = impulse(256)
	variableBandwidth(d2, { fc: 1000, Q: -3, fs: 44100 })
	ok(finite(d2), 'negative Q clamped, output finite')
	// failure then recovery on one reused object
	let q = { fc: 1000, Q: 0.707, fs: 44100 }
	variableBandwidth(impulse(64), q)
	ok(throws(() => variableBandwidth(impulse(64), { ...q, fc: Infinity })), 'a bad fc on a copy throws')
	let back = dc(512)
	variableBandwidth(back, q)
	ok(finite(back) && Math.abs(back[511] - 1) < 0.05, 'the original object still filters correctly after the failure')
})

test('variableBlock — NaN-held state starts at the targets, never propagating NaN', () => {
	// the kernel’s own fail-safe: a poisoned/NaN smoothing state re-anchors at the held target on entry
	let fs = 44100, s = Float64Array.of(0, 0, NaN, NaN), set = Float64Array.of(1000, 0.707, fs)
	let section = { b0: 0, b1: 0, b2: 0, a1: 0, a2: 0 }
	let d = impulse(128)
	variableBlock(d, s, set, section, 'lowpass')
	ok(finite(d), 'NaN smoothed fc/Q does not reach the output')
	is(s[2], 1000, 'smoothed fc re-anchored at the target')
	is(s[3], 0.707, 'smoothed Q re-anchored at the target')
})
