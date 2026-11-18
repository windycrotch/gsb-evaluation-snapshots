import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MM_PER_INCH,
  ONE_TO_ONE_TOLERANCE,
  getTargetPixelsPerMm,
  get1to1RelativeError,
  isOrthographic1to1,
} from '../utils/scale1to1.ts';

describe('1:1 orthographic judgment', () => {
  const ppi = 96;
  const target = getTargetPixelsPerMm(ppi);

  it('derives the target as PPI pixels per millimeter (PPI / 25.4)', () => {
    assert.equal(target, ppi / MM_PER_INCH);
    assert.ok(Math.abs(target - 3.7795275590551185) < 1e-12);
  });

  it('matches exactly at the target zoom', () => {
    assert.equal(isOrthographic1to1(target, ppi), true);
    assert.equal(get1to1RelativeError(target, ppi), 0);
  });

  it('updates the target when PPI changes', () => {
    const ppi2 = 144;
    const target2 = getTargetPixelsPerMm(ppi2);
    assert.notEqual(target2, target);
    assert.equal(isOrthographic1to1(target, ppi2), false); // old zoom no longer matches
    assert.equal(isOrthographic1to1(target2, ppi2), true); // new target matches
  });

  it('judges the two sides of the 0.015 relative-error boundary in opposite ways', () => {
    // Relative error e means zoom = target * (1 +/- e).
    const justInside = target * (1 + (ONE_TO_ONE_TOLERANCE - 1e-9));
    const justOutside = target * (1 + (ONE_TO_ONE_TOLERANCE + 1e-9));

    assert.ok(get1to1RelativeError(justInside, ppi) < ONE_TO_ONE_TOLERANCE);
    assert.equal(isOrthographic1to1(justInside, ppi), true);

    assert.ok(get1to1RelativeError(justOutside, ppi) > ONE_TO_ONE_TOLERANCE);
    assert.equal(isOrthographic1to1(justOutside, ppi), false);

    // Symmetric check on the under-zoom side.
    const underInside = target * (1 - (ONE_TO_ONE_TOLERANCE - 1e-9));
    const underOutside = target * (1 - (ONE_TO_ONE_TOLERANCE + 1e-9));
    assert.equal(isOrthographic1to1(underInside, ppi), true);
    assert.equal(isOrthographic1to1(underOutside, ppi), false);
  });

  it('uses a strictly less-than comparison against the 0.015 tolerance', () => {
    // For every probe the verdict must equal "error < tolerance", proving the
    // boundary itself (error === 0.015) can never be accepted as a match.
    const probes = [
      target,
      target * (1 - ONE_TO_ONE_TOLERANCE),
      target * (1 + ONE_TO_ONE_TOLERANCE),
      target * (1 - (ONE_TO_ONE_TOLERANCE + 1e-6)),
      target * (1 + (ONE_TO_ONE_TOLERANCE + 1e-6)),
      target * 0.5,
      target * 1.5,
    ];
    for (const zoom of probes) {
      const error = get1to1RelativeError(zoom, ppi);
      assert.equal(isOrthographic1to1(zoom, ppi), error < ONE_TO_ONE_TOLERANCE);
    }
  });

  it('treats non-finite zoom or PPI as not matching', () => {
    assert.equal(isOrthographic1to1(Number.NaN, ppi), false);
    assert.equal(isOrthographic1to1(target, 0), false);
    assert.equal(isOrthographic1to1(target, Number.NaN), false);
  });
});
