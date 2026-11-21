/** The Graph follows the keys selected in the Dopesheet (Dopesheet-centric sync), or the selected bones. */
import { describe, expect, it } from 'vitest';
import { encodeKey } from '../src/core/keyrefs';
import { buildCurves } from '../src/editor/timeline/GraphEditor';
import { emptySelection } from '../src/store/ui';
import { readSettings } from '../src/store/settings';
import { buildFixture } from './fixture';

function rig() {
  const f = buildFixture();
  const doc = f.project.skeleton;
  const anim = doc.animations[0];
  // two bones with a rotate and a translate timeline each
  const [a, b] = doc.bones.slice(1, 3);
  anim.bones = {
    [a.id]: {
      rotate: [
        { time: 0, value: [0] },
        { time: 1, value: [10] },
      ],
      translate: [
        { time: 0, value: [0, 0] },
        { time: 1, value: [5, 5] },
      ],
    },
    [b.id]: {
      rotate: [
        { time: 0, value: [0] },
        { time: 1, value: [20] },
      ],
    },
  };
  return { doc, anim, a, b };
}

const targets = (curves: ReturnType<typeof buildCurves>) => [...new Set(curves.map((c) => `${c.ref.target}|${c.ref.prop}`))];

describe('buildCurves', () => {
  it('Dopesheet-centric: the timeline of a selected key, whatever bones are selected', () => {
    const { doc, anim, a, b } = rig();
    const key = encodeKey({ kind: 'bone', target: b.id, prop: 'rotate', time: 0 });
    const curves = buildCurves(doc, anim, { ...emptySelection, bones: [a.id] }, [key], 'dopesheet');
    expect(targets(curves)).toEqual([`${b.id}|rotate`]);
  });

  it('Dopesheet-centric: with no key selected, the timelines of the selected bones', () => {
    const { doc, anim, a } = rig();
    const curves = buildCurves(doc, anim, { ...emptySelection, bones: [a.id] }, [], 'dopesheet');
    expect(targets(curves).sort()).toEqual([`${a.id}|rotate`, `${a.id}|translate`].sort());
  });

  it('Selection-centric: the selected bones, the selected keys do not change the graph', () => {
    const { doc, anim, a, b } = rig();
    const key = encodeKey({ kind: 'bone', target: b.id, prop: 'rotate', time: 0 });
    const curves = buildCurves(doc, anim, { ...emptySelection, bones: [a.id] }, [key], 'selection');
    expect(targets(curves).sort()).toEqual([`${a.id}|rotate`, `${a.id}|translate`].sort());
    expect(buildCurves(doc, anim, emptySelection, [key], 'selection')).toEqual([]);
  });

  it('is Dopesheet-centric when no mode is given', () => {
    const { doc, anim, a, b } = rig();
    const key = encodeKey({ kind: 'bone', target: b.id, prop: 'rotate', time: 0 });
    expect(targets(buildCurves(doc, anim, { ...emptySelection, bones: [a.id] }, [key]))).toEqual([`${b.id}|rotate`]);
  });
});

describe('the setting', () => {
  it('is one of the two modes', () => {
    expect(readSettings(JSON.stringify({ graphSync: 'selection' })).graphSync).toBe('selection');
    expect(readSettings(JSON.stringify({ graphSync: 'dopesheet' })).graphSync).toBe('dopesheet');
    expect(readSettings(JSON.stringify({ graphSync: 'both' })).graphSync).toBe('dopesheet');
  });
});
