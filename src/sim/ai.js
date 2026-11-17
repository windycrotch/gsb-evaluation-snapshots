import { BTN, ST, MAX_ENERGY, ARENA_R } from './constants.js';
import { RNG, clamp } from '../core/math.js';

// The bot plays through the same input frames a human does. It perceives the opponent through a
// reaction-time delay, rolls once per incoming threat to decide whether it parries / blocks /
// dodges / eats it, and runs combo scripts whose length depends on its skill.

export const LEVELS = {
  easy: { react: 0.42, block: 0.22, parry: 0.0, dodge: 0.08, aggro: 0.34, combo: 0.4, special: 0.25, ultIQ: 0.2, mash: 5.0, tech: 0.05, idle: 1.0, counterUlt: 0.1, punish: 0.1 },
  normal: { react: 0.27, block: 0.46, parry: 0.06, dodge: 0.26, aggro: 0.55, combo: 0.7, special: 0.5, ultIQ: 0.5, mash: 7.0, tech: 0.35, idle: 0.55, counterUlt: 0.4, punish: 0.45 },
  hard: { react: 0.17, block: 0.64, parry: 0.2, dodge: 0.48, aggro: 0.72, combo: 0.9, special: 0.75, ultIQ: 0.8, mash: 8.8, tech: 0.75, idle: 0.26, counterUlt: 0.75, punish: 0.8 },
  nightmare: { react: 0.09, block: 0.78, parry: 0.42, dodge: 0.7, aggro: 0.88, combo: 1.0, special: 0.95, ultIQ: 1.0, mash: 10.8, tech: 0.95, idle: 0.08, counterUlt: 1.0, punish: 1.0 },
};

const ROUTES = {
  full: ['L', 'L', 'L', 'L', 'JUMP', 'L', 'L', 'H'],
  air1: ['L', 'L', 'L', 'L', 'JUMP', 'L', 'H'],
  smash: ['L', 'L', 'L', 'H'],
  short: ['L', 'L', 'H'],
  poke: ['L', 'L'],
  three: ['L', 'L', 'L'],
  erupt: ['L', 'L', 'S2'],
  heavy: ['H'],
};
const BIT = { L: BTN.LIGHT, H: BTN.HEAVY, JUMP: BTN.JUMP, S1: BTN.S1, S2: BTN.S2, ULT: BTN.ULT, DASH: BTN.DASH };

export class Bot {
  constructor(idx, level = 'normal', seed = 7) {
    this.idx = idx;
    this.level = level;
    this.p = { ...LEVELS[level] };
    this.rng = new RNG(seed);
    this.out = { fwd: 0, strafe: 0, buttons: 0 };
    this.t = 0;
    this.hist = [];
    this.plan = 'circle';
    this.planT = 0.4;
    this.side = 1;
    this.pending = 0;
    this.tapCd = 0;
    this.script = null;
    this.si = 0;
    this.seq0 = null;
    this.scriptT = 0;
    this.threatId = null;
    this.response = 'none';
    this.blockHold = 0;
    this.mashT = 0;
    this.directive = null; // set by the showcase director to stage specific beats
  }

  tap(name) {
    if (this.tapCd > 0) return false;
    this.pending |= BIT[name];
    this.tapCd = 0.05;
    return true;
  }

  startScript(route) {
    this.script = typeof route === 'string' ? ROUTES[route] : route;
    this.si = 0;
    this.scriptT = 0;
    this.seq0 = null;
  }

  think(world, dt) {
    const me = world.fighters[this.idx], op = world.fighters[1 - this.idx];
    const out = this.out, p = this.p, rng = this.rng;
    this.t += dt;
    this.tapCd -= dt;
    out.fwd = 0; out.strafe = 0;
    let hold = 0;
    this.hist.push({ t: this.t, state: op.state, moveId: op.move ? op.move.id : null, seq: op.moveSeq, beam: op.beam.on });
    while (this.hist.length > 1 && this.hist[1].t <= this.t - p.react) this.hist.shift();
    const obs = this.hist[0];

    const finish = () => {
      out.buttons = hold | this.pending;
      this.pending = 0;
      return out;
    };
    if (!world.active || world.over) { this.script = null; return finish(); }

    const dx = op.x - me.x, dz = op.z - me.z, dist = Math.hypot(dx, dz) || 1e-3;
    const D = this.directive;

    if (me.state === ST.CLASH) {
      this.mashT -= dt;
      if (this.mashT <= 0) {
        this.pending |= BTN.LIGHT;
        const rate = D && D.mash ? D.mash : p.mash;
        this.mashT = (1 / rate) * rng.range(0.8, 1.25);
      }
      return finish();
    }
    if (me.state === ST.LAUNCH) {
      if (me.st > 0.45 && rng.chance(p.tech * dt * 5) && !(D && D.noTech)) this.pending |= BTN.DASH;
      this.script = null;
      return finish();
    }
    if (me.state === ST.DOWN) { if (me.st > 0.25 && rng.chance(dt * 6)) this.pending |= BTN.JUMP; return finish(); }
    if (me.state === ST.HIT || me.state === ST.STUN || me.state === ST.GETUP || me.state === ST.KO) {
      this.script = null;
      if (me.state === ST.HIT && op.beam.on && me.energy >= MAX_ENERGY && this.response === 'ult') this.tap('ULT');
      return finish();
    }

    // ---------------- defence ----------------------------------------------------------------------
    const canDefend = me.state === ST.IDLE || me.state === ST.BLOCK || (me.state === ST.ATTACK && me.move && me.st > me.move.dur - 0.12);
    const threat = D && D.noDefense ? null : this._threat(world, me, op, obs, dist);
    if (threat) {
      if (threat.id !== this.threatId) {
        this.threatId = threat.id;
        const r = rng.next();
        if (D && D.defense) this.response = D.defense;
        else if (threat.type === 'beam') this.response = me.energy >= MAX_ENERGY && rng.chance(p.counterUlt) ? 'ult' : rng.chance(p.dodge + 0.3) ? 'evade' : rng.chance(p.block + 0.2) ? 'block' : 'none';
        else if (threat.type === 'zone') this.response = rng.chance(0.35 + p.dodge) ? 'move' : 'none';
        else this.response = r < p.parry ? 'parry' : r < p.parry + p.block ? 'block' : r < p.parry + p.block + p.dodge ? 'dodge' : 'none';
        this.side = rng.sign();
      }
      if (canDefend) {
        switch (this.response) {
          case 'parry':
            if (threat.eta <= 0.085) this.blockHold = 0.26;
            else if (me.state === ST.BLOCK) this.blockHold = 0; // release so the re-press lands in the window
            break;
          case 'block':
            this.blockHold = Math.max(this.blockHold, threat.eta + 0.22);
            break;
          case 'dodge':
            if (threat.eta <= 0.15 && me.stamina >= 26) { out.strafe = this.side; out.fwd = threat.type === 'proj' ? 0 : -0.2; this.tap('DASH'); this.script = null; }
            else if (me.stamina < 26) this.blockHold = Math.max(this.blockHold, threat.eta + 0.2);
            break;
          case 'evade':
            out.strafe = this.side; out.fwd = 0.1;
            if (me.stamina >= 26 && threat.eta < 0.2 && rng.chance(dt * 10)) this.tap('DASH');
            this.script = null;
            return finish();
          case 'move': {
            const ax = me.x - threat.x, az = me.z - threat.z, al = Math.hypot(ax, az) || 1;
            const fx = Math.sin(me.yaw), fz = Math.cos(me.yaw);
            out.fwd = (ax / al) * fx + (az / al) * fz;
            out.strafe = (ax / al) * -fz + (az / al) * fx;
            if (threat.eta < 0.22 && me.stamina >= 26) this.tap('DASH');
            return finish();
          }
          case 'ult':
            this.tap('ULT');
            break;
        }
      }
    }
    if (this.blockHold > 0) {
      this.blockHold -= dt;
      hold |= BTN.BLOCK;
      this.script = null;
      if (!(D && D.defense === 'block' && D.keepBlocking)) return finish();
    }

    // ---------------- staged behaviour (showcase director) -------------------------------------------
    if (D && D.do && D.do !== 'free') {
      switch (D.do) {
        case 'idle': return finish();
        case 'block': hold |= BTN.BLOCK; return finish();
        case 'walk': out.fwd = D.fwd || 0; out.strafe = D.strafe || 0; return finish();
        case 'dashIn':
          out.fwd = 1;
          if (dist > (D.range || 5) && me.state === ST.IDLE && me.stamina >= 26) this.tap('DASH');
          return finish();
        case 'tap':
          // one-shot button with optional movement
          out.fwd = D.fwd || 0; out.strafe = D.strafe || 0;
          if (!D.done && (me.state === ST.IDLE || D.any) && this.tap(D.btn)) D.done = true;
          return finish();
        case 'script':
          if (!D.started) {
            if (dist > (D.range || 2.3)) {
              out.fwd = 1;
              if (dist > 6 && me.state === ST.IDLE && me.stamina >= 26 && D.dash !== false) this.tap('DASH');
              return finish();
            }
            D.started = true;
            this.startScript(D.script);
          }
          if (!this.script) { if (D.then) this.directive = D.then; else D.do = D.after || 'free'; }
          break;
      }
    }

    // ---------------- combo scripts ----------------------------------------------------------------
    if (this.script) {
      this._runScript(me, op, dist, dt, out);
      return finish();
    }
    if (me.state !== ST.IDLE) return finish();
    if (D && D.do === 'script') return finish();

    // ---------------- neutral ----------------------------------------------------------------------
    const opOpen = op.state === ST.STUN || (op.state === ST.ATTACK && op.move && !op.connected && !op.move.ult && op.st > (op.move.hits ? op.move.hits[0].t1 : 0.3));
    const opSafe = op.state === ST.DOWN || op.state === ST.GETUP || op.invuln > 0.1;
    if (me.energy >= MAX_ENERGY && dist > 3 && dist < 15 && op.grounded && !opSafe && !op.beam.on) {
      const good = opOpen || op.state === ST.HIT || op.state === ST.BLOCK;
      if (rng.chance(dt * (good ? 6 * p.ultIQ + 0.6 : 0.35 + (1 - p.ultIQ) * 0.5))) { this.tap('ULT'); return finish(); }
    }
    if (opOpen && dist < 7 && rng.chance(p.punish * dt * 12)) { this.plan = 'approach'; this.planT = 0.8; this.punishing = true; }

    this.planT -= dt;
    if (this.planT <= 0) this._choosePlan(me, op, dist);
    const range = 2.3 + me.stats.reach * 0.5;
    switch (this.plan) {
      case 'approach':
        out.fwd = 1;
        out.strafe = this.side * 0.18;
        if (dist > 6.5 && me.stamina > 55 && rng.chance(dt * 2.2 * p.aggro)) this.tap('DASH');
        if (dist > 4.5 && dist < 13 && !opSafe && rng.chance(dt * 1.1 * p.special)) {
          if (me.cdS2 <= 0 && rng.chance(0.45)) { this.tap('S2'); break; }
          if (me.cdS1 <= 0) { this.tap('S1'); break; }
        }
        if (dist < range && !opSafe && (this.punishing || rng.chance(dt * (5 + 11 * p.aggro)))) {
          const r = rng.next();
          let route;
          if (this.punishing || r < p.combo * 0.75) route = rng.chance(0.75) ? 'full' : 'air1';
          else if (r < p.combo) route = rng.pick(['smash', 'erupt', 'short']);
          else route = rng.pick(['poke', 'three', 'short', 'heavy']);
          if (route === 'erupt' && me.cdS2 > 0) route = 'smash';
          this.punishing = false;
          this.startScript(route);
        } else if (opSafe && dist < 3.2) {
          out.fwd = -0.6;
        } else if (dist < range) {
          out.fwd = 0.2;
        }
        break;
      case 'circle':
        out.strafe = this.side;
        out.fwd = dist > 7 ? 0.6 : dist < 3.6 ? -0.5 : 0.05;
        if (dist > 5 && dist < 13 && rng.chance(dt * 0.7 * p.special) && me.cdS1 <= 0) this.tap('S1');
        break;
      case 'retreat':
        out.fwd = -1;
        out.strafe = this.side * 0.5;
        if (Math.hypot(me.x, me.z) > ARENA_R - 3.5) { this.plan = 'circle'; this.planT = 0.6; }
        break;
      default:
        break; // 'wait'
    }
    return finish();
  }

  _choosePlan(me, op, dist) {
    const p = this.p, rng = this.rng;
    const w = {
      approach: p.aggro * 1.3 + (dist > 9 ? 0.4 : 0),
      circle: 0.35 + p.idle * 0.4,
      retreat: (1 - p.aggro) * 0.35 + (me.stamina < 30 ? 0.5 : 0) + (me.hp < 25 ? 0.15 : 0),
      wait: p.idle * 0.7,
    };
    let tot = 0;
    for (const k in w) tot += w[k];
    let r = rng.next() * tot;
    for (const k in w) { r -= w[k]; if (r <= 0) { this.plan = k; break; } }
    this.planT = this.plan === 'approach' ? rng.range(0.9, 2.2) : this.plan === 'wait' ? rng.range(0.3, 0.9) * (0.4 + p.idle) : rng.range(0.35, 1.0) * (0.6 + p.idle * 0.6);
    this.side = rng.sign();
  }

  _runScript(me, op, dist, dt, out) {
    if (this.seq0 === null) this.seq0 = me.moveSeq;
    this.scriptT += dt;
    out.fwd = 1;
    let step = this.script[this.si];
    // a step is consumed once the move it asked for has actually started
    if (step !== 'JUMP' && me.moveSeq !== this.seq0) { this.si++; this.seq0 = me.moveSeq; this.scriptT = 0; step = this.script[this.si]; }
    else if (step === 'JUMP' && me.state === ST.AIR) { this.si++; this.scriptT = 0; step = this.script[this.si]; }
    if (step === undefined || this.scriptT > 1.0) { this.script = null; return; }
    const m = me.move;
    if (me.state === ST.IDLE) {
      if (this.si === 0) this.tap(step);
      else if (this.scriptT > 0.2) this.script = null;
      return;
    }
    if (me.state === ST.ATTACK && m) {
      const whiffed = m.hits && !me.connected && me.st > m.hits[0].t1 + 0.02;
      if (step === 'JUMP') {
        if (!m.jumpCancel || whiffed) { this.script = null; return; }
        if (me.connected && me.st >= m.jumpCancel - 0.1) this.tap('JUMP');
        return;
      }
      if (whiffed && this.p.combo > 0.6 && !m.air) { this.script = null; return; } // good players do not finish a whiffed string
      const at = m.chain ? m.chain.at : m.dur;
      if (me.st >= at - 0.12) {
        if (!m.air || (dist < 3.0 && Math.abs(op.y - me.y) < 2.6) || step === 'H') this.tap(step);
      }
      return;
    }
    if (me.state === ST.AIR) {
      if (dist < 2.8 && Math.abs(op.y - me.y) < 2.4 && op.state === ST.LAUNCH) this.tap(step);
      else if (me.vy < -9) { if (step === 'H') this.tap('H'); else this.script = null; }
      return;
    }
    this.script = null;
  }

  // The most urgent thing about to hit this fighter, or null.
  _threat(world, me, op, obs, dist) {
    let best = null;
    const consider = (t) => { if (t.eta > -0.05 && (!best || t.eta < best.eta)) best = t; };
    const p = this.p;
    if (obs.state === ST.ATTACK && op.state === ST.ATTACK && op.move && obs.seq === op.moveSeq) {
      const m = op.move;
      if (m.ult) {
        const ax = Math.sin(op.yaw), az = Math.cos(op.yaw);
        const ex = me.x - op.x, ez = me.z - op.z;
        const along = ex * ax + ez * az, perp = Math.abs(ex * az - ez * ax);
        if (along > -1 && perp < 3.2) consider({ id: 'u' + op.moveSeq, type: 'beam', eta: Math.max(0, 0.95 - op.st) });
      } else if (m.hits) {
        for (let i = 0; i < m.hits.length; i++) {
          const h = m.hits[i];
          if (op.hitMask & (1 << i) || op.st > h.t1) continue;
          const reach = h.fwd + h.r + 1.0 + (m.lunge ? 1.6 : 0) + (m.dive !== undefined ? 3 : 0);
          if (dist < reach) consider({ id: 'm' + op.moveSeq, type: 'melee', eta: h.t0 - op.st });
        }
      }
    }
    for (const pr of world.projectiles) {
      if (pr.owner === me.idx || pr.t < p.react * 0.8) continue;
      const ex = me.x - pr.x, ez = me.z - pr.z;
      const sp = Math.hypot(pr.vx, pr.vz) || 1;
      const along = (ex * pr.vx + ez * pr.vz) / sp;
      const perp = Math.abs(ex * pr.vz - ez * pr.vx) / sp;
      if (along > 0 && perp < 1.7) consider({ id: 'p' + pr.id, type: 'proj', eta: along / sp });
    }
    for (const z of world.zones) {
      if (z.owner === me.idx || !z.warned || z.t < p.react * 0.8) continue;
      if (Math.hypot(me.x - z.x, me.z - z.z) < z.r + 0.7) consider({ id: 'z' + z.id, type: 'zone', eta: z.delay - z.t, x: z.x, z: z.z });
    }
    return best;
  }
}
