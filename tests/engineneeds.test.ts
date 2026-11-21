/** What an export asks of the engine: read from the features the skeleton uses and the settings of the export. */
import { describe, expect, it } from 'vitest';
import { ENGINE_NEED_TEXTS, engineNeeds } from '../src/core/export/engineNeeds';
import { emptyProject } from '../src/core/model';
import type { Attachment } from '../src/core/model';
import { RU } from '../src/i18n/ru';
import { buildFixture } from './fixture';
import { addPhysicsRig } from './physicsrig';

const ids = (needs: { id: string }[]) => needs.map((n) => n.id);

/** A fixture skeleton with the features that ask nothing of the engine taken away, so one feature at a time can be added. */
function plain() {
  const f = buildFixture();
  const doc = f.project.skeleton;
  for (const s of doc.slots) {
    s.dark = null;
    s.blend = 'normal';
  }
  doc.constraints = doc.constraints.filter((c) => c.type === 'ik' || c.type === 'transform');
  for (const skin of doc.skins)
    for (const slotId of Object.keys(skin.attachments))
      for (const [name, a] of Object.entries(skin.attachments[slotId]))
        if (a.type === 'clipping' || ((a.type === 'region' || a.type === 'mesh') && a.sequence)) delete skin.attachments[slotId][name];
  for (const a of doc.animations) delete a.drawOrderFolder;
  doc.events.forEach((e) => delete e.audio);
  for (const skin of doc.skins)
    for (const slotId of Object.keys(skin.attachments))
      for (const a of Object.values(skin.attachments[slotId])) if (a.type === 'mesh') delete a.link;
  return f;
}

describe('engineNeeds', () => {
  it('asks only for the version of an empty skeleton', () => {
    expect(ids(engineNeeds(emptyProject().skeleton))).toEqual(['version']);
    expect(ids(engineNeeds(plain().project.skeleton, {}))).toEqual(['version']);
  });

  it('notes the settings of the export that the engine has to match', () => {
    const doc = plain().project.skeleton;
    expect(ids(engineNeeds(doc, { format: 'binary', scale: 0.5, pma: true, filter: 'Nearest', rotate: true }))).toEqual([
      'version',
      'binary',
      'scale',
      'pma',
      'nearest',
      'rotate',
    ]);
    expect(ids(engineNeeds(doc, { format: 'json', scale: 1, pma: false, filter: 'Linear', rotate: false }))).toEqual(['version']);
    expect(engineNeeds(doc, { pma: true }).every((n) => n.level === 'note')).toBe(true);
  });

  it('finds the colour and blend features in the slots', () => {
    const doc = plain().project.skeleton;
    doc.slots[0].dark = [0, 0, 0];
    expect(ids(engineNeeds(doc))).toContain('twoColor');
    expect(ids(engineNeeds(doc))).not.toContain('blend');
    doc.slots[1].blend = 'additive';
    const needs = engineNeeds(doc);
    expect(ids(needs)).toContain('blend');
    expect(needs.find((n) => n.id === 'blend')!.level).toBe('needs');
  });

  it('finds clipping, and inverse clipping on top of it', () => {
    const doc = plain().project.skeleton;
    const slot = doc.slots[0];
    const clip = (inverse: boolean): Attachment => ({
      type: 'clipping',
      name: 'c',
      color: [1, 1, 1, 1],
      vertices: [0, 0, 1, 0, 1, 1],
      weights: null,
      end: null,
      convex: false,
      inverse,
    });
    doc.skins[0].attachments[slot.id] = { ...doc.skins[0].attachments[slot.id], c: clip(false) };
    expect(ids(engineNeeds(doc))).toContain('clipping');
    expect(ids(engineNeeds(doc))).not.toContain('inverse');
    doc.skins[0].attachments[slot.id].c = clip(true);
    expect(ids(engineNeeds(doc))).toEqual(expect.arrayContaining(['clipping', 'inverse']));
  });

  it('finds physics and sliders among the constraints', () => {
    const f = plain();
    addPhysicsRig(f.project);
    expect(ids(engineNeeds(f.project.skeleton))).toContain('physics');
    const g = plain();
    g.project.skeleton.constraints.push({ id: 's1', type: 'slider', name: 's' } as never);
    expect(ids(engineNeeds(g.project.skeleton))).toContain('slider');
  });

  it('finds sequences, draw order folders, a linked mesh in another slot and events with audio', () => {
    const doc = plain().project.skeleton;
    const region = Object.values(doc.skins[0].attachments)
      .flatMap((m) => Object.values(m))
      .find((a) => a.type === 'region');
    if (region?.type === 'region') region.sequence = { count: 2, start: 0, digits: 0, setupIndex: 0 };
    doc.animations[0].drawOrderFolder = { f1: [{ time: 0, order: [] }] };
    doc.events.push({ id: 'e1', name: 'step', int: 0, float: 0, string: '', audio: 'step.wav' });
    const mesh = Object.entries(doc.skins[0].attachments)
      .flatMap(([slotId, m]) => Object.values(m).map((a) => ({ slotId, a })))
      .find((x) => x.a.type === 'mesh' && !x.a.link);
    if (mesh?.a.type === 'mesh') mesh.a.link = { skin: null, source: 'x', slot: 'another slot', deform: false };
    const got = ids(engineNeeds(doc));
    expect(got).toEqual(expect.arrayContaining(['sequence', 'folder', 'audio', 'linked']));
    expect(engineNeeds(doc).find((n) => n.id === 'audio')!.level).toBe('note');
  });

  it('does not report what the skeleton does not use', () => {
    const got = ids(engineNeeds(plain().project.skeleton));
    for (const id of ['twoColor', 'blend', 'clipping', 'inverse', 'physics', 'slider', 'sequence', 'folder', 'linked', 'audio'])
      expect(got).not.toContain(id);
  });
});

describe('the texts', () => {
  it('are all translated into Russian (the dialog shows them as they are)', () => {
    for (const t of ENGINE_NEED_TEXTS) expect(RU[t], t).toBeTruthy();
  });
  it('are written once each', () => {
    expect(new Set(ENGINE_NEED_TEXTS).size).toBe(ENGINE_NEED_TEXTS.length);
  });
});
