// How one page's save of notes is merged into selection.json, when another tab or the agent changed the file meanwhile.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeNotes } from '../src/editor.js';

const v = 'project.json', note = (n, id, extra = {}) => ({ n, ...(id ? { id } : {}), note: `note ${n}`, image: `selection/${n}.png`, project: v, ...extra });
const ns = list => list.map(m => `${m.n}:${m.id || '-'}`);

test('notes made in another tab are kept, and a taken number moves to the next free one', () => {
  const old = [note(1, 'a1')];                                          // tab A saved note 1
  const { all, renumbered } = mergeNotes(old, { marks: [note(1, 'b1')] }, v);   // tab B, which has not seen it, saves its own note 1
  assert.deepEqual(ns(all), ['1:a1', '2:b1']);
  assert.deepEqual(renumbered, [['b1', 1, 2]]);
  assert.equal(all[1].image, 'selection/2.png');
});

test('a deleted note goes only when the page names it', () => {
  const old = [note(1, 'a1'), note(2, 'b1')];
  assert.deepEqual(ns(mergeNotes(old, { marks: [note(2, 'b1')] }, v).all), ['1:a1', '2:b1']);   // left out: kept
  assert.deepEqual(ns(mergeNotes(old, { marks: [note(2, 'b1')], deleted: ['a1'] }, v).all), ['2:b1']);
});

test('notes from before ids are matched by number', () => {
  const old = [note(1), note(2)];
  const { all, renumbered } = mergeNotes(old, { marks: [{ ...note(1), note: 'edited' }, note(2)], deleted: [] }, v);
  assert.deepEqual(ns(all), ['1:-', '2:-']); assert.equal(all[0].note, 'edited'); assert.deepEqual(renumbered, []);
  assert.deepEqual(ns(mergeNotes(old, { marks: [note(2)], deleted: ['#1'] }, v).all), ['2:-']);
});

test('done stays the file\'s unless the page toggled it, and other versions are untouched', () => {
  const old = [note(1, 'a1', { done: true }), { ...note(2, 'x2'), project: 'project-tiktok.json' }];
  const { all } = mergeNotes(old, { marks: [note(1, 'a1'), note(3, 'c3')] }, v);
  assert.equal(all.find(m => m.id === 'a1').done, true);                // the agent marked it done in the file
  assert.ok(all.some(m => m.id === 'x2' && m.project === 'project-tiktok.json'));
  assert.equal(mergeNotes(old, { marks: [note(1, 'a1')], toggled: [1] }, v).all.find(m => m.id === 'a1').done, undefined);
});
