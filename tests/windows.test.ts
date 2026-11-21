/** The Metrics window numbers and the remembered window layout. */
import { describe, expect, it } from 'vitest';
import { newAnimation } from '../src/core/model';
import { countKeys, projectStats, projectWarnings } from '../src/core/stats';
import { DEFAULT_VIEWS, LAYOUTS, VIEW_LIST, readLayout } from '../src/store/layout';
import { buildFixture } from './fixture';

describe('project stats', () => {
  const { project } = buildFixture();

  it('count what is in the rig', () => {
    const s = projectStats(project);
    expect(s.bones).toBe(project.skeleton.bones.length);
    expect(s.slots).toBe(project.skeleton.slots.length);
    expect(s.animations).toBe(project.skeleton.animations.length);
    expect(s.attachments.mesh).toBeGreaterThan(0);
    expect(s.vertices).toBeGreaterThan(0);
    expect(s.triangles).toBeGreaterThan(0);
    expect(s.keys).toBe(project.skeleton.animations.reduce((n, a) => n + countKeys(a), 0));
    expect(s.keys).toBeGreaterThan(20);
    expect(Object.values(s.constraints).reduce((a, b) => a + b, 0)).toBe(project.skeleton.constraints.length);
  });

  it('count the keys of an animation once each', () => {
    const a = newAnimation('x', 1);
    expect(countKeys(a)).toBe(0);
    const bone = project.skeleton.bones[0].id;
    a.bones[bone] = {
      rotate: [
        { time: 0, value: [0] },
        { time: 1, value: [10] },
      ],
      translate: [{ time: 0.5, value: [1, 2] }],
    };
    expect(countKeys(a)).toBe(3);
  });

  it('report forgotten things without touching the project', () => {
    const before = JSON.stringify(project);
    const withExtra = structuredClone(project);
    withExtra.images.push({ id: 'zz', name: 'never-used', width: 4, height: 4 });
    withExtra.skeleton.animations.push(newAnimation('empty', 1));
    const w = projectWarnings(withExtra);
    expect(w).toContainEqual({ kind: 'unusedImage', subject: 'never-used' });
    expect(w).toContainEqual({
      kind: 'emptyAnimation',
      subject: 'empty',
      ref: { animation: withExtra.skeleton.animations.find((x) => x.name === 'empty')!.id },
    });
    expect(JSON.stringify(project)).toBe(before);
  });
});

describe('window layout', () => {
  it('keeps what is valid and falls back to the defaults for the rest', () => {
    expect(readLayout(null)).toEqual({});
    expect(readLayout('not json')).toEqual({});
    const odd = readLayout(
      JSON.stringify({ views: { tree: false, timeline: 'yes', ghost: true }, panel: { left: 5, right: 300, bottom: 300 } }),
    );
    expect(odd.views).toEqual({ ...DEFAULT_VIEWS, tree: false });
    expect(odd.panel).toBeUndefined(); // 5 px wide would hide the window for good
    const ok = readLayout(JSON.stringify({ views: DEFAULT_VIEWS, panel: { left: 270, right: 300, bottom: 300 } }));
    expect(ok.panel).toEqual({ left: 270, right: 300, bottom: 300 });
  });

  it('has ready layouts that name every window', () => {
    for (const l of LAYOUTS) expect(Object.keys(l.views).sort()).toEqual(VIEW_LIST.map((v) => v.id).sort());
    expect(LAYOUTS[0].views).toEqual(DEFAULT_VIEWS);
  });
});

describe('history and the command palette', () => {
  it('jumps to any point of the history and back', async () => {
    const { DocStore } = await import('../src/store/doc');
    const store = new DocStore();
    for (const n of ['a', 'b', 'c']) store.update(n, (d) => void (d.name = n));
    expect(store.history).toEqual({ past: ['a', 'b', 'c'], future: [] });
    store.jumpTo(0);
    expect(store.get().name).toBe('a');
    expect(store.history).toEqual({ past: ['a'], future: ['b', 'c'] });
    store.jumpTo(-1);
    expect(store.get().name).toBe('untitled');
    store.jumpTo(2);
    expect(store.get().name).toBe('c');
    expect(store.history.future).toEqual([]);
  });

  it('finds commands by every word typed, in either language', async () => {
    const { filterCommands } = await import('../src/editor/commands');
    const cmd = (title: string, group = 'Edit') => ({ id: title, title, group, run: () => {} });
    const all = [cmd('Mirror bones'), cmd('Duplicate bones'), cmd('Reset pose'), cmd('Onion skin', 'View')];
    const id = (s: string) => s;
    expect(filterCommands(all, 'bones', id).map((c) => c.title)).toEqual(['Mirror bones', 'Duplicate bones']);
    expect(filterCommands(all, 'dup bon', id).map((c) => c.title)).toEqual(['Duplicate bones']); // every word must be somewhere in the title or group
    expect(filterCommands(all, 'dup', id).map((c) => c.title)).toEqual(['Duplicate bones']);
    expect(filterCommands(all, 'view onion', id).map((c) => c.title)).toEqual(['Onion skin']);
    expect(filterCommands(all, '', id)).toBe(all);
    const ru = (s: string) => ({ 'Onion skin': 'Призраки кадров', View: 'Вид' })[s] ?? s;
    expect(filterCommands(all, 'призр', ru).map((c) => c.title)).toEqual(['Onion skin']);
  });
});
