/** Keys between frames: the time step of the editor (Settings → Key time step) and what follows from it. */
import { afterEach, describe, expect, it } from 'vitest';
import { keyGrid, keyStep, snapTime } from '../src/core/edit';
import { exportSpineJson } from '../src/core/export/spineJson';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { DEFAULT_SETTINGS, readSettings, setSettings, settingsStore } from '../src/store/settings';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';
import { exportAndLoad } from './official';

afterEach(() => setSettings({ keyGrid: 1 }));

describe('snapTime', () => {
  it('snaps to whole frames by default', () => {
    expect(keyGrid.steps).toBe(1);
    expect(snapTime(0.1234, 30)).toBeCloseTo(4 / 30, 10);
    expect(snapTime(-1, 30)).toBe(0);
  });
  it('snaps to a finer step when asked, per call or from the setting', () => {
    expect(snapTime(0.1234, 30, 4)).toBeCloseTo(15 / 120, 10); // a quarter of a frame
    expect(snapTime(0.1234, 30, 10)).toBeCloseTo(37 / 300, 10);
    expect(keyStep(30, 2)).toBeCloseTo(1 / 60, 12);
    setSettings({ keyGrid: 4 });
    expect(keyGrid.steps).toBe(4);
    expect(snapTime(0.1234, 30)).toBeCloseTo(15 / 120, 10);
    setSettings({ keyGrid: 1 });
    expect(snapTime(0.1234, 30)).toBeCloseTo(4 / 30, 10);
  });
});

describe('the setting', () => {
  it('is 1, 2, 4 or 10 and nothing else', () => {
    expect(DEFAULT_SETTINGS.keyGrid).toBe(1);
    for (const v of [1, 2, 4, 10]) expect(readSettings(JSON.stringify({ keyGrid: v })).keyGrid).toBe(v);
    for (const v of [0, 3, 100, -1, 'x', null]) expect(readSettings(JSON.stringify({ keyGrid: v })).keyGrid).toBe(1);
    expect(settingsStore.get().keyGrid).toBe(1);
  });
});

describe('keys between frames', () => {
  function session() {
    const f = buildFixture();
    docStore.replace(f.project);
    const anim = f.project.skeleton.animations.find((a) => a.name === 'walk')!;
    uiStore.patch({
      mode: 'animate',
      animationId: anim.id,
      selection: emptySelection,
      overrides: {},
      time: 0,
      playing: false,
      autoKey: true,
    });
    return { project: f.project, anim, bone: f.project.skeleton.bones[1] };
  }

  it('the playhead and new keys follow the step', () => {
    session();
    setSettings({ keyGrid: 4 });
    A.setTime(0.2);
    expect(uiStore.get().time).toBeCloseTo(0.2, 6); // 6 / 30 is on the grid
    A.setTime(0.2041);
    expect(uiStore.get().time).toBeCloseTo(0.2, 6);
    A.setTime(0.2084);
    expect(uiStore.get().time).toBeCloseTo(25 / 120, 6);
    setSettings({ keyGrid: 1 });
    A.setTime(0.2084);
    expect(uiStore.get().time).toBeCloseTo(6 / 30, 6);
  });

  it('a key can be moved by a fraction of a frame and the export keeps it', () => {
    const { anim, bone } = session();
    const refs = (anim.bones[bone.id]?.rotate ?? []).map((k) => ({ kind: 'bone' as const, target: bone.id, prop: 'rotate', time: k.time }));
    expect(refs.length).toBeGreaterThan(1);
    const second = refs[1];
    const moved = A.moveKeysBy([second], 1 / 60); // half a frame at 30 fps
    expect(moved[0].time).toBeCloseTo(second.time + 1 / 60, 6);
    const now = docStore.get().skeleton.animations.find((a) => a.id === anim.id)!;
    expect(now.bones[bone.id].rotate!.some((k) => Math.abs(k.time - (second.time + 1 / 60)) < 1e-6)).toBe(true);
    const json = exportSpineJson(docStore.get().skeleton) as {
      animations: Record<string, { bones: Record<string, { rotate: { time?: number }[] }> }>;
    };
    const times = json.animations.walk.bones[bone.name].rotate.map((k) => k.time ?? 0);
    expect(times.some((t) => Math.abs(t - (second.time + 1 / 60)) < 1e-4)).toBe(true);
    expect(() => exportAndLoad(docStore.get())).not.toThrow();
  });
});
