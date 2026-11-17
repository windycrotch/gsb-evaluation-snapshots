// The frame layout: pure arithmetic, so no Chrome or ffmpeg is needed. The layout is what renderProject checks the
// finished video against (test/render.test.js has the end-to-end cases).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { layoutPath, projectLayout, projectScenes, readTotal, sceneFrameCounts } from '../src/project.js';

const project = (scenes, fps = 30) => ({ fps, scenes });
const covers = layout => {   // the ranges, in order, cover [0, totalFrames) with no gap and no overlap
  const all = [...layout.scenes, ...layout.transitions].sort((a, b) => a.start - b.start);
  let at = 0;
  for (const r of all) { assert.equal(r.start, at, `${r.file || r.type} starts at ${r.start}, expected ${at}`); assert.ok(r.end > r.start); at = r.end; }
  assert.equal(at, layout.totalFrames);
};
const overlap = (a, b) => a.start < b.end && b.start < a.end;

test('layout: three scenes and two transitions cover the timeline in order', () => {
  const p = project([{ file: 'a.html', duration: 3 }, { file: 'b.html', duration: 2, transition: { type: 'fade', duration: 0.5 } },
    { file: 'c.html', duration: 1, transition: { type: 'crosswarp', duration: 0.1, ease: 'linear' } }]);
  const scenes = projectScenes(p);
  const layout = projectLayout(p, [90, 60, 30], scenes);
  assert.equal(layout.fps, 30);
  assert.equal(layout.totalFrames, 90 + 60 + 30 - 15 - 3);
  assert.deepEqual(layout.scenes.map(s => [s.start, s.end, s.frames, s.pageFrames]), [[0, 75, 75, 90], [90, 132, 42, 60], [135, 162, 27, 30]]);
  assert.deepEqual(layout.transitions.map(t => [t.type, t.start, t.end, t.frames]), [['fade', 75, 90, 15], ['crosswarp', 132, 135, 3]]);
  assert.deepEqual(layout.transitions.map(t => [t.from, t.to]), [['a.html', 'b.html'], ['b.html', 'c.html']]);
  covers(layout);
  for (const s of layout.scenes) for (const t of layout.transitions) assert.ok(!overlap(s, t), `${s.file} overlaps ${t.type}`);
});

test('layout: a transition rounds to the frame grid and is never shorter than one frame', () => {
  const scenes = projectScenes(project([{ file: 'a.html', duration: 1 }, { file: 'b.html', duration: 1, transition: { type: 'fade', duration: 0.05 } },
    { file: 'c.html', duration: 1, transition: { type: 'fade', duration: 0 } }]));
  assert.deepEqual(scenes.map(s => s.transition?.n ?? 0), [0, 2, 1]);   // 0.05 s at 30 fps is 1.5 frames -> 2; 0 -> 1
  const layout = projectLayout(project([{ file: 'a.html' }, { file: 'b.html' }, { file: 'c.html' }]), [30, 30, 30], scenes);
  assert.deepEqual(layout.transitions.map(t => t.frames), [2, 1]);
  assert.equal(layout.totalFrames, 90 - 3);
  covers(layout);
});

test('layout: hard cuts take no frames and leave the total as the sum of the scenes', () => {
  const p = project([{ file: 'a.html' }, { file: 'b.html' }, { file: 'c.html' }]);
  const layout = projectLayout(p, [45, 30, 15], projectScenes(p));
  assert.deepEqual(layout.transitions, []);
  assert.equal(layout.totalFrames, 90);
  covers(layout);
});

test('layout: a scene whose transitions leave it no frame of its own fails, naming the scene', () => {
  const p = project([{ file: 'scenes/a.html' }, { file: 'scenes/b.html', transition: { type: 'fade', duration: 0.3 } },
    { file: 'scenes/c.html', transition: { type: 'fade', duration: 0.3 } }]);
  const scenes = projectScenes(p);
  // b.html has 20 frames and hands 9 + 9 of them to its transitions: 2 frames left, still fine
  assert.equal(projectLayout(p, [30, 20, 30], scenes).scenes[1].frames, 2);
  // 17 frames would leave 17 - 18 = -1
  assert.throws(() => projectLayout(p, [30, 17, 30], scenes), /scene 2 \(scenes\/b\.html\).*leaving -1/);
  // and exactly 18 leaves 0, which is also too few
  assert.throws(() => projectLayout(p, [30, 18, 30], scenes), /scene 2 \(scenes\/b\.html\).*leaving 0/);
});

test('layout: a scene of one frame with a transition into it has nothing left', () => {
  const p = project([{ file: 'a.html' }, { file: 'b.html', transition: { type: 'fade', duration: 0.2 } }], 25);
  assert.throws(() => projectLayout(p, [25, 5], projectScenes(p)), /scene 2 \(b\.html\) has 5 frames.*leaving 0/);
});

test('layout: scene "duration" sets its frame count, on the frame grid', () => {
  const scenes = projectScenes(project([{ file: 'a.html', duration: 2.5 }, { file: 'b.html', duration: 1.98 }], 30));
  assert.equal(scenes[0].declaredFrames, 75); assert.equal(scenes[1].declaredFrames, 59);
  const layout = projectLayout(project([{ file: 'a.html' }, { file: 'b.html' }], 30), scenes.map(s => s.declaredFrames), scenes);
  assert.equal(layout.totalFrames, 134);
  covers(layout);
  assert.throws(() => projectScenes(project([{ file: 'a.html', duration: 0 }])), /"duration" must be a positive number of seconds/);
  assert.throws(() => projectScenes(project([{ file: 'a.html', duration: 'x' }])), /"duration" must be a positive number/);
});

test('layout: a bad transition is still rejected before any layout', () => {
  assert.throws(() => projectScenes(project([{ file: 'a.html' }, { file: 'b.html', transition: { type: 'nope', duration: 1 } }])), /unknown transition "nope"/);
  assert.throws(() => projectScenes(project([{ file: 'a.html', transition: { type: 'fade', duration: 1 } }])), /scene 1 \(a\.html\) has a transition/);
  assert.throws(() => projectScenes(project([{ file: 'a.html' }, { file: 'b.html', transition: { type: 'fade', duration: 1, ease: 'nope' } }])), /unknown ease "nope"/);
});

test('layout: the layout file sits beside the output, named after it', () => {
  assert.equal(layoutPath(join('out', 'promo.mp4')), join('out', 'promo.layout.json'));
  assert.equal(layoutPath(join('out', 'promo-tiktok.mp4')), join('out', 'promo-tiktok.layout.json'));
  assert.equal(layoutPath(join('out', 'promo.mov')), join('out', 'promo.layout.json'));
});

test('layout: window.TOTAL is read from a page without a browser when it is a literal', () => {
  assert.equal(readTotal('<script>window.TOTAL = 3;</script>'), 3);
  assert.equal(readTotal('window.TOTAL = 2.5'), 2.5);
  assert.equal(readTotal('window.TOTAL=0.5;'), 0.5);
  assert.equal(readTotal('window.TOTAL = 4 // four seconds\n'), 4);
  assert.equal(readTotal('const END = 8; window.TOTAL = END;'), 8);   // the skill's template style
  assert.equal(readTotal('const W = 1920, H = 1080; const END = 8; window.TOTAL = END;'), 8);
  // a TOTAL that is not a literal is left to the browser, never guessed
  for (const src of ['window.TOTAL = END;', 'window.TOTAL = 1.5 * fps;', 'const TOTAL = 4;', 'function scene(total) { window.TOTAL = total; }',
    'window.TOTAL = "4";', '// window.TOTAL = 4\n']) assert.equal(readTotal(src), undefined, src);
});

test('layout: frames come from "duration", else a TOTAL literal, else a browser measurement', () => {
  const p = { ...project([{ file: 'a.html', duration: 2 }, { file: 'b.html' }, { file: 'c.html' }, { file: 'd.html' }]), root: 'proj' };
  const files = { 'b.html': 'window.TOTAL = 1.5;', 'c.html': 'window.TOTAL = END;', 'd.html': 'window.TOTAL = 0;' };
  const counts = sceneFrameCounts(p, projectScenes(p), f => files[f.split(/[\\/]/).pop()] ?? '');
  assert.deepEqual(counts.map(c => [c.frames, c.from]), [[60, 'duration'], [45, 'TOTAL'], [undefined, 'measure'], [undefined, 'bad']]);
});
