/** The reference video: which moment goes with a time of the animation, when it is moved, and where it is drawn. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_REF_VIDEO, cleanRefVideoView, syncPlan, videoRect, videoTimeFor } from '../src/core/refVideo';
import { screenToWorld, worldToScreen } from '../src/store/scene';

describe('videoTimeFor', () => {
  it('adds the offset and stays inside the video', () => {
    expect(videoTimeFor(1, 0.5, 10)).toBe(1.5);
    expect(videoTimeFor(1, -3, 10)).toBe(0);
    expect(videoTimeFor(9, 5, 10)).toBe(10);
    expect(videoTimeFor(2, 0, 0)).toBe(2); // length not known yet
    expect(videoTimeFor(-1, 0, 0)).toBe(0);
  });
});

describe('syncPlan', () => {
  it('moves a paused video to the exact frame, and leaves it when it is already there', () => {
    expect(syncPlan(1, 2, false, 10)).toEqual({ seek: 2, play: false });
    expect(syncPlan(2, 2, false, 10)).toEqual({ seek: null, play: false });
    expect(syncPlan(2.005, 2, false, 10, 30)).toEqual({ seek: null, play: false });
    expect(syncPlan(2.05, 2, false, 10, 30)).toEqual({ seek: 2, play: false });
  });

  it('lets a playing video run and only moves it when it has drifted', () => {
    expect(syncPlan(2.05, 2, true, 10)).toEqual({ seek: null, play: true });
    expect(syncPlan(2.5, 2, true, 10)).toEqual({ seek: 2, play: true });
    expect(syncPlan(1.5, 2, true, 10)).toEqual({ seek: 2, play: true });
  });

  it('holds the video at its ends while the animation runs on', () => {
    expect(syncPlan(9.9, 10, true, 10)).toEqual({ seek: 10, play: false });
    expect(syncPlan(0, 0, true, 10)).toEqual({ seek: null, play: false });
    expect(syncPlan(3, 0, true, 10)).toEqual({ seek: 0, play: false });
  });
});

describe('videoRect', () => {
  const cam = { x: 20, y: 50, zoom: 2 };

  it('puts the middle of the video at its scene position, scaled by the camera and by the scale', () => {
    const r = videoRect(cam, 800, 600, { ...DEFAULT_REF_VIDEO, x: 20, y: 50, scale: 100 }, 100, 60);
    expect(r).toEqual({ left: 400 - 100, top: 300 - 60, width: 200, height: 120 });
    const half = videoRect(cam, 800, 600, { ...DEFAULT_REF_VIDEO, x: 20, y: 50, scale: 50 }, 100, 60);
    expect(half.width).toBe(100);
    expect(half.left + half.width / 2).toBe(400);
  });

  it('agrees with the editor camera: its centre is where the scene point lands on the screen, y up', () => {
    const view = { ...DEFAULT_REF_VIDEO, x: -30, y: 120, scale: 80 };
    const r = videoRect(cam, 900, 500, view, 320, 180);
    const [sx, sy] = worldToScreen(cam, 900, 500, view.x, view.y);
    expect(r.left + r.width / 2).toBeCloseTo(sx, 9);
    expect(r.top + r.height / 2).toBeCloseTo(sy, 9);
    const [wx, wy] = screenToWorld(cam, 900, 500, r.left, r.top);
    expect(wx).toBeCloseTo(view.x - (320 * 0.8) / 2, 9);
    expect(wy).toBeCloseTo(view.y + (180 * 0.8) / 2, 9);
  });
});

describe('cleanRefVideoView', () => {
  it('keeps what is fine and repairs the rest', () => {
    expect(cleanRefVideoView({})).toEqual(DEFAULT_REF_VIDEO);
    expect(cleanRefVideoView({ opacity: 7, scale: -5, offset: NaN, x: Infinity })).toEqual({ ...DEFAULT_REF_VIDEO, opacity: 1, scale: 1 });
    expect(cleanRefVideoView({ opacity: -1, scale: 99999 })).toMatchObject({ opacity: 0, scale: 2000 });
    expect(cleanRefVideoView({ offset: -2.5, x: 4, y: -9, scale: 60, opacity: 0.3 })).toEqual({
      offset: -2.5,
      x: 4,
      y: -9,
      scale: 60,
      opacity: 0.3,
    });
  });
});
