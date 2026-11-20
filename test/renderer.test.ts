import { describe, expect, it } from 'vitest';
import { AtmosphereRenderer } from '../src/renderer.js';
import { resolveConditions } from '../src/state.js';

// AtmosphereRenderer's readiness bookkeeping, as far as it can be read with
// no WebGL: the answers a caller gets before anything is linked. The variant
// that a driver refuses mid-flight is covered against a fake renderer in
// atmosphere.test.ts, and against a real browser in e2e/sky.spec.ts.

const noGL = () => ({
  getContext: () => null,
  addEventListener() {},
  removeEventListener() {},
  width: 0,
  height: 0,
}) as unknown as HTMLCanvasElement;

describe('a renderer with no WebGL', () => {
  it('is unavailable, and refuses no variant — there is nothing to refuse', () => {
    const r = new AtmosphereRenderer(noGL());
    expect(r.available).toBe(false);
    expect(r.ready).toBe(false);
    // (a state is not "refused" for want of a context: it is unavailable,
    // which isSettled and onReady(false) already say)
    expect(r.variantRefused(resolveConditions({ weather: 'rain' }))).toBe(false);
    r.dispose();
  });

  it('draws nothing for a render(), and stays unsettled', () => {
    const r = new AtmosphereRenderer(noGL());
    const s = resolveConditions({ weather: 'fair' });
    expect(() => r.render(0, s)).not.toThrow();
    expect(r.isSettled(s)).toBe(false);
    r.dispose();
  });
});
