/** The copies of a key that a looping animation comes round to: where the Dopesheet draws them faint. */
import { describe, expect, it } from 'vitest';
import { MAX_LOOP_GHOSTS, loopGhostTimes } from '../src/core/loops';

describe('loopGhostTimes', () => {
  it('has a copy of the key one length later after the end, and one earlier before 0', () => {
    // an animation 1 s long, a key at 0.25, a visible stretch from -1.2 to 2.2
    expect(loopGhostTimes(0.25, 1, -1.2, 2.2)).toEqual([-0.75, 1.25]);
  });

  it('never repeats the animation inside itself: the stretch 0 to the duration has no copies', () => {
    for (const t of [0, 0.3, 1, 0.999]) for (const g of loopGhostTimes(t, 1, -3, 4)) expect(g < -1e-9 || g > 1 + 1e-9).toBe(true);
    expect(loopGhostTimes(0.5, 1, 0, 1)).toEqual([]);
  });

  it('the first and the last key of a cycle land on the seam from the other side', () => {
    // a key at the very end (1) is also at 0 in the next round (inside the animation, not drawn) and at 2; a key at 0 comes back at 2 and at -1
    expect(loopGhostTimes(1, 1, -0.5, 2.5)).toEqual([2]);
    expect(loopGhostTimes(0, 1, -1.5, 2.5)).toEqual([-1, 2]);
    expect(loopGhostTimes(0, 1, -0.5, 2.5)).toEqual([2]); // -1 is outside the visible stretch
  });

  it('is in order and inside the visible stretch', () => {
    const g = loopGhostTimes(0.4, 0.8, -2, 3);
    expect(g).toEqual([...g].sort((a, b) => a - b));
    for (const t of g) {
      expect(t).toBeGreaterThanOrEqual(-2 - 1e-9);
      expect(t).toBeLessThanOrEqual(3 + 1e-9);
    }
  });

  it('is capped when the view is zoomed far out on a short animation', () => {
    expect(loopGhostTimes(0.01, 0.0333, -1000, 1000).length).toBeLessThanOrEqual(2 * MAX_LOOP_GHOSTS);
  });

  it('gives nothing for a length or a stretch that makes no sense', () => {
    expect(loopGhostTimes(0.3, 0, -1, 2)).toEqual([]);
    expect(loopGhostTimes(0.3, -1, -1, 2)).toEqual([]);
    expect(loopGhostTimes(0.3, 1, 2, -1)).toEqual([]);
    expect(loopGhostTimes(NaN, 1, -1, 2)).toEqual([]);
    expect(loopGhostTimes(0.3, 1, NaN, 2)).toEqual([]);
  });
});
