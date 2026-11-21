/**
 * Two-color tinting (a dark color next to the light one): import of Spine's `rgba2` / `rgb2` timelines, the validator's rules,
 * and the editor actions that key and remove the dark color. The comparison with the official runtime is in spine-parity.test.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { importSpineJson } from '../src/core/import/spineJson';
import { repairProject, validateProject } from '../src/core/validate';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';
import { exportAndLoad } from './official';

const doc = () => docStore.get().skeleton;
const slot = (name: string) => doc().slots.find((s) => s.name === name)!;
const walk = () => doc().animations.find((a) => a.name === 'walk')!;

function load() {
  const f = buildFixture();
  docStore.replace(f.project);
  uiStore.patch({
    mode: 'setup',
    tool: 'select',
    animationId: f.project.skeleton.animations[0].id,
    skinId: null,
    time: 0,
    selection: emptySelection,
    overrides: {},
    autoKey: true,
    playing: false,
  });
}

function healthy(label: string) {
  const project = docStore.get();
  expect(validateProject(project), `${label}: validator`).toEqual([]);
  expect(() => exportAndLoad(project), `${label}: official loader`).not.toThrow();
}

const hex = (h: string) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

describe('two-color timelines in Spine files', () => {
  const file = (slotTimelines: object, slotDef: object = { name: 'fx', bone: 'root', color: 'ffffffcc', dark: '102030' }) => ({
    skeleton: { spine: '4.3.20', fps: 30 },
    bones: [{ name: 'root' }],
    slots: [slotDef],
    skins: [{ name: 'default', attachments: {} }],
    animations: { a: { slots: { fx: slotTimelines } } },
  });

  it('reads rgba2 keys: light with alpha, dark, curves', () => {
    const r = importSpineJson(
      file({
        rgba2: [
          {
            light: 'ff8040ff',
            dark: '102030',
            curve: [
              0.25, 0.7, 0.75, 0.3, 0.3, 0.5, 0.6, 0.5, 0.3, 0.5, 0.6, 0.5, 0.3, 1, 0.6, 1, 0.3, 0.2, 0.6, 0.9, 0.3, 0.5, 0.6, 0.5, 0.3,
              0.2, 0.6, 0.4,
            ],
          },
          { time: 1, light: '00ff8080', dark: 'ffffff', curve: 'stepped' },
          { time: 2, light: 'ffffffff', dark: '000000' },
        ],
      }),
    );
    const a = r.project.skeleton.animations[0];
    const keys = a.slots[r.project.skeleton.slots[0].id].rgba2!;
    expect(keys.map((k) => k.value.length)).toEqual([7, 7, 7]);
    expect(keys[0].value.slice(0, 3)).toEqual(hex('ff8040'));
    expect(keys[0].value[3]).toBe(1);
    expect(keys[0].value.slice(4)).toEqual(hex('102030'));
    expect(keys[1].value[3]).toBeCloseTo(0x80 / 255, 6);
    expect(keys[1].curve).toBe('stepped');
    expect(Array.isArray(keys[0].curve) && keys[0].curve.length).toBe(28);
    expect(validateProject(r.project)).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('turns rgb2 into a two-color timeline whose alpha stays at the setup value', () => {
    const r = importSpineJson(
      file({
        rgb2: [
          {
            light: 'ff0000',
            dark: '00ff00',
            curve: [0.3, 0.2, 0.6, 0.8, 0.3, 0, 0.6, 1, 0.3, 0, 0.6, 1, 0.3, 1, 0.6, 0, 0.3, 0.5, 0.6, 0.5, 0.3, 0, 0.6, 1],
          },
          { time: 1, light: '0000ff', dark: '000000' },
        ],
      }),
    );
    const keys = r.project.skeleton.animations[0].slots[r.project.skeleton.slots[0].id].rgba2!;
    expect(keys[0].value).toEqual([1, 0, 0, 0xcc / 255, 0, 1, 0]);
    expect(keys[1].value).toEqual([0, 0, 1, 0xcc / 255, 0, 0, 0]);
    expect(Array.isArray(keys[0].curve) && keys[0].curve.length).toBe(28);
    expect(r.warnings.join('\n')).toContain('rgb2');
    expect(validateProject(r.project)).toEqual([]);
  });

  it('assumes black when a slot has two-color keys but no dark color, and keeps the document valid', () => {
    const r = importSpineJson(file({ rgba2: [{ light: 'ffffffff', dark: '102030' }] }, { name: 'fx', bone: 'root' }));
    expect(r.project.skeleton.slots[0].dark).toEqual([0, 0, 0]);
    expect(r.warnings.join('\n')).toContain('no dark color');
    expect(validateProject(r.project)).toEqual([]);
  });

  it('drops rgba keys that sit next to two-color keys', () => {
    const r = importSpineJson(file({ rgba: [{ color: 'ff0000ff' }], rgba2: [{ light: '00ff00ff', dark: '000000' }] }));
    const tl = r.project.skeleton.animations[0].slots[r.project.skeleton.slots[0].id];
    expect(tl.rgba).toBeUndefined();
    expect(tl.rgba2).toHaveLength(1);
    expect(r.warnings.join('\n')).toContain('next to two-color keys');
  });
});

describe('the validator and two-color keys', () => {
  beforeEach(load);

  it('the fixture (a two-color slot with rgba2 keys) is healthy', () => {
    expect(slot('glow').dark).not.toBeNull();
    expect(walk().slots[slot('glow').id].rgba2).toHaveLength(4);
    healthy('fixture');
  });

  it('gives a slot with two-color keys a dark color, and removes rgba keys next to them', () => {
    const project = structuredClone(docStore.get());
    const sk = project.skeleton;
    const glow = sk.slots.find((s) => s.name === 'glow')!;
    glow.dark = null;
    sk.animations[0].slots[glow.id].rgba = [{ time: 0, value: [1, 1, 1, 1] }];
    const notes = repairProject(project);
    expect(notes.join('\n')).toContain('got a dark color');
    expect(notes.join('\n')).toContain('next to two-color keys');
    expect(glow.dark).toEqual([0, 0, 0]);
    expect(sk.animations[0].slots[glow.id].rgba).toBeUndefined();
    expect(validateProject(project)).toEqual([]);
  });

  it('removes two-color keys that do not have seven channels', () => {
    const project = structuredClone(docStore.get());
    const sk = project.skeleton;
    const glow = sk.slots.find((s) => s.name === 'glow')!;
    sk.animations[0].slots[glow.id].rgba2![1].value = [1, 1, 1, 1];
    const notes = repairProject(project);
    expect(notes.join('\n')).toContain('two-color keys repaired');
    expect(sk.animations[0].slots[glow.id].rgba2).toHaveLength(3);
  });
});

describe('editing the dark color', () => {
  beforeEach(load);

  it('removing the dark color turns two-color keys into plain color keys (one undo step)', () => {
    const glow = slot('glow');
    const before = structuredClone(walk().slots[glow.id].rgba2!);
    A.setSlotProps(glow.id, { dark: null }, 'Dark tint');
    expect(slot('glow').dark).toBeNull();
    const tl = walk().slots[glow.id];
    expect(tl.rgba2).toBeUndefined();
    expect(tl.rgba!.map((k) => k.value)).toEqual(before.map((k) => k.value.slice(0, 4)));
    expect(tl.rgba!.map((k) => (Array.isArray(k.curve) ? k.curve.length : k.curve))).toEqual(
      before.map((k) => (Array.isArray(k.curve) ? 16 : k.curve)),
    );
    healthy('dark removed');
    docStore.undo();
    expect(slot('glow').dark).not.toBeNull();
    expect(walk().slots[glow.id].rgba2).toEqual(before);
    healthy('after undo');
  });

  it('enabling it on a slot with plain color keys leaves the keys alone', () => {
    const flag = slot('flag');
    const keys = structuredClone(walk().slots[flag.id].rgba);
    A.setSlotProps(flag.id, { dark: [0.2, 0.1, 0] }, 'Dark tint');
    expect(walk().slots[flag.id].rgba).toEqual(keys);
    expect(walk().slots[flag.id].rgba2).toBeUndefined();
    healthy('dark on flag');
  });

  it('keying the color of a two-color slot writes light and dark into one rgba2 key', () => {
    const glow = slot('glow');
    uiStore.patch({ mode: 'animate', time: 0.45 });
    A.setSlotColor(glow.id, [0.5, 0.25, 0.75, 0.5], [0.9, 0.8, 0.7]);
    const keys = walk().slots[glow.id].rgba2!;
    const key = keys.find((k) => Math.abs(k.time - 0.45) < 1e-6)!;
    expect(key.value).toEqual([0.5, 0.25, 0.75, 0.5, 0.9, 0.8, 0.7]);
    expect(keys.map((k) => k.time)).toEqual([0, 0.45, 0.6, 0.9, 1.2]);
    expect(walk().slots[glow.id].rgba).toBeUndefined();
    healthy('keyed');
    // the same time again replaces the key instead of adding one
    A.setSlotColor(glow.id, [0, 0, 0, 1], [1, 1, 1]);
    expect(walk().slots[glow.id].rgba2).toHaveLength(5);
    expect(walk().slots[glow.id].rgba2!.find((k) => Math.abs(k.time - 0.45) < 1e-6)!.value).toEqual([0, 0, 0, 1, 1, 1, 1]);
  });

  it('keying a slot that gained a dark color upgrades its light-only keys', () => {
    const flag = slot('flag');
    A.setSlotProps(flag.id, { dark: [0.3, 0.2, 0.1] }, 'Dark tint');
    const light = structuredClone(walk().slots[flag.id].rgba!);
    uiStore.patch({ mode: 'animate', time: 0.7 });
    A.setSlotColor(flag.id, [1, 0, 0, 1]); // no dark given: the setup dark color is keyed
    const tl = walk().slots[flag.id];
    expect(tl.rgba).toBeUndefined();
    expect(tl.rgba2!.map((k) => k.value.slice(0, 4))).toEqual([light[0].value, [1, 0, 0, 1], light[1].value]);
    expect(tl.rgba2!.map((k) => k.value.slice(4))).toEqual([
      [0.3, 0.2, 0.1],
      [0.3, 0.2, 0.1],
      [0.3, 0.2, 0.1],
    ]); // the dark color of the upgraded keys is the setup one
    expect(tl.rgba2!.every((k) => k.value.length === 7)).toBe(true);
    expect(tl.rgba2!.every((k) => !Array.isArray(k.curve) || k.curve.length === 28)).toBe(true);
    healthy('upgraded');
  });

  it('a slot without a dark color is still keyed with plain rgba', () => {
    const body = slot('body');
    uiStore.patch({ mode: 'animate', time: 0.2 });
    A.setSlotColor(body.id, [0.1, 0.2, 0.3, 0.4]);
    expect(walk().slots[body.id].rgba).toHaveLength(1);
    expect(walk().slots[body.id].rgba2).toBeUndefined();
    healthy('plain key');
  });
});
