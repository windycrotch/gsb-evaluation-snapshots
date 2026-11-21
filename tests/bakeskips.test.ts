/** bakeSkips: the path constraints whose bones a bake cannot carry (their slot shows no path), and the bake message that names them. */
import { beforeEach, describe, expect, it } from 'vitest';
import { bakeSkips } from '../src/core/bake';
import type { PathConstraint, SkeletonDoc } from '../src/core/model';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';
import { addPathRig } from './pathrig';

const pathOf = (doc: SkeletonDoc): PathConstraint => doc.constraints.find((x): x is PathConstraint => x.type === 'path')!;

function rig() {
  const { project } = buildFixture();
  const r = addPathRig(project);
  const doc = project.skeleton;
  const anim = doc.animations[0];
  return { project, doc, anim, r };
}

describe('bakeSkips', () => {
  it('names a constraint whose slot has no attachment', () => {
    const { doc, anim } = rig();
    const c = pathOf(doc);
    doc.slots.find((s) => s.id === c.target)!.attachment = null;
    expect(bakeSkips(doc, anim)).toContain(c.name);
  });

  it('names a constraint whose slot is switched off by an attachment key', () => {
    const { doc, anim } = rig();
    const c = pathOf(doc);
    const slot = doc.slots.find((s) => s.id === c.target)!;
    const keep = slot.attachment!;
    slot.attachment = keep;
    anim.slots[c.target] = {
      ...(anim.slots[c.target] ?? {}),
      attachment: [
        { time: 0, name: keep },
        { time: 0.5, name: null },
      ],
    };
    expect(bakeSkips(doc, anim)).toContain(c.name);
  });

  it('names a constraint whose slot shows a mesh (not a path)', () => {
    const { doc, anim } = rig();
    const c = pathOf(doc);
    const meshSlot = doc.slots.find((s) => Object.values(doc.skins[0].attachments[s.id] ?? {}).some((a) => a.type === 'mesh'))!;
    const name = Object.keys(doc.skins[0].attachments[meshSlot.id]).find((n) => doc.skins[0].attachments[meshSlot.id][n].type === 'mesh')!;
    c.target = meshSlot.id;
    meshSlot.attachment = name;
    expect(bakeSkips(doc, anim)).toContain(c.name);
  });
});

describe('the bake message', () => {
  beforeEach(() => uiStore.patch({ toast: null }));

  it('warns when a path constraint has no path, and just reports the bake otherwise', () => {
    const { project, doc, anim } = rig();
    const c = pathOf(doc);
    doc.slots.find((s) => s.id === c.target)!.attachment = null;
    docStore.replace(project);
    uiStore.patch({ mode: 'animate', animationId: anim.id });
    A.bakeCurrentAnimation({});
    expect(uiStore.get().toast?.text).toContain(`path constraint "${c.name}"`);
  });
});
