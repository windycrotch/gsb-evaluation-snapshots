/** Key Edited: only the channels that were changed get a key; with nothing pending it keys everything of the selected bones. */
import { beforeEach, describe, expect, it } from 'vitest';
import { validateProject } from '../src/core/validate';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';

const doc = () => docStore.get().skeleton;
const walk = () => doc().animations.find((a) => a.name === 'walk')!;

describe('key edited', () => {
  let bone = '';
  beforeEach(() => {
    const f = buildFixture();
    docStore.replace(f.project);
    bone = f.project.skeleton.bones[1].id;
    uiStore.patch({
      mode: 'animate',
      tool: 'select',
      animationId: walk().id,
      skinId: null,
      time: 0.123,
      selection: { ...emptySelection, bones: [bone] },
      overrides: {},
      autoKey: false,
      playing: false,
    });
  });
  const keysAt = (prop: 'rotate' | 'translate' | 'scale' | 'shear') =>
    (walk().bones[bone]?.[prop] ?? []).filter((k) => Math.abs(k.time - 0.123) < 1e-6);

  it('keys only the rotation after a rotation edit, then clears the pending pose', () => {
    A.setBonePose([{ id: bone, props: { rotation: 33 } }]);
    expect(Object.keys(uiStore.get().overrides)).toEqual([bone]);
    expect(A.editedChannels(uiStore.get().overrides[bone])).toEqual(new Set(['rotate']));
    A.setBonePose([{ id: bone, props: { x: 3 } }]);
    expect(A.editedChannels(uiStore.get().overrides[bone])).toEqual(new Set(['rotate', 'translatex'])); // the axis that was edited
    uiStore.patch({ overrides: { [bone]: { rotation: 33 } } });
    A.keyEditedBones();
    expect(keysAt('rotate')).toHaveLength(1);
    expect(keysAt('translate')).toHaveLength(0);
    expect(keysAt('scale')).toHaveLength(0);
    expect(keysAt('shear')).toHaveLength(0);
    expect(uiStore.get().overrides).toEqual({});
    expect(validateProject(docStore.get())).toEqual([]);
  });

  it('a move and a scale edit key translate and scale, not rotate', () => {
    A.setBonePose([{ id: bone, props: { x: 5, scaleX: 2 } }]);
    A.keyEditedBones();
    expect(keysAt('translate')).toHaveLength(1);
    expect(keysAt('scale')).toHaveLength(1);
    expect(keysAt('rotate')).toHaveLength(0);
  });

  it('with nothing pending every channel of the selected bone is keyed', () => {
    A.keyEditedBones();
    for (const p of ['rotate', 'translate', 'scale', 'shear'] as const) expect(keysAt(p)).toHaveLength(1);
  });

  it('is one history step', () => {
    A.setBonePose([{ id: bone, props: { rotation: 10 } }]);
    const before = docStore.get();
    A.keyEditedBones();
    docStore.undo();
    expect(docStore.get()).toEqual(before);
  });
});
