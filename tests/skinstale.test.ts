/** Timelines a skin made for an attachment do not outlive the attachment that replaces it. */
import { describe, expect, it } from 'vitest';
import { putSkinImage } from '../src/core/skinImages';
import { uid } from '../src/core/ids';
import type { Skin } from '../src/core/model';
import { buildFixture } from './fixture';

describe('putSkinImage', () => {
  it('drops the deform keys the skin had for the attachment it replaces', () => {
    const f = buildFixture();
    const doc = f.project.skeleton;
    let slotId = '';
    let name = '';
    for (const slot of doc.slots) {
      for (const a of Object.values(doc.skins[0].attachments[slot.id] ?? {})) {
        if (a.type === 'mesh' && !a.link && !slotId) {
          slotId = slot.id;
          name = a.name;
        }
      }
    }
    expect(slotId).not.toBe('');
    const skin: Skin = {
      id: uid(),
      name: 'red',
      attachments: { [slotId]: { [name]: structuredClone(doc.skins[0].attachments[slotId][name]) } },
      bones: [],
      constraints: [],
    };
    doc.skins.push(skin);
    const anim = doc.animations[0];
    ((anim.deform[skin.id] ??= {})[slotId] ??= {})[name] = [{ time: 0, value: [1, 2, 3] }] as never;
    const img = f.project.images[0];
    expect(putSkinImage(doc, skin.id, slotId, name, img)).toBe(true);
    expect(anim.deform[skin.id]?.[slotId]?.[name]).toBeUndefined();
    // the attachment is the linked mesh now
    const now = skin.attachments[slotId][name];
    expect(now.type === 'mesh' && !!now.link).toBe(true);
  });

  it('leaves the timelines of other skins and attachments alone', () => {
    const f = buildFixture();
    const doc = f.project.skeleton;
    const slot = doc.slots[0];
    const placeholder = Object.keys(doc.skins[0].attachments[slot.id] ?? {})[0];
    const other: Skin = { id: uid(), name: 'other', attachments: {}, bones: [], constraints: [] };
    const skin: Skin = { id: uid(), name: 'red', attachments: {}, bones: [], constraints: [] };
    doc.skins.push(other, skin);
    const anim = doc.animations[0];
    const keys = [{ time: 0, value: [1, 2] }] as never;
    ((anim.deform[other.id] ??= {})[slot.id] ??= {})[placeholder] = keys;
    putSkinImage(doc, skin.id, slot.id, placeholder, f.project.images[0]);
    expect(anim.deform[other.id][slot.id][placeholder]).toBe(keys);
  });
});
