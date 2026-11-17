import { ARENA_R, GRAVITY, FIGHTER_R, CHEST_Y, HURT_R, MAX_HP, MAX_ENERGY, MAX_STAMINA, BTN, ST } from './constants.js';
import { MOVES, CHARS, ULT } from './moves.js';
import { RNG, clamp, damp, turnToward } from '../core/math.js';

// Deterministic fight simulation. Inputs in, state + events out; nothing here touches rendering.
// An input frame is { fwd, strafe, buttons }: movement relative to the lock-on axis (fwd = toward
// the opponent, strafe = to the fighter's right) plus a BTN bitmask. That is all a networked
// opponent would need to send.

const BUFFER = 0.22;
const PARRY_WINDOW = 0.15;
const DASH_T = 0.24;
const DASH_IFRAMES = 0.2;
const DASH_COST = 26;
const DMG_SCALE = 0.5; // global pacing knob: rounds should last 40-70 s between even opponents
const ACTIONS = [
  [BTN.ULT, 'ULT'], [BTN.S2, 'S2'], [BTN.S1, 'S1'], [BTN.HEAVY, 'H'], [BTN.LIGHT, 'L'], [BTN.DASH, 'DASH'], [BTN.JUMP, 'JUMP'],
];

function makeFighter(idx, char, x) {
  return {
    idx, char, stats: CHARS[char], moves: MOVES[char],
    x, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: x < 0 ? Math.PI / 2 : -Math.PI / 2,
    hp: MAX_HP, energy: 0, stamina: MAX_STAMINA, stamDelay: 0,
    state: ST.INTRO, st: 0, move: null, moveSeq: 0, hitMask: 0, connected: false,
    buf: null, bufT: 0, prev: 0, pressed: 0, held: 0, inF: 0, inS: 0, mashPress: 0, mash: 0,
    blockT: 0, blockStun: 0, invuln: 0, stunDur: 0,
    cdS1: 0, cdS2: 0, airDash: false, airLights: 0,
    juggle: 0, comboCount: 0, comboDmg: 0, spike: false, bounced: false, wallHit: false, dodged: false,
    dashX: 0, dashZ: 0, grounded: true, dived: false, landed: false, koDown: false, fastUlt: false,
    beam: { on: false, t: 0, len: 0, visLen: 0, maxLen: 0, yaw: 0, ox: 0, oy: 0, oz: 0, tick: 0, hitting: false },
    lastHitT: -9, // world time this fighter last took a hit (drives hurt animation / flashes)
  };
}

export class World {
  constructor({ chars = ['clawd', 'codex'], seed = 1, roundTime = 99 } = {}) {
    this.rng = new RNG(seed);
    this.time = 0;
    // Each mascot has a home corner: Clawd on the warm side (-x), Codex on the cool side (+x).
    const xs = chars[0] === chars[1] ? [-4.5, 4.5] : chars.map((c) => (c === 'clawd' ? -4.5 : 4.5));
    this.fighters = [makeFighter(0, chars[0], xs[0]), makeFighter(1, chars[1], xs[1])];
    this.projectiles = [];
    this.zones = [];
    this.events = [];
    this.groupHits = new Map();
    this.hitstop = 0;
    this.freezeT = 0;
    this.freezeOwner = -1;
    this.clash = { on: false, t: 0, c: 0.5, x: 0, y: 0, z: 0, max: 5.2 };
    this.over = false;
    this.winner = -1;
    this.overT = 0;
    this.roundTime = roundTime;
    this.timeLeft = roundTime;
    this.active = false; // fighters can act
    this.nextId = 1;
  }

  emit(e) { this.events.push(e); }

  begin() {
    this.active = true;
    for (const f of this.fighters) this._set(f, ST.IDLE);
  }

  _set(f, state) {
    f.state = state;
    f.st = 0;
    if (state !== ST.ATTACK) f.move = null;
  }

  _startMove(f, id) {
    const m = f.moves[id];
    f.state = ST.ATTACK;
    f.st = 0;
    f.move = m;
    f.moveSeq++;
    f.hitMask = 0;
    f.connected = false;
    f.dived = false;
    f.landed = false;
    f.buf = null;
    f.invuln = 0; // committing to an attack gives up any leftover dash / wake-up invulnerability
    if (id === 'AL') f.airLights++;
    this.emit({ type: 'move', f: f.idx, id });
  }

  _startUlt(f, o) {
    const fast = !!(o.move && o.move.ult) || o.beam.on;
    this._startMove(f, 'ULT');
    f.energy = 0;
    f.fastUlt = fast;
    f.vx = f.vz = 0;
    if (fast) {
      f.st = ULT.charge - 0.3;
      f.invuln = 0.32;
      this.emit({ type: 'ult_start', f: f.idx, fast: true });
    }
  }

  _startDash(f) {
    let dx = f.inF, dz = f.inS;
    if (Math.hypot(dx, dz) < 0.3) { dx = 1; dz = 0; }
    const l = Math.hypot(dx, dz);
    dx /= l; dz /= l;
    const fx = Math.sin(f.yaw), fz = Math.cos(f.yaw);
    f.dashX = fx * dx - fz * dz;
    f.dashZ = fz * dx + fx * dz;
    this._set(f, ST.DASH);
    f.invuln = Math.max(f.invuln, DASH_IFRAMES);
    f.stamina -= DASH_COST;
    f.stamDelay = 0.55;
    f.dodged = false;
    if (!f.grounded) { f.airDash = true; f.vy = 1.5; }
    this.emit({ type: 'dash', f: f.idx, air: !f.grounded, dx: f.dashX, dz: f.dashZ });
  }

  _jump(f, o, chase) {
    f.grounded = false;
    f.y = Math.max(f.y, 0.02);
    f.vy = f.stats.jump * (chase ? 1.06 : 1);
    if (chase) {
      // jump-cancel after a launcher: leap to where the opponent is going to be
      const dx = o.x - f.x, dz = o.z - f.z, d = Math.hypot(dx, dz) || 1;
      const sp = clamp((d - 1.0) / 0.4, 0, 14);
      f.vx = (dx / d) * sp; f.vz = (dz / d) * sp;
    }
    this._set(f, ST.AIR);
    this.emit({ type: 'jump', f: f.idx });
  }

  // Try to spend the buffered input. Returns true when it started something.
  _tryAction(f, o) {
    const b = f.buf;
    if (!b) return false;
    f.buf = null;
    const g = f.grounded;
    switch (b) {
      case 'L':
        if (g) { this._startMove(f, 'L1'); return true; }
        if (f.airLights < 3) { this._startMove(f, 'AL'); return true; }
        return false;
      case 'H':
        this._startMove(f, g ? 'H' : 'AH');
        return true;
      case 'S1':
        if (g && f.cdS1 <= 0) { this._startMove(f, 'S1'); f.cdS1 = f.moves.S1.cd; return true; }
        return false;
      case 'S2':
        if (g && f.cdS2 <= 0) { this._startMove(f, 'S2'); f.cdS2 = f.moves.S2.cd; return true; }
        return false;
      case 'ULT':
        if (g && f.energy >= MAX_ENERGY) { this._startUlt(f, o); return true; }
        return false;
      case 'DASH':
        if (f.stamina >= DASH_COST && (g || !f.airDash)) { this._startDash(f); return true; }
        return false;
      case 'JUMP':
        if (g) { this._jump(f, o, false); return true; }
        return false;
    }
    return false;
  }

  step(inputs, dt) {
    const F = this.fighters;
    for (let i = 0; i < 2; i++) {
      const f = F[i], inp = inputs[i] || { fwd: 0, strafe: 0, buttons: 0 };
      const edges = inp.buttons & ~f.prev;
      f.prev = f.held = inp.buttons;
      f.pressed |= edges;
      f.inF = clamp(inp.fwd || 0, -1, 1);
      f.inS = clamp(inp.strafe || 0, -1, 1);
      if (edges & (BTN.LIGHT | BTN.HEAVY | BTN.ULT)) f.mashPress++;
      for (const [bit, name] of ACTIONS) if (edges & bit) { f.buf = name; f.bufT = BUFFER; break; }
    }
    if (this.hitstop > 0) { this.hitstop -= dt; return; }
    this.time += dt;
    if (this.active && !this.over) {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) this._timeout();
    }
    if (this.over) this.overT += dt;
    const frozen = this.freezeT > 0;
    if (frozen) this.freezeT -= dt;
    for (let i = 0; i < 2; i++) {
      if (frozen && i !== this.freezeOwner) continue;
      this._stepFighter(F[i], F[1 - i], dt);
    }
    if (!frozen) {
      this._meleeHits();
      this._stepProjectiles(dt);
      this._stepZones(dt);
    }
    this._stepBeams(dt, frozen);
    this._separate();
    for (const f of F) { f.pressed = 0; f.mashPress = 0; }
  }

  _stepFighter(f, o, dt) {
    f.st += dt;
    if (f.buf && (f.bufT -= dt) <= 0) f.buf = null;
    f.invuln = Math.max(0, f.invuln - dt);
    f.cdS1 = Math.max(0, f.cdS1 - dt);
    f.cdS2 = Math.max(0, f.cdS2 - dt);
    f.blockStun = Math.max(0, f.blockStun - dt);
    if (f.stamDelay > 0) f.stamDelay -= dt;
    else f.stamina = Math.min(MAX_STAMINA, f.stamina + (f.state === ST.BLOCK ? 9 : 36) * dt);
    const free = this.active && !this.over;
    if (free) f.energy = Math.min(MAX_ENERGY, f.energy + 1.6 * dt);
    const dx = o.x - f.x, dz = o.z - f.z;
    const dist = Math.hypot(dx, dz) || 1e-4;
    const yawTo = Math.atan2(dx, dz);
    const fx = Math.sin(f.yaw), fz = Math.cos(f.yaw);
    // desired walk direction in world space (right-hand side of the fighter is (-fz, fx))
    let mx = fx * f.inF - fz * f.inS, mz = fz * f.inF + fx * f.inS;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }
    if (!free) { mx = 0; mz = 0; }

    switch (f.state) {
      case ST.IDLE: {
        f.yaw = turnToward(f.yaw, yawTo, 16 * dt);
        const sp = f.stats.speed * (f.inF < -0.3 ? 0.84 : 1);
        f.vx = damp(f.vx, mx * sp, 16, dt);
        f.vz = damp(f.vz, mz * sp, 16, dt);
        if (this.over && this.winner === f.idx && this.overT > 0.9) { this._set(f, ST.WIN); break; }
        if (free) {
          if (this._tryAction(f, o)) break;
          if (f.held & BTN.BLOCK) { this._set(f, ST.BLOCK); f.blockT = 0; }
        }
        break;
      }
      case ST.AIR: {
        f.yaw = turnToward(f.yaw, yawTo, 10 * dt);
        if (ml > 0.1) {
          f.vx = damp(f.vx, mx * f.stats.speed * 0.9, 3.5, dt);
          f.vz = damp(f.vz, mz * f.stats.speed * 0.9, 3.5, dt);
        }
        if (free) this._tryAction(f, o);
        break;
      }
      case ST.DASH: {
        const sp = f.stats.dash * (1 - 0.5 * Math.pow(Math.min(1, f.st / DASH_T), 2));
        f.vx = f.dashX * sp;
        f.vz = f.dashZ * sp;
        if (!f.grounded) f.vy = Math.max(f.vy, -2);
        if (free && f.st > 0.07 && f.grounded && (f.buf === 'L' || f.buf === 'H')) {
          const id = f.buf === 'L' ? 'DA' : 'H';
          f.yaw = yawTo;
          this._startMove(f, id);
          break;
        }
        if (f.st >= DASH_T) {
          f.vx *= 0.4; f.vz *= 0.4;
          this._set(f, f.grounded ? ST.IDLE : ST.AIR);
        }
        break;
      }
      case ST.ATTACK:
        this._runMove(f, o, dt, yawTo, dist, free);
        break;
      case ST.BLOCK: {
        f.blockT += dt;
        f.yaw = turnToward(f.yaw, yawTo, 14 * dt);
        f.vx = damp(f.vx, 0, 12, dt);
        f.vz = damp(f.vz, 0, 12, dt);
        if (free && (f.buf === 'DASH' || (f.buf === 'ULT' && f.energy >= MAX_ENERGY)) && f.blockStun <= 0) {
          if (this._tryAction(f, o)) break;
        }
        if ((!(f.held & BTN.BLOCK) || !free) && f.blockStun <= 0 && f.st > 0.12) this._set(f, ST.IDLE);
        break;
      }
      case ST.HIT: {
        f.vx = damp(f.vx, 0, 6.5, dt);
        f.vz = damp(f.vz, 0, 6.5, dt);
        // burst: answer an incoming ultimate with your own to force a beam clash
        if (free && f.buf === 'ULT' && f.energy >= MAX_ENERGY && o.beam.on && o.beam.t < 0.8 && f.grounded) {
          f.buf = null;
          this._startUlt(f, o);
          break;
        }
        if (f.st >= f.stunDur) { this._set(f, f.grounded ? ST.IDLE : ST.AIR); f.comboCount = 0; f.comboDmg = 0; f.juggle = 0; }
        break;
      }
      case ST.LAUNCH: {
        const k = Math.exp(-0.35 * dt);
        f.vx *= k; f.vz *= k;
        if (free && f.st > 0.42 && (f.pressed & (BTN.DASH | BTN.JUMP)) && f.stamina >= 16 && f.y > 0.6 && !f.spike) {
          // air tech
          f.stamina -= 16; f.stamDelay = 0.5;
          f.invuln = 0.32;
          f.vy = 8;
          const away = ml > 0.2 ? [mx, mz] : [-dx / dist, -dz / dist];
          f.vx = away[0] * 7.5; f.vz = away[1] * 7.5;
          f.comboCount = 0; f.comboDmg = 0; f.juggle = 0;
          this._set(f, ST.AIR);
          this.emit({ type: 'tech', f: f.idx });
        }
        break;
      }
      case ST.DOWN: {
        f.vx = damp(f.vx, 0, 5, dt);
        f.vz = damp(f.vz, 0, 5, dt);
        f.invuln = Math.max(f.invuln, 0.05);
        if (f.st > 0.55 || (f.st > 0.24 && f.pressed)) { this._set(f, ST.GETUP); this.emit({ type: 'getup', f: f.idx }); }
        break;
      }
      case ST.GETUP: {
        f.vx = damp(f.vx, 0, 10, dt);
        f.vz = damp(f.vz, 0, 10, dt);
        f.invuln = Math.max(f.invuln, 0.12);
        f.yaw = turnToward(f.yaw, yawTo, 12 * dt);
        if (f.st > 0.3) { this._set(f, ST.IDLE); f.comboCount = 0; f.comboDmg = 0; f.juggle = 0; }
        break;
      }
      case ST.STUN: {
        f.vx = damp(f.vx, 0, 8, dt);
        f.vz = damp(f.vz, 0, 8, dt);
        if (f.st >= f.stunDur) this._set(f, ST.IDLE);
        break;
      }
      case ST.CLASH:
        f.vx = f.vz = 0;
        break;
      case ST.KO: {
        const fr = f.grounded ? 5 : 0.3;
        f.vx = damp(f.vx, 0, fr, dt);
        f.vz = damp(f.vz, 0, fr, dt);
        break;
      }
      default:
        f.vx = damp(f.vx, 0, 10, dt);
        f.vz = damp(f.vz, 0, 10, dt);
        f.yaw = turnToward(f.yaw, yawTo, 6 * dt);
    }

    // --- integrate ------------------------------------------------------------------------------
    const wasGrounded = f.grounded;
    if (!f.grounded) {
      const hover = f.state === ST.DASH ? 0.15 : 1;
      f.vy -= GRAVITY * (1 + 0.1 * Math.min(f.juggle, 6)) * hover * dt;
    }
    f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
    if (f.y <= 0 && f.vy <= 0) {
      f.y = 0;
      const speed = -f.vy;
      f.vy = 0;
      f.grounded = true;
      if (!wasGrounded) this._land(f, speed);
    } else if (f.y > 0) {
      f.grounded = false;
    }
    // arena boundary
    const r = Math.hypot(f.x, f.z), R = ARENA_R - FIGHTER_R;
    if (r > R) {
      const nx = f.x / r, nz = f.z / r;
      f.x = nx * R; f.z = nz * R;
      const vr = f.vx * nx + f.vz * nz;
      if ((f.state === ST.LAUNCH || f.state === ST.KO) && vr > 8 && !f.wallHit) {
        f.wallHit = true;
        f.vx -= 1.5 * vr * nx; f.vz -= 1.5 * vr * nz;
        f.vy = Math.max(f.vy, 6);
        this.hitstop = Math.max(this.hitstop, 0.07);
        this.emit({ type: 'wall', f: f.idx, x: f.x + nx * FIGHTER_R, y: f.y + CHEST_Y, z: f.z + nz * FIGHTER_R, speed: vr });
        if (f.state === ST.LAUNCH) {
          f.hp -= 1.5;
          if (f.hp <= 0) this._ko(f, this.fighters[1 - f.idx], -nx, -nz);
        }
      } else if (vr > 0) {
        f.vx -= vr * nx; f.vz -= vr * nz;
      }
    }
  }

  _land(f, speed) {
    f.airDash = false;
    f.airLights = 0;
    switch (f.state) {
      case ST.AIR:
        this._set(f, ST.IDLE);
        this.emit({ type: 'land', f: f.idx, speed });
        break;
      case ST.ATTACK:
        if (f.move && f.move.air && f.move.dive === undefined) { this._set(f, ST.IDLE); this.emit({ type: 'land', f: f.idx, speed }); }
        break;
      case ST.LAUNCH:
        this.emit({ type: 'ground', f: f.idx, x: f.x, z: f.z, speed, spike: f.spike });
        if (f.spike && !f.bounced && speed > 14) {
          f.bounced = true;
          f.spike = false;
          f.vy = clamp(speed * 0.42, 7, 13);
          f.y = 0.02;
          f.grounded = false;
          this.hitstop = Math.max(this.hitstop, 0.06);
        } else {
          this._set(f, ST.DOWN);
        }
        break;
      case ST.KO:
        this.emit({ type: 'ground', f: f.idx, x: f.x, z: f.z, speed, spike: false, ko: true });
        if (!f.koDown && speed > 9) { f.koDown = true; f.vy = speed * 0.3; f.y = 0.02; f.grounded = false; }
        else f.koDown = true;
        break;
    }
  }

  _runMove(f, o, dt, yawTo, dist, free) {
    const m = f.move, t1 = f.st, t0 = t1 - dt;
    const sn = () => Math.sin(f.yaw), cs = () => Math.cos(f.yaw);
    if (m.track && t1 < m.track && !f.beam.on) f.yaw = turnToward(f.yaw, yawTo, (m.ult ? 6 : 12) * dt);
    let v = 0;
    if (m.lunge) for (const l of m.lunge) if (t1 >= l.t0 && t1 < l.t1) v = l.v;
    if (v > 0 && dist < 1.75 && Math.abs(o.y - f.y) < 1.6) v = 0; // do not shove through the target
    if (m.ult) {
      f.vx = f.vz = 0;
      if (t1 < ULT.charge) f.invuln = Math.max(f.invuln, 0.05);
    } else if (m.dive !== undefined) {
      if (t1 < m.dive) {
        f.vy = Math.max(f.vy, 2.5);
        f.vx = damp(f.vx, 0, 8, dt); f.vz = damp(f.vz, 0, 8, dt);
      } else if (!f.dived) {
        f.dived = true;
        f.vy = -44;
        const tGround = Math.max(0.1, f.y / 44);
        const sp = Math.min(Math.max(dist - 0.6, 0) / tGround, 20);
        f.vx = sn() * sp; f.vz = cs() * sp;
      }
      if (f.dived && f.grounded && !f.landed) {
        f.landed = true;
        f.vx = f.vz = 0;
        f.hitMask = -1;
        f.st = m.dur - m.landRecover;
        this._slam(f, o, m.slam);
      }
    } else if (m.air) {
      if (v > 0) { f.vx = sn() * v; f.vz = cs() * v; }
      f.vy = Math.max(f.vy, -6); // air normals float a little so strings connect
    } else {
      f.vx = damp(f.vx, sn() * v, v > 0 ? 40 : 11, dt);
      f.vz = damp(f.vz, cs() * v, v > 0 ? 40 : 11, dt);
    }
    if (m.ev) for (const ev of m.ev) if (ev.t >= t0 && ev.t < t1) this._moveEvent(f, o, m, ev);
    if (m.hits) for (const h of m.hits) if (h.t0 >= t0 && h.t0 < t1) this.emit({ type: 'swing', f: f.idx, id: m.id, hand: m.hand, kind: h.kind });
    if (f.state !== ST.ATTACK || f.move !== m) return;

    if (free && f.buf) {
      if (m.chain && t1 >= m.chain.at) {
        let next = f.buf === 'L' ? m.chain.L : f.buf === 'H' ? m.chain.H : null;
        if (next === 'AL' && f.airLights >= 3) next = 'AH';
        if (next) { this._startMove(f, next); return; }
        if (f.connected && (f.buf === 'S1' || f.buf === 'S2' || f.buf === 'ULT' || f.buf === 'DASH')) {
          if (this._tryAction(f, o)) return;
        }
      }
      if (m.jumpCancel && f.connected && t1 >= m.jumpCancel && f.buf === 'JUMP') {
        f.buf = null;
        this._jump(f, o, true);
        return;
      }
    }
    if (t1 >= m.dur) this._set(f, f.grounded ? ST.IDLE : ST.AIR);
  }

  _moveEvent(f, o, m, ev) {
    switch (ev.type) {
      case 'proj': {
        const fx = Math.sin(f.yaw), fz = Math.cos(f.yaw);
        const ox = f.x + fx * 1.25, oy = f.y + 1.15, oz = f.z + fz * 1.25;
        const tx = o.x - ox, ty = o.y + CHEST_Y - oy, tz = o.z - oz;
        const d = Math.hypot(tx, tz) || 1;
        const yaw = Math.atan2(tx, tz) + ev.spread;
        const pitch = Math.atan2(ty, d);
        const cp = Math.cos(pitch);
        const p = {
          id: this.nextId++, owner: f.idx, kind: ev.kind, x: ox, y: oy, z: oz,
          vx: Math.sin(yaw) * cp * ev.speed, vy: Math.sin(pitch) * ev.speed, vz: Math.cos(yaw) * cp * ev.speed,
          speed: ev.speed, r: ev.r, dmg: ev.dmg, kb: ev.kb, stun: ev.stun, launch: ev.launch, life: ev.life, homing: ev.homing, t: 0,
          stop: 0.04, kind2: 'special',
        };
        this.projectiles.push(p);
        this.emit({ type: 'proj_spawn', id: p.id, f: f.idx, kind: p.kind, x: ox, y: oy, z: oz });
        break;
      }
      case 'erupt': {
        const fx = Math.sin(f.yaw), fz = Math.cos(f.yaw);
        const group = this.nextId++;
        for (let i = 0; i < ev.count; i++) {
          const d = ev.first + ev.gap * i;
          const x = f.x + fx * d, z = f.z + fz * d;
          if (Math.hypot(x, z) > ARENA_R - 0.4) break;
          this.zones.push({ id: this.nextId++, owner: f.idx, kind: 'erupt', x, z, r: ev.r, wait: 0, delay: ev.delay + ev.step * i, t: 0, warned: false, dmg: ev.dmg, launch: ev.launch, group, maxY: 5, seq: i });
        }
        this.emit({ type: 'cast', f: f.idx, kind: 'erupt', x: f.x + fx * 1.2, z: f.z + fz * 1.2 });
        break;
      }
      case 'storm': {
        const group = this.nextId++;
        for (let i = 0; i < ev.count; i++) {
          this.zones.push({ id: this.nextId++, owner: f.idx, kind: 'storm', x: o.x, z: o.z, r: ev.r, wait: ev.step * i, delay: ev.delay, t: 0, warned: false, dmg: ev.dmg, launch: i === ev.count - 1 ? ev.launch : null, group: group + i * 0, maxY: 99, lead: ev.lead, seq: i, perHit: true });
        }
        this.emit({ type: 'cast', f: f.idx, kind: 'storm', x: f.x, z: f.z });
        break;
      }
      case 'ult_start':
        if (!f.fastUlt) {
          this.freezeT = ULT.charge - 0.1;
          this.freezeOwner = f.idx;
          this.emit({ type: 'ult_start', f: f.idx, fast: false });
        }
        break;
      case 'beam_start': {
        const b = f.beam;
        b.on = true; b.t = 0; b.len = 0; b.visLen = 0; b.yaw = f.yaw; b.tick = 0; b.hitting = false;
        this.emit({ type: 'beam_start', f: f.idx });
        break;
      }
      case 'beam_end':
        if (f.beam.on) { f.beam.on = false; this.emit({ type: 'beam_end', f: f.idx }); }
        break;
    }
  }

  _slam(f, o, s) {
    this.emit({ type: 'slam', f: f.idx, x: f.x, z: f.z, r: s.r });
    this.hitstop = Math.max(this.hitstop, 0.05);
    const dx = o.x - f.x, dz = o.z - f.z, d = Math.hypot(dx, dz) || 1;
    if (d < s.r + 0.4 && o.y < 3.2) {
      this._hit(f, o, { dmg: s.dmg, launch: s.launch, stun: 0.5, stop: s.stop, kind: 'slam' }, o.x, o.y + 0.6, o.z, dx / d, dz / d);
    }
  }

  _meleeHits() {
    const F = this.fighters, pend = [];
    for (const f of F) {
      if (f.state !== ST.ATTACK || !f.move || !f.move.hits) continue;
      const o = F[1 - f.idx], fx = Math.sin(f.yaw), fz = Math.cos(f.yaw);
      f.move.hits.forEach((h, i) => {
        if (f.st < h.t0 || f.st > h.t1 || f.hitMask & (1 << i)) return;
        const hx = f.x + fx * h.fwd, hy = f.y + h.up, hz = f.z + fz * h.fwd;
        const ex = o.x - hx, ey = o.y + CHEST_Y - hy, ez = o.z - hz;
        const rr = h.r + f.stats.reach + HURT_R;
        if (ex * ex + ey * ey + ez * ez < rr * rr) pend.push({ f, o, h, i, fx, fz });
      });
    }
    const melee = (p) => p.h.kind === 'light' || p.h.kind === 'heavy';
    if (pend.length === 2 && pend[0].f !== pend[1].f && melee(pend[0]) && melee(pend[1]) && pend[0].f.invuln <= 0 && pend[1].f.invuln <= 0 && pend[0].f.grounded && pend[1].f.grounded) {
      // simultaneous strikes cancel out in a clang
      const [a, b] = pend;
      for (const p of pend) {
        p.f.hitMask |= 1 << p.i;
        p.f.vx = -p.fx * 9; p.f.vz = -p.fz * 9;
        this._set(p.f, ST.STUN);
        p.f.stunDur = 0.3;
        p.f.energy = Math.min(MAX_ENERGY, p.f.energy + 4);
      }
      this.hitstop = Math.max(this.hitstop, 0.1);
      this.emit({ type: 'clang', x: (a.f.x + b.f.x) / 2, y: 1.15, z: (a.f.z + b.f.z) / 2 });
      return;
    }
    for (const p of pend) {
      // near-simultaneous strikes also clang: if the target's own swing is about to land, neither wins
      const o = p.o;
      if (melee(p) && o.state === ST.ATTACK && o.move && o.move.hits && !o.move.armor && !p.f.move.armor && o.grounded && p.f.grounded && o.invuln <= 0) {
        const h2 = o.move.hits[0];
        const facing = Math.sin(o.yaw) * p.fx + Math.cos(o.yaw) * p.fz < -0.4;
        if (facing && (h2.kind === 'light' || h2.kind === 'heavy') && !(o.hitMask & 1) && o.st >= h2.t0 - 0.04 && o.st <= h2.t1) {
          for (const f of [p.f, o]) {
            const bx = Math.sin(f.yaw), bz = Math.cos(f.yaw);
            f.hitMask = -1;
            f.vx = -bx * 9; f.vz = -bz * 9;
            this._set(f, ST.STUN);
            f.stunDur = 0.3;
            f.energy = Math.min(MAX_ENERGY, f.energy + 4);
          }
          this.hitstop = Math.max(this.hitstop, 0.1);
          this.emit({ type: 'clang', x: (p.f.x + o.x) / 2, y: 1.15, z: (p.f.z + o.z) / 2 });
          return;
        }
      }
      p.f.hitMask |= 1 << p.i;
      const ix = p.o.x - p.fx * 0.55, iz = p.o.z - p.fz * 0.55;
      const res = this._hit(p.f, p.o, p.h, ix, p.o.y + CHEST_Y + 0.1, iz, p.fx, p.fz);
      if (res === 'parry' && !(p.f.move && p.f.move.ult)) {
        // a parried strike leaves the attacker wide open
        p.f.vx = -p.fx * 6; p.f.vz = -p.fz * 6;
        this._set(p.f, ST.STUN);
        p.f.stunDur = 0.85;
      }
    }
  }

  // Resolve one hit. Returns 'hit' | 'block' | 'parry' | 'dodge' | 'miss'.
  _hit(att, def, h, px, py, pz, dirx, dirz) {
    if (def.state === ST.KO || this.over) return 'miss';
    if (def.invuln > 0) {
      if (def.state === ST.DASH && !def.dodged) {
        def.dodged = true;
        def.energy = Math.min(MAX_ENERGY, def.energy + 7);
        def.stamina = Math.min(MAX_STAMINA, def.stamina + 18);
        this.emit({ type: 'dodge', f: def.idx, x: def.x, y: def.y + CHEST_Y, z: def.z });
      }
      return 'dodge';
    }
    const kind = h.kind || 'special';
    const ax = (h.srcX ?? att.x) - def.x, az = (h.srcZ ?? att.z) - def.z;
    const facing = Math.cos(def.yaw - Math.atan2(ax, az)) > 0.15;
    const base = { type: 'hit', f: att.idx, t: def.idx, x: px, y: py, z: pz, dx: dirx, dz: dirz, kind, beam: !!h.beam, element: att.stats.element };
    if (def.state === ST.BLOCK && facing) {
      if (def.blockT <= PARRY_WINDOW && !h.beam && kind !== 'slam') {
        def.energy = Math.min(MAX_ENERGY, def.energy + 12);
        def.stamina = Math.min(MAX_STAMINA, def.stamina + 25);
        this.hitstop = Math.max(this.hitstop, 0.14);
        this.emit({ ...base, type: 'parry', f: def.idx, t: att.idx });
        return 'parry';
      }
      const chip = h.dmg * att.stats.dmg * DMG_SCALE * 0.16;
      def.hp = Math.max(0.5, def.hp - chip);
      def.stamina -= h.dmg * 3 + (h.guard || 0);
      def.stamDelay = 0.7;
      def.blockStun = 0.2;
      def.vx = dirx * (h.beam ? 4 : 5.5); def.vz = dirz * (h.beam ? 4 : 5.5);
      this.hitstop = Math.max(this.hitstop, (h.stop || 0) * 0.6);
      this.emit({ ...base, blocked: true, dmg: chip });
      if (def.stamina <= 0) {
        def.stamina = 40;
        this._set(def, ST.STUN);
        def.stunDur = 1.1;
        this.hitstop = Math.max(this.hitstop, 0.12);
        this.emit({ type: 'guardbreak', f: def.idx, x: def.x, y: def.y + CHEST_Y, z: def.z });
      }
      return 'block';
    }
    const m = def.move;
    const armored = (def.state === ST.ATTACK && m && ((m.armor && def.st >= m.armor[0] && def.st <= m.armor[1]) || m.ult) && kind !== 'ult') || (def.state === ST.CLASH);
    const scale = kind === 'ult' ? 1 : Math.max(0.4, Math.pow(0.9, def.comboCount));
    const dmg = h.dmg * att.stats.dmg * def.stats.def * DMG_SCALE * scale * (armored ? 0.55 : 1);
    def.hp -= dmg;
    def.lastHitT = this.time;
    if (!h.beam) att.energy = Math.min(MAX_ENERGY, att.energy + dmg * 2.3);
    def.energy = Math.min(MAX_ENERGY, def.energy + dmg * 1.7);
    att.connected = true;
    let launched = false;
    if (!armored) {
      if (def.beam.on) { def.beam.on = false; this.emit({ type: 'beam_end', f: def.idx }); }
      const airborne = !def.grounded || def.state === ST.LAUNCH;
      const L = h.launch || (airborne ? [h.kb || 4, 7] : null);
      if (L) {
        launched = true;
        def.vx = dirx * L[0]; def.vz = dirz * L[0];
        if (L[1] < 0 && def.grounded) { def.vy = -L[1] * 0.32; def.bounced = true; def.spike = false; }
        else { def.vy = L[1]; def.spike = !!h.bounce && L[1] < 0; def.bounced = false; }
        def.grounded = false;
        def.y = Math.max(def.y, 0.03);
        if (def.state === ST.LAUNCH || def.state === ST.HIT) def.juggle++;
        def.wallHit = false;
        this._set(def, ST.LAUNCH);
      } else {
        def.vx = dirx * (h.kb || 4); def.vz = dirz * (h.kb || 4);
        this._set(def, ST.HIT);
        def.stunDur = (h.stun || 0.3) * def.stats.poise;
      }
      def.comboCount++;
      def.comboDmg += dmg;
    }
    this.hitstop = Math.max(this.hitstop, h.stop || 0);
    this.emit({ ...base, dmg, launch: launched, armored, combo: def.comboCount, comboDmg: def.comboDmg });
    if (def.hp <= 0) this._ko(def, att, dirx, dirz);
    return 'hit';
  }

  _ko(def, att, dirx, dirz) {
    def.hp = 0;
    def.beam.on = false;
    this._set(def, ST.KO);
    def.grounded = false;
    def.y = Math.max(def.y, 0.05);
    def.vx = dirx * 15; def.vz = dirz * 15; def.vy = 12.5;
    def.wallHit = false;
    def.koDown = false;
    this.over = true;
    this.winner = att.idx;
    this.overT = 0;
    this.hitstop = Math.max(this.hitstop, 0.3);
    this.emit({ type: 'ko', f: def.idx, winner: att.idx, x: def.x, y: def.y + CHEST_Y, z: def.z });
  }

  _timeout() {
    const [a, b] = this.fighters;
    this.over = true;
    this.overT = 0;
    this.winner = a.hp === b.hp ? -1 : a.hp > b.hp ? 0 : 1;
    this.emit({ type: 'timeout', winner: this.winner });
  }

  _stepProjectiles(dt) {
    const P = this.projectiles, F = this.fighters;
    for (const p of P) {
      if (p.dead) continue;
      p.t += dt;
      const o = F[1 - p.owner];
      const tx = o.x - p.x, ty = o.y + CHEST_Y - p.y, tz = o.z - p.z;
      const td = Math.hypot(tx, ty, tz) || 1;
      if (p.homing && p.t < 0.7 && td > 2) {
        const k = Math.min(1, p.homing * dt);
        let vx = p.vx / p.speed + (tx / td - p.vx / p.speed) * k;
        let vy = p.vy / p.speed + (ty / td - p.vy / p.speed) * k;
        let vz = p.vz / p.speed + (tz / td - p.vz / p.speed) * k;
        const l = Math.hypot(vx, vy, vz) || 1;
        p.vx = (vx / l) * p.speed; p.vy = (vy / l) * p.speed; p.vz = (vz / l) * p.speed;
      }
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const ex = o.x - p.x, ey = o.y + CHEST_Y - p.y, ez = o.z - p.z;
      if (ex * ex + ey * ey + ez * ez < (p.r + HURT_R * 0.92) ** 2) {
        const hl = Math.hypot(p.vx, p.vz) || 1;
        const res = this._hit(F[p.owner], o, { dmg: p.dmg, kb: p.kb, stun: p.stun, launch: p.launch, stop: p.stop, kind: 'special', srcX: p.x - p.vx * 0.1, srcZ: p.z - p.vz * 0.1 }, p.x, p.y, p.z, p.vx / hl, p.vz / hl);
        if (res === 'parry') {
          p.owner = o.idx; p.vx *= -1.2; p.vy *= -1; p.vz *= -1.2; p.speed *= 1.2; p.t = 0; p.dmg *= 1.4; p.homing = 2;
          this.emit({ type: 'proj_reflect', id: p.id, f: o.idx, x: p.x, y: p.y, z: p.z });
        } else if (res !== 'dodge' && res !== 'miss') {
          this._endProj(p, 'hit');
        }
        continue;
      }
      if (p.y < 0.2) this._endProj(p, 'ground');
      else if (Math.hypot(p.x, p.z) > ARENA_R + 0.5) this._endProj(p, 'wall');
      else if (p.t > p.life) this._endProj(p, 'fizzle');
    }
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
      const a = P[i], b = P[j];
      if (a.dead || b.dead || a.owner === b.owner) continue;
      if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < a.r + b.r + 0.35) {
        this.emit({ type: 'proj_clash', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
        this._endProj(a, 'clash'); this._endProj(b, 'clash');
      }
    }
    if (P.some((p) => p.dead)) this.projectiles = P.filter((p) => !p.dead);
  }

  _endProj(p, reason) {
    p.dead = true;
    this.emit({ type: 'proj_end', id: p.id, f: p.owner, kind: p.kind, x: p.x, y: Math.max(p.y, 0.1), z: p.z, reason });
  }

  _stepZones(dt) {
    const F = this.fighters;
    for (const z of this.zones) {
      if (z.dead) continue;
      const o = F[1 - z.owner];
      if (z.wait > 0) { z.wait -= dt; if (z.wait > 0) continue; }
      if (!z.warned) {
        z.warned = true;
        if (z.kind === 'storm') {
          // each strike re-acquires the target, leading its movement
          const j = z.seq * 0.9;
          z.x = o.x + o.vx * z.lead + this.rng.range(-j, j);
          z.z = o.z + o.vz * z.lead + this.rng.range(-j, j);
          const r = Math.hypot(z.x, z.z);
          if (r > ARENA_R - 1) { z.x *= (ARENA_R - 1) / r; z.z *= (ARENA_R - 1) / r; }
        }
        this.emit({ type: 'zone_warn', id: z.id, f: z.owner, kind: z.kind, x: z.x, z: z.z, r: z.r, delay: z.delay });
      }
      z.t += dt;
      if (z.t >= z.delay) {
        z.dead = true;
        this.emit({ type: 'zone_fire', id: z.id, f: z.owner, kind: z.kind, x: z.x, z: z.z, r: z.r });
        const dx = o.x - z.x, dz = o.z - z.z, d = Math.hypot(dx, dz);
        const key = z.group + ':' + o.idx;
        if (d < z.r + 0.45 && o.y < z.maxY && (z.perHit || !this.groupHits.has(key))) {
          const att = F[z.owner];
          const ax = o.x - att.x, az = o.z - att.z, al = Math.hypot(ax, az) || 1;
          const res = this._hit(att, o, { dmg: z.dmg, launch: z.launch, kb: 3, stun: 0.55, stop: 0.09, kind: 'special', srcX: z.x - ax / al, srcZ: z.z - az / al }, o.x, o.y + CHEST_Y, o.z, ax / al, az / al);
          if (res === 'hit' || res === 'block') this.groupHits.set(key, true);
        }
      }
    }
    if (this.zones.some((z) => z.dead)) this.zones = this.zones.filter((z) => !z.dead);
  }

  _stepBeams(dt, frozen) {
    const F = this.fighters, C = this.clash;
    for (const f of F) {
      const b = f.beam;
      if (!b.on || (frozen && f.idx !== this.freezeOwner)) continue;
      const o = F[1 - f.idx];
      b.t += dt;
      if (!C.on) {
        b.yaw = turnToward(b.yaw, Math.atan2(o.x - f.x, o.z - f.z), 0.55 * dt);
        f.yaw = b.yaw;
      }
      const dx = Math.sin(b.yaw), dz = Math.cos(b.yaw);
      b.ox = f.x + dx * 1.35; b.oy = f.y + 1.12; b.oz = f.z + dz * 1.35;
      // ray vs barrier circle
      const R = ARENA_R + 0.8, bq = b.ox * dx + b.oz * dz, cq = b.ox * b.ox + b.oz * b.oz - R * R;
      b.maxLen = -bq + Math.sqrt(Math.max(0, bq * bq - cq));
      b.len = Math.min(b.len + 95 * dt, b.maxLen);
      b.visLen = b.len;
      b.hitting = false;
    }
    const [A, B] = F;
    if (!C.on && A.beam.on && B.beam.on && !frozen) {
      const ax = Math.sin(A.beam.yaw), az = Math.cos(A.beam.yaw), bx = Math.sin(B.beam.yaw), bz = Math.cos(B.beam.yaw);
      const ox = B.beam.ox - A.beam.ox, oz = B.beam.oz - A.beam.oz, d = Math.hypot(ox, oz);
      const perp = Math.abs(ox * az - oz * ax);
      if (ax * bx + az * bz < -0.5 && perp < 2.6 && A.beam.len + B.beam.len >= d - 0.5 && d > 2) {
        C.on = true; C.t = 0; C.d = d;
        C.c = clamp(A.beam.len / Math.max(0.01, A.beam.len + B.beam.len), 0.25, 0.75);
        // square the beams up so they meet head on
        A.beam.yaw = A.yaw = Math.atan2(ox, oz); B.beam.yaw = B.yaw = Math.atan2(-ox, -oz);
        for (const f of F) { this._set(f, ST.CLASH); f.mash = 0; f.invuln = 0; }
        this.hitstop = Math.max(this.hitstop, 0.12);
        this.emit({ type: 'clash_start' });
      }
    }
    if (C.on) {
      C.t += dt;
      for (const f of F) f.mash = f.mash * Math.exp(-3.2 * dt) + f.mashPress;
      C.c = clamp(C.c + (A.mash - B.mash) * 0.085 * (1 + C.t * 0.3) * dt, 0, 1);
      const ox = B.beam.ox - A.beam.ox, oz = B.beam.oz - A.beam.oz, d = Math.hypot(ox, oz);
      C.x = A.beam.ox + ox * C.c; C.y = A.beam.oy; C.z = A.beam.oz + oz * C.c;
      A.beam.visLen = d * C.c; B.beam.visLen = d * (1 - C.c);
      A.beam.hitting = B.beam.hitting = true;
      let winner = -2;
      if (C.c >= 0.9) winner = 0;
      else if (C.c <= 0.1) winner = 1;
      else if (C.t >= C.max) winner = C.c > 0.56 ? 0 : C.c < 0.44 ? 1 : -1;
      if (winner > -2) {
        C.on = false;
        this.hitstop = Math.max(this.hitstop, 0.22);
        this.emit({ type: 'clash_end', winner, x: C.x, y: C.y, z: C.z });
        for (const f of F) {
          f.beam.on = false;
          this.emit({ type: 'beam_end', f: f.idx });
          const o = F[1 - f.idx];
          const dx = f.x - o.x, dz = f.z - o.z, l = Math.hypot(dx, dz) || 1;
          if (winner === f.idx) {
            this._set(f, ST.STUN);
            f.stunDur = 0.35;
          } else {
            this._set(f, ST.IDLE);
            const draw = winner === -1;
            this._hit(o, f, { dmg: draw ? 9 : 27, launch: draw ? [15, 10] : [24, 13], stop: 0.1, kind: 'ult' }, f.x, f.y + CHEST_Y, f.z, dx / l, dz / l);
          }
        }
      }
      return;
    }
    for (const f of F) {
      const b = f.beam;
      if (!b.on || frozen) continue;
      const o = F[1 - f.idx];
      const dx = Math.sin(b.yaw), dz = Math.cos(b.yaw);
      const ex = o.x - b.ox, ey = o.y + CHEST_Y - b.oy, ez = o.z - b.oz;
      const s = ex * dx + ez * dz;
      const px = ex - dx * s, pz = ez - dz * s;
      const perp = Math.hypot(px, ey, pz);
      if (s > -0.6 && s < b.len + 0.8 && perp < ULT.radius + 0.8 && o.state !== ST.KO && o.invuln <= 0) {
        b.hitting = true;
        b.visLen = Math.min(b.len, Math.max(1, s + 0.2));
        b.tick -= dt;
        if (b.tick <= 0) {
          b.tick += ULT.tick;
          const last = b.t > ULT.beam - 0.14;
          this._hit(f, o, { dmg: ULT.dmg, kb: 10, stun: 0.3, stop: 0, guard: 3, kind: 'ult', beam: true, launch: last ? [20, 11] : null }, o.x - dx * 0.6, o.y + CHEST_Y, o.z - dz * 0.6, dx, dz);
        }
      } else {
        b.tick = Math.min(b.tick, 0.03);
      }
    }
  }

  _separate() {
    const [a, b] = this.fighters;
    const pass = (f) => f.state === ST.KO || f.state === ST.DOWN || (f.state === ST.DASH && f.invuln > 0) || f.state === ST.LAUNCH;
    if (pass(a) || pass(b) || Math.abs(a.y - b.y) > 1.7) return;
    let dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
    const min = FIGHTER_R * 1.9;
    if (d >= min) return;
    if (d < 1e-3) { dx = 1; dz = 0; d = 1; }
    const push = (min - d) / 2;
    a.x -= (dx / d) * push; a.z -= (dz / d) * push;
    b.x += (dx / d) * push; b.z += (dz / d) * push;
    for (const f of this.fighters) {
      const r = Math.hypot(f.x, f.z), R = ARENA_R - FIGHTER_R;
      if (r > R) { f.x *= R / r; f.z *= R / r; }
    }
  }
}
