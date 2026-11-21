/**
 * Differences from the official runtime that the random-session tests reported. Each one has its smallest document in
 * tests/fixtures. A difference that is a bug in the editor gets fixed; one that turned out to be the two runtimes reading the
 * same number differently stays here as the proof that the test harness, not the solver, was wrong.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Project } from '../src/core/model';
import { parityMismatch } from './fuzzkit';

describe('differences from the official runtime that were looked into', () => {
  // seed 118 (150 actions): bone "gear" has a rotation of -3e-15 degrees (float noise of an earlier edit) that the exporter rounds to 0.
  // The transform constraint reads its world rotation (0..360) BEFORE the slider turns the bone: -3e-15 gives 360 here and 0 in the
  // exported file, and a mix of 0.8 on 720 degrees of difference lands on another angle. The editor and the export agree on everything
  // else; the harness only looked at the pose the slider left behind when it asked whether the read was on the wrap.
  it('a transform constraint that reads its source on the 0/360 wrap before a slider moves it (fuzz seed 118)', () => {
    const p = JSON.parse(readFileSync('tests/fixtures/transform-parity.json', 'utf8')) as Project;
    expect(parityMismatch(p)).toBeNull();
  });
});

describe('found by the random sessions, fixed', () => {
  // seed 226: two sliders apply an animation whose attachment timeline switches a slot to nothing and back. A slot that changes its
  // attachment starts without the deformation of the old one (the official SlotPose.setAttachment); ours kept it, so the path of the
  // slot came out deformed here and in its setup shape in the official runtime.
  it("a slider that switches a slot's attachment drops the deformation of the old one (fuzz seed 226)", () => {
    const p = JSON.parse(readFileSync('tests/fixtures/slider-attachment-deform.json', 'utf8')) as Project;
    expect(parityMismatch(p)).toBeNull();
  });
});

describe('looked into: a result that depends on float noise', () => {
  // seed 131: a path constraint turns a bone by exactly half a turn (the next point lies straight along -x of the bone). Our path points have
  // a y that is -3e-14 away from the one the official runtime computes (0), so atan2 gives -pi here and +pi there, and a mix of 0.7 turns
  // the bone 127 degrees one way or the other; the children that follow it come out in different places. Not a defect of either side: the
  // test harness skips the bones of a constraint that sits on that cut (PathConstraintRT.onBranchCut).
  it('a path constraint that turns a bone by exactly half a turn (fuzz seed 131)', () => {
    const p = JSON.parse(readFileSync('tests/fixtures/path-halfturn.json', 'utf8')) as Project;
    expect(parityMismatch(p)).toBeNull();
  });
});
