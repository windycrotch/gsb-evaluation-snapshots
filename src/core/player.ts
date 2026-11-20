import type { ClockSeconds, Core, DurationSeconds, LoopMode, Output, Playback, PlaybackMode, Player, PlayerOptions, RecordingSeconds, Section, SpeedRatio, TransportEvent, TransportState } from "./interfaces";
import { continues, positionAt } from "./playback";
import { loopDelay, transition } from "./transport";

export const createPlayer: Core["createPlayer"] = (output, options) => new TransportPlayer(output, options);

const DUE_SLACK = 0.002;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

class TransportPlayer implements Player {
  readonly duration: DurationSeconds;
  private readonly output: Output;
  private state: TransportState;
  private loopMode: LoopMode;
  private anchor: { position: RecordingSeconds; time: ClockSeconds };
  private playback!: Playback;
  private audibleFrom: ClockSeconds = -Infinity;
  private retimed: Playback | null = null;
  private scrub: number | null = null;
  private lifted = false;
  private preLiftLoop: Section | null = null;
  private preLiftWait: ClockSeconds | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();

  constructor(output: Output, { duration, position, loop, loopMode, speed }: PlayerOptions) {
    this.output = output;
    this.duration = duration;
    this.state = { playState: "paused", loop: loop ?? { start: 0, end: duration }, speed, waitingUntil: null };
    this.loopMode = loopMode;
    this.anchor = { position: clamp(position, 0, duration), time: output.now() };
    this.render();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getState = () => this.state;

  position() {
    const { playback } = this;
    if (this.scrub !== null || playback.mode !== "playing") return this.renderedPosition();
    const { loop, loopWraps, anchorPosition } = playback;
    const time = Math.max(this.audibleFrom, this.output.now() - this.latency());
    const heard = positionAt(time < playback.anchorTime && this.retimed ? this.retimed : playback, time);
    const unwrapped = loopWraps && heard < loop.start && anchorPosition >= loop.start ? heard + loop.end - loop.start : heard;
    return Math.min(unwrapped, this.duration);
  }

  delayRemaining() {
    const until = this.state.waitingUntil;
    return until === null ? 0 : Math.max(0, until - this.output.now());
  }

  dispatch(event: TransportEvent) {
    const { playState, loop } = this.state;
    const { loopMode } = this;
    const now = this.output.now();
    const position = this.here(now);
    const next = transition(playState, event, { position, loop, loopMode });
    if (next.state !== "waiting" && event.type !== "loop-change") this.preLiftWait = null;
    this.reanchor(next.position ?? (next.state === "playing" ? position : this.position()), now);
    const waitingUntil = next.state === "waiting" ? this.anchor.time + loopDelay(loopMode) : null;
    this.state = { ...this.state, playState: next.state, waitingUntil };
    this.render();
  }

  startScrub(at: RecordingSeconds) {
    this.scrub = clamp(at, 0, this.duration);
    this.render();
  }

  scrubTo(at: RecordingSeconds) {
    if (this.scrub === null) return;
    this.scrub = clamp(at, 0, this.duration);
    this.render();
  }

  endScrub() {
    const position = this.scrub;
    if (position === null) return;
    this.scrub = null;
    if (this.lifted) {
      // The committed loop is not active until the drag commits: the drop keeps
      // its exact position instead of snapping to the resting loop start.
      this.reanchor(position);
      this.render();
      return;
    }
    this.dispatch({ type: "move", position });
  }

  setSpeed(speed: SpeedRatio) {
    this.reanchorHere();
    this.state = { ...this.state, speed };
    this.render();
  }

  setLoop(loop: Section | null) {
    if (loop === null) {
      this.beginLoopDrag();
      return;
    }
    this.commitLoop(loop);
  }

  setLoopMode(loopMode: LoopMode) {
    if (loopMode.type === this.loopMode.type && loopDelay(loopMode) === loopDelay(this.loopMode)) return;
    this.reanchorHere();
    this.loopMode = loopMode;
    this.render();
  }

  correctPosition(observed: RecordingSeconds) {
    this.reanchor(observed);
    this.render();
  }

  dispose() {
    clearTimeout(this.timer);
    this.listeners.clear();
    this.output.render({ ...this.playback, mode: "silent" });
  }

  // A loop-handle drag lifts the loop for its whole duration: the resting loop
  // stays out of force until the pointer comes up, and a pending loop delay is
  // parked instead of being swallowed or firing at the old boundary.
  private beginLoopDrag() {
    if (this.lifted) return;
    this.lifted = true;
    this.preLiftLoop = this.state.loop;
    if (this.state.playState === "waiting" && this.state.waitingUntil !== null) {
      this.preLiftWait = this.state.waitingUntil;
      this.state = { ...this.state, waitingUntil: null };
    }
    this.state = { ...this.state, loop: { start: 0, end: this.duration } };
    this.render();
  }

  private commitLoop(next: Section) {
    if (!this.lifted) {
      // Direct setLoop (e.g. tests/shortcuts) keeps the original single-step semantics.
      if (next.start === this.state.loop.start && next.end === this.state.loop.end) return;
      this.state = { ...this.state, loop: next };
      this.dispatch({ type: "loop-change" });
      return;
    }
    const restored = this.preLiftLoop;
    this.lifted = false;
    this.preLiftLoop = null;
    const unchanged = restored !== null && restored.start === next.start && restored.end === next.end;
    const parked = this.preLiftWait;
    this.preLiftWait = null;
    this.state = { ...this.state, loop: next };
    if (parked !== null && unchanged) {
      // A no-op drag releases an intact wait: resume the same countdown rather
      // than restarting it or dropping it on the floor.
      const waitingUntil = Math.max(parked, this.output.now());
      this.state = { ...this.state, playState: "waiting", waitingUntil };
      this.render();
      return;
    }
    this.dispatch({ type: "loop-change" });
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

  private reanchor(position: RecordingSeconds, time = this.output.now()) {
    this.anchor = { position, time };
  }

  private reanchorHere() {
    const now = this.output.now();
    this.reanchor(this.here(now), now);
  }

  private render() {
    const { playState, loop, speed } = this.state;
    const { loopMode } = this;
    const previous = this.playback;
    const mode: PlaybackMode =
      this.scrub !== null ? "scrubbing" : playState === "playing" ? "playing" : playState === "frozen" ? "frozen" : "silent";
    this.playback = {
      mode,
      anchorPosition: this.scrub ?? this.anchor.position,
      anchorTime: this.anchor.time,
      rate: speed,
      loop,
      loopWraps: !this.lifted && loopMode.type === "automatic" && loopDelay(loopMode) === 0,
    };
    const seamless = !!previous && continues(previous, this.playback);
    if (!seamless) this.audibleFrom = this.anchor.time;
    this.retimed = seamless ? previous : null;
    this.output.render(this.playback);
    this.schedule();
    this.listeners.forEach((listener) => listener());
  }

  private schedule() {
    clearTimeout(this.timer);
    if (this.lifted) return;
    const { mode, anchorPosition, anchorTime, rate, loop, loopWraps } = this.playback;
    const { playState, waitingUntil } = this.state;
    let due: number;
    let event: TransportEvent;
    if (mode === "playing" && !loopWraps && anchorPosition < loop.end) {
      due = anchorTime + (loop.end - anchorPosition) / rate;
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
