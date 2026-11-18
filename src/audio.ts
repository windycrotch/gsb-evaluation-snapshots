import * as THREE from "three";

// a forward buffer plus its sample-reversed copy; see AudioEngine for how the pair
// drives bidirectional playback
export type TrackBuffers = {forward: AudioBuffer; reverse: AudioBuffer};

// build a clip-time-reversed copy of a buffer by mirroring each channel's samples
export const reverseBuffer = (ctx: AudioContext, buffer: AudioBuffer): AudioBuffer => {
	const reversed = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
	for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
		const source = buffer.getChannelData(channel);
		const target = reversed.getChannelData(channel);
		for (let i = 0, j = source.length - 1; j >= 0; i++, j--) target[i] = source[j];
	}
	return reversed;
};

// Web Audio has no settable currentTime, so a "seek" means stopping the source
// and starting a fresh one at the right buffer offset. Allow this much drift
// from the projected position before doing so — generous, since every restart
// re-triggers decoding and a tight threshold would stutter. Jumps at or under
// it (e.g. a frame-step, or a tiny scrub) leave the running source alone.
export const AUDIO_DRIFT = 0.25;
const minRate = 0.0625;
const maxRate = 16;

// Audio rides on the animation clock, but through the Web Audio API rather than
// an <audio> element — so it can play backwards. Each track is decoded to an
// AudioBuffer up front alongside a sample-reversed copy. Forward playback
// schedules the forward buffer; reverse playback schedules the reversed one,
// whose playhead advancing maps to clip-time running backwards.
//
// Every sync projects where the running source *should* be (from clipTime +
// offset) and only re-seeks — by stopping and restarting the source at the right
// buffer offset — when one of these happens:
//  - the direction flips (switch to the other buffer, mirrored position)
//  - the track changes or a transport/loop discontinuity drops the source
//    (start exactly where the clock points, at the new track's own offset)
//  - the projected position drifts from the clock by more than AUDIO_DRIFT
//    (e.g. a scrub); smaller jumps never interrupt the running source
// Speed changes ride the source's playbackRate live, so they never interrupt
// audio either.
export class AudioEngine {
	track: string;
	enabled: boolean;

	private gainNode: GainNode;
	// state describing the source currently scheduled (if any)
	private source: AudioBufferSourceNode | null = null;
	private dir = 1; // +1 forward, -1 reverse — which buffer is playing
	private rate = 1; // playbackRate the source is currently running at
	private baseCtx = 0; // ctx.currentTime when the projection was last rebased
	private baseClip = 0; // clip-time the source represents at baseCtx
	// track the running source was built from; comparing it with `track` catches a
	// track change even when the field is assigned directly rather than via setTrack
	private activeTrack: string;
	// set when a discontinuity (track change, loop wrap, transport) invalidated the
	// source: the next sync must start exactly at the clock, not apply the
	// silent-head onset heuristic below
	private resync = false;
	// previous sync's projected file position; lets us spot the upward crossing out of
	// the silent head (a negative offset keeps target < 0 there) so a fresh start at the
	// head can begin at the file's first sample instead of the frame-overshot offset
	private prevTarget = 0;

	constructor(
		private ctx: AudioContext,
		private buffers: Record<string, TrackBuffers>,
		// Per-track start offset (seconds): how far into the file playback begins at
		// animation time 0.
		private offsets: Record<string, number>,
		track: string,
		enabled: boolean,
		volume: number,
	) {
		this.track = track;
		this.activeTrack = track;
		this.enabled = enabled;
		this.gainNode = ctx.createGain();
		this.gainNode.gain.value = volume;
		this.gainNode.connect(ctx.destination);
	}

	get volume() {
		return this.gainNode.gain.value;
	}
	set volume(value: number) {
		this.gainNode.gain.value = value;
	}

	// drop the running source whenever the clock jumps discontinuously (track
	// change, loop wrap, transport); the next sync rebuilds it from wherever the
	// animation clock now points, exactly — no drift window, no head offset
	restart() {
		this.stop();
		this.resync = true;
	}

	// Switch the soundtrack without losing the clock: the old track's source is
	// dropped immediately, and the next sync starts the new file at the position
	// that corresponds to the current clip time (its own offset included) rather
	// than at the file head or wherever the old track happened to be.
	setTrack(track: string) {
		if (track === this.track) return;
		this.track = track;
		this.restart();
	}

	private stop() {
		if (!this.source) return;
		this.source.onended = null;
		try {
			this.source.stop();
		} catch {}
		this.source.disconnect();
		this.source = null;
	}

	private duration() {
		return this.buffers[this.track].forward.duration;
	}

	private offset() {
		return this.offsets[this.track] || 0;
	}

	// clip-time the running source is actually at right now
	private position() {
		return this.baseClip + this.dir * this.rate * (this.ctx.currentTime - this.baseCtx);
	}

	// (re)schedule a source so clip-time `clip` is heard immediately
	private start(clip: number, dir: number, rate: number) {
		this.stop();
		const buffers = this.buffers[this.track];
		const buffer = dir < 0 ? buffers.reverse : buffers.forward;
		const source = this.ctx.createBufferSource();
		source.buffer = buffer;
		source.playbackRate.value = rate;
		source.connect(this.gainNode);
		// in the reversed buffer the sample for clip-time `clip` sits at the mirrored
		// offset; in the forward buffer it sits at `clip` itself
		const offset = dir < 0 ? buffer.duration - clip : clip;
		source.start(this.ctx.currentTime, THREE.MathUtils.clamp(offset, 0, buffer.duration));
		source.onended = () => {
			if (source === this.source) this.stop();
		};
		this.source = source;
		this.dir = dir;
		this.rate = rate;
		this.baseCtx = this.ctx.currentTime;
		this.baseClip = clip;
		this.activeTrack = this.track;
	}

	sync(clipTime: number, paused: boolean, reverse: boolean, speed: number) {
		// browsers suspend the context until a user gesture; the start click resumes
		// it, but retry here in case that resume was swallowed
		if (this.ctx.state === "suspended") this.ctx.resume();

		// a track switch — through setTrack or by assigning `track` directly — must
		// not leave the previous track's source sounding, and must not let the
		// previous track's head state leak into the new track's first sync
		if (this.track !== this.activeTrack) {
			this.stop();
			this.resync = true;
			this.activeTrack = this.track;
		}

		const buffers = this.buffers[this.track];
		if (!buffers) {
			this.stop();
			return;
		}

		const target = clipTime + this.offset();
		const duration = this.duration();
		const dir = reverse ? -1 : 1;
		const rate = THREE.MathUtils.clamp(speed, minRate, maxRate);
		// silent when muted, paused, frozen, or the clock sits outside the track —
		// a negative offset delays the sound at the head, and the clip may outrun the
		// shorter audio at the tail
		const shouldPlay = this.enabled && !paused && speed > 0 && target >= 0 && target <= duration;
		// a discontinuity already dropped the source; start exactly at the clock
		// instead of re-applying the head/onset handling below
		const force = this.resync;
		this.resync = false;
		// did this sync just step forward out of the silent head? frames advance in
		// discrete steps, so the clock never lands exactly on the head boundary — it
		// overshoots, and starting the file at that overshot offset would clip the
		// soundtrack's onset. Only a *small* step counts: a scrub from the silent head
		// to a later position is a seek and must land on the target. Detected here,
		// consumed when we (re)start below.
		const enteringHead =
			!force && dir > 0 && this.prevTarget < 0 && target >= 0 && target - this.prevTarget <= AUDIO_DRIFT;
		this.prevTarget = target;

		if (!shouldPlay) {
			this.stop();
			return;
		}
		// nothing playing, a discontinuity asked for a rebuild, or the direction
		// flipped to the other buffer. On a fresh start right out of the head, begin
		// at the file's first sample rather than the overshot offset — the sub-frame
		// visual desync is imperceptible, a clipped onset is not.
		if (force || !this.source || dir !== this.dir) {
			this.start(enteringHead && !this.source ? 0 : target, dir, rate);
			return;
		}
		// speed change: ride it live on the AudioParam and rebase the projection
		if (rate !== this.rate) {
			this.baseClip = this.position();
			this.baseCtx = this.ctx.currentTime;
			this.source.playbackRate.value = rate;
			this.rate = rate;
		}
		// a jump larger than the drift window (a scrub, an arrow-key seek) re-homes
		// to the target; anything within it leaves the source undisturbed
		if (Math.abs(this.position() - target) > AUDIO_DRIFT) {
			this.start(target, dir, rate);
		}
	}
}
