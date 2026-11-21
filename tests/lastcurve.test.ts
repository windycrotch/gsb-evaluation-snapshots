/** "Last chosen" interpolation: a new key starts with the curve that was set last on a key (Settings → New keys use the last chosen interpolation). */
import { afterEach, describe, expect, it } from 'vitest';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { DEFAULT_SETTINGS, readSettings, setSettings } from '../src/store/settings';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';

afterEach(() => {
  setSettings({ lastChosenCurve: false });
  uiStore.patch({ defaultCurve: 'bezier' });
});

function session() {
  const f = buildFixture();
  docStore.replace(f.project);
  const anim = f.project.skeleton.animations.find((a) => a.name === 'walk')!;
  const bone = f.project.skeleton.bones[1];
  uiStore.patch({
    mode: 'animate',
    animationId: anim.id,
    selection: { ...emptySelection, bones: [bone.id] },
    overrides: {},
    time: 0,
    playing: false,
    autoKey: false,
    defaultCurve: 'bezier',
  });
  const rotate = () => docStore.get().skeleton.animations.find((a) => a.id === anim.id)!.bones[bone.id].rotate ?? [];
  const ref = (time: number) => ({ kind: 'bone' as const, target: bone.id, prop: 'rotate', time });
  return { anim, bone, rotate, ref };
}

/** Keys the rotation of the selected bone at `time` (a time with no key yet) and returns the new key. */
function keyAt(time: number, rotate: () => { time: number; curve?: unknown }[]) {
  A.setTime(time);
  A.keySelectedBones(['rotate']);
  return rotate().find((k) => Math.abs(k.time - time) < 1e-4)!;
}

describe('the setting', () => {
  it('is off by default and read back only as a boolean', () => {
    expect(DEFAULT_SETTINGS.lastChosenCurve).toBe(false);
    expect(readSettings(JSON.stringify({ lastChosenCurve: true })).lastChosenCurve).toBe(true);
    expect(readSettings(JSON.stringify({ lastChosenCurve: 'yes' })).lastChosenCurve).toBe(false);
  });
});

describe('new keys', () => {
  it('keep the timeline default when the setting is off', () => {
    const { rotate, ref } = session();
    const first = rotate()[0];
    A.setKeysCurve([ref(first.time)], 'stepped');
    expect(uiStore.get().defaultCurve).toBe('bezier');
    const k = keyAt(0.3, rotate);
    expect(Array.isArray(k.curve)).toBe(true); // smooth, as the timeline says
  });

  it('start with the interpolation chosen last when it is on', () => {
    const { rotate, ref } = session();
    setSettings({ lastChosenCurve: true });
    const first = rotate()[0];
    A.setKeysCurve([ref(first.time)], 'stepped');
    expect(uiStore.get().defaultCurve).toBe('stepped');
    expect(keyAt(0.3, rotate).curve).toBe('stepped');
    A.setKeysCurve([ref(first.time)], 'linear');
    expect(uiStore.get().defaultCurve).toBe('linear');
    expect(keyAt(0.5, rotate).curve).toBeUndefined();
    A.setKeysCurve([ref(first.time)], [0.2, 0, 0.8, 1]); // a custom curve counts as smooth
    expect(uiStore.get().defaultCurve).toBe('bezier');
    expect(Array.isArray(keyAt(0.9, rotate).curve)).toBe(true);
  });
});
