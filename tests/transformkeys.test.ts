/**
 * Keying the mixes of transform constraints (Spine's `transform` timeline) from the editor: Setup edits the constraint,
 * Animate keys all six mixes at the playhead. The solver side is compared with the official runtime in spine-parity.test.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { validateProject } from '../src/core/validate';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import * as I from '../src/store/ikActions';
import * as T from '../src/store/transformActions';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';
import { exportAndLoad } from './official';

const doc = () => docStore.get().skeleton;
const walk = () => doc().animations.find((a) => a.name === 'walk')!;
const constraint = (name: string) => doc().constraints.find((c) => c.name === name)!;

function load(mode: 'setup' | 'animate') {
  const f = buildFixture();
  docStore.replace(f.project);
  uiStore.patch({
    mode,
    tool: 'select',
    animationId: f.project.skeleton.animations[0].id,
    skinId: null,
    time: 0,
    selection: emptySelection,
    overrides: {},
    autoKey: true,
    playing: false,
  });
}

function healthy(label: string) {
  const project = docStore.get();
  expect(validateProject(project), `${label}: validator`).toEqual([]);
  expect(() => exportAndLoad(project), `${label}: official loader`).not.toThrow();
}

describe('keying transform constraint mixes', () => {
  beforeEach(() => load('animate'));

  it('in Setup mode edits the constraint and keys nothing', () => {
    uiStore.patch({ mode: 'setup' });
    const c = constraint('world add');
    T.setTransformMix(c.id, { rotate: 0.25, y: 0.5 });
    const after = constraint('world add');
    expect(after.type === 'transform' && [after.mix.rotate, after.mix.y]).toEqual([0.25, 0.5]);
    expect(walk().transform[c.id]).toBeUndefined();
    healthy('setup edit');
  });

  it('in Animate mode keys all six mixes, the ones that were not edited keep their current values', () => {
    const c = constraint('world add');
    A.setTime(0.5, false);
    expect(T.currentTransformMix(c.id)).toEqual([1, 1, 1, 1, 1, 1]);
    T.setTransformMix(c.id, { y: 0.4 });
    const keys = walk().transform[c.id];
    expect(keys).toHaveLength(1);
    expect(keys[0].time).toBeCloseTo(0.5, 6);
    expect(keys[0].value).toEqual([1, 1, 0.4, 1, 1, 1]); // rotate, x, y, scaleX, scaleY, shearY
    healthy('first key');

    // a second key; between the keys the mixes interpolate, before the first one they hold the setup value
    A.setTime(1, false);
    T.setTransformMix(c.id, { rotate: 0.5 });
    expect(walk().transform[c.id]).toHaveLength(2);
    A.setTime(0.75, false);
    const mid = T.currentTransformMix(c.id)!;
    expect(mid[0]).toBeCloseTo(0.75, 3);
    expect(mid[2]).toBeCloseTo(0.4, 6);
    A.setTime(0.1, false);
    expect(T.currentTransformMix(c.id)).toEqual([1, 1, 1, 1, 1, 1]);
    healthy('two keys');
  });

  it('keying the same time again replaces the key', () => {
    const c = constraint('world add');
    A.setTime(0.5, false);
    T.setTransformMix(c.id, { y: 0.4 });
    T.setTransformMix(c.id, { y: 0.9, scaleX: 0.1 });
    const keys = walk().transform[c.id];
    expect(keys).toHaveLength(1);
    expect(keys[0].value).toEqual([1, 1, 0.9, 0.1, 1, 1]);
  });

  it('a key on a constraint that is already keyed keeps the other channels of the animated value', () => {
    const c = constraint('slide follow');
    expect(walk().transform[c.id]).toHaveLength(3); // the fixture keys it
    A.setTime(0.3, false);
    const before = T.currentTransformMix(c.id)!;
    T.setTransformMix(c.id, { scaleX: 0.123 });
    const key = walk().transform[c.id].find((k) => Math.abs(k.time - 0.3) < 1e-6)!;
    expect(key.value.map((v, i) => (i === 3 ? v : +v.toFixed(6)))).toEqual(before.map((v, i) => (i === 3 ? 0.123 : +v.toFixed(6))));
    healthy('inserted key');
  });

  it('deleting the keys removes the timeline; copy and paste move keys of constraints', () => {
    const c = constraint('world add');
    A.setTime(0.5, false);
    T.setTransformMix(c.id, { y: 0.4 });
    A.copyKeys([{ kind: 'transform', target: c.id, prop: '', time: 0.5 }]);
    const pasted = A.pasteKeys(1);
    expect(pasted).toHaveLength(1);
    expect(walk().transform[c.id]).toHaveLength(2);
    healthy('pasted');
    A.deleteKeys([{ kind: 'transform', target: c.id, prop: '', time: 0.5 }, ...pasted]);
    expect(walk().transform[c.id]).toBeUndefined();
    healthy('deleted');
  });

  it('keys move with undo and redo as one step', () => {
    const c = constraint('world add');
    A.setTime(0.5, false);
    T.setTransformMix(c.id, { y: 0.4 });
    docStore.undo();
    expect(walk().transform[c.id]).toBeUndefined();
    docStore.redo();
    expect(walk().transform[c.id]).toHaveLength(1);
  });

  it('deleting the constraint removes its keys (the official loader rejects dangling timelines)', () => {
    const c = constraint('slide follow');
    expect(walk().transform[c.id]).toHaveLength(3);
    I.deleteConstraint(c.id);
    expect(walk().transform[c.id]).toBeUndefined();
    healthy('constraint deleted');
  });
});
