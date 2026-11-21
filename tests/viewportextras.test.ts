/** Pixel snap, the frame counter and the settings of the pixel grid. */
import { describe, expect, it } from 'vitest';
import { snapPoint } from '../src/core/snap';
import { FpsMeter } from '../src/editor/viewport/fps';
import { DEFAULT_SETTINGS, readSettings } from '../src/store/settings';

describe('pixel snap', () => {
  it('lands on whole units when it is on and the grid is off', () => {
    const s = snapPoint(12.4, -7.6, { zoom: 8, grid: false, pixel: true });
    expect([s.x, s.y]).toEqual([12, -8]);
  });
  it('leaves a point alone with neither, lets the grid win, and still sticks to a guide first', () => {
    expect(snapPoint(12.4, -7.6, { zoom: 8, grid: false })).toMatchObject({ x: 12.4, y: -7.6 });
    expect(snapPoint(12.4, -7.6, { zoom: 8, grid: true, pixel: true })).toMatchObject({ x: 10, y: -10 });
    const g = snapPoint(12.4, -7.6, { zoom: 8, grid: false, pixel: true, guides: { x: [12.9], y: [] } });
    expect([g.x, g.y, g.guideX, g.guideY]).toEqual([12.9, -8, true, false]);
  });
});

describe('FpsMeter', () => {
  it('counts the frames of the last second and keeps the time of the last one', () => {
    const m = new FpsMeter();
    for (let t = 0; t < 1000; t += 100) m.tick(t, 2 + t / 1000);
    expect(m.read(1000)).toEqual({ fps: 10, ms: 2.9 });
    // a second later nothing was drawn: the viewport only draws what changes
    expect(m.read(2500).fps).toBe(0);
    m.tick(2600, 1.5);
    expect(m.read(2600)).toEqual({ fps: 1, ms: 1.5 });
  });
});

describe('settings of the viewport extras', () => {
  it('are off by default and read back only as flags', () => {
    expect(DEFAULT_SETTINGS.pixelGrid).toBe(false);
    expect(DEFAULT_SETTINGS.showFps).toBe(false);
    expect(readSettings(JSON.stringify({ pixelGrid: true, showFps: true }))).toMatchObject({ pixelGrid: true, showFps: true });
    expect(readSettings(JSON.stringify({ pixelGrid: 'yes', showFps: 1 }))).toMatchObject({ pixelGrid: false, showFps: false });
  });
});

describe('a bone name that stays on screen', () => {
  it('is an editor flag: one history step, kept by save and load, and not part of the Spine export', async () => {
    const { buildFixture } = await import('./fixture');
    const { docStore } = await import('../src/store/doc');
    const { setBoneProps } = await import('../src/store/actions');
    const { exportSpineJson } = await import('../src/core/export/spineJson');
    const { project } = buildFixture();
    docStore.replace(project);
    const bone = project.skeleton.bones[1];
    setBoneProps(bone.id, { showName: true }, 'Bone name on screen');
    expect(docStore.undoLabel).toBe('Bone name on screen');
    const saved = JSON.parse(JSON.stringify(docStore.get())) as typeof project;
    expect(saved.skeleton.bones[1].showName).toBe(true);
    const json = JSON.stringify(exportSpineJson(docStore.get().skeleton));
    expect(json).not.toContain('showName');
    docStore.undo();
    expect(docStore.get().skeleton.bones[1].showName).toBeUndefined();
  });
});
