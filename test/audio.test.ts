import {describe, expect, it} from "vitest";
import {AUDIO_DRIFT, AudioEngine, TrackBuffers, reverseBuffer} from "../src/audio";
import {FakeAudioContext, asAudioBuffer, asAudioContext} from "./fakes";

// 100 samples per second keeps the arithmetic exact enough to compare offsets.
const SAMPLE_RATE = 100;
const TRACK_SECONDS = 10;
const SHORT_SECONDS = 2;

// per-track offsets: alpha is delayed a little, beta starts mid-file, gamma has a
// negative offset that keeps its head silent at clip time 0, short has none
const OFFSETS: Record<string, number> = {alpha: 0.5, beta: 1.5, gamma: -2, short: 0};

const makeTrack = (ctx: FakeAudioContext, seconds: number): TrackBuffers => {
	const length = seconds * SAMPLE_RATE;
	const forward = ctx.createBuffer(1, length, SAMPLE_RATE);
	const samples = forward.getChannelData(0);
	// a ramp makes the mirror check meaningful
	for (let i = 0; i < length; i++) samples[i] = i / length;
	return {
		forward: asAudioBuffer(forward),
		reverse: asAudioBuffer(reverseBuffer(asAudioContext(ctx), asAudioBuffer(forward))),
	};
};

const setup = () => {
	const ctx = new FakeAudioContext();
	const tracks: Record<string, TrackBuffers> = {
		alpha: makeTrack(ctx, TRACK_SECONDS),
		beta: makeTrack(ctx, TRACK_SECONDS),
		gamma: makeTrack(ctx, TRACK_SECONDS),
		short: makeTrack(ctx, SHORT_SECONDS),
	};
	const engine = new AudioEngine(asAudioContext(ctx), tracks, OFFSETS, "alpha", true, 1);
	return {ctx, tracks, engine};
};

// the engine projects the playing source from the context clock, so tests advance
// that clock by hand alongside the clip time they feed to sync()
const advance = (ctx: FakeAudioContext, seconds: number) => {
	ctx.currentTime += seconds;
};

const offsetOf = (ctx: FakeAudioContext, index: number) => {
	const started = ctx.sources[index].started;
	if (!started) throw new Error(`source ${index} was never started`);
	return started.offset;
};

describe("reverseBuffer", () => {
	it("mirrors every sample of every channel", () => {
		const ctx = new FakeAudioContext();
		const stereo = ctx.createBuffer(2, 5, SAMPLE_RATE);
		stereo.getChannelData(0).set([0, 0.1, 0.2, 0.3, 0.4]);
		stereo.getChannelData(1).set([0.5, 0.6, 0.7, 0.8, 0.9]);

		const reversed = reverseBuffer(asAudioContext(ctx), asAudioBuffer(stereo));

		// Float32 channels: compare exactly against the float-rounded expectations
		const expectChannel = (channel: number, expected: number[]) => {
			const actual = Array.from(reversed.getChannelData(channel));
			expect(actual).toHaveLength(expected.length);
			actual.forEach((value, i) => expect(value).toBe(Math.fround(expected[i])));
		};
		expectChannel(0, [0.4, 0.3, 0.2, 0.1, 0]);
		expectChannel(1, [0.9, 0.8, 0.7, 0.6, 0.5]);
		expect(reversed.duration).toBe(stereo.duration);
	});
});

describe("track switch", () => {
	it("starts the new track at the current clip position with that track's own offset", () => {
		const {ctx, tracks, engine} = setup();
		engine.sync(3, false, false, 1);
		expect(offsetOf(ctx, 0)).toBeCloseTo(3 + OFFSETS.alpha);

		advance(ctx, 0.5);
		engine.setTrack("beta");
		// the old source is silenced immediately, not at the next frame
		expect(ctx.sources[0].stopped).toBe(true);
		expect(ctx.liveSources()).toHaveLength(0);

		engine.sync(3.5, false, false, 1);
		expect(ctx.sources).toHaveLength(2);
		expect(ctx.sources[1].buffer).toBe(tracks.beta.forward);
		// the file position matches the clock under beta's offset — not the file head
		// and not where alpha happened to be
		expect(offsetOf(ctx, 1)).toBeCloseTo(3.5 + OFFSETS.beta);
	});

	it("also notices a track assigned directly on the engine", () => {
		const {ctx, tracks, engine} = setup();
		engine.sync(2, false, false, 1);

		engine.track = "beta";
		engine.sync(2, false, false, 1);
		expect(ctx.sources[0].stopped).toBe(true);
		expect(ctx.sources[1].buffer).toBe(tracks.beta.forward);
		expect(offsetOf(ctx, 1)).toBeCloseTo(2 + OFFSETS.beta);
	});

	it("does not restart when setTrack names the track already playing", () => {
		const {ctx, engine} = setup();
		engine.sync(2, false, false, 1);
		engine.setTrack("alpha");
		expect(ctx.sources).toHaveLength(1);
		expect(ctx.sources[0].stopped).toBe(false);
	});

	it("does not carry the previous track's silent-head state into the new track", () => {
		const {ctx, engine} = setup();
		// gamma's negative offset leaves the head silent; prevTarget is now < 0
		engine.setTrack("gamma");
		engine.sync(0, false, false, 1);
		expect(ctx.liveSources()).toHaveLength(0);

		// switching to beta lands at a real file position, which must not be bent to
		// the file head by gamma's head-crossing heuristic
		engine.setTrack("beta");
		engine.sync(0, false, false, 1);
		expect(offsetOf(ctx, ctx.sources.length - 1)).toBeCloseTo(OFFSETS.beta);
	});

	it("gives each track its own offset for reverse playback too", () => {
		const {ctx, tracks, engine} = setup();
		engine.sync(4, false, true, 1); // alpha file time 4.5
		expect(ctx.sources[0].buffer).toBe(tracks.alpha.reverse);

		engine.setTrack("beta");
		engine.sync(4, false, true, 1); // beta file time 5.5
		expect(ctx.sources[1].buffer).toBe(tracks.beta.reverse);
		expect(offsetOf(ctx, 1)).toBeCloseTo(TRACK_SECONDS - (4 + OFFSETS.beta));
	});
});

describe("reverse toggle", () => {
	it("switches to the reversed buffer at the mirrored position when direction flips", () => {
		const {ctx, tracks, engine} = setup();
		engine.sync(3, false, false, 1); // alpha forward at file time 3.5
		const forwardSource = ctx.sources[0];

		advance(ctx, 0.2);
		engine.sync(3.2, false, true, 1); // file time 3.7
		expect(forwardSource.stopped).toBe(true);
		expect(ctx.sources).toHaveLength(2);
		expect(ctx.sources[1].buffer).toBe(tracks.alpha.reverse);
		expect(offsetOf(ctx, 1)).toBeCloseTo(TRACK_SECONDS - 3.7);
	});

	it("flips back to the forward buffer at the mirrored position", () => {
		const {ctx, tracks, engine} = setup();
		engine.sync(3, false, false, 1);
		engine.sync(3, false, true, 1);

		advance(ctx, 0.3);
		engine.sync(2.7, false, false, 1); // reverse ran backwards to file time 3.2
		expect(ctx.sources).toHaveLength(3);
		expect(ctx.sources[2].buffer).toBe(tracks.alpha.forward);
		expect(offsetOf(ctx, 2)).toBeCloseTo(3.2);
	});

	it("keeps the reversed source running from frame to frame while in sync", () => {
		const {ctx, engine} = setup();
		engine.sync(5, false, true, 1);
		const source = ctx.sources[0];

		advance(ctx, 0.4);
		engine.sync(4.6, false, true, 1);
		expect(ctx.sources).toHaveLength(1);
		expect(ctx.sources[0]).toBe(source);
		expect(source.stopped).toBe(false);
	});
});

describe("loop wrap", () => {
	it("drops the running source and rebuilds it from the new clock next frame", () => {
		const {ctx, tracks, engine} = setup();
		engine.sync(9.4, false, false, 1); // near the tail: file time 9.9
		expect(ctx.liveSources()).toHaveLength(1);

		advance(ctx, 0.2);
		engine.restart(); // what the Player does on the mixer's "loop" event
		expect(ctx.liveSources()).toHaveLength(0);
		expect(ctx.sources[0].stopped).toBe(true);

		engine.sync(0.1, false, false, 1); // first frame after the wrap
		expect(ctx.sources).toHaveLength(2);
		expect(ctx.sources[1].buffer).toBe(tracks.alpha.forward);
		// exactly the clock's file position, not the file head
		expect(offsetOf(ctx, 1)).toBeCloseTo(0.1 + OFFSETS.alpha);
	});

	it("restarts even when the new clock is still inside the drift window", () => {
		const {ctx, engine} = setup();
		engine.sync(5, false, false, 1);
		advance(ctx, 0.1);
		engine.restart();
		engine.sync(5.1, false, false, 1);
		expect(ctx.sources).toHaveLength(2);
		expect(ctx.sources[0].stopped).toBe(true);
		expect(offsetOf(ctx, 1)).toBeCloseTo(5.1 + OFFSETS.alpha);
	});

	it("drops a source that was silent before the wrap without inventing one", () => {
		const {ctx, engine} = setup();
		engine.setTrack("short");
		engine.sync(5, false, false, 1); // past the 2s track: silent
		expect(ctx.sources).toHaveLength(0);

		engine.restart();
		engine.sync(0.5, false, false, 1);
		expect(ctx.sources).toHaveLength(1);
		expect(offsetOf(ctx, 0)).toBeCloseTo(0.5);
	});
});

describe("scrubbing", () => {
	it("re-homes to the target when the jump exceeds the drift window", () => {
		const {ctx, engine} = setup();
		engine.sync(2, false, false, 1); // file time 2.5
		advance(ctx, 0.1); // playing at 2.6 now

		engine.sync(5, false, false, 1); // jump to file time 5.5, drift 2.9
		expect(ctx.sources).toHaveLength(2);
		expect(ctx.sources[0].stopped).toBe(true);
		expect(offsetOf(ctx, 1)).toBeCloseTo(5.5);
	});

	it("leaves the running source alone when the jump is inside the drift window", () => {
		const {ctx, engine} = setup();
		engine.sync(2, false, false, 1); // file time 2.5
		const source = ctx.sources[0];
		advance(ctx, 0.1); // projected 2.6

		engine.sync(2.3, false, false, 1); // target 2.8, drift 0.2
		expect(ctx.sources).toHaveLength(1);
		expect(ctx.sources[0]).toBe(source);
		expect(source.stopped).toBe(false);
		expect(source.disconnected).toBe(false);
	});

	it("treats exactly the drift limit as in-sync and just past it as a seek", () => {
		const {ctx, engine} = setup();
		engine.sync(2, false, false, 1); // file time 2.5; projection based at 2.5
		advance(ctx, 0.25); // projected 2.75

		// |2.75 - 2.5| is exactly AUDIO_DRIFT; the source must keep running
		engine.sync(2, false, false, 1);
		expect(AUDIO_DRIFT).toBe(0.25);
		expect(ctx.sources).toHaveLength(1);
		expect(ctx.sources[0].stopped).toBe(false);

		// a hair past the limit re-homes to the target
		advance(ctx, 0.001); // projected 2.751
		engine.sync(2, false, false, 1); // target 2.5, drift 0.251
		expect(ctx.sources).toHaveLength(2);
		expect(offsetOf(ctx, 1)).toBeCloseTo(2.5);
	});

	it("re-homes a scrub in reverse to the mirrored position", () => {
		const {ctx, tracks, engine} = setup();
		engine.sync(5, false, true, 1); // file time 5.5, reversed offset 4.5
		advance(ctx, 0.1); // projected file time 5.4 (reversed buffer at 4.6)
		engine.sync(2, false, true, 1); // target 2.5

		expect(ctx.sources).toHaveLength(2);
		expect(ctx.sources[1].buffer).toBe(tracks.alpha.reverse);
		expect(offsetOf(ctx, 1)).toBeCloseTo(TRACK_SECONDS - 2.5);
	});
});

describe("speed", () => {
	it("changes playbackRate live without restarting the source", () => {
		const {ctx, engine} = setup();
		engine.sync(2, false, false, 1); // file time 2.5
		const source = ctx.sources[0];

		advance(ctx, 0.5); // projected 3.0
		engine.sync(2.5, false, false, 2); // same clock position, new rate
		expect(ctx.sources).toHaveLength(1);
		expect(ctx.sources[0]).toBe(source);
		expect(source.playbackRate.value).toBe(2);
		expect(source.stopped).toBe(false);
	});

	it("projects the rebased clock at the new rate, so no seek follows", () => {
		const {ctx, engine} = setup();
		engine.sync(2, false, false, 1);
		advance(ctx, 0.5); // projected 3.0
		engine.sync(2.5, false, false, 2); // rebases at 3.0, rate 2

		advance(ctx, 0.25); // 3.0 + 2 * 0.25 = 3.5
		engine.sync(3, false, false, 2); // target 3.5
		expect(ctx.sources).toHaveLength(1);
		engine.sync(3.1, false, false, 2); // target 3.6, drift 0.1 → still in sync
		expect(ctx.sources).toHaveLength(1);
	});

	it("clamps extreme rates rather than handing Web Audio a bad value", () => {
		const {ctx, engine} = setup();
		engine.sync(2, false, false, 1000);
		const source = ctx.sources[0];
		expect(source.playbackRate.value).toBe(16);

		// a tiny but nonzero speed rides the live rate down to the clamp, without a
		// restart (zero is the mute/freeze condition and never reaches here)
		engine.sync(2.001, false, false, 0.001);
		expect(ctx.sources).toHaveLength(1);
		expect(source.playbackRate.value).toBeCloseTo(0.0625);
	});
});

describe("silence", () => {
	it("is silent while muted, and stops a source that was already playing", () => {
		const {ctx, engine} = setup();
		engine.sync(3, false, false, 1);
		expect(ctx.liveSources()).toHaveLength(1);

		engine.enabled = false;
		engine.sync(3.1, false, false, 1);
		expect(ctx.liveSources()).toHaveLength(0);
		expect(ctx.sources).toHaveLength(1);
	});

	it("starts playing again after unmuting", () => {
		const {ctx, engine} = setup();
		engine.enabled = false;
		engine.sync(3, false, false, 1);
		expect(ctx.sources).toHaveLength(0);

		engine.enabled = true;
		engine.sync(3, false, false, 1);
		expect(ctx.sources).toHaveLength(1);
		expect(offsetOf(ctx, 0)).toBeCloseTo(3.5);
	});

	it("stays silent after unmuting outside the track and starts once back inside", () => {
		const {ctx, engine} = setup();
		engine.setTrack("short"); // 2s
		engine.enabled = false;
		engine.sync(5, false, false, 1);
		expect(ctx.sources).toHaveLength(0);

		engine.enabled = true;
		engine.sync(5, false, false, 1);
		expect(ctx.sources).toHaveLength(0);

		engine.sync(1, false, false, 1);
		expect(ctx.sources).toHaveLength(1);
		expect(offsetOf(ctx, 0)).toBeCloseTo(1);
	});

	it("switches silently while muted, then starts the new track on unmute", () => {
		const {ctx, tracks, engine} = setup();
		engine.enabled = false;
		engine.sync(4, false, false, 1); // nothing plays

		engine.setTrack("beta");
		engine.sync(4, false, false, 1);
		expect(ctx.sources).toHaveLength(0);

		engine.enabled = true;
		engine.sync(4, false, false, 1);
		expect(ctx.sources).toHaveLength(1);
		expect(ctx.sources[0].buffer).toBe(tracks.beta.forward);
		expect(offsetOf(ctx, 0)).toBeCloseTo(4 + OFFSETS.beta);
	});

	it("is silent while paused and when the speed is zero", () => {
		const {ctx, engine} = setup();
		engine.sync(3, true, false, 1);
		expect(ctx.sources).toHaveLength(0);

		engine.sync(3, false, false, 0);
		expect(ctx.sources).toHaveLength(0);
	});

	it("is silent before a negative offset brings the track in", () => {
		const {ctx, engine} = setup();
		engine.setTrack("gamma"); // offset -2
		engine.sync(1.9, false, false, 1); // file time -0.1
		expect(ctx.sources).toHaveLength(0);

		engine.sync(2.3, false, false, 1); // file time 0.3
		expect(ctx.sources).toHaveLength(1);
		expect(offsetOf(ctx, 0)).toBeCloseTo(0.3);
	});

	it("starts the file at its first sample when the clock steps out of the silent head", () => {
		const {ctx, engine} = setup();
		engine.setTrack("gamma");
		engine.sync(1.98, false, false, 1); // file time -0.02, silent
		const sourcesBefore = ctx.sources.length;

		// the next frame overshoots the head boundary; the onset must not be clipped
		engine.sync(2.02, false, false, 1); // file time 0.02
		expect(ctx.sources).toHaveLength(sourcesBefore + 1);
		expect(offsetOf(ctx, ctx.sources.length - 1)).toBe(0);
	});

	it("uses the exact position instead of the head heuristic after a discontinuity", () => {
		const {ctx, engine} = setup();
		engine.setTrack("gamma");
		engine.sync(1.98, false, false, 1); // prevTarget = -0.02
		engine.restart();

		engine.sync(2.02, false, false, 1); // file time 0.02
		expect(offsetOf(ctx, ctx.sources.length - 1)).toBeCloseTo(0.02);
	});

	it("treats a scrub out of the silent head as a seek, not an onset", () => {
		const {ctx, engine} = setup();
		engine.setTrack("gamma");
		engine.sync(1.9, false, false, 1); // file time -0.1, silent

		engine.sync(4, false, false, 1); // file time 2.0 — a jump, not a head crossing
		expect(offsetOf(ctx, ctx.sources.length - 1)).toBeCloseTo(2);
	});

	it("is silent past the end of a track shorter than the clip", () => {
		const {ctx, engine} = setup();
		engine.setTrack("short"); // 2s track
		engine.sync(1.5, false, false, 1);
		expect(ctx.liveSources()).toHaveLength(1);

		engine.sync(2.5, false, false, 1); // beyond the track's tail
		expect(ctx.liveSources()).toHaveLength(0);

		engine.sync(1.9, false, false, 1);
		expect(ctx.sources).toHaveLength(2); // comes back near the tail
	});

	it("still plays exactly at the track's end and drops the clip silently at the head", () => {
		const {ctx, engine} = setup();
		engine.setTrack("short");
		engine.sync(SHORT_SECONDS, false, false, 1); // target == duration → allowed
		expect(ctx.sources).toHaveLength(1);
		expect(offsetOf(ctx, 0)).toBeCloseTo(SHORT_SECONDS);

		engine.sync(SHORT_SECONDS + 0.01, false, false, 1);
		expect(ctx.liveSources()).toHaveLength(0);
	});
});

describe("clock alignment", () => {
	it("keeps a source started mid-track aligned to the animation clock", () => {
		const {ctx, engine} = setup();
		engine.sync(4, false, false, 1); // file time 4.5

		for (let frame = 1; frame <= 30; frame++) {
			advance(ctx, 1 / 60);
			engine.sync(4 + frame / 60, false, false, 1);
		}
		expect(ctx.sources).toHaveLength(1);
		expect(ctx.sources[0].stopped).toBe(false);
	});

	it("re-homes after the animation clock stalls behind the audio", () => {
		const {ctx, engine} = setup();
		engine.sync(4, false, false, 1);
		advance(ctx, 0.4); // audio runs 0.4s ahead while the clip stays put
		engine.sync(4, false, false, 1);
		expect(ctx.sources).toHaveLength(2);
		expect(offsetOf(ctx, 1)).toBeCloseTo(4.5);
	});

	it("schedules the source to begin at the context's current time", () => {
		const {ctx, engine} = setup();
		advance(ctx, 2.5);
		engine.sync(1, false, false, 1);
		expect(ctx.sources[0].started!.when).toBeCloseTo(2.5);
	});

	it("keeps the scheduled offsets clamped inside the buffer", () => {
		const {ctx, engine} = setup();
		engine.sync(0, false, true, 1); // alpha: file time 0.5 → mirrored 9.5
		expect(offsetOf(ctx, 0)).toBeCloseTo(TRACK_SECONDS - 0.5);

		engine.setTrack("short"); // 2s, no offset
		engine.sync(0, false, false, 1);
		expect(offsetOf(ctx, ctx.sources.length - 1)).toBeCloseTo(0);
	});

	it("resumes a suspended context before scheduling", () => {
		const {ctx, engine} = setup();
		ctx.state = "suspended";
		engine.sync(1, false, false, 1);
		expect(ctx.resumeCalls).toBe(1);
		expect(ctx.state).toBe("running");
	});
});
