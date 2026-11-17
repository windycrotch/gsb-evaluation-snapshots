import * as THREE from 'three';
import { Renderer, fxGlobals } from './render/renderer.js';
import { Arena } from './render/arena.js';
import { Actor } from './render/characters/actor.js';
import { VFX } from './render/vfx/vfx.js';
import { CameraRig } from './render/camera.js';
import { World } from './sim/world.js';

// The stage owns everything needed to show a fight: renderer, arena, the two actors, effects and
// camera, plus the World being presented. The game, the look-dev page and the showcase capture
// all drive this same object, so what is filmed is exactly what is played.

const SIM_DT = 1 / 120;
const NO_INPUT = { fwd: 0, strafe: 0, buttons: 0 };

export class Stage {
  constructor(canvas, { quality = 'high', preserve = false } = {}) {
    this.R = new Renderer(canvas, { quality, preserve });
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 900);
    this.arena = new Arena(this.scene, this.R, { lightsPool: quality === 'low' ? 4 : 6 });
    this.vfx = new VFX(this.scene, this.arena, this.R, { density: quality === 'low' ? 0.5 : quality === 'medium' ? 0.75 : 1 });
    this.rig = new CameraRig(this.camera);
    this.actorPool = { clawd: new Actor('clawd', this.scene), codex: new Actor('codex', this.scene) };
    this.actors = [this.actorPool.clawd, this.actorPool.codex];
    this.world = null;
    this.player = 0;
    this.controllers = [null, null];
    this.time = 0; // presentation time (scaled by slow motion)
    this.real = 0;
    this.timeScale = 1;
    this.slow = { scale: 1, t: 0 };
    this.onEvent = null;
    this.vfx.onSlowmo = (scale, dur) => this.slowmo(scale, dur);
    this.newWorld({});
  }

  resize(w, h, dpr = 1) {
    this.R.setSize(w, h, dpr);
  }

  newWorld({ chars = ['clawd', 'codex'], seed = 1, roundTime = 99 } = {}) {
    this.world = new World({ chars, seed, roundTime });
    this.actors = chars.map((c) => this.actorPool[c]);
    for (let i = 0; i < 2; i++) { const a = this.actors[i]; a.snapNext = true; a.tumble = 0; a.spin = 0; a.stance = 0; a.flash = 0; a.lastHit = this.world.fighters[i].lastHitT; }
    this.vfx.clearCombat();
    this.vfx.bindFighters(this.world);
    this.rig.snap = true;
    this.rig.special = null;
    this.slow.t = 0;
    return this.world;
  }

  slowmo(scale, dur) {
    if (this.slow.t > 0 && this.slow.scale < scale) return; // keep the stronger one
    this.slow.scale = scale;
    this.slow.t = dur;
    this.slow.dur = dur;
  }

  // Advance by dt of real (output) time.
  step(dt) {
    const w = this.world;
    let ts = this.timeScale;
    if (this.slow.t > 0) {
      // ease back up to speed over the last 30% so the release does not pop
      const k = Math.min(1, this.slow.t / (this.slow.dur * 0.3));
      ts *= this.slow.scale + (1 - this.slow.scale) * (1 - k) * (1 - k);
      this.slow.t -= dt;
    }
    const sdt = dt * ts;
    const n = Math.max(1, Math.ceil(sdt / SIM_DT - 1e-6));
    const h = sdt / n;
    for (let i = 0; i < n; i++) {
      const a = this.controllers[0] ? this.controllers[0](w, h) : NO_INPUT;
      const b = this.controllers[1] ? this.controllers[1](w, h) : NO_INPUT;
      w.step([a, b], h);
      if (w.events.length) {
        for (const e of w.events) {
          this.vfx.onEvent(e, w, this.actors);
          this.rig.onEvent(e, w, this.player);
          this.onEvent?.(e, w);
        }
        w.events.length = 0;
      }
    }
    this.time += sdt;
    this.real += dt;
    fxGlobals.uTime.value = this.time;
    for (let i = 0; i < 2; i++) this.actors[i].update(w.fighters[i], w, sdt, this.time);
    this.rig.update(dt, this.real, w, this.player, this.vfx);
    this.vfx.update(sdt, this.time, w, this.actors, this.camera);
    this.arena.update(sdt, this.camera);
    return ts;
  }

  render(dt) {
    this.R.render(this.scene, this.camera, dt);
  }

  // Film-quality frame: S sub-steps accumulated for true motion blur + temporal AA.
  // simPer: simulation steps per drawn sub-frame, so previews can draw less often while stepping
  // the sim on exactly the same clock as the final render.
  renderFilm(dt, S, beforeSub, simPer = 1) {
    const R = this.R, h = dt / (S * simPer);
    R.accumBegin();
    for (let i = 0; i < S; i++) {
      for (let k = 0; k < simPer; k++) { beforeSub?.(h, i); this.step(h); }
      R.drawWorld(this.scene, this.camera, S > 1 ? i : -1);
      R.accumAdd(1 / S);
    }
    R.present(true, dt);
  }
}
