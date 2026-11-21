/** The Preview window: the mix table, the crossfade between two animations, the player and its events, the sound lookup. */
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyProject, newAnimation, newBone } from '@/core/model';
import type { Animation, Project } from '@/core/model';
import { PreviewPlayer, cleanMixes, mixTime, poseMixed, soundKey, withDefaultMix, withMix, withoutAnimation } from '@/core/preview';
import { compileSkeleton, createSkeleton } from '@/core/skeleton';
import { validateProject } from '@/core/validate';
import { deleteAnimation } from '@/store/actions';
import { docStore } from '@/store/doc';
import { setDefaultMix, setMixPair } from '@/store/mixActions';
import { hasSound, playEventSound } from '@/store/sounds';

const rot = (anim: Animation, bone: string, a: number, b: number) => {
  anim.bones[bone] = {
    rotate: [
      { time: 0, value: [a] },
      { time: anim.duration, value: [b] },
    ],
  };
};

function build() {
  const p: Project = emptyProject();
  p.skeleton.bones = [];
  const root = newBone({ name: 'root', length: 10 });
  p.skeleton.bones.push(root);
  const a = newAnimation('a', 1);
  const b = newAnimation('b', 1);
  rot(a, root.id, 0, 90);
  rot(b, root.id, 90, 0);
  p.skeleton.animations.push(a, b);
  return { p, root, a, b };
}

describe('mix table', () => {
  it('a pair without an entry takes the default; the entry wins', () => {
    const m = withMix(withDefaultMix(undefined, 0.3), 'a', 'b', 0.8);
    expect(mixTime(m, 'a', 'b')).toBe(0.8);
    expect(mixTime(m, 'b', 'a')).toBe(0.3);
    expect(mixTime(undefined, 'a', 'b')).toBe(0);
  });
  it('a time equal to the default removes the entry, a new default drops the entries it now equals', () => {
    let m = withMix(withDefaultMix(undefined, 0.3), 'a', 'b', 0.8);
    m = withMix(m, 'a', 'b', 0.3);
    expect(m.pairs).toEqual([]);
    m = withMix(m, 'a', 'b', 0.5);
    m = withDefaultMix(m, 0.5);
    expect(m.pairs).toEqual([]);
  });
  it('cleaning keeps known animations, one entry per pair, times in range, and nothing when nothing is left', () => {
    const ids = new Set(['a', 'b']);
    const m = cleanMixes(
      {
        default: -4,
        pairs: [
          { from: 'a', to: 'b', time: 99 },
          { from: 'a', to: 'b', time: 1 },
          { from: 'a', to: 'zz', time: 1 },
          { from: 5, to: 'b', time: 1 },
          null,
        ],
      },
      ids,
    );
    expect(m).toEqual({ default: 0, pairs: [{ from: 'a', to: 'b', time: 10 }] });
    expect(cleanMixes({ default: 0, pairs: [] }, ids)).toBeUndefined();
    expect(cleanMixes('x', ids)).toBeUndefined();
    expect(withoutAnimation(m, 'b')!.pairs).toEqual([]);
  });
});

describe('crossfade of poses', () => {
  it('alpha 1 is the new animation, alpha 0 the old one, in between the short way round', () => {
    const { p, root, a } = build();
    rot(a, root.id, 170, 170);
    const b = p.skeleton.animations[1];
    rot(b, root.id, -170, -170); // 20 degrees away from 170 through 180
    const sk = createSkeleton(compileSkeleton(p.skeleton));
    const bone = sk.bones[0];
    poseMixed(sk, { anim: a, time: 0 }, { anim: b, time: 0 }, 1);
    expect(bone.rotation).toBeCloseTo(-170, 6);
    poseMixed(sk, { anim: a, time: 0 }, { anim: b, time: 0 }, 0);
    expect(bone.rotation).toBeCloseTo(170, 6);
    poseMixed(sk, { anim: a, time: 0 }, { anim: b, time: 0 }, 0.5);
    expect(Math.abs(Math.abs(bone.rotation) - 180)).toBeLessThan(1e-6); // 180, not 0
  });
});

describe('player', () => {
  it('without a mix it switches at once; with a mix it fades over the time of the pair', () => {
    const { p, a, b } = build();
    const m = withMix(undefined, a.id, b.id, 0.5);
    const pl = new PreviewPlayer();
    pl.play(a);
    expect(pl.alpha).toBe(1);
    pl.advance(0.25);
    pl.play(b, m);
    expect(pl.alpha).toBe(0);
    pl.advance(0.25);
    expect(pl.alpha).toBeCloseTo(0.5, 9);
    const sk = createSkeleton(compileSkeleton(p.skeleton));
    pl.pose(sk);
    // old animation at 0.5 s is 45 degrees, the new one at 0.25 s is 67.5: halfway between
    expect(sk.bones[0].rotation).toBeCloseTo((45 + 67.5) / 2, 6);
    pl.advance(0.3);
    expect(pl.alpha).toBe(1);
  });
  it('loops, stops at the end when not looping, and reports each event once', () => {
    const { a } = build();
    a.events.push({ time: 0.5, event: 'e1' }, { time: 1, event: 'e2' });
    const pl = new PreviewPlayer();
    pl.play(a);
    expect(pl.advance(0.6).map((e) => e.event)).toEqual(['e1']);
    expect(pl.advance(0.6).map((e) => e.event)).toEqual(['e2']); // 1.2: crosses the end, no event at 0..0.2
    expect(pl.time).toBeCloseTo(0.2, 9);
    expect(pl.advance(0.4).map((e) => e.event)).toEqual(['e1']);
    pl.loop = false;
    pl.advance(5);
    expect(pl.time).toBe(1);
    pl.playing = false;
    expect(pl.advance(1)).toEqual([]);
    expect(pl.time).toBe(1);
  });
  it('speed scales the time', () => {
    const { a } = build();
    const pl = new PreviewPlayer();
    pl.speed = 2;
    pl.play(a);
    pl.advance(0.25);
    expect(pl.time).toBeCloseTo(0.5, 9);
  });
});

describe('event sounds', () => {
  it('an event without a sound, or with a sound nobody loaded, plays nothing', () => {
    const defs = [
      { id: 'a', name: 'a', int: 0, float: 0, string: '' },
      { id: 'b', name: 'b', int: 0, float: 0, string: '', audio: 'sfx/none.ogg' },
    ];
    expect(playEventSound(defs, { time: 0, event: 'a' })).toBe(false);
    expect(playEventSound(defs, { time: 0, event: 'b' })).toBe(false);
    expect(playEventSound(defs, { time: 0, event: 'zz' })).toBe(false);
    expect(hasSound('sfx/none.ogg')).toBe(false);
  });
});

describe('sound names', () => {
  it('folders, extension and case do not count', () => {
    expect(soundKey('sfx/Step.OGG')).toBe('step');
    expect(soundKey('C:\\sounds\\step.wav')).toBe('step');
    expect(soundKey('step')).toBe('step');
  });
});

describe('mix table in the store', () => {
  let ids: [string, string];
  beforeEach(() => {
    const { p, a, b } = build();
    docStore.replace(p);
    ids = [a.id, b.id];
  });
  it('is kept in the project, stays valid, and forgets a deleted animation', () => {
    setDefaultMix(0.2);
    setMixPair(ids[0], ids[1], 0.7);
    expect(docStore.get().mixes).toEqual({ default: 0.2, pairs: [{ from: ids[0], to: ids[1], time: 0.7 }] });
    expect(validateProject(docStore.get())).toEqual([]);
    deleteAnimation(ids[1]);
    expect(docStore.get().mixes).toEqual({ default: 0.2, pairs: [] });
    expect(validateProject(docStore.get())).toEqual([]);
    setDefaultMix(0);
    expect(docStore.get().mixes).toBeUndefined();
  });
  it('a damaged table is repaired when a project opens', () => {
    const p = structuredClone(docStore.get());
    p.mixes = { default: 0, pairs: [{ from: ids[0], to: 'gone', time: 1 }] };
    expect(validateProject(p)).toContain('the mix table was repaired');
  });
});
