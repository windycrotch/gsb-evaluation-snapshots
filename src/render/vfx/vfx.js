import * as THREE from 'three';
import { Puffs, Sparks, Glows, Shocks } from './particles.js';
import { Lightning, Trails, GroundQuads, Debris, Slashes, Orbs, Beam } from './meshfx.js';
import { RNG, TAU, sat, lerp } from '../../core/math.js';
import { ARENA_R, ST, CHEST_Y } from '../../sim/constants.js';
import { ULT } from '../../sim/moves.js';

// Turns simulation events and continuous sim state into effects. Purely cosmetic: nothing here
// feeds back into the simulation, so effect quality can scale without touching gameplay.

const FIRE = new THREE.Color(1.0, 0.42, 0.1);
const VOLT = new THREE.Color(0.28, 0.62, 1.0);
const WHITE = new THREE.Color(1, 0.96, 0.9);
const P3 = (x, y, z) => ({ x, y, z });

export class VFX {
  constructor(scene, arena, renderer, { density = 1 } = {}) {
    this.scene = scene;
    this.arena = arena;
    this.R = renderer;
    this.density = density;
    this.rng = new RNG(777);
    this.puffs = new Puffs(scene);
    this.sparks = new Sparks(scene);
    this.glows = new Glows(scene);
    this.shocks = new Shocks(scene);
    this.bolts = new Lightning(scene);
    this.trails = new Trails(scene);
    this.decals = new GroundQuads(scene, 40, true);
    this.ground = new GroundQuads(scene, 40, false);
    this.rubble = new Debris(scene, 220, false);
    this.cubes = new Debris(scene, 260, true);
    this.slashes = new Slashes(scene);
    this.orbs = new Orbs(scene);
    this.beams = [null, null];
    this.projFx = new Map();
    this.zoneFx = new Map();
    this.dashTrail = [null, null];
    this.chargeOrb = [null, null];
    this.clashOrbs = null;
    this.acc = { amb: 0, mist: 0, coil: 0, haze: 0, beam: [0, 0], clash: 0, aura: [0, 0], ember: 0 };
    // screen-space pulses (decay every frame, summed onto the renderer look)
    this.screen = { ca: 0, radial: 0, flash: 0, flashCol: new THREE.Color(1, 1, 1), expo: 0 };
    this.base = { ca: renderer.look.ca, exposure: renderer.look.exposure };
    this.trauma = 0; // read by the camera rig
    this.kick = new THREE.Vector3();
    this.onSlowmo = null;
    this.t = 0;
  }

  bindFighters(world) {
    for (let i = 0; i < 2; i++) {
      if (this.beams[i]) this.scene.remove(this.beams[i].group);
      this.beams[i] = new Beam(this.scene, world.fighters[i].stats.element === 'fire' ? 0 : 1);
    }
  }

  // ---- small emit helpers --------------------------------------------------------------------
  n(k) { return Math.max(1, Math.round(k * this.density)); }
  puff(x, y, z, vx, vy, vz, life, s0, s1, heat, ramp, a = 0.6, col = 0.045, drag = 2, buoy = 2, turb = 0) {
    const o = this.puffs.o, r = this.rng;
    o.x = x; o.y = y; o.z = z; o.vx = vx; o.vy = vy; o.vz = vz; o.life = life; o.s0 = s0; o.s1 = s1;
    o.rot = r.range(0, TAU); o.rotV = r.range(-1.2, 1.2); o.seed = r.next(); o.heat = heat; o.ramp = ramp;
    o.r = col; o.g = col * 1.0; o.b = col * 1.12; o.a = a; o.drag = drag; o.buoy = buoy; o.turb = turb; o.stretch = 0;
    this.puffs.emit();
  }
  flame(x, y, z, size, heat, ramp = 0, life = 0.6, vy = 2.4, amb = 0) {
    const o = this.puffs.o, r = this.rng;
    o.x = x; o.y = y; o.z = z; o.vx = r.range(-0.3, 0.3); o.vy = vy * r.range(0.8, 1.3); o.vz = r.range(-0.3, 0.3); o.life = life * r.range(0.75, 1.25);
    o.s0 = size * 0.7; o.s1 = size * 1.15; o.rot = r.range(-0.25, 0.25); o.rotV = 0; o.seed = r.next(); o.heat = heat; o.ramp = ramp;
    o.r = o.g = 0.04; o.b = 0.045; o.a = 0.12; o.drag = 0.7; o.buoy = 2.6; o.turb = 1.4; o.stretch = r.range(0.7, 1.4); o.amb = amb;
    this.puffs.emit();
    o.stretch = 0; o.amb = 0;
  }
  dir(dx, dy, dz, spread) {
    const r = this.rng;
    let x = r.range(-1, 1), y = r.range(-1, 1), z = r.range(-1, 1);
    const l = Math.hypot(x, y, z) || 1;
    x = dx + (x / l) * spread; y = dy + (y / l) * spread; z = dz + (z / l) * spread;
    const m = Math.hypot(x, y, z) || 1;
    this._dx = x / m; this._dy = y / m; this._dz = z / m;
  }
  sparkBurst(x, y, z, n, speed, ramp, { dx = 0, dy = 0.3, dz = 0, spread = 1, heat = 1.2, life = 0.6, width = 0.024, grav = 24 } = {}) {
    const r = this.rng;
    n = this.n(n);
    for (let i = 0; i < n; i++) {
      this.dir(dx, dy, dz, spread);
      const sp = speed * r.range(0.25, 1);
      this.sparks.emit(x, y, z, this._dx * sp, this._dy * sp, this._dz * sp, life * r.range(0.4, 1), width * r.range(0.6, 1.3), heat * r.range(0.7, 1.1), ramp, grav, 1.2);
    }
  }
  flash(x, y, z, size, ramp, k = 1, life = 0.14, star = 1) {
    const c = ramp === 0 ? FIRE : ramp === 1 ? VOLT : WHITE;
    this.glows.emit(x, y, z, size * 0.22, size * 0.55, life, c.r * 6 * k, c.g * 6 * k, c.b * 6 * k, { star, fadePow: 1.6 });
    this.glows.emit(x, y, z, size * 0.6, size * 1.3, life * 1.6, c.r * 0.45 * k, c.g * 0.45 * k, c.b * 0.45 * k, { fadePow: 2 });
  }
  light(x, y, z, ramp, intensity, life = 0.35, dist = 30) {
    this.arena.light(P3(x, y, z), ramp === 0 ? FIRE : ramp === 1 ? VOLT : WHITE, intensity, life, dist);
  }
  shake(t) { this.trauma = Math.min(1.4, this.trauma + t); }

  // A burst of rolling fire (ramp 0) or plasma (ramp 1) that cools into smoke.
  fireball(x, y, z, s, ramp, { smoke = 0.75, up = 1 } = {}) {
    const r = this.rng;
    this.flash(x, y, z, 3.2 * s, ramp, 1.2, 0.16);
    const n = this.n(13 * s + 5);
    for (let i = 0; i < n; i++) {
      this.dir(0, 0.25 * up, 0, 1);
      const sp = r.range(1.5, 7.5) * s;
      const off = r.range(0, 0.45) * s;
      this.puff(x + this._dx * off, Math.max(0.15, y + this._dy * off), z + this._dz * off, this._dx * sp, this._dy * sp + 1.5 * up, this._dz * sp,
        r.range(0.45, 1.0) * (0.8 + s * 0.25), r.range(0.3, 0.55) * s, r.range(1.1, 2.0) * s, r.range(1.2, 1.75), ramp, ramp === 0 ? smoke : smoke * 0.35, 0.04, 2.6, 3.2 * up, 1.5);
    }
    this.sparkBurst(x, y, z, 26 * s, 20 * Math.sqrt(s), ramp, { spread: 1, dy: 0.35, life: 0.8 });
    this.shocks.emit(x, y, z, 4.2 * s, 0.38, 0.03 * Math.min(1.6, s));
    this.light(x, y + 0.5, z, ramp, 90 * s, 0.4, 26 + 6 * s);
  }

  dustRing(x, z, radius, n, speed = 7, col = 0.11) {
    const r = this.rng;
    n = this.n(n);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + r.range(-0.2, 0.2), c = Math.cos(a), s = Math.sin(a);
      const sp = speed * r.range(0.6, 1.15);
      this.puff(x + c * radius, 0.25, z + s * radius, c * sp, r.range(0.4, 1.6), s * sp, r.range(0.7, 1.4), r.range(0.3, 0.5), r.range(1.1, 1.9), 0, 0, 0.42, col, 3.2, 0.6, 0.6);
    }
  }

  // Something heavy just hit the floor: scorch + cracks, flash ring, dust, flying rubble.
  groundImpact(x, z, s, ramp, { heat = 1, rubble = 1, dust = 1 } = {}) {
    const r = this.rng, c = ramp === 0 ? FIRE : VOLT;
    this.decals.add(x, z, 1.9 * s, { mode: ramp, life: 14, intensity: heat * 1.2, seed: r.next(), r: 0.3, g: 0.3, b: 0.3 });
    if (heat > 0) this.ground.add(x, z, 4.2 * s, { mode: 0, life: 0.42, r: c.r * 9, g: c.g * 9, b: c.b * 9, seed: r.next() });
    this.shocks.emit(x, 0.05, z, 5.5 * s, 0.45, 0.03 * Math.min(1.5, s), { ground: true });
    if (dust) this.dustRing(x, z, 0.6 * s, 12 * s + 4, 6 + 3 * s);
    const nr = this.n(7 * s * rubble);
    for (let i = 0; i < nr; i++) {
      const a = r.range(0, TAU), sp = r.range(2, 7) * Math.sqrt(s), d = r.range(0.2, 1.1) * s;
      this.rubble.spawn(x + Math.cos(a) * d, 0.15, z + Math.sin(a) * d, Math.cos(a) * sp, r.range(5, 13) * Math.sqrt(s), Math.sin(a) * sp, r.range(0.12, 0.42) * Math.min(1.5, 0.7 + s * 0.3), r.range(1.6, 3.2));
    }
    if (heat > 0) {
      this.sparkBurst(x, 0.2, z, 22 * s, 16, ramp, { dy: 1, spread: 0.9, life: 0.9 });
      if (ramp === 0) for (let i = 0; i < this.n(6 * s); i++) {
        const a = r.range(0, TAU), sp = r.range(2, 8);
        this.cubes.spawn(x, 0.3, z, Math.cos(a) * sp, r.range(6, 14), Math.sin(a) * sp, r.range(0.07, 0.16), r.range(1.2, 2.2), FIRE.r, FIRE.g * 0.8, FIRE.b * 0.5, 9);
      }
    }
    this.arena.shared.uPulse.value = Math.min(1.2, this.arena.shared.uPulse.value + 0.25 * s);
  }

  // Forks of electricity radiating from a point.
  arcs(x, y, z, n, len, { width = 0.1, life = 0.16, intensity = 14, flat = false, ramp = 1 } = {}) {
    const r = this.rng, c = ramp === 0 ? FIRE : VOLT;
    for (let i = 0; i < n; i++) {
      this.dir(0, flat ? 0 : 0.2, 0, 1);
      const l = len * r.range(0.5, 1);
      const by = flat ? 0.06 : Math.max(0.06, y + this._dy * l);
      this.bolts.strike(P3(x, y, z), P3(x + this._dx * l, by, z + this._dz * l), { width, life: life * r.range(0.7, 1.2), r: c.r, g: c.g, b: c.b, intensity, branches: 1, levels: 4, jag: 0.24 });
    }
  }

  skyStrike(x, z, power = 1) {
    const r = this.rng;
    const top = P3(x + r.range(-5, 5), 34, z + r.range(-5, 5));
    this.bolts.strike(top, P3(x, 0.05, z), { width: 0.85 * power, life: 0.3, intensity: 34, branches: 5, levels: 6, jag: 0.17, regen: 0.05 });
    this.bolts.strike(top, P3(x + r.range(-0.4, 0.4), 0.05, z + r.range(-0.4, 0.4)), { width: 0.35 * power, life: 0.38, intensity: 20, branches: 2, levels: 6, jag: 0.22, regen: 0.04 });
    this.arcs(x, 0.1, z, 7, 4.2 * power, { flat: true, width: 0.13, life: 0.3, intensity: 16 });
    this.flash(x, 1.2, z, 5.5 * power, 1, 1.3, 0.2);
    for (let i = 0; i < this.n(10); i++) {
      this.dir(0, 0.6, 0, 1);
      const sp = r.range(2, 8);
      this.puff(x, 0.5, z, this._dx * sp, this._dy * sp, this._dz * sp, r.range(0.4, 0.9), 0.4, r.range(1.2, 2.2), r.range(1.2, 1.7), 1, 0.3, 0.05, 2.4, 2.5, 1);
    }
    this.sparkBurst(x, 0.3, z, 50, 22, 1, { dy: 0.8, spread: 1, life: 0.9 });
    this.groundImpact(x, z, 1.25 * power, 1, { rubble: 0.8 });
    this.light(x, 3, z, 1, 220 * power, 0.35, 45);
    this.arena.skyFlash(0.9);
    this.screen.flash = Math.max(this.screen.flash, 0.1);
    this.screen.flashCol.setRGB(0.6, 0.8, 1);
    this.screen.ca += 0.004;
    this.shake(0.45);
  }

  // A fighter flaring up (round start, staged beats).
  powerUp(f, ramp, k = 1) {
    this.ground.add(f.x, f.z, 4.5 * k, { mode: 0, life: 0.5, ...this._co(ramp, 8) });
    this.shocks.emit(f.x, 1, f.z, 6 * k, 0.5, 0.035 * k);
    this.dustRing(f.x, f.z, 0.7, 14, 8 * k);
    this.flash(f.x, 1.1, f.z, 3.5 * k, ramp, 1, 0.2);
    this.sparkBurst(f.x, 0.6, f.z, 34 * k, 13, ramp, { dy: 1.2, spread: 0.8, life: 0.8 });
    if (ramp === 1) this.arcs(f.x, 1.2, f.z, 6, 2.6, { life: 0.25 });
    else for (let i = 0; i < this.n(10); i++) { const a = this.rng.range(0, TAU); this.puff(f.x + Math.cos(a) * 0.9, 0.3, f.z + Math.sin(a) * 0.9, Math.cos(a) * 2, this.rng.range(3, 7), Math.sin(a) * 2, this.rng.range(0.4, 0.8), 0.35, 1.1, 1.5, 0, 0.3, 0.04, 2, 3, 1); }
    this.light(f.x, 1.5, f.z, ramp, 120 * k, 0.4);
    this.shake(0.25 * k);
  }

  // ---- event handling ------------------------------------------------------------------------
  onEvent(e, world, actors) {
    const F = world.fighters, r = this.rng;
    const rampOf = (i) => (F[i].stats.element === 'fire' ? 0 : 1);
    switch (e.type) {
      case 'swing': {
        const f = F[e.f], a = actors[e.f], ramp = rampOf(e.f);
        const fx = Math.sin(f.yaw), fz = Math.cos(f.yaw);
        const cx = f.x + fx * 0.5, cy = f.y + 1.05, cz = f.z + fz * 0.5;
        const big = ramp === 0 ? 1.15 : 1;
        if (e.id === 'L3') this.slashes.spawn(f.x, cy, f.z, f.yaw, { size: 2.7 * big, life: 0.2, ramp, heat: 1.05, dir: -1 });
        else if (e.id === 'L4') this.slashes.spawn(cx, cy + 0.2, cz, f.yaw, { tilt: Math.PI / 2, size: 2.4 * big, life: 0.18, ramp, heat: 1.1 });
        else if (e.id === 'AL') this.slashes.spawn(cx, cy, cz, f.yaw, { roll: f.airLights % 2 ? 0.6 : -0.6, size: 2.2 * big, life: 0.16, ramp, heat: 1.0, dir: f.airLights % 2 ? 1 : -1 });
        else if (e.id === 'L1' || e.id === 'L2') this.slashes.spawn(cx, cy, cz, f.yaw, { roll: e.id === 'L1' ? 0.25 : -0.25, size: 1.9 * big, life: 0.14, ramp, heat: 0.95, dir: e.id === 'L1' ? 1 : -1 });
        if (e.id === 'H' || e.id === 'DA' || e.id === 'AH') {
          // committed lunges drag a streak of their element behind them
          this._streaks(e.f, ramp, 0.3, 1.25);
          this.shocks.emit(cx, cy, cz, 2.2, 0.25, 0.02);
        }
        break;
      }
      case 'hit': this._hit(e, world, actors); break;
      case 'parry': {
        this.flash(e.x, e.y, e.z, 3.2, 2, 1.2, 0.16);
        this.sparkBurst(e.x, e.y, e.z, 46, 22, rampOf(e.f), { spread: 1, dy: 0.1, life: 0.6, heat: 1.5 });
        this.shocks.emit(e.x, e.y, e.z, 5, 0.4, 0.045);
        this.light(e.x, e.y, e.z, 2, 120, 0.3);
        this.screen.flash = Math.max(this.screen.flash, 0.07); this.screen.flashCol.setRGB(1, 1, 1);
        this.screen.ca += 0.006;
        this.shake(0.35);
        this.onSlowmo?.(0.16, 0.5);
        break;
      }
      case 'clang': {
        this.flash(e.x, e.y, e.z, 3.0, 2, 1.2, 0.14);
        this.sparkBurst(e.x, e.y, e.z, 70, 26, 0, { spread: 1, dy: 0.2, heat: 1.45 });
        this.sparkBurst(e.x, e.y, e.z, 70, 26, 1, { spread: 1, dy: 0.2, heat: 1.45 });
        this.shocks.emit(e.x, e.y, e.z, 6, 0.4, 0.05);
        this.shocks.emit(e.x, 0.05, e.z, 6, 0.5, 0.03, { ground: true });
        this.dustRing(e.x, e.z, 0.8, 14, 9);
        this.light(e.x, e.y, e.z, 2, 150, 0.3);
        this.screen.ca += 0.004; this.screen.radial = Math.max(this.screen.radial, 0.3);
        this.shake(0.5);
        break;
      }
      case 'dodge': {
        const ramp = rampOf(e.f);
        this.glows.emit(e.x, e.y, e.z, 1.2, 3.4, 0.3, ...this._c(ramp, 5), { fadePow: 1.5 });
        this.shocks.emit(e.x, e.y, e.z, 3.5, 0.35, 0.025);
        this.screen.ca += 0.004;
        this.onSlowmo?.(0.3, 0.28);
        break;
      }
      case 'dash': {
        const f = F[e.f], ramp = rampOf(e.f);
        this._streaks(e.f, ramp, 0.24, 1.0);
        for (let i = 0; i < this.n(5); i++) this.puff(f.x + r.range(-0.4, 0.4), f.y + 0.2, f.z + r.range(-0.4, 0.4), -e.dx * r.range(1, 4), r.range(0.3, 1.5), -e.dz * r.range(1, 4), r.range(0.4, 0.8), 0.3, r.range(0.8, 1.3), 0, 0, 0.35, 0.11, 3, 0.5);
        this.shocks.emit(f.x, f.y + 1, f.z, 2.4, 0.25, 0.018);
        this.sparkBurst(f.x, f.y + 0.3, f.z, 8, 9, ramp, { dx: -e.dx, dy: 0.3, dz: -e.dz, spread: 0.6, life: 0.35, heat: 1.1 });
        break;
      }
      case 'jump': {
        const f = F[e.f];
        this.dustRing(f.x, f.z, 0.4, 7, 4.5);
        break;
      }
      case 'land': {
        const f = F[e.f];
        if (e.speed > 9) this.dustRing(f.x, f.z, 0.5, 8, 4 + e.speed * 0.12);
        break;
      }
      case 'slam': {
        const ramp = rampOf(e.f);
        this.groundImpact(e.x, e.z, 1.7, ramp);
        if (ramp === 0) {
          this.fireball(e.x, 0.5, e.z, 1.2, 0);
          for (let i = 0; i < this.n(16); i++) {
            const a = (i / 16) * TAU;
            this.puff(e.x + Math.cos(a) * 1.2, 0.3, e.z + Math.sin(a) * 1.2, Math.cos(a) * 9, r.range(1, 3), Math.sin(a) * 9, r.range(0.4, 0.75), 0.4, 1.3, 1.5, 0, 0.5, 0.04, 3.5, 2.5);
          }
        } else {
          this.arcs(e.x, 0.1, e.z, 9, 4.5, { flat: true, width: 0.14, life: 0.3, intensity: 18 });
          this.bolts.strike(P3(e.x + r.range(-2, 2), 26, e.z + r.range(-2, 2)), P3(e.x, 0.1, e.z), { width: 0.6, life: 0.22, intensity: 28, branches: 3, levels: 6 });
          this.flash(e.x, 0.8, e.z, 5, 1, 1.4, 0.18);
          this.light(e.x, 1.5, e.z, 1, 150, 0.35);
        }
        this.shake(0.6);
        this.screen.ca += 0.005; this.screen.radial = Math.max(this.screen.radial, 0.3);
        break;
      }
      case 'ground': {
        const hard = e.speed > 16 || e.spike;
        if (hard) {
          this.groundImpact(e.x, e.z, e.spike ? 1.5 : 1.0, rampOf(1 - e.f), { heat: e.spike ? 0.8 : 0 });
          this.shake(e.spike ? 0.55 : 0.3);
        } else {
          this.dustRing(e.x, e.z, 0.5, 9, 3 + e.speed * 0.2);
        }
        break;
      }
      case 'wall': {
        const ramp = rampOf(1 - e.f);
        this.arena.barrierHit(e, ramp === 0 ? FIRE : VOLT);
        this.sparkBurst(e.x, e.y, e.z, 40, 18, ramp, { dx: -e.x / ARENA_R, dz: -e.z / ARENA_R, dy: 0.2, spread: 0.8 });
        this.shocks.emit(e.x, e.y, e.z, 5, 0.4, 0.04);
        this.flash(e.x, e.y, e.z, 3.5, ramp, 1.2);
        this.light(e.x, e.y, e.z, ramp, 90, 0.35);
        this.shake(0.5);
        break;
      }
      case 'proj_spawn': {
        const ramp = e.kind === 'ember' ? 0 : 1;
        const tr = this.trails.start({ width: ramp === 0 ? 0.7 : 0.42, life: ramp === 0 ? 0.3 : 0.2, heat: 1.6, ramp });
        this.projFx.set(e.id, { tr, ramp });
        this.flash(e.x, e.y, e.z, 2.2, ramp, 1.1, 0.12);
        this.sparkBurst(e.x, e.y, e.z, 10, 12, ramp, { spread: 0.9, life: 0.35 });
        this.light(e.x, e.y, e.z, ramp, 45, 0.25);
        if (ramp === 1) this.arcs(e.x, e.y, e.z, 2, 1.2, { life: 0.1 });
        break;
      }
      case 'proj_reflect': {
        this.flash(e.x, e.y, e.z, 3.5, 2, 1.5, 0.16);
        this.shocks.emit(e.x, e.y, e.z, 3.5, 0.3, 0.035);
        break;
      }
      case 'proj_end': {
        const fx = this.projFx.get(e.id);
        if (fx) { fx.tr.ended = true; this.projFx.delete(e.id); }
        if (e.reason === 'fizzle') break;
        if (e.kind === 'ember') {
          this.fireball(e.x, e.y, e.z, 0.75, 0);
          if (e.reason === 'ground') this.groundImpact(e.x, e.z, 0.8, 0, { rubble: 0.6 });
        } else {
          this.flash(e.x, e.y, e.z, 3, 1, 1.3);
          this.arcs(e.x, e.y, e.z, 5, 2.2, { life: 0.18 });
          this.sparkBurst(e.x, e.y, e.z, 30, 18, 1, { spread: 1, life: 0.5 });
          this.shocks.emit(e.x, e.y, e.z, 3, 0.3, 0.025);
          this.light(e.x, e.y, e.z, 1, 70, 0.3);
          if (e.reason === 'ground') this.groundImpact(e.x, e.z, 0.6, 1, { rubble: 0.4 });
        }
        if (e.reason === 'wall') this.arena.barrierHit(e, e.kind === 'ember' ? FIRE : VOLT);
        this.shake(0.12);
        break;
      }
      case 'proj_clash': {
        this.fireball(e.x, e.y, e.z, 1.1, 0);
        this.arcs(e.x, e.y, e.z, 8, 3.5, { life: 0.22, intensity: 18 });
        this.flash(e.x, e.y, e.z, 3.2, 2, 1.1, 0.16);
        this.screen.ca += 0.005;
        this.shake(0.35);
        break;
      }
      case 'cast': {
        const f = F[e.f], ramp = rampOf(e.f);
        if (e.kind === 'erupt') {
          this.groundImpact(e.x, e.z, 1.2, 0);
          this.shake(0.4);
        } else {
          const a = actors[e.f];
          this.bolts.strike(a.tipW[1], P3(f.x + r.range(-3, 3), 30, f.z + r.range(-3, 3)), { width: 0.3, life: 0.3, intensity: 18, branches: 3, levels: 6 });
          this.flash(a.tipW[1].x, a.tipW[1].y, a.tipW[1].z, 3, 1, 1.2, 0.2);
          this.light(f.x, 3, f.z, 1, 70, 0.4);
          this.arena.skyFlash(0.7);
        }
        break;
      }
      case 'zone_warn': {
        const c = e.kind === 'erupt' ? FIRE : VOLT;
        const it = this.ground.add(e.x, e.z, e.r * 1.05, { mode: e.kind === 'erupt' ? 2 : 1, life: e.delay + 0.03, r: c.r * 7, g: c.g * 7, b: c.b * 7, seed: r.next() });
        this.zoneFx.set(e.id, it);
        break;
      }
      case 'zone_fire': {
        const it = this.zoneFx.get(e.id);
        if (it) { it.dead = true; this.zoneFx.delete(e.id); }
        if (e.kind === 'erupt') this._geyser(e.x, e.z, e.r);
        else this.skyStrike(e.x, e.z, 1);
        break;
      }
      case 'ult_start': {
        const f = F[e.f], ramp = rampOf(e.f);
        this.shocks.emit(f.x, 1, f.z, 7, 0.6, 0.04);
        this.dustRing(f.x, f.z, 0.8, 16, 9);
        this.ground.add(f.x, f.z, 4.5, { mode: 0, life: 0.5, ...this._co(ramp, 8) });
        this.screen.ca += 0.006;
        this.shake(0.3);
        if (!e.fast) this.arena.skyFlash(1);
        break;
      }
      case 'beam_start': {
        const f = F[e.f], ramp = rampOf(e.f);
        const fx = Math.sin(f.yaw), fz = Math.cos(f.yaw);
        this.flash(f.x + fx * 1.6, 1.15, f.z + fz * 1.6, 5, ramp, 1.4, 0.2);
        this.shocks.emit(f.x + fx * 1.5, 1.1, f.z + fz * 1.5, 8, 0.5, 0.07);
        this.dustRing(f.x, f.z, 1, 18, 12);
        this.screen.flash = Math.max(this.screen.flash, 0.09); this.screen.flashCol.copy(ramp === 0 ? FIRE : VOLT).lerp(WHITE, 0.5);
        this.screen.radial = Math.max(this.screen.radial, 0.35);
        this.screen.ca += 0.006;
        this.shake(0.7);
        if (this.chargeOrb[e.f]) { this.orbs.release(this.chargeOrb[e.f]); this.chargeOrb[e.f] = null; }
        break;
      }
      case 'clash_start': {
        const C = world.clash;
        const cx = (F[0].x + F[1].x) / 2, cz = (F[0].z + F[1].z) / 2;
        this.flash(cx, 1.2, cz, 4.5, 2, 1.3, 0.2);
        this.shocks.emit(cx, 1.2, cz, 14, 0.7, 0.09);
        this.groundImpact(cx, cz, 2.2, 0);
        this.screen.flash = Math.max(this.screen.flash, 0.05); this.screen.flashCol.setRGB(1, 1, 1);
        this.screen.radial = 0.4; this.screen.ca += 0.006;
        this.shake(0.8);
        this.arena.skyFlash(1);
        this.onSlowmo?.(0.25, 0.35);
        break;
      }
      case 'clash_end': {
        this._bigBoom(e.x, e.y, e.z);
        if (this.clashOrbs) { this.clashOrbs.forEach((o) => this.orbs.release(o)); this.clashOrbs = null; }
        this.onSlowmo?.(0.2, 0.7);
        break;
      }
      case 'guardbreak': {
        const ramp = rampOf(1 - e.f);
        this.flash(e.x, e.y, e.z, 4.5, 2, 1.5, 0.18);
        this.sparkBurst(e.x, e.y, e.z, 50, 20, ramp, { spread: 1, heat: 1.6 });
        this.shocks.emit(e.x, e.y, e.z, 5, 0.4, 0.05);
        this.shake(0.5);
        this.onSlowmo?.(0.3, 0.3);
        break;
      }
      case 'tech': {
        const f = F[e.f];
        this.glows.emit(f.x, f.y + 1, f.z, 0.8, 2.6, 0.25, 8, 8, 8, { fadePow: 1.5 });
        this.shocks.emit(f.x, f.y + 1, f.z, 3, 0.3, 0.02);
        break;
      }
      case 'ko': {
        const ramp = rampOf(e.winner);
        this.flash(e.x, e.y, e.z, 11, ramp, 2.4, 0.3);
        this.fireball(e.x, e.y, e.z, 1.8, ramp);
        this.sparkBurst(e.x, e.y, e.z, 120, 30, ramp, { spread: 1, heat: 1.7, life: 1.2 });
        this.shocks.emit(e.x, e.y, e.z, 12, 0.8, 0.08);
        this.shocks.emit(e.x, 0.05, e.z, 12, 0.9, 0.05, { ground: true });
        this.groundImpact(e.x, e.z, 2, ramp);
        if (ramp === 1) this.arcs(e.x, e.y, e.z, 12, 6, { life: 0.35, intensity: 20 });
        this.screen.flash = 0.7; this.screen.flashCol.copy(ramp === 0 ? FIRE : VOLT).lerp(WHITE, 0.6);
        this.screen.radial = 1; this.screen.ca += 0.016;
        this.shake(1.2);
        this.arena.skyFlash(1);
        this.onSlowmo?.(0.12, 1.5);
        break;
      }
    }
  }

  _streaks(i, ramp, dur, heat) {
    const old = this.dashTrail[i];
    if (old) for (const tr of old.trs) tr.ended = true;
    const trs = [0.42, 1.0, 1.58].map((y, k) => Object.assign(this.trails.start({ width: k === 1 ? 0.5 : 0.3, life: 0.2, heat: heat * (k === 1 ? 1 : 0.85), ramp }), { oy: y }));
    this.dashTrail[i] = { trs, until: this.t + dur };
  }
  _c(ramp, k) { const c = ramp === 0 ? FIRE : ramp === 1 ? VOLT : WHITE; return [c.r * k, c.g * k, c.b * k]; }
  _co(ramp, k) { const c = ramp === 0 ? FIRE : ramp === 1 ? VOLT : WHITE; return { r: c.r * k, g: c.g * k, b: c.b * k }; }

  _hit(e, world, actors) {
    const r = this.rng, F = world.fighters;
    const ramp = e.element === 'fire' ? 0 : 1;
    const { x, y, z, dx, dz } = e;
    if (e.beam) {
      // beam ticks: a steady spray rather than discrete impacts
      this.sparkBurst(x, y, z, 10, 22, ramp, { dx: -dx * 0.3, dy: 0.5, dz: -dz * 0.3, spread: 1 });
      if (e.blocked) this._shield(e, F, ramp);
      this.trauma = Math.max(this.trauma, 0.45);
      return;
    }
    if (e.blocked) {
      this._shield(e, F, ramp);
      this.sparkBurst(x, y, z, 14, 13, ramp, { dx: -dx, dy: 0.3, dz: -dz, spread: 0.9, life: 0.4, heat: 1.2 });
      this.flash(x, y, z, 1.6, ramp, 0.7, 0.1, 0);
      this.shake(0.1);
      return;
    }
    const heavy = e.kind === 'heavy' || e.kind === 'slam' || e.kind === 'ult' || e.launch;
    const s = e.kind === 'ult' ? 2 : heavy ? 1 : 0.55;
    this.flash(x, y, z, 2.4 * s + 0.8, ramp, 1 + s * 0.4, 0.12);
    this.sparkBurst(x, y, z, 16 + 34 * s, 14 + 12 * s, ramp, { dx, dy: 0.35, dz, spread: 0.75, life: 0.55 + 0.3 * s });
    this.shocks.emit(x, y, z, 1.8 + 3 * s, 0.3, 0.012 + 0.024 * s);
    this.light(x, y, z, ramp, 30 + 80 * s, 0.25);
    if (ramp === 0) {
      const n = this.n(3 + 6 * s);
      for (let i = 0; i < n; i++) {
        this.dir(dx, 0.4, dz, 0.8);
        const sp = r.range(2, 7) * (0.6 + s);
        this.puff(x, y, z, this._dx * sp, this._dy * sp, this._dz * sp, r.range(0.25, 0.6), 0.2 + 0.15 * s, r.range(0.6, 1.2) * (0.6 + s * 0.6), r.range(1.2, 1.7), 0, 0.45, 0.04, 3, 2.5, 1);
        this.dir(dx, 0.6, dz, 0.9);
        const cs = r.range(4, 12) * (0.7 + s * 0.5);
        this.cubes.spawn(x, y, z, this._dx * cs, this._dy * cs, this._dz * cs, r.range(0.05, 0.13), r.range(0.8, 1.6), FIRE.r, FIRE.g * 0.85, FIRE.b * 0.5, 9);
      }
    } else {
      this.arcs(x, y, z, Math.round(2 + 4 * s), 1.2 + 1.4 * s, { life: 0.14, width: 0.09, intensity: 13 });
      for (let i = 0; i < this.n(2 + 3 * s); i++) {
        this.dir(dx, 0.3, dz, 0.9);
        const sp = r.range(2, 6);
        this.puff(x, y, z, this._dx * sp, this._dy * sp, this._dz * sp, r.range(0.2, 0.4), 0.2, r.range(0.5, 1.0) * (0.6 + s * 0.5), r.range(1.2, 1.6), 1, 0.1, 0.05, 3, 1, 1);
      }
    }
    this.kick.set(dx, 0, dz).multiplyScalar(0.25 * s);
    this.shake(0.1 + 0.28 * s);
    this.screen.ca += 0.0015 + 0.004 * s;
    if (heavy) this.screen.radial = Math.max(this.screen.radial, 0.22 * s);
  }

  _shield(e, F, ramp) {
    const d = F[e.t];
    const tint = d.stats.element === 'fire' ? FIRE : VOLT;
    this.orbs.spawn(d.x, d.y + CHEST_Y, d.z, { kind: 1, s0: 1.35, s1: 1.5, life: 0.26, heat: 1, tint, yaw: Math.atan2(-e.dx, -e.dz) });
  }

  _geyser(x, z, rad) {
    const r = this.rng;
    this.flash(x, 1, z, 5.5, 0, 1.5, 0.2);
    for (let i = 0; i < this.n(26); i++) {
      const a = r.range(0, TAU), d = r.range(0, rad * 0.5);
      const up = r.range(7, 24);
      this.puff(x + Math.cos(a) * d, 0.3, z + Math.sin(a) * d, Math.cos(a) * r.range(0, 3), up, Math.sin(a) * r.range(0, 3), r.range(0.45, 1.0), r.range(0.35, 0.6), r.range(1.0, 2.0), r.range(1.3, 1.8), 0, 0.7, 0.04, 2.2, 1.5, 1.5);
    }
    this.sparkBurst(x, 0.3, z, 70, 26, 0, { dy: 1.6, spread: 0.7, life: 1.2, heat: 1.6 });
    for (let i = 0; i < this.n(12); i++) {
      const a = r.range(0, TAU), sp = r.range(1, 6);
      this.cubes.spawn(x, 0.4, z, Math.cos(a) * sp, r.range(9, 20), Math.sin(a) * sp, r.range(0.08, 0.2), r.range(1.4, 2.4), FIRE.r, FIRE.g * 0.8, FIRE.b * 0.45, 11);
    }
    this.groundImpact(x, z, 1.25, 0, { rubble: 1.2 });
    this.shocks.emit(x, 2.5, z, 4, 0.9, 0.03, { haze: true, vy: 3 });
    this.light(x, 2, z, 0, 170, 0.5, 34);
    this.shake(0.4);
  }

  _bigBoom(x, y, z) {
    const r = this.rng;
    this.fireball(x, y, z, 3, 0, { smoke: 0.8 });
    this.fireball(x, y + 0.5, z, 2.4, 1);
    this.flash(x, y, z, 22, 2, 3, 0.4);
    this.sparkBurst(x, y, z, 160, 40, 0, { spread: 1, heat: 1.7, life: 1.5 });
    this.sparkBurst(x, y, z, 160, 40, 1, { spread: 1, heat: 1.7, life: 1.5 });
    this.arcs(x, y, z, 14, 9, { life: 0.4, intensity: 22, width: 0.16 });
    this.shocks.emit(x, y, z, 22, 1.0, 0.12);
    this.shocks.emit(x, 0.05, z, 20, 1.1, 0.07, { ground: true });
    this.groundImpact(x, z, 3.2, 0, { rubble: 2.2 });
    this.dustRing(x, z, 2, 30, 16);
    for (let i = 0; i < this.n(26); i++) {
      const a = r.range(0, TAU), sp = r.range(4, 16);
      this.cubes.spawn(x, y, z, Math.cos(a) * sp, r.range(5, 20), Math.sin(a) * sp, r.range(0.08, 0.22), r.range(1.5, 3), FIRE.r, FIRE.g * 0.8, FIRE.b * 0.45, 11);
    }
    this.light(x, y + 1, z, 2, 500, 0.7, 60);
    this.screen.flash = 1; this.screen.flashCol.setRGB(1, 0.97, 0.92);
    this.screen.radial = 1.2; this.screen.ca += 0.03;
    this.shake(1.4);
    this.arena.skyFlash(1);
    this.arena.shared.uPulse.value = 1.5;
  }

  // ---- continuous effects --------------------------------------------------------------------
  update(dt, t, world, actors, camera) {
    this.t = t;
    const r = this.rng, F = world.fighters, acc = this.acc;
    const due = (key, every, i) => {
      if (i === undefined) { acc[key] += dt; if (acc[key] >= every) { acc[key] -= every; return true; } return false; }
      acc[key][i] += dt; if (acc[key][i] >= every) { acc[key][i] -= every; return true; } return false;
    };

    // ambience: braziers, coils, embers, floor mist
    if (due('amb', 0.045)) {
      for (const b of this.arena.braziers) {
        this.flame(b.x + r.range(-0.4, 0.4), b.y + 0.15, b.z + r.range(-0.4, 0.4), r.range(0.4, 0.62), r.range(1.2, 1.55), 0, 0.7, 2.0, 1);
      }
    }
    if (due('ember', 0.11)) {
      const b = r.pick(this.arena.braziers);
      this.glows.emit(b.x + r.range(-0.4, 0.4), b.y + 0.4, b.z + r.range(-0.4, 0.4), 0.05, 0.03, r.range(1.5, 3.5), 14, 4.5, 0.8, { vx: r.range(-0.6, 0.6), vy: r.range(1.2, 2.8), vz: r.range(-0.6, 0.6), turb: 3, fadePow: 0.8, amb: 1 });
      // drifting motes across the whole stage, tinted by which half they are in
      const mx = r.range(-ARENA_R, ARENA_R), mz = r.range(-ARENA_R, ARENA_R);
      const w = mx < 0;
      this.glows.emit(mx, r.range(0.2, 5), mz, 0.035, 0.03, r.range(3, 6), w ? 5 : 1.2, w ? 1.8 : 3.2, w ? 0.4 : 6, { vx: r.range(-0.3, 0.3), vy: r.range(0.05, 0.4), vz: r.range(-0.3, 0.3), turb: 1, fadePow: 0.7, amb: 1 });
    }
    if (due('haze', 0.3)) for (const b of this.arena.braziers) this.shocks.emit(b.x, b.y + 0.9, b.z, 1.3, 1.1, 0.012, { haze: true, vy: 1.2 });
    if (due('coil', 0.34)) {
      const c = r.pick(this.arena.coils);
      const to = r.chance(0.5) ? P3(c.x + r.range(-1.2, 1.2), c.y - r.range(0.6, 1.4), c.z + r.range(-1.2, 1.2)) : P3(c.x + r.range(-2.5, 2.5), 0.05, c.z + r.range(-2.5, 2.5));
      this.bolts.strike(P3(c.x, c.y, c.z), to, { width: 0.07, life: r.range(0.08, 0.2), intensity: 9, branches: 1, levels: 4, jag: 0.25 });
      this.glows.emit(c.x, c.y, c.z, 0.5, 1.3, 0.2, 2, 5, 10, { fadePow: 1.5 });
    }
    if (due('mist', 0.5)) {
      const a = r.range(0, TAU), d = r.range(2, ARENA_R + 3);
      const mx = Math.cos(a) * d, mz = Math.sin(a) * d;
      this.puffs.o.amb = 1;
      this.puff(mx, r.range(0.2, 0.7), mz, r.range(-0.5, 0.5), 0.02, r.range(-0.5, 0.5), r.range(5, 8), r.range(2, 3), r.range(3.5, 5), 0, 0, 0.1, mx < 0 ? 0.16 : 0.1, 0.2, 0, 0);
      this.puffs.o.amb = 0;
    }

    // per-fighter effects
    for (let i = 0; i < 2; i++) {
      const f = F[i], a = actors[i], ramp = f.stats.element === 'fire' ? 0 : 1;
      const c = ramp === 0 ? FIRE : VOLT;
      const dtr = this.dashTrail[i];
      if (dtr) {
        if (t > dtr.until || f.state === ST.HIT || f.state === ST.LAUNCH) { for (const tr of dtr.trs) tr.ended = true; this.dashTrail[i] = null; }
        else for (const tr of dtr.trs) this.trails.push(tr, f.x, f.y + tr.oy, f.z);
      }
      // full meter: the fighter smoulders / crackles
      if (f.energy >= 100 && f.state !== ST.KO && due('aura', 0.06, i)) {
        if (r.chance(0.2)) this.ground.add(f.x, f.z, 2.4, { mode: 3, life: 0.55, r: c.r * 1.3, g: c.g * 1.3, b: c.b * 1.3, seed: r.next() });
        if (ramp === 0) for (let j = 0; j < 2; j++) this.glows.emit(f.x + r.range(-1.1, 1.1), f.y + r.range(0.1, 1.5), f.z + r.range(-0.8, 0.8), r.range(0.035, 0.07), 0.02, r.range(0.7, 1.5), 15, 4.6, 0.8, { vx: r.range(-0.4, 0.4), vy: r.range(1.4, 3.2), vz: r.range(-0.4, 0.4), turb: 3, fadePow: 0.8 });
        else if (r.chance(0.5)) {
          this.dir(0, 0.2, 0, 1);
          const p0 = P3(f.x + this._dx * 0.9, f.y + 1.2 + this._dy * 0.7, f.z + this._dz * 0.9);
          this.dir(0, 0.2, 0, 1);
          this.bolts.strike(p0, P3(f.x + this._dx * 0.9, f.y + 1.2 + this._dy * 0.7, f.z + this._dz * 0.9), { width: 0.05, life: 0.1, intensity: 10, branches: 0, levels: 3, jag: 0.3 });
        }
      }
      // attack charge-ups read as heat on the limbs
      if (f.state === ST.ATTACK && f.move && (f.move.id === 'H' || f.move.id === 'S2' || f.move.id === 'S1') && f.st < 0.4 && due('aura', 0.03, i)) {
        const tip = a.tipW[r.int(0, 1)];
        if (ramp === 0) this.flame(tip.x, tip.y, tip.z, 0.22, 1.4, 0, 0.3, 1.6);
        else this.arcs(tip.x, tip.y, tip.z, 1, 0.9, { life: 0.09, width: 0.06, intensity: 11 });
        this.glows.emit(tip.x, tip.y, tip.z, 0.3, 0.7, 0.12, c.r * 8, c.g * 8, c.b * 8);
      }
      // ultimate: charge
      const ult = f.state === ST.ATTACK && f.move && f.move.ult;
      const fx = Math.sin(f.yaw), fz = Math.cos(f.yaw);
      const mx = f.x + fx * 1.35, my = f.y + 1.12, mz = f.z + fz * 1.35;
      if (ult && f.st < ULT.charge) {
        const k = f.st / ULT.charge;
        if (!this.chargeOrb[i]) this.chargeOrb[i] = this.orbs.spawn(mx, my, mz, { kind: 2, s0: 0.1, life: 0, ramp, heat: 0.7 });
        const o = this.chargeOrb[i];
        o.m.position.set(mx, my, mz);
        o.m.scale.setScalar(0.15 + 0.75 * k * k + 0.05 * Math.sin(t * 60));
        o.u.uHeat.value = 0.55 + 0.3 * k;
        if (due('beam', 0.016, i)) {
          // energy streaming inward
          for (let j = 0; j < 2; j++) {
            this.dir(0, 0.1, 0, 1);
            const d = r.range(2.5, 5);
            this.sparks.emit(mx + this._dx * d, my + this._dy * d, mz + this._dz * d, -this._dx * d * 4.2, -this._dy * d * 4.2, -this._dz * d * 4.2, 0.22, 0.04, 1.5, ramp, 0, 0, 0.05);
          }
          if (ramp === 1 && r.chance(0.35)) this.arcs(mx, my, mz, 1, 2.6, { life: 0.1, width: 0.08 });
          if (ramp === 0 && r.chance(0.5)) this.flame(f.x + r.range(-1.3, 1.3), 0.25, f.z + r.range(-1.2, 1.2), r.range(0.25, 0.45), 1.35, 0, 0.5, 3.6);
          this.glows.emit(mx, my, mz, 0.9 + 1.3 * k, 0.5, 0.1, c.r * 4 * k, c.g * 4 * k, c.b * 4 * k, { star: 1 });
        }
        this.arena.light(P3(mx, my, mz), c, 30 + 150 * k, 0.12, 28);
        this.trauma = Math.max(this.trauma, 0.1 + 0.16 * k);
        this.screen.ca = Math.max(this.screen.ca, 0.002 * k);
      } else if (this.chargeOrb[i]) { this.orbs.release(this.chargeOrb[i]); this.chargeOrb[i] = null; }

      // ultimate: beam
      const b = f.beam;
      this.beams[i].set(b.ox, b.oy, b.oz, b.yaw, b.visLen, b.on, dt, world.clash.on ? 1.15 : 1);
      if (b.on) {
        const dx = Math.sin(b.yaw), dz = Math.cos(b.yaw);
        const ex = b.ox + dx * b.visLen, ez = b.oz + dz * b.visLen;
        this.arena.light(P3(b.ox + dx * 2, b.oy + 0.5, b.oz + dz * 2), c, 130, 0.1, 40);
        this.arena.light(P3(ex, b.oy + 0.5, ez), c, 140, 0.1, 40);
        this.trauma = Math.max(this.trauma, 0.36);
        this.screen.ca = Math.max(this.screen.ca, 0.003);
        this.screen.radial = Math.max(this.screen.radial, 0.06);
        if (due('beam', 0.02, i)) {
          // muzzle
          this.glows.emit(b.ox, b.oy, b.oz, 1.6, 1.2, 0.07, c.r * 5, c.g * 5, c.b * 5, { star: 1 });
          this.sparkBurst(b.ox, b.oy, b.oz, 3, 16, ramp, { dx: dx * 0.5, dy: 0.2, dz: dz * 0.5, spread: 1, life: 0.4 });
          // along the shaft
          for (let j = 0; j < this.n(3); j++) {
            const s = r.range(0.5, Math.max(1, b.visLen)), ang = r.range(0, TAU), rr = ramp === 0 ? 0.9 : 0.75;
            const px = b.ox + dx * s + Math.cos(ang) * dz * rr, py = b.oy + Math.sin(ang) * rr, pz = b.oz + dz * s - Math.cos(ang) * dx * rr;
            if (ramp === 0) this.puff(px, py, pz, dx * r.range(8, 22) + Math.cos(ang) * dz * 2, Math.sin(ang) * 2.5 + 1, dz * r.range(8, 22) - Math.cos(ang) * dx * 2, r.range(0.3, 0.6), 0.4, r.range(1.0, 1.6), r.range(1.3, 1.7), 0, 0.3, 0.04, 2.5, 3, 1.5);
            else {
              const s2 = s + r.range(1.5, 4), a2 = ang + r.range(1, 2.4);
              this.bolts.strike(P3(px, py, pz), P3(b.ox + dx * s2 + Math.cos(a2) * dz * rr, b.oy + Math.sin(a2) * rr, b.oz + dz * s2 - Math.cos(a2) * dx * rr), { width: 0.09, life: 0.09, intensity: 15, branches: 0, levels: 3, jag: 0.25 });
            }
            this.sparks.emit(px, py, pz, dx * r.range(15, 40), r.range(-3, 5), dz * r.range(15, 40), 0.3, 0.035, 1.5, ramp, 8, 0.5);
          }
          // scorched floor under the beam
          if (r.chance(0.35)) {
            const s = r.range(1, Math.max(2, b.visLen));
            this.ground.add(b.ox + dx * s, b.oz + dz * s, r.range(1.5, 2.6), { mode: 3, life: 0.35, r: c.r * 2.5, g: c.g * 2.5, b: c.b * 2.5, seed: r.next() });
            if (r.chance(0.3)) this.decals.add(b.ox + dx * s + r.range(-0.5, 0.5), b.oz + dz * s + r.range(-0.5, 0.5), r.range(0.9, 1.5), { mode: ramp, life: 14, intensity: 1, seed: r.next(), r: 0.3, g: 0.3, b: 0.3 });
            this.puff(b.ox + dx * s, 0.2, b.oz + dz * s, r.range(-2, 2), r.range(1, 3), r.range(-2, 2), 0.8, 0.4, 1.4, 0, 0, 0.3, 0.1, 2.5, 1, 0.5);
          }
          this.shocks.emit(b.ox + dx * r.range(1, Math.max(2, b.visLen)), b.oy + 0.6, b.oz + dz * r.range(1, Math.max(2, b.visLen)), 2.2, 0.4, 0.02, { haze: true, vy: 2 });
          // where it lands
          if (!world.clash.on) {
            this.glows.emit(ex, b.oy, ez, 2.2, 1.6, 0.08, c.r * 6, c.g * 6, c.b * 6, { star: 1 });
            this.sparkBurst(ex, b.oy, ez, 9, 26, ramp, { dx: -dx * 0.6, dy: 0.5, dz: -dz * 0.6, spread: 0.9, life: 0.7 });
            if (ramp === 0) this.puff(ex, b.oy, ez, -dx * r.range(2, 8) + r.range(-5, 5), r.range(1, 7), -dz * r.range(2, 8) + r.range(-5, 5), r.range(0.4, 0.8), 0.5, r.range(1.4, 2.4), 1.6, 0, 0.55, 0.04, 2.5, 3, 1.5);
            else if (r.chance(0.6)) this.arcs(ex, b.oy, ez, 2, 3, { life: 0.12, intensity: 16 });
            if (b.visLen >= b.maxLen - 0.6 && r.chance(0.25)) this.arena.barrierHit(P3(ex, b.oy, ez), c);
          }
        }
      }
    }

    // beam clash: the centrepiece
    const C = world.clash;
    if (C.on) {
      if (!this.clashOrbs) this.clashOrbs = [this.orbs.spawn(C.x, C.y, C.z, { kind: 2, life: 0, ramp: 0, heat: 0.72 }), this.orbs.spawn(C.x, C.y, C.z, { kind: 2, life: 0, ramp: 1, heat: 0.72 })];
      const grow = 1 + Math.min(1.2, C.t * 0.28);
      const pul = 1 + 0.1 * Math.sin(t * 47) + 0.06 * Math.sin(t * 83);
      // two half-merged balls: fire leaning toward Clawd, plasma toward Codex
      const cdx = F[1].x - F[0].x, cdz = F[1].z - F[0].z, cdl = Math.hypot(cdx, cdz) || 1;
      const fs = F[0].stats.element === 'fire' ? -1 : 1, off = 0.42 * grow;
      this.clashOrbs[0].m.position.set(C.x + (cdx / cdl) * off * fs, C.y, C.z + (cdz / cdl) * off * fs); this.clashOrbs[0].m.scale.setScalar(1.55 * grow * pul);
      this.clashOrbs[1].m.position.set(C.x - (cdx / cdl) * off * fs, C.y, C.z - (cdz / cdl) * off * fs); this.clashOrbs[1].m.scale.setScalar(1.5 * grow * (2 - pul));
      this.clashOrbs[0].m.rotation.y = t * 1.3; this.clashOrbs[1].m.rotation.y = -t * 1.7;
      this.arena.light(P3(C.x, C.y + 1, C.z), WHITE, 190, 0.1, 55);
      this.trauma = Math.max(this.trauma, 0.42 + Math.min(0.25, C.t * 0.06));
      this.screen.ca = Math.max(this.screen.ca, 0.0022 + 0.001 * Math.sin(t * 30));
      this.screen.radial = Math.max(this.screen.radial, 0.1);
      this.arena.shared.uPulse.value = Math.max(this.arena.shared.uPulse.value, 0.8);
      if (due('clash', 0.022)) {
        const ax = F[1].x - F[0].x, az = F[1].z - F[0].z, al = Math.hypot(ax, az) || 1;
        const nx = -az / al, nz = ax / al;
        this.glows.emit(C.x, C.y, C.z, 2.2 * grow, 1.6, 0.08, 5, 4.6, 4.4, { star: 1 });
        for (let j = 0; j < this.n(5); j++) {
          const ang = r.range(0, TAU), sp = r.range(12, 38);
          const sx = Math.cos(ang) * nx, sy = Math.sin(ang), sz = Math.cos(ang) * nz;
          this.sparks.emit(C.x, C.y, C.z, sx * sp + r.range(-4, 4), sy * sp, sz * sp + r.range(-4, 4), r.range(0.4, 1.0), 0.045, 1.7, j % 2, 16, 0.6);
        }
        if (r.chance(0.55)) {
          const ang = r.range(0, TAU), d = r.range(3, 9);
          this.bolts.strike(P3(C.x, C.y, C.z), P3(C.x + Math.cos(ang) * d, r.chance(0.6) ? 0.05 : r.range(2, 9), C.z + Math.sin(ang) * d), { width: 0.14, life: 0.12, intensity: 18, branches: 1, levels: 5, ...(r.chance(0.5) ? { r: FIRE.r, g: FIRE.g, b: FIRE.b } : {}) });
        }
        if (r.chance(0.3)) {
          const ang = r.range(0, TAU), d = r.range(0.5, 4.5);
          this.rubble.spawn(C.x + Math.cos(ang) * d, 0.1, C.z + Math.sin(ang) * d, Math.cos(ang) * 2, r.range(6, 15), Math.sin(ang) * 2, r.range(0.12, 0.4), r.range(1.2, 2.2));
          this.puff(C.x + Math.cos(ang) * d, 0.2, C.z + Math.sin(ang) * d, Math.cos(ang) * 6, r.range(0.5, 2), Math.sin(ang) * 6, 0.9, 0.4, 1.6, 0, 0, 0.35, 0.1, 2.5, 0.6);
        }
        if (r.chance(0.5)) this.puff(C.x, C.y, C.z, r.range(-9, 9), r.range(-2, 9), r.range(-9, 9), r.range(0.3, 0.6), 0.5, r.range(1.3, 2.4), 1.7, r.int(0, 1), 0.15, 0.04, 2.5, 2, 2);
        if (r.chance(0.12)) {
          this.shocks.emit(C.x, C.y, C.z, 9, 0.5, 0.05);
          this.shocks.emit(C.x, 0.05, C.z, 10, 0.6, 0.035, { ground: true });
          this.ground.add(C.x, C.z, 7, { mode: 0, life: 0.45, r: 9, g: 8, b: 7, seed: r.next() });
          this.decals.add(C.x + r.range(-2, 2), C.z + r.range(-2, 2), r.range(1.5, 3), { mode: r.int(0, 1), life: 14, intensity: 1.2, seed: r.next(), r: 0.3, g: 0.3, b: 0.3 });
        }
      }
    } else if (this.clashOrbs) { this.clashOrbs.forEach((o) => this.orbs.release(o)); this.clashOrbs = null; }

    // projectiles
    for (const p of world.projectiles) {
      const fx = this.projFx.get(p.id);
      if (!fx) continue;
      const ramp = (fx.ramp = p.kind === 'ember' ? 0 : 1), c = ramp === 0 ? FIRE : VOLT;
      this.trails.push(fx.tr, p.x, p.y, p.z);
      this.glows.emit(p.x, p.y, p.z, ramp === 0 ? 1.1 : 0.9, 0.6, 0.05, c.r * 9, c.g * 9, c.b * 9, { star: ramp, stretch: 1 });
      if (r.chance(dt * 60)) {
        if (ramp === 0) {
          this.puff(p.x, p.y, p.z, r.range(-1, 1), r.range(0, 2), r.range(-1, 1), r.range(0.25, 0.5), 0.3, 0.7, 1.5, 0, 0.35, 0.04, 2, 2, 1);
          this.sparks.emit(p.x, p.y, p.z, r.range(-4, 4) - p.vx * 0.1, r.range(-1, 5), r.range(-4, 4) - p.vz * 0.1, 0.4, 0.03, 1.4, 0);
        } else if (r.chance(0.5)) this.arcs(p.x, p.y, p.z, 1, 1.1, { life: 0.07, width: 0.06, intensity: 12 });
      }
      this.arena.light(p, c, 28, 0.08, 16);
    }

    this.puffs.update(dt, camera, t);
    this.sparks.update(dt);
    this.glows.update(dt, t);
    this.shocks.update(dt);
    this.bolts.update(dt, camera);
    this.trails.update(dt, camera);
    this.decals.update(dt);
    this.ground.update(dt);
    this.rubble.update(dt);
    this.cubes.update(dt);
    this.slashes.update(dt);
    this.orbs.update(dt);

    // screen pulses
    const S = this.screen, L = this.R.look;
    S.ca *= Math.exp(-dt * 7); S.radial *= Math.exp(-dt * 6); S.flash *= Math.exp(-dt * 9);
    L.ca = this.base.ca + Math.min(0.008, S.ca);
    L.radial = Math.min(1.2, S.radial);
    L.flash.set(S.flashCol.r, S.flashCol.g, S.flashCol.b, Math.min(0.95, S.flash));
    this.trauma = Math.max(0, this.trauma - dt * 1.7);
    this.kick.multiplyScalar(Math.exp(-dt * 12));
  }

  // New scene (next round, next shot): nothing from the last exchange may linger in the air.
  // Scenery — brazier flames, motes, mist — and the scars on the floor stay.
  clearCombat() {
    this.clearTransient();
    this.puffs.clearCombat(); this.glows.clearCombat();
    this.sparks.clear(); this.shocks.clear(); this.bolts.clear(); this.trails.clear(); this.ground.clear();
    this.rubble.clear(); this.cubes.clear(); this.slashes.clear(); this.orbs.clear();
    this.dashTrail = [null, null];
    for (const l of this.arena.dyn) l.intensity = 0;
    this.arena.shared.uPulse.value = 0;
    const S = this.screen;
    S.ca = 0; S.radial = 0; S.flash = 0;
    this.trauma = 0;
    this.kick.set(0, 0, 0);
  }

  clearTransient() {
    for (const [, fx] of this.projFx) fx.tr.ended = true;
    this.projFx.clear();
    for (const [, it] of this.zoneFx) it.dead = true;
    this.zoneFx.clear();
    for (let i = 0; i < 2; i++) if (this.chargeOrb[i]) { this.orbs.release(this.chargeOrb[i]); this.chargeOrb[i] = null; }
    if (this.clashOrbs) { this.clashOrbs.forEach((o) => this.orbs.release(o)); this.clashOrbs = null; }
  }
}
