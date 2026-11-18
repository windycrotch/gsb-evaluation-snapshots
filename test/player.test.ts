import "./browser-shims";
import {AnimationClip, AnimationMixer, NumberKeyframeTrack, Object3D} from "three";
import {beforeEach, describe, expect, it} from "vitest";
import {AudioEngine, TrackBuffers, reverseBuffer} from "../src/audio";
import {Player} from "../src/player";
import {FakeAudioContext, asAudioBuffer, asAudioContext} from "./fakes";

// End-to-end checks over the Player → AudioEngine seam: these drive the same entry
// points the UI does (setTrack, setReverse, seekTo, update) and inspect the sources
// the engine scheduled.

const SAMPLE_RATE = 100;
const TRACK_SECONDS = 10;
const CLIP_SECONDS = 12;
// alpha starts a little into the file, beta further in, gamma with a delay that
// leaves the clip's first two seconds silent
const OFFSETS: Record<string, number> = {alpha: 0.5, beta: 1.5, gamma: -2};

const makeTrack = (ctx: FakeAudioContext, seconds: number): TrackBuffers => {
	const length = seconds * SAMPLE_RATE;
	const forward = ctx.createBuffer(1, length, SAMPLE_RATE);
	const samples = forward.getChannelData(0);
	for (let i = 0; i < length; i++) samples[i] = i / length;
	return {
		forward: asAudioBuffer(forward),
		reverse: asAudioBuffer(reverseBuffer(asAudioContext(ctx), asAudioBuffer(forward))),
	};
};

const setup = (clipSeconds = CLIP_SECONDS) => {
	const ctx = new FakeAudioContext();
	const tracks: Record<string, TrackBuffers> = {
		alpha: makeTrack(ctx, TRACK_SECONDS),
		beta: makeTrack(ctx, TRACK_SECONDS),
		gamma: makeTrack(ctx, TRACK_SECONDS),
	};
	const audio = new AudioEngine(asAudioContext(ctx), tracks, OFFSETS, "alpha", true, 1);

	// a one-track clip over a bare Object3D; only action.time is read back
	const root = new Object3D();
	const clip = new AnimationClip("gc", clipSeconds, [
		new NumberKeyframeTrack(".position[x]", [0, clipSeconds], [0, 0]),
	]);
	const mixer = new AnimationMixer(root);
	const action = mixer.clipAction(clip);
	action.play();

	const noop = () => {};
	const orbit = {intensity: 1, setEnabled: noop};
	const player = new Player(action, mixer, clip, audio, orbit as any, noop, noop, {loop: false});
	return {ctx, audio, player, tracks};
};

// run one render-loop frame; `seconds` of wall clock passes
const frame = (ctx: FakeAudioContext, player: Player, seconds: number) => {
	ctx.currentTime += seconds;
	player.update(seconds);
};

const lastStarted = (ctx: FakeAudioContext) => {
	const source = ctx.liveSources()[ctx.liveSources().length - 1];
	if (!source?.started) throw new Error("no running source");
	return source;
};

describe("Player audio wiring", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("starts the new track at the current clip position on setTrack", () => {
		const {ctx, player} = setup();
		player.seekTo(3);
		player.play();
		frame(ctx, player, 0);
		expect(lastStarted(ctx).started!.offset).toBeCloseTo(3 + OFFSETS.alpha);

		player.setTrack("beta");
		// no frame needed: the new file starts immediately, at beta's own offset
		expect(lastStarted(ctx).started!.offset).toBeCloseTo(3 + OFFSETS.beta);
	});

	it("switches track without leaving the previous file's head state in charge", () => {
		const {ctx, player} = setup();
		player.seekTo(0);
		player.play();
		frame(ctx, player, 0);
		expect(lastStarted(ctx).started!.offset).toBeCloseTo(OFFSETS.alpha);

		// gamma is silent at clip time 0 (offset -2); switching back to beta must
		// start at beta's real file position, not at the head
		player.setTrack("gamma");
		expect(ctx.liveSources()).toHaveLength(0);

		player.setTrack("beta");
		expect(lastStarted(ctx).started!.offset).toBeCloseTo(OFFSETS.beta);
	});

	it("flips to the reversed buffer as soon as setReverse runs", () => {
		const {ctx, player} = setup();
		player.seekTo(4);
		player.play();
		frame(ctx, player, 0);
		const forwardSource = lastStarted(ctx);

		player.setReverse(true);
		expect(forwardSource.stopped).toBe(true);
		expect(lastStarted(ctx).buffer).not.toBe(forwardSource.buffer);
		expect(lastStarted(ctx).started!.offset).toBeCloseTo(TRACK_SECONDS - (4 + OFFSETS.alpha));
	});

	it("keeps audio aligned across loop wraps", () => {
		// a 9s clip with 10s tracks: both the pre- and post-wrap positions stay inside
		// the soundtrack, so the check isolates the wrap itself
		const {ctx, player} = setup(9);
		player.setLoop(true);
		player.seekTo(8.8);
		player.play();
		frame(ctx, player, 0);
		const beforeWrap = lastStarted(ctx);

		// crossing the end wraps the action and fires the mixer's "loop" event, which
		// drops the source; the same update's sync rebuilds it at the new clock
		frame(ctx, player, 0.3);
		expect(player.time).toBeCloseTo(9.1 - 9);
		expect(beforeWrap.stopped).toBe(true);
		expect(ctx.liveSources()).toHaveLength(1);
		expect(lastStarted(ctx)).not.toBe(beforeWrap);
		expect(lastStarted(ctx).started!.offset).toBeCloseTo(player.time + OFFSETS.alpha);
	});

	it("re-homes on a large scrub but not on a small one", () => {		const {ctx, player} = setup();
		player.seekTo(2);
		player.play();
		frame(ctx, player, 0);
		const first = lastStarted(ctx);

		// a sub-threshold nudge keeps the source running
		frame(ctx, player, 0.05);
		player.seekBy(0.1);
		frame(ctx, player, 0);
		expect(ctx.liveSources()).toHaveLength(1);
		expect(lastStarted(ctx)).toBe(first);

		// a large scrub restarts at the new position
		player.seekTo(7);
		frame(ctx, player, 0);
		expect(first.stopped).toBe(true);
		expect(lastStarted(ctx).started!.offset).toBeCloseTo(7 + OFFSETS.alpha);
	});

	it("stays silent past the end of a soundtrack shorter than the clip", () => {
		const {ctx, player} = setup();
		player.seekTo(11);
		player.play();
		// the tracks are 10s with a +0.5s offset: clip time 11 is past the tail
		frame(ctx, player, 0);
		expect(ctx.liveSources()).toHaveLength(0);
	});

	it("goes silent on pause and returns on play at the paused position", () => {
		const {ctx, player} = setup();
		player.seekTo(3);
		player.play();
		frame(ctx, player, 0);
		expect(ctx.liveSources()).toHaveLength(1);

		player.pause();
		frame(ctx, player, 0);
		expect(ctx.liveSources()).toHaveLength(0);

		player.play();
		frame(ctx, player, 0);
		expect(lastStarted(ctx).started!.offset).toBeCloseTo(3 + OFFSETS.alpha);
	});

	it("applies a speed change without restarting the source", () => {
		const {ctx, player} = setup();
		player.seekTo(2);
		player.play();
		frame(ctx, player, 0);
		const source = lastStarted(ctx);

		// the clip's own clock follows timeScale, so a speed change also advances the
		// action; sync with the clock it lands on
		player.setSpeed(2);
		frame(ctx, player, 0);
		expect(lastStarted(ctx)).toBe(source);
		expect(source.playbackRate.value).toBe(2);
		expect(source.stopped).toBe(false);
	});

	it("keeps audio aligned while running backwards", () => {
		const {ctx, player, audio} = setup();
		player.setReverse(true);
		player.seekTo(5);
		player.play();
		frame(ctx, player, 0);
		const source = lastStarted(ctx);
		const expected = TRACK_SECONDS - (5 + OFFSETS.alpha);
		expect(source.started!.offset).toBeCloseTo(expected);

		// run 0.5s of reversed playback: the action clock decreases, the reversed
		// buffer's playhead advances, and no restart is needed
		frame(ctx, player, 0.5);
		expect(player.time).toBeCloseTo(4.5);
		expect(ctx.liveSources()).toHaveLength(1);
		expect(lastStarted(ctx)).toBe(source);
	});

	it("re-homes after a loop wrap while running backwards", () => {
		// an 8s clip keeps the post-wrap position inside the 10s soundtrack, so the
		// check is about the wrap itself rather than the track running out
		const {ctx, player, tracks} = setup(8);
		player.setLoop(true);
		player.setReverse(true);
		player.seekTo(0.2);
		player.play();
		frame(ctx, player, 0);

		// crossing zero backwards wraps to the clip's end; the source must be rebuilt
		// from the new clock, not left running from the old position
		frame(ctx, player, 0.4);
		expect(player.time).toBeCloseTo(8 - 0.2);
		expect(lastStarted(ctx).buffer).toBe(tracks.alpha.reverse);
		expect(lastStarted(ctx).started!.offset).toBeCloseTo(TRACK_SECONDS - (player.time + OFFSETS.alpha));
	});
});
