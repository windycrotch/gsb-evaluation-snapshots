import type { ClockSeconds, Core, DurationSeconds, LoopMode, Output, Playback, PlaybackMode, Player, PlayerOptions, RecordingSeconds, Section, SpeedRatio, TransportEvent, TransportState } from "./interfaces";
import { continues, positionAt } from "./playback";
import { loopDelay, transition } from "./transport";

export const createPlayer: Core["createPlayer"] = (output, options) => new TransportPlayer(output, options);

const DUE_SLACK = 0.002;
const TRAJECTORY_LIMIT = 64;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

class TransportPlayer implements Player {
  readonly duration: DurationSeconds;
  private readonly output: Output;
  private state: TransportState;
  private loopMode: LoopMode;
  private anchor: { position: RecordingSeconds; time: ClockSeconds };
  private playback!: Playback;
  private audibleFrom: ClockSeconds = -Infinity;
  private past: Playback[] = [];
  private scrub: number | null = null;
  private waitingSince: ClockSeconds | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();
  private disposed = false;

  constructor(output: Output, { duration, position, loop, loopMode, speed }: PlayerOptions) {
    this.output = output;
    this.duration = duration;
    this.state = { playState: "paused", loop: loop ?? { start: 0, end: duration }, speed, waitingUntil: null };
    this.loopMode = loopMode;
    this.anchor = { position: clamp(position, 0, duration), time: output.now() };
    this.render();
  }

  subscribe = (listener: () => void) => {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getState = () => this.state;

  position() {
    const { playback } = this;
    if (this.scrub !== null || playback.mode !== "playing") return this.renderedPosition();
    const { loop, loopWraps, anchorPosition } = playback;
    const time = Math.max(this.audibleFrom, this.output.now() - this.latency());
    const heard = positionAt(this.trajectoryAt(time), time);
    const unwrapped = loopWraps && heard < loop.start && anchorPosition >= loop.start ? heard + loop.end - loop.start : heard;
    return Math.min(unwrapped, this.duration);
  }

  delayRemaining() {
    const until = this.state.waitingUntil;
    return until === null ? 0 : Math.max(0, until - this.output.now());
  }

  dispatch(event: TransportEvent) {
    if (this.disposed) return;
    if (this.scrub !== null && (event.type === "loop-end" || event.type === "delay-end")) return;
    const { playState, loop } = this.state;
    const { loopMode } = this;
    const now = this.output.now();
    const position = this.here(now);
    const next = transition(playState, event, { position, loop, loopMode });
    this.reanchor(next.position ?? (next.state === "playing" ? position : this.position()), now);
    this.waitingSince = next.state === "waiting" ? now : null;
    const waitingUntil = this.waitingSince === null ? null : this.waitingSince + loopDelay(loopMode);
    this.state = { ...this.state, playState: next.state, waitingUntil };
    this.render();
  }

  startScrub(at: RecordingSeconds) {
    if (this.disposed) return;
    this.scrub = clamp(at, 0, this.duration);
    if (this.state.playState === "waiting") {
      this.waitingSince = null;
      this.state = { ...this.state, playState: "playing", waitingUntil: null };
      this.reanchor(this.scrub, this.output.now());
    }
    this.render();
  }

  scrubTo(at: RecordingSeconds) {
    if (this.disposed || this.scrub === null) return;
    this.scrub = clamp(at, 0, this.duration);
    this.render();
  }

  endScrub() {
    if (this.disposed) return;
    const position = this.scrub;
    if (position === null) return;
    this.scrub = null;
    this.dispatch({ type: "move", position });
  }

  setSpeed(speed: SpeedRatio) {
    if (this.disposed) return;
    if (speed === this.state.speed) return;
    this.reanchorHere();
    this.state = { ...this.state, speed };
    this.render();
  }

  setLoop(loop: Section | null) {
    if (this.disposed) return;
    const next = loop ?? { start: 0, end: this.duration };
    if (next.start === this.state.loop.start && next.end === this.state.loop.end) return;
    this.state = { ...this.state, loop: next };
    this.dispatch({ type: "loop-change" });
  }

  setLoopMode(loopMode: LoopMode) {
    if (this.disposed) return;
    if (loopMode.type === this.loopMode.type && loopDelay(loopMode) === loopDelay(this.loopMode)) return;
    const now = this.output.now();
    if (this.state.playState === "waiting" && this.waitingSince !== null) {
      const { loop } = this.state;
      const startedAt = this.waitingSince;
      const delay = loopDelay(loopMode);
      const until = startedAt + delay;
      this.loopMode = loopMode;
      if (loopMode.type === "manual" || delay <= 0 || until <= now) {
        this.waitingSince = null;
        this.state = { ...this.state, playState: loopMode.type === "manual" ? "paused" : "playing", waitingUntil: null };
        this.reanchor(loop.start, now);
      } else {
        this.state = { ...this.state, waitingUntil: until };
        this.reanchorHere();
      }
      this.render();
      return;
    }
    this.reanchorHere();
    this.loopMode = loopMode;
    this.render();
  }

  correctPosition(observed: RecordingSeconds) {
    if (this.disposed || this.scrub !== null) return;
    this.reanchor(observed);
    this.render();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.scrub = null;
    this.waitingSince = null;
    this.past = [];
    this.state = { ...this.state, waitingUntil: null };
    clearTimeout(this.timer);
    this.timer = undefined;
    this.listeners.clear();
    this.output.render({ ...this.playback, mode: "silent" });
  }

  private renderedPosition() {
    return Math.min(this.here(), this.duration);
  }

  private latency() {
    return this.output.latency?.() ?? 0;
  }

  private here(now = this.output.now()) {
    return this.scrub ?? positionAt(this.playback, now);
  }

  /**
   * The segment of the trajectory that was actually audible at `time`.
   *
   * Audio reaching the speakers now was rendered `latency()` seconds ago, and
   * the rate may have changed since. `past` holds the earlier anchors, oldest
   * first, so the answer is the newest one that had already begun at `time`.
   */
  private trajectoryAt(time: ClockSeconds) {
    if (time >= this.playback.anchorTime) return this.playback;
    let chosen: Playback | null = null;
    for (const candidate of this.past) if (candidate.anchorTime <= time) chosen = candidate;
    return chosen ?? this.past[0] ?? this.playback;
  }

  private reanchor(position: RecordingSeconds, time = this.output.now()) {
    this.anchor = { position, time };
  }

  private reanchorHere() {
    const now = this.output.now();
    this.reanchor(this.here(now), now);
  }

  private render() {
    if (this.disposed) return;
    const { playState, loop, speed } = this.state;
    const { loopMode } = this;
    const previous = this.playback;
    const mode: PlaybackMode = this.scrub !== null ? "scrubbing" : playState === "playing" ? "playing" : playState === "frozen" ? "frozen" : "silent";
    this.playback = {
      mode,
      anchorPosition: this.scrub ?? this.anchor.position,
      anchorTime: this.anchor.time,
      rate: speed,
      loop,
      loopWraps: loopMode.type === "automatic" && loopDelay(loopMode) === 0,
    };
    if (previous && continues(previous, this.playback)) {
      this.past.push(previous);
      const cutoff = this.playback.anchorTime - Math.max(this.latency(), 0) - 0.25;
      while (this.past.length > 1 && this.past[1].anchorTime <= cutoff) this.past.shift();
      while (this.past.length > TRAJECTORY_LIMIT) this.past.shift();
    } else {
      this.past = [];
      this.audibleFrom = this.anchor.time;
    }
    this.output.render(this.playback);
    this.schedule();
    this.listeners.forEach((listener) => listener());
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.scrub !== null) return;
    const { mode, anchorPosition, anchorTime, rate, loop, loopWraps } = this.playback;
    const { playState, waitingUntil } = this.state;
    let due: number;
    let event: TransportEvent;
    if (mode === "playing" && !loopWraps && anchorPosition < loop.end) {
      due = anchorTime + (loop.end - anchorPosition) / rate + this.latency();
      event = { type: "loop-end" };
    } else if (playState === "waiting" && waitingUntil !== null) {
      due = waitingUntil;
      event = { type: "delay-end" };
    } else return;
    this.timer = setTimeout(() => {
      if (this.output.now() >= due - DUE_SLACK) this.dispatch(event);
      else this.schedule();
    }, Math.max(0, (due - this.output.now()) * 1000));
  }
}
