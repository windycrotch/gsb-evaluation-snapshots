import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cubicBezier, ease, spring, stagger, tween } from '../src/page/motion.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTransition, isTransitionFile, layerFrames, layerProgress, parseTransition, transitionHead, transitionNames, transitionOverlap, transitionProgress, transitionTail } from '../src/page/transitions.js';
import { projectScenes } from '../src/project.js';

const near = (a, b, d = 1e-3) => assert.ok(Math.abs(a - b) <= d, `${a} is not within ${d} of ${b}`);

test('every easing starts at 0 and ends at 1', () => {
  for (const [name, e] of Object.entries(ease)) { near(e(0), 0, 1e-6); near(e(1), 1, 1e-6); assert.ok(Number.isFinite(e(0.5)), name); }
});

test('cubicBezier matches CSS ease and is the identity on a straight line', () => {
  near(cubicBezier(0.25, 0.1, 0.25, 1)(0.5), 0.8024, 2e-4);   // CSS "ease" at half time
  const line = cubicBezier(0.3, 0.3, 0.7, 0.7);
  for (const k of [0.1, 0.37, 0.9]) near(line(k), k, 1e-5);
});

test('spring starts at 0 with the given velocity and settles at 1', () => {
  for (const cfg of [{ damping: 10 }, { damping: 20 }, { damping: 40 }, { damping: 12, velocity: 5 }]) {   // under, critical, over damped
    const s = spring({ stiffness: 100, mass: 1, ...cfg }), h = 1e-5;
    near(s(h) / h, cfg.velocity || 0, 0.01);
    near(s(s.duration), 1, 1e-3); near(s(s.duration + 3), 1, 1e-3);
    assert.ok(s.duration > 0 && s.duration < 30);
  }
  const bouncy = spring({ stiffness: 100, damping: 10 });
  assert.ok(Math.max(...Array.from({ length: 200 }, (_, i) => bouncy(i / 100))) > 1.15, 'damping ratio 0.5 overshoots by 16%');
  const critical = spring({ stiffness: 100, damping: 20 }); let last = 0;
  for (let t = 0; t < 2; t += 0.01) { assert.ok(critical(t) >= last - 1e-9); last = critical(t); }
});

test('tween holds outside its keys and blends numbers and arrays', () => {
  const keys = [[1, 0], [2, 10, ease.linear], [3, 10]];
  assert.equal(tween(0, keys), 0); assert.equal(tween(1.5, keys), 5); assert.equal(tween(9, keys), 10);
  assert.deepEqual(tween(0.5, [[0, [0, 0]], [1, [10, 20], ease.linear]]), [5, 10]);
});

test('stagger spaces items from the start, the end or the centre', () => {
  assert.equal(stagger(2, 0.1, 1), 1.2);
  near(stagger(0, 0.1, 0, { n: 5, from: 'end' }), 0.4, 1e-12);
  assert.equal(stagger(2, 0.1, 0, { n: 5, from: 'center' }), 0);
});

test('transitions are found by any case and their progress covers the frame middles', () => {
  assert.equal(findTransition('CROSSWARP').name, 'crosswarp');
  assert.throws(() => findTransition('nope'), /use one of/);
  near(transitionProgress(0, 2, 'linear'), 0.25, 1e-12); near(transitionProgress(1, 2, 'linear'), 0.75, 1e-12);
  assert.throws(() => transitionProgress(0, 2, 'wobble'), /unknown ease/);
  for (const name of transitionNames) assert.match(findTransition(name).glsl, /vec4 transition\s*\(/);
});

test('project scenes accept paths and objects with transitions', () => {
  const s = projectScenes({ fps: 30, scenes: ['a.html', { file: 'b.html', transition: { type: 'fade', duration: 0.5 } }] });
  assert.deepEqual(s[0], { file: 'a.html' });
  assert.equal(s[1].transition.n, 15); assert.equal(s[1].transition.ease, 'inOutCubic');
  assert.throws(() => projectScenes({ fps: 30, scenes: [{ file: 'a.html', transition: { type: 'fade', duration: 1 } }] }), /no scene before it/);
  assert.throws(() => projectScenes({ fps: 30, scenes: ['a.html', { file: 'b.html', transition: { type: 'zap', duration: 1 } }] }), /scene 2 .*unknown transition/);
});

test('a .glsl transition file: its uniforms and their defaults are read as gl-transitions writes them', () => {
  // the built-in shaders come back with the types and defaults listed next to them
  for (const name of transitionNames) {
    const t = findTransition(name), parsed = parseTransition(t.glsl, name);
    assert.deepEqual([parsed.types, parsed.defaults], [t.types, t.defaults], name);
  }
  const t = parseTransition(`uniform float amount; // = 0.25
uniform vec3 tint;// = vec3(1.0)
uniform float soft/* = 0.4 */; // a note after the default
uniform bool flip; // = true
uniform int steps; // = 6
uniform vec2 dir;
uniform ivec2 grid; // = ivec2(4)
// uniform float old; // = 9.0
vec4 transition(vec2 uv) { return mix(getFromColor(uv), getToColor(uv), progress * amount); }`, 'mine.glsl');
  assert.deepEqual(t.types, { amount: 'float', tint: 'vec3', soft: 'float', flip: 'bool', steps: 'int', dir: 'vec2', grid: 'ivec2' });
  assert.deepEqual(t.defaults, { amount: 0.25, tint: [1, 1, 1], soft: 0.4, flip: true, steps: 6, grid: [4, 4] });
  assert.throws(() => parseTransition('vec4 main2(vec2 uv) { return vec4(1.0); }', 'x.glsl'), /no vec4 transition/);
  assert.throws(() => parseTransition('uniform sampler2D map;\nvec4 transition(vec2 uv) { return vec4(1.0); }', 'x.glsl'), /map is a sampler2D/);
  assert.throws(() => parseTransition('uniform float progress;\nvec4 transition(vec2 uv) { return vec4(1.0); }', 'x.glsl'), /progress, which motlab sets/);
  assert.ok(isTransitionFile('transitions/Swirl.GLSL') && !isTransitionFile('fade'));
  // projectScenes keeps the path as the type and checks the file when it knows the project folder
  const dir = mkdtempSync(join(tmpdir(), 'motlab-glsl-'));
  try {
    mkdirSync(join(dir, 't')); writeFileSync(join(dir, 't', 'mine.glsl'), 'vec4 transition(vec2 uv) { return getToColor(uv); }');
    const p = { fps: 30, scenes: ['a.html', { file: 'b.html', transition: { type: 't/mine.glsl', duration: 0.5 } }] };
    assert.equal(projectScenes(p, dir)[1].transition.type, 't/mine.glsl');
    p.scenes[1].transition.type = 't/gone.glsl';
    assert.throws(() => projectScenes(p, dir), /scene 2 .*t\/gone\.glsl does not exist/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a layer transition splits its frames around the cut and takes no time from the video', () => {
  assert.deepEqual(layerFrames(15), { before: 7, after: 8 });
  assert.deepEqual(layerFrames(1), { before: 0, after: 1 });
  const layer = { layer: 'swish.js', n: 15 }, shader = { type: 'fade', n: 15 };
  assert.deepEqual([transitionHead(layer), transitionTail(layer), transitionOverlap(layer)], [8, 7, 0]);
  assert.deepEqual([transitionHead(shader), transitionTail(shader), transitionOverlap(shader)], [15, 15, 15]);
  assert.equal(layerProgress(7, 14), 0.5357142857142857);   // the first frame after the cut is just past 0.5
  const p = { fps: 30, scenes: ['a.html', { file: 'b.html', transition: { layer: 'swish.js', duration: 0.5 } }] };
  assert.equal(projectScenes(p)[1].transition.n, 15);
  p.scenes[1].transition.type = 'fade';
  assert.throws(() => projectScenes(p), /"type" .* or "layer" .*, not both/);
  assert.throws(() => projectScenes({ fps: 30, scenes: ['a.html', { file: 'b.html', transition: { layer: 'swish.glsl', duration: 0.5 } }] }), /must be a \.js module/);
});
