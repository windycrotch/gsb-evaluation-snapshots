/**
 * A reference video under the animation (rotoscoping): which moment of the video goes with a time of the animation, when the video has to
 * be moved to stay in step, and where it is drawn on the screen. Editor only: the video is never saved or exported.
 */

export interface RefVideoView {
  /** Seconds added to the animation time to get the video time (negative: the video starts later). */
  offset: number;
  /** Percent of the size of the video's own pixels (100: one pixel of the video is one scene unit). */
  scale: number;
  /** Where the middle of the video sits in the scene. */
  x: number;
  y: number;
  /** 0 to 1. */
  opacity: number;
}

export const DEFAULT_REF_VIDEO: RefVideoView = { offset: 0, scale: 100, x: 0, y: 0, opacity: 0.5 };

/** The moment of the video that goes with an animation time: before its start the first frame shows, after its end the last. */
export function videoTimeFor(time: number, offset: number, duration: number): number {
  const t = time + offset;
  if (!(duration > 0)) return Math.max(0, t);
  return Math.min(duration, Math.max(0, t));
}

export interface SyncPlan {
  /** Move the video to this time, or null to leave it. */
  seek: number | null;
  play: boolean;
}

/**
 * What to do to the video to keep it with the animation. Paused: it is moved to the exact frame when it is off by more than half a frame.
 * Playing: it plays on its own and is only moved when it has drifted by more than `tolerance` seconds, so it does not stutter; past either
 * end of the video it waits there.
 */
export function syncPlan(videoTime: number, wanted: number, playing: boolean, duration: number, fps = 30, tolerance = 0.15): SyncPlan {
  const atEnd = duration > 0 && wanted >= duration;
  const atStart = wanted <= 0;
  if (!playing || atEnd || atStart) {
    return { seek: Math.abs(videoTime - wanted) > 0.5 / Math.max(1, fps) ? wanted : null, play: false };
  }
  return { seek: Math.abs(videoTime - wanted) > tolerance ? wanted : null, play: true };
}

/** The rectangle of the video on the screen, in CSS pixels, for a camera and the viewport size. */
export function videoRect(
  cam: { x: number; y: number; zoom: number; flip?: boolean },
  width: number,
  height: number,
  view: RefVideoView,
  videoW: number,
  videoH: number,
): { left: number; top: number; width: number; height: number } {
  const k = (view.scale / 100) * cam.zoom;
  const w = videoW * k;
  const h = videoH * k;
  const cx = (view.x - cam.x) * cam.zoom * (cam.flip ? -1 : 1) + width / 2;
  const cy = height / 2 - (view.y - cam.y) * cam.zoom;
  return { left: cx - w / 2, top: cy - h / 2, width: w, height: h };
}

/** A view from anything: the opacity between 0 and 1, a scale above zero, numbers that are really numbers. */
export function cleanRefVideoView(v: Partial<RefVideoView>): RefVideoView {
  const num = (x: unknown, fallback: number) => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);
  return {
    offset: num(v.offset, DEFAULT_REF_VIDEO.offset),
    scale: Math.min(2000, Math.max(1, num(v.scale, DEFAULT_REF_VIDEO.scale))),
    x: num(v.x, DEFAULT_REF_VIDEO.x),
    y: num(v.y, DEFAULT_REF_VIDEO.y),
    opacity: Math.min(1, Math.max(0, num(v.opacity, DEFAULT_REF_VIDEO.opacity))),
  };
}
