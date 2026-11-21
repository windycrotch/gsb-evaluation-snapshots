/** Names in bulk: the filter forms (words, wildcards, regular expressions) and Find and replace. */
import { describe, expect, it } from 'vitest';
import { applyImageRename, applyRename, nameMatcher, planRename } from '../src/core/rename';
import type { FindReplaceOptions } from '../src/core/rename';
import { filterTree } from '../src/core/treeFilter';
import { docStore } from '../src/store/doc';
import { findReplaceNames, renameScope } from '../src/store/renameActions';
import { uiStore } from '../src/store/ui';
import { validateProject } from '../src/core/validate';
import { buildFixture } from './fixture';

const opts = (extra: Partial<FindReplaceOptions>): FindReplaceOptions => ({
  find: 'x',
  replace: 'y',
  regex: false,
  matchCase: false,
  firstOnly: false,
  kinds: ['bone'],
  ...extra,
});

describe('nameMatcher', () => {
  it('is null for an empty filter', () => {
    expect(nameMatcher('')).toBeNull();
    expect(nameMatcher('   ')).toBeNull();
  });

  it('words: every word, any case, any order', () => {
    const m = nameMatcher('arm UP')!;
    expect(m('armUpper')).toBe(true);
    expect(m('upperArm')).toBe(true);
    expect(m('armLower')).toBe(false);
  });

  it('wildcards: * is a run, ? is one character, the rest is literal', () => {
    expect(nameMatcher('arm*per')!('armUpper')).toBe(true);
    expect(nameMatcher('arm?pper')!('armUpper')).toBe(true);
    expect(nameMatcher('arm?per')!('armUpper')).toBe(false);
    expect(nameMatcher('a.m*')!('a.mX')).toBe(true);
    expect(nameMatcher('a.m*')!('abmX')).toBe(false);
    expect(nameMatcher('(x)*')!('(x)y')).toBe(true);
  });

  it('/regex/: flags, and a bad expression matches nothing instead of throwing', () => {
    expect(nameMatcher('/^arm/')!('armUpper')).toBe(true);
    expect(nameMatcher('/^arm/')!('legarm')).toBe(false);
    expect(nameMatcher('/^ARM/')!('armUpper')).toBe(false);
    expect(nameMatcher('/^ARM/i')!('armUpper')).toBe(true);
    expect(nameMatcher('/(/')!('anything')).toBe(false);
  });

  it('a stateful flag does not make the test flip between calls', () => {
    const m = nameMatcher('/a/g')!;
    expect([m('a'), m('a'), m('a')]).toEqual([true, true, true]);
  });
});

describe('the hierarchy filter with the new forms', () => {
  const doc = buildFixture().project.skeleton;
  it('finds bones by wildcard and by regular expression, with their ancestors', () => {
    const names = (q: string) => doc.bones.filter((b) => filterTree(doc, q).bones.has(b.id)).map((b) => b.name);
    expect(names('arm*')).toContain('armLower');
    expect(names('arm*')).toContain('torso');
    expect(names('/^hand/')).toEqual(expect.arrayContaining(['hand', 'handTarget']));
    const none = filterTree(doc, '/(/');
    expect(none.active).toBe(true);
    expect(none.bones.size).toBe(0);
  });
});

describe('planRename / applyRename', () => {
  it('renames what matches, only in the chosen kinds', () => {
    const doc = buildFixture().project.skeleton;
    const plan = planRename(doc, opts({ find: 'arm', replace: 'Arm', matchCase: true }));
    expect(plan.changes.length).toBeGreaterThan(0);
    expect(plan.changes.every((c) => c.kind === 'bone')).toBe(true);
    expect(plan.changes.map((c) => c.to)).toContain('ArmUpper');
    const before = doc.slots.map((s) => s.name);
    applyRename(doc, plan.changes);
    expect(doc.bones.some((b) => b.name === 'ArmUpper')).toBe(true);
    expect(doc.slots.map((s) => s.name)).toEqual(before);
  });

  it('match case and first-only', () => {
    const doc = buildFixture().project.skeleton;
    expect(planRename(doc, opts({ find: 'ARM', replace: 'q', matchCase: true })).changes).toHaveLength(0);
    expect(planRename(doc, opts({ find: 'ARM', replace: 'q', matchCase: false })).changes.length).toBeGreaterThan(0);
    const names = doc.bones.map((b) => b.name);
    const target = names.find((n) => (n.match(/e/gi) ?? []).length > 1)!;
    const first = planRename(doc, opts({ find: 'e', replace: '_', firstOnly: true })).changes.find((c) => c.from === target)!;
    const all = planRename(doc, opts({ find: 'e', replace: '_' })).changes.find((c) => c.from === target)!;
    expect((first.to.match(/_/g) ?? []).length).toBe(1);
    expect((all.to.match(/_/g) ?? []).length).toBeGreaterThan(1);
  });

  it('a plain replacement is literal ($1 is just text), a regular expression one has groups', () => {
    const doc = buildFixture().project.skeleton;
    const lit = planRename(doc, opts({ find: 'head', replace: '$1x' })).changes.find((c) => c.from === 'head');
    expect(lit?.to).toBe('$1x');
    const grp = planRename(doc, opts({ find: '^(arm)(\\w+)$', replace: '$2_$1', regex: true })).changes.find((c) => c.from === 'armUpper');
    expect(grp?.to).toBe('Upper_arm');
  });

  it('special characters in a plain search are not an expression', () => {
    const doc = buildFixture().project.skeleton;
    doc.bones[1].name = 'a.b(c)';
    const plan = planRename(doc, opts({ find: '.b(', replace: '-' }));
    expect(plan.invalid).toBe(false);
    expect(plan.changes.find((c) => c.from === 'a.b(c)')?.to).toBe('a-c)');
  });

  it('an expression that does not parse is reported, nothing changes', () => {
    const doc = buildFixture().project.skeleton;
    const plan = planRename(doc, opts({ find: '(', replace: '', regex: true }));
    expect(plan.invalid).toBe(true);
    expect(plan.changes).toHaveLength(0);
  });

  it('a name that would clash or become empty is skipped and listed', () => {
    const doc = buildFixture().project.skeleton;
    const plan = planRename(doc, opts({ find: '.+', replace: 'same', regex: true, firstOnly: true }));
    // the first one takes "same", every other one would clash with it
    expect(plan.changes).toHaveLength(1);
    expect(plan.skipped.length).toBe(doc.bones.length - 1);
    expect(plan.skipped.every((s) => s.why === 'taken')).toBe(true);
    const gone = planRename(doc, opts({ find: 'head', replace: '' }));
    expect(gone.skipped.find((s) => s.from === 'head')?.why).toBe('empty');
  });

  it('swapping works one name at a time and never leaves a duplicate', () => {
    const doc = buildFixture().project.skeleton;
    const a = doc.bones.find((b) => b.name === 'armUpper')!;
    const plan = planRename(doc, opts({ find: 'armUpper', replace: 'armLower' }));
    expect(plan.changes).toHaveLength(0);
    expect(plan.skipped[0]).toMatchObject({ from: 'armUpper', why: 'taken' });
    expect(a.name).toBe('armUpper');
  });

  it('keeps the default skin name, and renames the rest of the kinds', () => {
    const { project } = buildFixture();
    const doc = project.skeleton;
    const kinds = ['bone', 'slot', 'skin', 'event', 'constraint', 'animation'] as const;
    const plan = planRename(doc, opts({ find: '[a-z]', replace: 'Z', regex: true, firstOnly: true, kinds }));
    expect(plan.changes.some((c) => c.kind === 'skin' && c.from === doc.skins[0].name)).toBe(false);
    applyRename(doc, plan.changes);
    for (const list of [doc.bones, doc.slots, doc.skins, doc.events, doc.constraints, doc.animations]) {
      const names = list.map((x) => x.name);
      expect(new Set(names).size).toBe(names.length);
    }
    expect(validateProject(project)).toEqual([]);
  });

  it('ignores a change whose name moved on since the plan was made', () => {
    const doc = buildFixture().project.skeleton;
    const plan = planRename(doc, opts({ find: 'head', replace: 'skull' }));
    doc.bones.find((b) => b.name === 'head')!.name = 'other';
    expect(applyRename(doc, plan.changes)).toBe(0);
  });
});

describe('Find and replace: pictures and where', () => {
  it('renames pictures and points the attachments that show them at the new names', () => {
    const { project } = buildFixture();
    const plan = planRename(project.skeleton, opts({ find: 'flag', replace: 'banner', kinds: ['image'] }), project);
    expect(plan.changes.map((c) => [c.from, c.to])).toEqual([
      ['flagA', 'bannerA'],
      ['flagB', 'bannerB'],
    ]);
    expect(applyImageRename(project, plan.changes)).toBe(2);
    expect(project.images.map((i) => i.name)).toContain('bannerA');
    const paths = project.skeleton.skins.flatMap((s) => Object.values(s.attachments).flatMap((slot) => Object.values(slot)));
    expect(paths.some((a) => (a.type === 'region' || a.type === 'mesh') && a.path === 'bannerB')).toBe(true);
    expect(paths.some((a) => (a.type === 'region' || a.type === 'mesh') && a.path.startsWith('flag'))).toBe(false);
    expect(validateProject(project)).toEqual([]);
  });

  it('a picture is not renamed to a name another picture has, or to nothing', () => {
    const { project } = buildFixture();
    const clash = planRename(project.skeleton, opts({ find: 'bodyAlt', replace: 'body', kinds: ['image'] }), project);
    expect(clash.changes).toEqual([]);
    expect(clash.skipped[0]).toMatchObject({ kind: 'image', from: 'bodyAlt', why: 'taken' });
    const empty = planRename(project.skeleton, opts({ find: 'front', replace: '', kinds: ['image'] }), project);
    expect(empty.skipped[0]).toMatchObject({ kind: 'image', from: 'front', why: 'empty' });
  });

  it('pictures are only touched when the project is given', () => {
    const { project } = buildFixture();
    expect(planRename(project.skeleton, opts({ find: 'flag', replace: 'banner', kinds: ['image'] })).changes).toEqual([]);
  });

  it('a picture that is a frame of a sequence is skipped and listed', () => {
    const { project } = buildFixture();
    const att = Object.values(project.skeleton.skins[0].attachments)
      .flatMap((s) => Object.values(s))
      .find((a) => a.type === 'region');
    if (att?.type !== 'region') throw new Error('no region');
    project.images.push({ id: 'f0', name: 'run0', width: 8, height: 8 }, { id: 'f1', name: 'run1', width: 8, height: 8 });
    att.path = 'run';
    att.sequence = { count: 2, start: 0, digits: 1, setupIndex: 0, mode: 'loop', delay: 0 } as never;
    const plan = planRename(project.skeleton, opts({ find: 'run', replace: 'walk', kinds: ['image'] }), project);
    expect(plan.changes).toEqual([]);
    expect(plan.skipped.map((s) => s.why)).toEqual(['frame', 'frame']);
  });

  it('a scope limits the names: only the ids and pictures it lists', () => {
    const { project } = buildFixture();
    const doc = project.skeleton;
    const head = doc.bones.find((b) => b.name === 'head')!;
    const all = planRename(doc, opts({ find: 'e', replace: 'E' }), project);
    expect(all.changes.length).toBeGreaterThan(1);
    const some = planRename(doc, opts({ find: 'e', replace: 'E', scope: { ids: new Set([head.id]) } }), project);
    expect(some.changes.map((c) => c.id)).toEqual([head.id]);
    const pics = planRename(doc, opts({ find: 'o', replace: '0', kinds: ['image'], scope: { images: new Set(['body']) } }), project);
    expect(pics.changes.map((c) => c.from)).toEqual(['body']);
    // an empty scope touches nothing
    expect(planRename(doc, opts({ find: 'e', replace: 'E', scope: { ids: new Set() } }), project).changes).toEqual([]);
  });
});

describe('the scope the editor builds', () => {
  it('"selection" is the selected bones, slot and constraint, and what the slot shows; "skin" is the chosen skin and its pictures', () => {
    const { project } = buildFixture();
    docStore.replace(project);
    const doc = project.skeleton;
    const flag = doc.slots.find((s) => s.name === 'flag')!;
    const head = doc.bones.find((b) => b.name === 'head')!;
    const ui = {
      ...uiStore.get(),
      selection: { bones: [head.id], slot: flag.id, attachment: null, constraint: null, vertices: [] },
      mode: 'setup' as const,
      skinId: doc.skins[1].id,
    };
    expect(renameScope('all', project, ui)).toBeUndefined();
    const sel = renameScope('selection', project, ui)!;
    expect([...sel.ids!].sort()).toEqual([head.id, flag.id].sort());
    // the flag shows flagA in the default skin and flagB in the alt skin
    expect([...sel.images!].sort()).toEqual(['flagA', 'flagB']);
    const skin = renameScope('skin', project, ui)!;
    expect([...skin.ids!]).toEqual([doc.skins[1].id]);
    expect([...skin.images!]).toEqual(['flagB']);
    // no skin chosen: the default one
    const plain = renameScope('skin', project, { ...ui, skinId: null })!;
    expect([...plain.ids!]).toEqual([doc.skins[0].id]);
    expect(plain.images!.has('body')).toBe(true);
  });

  it('Find and replace through the store renames names and pictures in one step', () => {
    const { project } = buildFixture();
    docStore.replace(project);
    const n = findReplaceNames({
      find: 'flag',
      replace: 'banner',
      regex: false,
      matchCase: false,
      firstOnly: false,
      kinds: ['slot', 'image'],
    });
    expect(n).toBeGreaterThanOrEqual(3);
    expect(docStore.undoLabel).toBe('Find and replace');
    expect(docStore.get().images.some((i) => i.name === 'bannerA')).toBe(true);
    docStore.undo();
    expect(docStore.get().images.some((i) => i.name === 'flagA')).toBe(true);
  });
});
