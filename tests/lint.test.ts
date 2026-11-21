/** The animation check: it finds what was made wrong on purpose, and says nothing about the demo rig and about a clean animation. */
import { beforeEach, describe, expect, it } from 'vitest';
import { counterpartName, sideStyle } from '../src/core/animtools';
import { uid } from '../src/core/ids';
import { SPIN_LIMIT, lintAnimation, lintProject } from '../src/core/lint';
import { closeLoop, openSeams } from '../src/core/loops';
import { emptyProject, newAnimation, newBone } from '../src/core/model';
import type { Animation, ImageRef, Key, Project } from '../src/core/model';
import { DEMO_IMAGES, buildDemoRig } from '../src/store/demo/kit';
import { fixFinding } from '../src/store/problemActions';
import { docStore } from '../src/store/doc';
import { emptySelection, uiStore } from '../src/store/ui';

const keys = (...pairs: [number, number][]): Key[] => pairs.map(([time, v]) => ({ time, value: [v] }));

/** An animation of one bone with the given rotate keys. */
function rotating(name: string, duration: number, rotate: Key[]): { anim: Animation; bone: string } {
  const bone = uid();
  const anim = newAnimation(name, duration);
  anim.bones[bone] = { rotate };
  return { anim, bone };
}

describe('the checks of one animation', () => {
  it('says nothing about a clean animation', () => {
    const { anim } = rotating('arm', 1, keys([0, 0], [0.5, 40], [1, 20]));
    expect(lintAnimation(anim, 30)).toEqual([]);
  });

  it('loopSeam: a cycle that ends on another value than it starts on, and not a one-shot', () => {
    const open = rotating('walk', 1, keys([0, 0], [0.5, 40], [1, 12]));
    expect(lintAnimation(open.anim, 30).map((f) => f.kind)).toEqual(['loopSeam']);
    const jump = rotating('jump', 1, keys([0, 0], [0.5, 40], [1, 12]));
    expect(lintAnimation(jump.anim, 30)).toEqual([]); // a jump is not named as a cycle
    jump.anim.play = { loop: true, pingPong: false, range: null };
    expect(lintAnimation(jump.anim, 30).map((f) => f.kind)).toEqual(['loopSeam']); // but the person said it loops
    open.anim.play = { loop: false, pingPong: false, range: null };
    expect(lintAnimation(open.anim, 30)).toEqual([]); // and a walk that is told not to loop is left alone
  });

  it('loopSeam: a seam under a tenth of a degree is not shown, closeLoop puts the rest right', () => {
    const tiny = rotating('idle', 1, keys([0, 0], [0.5, 5], [1, 0.05]));
    expect(lintAnimation(tiny.anim, 30)).toEqual([]);
    const open = rotating('idle', 1, keys([0, 0], [0.5, 5], [1, 3]));
    expect(openSeams(open.anim)).toBe(1);
    expect(closeLoop(open.anim)).toBe(1);
    expect(openSeams(open.anim)).toBe(0);
    expect(lintAnimation(open.anim, 30)).toEqual([]);
  });

  it('longSpin: more than half a circle between two keys, where it is and how many', () => {
    const { anim, bone } = rotating('arm', 1, keys([0, 0], [0.4, SPIN_LIMIT + 10], [1, 170]));
    const spin = lintAnimation(anim, 30).filter((f) => f.kind === 'longSpin');
    expect(spin).toHaveLength(1);
    expect(spin[0]).toMatchObject({ bone, time: 0, count: 1 });
    // exactly half a circle is allowed, and a stepped key does not turn through anything
    expect(lintAnimation(rotating('arm', 1, keys([0, 0], [1, SPIN_LIMIT])).anim, 30)).toEqual([]);
    const stepped = rotating('arm', 1, [
      { time: 0, value: [0], curve: 'stepped' },
      { time: 1, value: [300] },
    ]);
    expect(lintAnimation(stepped.anim, 30)).toEqual([]);
  });

  it('keyAfterEnd and duplicateKey', () => {
    const late = rotating('arm', 1, keys([0, 0], [1.5, 10]));
    expect(lintAnimation(late.anim, 30).map((f) => f.kind)).toEqual(['keyAfterEnd']);
    const twin = rotating('arm', 1, keys([0, 0], [0.5, 10], [0.5, 20], [1, 0]));
    expect(lintAnimation(twin.anim, 30).map((f) => f.kind)).toEqual(['duplicateKey']);
  });

  it('denseKeys: a key on every frame is found, a hand-keyed animation is not', () => {
    const baked = keys(...Array.from({ length: 31 }, (_, i): [number, number] => [i / 30, Math.sin(i / 5) * 20]));
    expect(lintAnimation(rotating('arm', 1, baked).anim, 30).map((f) => f.kind)).toEqual(['denseKeys']);
    const hand = keys(...Array.from({ length: 10 }, (_, i): [number, number] => [i / 10, i * 3]));
    expect(lintAnimation(rotating('arm', 1, hand).anim, 30)).toEqual([]);
  });
});

describe('the names of the sides', () => {
  const project = (...names: string[]): Project => {
    const p = emptyProject('names');
    for (const name of names) p.skeleton.bones.push(newBone({ name, parent: p.skeleton.bones[0].id, length: 10 }));
    return p;
  };

  it('knows how a name writes its side', () => {
    expect(sideStyle('arm_L')).toBe('l-r');
    expect(sideStyle('handLeft')).toBe('left-right');
    expect(sideStyle('arm near 1')).toBe('near-far');
    expect(sideStyle('head')).toBeNull();
    expect(counterpartName('arm_L')).toBe('arm_R');
  });

  it('unpairedSide: a side without the other one, listed by name; pairs and centre bones are fine', () => {
    expect(lintProject(project('arm_L', 'arm_R', 'head'))).toEqual([]);
    const found = lintProject(project('arm_L', 'arm_R', 'leg_L', 'head'));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'unpairedSide', subject: 'leg_L', count: 1 });
  });

  it('mixedSides: left/right and L/R in one skeleton; near/far next to L/R is another thing', () => {
    const mixed = lintProject(project('arm_L', 'arm_R', 'legLeft', 'legRight')).filter((f) => f.kind === 'mixedSides');
    expect(mixed).toHaveLength(1);
    expect(lintProject(project('arm_L', 'arm_R', 'tail near', 'tail far'))).toEqual([]);
  });
});

describe('the demo rig and the fix', () => {
  it('has nothing to say about the demo fox (no false alarms on a rig made with care)', () => {
    const images: Record<string, ImageRef> = {};
    for (const i of DEMO_IMAGES) images[i.name] = { id: uid(), name: i.name, width: i.width, height: i.height };
    expect(lintProject(buildDemoRig(images))).toEqual([]);
  });

  beforeEach(() => {
    const p = emptyProject('seam');
    const { anim } = rotating('idle', 1, keys([0, 0], [0.5, 5], [1, 3]));
    p.skeleton.animations.push(anim);
    docStore.replace(p);
    uiStore.patch({ selection: emptySelection, animationId: anim.id, time: 0 });
  });

  it('fixFinding closes the seam in one history step, and then the finding is gone', () => {
    const project = docStore.get();
    const found = lintProject(project);
    expect(found.map((f) => f.kind)).toEqual(['loopSeam']);
    expect(fixFinding(found[0])).toBe(1);
    expect(lintProject(docStore.get())).toEqual([]);
    expect(docStore.undoLabel).toBe('Close the loop');
    docStore.undo();
    expect(lintProject(docStore.get()).map((f) => f.kind)).toEqual(['loopSeam']);
  });
});
