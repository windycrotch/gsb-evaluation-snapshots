import * as THREE from 'three';
import { makeBus, SFX, HOLD, scheduleBar, BAR, encodeWav } from './synth.js';
import { ULT } from '../sim/moves.js';

// Live playback for the game, or a time-stamped cue log for the showcase capture (which is then
// rendered through the very same synth on an OfflineAudioContext).
export class AudioEngine {
  constructor({ record = false } = {}) {
    this.record = record;
    this.log = [];
    this.clock = 0; // capture timeline (seconds), advanced by the capture session
    this.A = null;
    this.holds = new Map();
    this.level = -1;
    this.nextBar = 0;
    this.bar = 0;
    this.volume = 1.6; // the bus is mixed with headroom for the film master; the game plays it hotter
  }
  unlock() {
    if (this.record || this.A) { this.A?.ctx.resume?.(); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.A = makeBus(new Ctx({ latencyHint: 'interactive' }));
    this.A.master.gain.value = this.volume;
    this._timer = setInterval(() => this._schedule(), 100);
  }
  setVolume(v) { this.volume = v; if (this.A) this.A.master.gain.value = v; }
  cue(name, p = {}) {
    if (this.record) { this.log.push({ t: this.clock, k: 'cue', name, p }); return; }
    if (!this.A || this.A.ctx.state !== 'running') return;
    SFX[name](this.A, this.A.ctx.currentTime + 0.004, p);
  }
  hold(key, name, p = {}) {
    if (this.record) { this.log.push({ t: this.clock, k: 'hold', key, name, p }); return; }
    if (!this.A || this.holds.has(key)) return;
    this.holds.set(key, HOLD[name](this.A, this.A.ctx.currentTime + 0.004, p));
  }
  release(key) {
    if (this.record) { this.log.push({ t: this.clock, k: 'release', key }); return; }
    const h = this.holds.get(key);
    if (h) { h.stop(this.A.ctx.currentTime + 0.01); this.holds.delete(key); }
  }
  releaseAll() { for (const k of [...this.holds.keys()]) this.release(k); }
  // -1 silent · 0 pad · 1 pulse · 2 half-time · 3 full
  music(level) {
    if (level !== this.level && level > this.level && this.A) this.nextBar = 0; // step up right away
    this.level = level;
  }
  _schedule() {
    const A = this.A;
    if (!A || this.level < 0 || A.ctx.state !== 'running') return;
    const now = A.ctx.currentTime;
    if (this.nextBar < now) { this.nextBar = now + 0.06; }
    while (this.nextBar < now + 0.35) {
      scheduleBar(A, this.nextBar, this.bar++, this.level);
      this.nextBar += BAR;
    }
  }
  pause(on) { if (this.A) on ? this.A.ctx.suspend() : this.A.ctx.resume(); }
}

export async function renderOffline(log, duration, score) {
  const sr = 48000;
  const ctx = new OfflineAudioContext(2, Math.ceil(duration * sr), sr);
  const A = makeBus(ctx);
  const holds = new Map();
  for (const e of log) {
    if (e.t >= duration - 0.01) continue;
    if (e.k === 'cue') SFX[e.name](A, e.t, e.p);
    else if (e.k === 'hold') { if (!holds.has(e.key)) holds.set(e.key, HOLD[e.name](A, e.t, e.p)); }
    else if (e.k === 'release') { const h = holds.get(e.key); if (h) { h.stop(e.t); holds.delete(e.key); } }
  }
  for (const [, h] of holds) h.stop(duration - 0.4);
  score?.(A, duration);
  return encodeWav(await ctx.startRendering());
}

const _v = new THREE.Vector3();

// Simulation event → sound. Shared by the game and the showcase capture.
export function soundForEvent(e, world, audio, camera) {
  const F = world.fighters;
  const at = (x, z) => {
    if (!camera) return 0;
    _v.set(x, 1, z).project(camera);
    return Math.max(-0.7, Math.min(0.7, _v.x * 0.6));
  };
  const fpan = (i) => at(F[i].x, F[i].z);
  const pan = e.x !== undefined ? at(e.x, e.z) : e.f !== undefined ? fpan(e.f) : 0;
  const ramp = (i) => (F[i].stats.element === 'fire' ? 0 : 1);
  const c = (name, p = {}) => audio.cue(name, { pan, ...p });
  switch (e.type) {
    case 'swing': c('whoosh', { size: e.kind === 'heavy' || e.kind === 'special' ? 1.5 : 0.8, gain: 0.8 }); break;
    case 'hit':
      if (e.beam) { if (e.blocked) c('block', { gain: 0.35 }); break; }
      if (e.blocked) { c('block'); break; }
      c('hit', { size: e.kind === 'ult' ? 2 : e.kind === 'light' && !e.launch ? 0.55 : 1.1 });
      if (e.element === 'fire') c('fire', { size: e.kind === 'light' ? 0.35 : 0.7, gain: 0.6 });
      else c('zap', { size: e.kind === 'light' ? 0.45 : 0.9, gain: 0.6 });
      break;
    case 'parry': c('parry'); break;
    case 'clang': c('clang'); break;
    case 'dodge': c('dash', { gain: 0.7 }); break;
    case 'dash': c('dash', { gain: 0.8 }); break;
    case 'jump': c('jump'); break;
    case 'land': c('land', { size: Math.min(1.3, 0.5 + e.speed / 30) }); break;
    case 'slam': c('boom', { size: 0.8 }); c(ramp(e.f) === 0 ? 'fire' : 'thunder', { size: 0.8, gain: 0.7 }); break;
    case 'ground': if (e.spike || e.speed > 16) c('crack', { size: 1 }); else c('land', { size: 1.2 }); break;
    case 'wall': c('block'); c('boom', { size: 0.55 }); c('zap', { size: 0.8 }); break;
    case 'proj_spawn': if (e.kind === 'ember') { c('fire', { size: 0.45 }); c('whoosh', { size: 1.2, gain: 0.6 }); } else c('zap', { size: 0.8 }); break;
    case 'proj_end':
      if (e.reason === 'fizzle') break;
      if (e.kind === 'ember') { c('boom', { size: 0.5 }); c('fire', { size: 0.8 }); } else { c('zap', { size: 1.1 }); c('hit', { size: 0.6 }); }
      break;
    case 'proj_clash': c('boom', { size: 0.9 }); c('zap', { size: 1 }); break;
    case 'proj_reflect': c('parry', { gain: 0.7 }); break;
    case 'cast': if (e.kind === 'erupt') c('crack', { size: 1.1 }); else { c('zap', { size: 1.2 }); c('charge', { dur: 0.5, ramp: 1, gain: 0.5 }); } break;
    case 'zone_warn': if (e.kind === 'erupt') c('crack', { size: 0.35, gain: 0.6 }); else c('ui', { f: 1500, gain: 0.7 }); break;
    case 'zone_fire': if (e.kind === 'erupt') { c('boom', { size: 0.7 }); c('fire', { size: 1.3 }); } else c('thunder', { size: 1 }); break;
    case 'ult_start': c('charge', { dur: e.fast ? 0.3 : ULT.charge, ramp: ramp(e.f) }); c('drum', { gain: 0.8 }); break;
    case 'beam_start': c('boom', { size: 1.1 }); audio.hold('beam' + e.f, 'beam', { ramp: ramp(e.f), pan: fpan(e.f) * 0.5 }); break;
    case 'beam_end': audio.release('beam' + e.f); break;
    case 'clash_start': c('boom', { size: 1.4 }); c('clang', { gain: 0.8 }); audio.hold('clash', 'clash', {}); break;
    case 'clash_end': audio.release('clash'); c('boom', { size: 2 }); c('thunder', { size: 1.2 }); break;
    case 'guardbreak': c('shatter'); break;
    case 'tech': c('jump'); c('whoosh', { size: 0.8, gain: 0.6 }); break;
    case 'ko': c('boom', { size: 1.8 }); c('sting', { gain: 0.9 }); break;
  }
}
