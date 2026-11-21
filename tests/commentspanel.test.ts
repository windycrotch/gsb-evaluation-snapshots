/** The Comments window: every review comment of the project in one list, a jump to where one is, and "resolved" marks. */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyReview, listReview, makeComment, reviewCounts } from '../src/core/review';
import { DEFAULT_VIEWS, VIEW_LIST } from '../src/store/layout';
import { docStore } from '../src/store/doc';
import { goToComment, resolveAllComments, setCommentResolved } from '../src/store/commentActions';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';

const doc = () => docStore.get().skeleton;

beforeEach(() => {
  const f = buildFixture();
  const d = f.project.skeleton;
  const [first, second] = d.animations;
  const bone = d.bones[3].name;
  applyReview(d, [
    makeComment('c1', second.name, 0.5, 'second, early', 'Ann', undefined, 1),
    makeComment('c2', first.name, 0.4, 'first, late', 'Bob', bone, 2),
    makeComment('c3', first.name, 0.1, 'first, early', 'Ann', undefined, 3),
  ]);
  docStore.replace(f.project);
  uiStore.patch({ mode: 'setup', animationId: null, time: 0, selection: emptySelection });
});

describe('listReview', () => {
  it('lists the comments by animation in the order of the document, and by time inside one', () => {
    const items = listReview(doc());
    expect(items.map((i) => i.marker.text)).toEqual(['first, early', 'first, late', 'second, early']);
    expect(items[0].animation).toBe(doc().animations[0].name);
    expect(items[0].animationId).toBe(doc().animations[0].id);
  });

  it('leaves out what is not a review comment', () => {
    docStore.update('marker', (d) => {
      (d.skeleton.animations[0].markers ??= []).push({ id: 'plain', time: 0.2, name: 'beat', color: 0, text: 'a beat' });
    });
    expect(listReview(doc()).some((i) => i.marker.id === 'plain')).toBe(false);
  });

  it('puts the comments that are dealt with last when asked', () => {
    const [a] = listReview(doc());
    setCommentResolved(a.animationId, a.marker.id, true);
    const items = listReview(doc(), true);
    expect(items.map((i) => !!i.marker.resolved)).toEqual([false, false, true]);
    expect(items[2].marker.id).toBe(a.marker.id);
  });

  it('is empty for a project without comments', () => {
    expect(listReview(buildFixture().project.skeleton)).toEqual([]);
  });
});

describe('going to a comment', () => {
  it('opens its animation in Animate mode at its moment and selects the bone it points at', () => {
    const late = listReview(doc()).find((i) => i.marker.text === 'first, late')!;
    expect(goToComment(late.animationId, late.marker.id)).toBe(true);
    const ui = uiStore.get();
    expect(ui.mode).toBe('animate');
    expect(ui.animationId).toBe(late.animationId);
    expect(ui.time).toBeCloseTo(0.4, 6);
    expect(ui.selection.bones).toEqual([doc().bones[3].id]);
  });

  it('a comment without a bone leaves the selection alone, and a comment that is gone is refused', () => {
    const early = listReview(doc()).find((i) => i.marker.text === 'second, early')!;
    uiStore.patch({ selection: { ...emptySelection, bones: [doc().bones[1].id] } });
    expect(goToComment(early.animationId, early.marker.id)).toBe(true);
    expect(uiStore.get().selection.bones).toEqual([doc().bones[1].id]);
    expect(goToComment(early.animationId, 'nope')).toBe(false);
    expect(goToComment('nope', early.marker.id)).toBe(false);
  });
});

describe('resolving', () => {
  it('marks one comment, as one step of history that undo takes back', () => {
    const [a] = listReview(doc());
    const steps = docStore.history.past.length;
    expect(setCommentResolved(a.animationId, a.marker.id, true)).toBe(true);
    expect(docStore.history.past.length).toBe(steps + 1);
    expect(reviewCounts(doc())).toEqual({ open: 2, resolved: 1 });
    expect(setCommentResolved(a.animationId, a.marker.id, true)).toBe(false); // already so
    docStore.undo();
    expect(reviewCounts(doc())).toEqual({ open: 3, resolved: 0 });
  });

  it('opens one again, and refuses what is not a review comment', () => {
    const [a] = listReview(doc());
    setCommentResolved(a.animationId, a.marker.id, true);
    expect(setCommentResolved(a.animationId, a.marker.id, false)).toBe(true);
    expect(reviewCounts(doc()).open).toBe(3);
    docStore.update('marker', (d) => {
      (d.skeleton.animations[0].markers ??= []).push({ id: 'plain', time: 0.2, name: 'beat', color: 0, text: '' });
    });
    expect(setCommentResolved(doc().animations[0].id, 'plain', true)).toBe(false);
  });

  it('resolves every open comment in one step', () => {
    const [a] = listReview(doc());
    setCommentResolved(a.animationId, a.marker.id, true);
    const steps = docStore.history.past.length;
    expect(resolveAllComments()).toBe(2);
    expect(docStore.history.past.length).toBe(steps + 1);
    expect(reviewCounts(doc())).toEqual({ open: 0, resolved: 3 });
    expect(resolveAllComments()).toBe(0);
  });
});

describe('the window', () => {
  it('is one of the windows, off until it is opened', () => {
    expect(VIEW_LIST.some((v) => v.id === 'comments')).toBe(true);
    expect(DEFAULT_VIEWS.comments).toBe(false);
  });
});
