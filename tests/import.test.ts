/**
 * Spine JSON import. The strongest check is the round trip: our own export, imported again and exported again,
 * must be byte-for-byte the same JSON — and the imported rig must still agree with the official runtime.
 */
import { describe, expect, it } from 'vitest';
import { packAtlas, writeAtlas } from '../src/core/export/atlas';
import { exportSpineJson } from '../src/core/export/spineJson';
import { parseAtlas } from '../src/core/import/atlas';
import { importSpineJson } from '../src/core/import/spineJson';
import { attachmentImage } from '../src/core/model';
import { validateProject } from '../src/core/validate';
import { buildFixture } from './fixture';
import { parityMismatch } from './fuzzkit';
import { exportAndLoad } from './official';

/** Path of the first difference between two JSON trees (readable failure messages for the round trip). */
function firstDiff(a: unknown, b: unknown, path: string): string | null {
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  if (a && b && typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return a === b ? null : `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

describe('Spine JSON import: round trip', () => {
  const f = buildFixture();
  const json = exportSpineJson(f.project.skeleton);
  const { project, warnings } = importSpineJson(JSON.parse(JSON.stringify(json)), 'roundtrip');

  it('imports our own export without warnings', () => {
    expect(warnings).toEqual([]);
    expect(project.skeleton.bones.length).toBe(f.project.skeleton.bones.length);
    expect(project.skeleton.slots.length).toBe(f.project.skeleton.slots.length);
    expect(project.skeleton.constraints.map((c) => c.type)).toEqual(f.project.skeleton.constraints.map((c) => c.type));
    expect(project.skeleton.animations.map((a) => a.name)).toEqual(['walk', 'pose', 'pose2']);
    expect(project.skeleton.skins.map((s) => s.name)).toEqual(['default', 'alt']);
  });

  it('export -> import -> export is identical', () => {
    const again = JSON.parse(JSON.stringify(exportSpineJson(project.skeleton)));
    const original = JSON.parse(JSON.stringify(json));
    // (the hash covers the content, so it differs exactly when something else does)
    delete again.skeleton.hash;
    delete original.skeleton.hash;
    expect(firstDiff(original, again, 'json')).toBeNull();
    expect(again).toEqual(original);
  });

  it('the imported document is healthy', () => {
    expect(validateProject(project)).toEqual([]);
  });

  it('the imported rig loads in the official runtime and our solver agrees with it', () => {
    expect(() => exportAndLoad(project)).not.toThrow();
    expect(parityMismatch(project)).toBeNull();
  });

  it('keeps sliders, their driver mapping and their timelines', () => {
    const sliders = project.skeleton.constraints.filter((c) => c.type === 'slider');
    expect(sliders.map((c) => c.name)).toEqual(['pose slider', 'loop slider', 'manual slider']);
    const a = sliders[0];
    if (a.type !== 'slider') throw new Error('not a slider');
    expect(project.skeleton.animations.find((x) => x.id === a.animation)?.name).toBe('pose');
    expect(a.property).toBe('x');
    expect(a.scale).toBeCloseTo(0.006, 7);
    const walk = project.skeleton.animations[0];
    const manual = sliders[2];
    expect(walk.slider[manual.id].time?.map((k) => k.time)).toEqual([0, 0.6, 1.2]);
  });
});

describe('atlas parser', () => {
  it('reads what our own atlas writer produces', () => {
    const images = [
      { name: 'body', width: 64, height: 64 },
      { name: 'parts/head', width: 33, height: 20 },
      { name: 'flag', width: 30, height: 30 },
    ];
    const pages = packAtlas(images, { maxSize: 256, padding: 2 });
    const parsed = parseAtlas(writeAtlas(pages, (i) => `atlas${i}.png`));
    expect(parsed.length).toBe(pages.length);
    expect(parsed.flatMap((p) => p.regions.map((r) => r.name)).sort()).toEqual(['body', 'flag', 'parts/head']);
    const head = parsed.flatMap((p) => p.regions).find((r) => r.name === 'parts/head')!;
    expect([head.width, head.height, head.originalWidth, head.originalHeight, head.rotate]).toEqual([33, 20, 33, 20, 0]);
    expect(parsed[0].width).toBe(pages[0].width);
    expect(parsed[0].file).toBe('atlas0.png');
  });

  it('reads trimmed and rotated regions and the older xy/size format', () => {
    const text = [
      'skin.png',
      'size: 512, 256',
      'format: RGBA8888',
      'filter: Linear, Linear',
      'pma: true',
      'hand',
      'bounds:10,20,30,40',
      'offsets:2,3,34,45',
      'rotate:90',
      'old',
      'rotate: false',
      'xy: 5, 6',
      'size: 7, 8',
      'orig: 9, 10',
      'offset: 1, 2',
      '',
      'second.png',
      'size:64,64',
      'x',
      'bounds:0,0,8,8',
    ].join('\n');
    const pages = parseAtlas(text);
    expect(pages.map((p) => p.file)).toEqual(['skin.png', 'second.png']);
    expect(pages[0].pma).toBe(true);
    const [hand, old] = pages[0].regions;
    expect(hand).toMatchObject({
      name: 'hand',
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      offsetX: 2,
      offsetY: 3,
      originalWidth: 34,
      originalHeight: 45,
      rotate: 90,
    });
    expect(old).toMatchObject({
      name: 'old',
      x: 5,
      y: 6,
      width: 7,
      height: 8,
      offsetX: 1,
      offsetY: 2,
      originalWidth: 9,
      originalHeight: 10,
      rotate: 0,
    });
    expect(pages[1].regions[0].originalWidth).toBe(8); // untrimmed: the original size defaults to the region size
  });
});

describe('Spine JSON import: files made by Spine itself', () => {
  // Hand written in the style of a 4.3 export: defaults omitted, separate axis timelines, draw order offsets, extras Bone 2D lacks.
  const spine = {
    skeleton: { hash: 'x', spine: '4.3.20', x: 0, y: 0, width: 10, height: 10, fps: 24 },
    bones: [
      { name: 'root' },
      { name: 'hip', parent: 'root', length: 20, y: 10, transform: 'onlyTranslation', color: '3a7bd5ff' },
      { name: 'arm', parent: 'hip', length: 30, x: 20, rotation: 15, skin: true },
      { name: 'ghost', parent: 'missing-bone' },
    ],
    slots: [
      { name: 'body', bone: 'hip', attachment: 'body' },
      { name: 'arm', bone: 'arm', color: 'ff8000cc', dark: '102030', blend: 'additive' },
      { name: 'lost', bone: 'nowhere' },
    ],
    constraints: [
      { name: 'arm ik', type: 'ik', bones: ['arm'], target: 'root', bendPositive: false },
      {
        name: 'rot',
        type: 'transform',
        bones: ['arm'],
        source: 'hip',
        properties: { rotate: { offset: 5, to: { rotate: { scale: -1 } } } },
        mixRotate: 0.5,
      },
      { name: 'springy', type: 'wobble', bone: 'arm' }, // a constraint type nobody knows
      { name: 'swing', type: 'slider', animation: 'swing pose', bone: 'hip', property: 'rotate', from: 0, to: 0, scale: 0.01, loop: true },
    ],
    skins: [
      {
        name: 'default',
        attachments: {
          body: {
            body: { name: 'body', width: 40, height: 30 },
            hat: {
              type: 'mesh',
              uvs: [0, 0, 1, 0, 1, 1, 0, 1],
              triangles: [0, 1, 2, 0, 2, 3],
              vertices: [0, 0, 20, 0, 20, 20, 0, 20],
              hull: 4,
              width: 20,
              height: 20,
            },
            hatLinked: { type: 'linkedmesh', parent: 'hat', path: 'hat2' },
            box: { type: 'boundingbox', vertexCount: 3, vertices: [0, 0, 1, 0, 1, 1] },
          },
          arm: {
            // weighted: per vertex [count, (bone index, x, y, weight)*] — vertex 1 is shared by the "hip" (1) and "arm" (2) bones
            arm: {
              type: 'mesh',
              uvs: [0, 0, 1, 0, 0.5, 1],
              triangles: [0, 1, 2],
              vertices: [1, 1, 0, 0, 1, 2, 1, 0, 0, 0.4, 2, 5, 5, 0.6, 1, 2, 1, 1, 1],
              hull: 3,
              width: 8,
              height: 8,
            },
          },
        },
      },
      {
        name: 'dark',
        bones: ['arm'],
        ik: ['arm ik'],
        transform: ['rot'],
        attachments: { body: { body: { name: 'body', path: 'body-dark', width: 40, height: 30 } } },
      },
    ],
    events: { footstep: { int: 2, string: 'step', audio: 'step.ogg' } },
    animations: {
      'swing pose': { bones: { arm: { rotate: [{ value: 0 }, { time: 1, value: 40, curve: [0.25, 0, 0.75, 40] }] } } },
      walk: {
        bones: {
          hip: {
            translatex: [{ value: 0 }, { time: 0.5, value: 12, curve: 'stepped' }, { time: 1, value: 0 }],
            scale: [
              { x: 1, y: 1 },
              { time: 1, x: 1.1, y: 0.9 },
            ],
          },
        },
        slots: {
          arm: {
            rgba: [
              { color: 'ffffffff', curve: [0.3, 1, 0.6, 0.5, 0.3, 1, 0.6, 0.5, 0.3, 1, 0.6, 0.5, 0.3, 1, 0.6, 0.5] },
              { time: 1, color: '00ff0080' },
            ],
            attachment: [{ name: 'arm' }, { time: 0.7 }],
          },
        },
        ik: { 'arm ik': [{ mix: 0.5, bendPositive: false }, { time: 1 }] },
        transform: { rot: [{ mixRotate: 0.2 }, { time: 1 }] },
        slider: { swing: { mix: [{ value: 0.5 }, { time: 1, value: 1 }] } },
        attachments: { default: { body: { arm: { deform: [{}, { time: 1, offset: 1, vertices: [3, 4] }] } } } },
        drawOrder: [{ time: 0.4, offsets: [{ slot: 'body', offset: 1 }] }],
        events: [
          { time: 0.5, name: 'footstep', int: 5 },
          { time: 0.6, name: 'unknown' },
        ],
      },
    },
  };

  const result = importSpineJson(JSON.parse(JSON.stringify(spine)), 'hand-written');
  const d = result.project.skeleton;

  it('imports the supported content and reports what it could not use', () => {
    const w = result.warnings.join('\n');
    expect(w).toContain('wobble constraint "springy"');
    expect(w).not.toContain('boundingbox attachment'); // bounding boxes are imported now
    expect(w).toContain('slot "lost" was skipped');
    expect(w).not.toContain('translatex'); // the split axes are kept as they are now
    const walkTl = d.animations.find((a) => a.name === 'walk')!.bones[d.bones[1].id];
    expect(walkTl.translatex?.map((k) => k.value[0])).toEqual([0, 12, 0]);
    expect(walkTl.translatex?.[1].curve).toBe('stepped');
    expect(walkTl.translate).toBeUndefined();
    expect(w).not.toContain('audio'); // sounds are kept now
    expect(d.events.find((e) => e.name === 'footstep')?.audio).toBe('step.ogg');
    expect(d.bones.map((b) => b.name)).toEqual(['root', 'hip', 'arm', 'ghost']);
    expect(d.fps).toBe(24);
    expect(d.slots.map((s) => s.name)).toEqual(['body', 'arm']);
  });

  it('reads bones, slots and constraints with Spine defaults', () => {
    expect(d.bones[1].inherit).toBe('onlyTranslation'); // the legacy "transform" key
    expect(d.bones[2].skinRequired).toBe(true);
    expect(d.bones[3].parent).toBeNull(); // the parent did not exist
    expect(d.slots[1].dark).not.toBeNull();
    expect(d.slots[1].blend).toBe('additive');
    const rot = d.constraints.find((c) => c.name === 'rot');
    expect(rot?.type === 'transform' && rot.mix.rotate).toBe(0.5);
    expect(rot?.type === 'transform' && rot.properties[0].to[0].max).toBe(1); // the Spine default
    const ik = d.constraints.find((c) => c.name === 'arm ik');
    expect(ik?.type === 'ik' && ik.bendPositive).toBe(false);
  });

  it('turns weighted vertices, linked meshes and skins into Bone 2D structures', () => {
    const arm = d.skins[0].attachments[d.slots[1].id].arm;
    expect(arm.type).toBe('mesh');
    if (arm.type !== 'mesh') return;
    expect(arm.weights?.map((l) => l.length)).toEqual([1, 2, 1]);
    expect(arm.weights![1].map((i) => d.bones.find((b) => b.id === i[0])!.name)).toEqual(['hip', 'arm']);
    expect(arm.weights![1].map((i) => i[3])).toEqual([0.4, 0.6]);
    const body = d.skins[0].attachments[d.slots[0].id];
    expect(body.hatLinked.type).toBe('mesh');
    expect(attachmentImage(body.hatLinked)).toBe('hat2');
    expect(body.hatLinked.type === 'mesh' && body.hatLinked.link).toEqual({ source: 'hat', slot: null, skin: null, deform: true }); // the link is kept
    expect(body.box.type).toBe('boundingbox');
    if (body.box.type === 'boundingbox') expect(body.box.vertices).toEqual([0, 0, 1, 0, 1, 1]);
    expect(d.skins[1].name).toBe('dark');
    expect(d.skins[1].constraints.length).toBe(2);
    expect(d.skins[1].bones.length).toBe(1);
  });

  it('keeps curves, draw order offsets, events and sliders', () => {
    const walk = d.animations.find((a) => a.name === 'walk')!;
    const hipKeys = walk.bones[d.bones[1].id].translatex!;
    expect(hipKeys.map((k) => k.value[0])).toEqual([0, 12, 0]);
    expect(hipKeys[1].curve).toBe('stepped');
    expect(walk.drawOrder[0].order.map((id) => d.slots.find((s) => s.id === id)!.name)).toEqual(['arm', 'body']); // "body" moved one up the list
    expect(walk.events.length).toBe(1); // the unknown event was dropped
    expect(walk.events[0].int).toBe(5);
    const swing = d.constraints.find((c) => c.name === 'swing');
    expect(swing?.type === 'slider' && d.animations.find((a) => a.id === swing.animation)?.name).toBe('swing pose');
    expect(walk.slider[swing!.id].mix?.map((k) => k.value[0])).toEqual([0.5, 1]);
  });

  it('produces a healthy document that exports and loads in the official runtime', () => {
    expect(validateProject(result.project)).toEqual([]);
    expect(() => exportAndLoad(result.project)).not.toThrow();
  });

  it('rejects files that are not skeletons', () => {
    expect(() => importSpineJson({ hello: 1 })).toThrow(/Not a Spine skeleton/);
    expect(() => importSpineJson(null)).toThrow();
  });
});
