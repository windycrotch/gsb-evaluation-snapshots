import type { PlaySettings } from './model';
/**
 * How the playhead moves while an animation plays: forward or ping-pong (forward, then backward), looping or playing once,
 * over the whole animation or over a chosen range (Spine's loop range). Pure: the playback loop feeds it the elapsed time.
 */
export interface PlayMode {
  loop: boolean;
  pingPong: boolean;
  /** Seconds [start, end] to play instead of the whole animation. */
  range: [number, number] | null;
}

export interface PlayState {
  time: number;
  /** 1 forward, -1 backward (only a ping-pong runs backward). */
  dir: 1 | -1;
}

/** The part of the animation that plays: the range clamped to the animation, or all of it when the range is empty or missing. */
export function playSpan(duration: number, range: PlayMode['range']): [number, number] {
  if (!range) return [0, Math.max(0, duration)];
  const lo = Math.min(Math.max(0, range[0]), duration);
  const hi = Math.min(Math.max(0, range[1]), duration);
  return hi - lo >= 1e-3 ? [lo, hi] : [0, Math.max(0, duration)];
}

/** Moves the playhead by `delta` seconds (already multiplied by the speed). `stopped` is true when a one-shot play reached its end. */
export function advancePlayback(state: PlayState, delta: number, duration: number, mode: PlayMode): PlayState & { stopped: boolean } {
  const [lo, hi] = playSpan(duration, mode.range);
  const length = hi - lo;
  if (length <= 0) return { time: lo, dir: 1, stopped: true };
  const t = Math.min(Math.max(state.time, lo), hi);
  if (!mode.pingPong) {
    let p = t - lo + delta;
    if (p >= length) {
      if (!mode.loop) return { time: hi, dir: 1, stopped: true };
      p %= length;
    }
    return { time: lo + p, dir: 1, stopped: false };
  }
  // ping-pong: one position along a cycle that runs there and back
  const period = length * 2;
  let p = (state.dir > 0 ? t - lo : period - (t - lo)) + delta;
  if (p >= period) {
    if (!mode.loop) return { time: lo, dir: 1, stopped: true };
    p %= period;
  }
  return p <= length ? { time: lo + p, dir: 1, stopped: false } : { time: lo + period - p, dir: -1, stopped: false };
}

/** What a new animation plays like: looping, the whole animation, forward only. */
export const DEFAULT_PLAY: PlaySettings = { loop: true, pingPong: false, range: null };

/** The play settings of an animation (the defaults when it has none or they are damaged). */
export function playOf(anim: { play?: unknown; duration: number } | null | undefined): PlaySettings {
  return cleanPlay(anim?.play, anim?.duration ?? 0);
}

/** Play settings from anything: booleans where booleans belong, and a range of two numbers inside the animation (null when it is empty). */
export function cleanPlay(raw: unknown, duration: number): PlaySettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { loop?: unknown; pingPong?: unknown; range?: unknown };
  let range: [number, number] | null = null;
  if (Array.isArray(r.range) && r.range.length === 2 && Number.isFinite(r.range[0]) && Number.isFinite(r.range[1])) {
    const lo = Math.min(Math.max(0, +r.range[0]), duration);
    const hi = Math.min(Math.max(0, +r.range[1]), duration);
    if (hi - lo >= 1e-3) range = [lo, hi];
  }
  return {
    loop: typeof r.loop === 'boolean' ? r.loop : DEFAULT_PLAY.loop,
    pingPong: typeof r.pingPong === 'boolean' ? r.pingPong : DEFAULT_PLAY.pingPong,
    range,
  };
}

export function samePlay(a: PlaySettings, b: PlaySettings): boolean {
  return (
    a.loop === b.loop &&
    a.pingPong === b.pingPong &&
    (a.range === b.range || (!!a.range && !!b.range && a.range[0] === b.range[0] && a.range[1] === b.range[1]))
  );
}

/** The time the pose is shown at when playback is "stepped": the start of the frame the time falls in, as a game that runs at the animation's frame rate would. */
export function steppedTime(time: number, fps: number): number {
  if (!(fps > 0)) return time;
  return Math.floor(time * fps + 1e-6) / fps;
}
