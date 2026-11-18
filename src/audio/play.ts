import { Track } from "@/audio/track";
import { durationToSeconds } from "@/audio/util";

/**
 * Manages playback and scheduling of tracks through a web audio context.
 */
export default class Player {
  /** Internal position counter. */
  index: number;

  length: number;

  lookahead: number;

  loop: boolean;

  step: number;

  tempo: number;

  /** Audio context time of the most recently scheduled step. */
  timer: number;

  tick: number;

  /** Handle for the currently pending scheduler timeout. */
  timeout: ReturnType<typeof setTimeout> | null;

  /**
   * Monotonic playback generation, incremented whenever playback stops.
   * Queued scheduler callbacks from earlier generations are ignored so that
   * stopping or restarting cannot leave a second scheduling loop running.
   */
  generation: number;

  constructor(
    length: number,
    lookahead: number,
    step: number,
    tempo: number,
    tick: number
  ) {
    this.index = -1;
    this.length = length;
    this.lookahead = lookahead;
    this.loop = false;
    this.step = step;
    this.tempo = tempo;
    this.tick = tick;
    this.timer = 0;
    this.timeout = null;
    this.generation = 0;
  }

  /**
   * Check if next audio step is within the current schedular lookahead range.
   *
   * @param stepDuration  Size of next audio step.
   * @param stop  End of lookahead range.
   * @returns Whether step is within the current schedular lookahead range.
   */
  next(stepDuration: number, lookaheadStop: number): boolean {
    if (this.timer + stepDuration >= lookaheadStop) {
      return false;
    }

    this.timer += stepDuration;
    this.index = (this.index + 1) % this.length;
    return true;
  }

  /**
   * Start playback from the first step using the current tempo.
   *
   * Any scheduler left over from a previous playback is cancelled first, so
   * repeated calls can never run more than one scheduling loop.
   *
   * @param context  Associated audio context.
   * @param destination  Audio node receiving the source samples.
   * @param tracks  Tracks to play.
   */
  start(
    context: AudioContext,
    destination: AudioNode,
    tracks: Array<Track>
  ): void {
    this.stop();
    this.loop = true;
    this.index = -1;
    this.timer = context.currentTime;
    this.playTick(context, destination, tracks, this.generation);
  }

  /**
   * Stop playback, cancel pending scheduling, and reset position and timing.
   */
  stop(): void {
    this.loop = false;
    this.generation += 1;

    if (this.timeout !== null) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }

    this.index = -1;
    this.timer = 0;
  }

  /**
   * Schedules audio playback for tracks.
   *
   * @param context  Associated audio context.
   * @param destination  Audio node receiving the source samples.
   * @param tracks  Tracks to play.
   * @param generation  Playback generation that queued this tick.
   */
  playTick(
    context: AudioContext,
    destination: AudioNode,
    tracks: Array<Track>,
    generation: number = this.generation
  ): void {
    if (generation !== this.generation) {
      return;
    }

    // Cancel any scheduler still pending from a previous tick or start so that
    // at most one scheduling loop is ever alive.
    if (this.timeout !== null) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }

    const stepDuration = durationToSeconds(this.tempo, this.step);
    const lookaheadStop = context.currentTime + this.lookahead;

    while (this.next(stepDuration, lookaheadStop)) {
      tracks.forEach((track) =>
        track.play(context, destination, this.index, this.timer)
      );
    }

    if (this.loop && generation === this.generation) {
      this.timeout = setTimeout(() => {
        this.timeout = null;
        if (!this.loop || generation !== this.generation) {
          return;
        }
        this.playTick(context, destination, tracks, generation);
      }, 1000 * this.tick);
    }
  }
}
