import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutList } from '../src/page/cuts.js';

const ms = v => Math.round(v * 1000) / 1000;   // times to the millisecond, past float noise
const near = (a, b, d = 1e-9) => assert.ok(Math.abs(a - b) <= d, `${a} is not within ${d} of ${b}`);
// four parts of 4 s with 1 s pauses cut out between them
const segments = [{ from: 0, to: 4 }, { from: 5, to: 9 }, { from: 10, to: 14 }, { from: 15, to: 19 }];
const sections = [{ name: 'hook', from: 0 }, { name: 'rest', from: 9.6 }];   // 9.6 is nearest the cut at 10
const transcript = { segments: [{ words: [
  { word: ' Hello', start: 1.0, end: 1.4 }, { word: ' world.', start: 1.5, end: 2.0 }, { word: ' this', start: 2.6, end: 2.9 },
  { word: ' is', start: 3.0, end: 3.2 }, { word: ' um', start: 4.3, end: 4.6 }, { word: ' kept', start: 5.2, end: 5.5 },
] }, { words: [{ word: ' Next', start: 10.2, end: 10.5 }, { word: ' part', start: 10.6, end: 11.0 }] }] };

test('cut list sections: each starts at the cut nearest its time, and the sections add up to the whole edit', () => {
  const whole = cutList({ segments }, null), hook = cutList({ segments, sections }, null, { section: 'hook' }), rest = cutList({ segments, sections }, null, { section: 1 });
  assert.equal(whole.duration, 16);
  assert.deepEqual([hook.duration, hook.offset, hook.parts.length, hook.section], [8, 0, 2, 'hook']);
  assert.deepEqual([rest.duration, rest.offset, rest.parts.map(p => p.at)], [8, 8, [0, 4]]);
  near(rest.toOut(12), 2); near(rest.at(5).src, 16);
  // with a dissolve the parts overlap; a section ends where the next one's first part starts, so the sum still holds
  const D = 0.5, wd = cutList({ segments, dissolve: D }, null, { clip2: {} });
  const a = cutList({ segments, sections, dissolve: D }, null, { clip2: {}, section: 'hook' }), b = cutList({ segments, sections, dissolve: D }, null, { clip2: {}, section: 'rest' });
  near(a.duration + b.duration, wd.duration); assert.deepEqual([a.duration, b.offset], [7, 7]);
  // punch keeps alternating across the whole list, not per section
  assert.deepEqual(cutList({ segments, sections }, null, { punch: [1, 1.2], section: 'rest' }).parts.map(p => p.zoom), [1, 1.2]);
  assert.throws(() => cutList({ segments }, null, { section: 'hook' }), /no "sections"/);
  assert.throws(() => cutList({ segments, sections }, null, { section: 'outro' }), /no section "outro"; the sections are hook, rest/);
  assert.throws(() => cutList({ segments, sections: [{ name: 'a', from: 9.8 }, { name: 'b', from: 10.1 }] }, null, { section: 'a' }), /same cut as the one after it/);
});

test('captions: words land on the scene time, cut words are dropped, and lines break at pauses, sentences and length', () => {
  const hook = cutList({ segments, sections }, null, { section: 'hook' }), rest = cutList({ segments, sections }, null, { section: 'rest' });
  const lines = hook.captions(transcript);
  assert.deepEqual(lines.map(l => l.text), ['Hello world.', 'this is', 'kept']);   // "um" sat in a cut pause
  assert.deepEqual(lines.map(l => [ms(l.start), ms(l.end)]), [[1, 2.3], [2.6, 3.5], [4.2, 4.8]]);
  assert.deepEqual(rest.captions(transcript).map(l => [l.text, ms(l.start)]), [['Next part', 0.2]]);
  assert.deepEqual(hook.captions(transcript, { maxChars: 8 }).map(l => l.text), ['Hello', 'world.', 'this is', 'kept']);
  // shift moves every word before it is placed; a flat list of { text, start, end } works too
  assert.deepEqual(rest.captions([{ text: 'late', start: 10.0, end: 10.2 }], { shift: 0.25 }).map(l => ms(l.start)), [0.25]);
  assert.deepEqual(cutList({ segments }, null).captions([{ text: 'late', start: 10.0, end: 10.2 }]).map(l => l.start), [8]);
});
