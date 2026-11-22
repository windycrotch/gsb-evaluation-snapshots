// Skill bar: forged slots with generated icon art, a REAL radial cooldown wedge
// (SVG clock-wipe, not an opacity fade), mana-cost tinting, insufficient-mana /
// locked states, and keybind labels.
//
// THE BAR MIRRORS COMBAT; IT DOES NOT DECIDE ANYTHING.
//
// Earlier versions kept their own cooldown timers and subtracted mana on every
// EV.PLAYER_CAST they observed. Both were wrong once combat became authoritative:
//   - the local timers ran on frame dt, which hitstop scales, so a sweep could crawl
//     through a freeze while the real cooldown had already elapsed (or the reverse);
//   - and a cast combat REJECTED (a sliver of global cooldown left, mana short) still
//     emitted EV.PLAYER_CAST on its wind-up, so the bar flashed and could spend mana
//     for an action that never happened — "the bar lit up, I pressed, and nothing".
// The bar now reads `World.combat` (real-second deadlines on the same clock the freeze
// budget uses) and the player's authoritative mana. It flashes only when combat reports
// a COMMITTED cast ('combat:castCommitted'), i.e. after cost and cooldown were written.
// Nothing is ever spent here. Until combat exists (boot, or a stubbed build) the
// input-press path drives local feedback only, exactly as before.
import { Input } from '../core/input.js';
import { World } from '../core/world.js';
import { bus } from '../core/events.js';
import { PAL, el, svg, drawIcon } from './theme.js';
import { SKILLS } from './skills.js';

const DPR = Math.min(window.devicePixelRatio || 1, 2);
const R = 75; // wedge radius in a 0..100 viewBox (over-covers the square corners)

// Emitted by combat.js the moment a cast is accepted (cost + cooldowns written).
const EV_CAST_COMMITTED = 'combat:castCommitted';

function wedgePath(frac) {
  if (frac <= 0) return '';
  if (frac >= 0.9999) frac = 0.9999;
  const e = 1 - frac;
  const a0 = (-90 + e * 360) * Math.PI / 180;
  const a1 = (-90 + 360) * Math.PI / 180;
  const x0 = 50 + R * Math.cos(a0), y0 = 50 + R * Math.sin(a0);
  const x1 = 50 + R * Math.cos(a1), y1 = 50 + R * Math.sin(a1);
  const large = frac > 0.5 ? 1 : 0;
  return `M50 50 L${x0.toFixed(2)} ${y0.toFixed(2)} A${R} ${R} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
}

// HUD slot name -> the combat skill id it represents (they differ: the bar calls slot
// 'q' "Firestorm" while combat's id is 'fireball'). Bridged by key, which both tables
// share. `lmb` maps to Cleave.
const KEY_TO_ID = {
  lmb: 'cleave', q: 'fireball', f: 'stormLance', e: 'groundSlam', r: 'voidBeam',
  '1': 'frostNova', '2': 'causticField', '3': 'blink', '4': 'hexSeeker',
};

export class SkillBar {
  constructor(root, vitals) {
    this.vitals = vitals;
    this.castWired = false;
    this.bar = el('div', 'forged', root);
    this.bar.id = 'skillbar';
    this.slots = SKILLS.map((def) => this._buildSlot(def));
    this._byId = new Map();
    for (const s of this.slots) if (s.id) this._byId.set(s.id, s);
    // Combat tells us the definitive moment a cast is paid for and scheduled.
    this._offCommitted = bus.on(EV_CAST_COMMITTED, (p) => {
      this.castWired = true;
      const s = p && this._byId.get(p.id);
      if (s) this._flashAccepted(s);
    });
  }

  _buildSlot(def) {
    const box = el('div', 'skill', this.bar);
    const size = 48;
    const cv = el('canvas', null, box);
    cv.width = cv.height = Math.round(size * DPR);
    drawIcon(cv.getContext('2d'), def.icon, def.color, cv.width);

    const g = svg('svg', { class: 'cd-svg', viewBox: '0 0 100 100', preserveAspectRatio: 'none' }, box);
    g.style.overflow = 'visible';
    const wedge = svg('path', { d: '', fill: 'rgba(0,0,0,.66)' }, g);
    const hand = svg('line', { x1: 50, y1: 50, x2: 50, y2: -25, stroke: PAL.goldLite, 'stroke-width': 1.4, opacity: 0 }, g);

    const flash = el('div', 'flash', box);
    const cdText = el('div', 'cd-text', box);
    if (def.mana > 0) { const m = el('div', 'mana-cost', box); m.textContent = def.mana; }
    const key = el('div', 'key', box); key.textContent = def.label;

    // `localCd` is used ONLY before combat is wired (boot / stubbed build).
    return { def, box, wedge, hand, flash, cdText, localCd: 0, flashT: 0, cooling: false, noMana: false, _secs: null, id: KEY_TO_ID[def.key] };
  }

  // local input attempt — feedback only, used when combat is not present at all
  _tryCast(s) {
    if (s.localCd > 0.02) return;
    if (this.vitals.mana < s.def.mana) {
      s.flashT = 0.18;
      s.flash.style.background = 'radial-gradient(circle,rgba(255,90,78,.6),transparent 70%)';
      return;
    }
    s.localCd = s.def.cd; s.flashT = 0.16;
    s.flash.style.background = `radial-gradient(circle,${s.def.color},transparent 70%)`;
  }

  _flashAccepted(s) {
    s.flashT = 0.16;
    s.flash.style.background = `radial-gradient(circle,${s.def.color},transparent 70%)`;
  }

  frame(dt) {
    const v = this.vitals;
    const combat = World.combat || null;
    if (combat) this.castWired = true;

    for (const s of this.slots) {
      let cpu = 0, frac = 0;

      if (combat && typeof combat.cooldown === 'function' && s.id) {
        // AUTHORITATIVE: real-second deadline; advances through a freeze and clamps at 0.
        const cd = combat.cooldown(s.id);
        frac = cd.frac; cpu = cd.remain;
      } else {
        // Fallback: local sweep on frame dt (combat absent).
        if (!this.castWired) {
          const pressed = s.def.slot === 'lmb' ? Input.lmbEdge : Input.pressed(s.def.key);
          if (pressed) this._tryCast(s);
        }
        if (s.localCd > 0) { s.localCd -= dt; if (s.localCd < 0) s.localCd = 0; }
        cpu = s.localCd; frac = s.def.cd > 0 ? cpu / s.def.cd : 0;
      }

      if (cpu > 0.001 && frac > 0) {
        if (!s.cooling) { s.cooling = true; s.box.classList.add('cooling'); s.hand.style.opacity = '0.8'; }
        s.wedge.setAttribute('d', wedgePath(frac));
        const secs = cpu >= 1 ? String(Math.ceil(cpu)) : cpu.toFixed(1);
        if (secs !== s._secs) { s.cdText.textContent = secs; s._secs = secs; }
        const ang = (-90 + (1 - frac) * 360) * Math.PI / 180;
        s.hand.setAttribute('x2', (50 + R * Math.cos(ang)).toFixed(1));
        s.hand.setAttribute('y2', (50 + R * Math.sin(ang)).toFixed(1));
      } else if (s.cooling) {
        s.cooling = false;
        s.box.classList.remove('cooling');
        s.wedge.setAttribute('d', ''); s.hand.style.opacity = '0'; s._secs = null;
      }

      const noMana = v.mana < s.def.mana;
      if (noMana !== s.noMana) { s.noMana = noMana; s.box.classList.toggle('no-mana', noMana); }

      if (s.flashT > 0) {
        s.flashT -= dt;
        s.flash.style.opacity = Math.max(0, s.flashT / 0.16).toFixed(3);
      } else if (s.flash.style.opacity !== '0' && s.flash.style.opacity !== '') {
        s.flash.style.opacity = '0';
      }
    }
  }
}
