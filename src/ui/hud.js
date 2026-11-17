import { MAX_HP, MAX_ENERGY, MAX_STAMINA } from '../sim/constants.js';
import { CHARS } from '../sim/moves.js';
import { ease, sat } from '../core/math.js';

// DOM heads-up display. Every animated value is computed from sim state and a clock the caller
// advances, never CSS transitions, so the capture renders it deterministically.

export const TINT = { clawd: 'var(--fire)', codex: 'var(--volt)' };

const sideHtml = (cls) => `
  <div class="side ${cls}">
    <div class="row"><span class="name"></span><span class="pips"><i></i><i></i></span></div>
    <div class="hp"><div class="ghost"></div><div class="fill"></div></div>
    <div class="sub"><div class="en"><div></div></div><div class="stam"><div></div></div></div>
  </div>`;

export class HUD {
  constructor(root) {
    const el = (this.el = document.createElement('div'));
    el.className = 'hud hidden';
    el.innerHTML = `
      <div class="top">${sideHtml('left')}<div class="clock">99</div>${sideHtml('right')}</div>
      <div class="combo l"><b>0</b><span>hits</span></div>
      <div class="combo r"><b>0</b><span>hits</span></div>
      <div class="announce"><div class="big"></div><div class="small"></div></div>
      <div class="clash"><div class="track"><div class="a"></div></div><div class="hint">Mash <kbd>J</kbd></div></div>
      <div class="moves"></div>
      <div class="keys"></div>`;
    root.appendChild(el);
    const q = (s) => el.querySelector(s);
    this.sides = ['.left', '.right'].map((s) => {
      const e = q(s);
      return { el: e, name: e.querySelector('.name'), pips: [...e.querySelectorAll('.pips i')], fill: e.querySelector('.hp .fill'), ghost: e.querySelector('.hp .ghost'), en: e.querySelector('.en'), enFill: e.querySelector('.en > div'), stam: e.querySelector('.stam > div'), g: 1, gDelay: 0, hp: 1 };
    });
    this.clock = q('.clock');
    this.combos = ['.combo.l', '.combo.r'].map((s) => ({ el: q(s), num: q(s + ' b'), n: 0, t: 9, pop: 9 }));
    this.ann = { el: q('.announce'), big: q('.announce .big'), small: q('.announce .small'), t: 9, dur: 1 };
    this.clash = { el: q('.clash'), a: q('.clash .a'), track: q('.clash .track') };
    this.moves = q('.moves');
    this.keys = q('.keys');
    this.mv = [];
    this.player = 0;
    this.minimal = false;
    this.lastClock = -1;
  }

  show(v) { this.el.classList.toggle('hidden', !v); }

  setup(world, player, wins, { minimal = false } = {}) {
    this.player = player;
    this.minimal = minimal;
    const order = [player, 1 - player];
    order.forEach((fi, si) => {
      const f = world.fighters[fi], s = this.sides[si];
      s.fi = fi;
      s.name.textContent = f.stats.name;
      s.el.style.setProperty('--c', TINT[f.char]);
      s.g = 1; s.gDelay = 0; s.hp = 1;
      s.pips.forEach((p, k) => p.classList.toggle('on', k < wins[fi]));
    });
    for (const c of this.combos) { c.n = 0; c.t = 9; c.el.style.opacity = 0; }
    const me = world.fighters[player];
    this.clash.track.style.setProperty('--a', TINT[me.char]);
    this.clash.track.style.setProperty('--b', TINT[world.fighters[1 - player].char]);
    const mv = CHARS[me.char].moves;
    this.moves.innerHTML = [['Q', mv.s1, 's1'], ['E', mv.s2, 's2'], ['R', mv.ult, 'ult']]
      .map(([k, n, id]) => `<div class="mv" data-id="${id}" style="--c:${TINT[me.char]}"><kbd>${k}</kbd><span>${n}</span><i class="cd"></i></div>`).join('');
    this.mv = [...this.moves.children].map((e) => ({ el: e, cd: e.querySelector('.cd') }));
    this.keys.innerHTML = [['WASD', 'Move'], ['J', 'Light'], ['K', 'Heavy'], ['L', 'Block'], ['Shift', 'Dash'], ['Space', 'Jump']]
      .map(([k, n]) => `<span><kbd>${k}</kbd></span><span>${n}</span>`).join('');
    this.moves.classList.toggle('hidden', minimal);
    this.keys.classList.toggle('hidden', minimal);
    this.ann.t = 9;
    this.ann.el.style.opacity = 0;
    this.lastClock = -1;
  }

  announce(text, small = '', dur = 1.3) {
    const a = this.ann;
    a.big.textContent = text;
    a.small.textContent = small;
    a.t = 0;
    a.dur = dur;
  }

  onEvent(e, world) {
    if (e.type === 'hit' && !e.blocked && e.combo >= 2) {
      // the counter sits on the side of whoever is landing the hits
      const si = e.f === this.player ? 0 : 1, c = this.combos[si];
      c.n = e.combo; c.t = 0; c.pop = 0;
      c.num.textContent = e.combo;
    }
  }

  update(world, dt) {
    for (const s of this.sides) {
      const f = world.fighters[s.fi];
      const hp = sat(f.hp / MAX_HP);
      if (hp < s.hp - 1e-4) s.gDelay = 0.45;
      s.hp = hp;
      if (s.gDelay > 0) s.gDelay -= dt; else s.g += (hp - s.g) * Math.min(1, dt * 5);
      if (s.g < hp) s.g = hp;
      s.fill.style.transform = `scaleX(${hp.toFixed(4)})`;
      s.ghost.style.transform = `scaleX(${s.g.toFixed(4)})`;
      const en = sat(f.energy / MAX_ENERGY);
      s.enFill.style.transform = `scaleX(${en.toFixed(4)})`;
      s.en.classList.toggle('full', en >= 1);
      s.stam.style.transform = `scaleX(${sat(f.stamina / MAX_STAMINA).toFixed(4)})`;
    }
    const sec = Math.max(0, Math.ceil(world.timeLeft));
    if (sec !== this.lastClock) { this.clock.textContent = sec; this.lastClock = sec; }
    for (const c of this.combos) {
      c.t += dt; c.pop += dt;
      const vis = c.n >= 2 ? 1 - sat((c.t - 1.1) / 0.35) : 0;
      c.el.style.opacity = vis.toFixed(3);
      if (vis > 0) c.el.style.transform = `scale(${(1 + 0.32 * (1 - ease.outCubic(c.pop / 0.16))).toFixed(3)})`;
      if (vis <= 0) c.n = 0;
    }
    const a = this.ann;
    if (a.t < a.dur) {
      a.t += dt;
      const i = ease.outQuint(a.t / 0.22), o = 1 - sat((a.t - (a.dur - 0.25)) / 0.25);
      a.el.style.opacity = (sat(a.t / 0.08) * o).toFixed(3);
      a.big.style.transform = `scale(${(1.35 - 0.35 * i + 0.04 * sat(a.t / a.dur)).toFixed(4)})`;
      a.big.style.letterSpacing = `${(0.32 - 0.3 * i).toFixed(3)}em`;
    } else if (a.el.style.opacity !== '0') a.el.style.opacity = '0';

    const C = world.clash;
    this.clash.el.classList.toggle('on', C.on && !this.minimal);
    if (C.on) this.clash.a.style.transform = `scaleX(${(this.player === 0 ? C.c : 1 - C.c).toFixed(4)})`;

    if (!this.minimal && this.mv.length) {
      const f = world.fighters[this.player], m = f.moves;
      const vals = [1 - sat(f.cdS1 / m.S1.cd), 1 - sat(f.cdS2 / m.S2.cd), sat(f.energy / MAX_ENERGY)];
      this.mv.forEach((v, i) => {
        v.cd.style.transform = `scaleX(${vals[i].toFixed(3)})`;
        v.el.classList.toggle('off', vals[i] < 1);
        v.el.classList.toggle('hot', i === 2 && vals[i] >= 1);
      });
    }
  }
}
