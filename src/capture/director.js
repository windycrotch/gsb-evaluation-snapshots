import * as THREE from 'three';
import '@fontsource-variable/archivo/wdth.css';
import '../ui/style.css';
import './title.css';
import { Bot } from '../sim/ai.js';
import { HUD } from '../ui/hud.js';
import { AudioEngine, renderOffline, soundForEvent } from '../audio/audio.js';
import { INST, SFX, scheduleBar, BAR, BEAT } from '../audio/synth.js';
import { ST } from '../sim/constants.js';
import { ease, sat, lerp, TAU } from '../core/math.js';

// The showcase film. Each shot stages a short piece of real gameplay: fighters are placed, the
// bots are given a directive (run this combo, parry, fire that special) and the simulation plays
// it out while a scripted camera films it. Nothing is keyframed: every hit, effect and sound
// comes out of the game systems.
//
// Timing sits on a 150 BPM grid (beat = 0.4 s): every cut lands on a beat, section changes on
// bar lines of the score, which starts with a 0.8 s pickup so the first drop falls at 4.0 s.

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const FULL = ['L', 'L', 'L', 'L', 'JUMP', 'L', 'L', 'H'];
const CLASH_MAX = 4.618; // seconds of beam struggle; tuned so the detonation lands on the 28.0 s bar line

export function makeShowcase(params) {
  const only = params.get('only');
  let stage, hud, title, audio;
  let bots = [null, null];
  let cur = null, curIdx = -1, w = null;
  const cine = { pos: V(0, 2, 12), target: V(0, 1.2, 0), fov: 36, roll: 0 };
  const sm = new Map();
  const follow = (key, x, y, z, lambda, h) => {
    let v = sm.get(key);
    if (!v) { v = V(x, y, z); sm.set(key, v); return v; }
    const k = 1 - Math.exp(-lambda * h);
    v.x += (x - v.x) * k; v.y += (y - v.y) * k; v.z += (z - v.z) * k;
    return v;
  };
  const F = (i) => w.fighters[i];
  const mid = () => ({ x: (F(0).x + F(1).x) / 2, y: (F(0).y + F(1).y) / 2, z: (F(0).z + F(1).z) / 2 });
  const dir = (i, d) => { bots[i].directive = d; };
  const look = (o) => Object.assign(stage.R.look, o);
  // Stage the beam struggle: both bots mash, and their rates are nudged so the clash point follows
  // the story (pushed back, recovered, dead level) instead of whoever rolled better.
  const steerClash = (target) => {
    const C = w.clash;
    if (!C.on) return;
    const err = target - C.c;
    bots[0].directive.mash = Math.max(2, Math.min(19, 9.5 + err * 70));
    bots[1].directive.mash = Math.max(2, Math.min(19, 9.5 - err * 70));
  };

  function fresh(seed, { x0 = -4.5, x1 = 4.5, z0 = 0, z1 = 0, hp = [100, 100], energy = [0, 0], active = true } = {}) {
    w = stage.newWorld({ chars: ['clawd', 'codex'], seed });
    bots = [new Bot(0, 'nightmare', seed * 31 + 7), new Bot(1, 'nightmare', seed * 17 + 3)];
    stage.controllers = bots.map((b) => (wd, dt) => b.think(wd, dt));
    const [a, b] = w.fighters;
    a.x = x0; a.z = z0; b.x = x1; b.z = z1;
    a.yaw = Math.atan2(b.x - a.x, b.z - a.z); b.yaw = Math.atan2(a.x - b.x, a.z - b.z);
    a.hp = hp[0]; b.hp = hp[1]; a.energy = energy[0]; b.energy = energy[1];
    if (active) w.begin();
    for (const ac of stage.actors) { ac.heatMin = 0; ac.stance = 0; }
    dir(0, { do: 'idle', noDefense: true, noTech: true });
    dir(1, { do: 'idle', noDefense: true, noTech: true });
    sm.clear();
    stage.rig.cine = cine;
    stage.timeScale = 1;
    stage.slow.t = 0;
    return w;
  }
  // camera placed relative to the line between the fighters: side = distance off the axis
  // (+ keeps Clawd on screen-left when he stands at -x), along = shift toward fighter 1
  function twoShot(h, { side = 8, height = 1.5, along = 0, ty = 1.2, lam = 6, tBias = 0.5, fov = 36 } = {}) {
    const a = F(0), b = F(1);
    const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz) || 1;
    const ax = dx / d, az = dz / d;
    const m = follow('mid', a.x + dx * tBias, (a.y + b.y) * 0.5, a.z + dz * tBias, lam, h);
    cine.pos.set(m.x - az * side + ax * along, height + m.y * 0.4, m.z + ax * side + az * along);
    cine.target.set(m.x, ty + m.y * 0.8, m.z);
    cine.fov = fov;
  }

  // ------------------------------------------------------------------------------------ the shots
  const shots = [
    {
      id: 'faceoff', dur: 1.6,
      init() {
        fresh(11, { x0: -2.75, x1: 2.75, z0: 0.3, z1: 0.3, energy: [100, 100], active: false });
        stage.actors[0].stance = -0.62; stage.actors[1].stance = 0.62;
        stage.actors[0].heatMin = 0.1; stage.actors[1].heatMin = 0.14;
        look({ dof: 7, focusRange: 7 });
      },
      cam(t, h) {
        const k = ease.inOut(t / 1.6);
        cine.pos.set(lerp(0.2, -0.15, k), lerp(0.8, 0.95, k), lerp(10.3, 8.7, k));
        cine.target.set(-0.12, 1.14, 0.3);
        cine.fov = 30;
        stage.R.look.focus = cine.pos.z - 0.3;
        // keep both of them visibly charged
        const r = stage.vfx.rng;
        if (r.chance(h * 14)) { const f = F(1); stage.vfx.arcs(f.x + r.range(-0.5, 0.5), f.y + r.range(0.5, 1.9), f.z + r.range(-0.3, 0.5), 1, 1.3, { life: 0.12, width: 0.055, intensity: 10 }); }
      },
    },
    {
      id: 'charge', dur: 2.4,
      init(at) {
        fresh(12, { x0: -6.2, x1: 6.2, energy: [100, 100] });
        stage.actors[0].heatMin = 0.12; stage.actors[1].heatMin = 0.16;
        look({ dof: 4, focusRange: 12 });
        at(0.1, () => { stage.vfx.powerUp(F(0), 0, 1.2); stage.vfx.powerUp(F(1), 1, 1.2); audio.cue('boom', { size: 0.7 }); });
        at(1.42, () => { dir(0, { do: 'tap', btn: 'DASH', fwd: 1, any: true, noDefense: true }); dir(1, { do: 'tap', btn: 'DASH', fwd: 1, any: true, noDefense: true }); });
        at(1.5, () => { dir(0, { do: 'tap', btn: 'L', any: true, noDefense: true }); dir(1, { do: 'tap', btn: 'L', any: true, noDefense: true }); });
        at(2.2, () => { dir(0, { do: 'idle' }); dir(1, { do: 'idle' }); });
      },
      on(e) { if (e.type === 'clang') stage.slowmo(0.14, 0.75); },
      cam(t, h) {
        const k = ease.inOut(sat((t - 1.2) / 0.5));
        twoShot(h, { side: lerp(15.5, 8.6, k) - 1.4 * ease.outCubic(sat((t - 1.7) / 0.7)), height: lerp(0.7, 1.1, k), ty: 1.3, fov: lerp(34, 38, k), lam: 20 });
        cine.pos.x += Math.sin(t * 0.7) * 0.4;
        stage.R.look.focus = cine.pos.distanceTo(cine.target);
      },
    },
    {
      id: 'combo', dur: 1.2,
      init() {
        fresh(13, { x0: -1.25, x1: 1.1 });
        dir(0, { do: 'script', script: FULL, range: 3, noDefense: true });
        look({ dof: 4, focusRange: 8 });
      },
      cam(t, h) {
        twoShot(h, { side: 5.6 - t * 0.5, height: 1.25, along: -0.6 + t * 0.9, ty: 1.15, fov: 38, lam: 9 });
        stage.R.look.focus = cine.pos.distanceTo(cine.target);
      },
    },
    {
      id: 'air', dur: 2.0, cont: true,
      init() { look({ dof: 3, focusRange: 14 }); sm.clear(); },
      on(e) { if (e.type === 'slam') stage.slowmo(0.22, 0.7); },
      cam(t, h) {
        const a = F(0), b = F(1);
        const m = follow('m', (a.x + b.x) / 2, Math.max(a.y, b.y) * 0.62, (a.z + b.z) / 2, 7, h);
        cine.pos.set(m.x + 2.4 - t * 0.6, 0.55, m.z + 8.2 - t * 0.5);
        cine.target.set(m.x, 1.3 + m.y, m.z);
        cine.fov = 40;
        stage.R.look.focus = cine.pos.distanceTo(cine.target);
      },
    },
    {
      id: 'thunder', dur: 1.6,
      init(at) {
        fresh(14, { x0: -8.2, x1: -5.9, z0: 1, z1: 1 });
        dir(1, { do: 'script', script: ['L', 'L', 'H'], range: 3, noDefense: true });
        look({ dof: 3, focusRange: 12 });
      },
      cam(t, h) {
        const a = F(0), b = F(1);
        const launched = a.state === ST.LAUNCH || a.state === ST.DOWN;
        const m = follow('m', launched ? a.x * 0.7 + b.x * 0.3 : (a.x + b.x) / 2, a.y * 0.5, a.z, launched ? 4.5 : 8, h);
        cine.pos.set(m.x + 3.2 + t * 0.4, 1.0, m.z + 7.4);
        cine.target.set(m.x, 1.25 + m.y, m.z);
        cine.fov = 40;
        stage.R.look.focus = cine.pos.distanceTo(cine.target);
      },
    },
    {
      id: 'parry', dur: 1.6,
      init(at) {
        fresh(15, { x0: -2.5, x1: 2.3 });
        at(0.02, () => dir(0, { do: 'tap', btn: 'H', noDefense: true }));
        dir(1, { do: 'idle', defense: 'parry' });
        look({ dof: 5, focusRange: 7 });
      },
      on(e) { if (e.type === 'parry') { dir(1, { do: 'script', script: ['L', 'L', 'L', 'L', 'JUMP', 'L', 'H'], range: 3.4, dash: false, noDefense: true }); dir(0, { do: 'idle', noDefense: true, noTech: true }); } },
      cam(t, h) {
        const b = F(1), a = F(0);
        const m = follow('m', (a.x + b.x) / 2 + 0.6, (a.y + b.y) * 0.35, 0, 7, h);
        const ang = -0.75 + t * 0.32;
        cine.pos.set(m.x + Math.sin(ang) * 6.2, 1.15 + t * 0.15, m.z + Math.cos(ang) * 6.2);
        cine.target.set(m.x, 1.2 + m.y, m.z);
        cine.fov = 36;
        stage.R.look.focus = cine.pos.distanceTo(cine.target);
      },
    },
    {
      id: 'embers', dur: 1.6,
      init(at) {
        fresh(16, { x0: -6, x1: 6 });
        at(0.02, () => dir(0, { do: 'tap', btn: 'S1', noDefense: true }));
        dir(1, { do: 'idle', defense: 'dodge' });
        at(0.86, () => dir(1, { do: 'tap', btn: 'S1', any: true, noDefense: true }));
        look({ dof: 3, focusRange: 16 });
      },
      cam(t, h) {
        const a = F(0), b = F(1);
        cine.pos.set(a.x - 3.4 + t * 0.5, 1.75, a.z + 2.9 - t * 0.3);
        const tg = follow('t', b.x * 0.75 + a.x * 0.25, 1.2, b.z * 0.75, 6, h);
        cine.target.copy(tg);
        cine.fov = 38;
        stage.R.look.focus = 9;
      },
    },
    {
      id: 'storm', dur: 1.6,
      init(at) {
        fresh(17, { x0: -3.5, x1: 8.5, z0: -0.5, z1: -1 });
        at(0.0, () => dir(1, { do: 'tap', btn: 'S2', noDefense: true }));
        dir(0, { do: 'walk', fwd: 1, strafe: 0.25, noDefense: true, noTech: true });
        look({ dof: 0 });
      },
      cam(t, h) {
        const a = F(0);
        const m = follow('m', a.x * 0.7 + 1.5, 0, a.z, 3, h);
        cine.pos.set(m.x - 4.5 + t * 0.7, 6.6 - t * 0.5, 12.2 - t * 0.6);
        cine.target.set(m.x + 1.2, 2.6, m.z);
        cine.fov = 46;
      },
    },
    {
      id: 'erupt', dur: 1.6,
      init(at) {
        fresh(18, { x0: -5.2, x1: 5.3 });
        at(0.0, () => dir(0, { do: 'tap', btn: 'S2', noDefense: true }));
        look({ dof: 3, focusRange: 14 });
      },
      cam(t, h) {
        const b = F(1);
        cine.pos.set(7.6 - t * 0.9, 0.9 + t * 0.25, 9.2 - t * 0.5);
        const tg = follow('t', 1.4, 1.7 + b.y * 0.5, 0, 5, h);
        cine.target.copy(tg);
        cine.fov = 40;
        stage.R.look.focus = 10;
      },
    },
    {
      id: 'crossfire', dur: 1.6,
      init(at) {
        fresh(19, { x0: -7.2, x1: 7.2 });
        at(0.0, () => { dir(0, { do: 'tap', btn: 'S1', noDefense: true }); dir(1, { do: 'tap', btn: 'S1', noDefense: true }); });
        look({ dof: 3, focusRange: 14 });
      },
      on(e) { if (e.type === 'proj_clash') stage.slowmo(0.2, 0.55); },
      cam(t, h) {
        twoShot(h, { side: 14.5 - t * 1.8, height: 1.0 + t * 0.25, ty: 1.3, fov: 40, lam: 5, along: -0.8 + t });
        stage.R.look.focus = cine.pos.distanceTo(cine.target);
      },
    },
    {
      id: 'gameplay', dur: 4.8, hud: true,
      init() {
        fresh(+(params.get('gseed') || 49), { x0: -3.4, x1: 3.4, hp: [72, 66], energy: [38, 52] });
        dir(0, { do: 'free' }); dir(1, { do: 'free' });
        stage.rig.cine = null;
        stage.rig.snap = true;
        stage.player = 0;
        look({ dof: 0 });
        hud.setup(w, 0, [1, 1], { minimal: true });
        w.timeLeft = 61.4;
      },
      cam() {},
    },
    {
      id: 'stare', dur: 0.8,
      init(at) {
        fresh(21, { x0: -6.6, x1: 6.6, hp: [34, 31], energy: [100, 100] });
        w.clash.max = +(params.get('clash') || CLASH_MAX);
        stage.actors[0].heatMin = 0.14; stage.actors[1].heatMin = 0.18;
        at(0.5, () => dir(0, { do: 'tap', btn: 'ULT', noDefense: true, mash: 9.5 }));
        dir(1, { do: 'idle', defense: 'ult', mash: 9.5 });
        look({ dof: 3, focusRange: 16 });
      },
      cam(t, h) {
        twoShot(h, { side: 15 - t * 2.2, height: 0.75, ty: 1.4, fov: 34, lam: 20 });
        stage.R.look.focus = cine.pos.distanceTo(cine.target);
      },
    },
    {
      id: 'ult-charge', dur: 0.8, cont: true,
      init() { look({ dof: 6, focusRange: 5 }); },
      cam(t) {
        const f = F(0);
        const ang = f.yaw - 0.55 - t * 0.9, d = 4.3 - t * 0.9;
        cine.pos.set(f.x + Math.sin(ang) * d, 0.95 + t * 0.4, f.z + Math.cos(ang) * d);
        cine.target.set(f.x, 1.25, f.z);
        cine.fov = 36;
        stage.R.look.focus = d;
      },
    },
    {
      id: 'ult-fire', dur: 0.8, cont: true, noSlow: true,
      init() { look({ dof: 0 }); sm.clear(); },
      cam(t) {
        const f = F(0);
        cine.pos.set(-3 + t * 2.2, 5.6 - t * 1.1, 17.5 - t * 1.6);
        cine.target.set(0.4, 1.2, 0);
        cine.fov = 42;
      },
    },
    {
      id: 'clash-wide', dur: 1.2, cont: true,
      init() { look({ dof: 0 }); },
      cam(t, h) {
        const C = w.clash;
        steerClash(lerp(0.7, 0.42, sat(t / 1.0)));
        cine.pos.set(C.x * 0.3 + 1.5 - t * 1.2, 1.1 + t * 0.25, 15.5 - t * 1.6);
        cine.target.set(C.x * 0.5, 1.45, 0);
        cine.fov = 40;
      },
    },
    {
      id: 'clash-clawd', dur: 0.8, cont: true,
      init() { look({ dof: 4, focusRange: 9 }); },
      cam(t) {
        const f = F(0);
        steerClash(lerp(0.42, 0.66, sat(t / 0.7)));
        cine.pos.set(f.x + 3.3 - t * 0.5, 0.7, f.z + 2.5);
        cine.target.set(f.x - 0.2, 1.3, f.z);
        cine.fov = 34;
        stage.R.look.focus = 4.2;
      },
    },
    {
      id: 'clash-codex', dur: 0.8, cont: true,
      init() { look({ dof: 4, focusRange: 9 }); },
      cam(t) {
        const f = F(1);
        steerClash(lerp(0.66, 0.34, sat(t / 0.7)));
        cine.pos.set(f.x - 3.1 + t * 0.5, 0.8, f.z + 2.4);
        cine.target.set(f.x + 0.2, 1.35, f.z);
        cine.fov = 34;
        stage.R.look.focus = 4;
      },
    },
    {
      id: 'clash-peak', dur: 1.2, cont: true,
      init() { look({ dof: 0 }); },
      cam(t) {
        const C = w.clash;
        steerClash(lerp(0.34, 0.5, sat(t / 0.6)));
        const k = ease.inOut(t / 1.2);
        const ang = -0.9 + k * 1.15;
        const d = lerp(17, 9.5, k);
        cine.pos.set(C.x + Math.sin(ang) * d, lerp(8.5, 2.2, k), C.z + Math.cos(ang) * d);
        cine.target.set(C.x, 1.4, C.z);
        cine.fov = 42;
      },
    },
    {
      id: 'boom', dur: 1.2, cont: true,
      init() { look({ dof: 0 }); stage.slowmo(0.3, 1.1); },
      cam(t) {
        cine.pos.set(-1.5 + t * 0.8, 2.4 + t * 0.9, 17.5 + t * 2.2);
        cine.target.set(0, 2.2 + t * 0.5, 0);
        cine.fov = 44;
      },
    },
    {
      id: 'rise', dur: 1.6,
      init(at) {
        fresh(31, { x0: -5.2, x1: 5.2, hp: [9, 9], energy: [0, 0] });
        look({ dof: 4, focusRange: 12 });
        // the dust has not settled yet
        const v = stage.vfx, r = v.rng;
        for (let i = 0; i < 46; i++) v.puff(r.range(-9, 9), r.range(0.3, 3.2), r.range(-5, 3), r.range(-0.6, 0.6), r.range(0.1, 0.5), r.range(-0.3, 0.3), r.range(2.2, 4), r.range(1.6, 2.6), r.range(3, 4.6), 0, 0, 0.36, 0.1, 0.3, 0.1, 0.4);
        for (let i = 0; i < 5; i++) v.decals.add(r.range(-4, 4), r.range(-2.5, 2.5), r.range(2, 3.6), { mode: i % 2, life: 14, intensity: 1.1, seed: r.next(), r: 0.3, g: 0.3, b: 0.3 });
        stage.actors[0].heatMin = 0.1; stage.actors[1].heatMin = 0.14;
        at(1.2, () => { dir(0, { do: 'tap', btn: 'DASH', fwd: 1, any: true, noDefense: true }); dir(1, { do: 'tap', btn: 'DASH', fwd: 1, any: true, noDefense: true }); });
        at(1.28, () => { dir(0, { do: 'tap', btn: 'L', any: true, noDefense: true }); dir(1, { do: 'tap', btn: 'L', any: true, noDefense: true }); });
        this.fz = 1; this.frozen = false;
      },
      // the instant before they connect, time grinds to a halt
      ts() {
        if (Math.hypot(F(1).x - F(0).x, F(1).z - F(0).z) < 5.15) this.frozen = true;
        if (this.frozen) this.fz = Math.max(0.003, this.fz - 0.13);
        return this.fz;
      },
      cam(t, h) {
        twoShot(h, { side: 13.5 - t * 2.4, height: 0.62, ty: 1.25, fov: 34, lam: 20 });
        stage.R.look.focus = cine.pos.distanceTo(cine.target);
      },
    },
    {
      id: 'title', dur: 2.4, cont: true, title: true,
      init() { stage.timeScale = 0; look({ dof: 0 }); },
      ts() { return 0; },
      // the world is frozen, but the speed streaks are allowed to burn out so the name sits on a calm frame
      cam(t, h) { stage.vfx.trails.update(h, stage.camera); },
    },
  ];

  let T0 = 0;
  for (const s of shots) { s.start = T0; T0 += s.dur; }
  const list = only ? shots.filter((s) => only.split(',').includes(s.id)) : shots;
  if (only) { let t = 0; for (const s of list) { s.start = t; t += s.dur; } }
  const duration = list.reduce((a, s) => a + s.dur, 0);
  let pending = [];

  function enter(i) {
    curIdx = i;
    cur = list[i];
    pending = [];
    const at = (time, fn) => pending.push({ time, fn });
    if (only && cur.cont && i === 0) {
      // running a continuation shot on its own: replay the shots it depends on, unrendered
      throw new Error(`shot "${cur.id}" continues the previous one; include its parents in only=`);
    }
    cur.init?.(at);
    hud.show(!!cur.hud);
    title.el.style.opacity = 0;
  }

  const tick = {}, tally = {};
  return {
    duration,
    async setup(st) {
      stage = st;
      const ui = document.getElementById('ui');
      hud = new HUD(ui);
      title = { el: document.createElement('div') };
      title.el.className = 'film-title';
      title.el.innerHTML = '<span>Merge Conflict</span>';
      ui.appendChild(title.el);
      audio = new AudioEngine({ record: true });
      stage.onEvent = (e, wd) => {
        soundForEvent(e, wd, audio, stage.camera);
        hud.onEvent(e, wd);
        cur?.on?.(e);
        if (e.type === 'clang' || e.type === 'clash_end' || e.type === 'parry' || e.type === 'slam' || e.type === 'proj_clash' || e.type === 'wall' || e.type === 'dodge') console.log('[director]', e.type, 'at', audio.clock.toFixed(3), cur.id);
        if (cur && cur.id === 'gameplay') { tally[e.type] = (tally[e.type] || 0) + 1; if (e.type === 'hit' && e.combo > (tally.maxCombo || 0)) tally.maxCombo = e.combo; }
      };
      await document.fonts.load('800 40px "Archivo Variable"');
      await document.fonts.ready;
      enter(0);
      // pre-roll so frame 0 already has fire in the braziers, motes in the air and both auras lit
      if (list[0].id === 'faceoff') {
        for (let i = 0; i < 150; i++) { list[0].cam(0, 1 / 60); stage.step(1 / 60); }
        audio.log.length = 0;
      }
    },
    tick(t, h) {
      audio.clock = t;
      if (w && w.clash.on && !tick.c0) { tick.c0 = t; console.log('[director] clash starts at', t.toFixed(3)); }
      let i = curIdx;
      while (i + 1 < list.length && t >= list[i + 1].start - 1e-6) i++;
      if (i !== curIdx) { if (cur && cur.id === 'gameplay') console.log('[director] gameplay tally', JSON.stringify(tally)); enter(i); }
      const lt = t - cur.start;
      for (let k = 0; k < pending.length; k++) if (lt >= pending[k].time) { pending[k].fn(); pending.splice(k--, 1); }
      if (cur.ts) stage.timeScale = cur.ts(lt);
      if (cur.noSlow) stage.slow.t = 0; // the ignition plays at full speed; the struggle that follows is the held beat
      cur.cam(lt, h);
      if (cur.hud) hud.update(w, h * stage.timeScale);
      const L = stage.R.look;
      if (cur.title) {
        // lockup: the frozen frame sinks, the name settles in
        const k = ease.outCubic(sat(lt / 0.5));
        L.fade = lerp(1, 0.032, k); L.sat = lerp(1.06, 0.4, k);
        L.dof = 18 * k; L.focus = 0.5; L.focusRange = 2;
        const a = sat((lt - 0.12) / 0.35), sp = title.el.firstChild;
        title.el.style.opacity = a.toFixed(3);
        sp.style.letterSpacing = `${(0.2 - 0.14 * ease.outQuint(sat((lt - 0.12) / 0.7))).toFixed(4)}em`;
        sp.style.transform = `scale(${(1 + 0.035 * sat(lt / cur.dur)).toFixed(4)})`;
      } else { L.fade = 1; L.sat = 1.06; }
      // open on a short lift out of black so frame 0 holds as a poster but the film still "starts"
      if (!only && t < 0.25) L.exposure = lerp(0.86, 1, ease.outCubic(t / 0.25)); else L.exposure = 1;
    },
    cues: () => audio.log,
    async audio(dur) {
      const buf = await renderOffline(audio.log, dur, only ? null : score);
      let bin = '';
      const u8 = new Uint8Array(buf);
      for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      return btoa(bin);
    },
  };
}

// ---------------------------------------------------------------------------------------- score
// Bars start at 0.8 s (pickup) so bar lines fall on 4.0 (first drop), 16.8 (gameplay), 21.6
// (stand-off) and 28.0 (the detonation).
function score(A) {
  const bar = (k) => 0.8 + k * BAR;
  // cold open: a low pad and a slow heartbeat under the stare-down
  INST.pad(A, 0, [38, 45, 50], 2.6, 2.4);
  INST.pad(A, 0, [26], 4.0, 2.0);
  for (const t of [0.0, 0.8, 1.6, 2.0, 2.4, 2.8]) INST.kick(A, t, 0.55);
  INST.riser(A, 1.6, 1.6, 1.1);
  INST.impact(A, 3.2, 0.9);
  INST.pad(A, 3.2, [38, 45, 53], 1.0, 1.6);
  // act one: melee + specials
  for (let k = 2; k < 10; k++) scheduleBar(A, bar(k), k - 2, 3);
  INST.impact(A, bar(2), 0.7);
  INST.impact(A, bar(6), 0.5);
  INST.riser(A, bar(9) + BEAT * 2, BEAT * 2, 0.7);
  // gameplay: half-time, room for the hits
  for (let k = 10; k < 13; k++) scheduleBar(A, bar(k), k - 2, 2, { arp: true });
  INST.riser(A, bar(12), BAR, 0.9);
  // stand-off into the beam struggle
  INST.impact(A, bar(13), 0.8);
  for (let k = 13; k < 17; k++) scheduleBar(A, bar(k), k - 1, 3, { pad: true });
  INST.riser(A, bar(15), BAR * 2, 1.3);
  for (let i = 0; i < 16; i++) INST.snare(A, bar(16) + (i * BEAT) / 4, 0.35 + i * 0.045);
  // detonation, then air
  INST.impact(A, bar(17), 1.2);
  INST.pad(A, bar(17) + 0.6, [38, 45, 50, 53], 2.4, 1.5);
  for (const t of [29.2, 29.6, 30.0, 30.4]) INST.kick(A, t, 0.5);
  INST.riser(A, 29.6, 1.2, 0.6);
  // lockup: one resolved chord as the name lands, long tail
  INST.impact(A, 30.8, 0.55);
  INST.stab(A, 31.05, [50, 57, 62, 65, 69], 2.2, 1.5);
  INST.pad(A, 31.0, [38, 50, 57, 62], 2.3, 2.2);
}
