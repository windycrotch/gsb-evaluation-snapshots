// Framework-agnostic lookahead scheduler for the metronome.
//
// Chris Wilson's "A Tale of Two Clocks" pattern: an interval timer (driven by
// the JS clock) only queues events onto the audio clock, which plays them
// sample-accurately. All timing state lives here so the behaviour can be unit
// tested without a browser or React; the React hook in use-metronome.ts is a
// thin wrapper that supplies the AudioContext primitives.

export const LOOKAHEAD_MS = 25;
export const SCHEDULE_AHEAD_S = 0.1;
export const START_DELAY_S = 0.05;
export const DOWNBEAT_FREQUENCY = 1200;
export const NORMAL_FREQUENCY = 800;

type IntervalId = ReturnType<typeof globalThis.setInterval>;
type TimeoutId = ReturnType<typeof globalThis.setTimeout>;

export interface ScheduledClick {
  /** Zero-based position of the click inside its bar. */
  beatIndex: number;
  /** Audio-clock time at which the click sounds. */
  time: number;
  /** Abort a click that was queued but has not sounded yet. */
  cancel: () => void;
  /** Timer that flips the visual indicator when the click actually sounds. */
  visualTimer: TimeoutId;
}

export interface MetronomeEngineOptions {
  bpm: number;
  beatsPerBar: number;
  /** Current audio-clock time in seconds. */
  getAudioTime: () => number;
  /**
   * Queue one click on the audio clock. Must return a cancel function that
   * prevents the click from sounding.
   */
  scheduleClick: (
    beatIndex: number,
    isDownbeat: boolean,
    time: number,
  ) => () => void;
  /** Fires with the beat index when a click sounds, or null when stopped. */
  onBeat?: (beatIndex: number | null) => void;
  setIntervalFn?: (callback: () => void, ms: number) => IntervalId;
  clearIntervalFn?: (id: IntervalId) => void;
  setTimeoutFn?: (callback: () => void, ms: number) => TimeoutId;
  clearTimeoutFn?: (id: TimeoutId) => void;
}

export class MetronomeEngine {
  private bpm: number;
  private beatsPerBar: number;
  private readonly getAudioTime: () => number;
  private readonly scheduleClick: MetronomeEngineOptions["scheduleClick"];
  private readonly onBeat?: (beatIndex: number | null) => void;
  private readonly setIntervalFn: (cb: () => void, ms: number) => IntervalId;
  private readonly clearIntervalFn: (id: IntervalId) => void;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => TimeoutId;
  private readonly clearTimeoutFn: (id: TimeoutId) => void;

  private running = false;
  private intervalId: IntervalId | null = null;
  /** Audio-clock time of the next click to queue. */
  private nextNoteTime = 0;
  /** Zero-based position inside the current bar (0 = downbeat). */
  private beatInBar = 0;
  /** Clicks already queued on the audio clock, not yet sounded. */
  private readonly pending = new Set<ScheduledClick>();

  constructor(opts: MetronomeEngineOptions) {
    this.bpm = opts.bpm;
    this.beatsPerBar = opts.beatsPerBar;
    this.getAudioTime = opts.getAudioTime;
    this.scheduleClick = opts.scheduleClick;
    this.onBeat = opts.onBeat;
    this.setIntervalFn =
      opts.setIntervalFn ?? ((cb, ms) => globalThis.setInterval(cb, ms));
    this.clearIntervalFn =
      opts.clearIntervalFn ?? ((id) => globalThis.clearInterval(id));
    this.setTimeoutFn =
      opts.setTimeoutFn ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
    this.clearTimeoutFn =
      opts.clearTimeoutFn ?? ((id) => globalThis.clearTimeout(id));
  }

  get isRunning(): boolean {
    return this.running;
  }

  get currentBeatInBar(): number {
    return this.beatInBar;
  }

  /**
   * Start from beat 1 (the downbeat) of a fresh bar. Any prior run is fully
   * torn down first, so restarting after stop always begins on the downbeat.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.beatInBar = 0;
    this.nextNoteTime = this.getAudioTime() + START_DELAY_S;
    this.intervalId = this.setIntervalFn(() => this.scheduler(), LOOKAHEAD_MS);
  }

  /**
   * Stop immediately: cancel every click queued but not yet sounded, suppress
   * all pending indicator updates, and clear the indicator.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.intervalId !== null) {
      this.clearIntervalFn(this.intervalId);
      this.intervalId = null;
    }
    for (const click of this.pending) {
      this.clearTimeoutFn(click.visualTimer);
      click.cancel();
    }
    this.pending.clear();
    this.onBeat?.(null);
  }

  /**
   * Change tempo. Only the spacing of clicks queued from now on changes: the
   * position reached inside the current bar and the next click time are kept,
   * so the bar count never jumps and already-queued clicks stay put.
   */
  setBpm(nextBpm: number): void {
    this.bpm = nextBpm;
  }

  /**
   * Change time signature. Counting restarts from beat 1 of a brand-new bar:
   * counts accumulated under the old signature are not re-wrapped onto it.
   * Clicks already queued under the old bar are pulled back and its downbeat
   * is re-queued at the earliest pending time, so playback stays gap-free.
   */
  setBeatsPerBar(nextBeatsPerBar: number): void {
    if (nextBeatsPerBar === this.beatsPerBar) return;
    this.beatsPerBar = nextBeatsPerBar;
    this.beatInBar = 0;
    if (!this.running) return;

    let earliestPending = Infinity;
    for (const click of this.pending) {
      earliestPending = Math.min(earliestPending, click.time);
      this.clearTimeoutFn(click.visualTimer);
      click.cancel();
    }
    this.pending.clear();
    if (Number.isFinite(earliestPending)) {
      this.nextNoteTime = earliestPending;
    }
    this.scheduler();
  }

  private scheduler(): void {
    if (!this.running) return;
    const horizon = this.getAudioTime() + SCHEDULE_AHEAD_S;
    while (this.nextNoteTime < horizon) {
      const beatIndex = this.beatInBar;
      const time = this.nextNoteTime;
      const isDownbeat = beatIndex === 0;
      const cancel = this.scheduleClick(beatIndex, isDownbeat, time);

      // The indicator flips when the click actually sounds, not when it is
      // queued, so it stays in lock-step with the audio.
      let click: ScheduledClick;
      const delayMs = Math.max(0, (time - this.getAudioTime()) * 1000);
      const visualTimer = this.setTimeoutFn(() => {
        this.pending.delete(click);
        this.onBeat?.(beatIndex);
      }, delayMs);
      click = { beatIndex, time, cancel, visualTimer };
      this.pending.add(click);

      this.nextNoteTime += 60.0 / this.bpm;
      this.beatInBar = (this.beatInBar + 1) % this.beatsPerBar;
    }
  }
}
