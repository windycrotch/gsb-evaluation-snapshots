/** Metrics: timelines and the area the pictures cover. */
import { describe, expect, it } from 'vitest';
import { newAnimation } from '../src/core/model';
import type { MeshAttachment, RegionAttachment } from '../src/core/model';
import { attachmentArea, countKeys, countTimelines, projectStats } from '../src/core/stats';
import { buildFixture } from './fixture';

describe('area', () => {
  it('a region is its size times its scale, a mesh the area of its texture triangles', () => {
    const region = {
      type: 'region',
      name: 'r',
      path: 'r',
      x: 0,
      y: 0,
      rotation: 0,
      scaleX: 2,
      scaleY: -0.5,
      width: 30,
      height: 40,
      color: [1, 1, 1, 1],
    } as RegionAttachment;
    expect(attachmentArea(region)).toBe(1200);
    const mesh = {
      type: 'mesh',
      name: 'm',
      path: 'm',
      color: [1, 1, 1, 1],
      width: 20,
      height: 10,
      uvs: [0, 0, 1, 0, 1, 1, 0, 1],
      triangles: [0, 1, 2, 0, 2, 3],
      hull: 4,
      edges: [],
      vertices: [],
      weights: null,
    } as MeshAttachment;
    expect(attachmentArea(mesh)).toBeCloseTo(200, 9);
    expect(attachmentArea({ type: 'point', name: 'p' } as never)).toBe(0);
  });

  it('the project adds them up', () => {
    const { project } = buildFixture();
    const s = projectStats(project);
    expect(s.area).toBeGreaterThan(0);
    expect(Number.isInteger(s.area)).toBe(true);
  });
});

describe('timelines', () => {
  it('counts every list of keys once', () => {
    const a = newAnimation('a', 1);
    const [id1, id2] = ['b1', 'b2'];
    a.bones[id1] = {
      rotate: [
        { time: 0, value: [0] },
        { time: 1, value: [5] },
      ],
      translate: [{ time: 0, value: [0, 0] }],
    };
    a.bones[id2] = { scale: [{ time: 0, value: [1, 1] }] };
    expect(countTimelines(a)).toBe(3);
    expect(countKeys(a)).toBe(4);
    expect(countTimelines(newAnimation('empty', 1))).toBe(0);
  });
});
