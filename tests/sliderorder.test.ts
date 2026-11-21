/**
 * Found by the fuzz run (seed 246): a bone-driven slider with no animation does nothing and is left out of the export, but it used to
 * take part in the update order of our solver, so a path constraint next to it saw its bones updated in another order than in the
 * exported file (tn1.a 0.45 here, 0.71 in the official runtime).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileSkeleton, createSkeleton } from '../src/core/skeleton';
import type { Project } from '../src/core/model';
import { parityMismatch } from './fuzzkit';

describe('a slider without an animation', () => {
  const load = () => JSON.parse(readFileSync('tests/fixtures/path-slider-parity.json', 'utf8')) as Project;

  it('leaves the pose exactly as the official runtime computes it from the exported file', () => {
    expect(parityMismatch(load())).toBeNull();
  });

  it('is inactive, so it does not order the bones either', () => {
    const p = load();
    const data = compileSkeleton(structuredClone(p.skeleton));
    const sk = createSkeleton(data);
    const slider = sk.constraints.find((c) => c.data.kind === 'slider')!;
    expect(slider.active).toBe(false);
  });
});
