/**
 * The binary reader against files our own writer never makes: Spine writes split translate timelines, separate rgb / alpha, inherit
 * keys, draw order folders, linked meshes, sequences and audio events. The bytes are composed by hand here, the official
 * `SkeletonBinary` reads them, and our reader's JSON — read by the official `SkeletonJson` — must give the same skeleton.
 */
import { describe, expect, it } from 'vitest';
import { packAtlas, writeAtlas } from '../src/core/export/atlas';
import { Out } from '../src/core/export/spineBinary';
import { binaryToJson } from '../src/core/import/spineBinary';
import { importSpineJson } from '../src/core/import/spineJson';
import { diffGraphs } from './binarykit';
import { loadOfficial, loadOfficialBinary } from './official';

const STRINGS = ['slotA', 'slotB', 'body', 'mesh', 'linked', 'sideview'];
const ref = (s: string | null) => (s === null ? 0 : STRINGS.indexOf(s) + 1);

/** One bone, two slots, a region with a sequence, a mesh, a linked mesh, a second skin, an audio event and an animation with the exotic timelines. */
function compose(): Uint8Array {
  const w = new Out();
  w.int32(0x01020304);
  w.int32(0x05060708);
  w.string('4.3.13');
  for (const v of [0, 0, 100, 100, 100]) w.float(v);
  w.bool(false); // no editor-only data
  w.varint(STRINGS.length, true);
  for (const s of STRINGS) w.string(s);

  // bones
  w.varint(1, true);
  w.string('root');
  for (const v of [0, 0, 0, 1, 1, 0, 0]) w.float(v);
  w.byte(0);
  w.float(10);
  w.bool(false);

  // slots
  w.varint(2, true);
  for (const name of ['slotA', 'slotB']) {
    w.string(name);
    w.varint(0, true);
    w.int32(-1);
    w.int32(-1);
    w.varint(name === 'slotA' ? ref('body') : ref(null), true);
    w.varint(0, true);
  }
  w.varint(0, true); // constraints

  // default skin: slotA has a region with a sequence, a mesh and a linked mesh
  w.varint(1, true);
  w.varint(0, true);
  w.varint(3, true);
  w.varint(ref('body'), true);
  w.byte(0 | 64); // region, with a sequence
  w.varint(3, true);
  w.varint(1, true);
  w.varint(2, true);
  w.varint(1, true);
  for (const v of [1, 2, 1, 1, 30, 40]) w.float(v);

  w.varint(ref('mesh'), true);
  w.byte(2); // mesh
  w.varint(4, true); // hull
  w.varint(4, true); // vertices
  for (const v of [0, 0, 10, 0, 10, 10, 0, 10]) w.float(v);
  for (const v of [0, 0, 1, 0, 1, 1, 0, 1]) w.float(v);
  for (const v of [0, 1, 2, 0, 2, 3]) w.varint(v, true);
  w.varint(0, true);

  w.varint(ref('linked'), true);
  w.byte(3 | 16 | 128); // linked mesh with its own path, sharing the source's timelines
  w.varint(ref('sideview'), true);
  w.varint(0, true); // slot of the source
  w.varint(0, true); // skin of the source
  w.varint(ref('mesh'), true);

  w.varint(0, true); // no other skins

  // events: one with audio
  w.varint(1, true);
  w.string('step');
  w.varint(2, false);
  w.float(0.5);
  w.string('boot');
  w.string('step.ogg');
  w.float(0.8);
  w.float(-0.25);

  // animations
  w.varint(1, true);
  w.string('exotic');
  w.varint(0, true); // number of timelines (the reader ignores it)
  // slot timelines: slotA with rgb, alpha, rgb2, attachment
  w.varint(1, true);
  w.varint(0, true);
  w.varint(4, true);
  w.byte(2); // rgb
  w.varint(2, true);
  w.varint(0, true);
  w.float(0);
  for (const b of [255, 128, 0]) w.byte(b);
  w.float(1);
  for (const b of [0, 128, 255]) w.byte(b);
  w.byte(1); // stepped
  w.byte(5); // alpha
  w.varint(2, true);
  w.varint(1, true);
  w.float(0);
  w.byte(255);
  w.float(1);
  w.byte(51);
  w.byte(2); // bezier
  for (const v of [0.25, 0, 0.75, 1]) w.float(v);
  w.byte(4); // rgb2
  w.varint(1, true);
  w.varint(0, true);
  w.float(0.5);
  for (const b of [10, 20, 30, 40, 50, 60]) w.byte(b);
  w.byte(0); // attachment
  w.varint(2, true);
  w.float(0);
  w.varint(ref('body'), true);
  w.float(0.5);
  w.varint(ref(null), true);
  // bone timelines: translateX and an inherit key
  w.varint(1, true);
  w.varint(0, true);
  w.varint(2, true);
  w.byte(2); // translatex
  w.varint(2, true);
  w.varint(0, true);
  w.float(0);
  w.float(1);
  w.float(1);
  w.float(9);
  w.byte(0);
  w.byte(10); // inherit
  w.varint(1, true);
  w.float(0.25);
  w.byte(3);
  for (let i = 0; i < 5; i++) w.varint(0, true); // ik, transform, path, physics, slider
  // sequence timeline of the region
  w.varint(1, true);
  w.varint(0, true);
  w.varint(1, true);
  w.varint(0, true);
  w.varint(1, true);
  w.varint(ref('body'), true);
  w.byte(1);
  w.varint(2, true);
  w.float(0);
  w.int32((1 << 4) | 2); // loop mode, index 1
  w.float(0.1);
  w.float(0.5);
  w.int32((0 << 4) | 3);
  w.float(0.2);
  w.varint(0, true); // draw order
  w.varint(1, true); // a draw order folder of both slots
  w.varint(2, true);
  w.varint(0, true);
  w.varint(1, true);
  w.varint(1, true);
  w.float(0.5);
  w.varint(1, true);
  w.varint(0, true);
  w.varint(1, true);
  w.varint(1, true); // one event key
  w.float(0.75);
  w.varint(0, true);
  w.varint(7, false);
  w.float(1.5);
  w.string(null);
  w.float(0.6);
  w.float(0.1);
  return w.bytes();
}

function atlasText(): string {
  const names = ['body01', 'body02', 'body03', 'mesh', 'sideview'];
  return writeAtlas(
    packAtlas(
      names.map((name) => ({ name, width: 32, height: 32 })),
      { maxSize: 256, padding: 2 },
    ),
    (i) => `a${i}.png`,
  );
}

describe('binary reader on files written the way Spine writes them', () => {
  const bytes = compose();

  it('the official reader accepts the hand-made file', () => {
    const sd = loadOfficialBinary(bytes, atlasText());
    expect(sd.bones.length).toBe(1);
    expect(sd.slots.length).toBe(2);
    expect(sd.animations[0].name).toBe('exotic');
  });

  it('our reader and the official one agree on every field', () => {
    const atlas = atlasText();
    const official = loadOfficialBinary(bytes, atlas);
    const json = binaryToJson(bytes);
    const ours = loadOfficial(json, atlas);
    // (the official binary loader leaves the default 30 fps and empty hull edges when there is no editor-only data)
    const known = /propertyIds|timelineIds|\.hullLength:|\.edges:|^skeleton\.fps:/;
    const diffs = diffGraphs(official, ours, 'skeleton').filter((d) => !known.test(d));
    expect(diffs).toEqual([]);
  });

  it('the JSON has the shapes of the official format', () => {
    const json = binaryToJson(bytes);
    const slotA = json.animations.exotic.slots.slotA;
    expect(slotA.rgb).toHaveLength(2);
    expect(slotA.rgb[0].curve).toBe('stepped');
    expect(slotA.alpha[0].curve).toHaveLength(4);
    expect(slotA.rgb2[0].dark).toBe('28323c');
    expect(json.animations.exotic.bones.root.translatex).toHaveLength(2);
    expect(json.animations.exotic.bones.root.inherit[0].inherit).toBe('noScale');
    expect(json.animations.exotic.drawOrderFolder[0].slots).toEqual(['slotA', 'slotB']);
    expect(json.animations.exotic.attachments.default.slotA.body.sequence[0].mode).toBe('loop');
    expect(json.skins[0].attachments.slotA.linked).toMatchObject({ type: 'linkedmesh', source: 'mesh', parent: 'mesh', path: 'sideview' });
    expect(json.events.step).toMatchObject({ int: 2, string: 'boot', audio: 'step.ogg' });
  });

  it('imports into a project, with the unsupported parts reported', () => {
    const result = importSpineJson(binaryToJson(bytes), 'exotic');
    const skin = result.project.skeleton.skins[0];
    const slotId = result.project.skeleton.slots[0].id;
    const linked = skin.attachments[slotId].linked;
    expect(linked.type).toBe('mesh');
    expect(linked.type === 'mesh' && linked.link?.source).toBeTruthy(); // it keeps the link to its source
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
