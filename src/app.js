import { Engine } from './audio/engine.js';
import { PACKS } from './audio/presets.js';
import { SCALES, degreeIndex, degreeToMidi, noteLabel } from './audio/scales.js';
import { PADS, padForCode } from './core/keymap.js';
import { ART, DEVICE, ICONS, INFO, KNOBS, SCREEN, keyRect } from './core/layout.js';
import { Pet } from './core/pet.js';
import { Display } from './render/display.js';
import {
  drawChrome,
  drawKeys,
  drawKnob,
  drawLeds,
  drawScreenGlow,
  drawShadow,
  drawShell,
} from './render/device.js';
import { Particles } from './render/particles.js';
import { Pixel } from './render/pixel.js';
import { themeFor } from './render/theme.js';

const HINTS = [
  'KEYS PLAY - ARROWS TURN KNOBS',
  'CLICK SOUND KNOB FOR MORE',
  'SPACE HOLDS - ESC PANICS',
  'CLICK THE PET TO SAY HI',
  'RIGHT CLICK FOR OPTIONS',
];

const KNOB_DRAG_STEP = 9;

class App {
  constructor() {
    this.canvas = document.getElementById('panel');
    this.hit = document.getElementById('hit');
    this.p = new Pixel(this.canvas, ART.w, ART.h);
    this.engine = new Engine();
    this.pet = new Pet();
    this.display = new Display();
    this.sparks = new Particles(140);

    this.scaleIndex = 0;
    this.packIndex = 0;
    this.presetIndex = 0;
    this.time = 0;
    this.usage = 0;
    this.shake = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.focused = true;
    this.pinned = true;
    this.hover = null;
    this.sustain = false;
    this.lastPressAt = -1;
    this.lastNoteAt = -99;
    this.noteLabel = null;
    this.shellDirty = true;
    this.shellCache = null;
    this.pixelScale = 3;

    this.keyState = PADS.map(() => ({ down: false, glow: 0, tonic: false, midi: 0 }));
    this.knobState = [
      { index: 0, norm: 0, count: SCALES.length, glow: 0, press: 0, pop: 0, held: false },
      {
        index: 0,
        norm: 0,
        count: PACKS.length,
        glow: 0,
        press: 0,
        pop: 0,
        held: false,
        sub: { index: 0, count: PACKS[0].presets.length },
      },
    ];

    this.held = new Set();
    this.mouseHeld = new Set();
    this.pointerDown = false;
    this.knobDrag = null;
    this.lastPetAt = -99;

    this.state = {
      time: 0,
      theme: themeFor(PACKS[0].presets[0].accent),
      scale: SCALES[0],
      pack: PACKS[0],
      preset: PACKS[0].presets[0],
      knobs: KNOBS,
      pads: PADS,
      keyState: this.keyState,
      scope: this.engine.scope,
      level: 0,
      voices: 0,
      expr: this.pet.expression(),
      noteLabel: null,
      since: 99,
      combo: 0,
      affection: 0.25,
      sustain: false,
      focused: true,
      pinned: true,
      hover: null,
      usage: 0,
      hint: HINTS[0],
      shakeX: 0,
      shakeY: 0,
    };

    this.engine.init();
    this.refreshTonics();
    this.buildZones();
    this.bindInput();
    this.bindShell();

    this.display.message('HELLO', 'DESKSYNTH', 2);
    this.pet.shock = 1;
    this.pet.emote('note');

    this.last = performance.now();
    requestAnimationFrame(this.frame);

    const demo = new URLSearchParams(location.search).get('demo');
    if (demo) this.runDemo(demo);
  }

  /** Dev helper driven by `DESKSYNTH_DEMO`, used together with DESKSYNTH_SHOT. */
  runDemo(spec) {
    const [kind, arg] = spec.split(':');
    switch (kind) {
      case 'mood':
        this.pet.pickMood = () => arg;
        this.display.flash = null;
        break;
      case 'play':
        [12, 14, 16].forEach((d, i) => {
          setTimeout(() => this.pressPad(PADS.find((p) => p.degree === d), 0.9), i * 120);
        });
        break;
      case 'chord':
        [10, 14, 17].forEach((d) => this.pressPad(PADS.find((p) => p.degree === d), 0.9));
        break;
      case 'fast': {
        let i = 0;
        const id = setInterval(() => {
          const pad = PADS[(i * 5 + 3) % PADS.length];
          this.pressPad(pad, 0.8);
          setTimeout(() => this.releasePad(pad), 60);
          if (++i > 60) clearInterval(id);
        }, 70);
        break;
      }
      case 'scale':
        this.turnKnob(0, Number(arg || 3));
        break;
      case 'sound':
      case 'pack':
        this.turnKnob(1, Number(arg || 4));
        break;
      case 'preset':
        for (let i = 0; i < Number(arg || 1); i++) this.pressKnob(1);
        break;
      case 'press':
        // Holds the sound knob down, for looking at the pressed-in artwork.
        this.knobState[1].held = true;
        setTimeout(() => this.pressKnob(1), 1100);
        break;
      case 'audit':
        this.display.flash = null;
        import('./audio/audit.js').then((m) => m.auditPresets());
        break;
      case 'pet':
        this.petTouch();
        break;
      case 'hero':
        this.display.flash = null;
        this.pet.affection = 0.8;
        [10, 14, 17, 21].forEach((d, i) => {
          setTimeout(() => this.pressPad(PADS.find((q) => q.degree === d), 0.9), i * 45);
        });
        break;
      default:
        break;
    }
  }

  get scale() {
    return SCALES[this.scaleIndex];
  }

  get pack() {
    return PACKS[this.packIndex];
  }

  get preset() {
    return this.pack.presets[this.presetIndex];
  }

  // ---- hit zones ----------------------------------------------------------

  buildZones() {
    this.hit.textContent = '';
    this.zones = [];

    const add = (cls, rect, data) => {
      const el = document.createElement('div');
      el.className = cls;
      Object.assign(el.dataset, data ?? {});
      this.hit.appendChild(el);
      this.zones.push({ el, rect });
      return el;
    };

    add('zone-screen', SCREEN, { role: 'screen' });
    for (const knob of KNOBS) {
      add(
        'zone-knob',
        { x: knob.cx - knob.r - 1, y: knob.cy - knob.r - 1, w: knob.r * 2 + 3, h: knob.r * 2 + 3 },
        { role: 'knob', id: knob.id },
      );
    }
    for (const pad of PADS) {
      add('zone-key', keyRect(pad.row, pad.col), { role: 'key', index: String(pad.index) });
    }
    add('zone-icon', { x: ICONS.pin.x - 2, y: ICONS.pin.y - 2, w: ICONS.pin.w + 4, h: ICONS.pin.h + 4 }, { role: 'pin' });
    add('zone-icon', { x: ICONS.close.x - 2, y: ICONS.close.y - 2, w: ICONS.close.w + 4, h: ICONS.close.h + 4 }, { role: 'close' });

    this.layoutZones();
  }

  layoutZones() {
    const scale = this.canvas.clientWidth / ART.w || this.pixelScale;
    this.pixelScale = scale;
    for (const z of this.zones) {
      z.el.style.left = `${z.rect.x * scale}px`;
      z.el.style.top = `${z.rect.y * scale}px`;
      z.el.style.width = `${z.rect.w * scale}px`;
      z.el.style.height = `${z.rect.h * scale}px`;
    }
  }

  // ---- input --------------------------------------------------------------

  bindInput() {
    this.hit.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.hit.addEventListener('pointerover', (e) => this.onPointerOver(e));
    this.hit.addEventListener('pointerout', () => {
      this.hover = null;
    });
    this.hit.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', () => this.onPointerUp());
    window.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      window.shell?.menu();
    });
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => this.releaseAll());
    window.addEventListener('resize', () => {
      this.layoutZones();
      this.shellDirty = true;
    });
  }

  bindShell() {
    const api = window.shell;
    if (!api) return;
    api.getPin().then((v) => {
      this.pinned = v;
    });
    api.onFocusChange((focused) => {
      this.focused = focused;
      if (!focused) this.releaseAll();
    });
    api.onScaleChange(() => {
      requestAnimationFrame(() => {
        this.layoutZones();
        this.shellDirty = true;
      });
    });
  }

  onPointerOver(e) {
    const role = e.target.dataset?.role;
    this.hover = role === 'knob' ? e.target.dataset.id : role ?? null;
  }

  onPointerDown(e) {
    this.engine.resume();
    const role = e.target.dataset?.role;
    this.pointerDown = true;
    if (role === 'key') {
      const pad = PADS[Number(e.target.dataset.index)];
      this.pressPad(pad, null, true);
      return;
    }
    if (role === 'knob') {
      const which = e.target.dataset.id === 'scale' ? 0 : 1;
      this.knobDrag = { which, startY: e.clientY, accum: 0, moved: false };
      this.knobState[which].held = true;
      return;
    }
    if (role === 'screen') {
      this.petTouch();
      return;
    }
    if (role === 'pin') {
      window.shell?.togglePin().then((v) => {
        this.pinned = v;
        this.engine.tick(1.4);
      });
      return;
    }
    if (role === 'close') window.shell?.quit();
  }

  onPointerMove(e) {
    if (this.knobDrag) {
      const dy = this.knobDrag.startY - e.clientY;
      const steps = Math.trunc(dy / KNOB_DRAG_STEP);
      if (steps !== this.knobDrag.accum) {
        const delta = steps - this.knobDrag.accum;
        this.knobDrag.accum = steps;
        this.knobDrag.moved = true;
        this.turnKnob(this.knobDrag.which, delta);
      }
      return;
    }
    if (!this.pointerDown) return;
    const role = e.target?.dataset?.role;
    if (role === 'key') {
      const pad = PADS[Number(e.target.dataset.index)];
      if (!this.keyState[pad.index].down) {
        this.releaseMouseKeys();
        this.pressPad(pad, null, true);
      }
    } else if (role === 'screen' && this.time - this.lastPetAt > 0.28) {
      this.petTouch();
    }
  }

  onPointerUp() {
    this.pointerDown = false;
    if (this.knobDrag) {
      const { which, moved } = this.knobDrag;
      this.knobState[which].held = false;
      if (!moved) this.pressKnob(which);
      this.knobDrag = null;
    }
    this.releaseMouseKeys();
  }

  onWheel(e) {
    const role = e.target.dataset?.role;
    if (role !== 'knob') return;
    e.preventDefault();
    const which = e.target.dataset.id === 'scale' ? 0 : 1;
    this.turnKnob(which, e.deltaY > 0 ? -1 : 1);
  }

  onKeyDown(e) {
    if (e.metaKey || e.ctrlKey) {
      if (e.code === 'KeyQ') window.shell?.quit();
      else if (e.code === 'KeyW' || e.code === 'KeyH') window.shell?.hide();
      else if (e.code === 'Equal' || e.code === 'Minus') window.shell?.cycleScale();
      return;
    }
    this.engine.resume();

    switch (e.code) {
      case 'ArrowLeft':
        e.preventDefault();
        this.turnKnob(0, -1);
        return;
      case 'ArrowRight':
        e.preventDefault();
        this.turnKnob(0, 1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        this.turnKnob(1, 1);
        return;
      case 'ArrowDown':
        e.preventDefault();
        this.turnKnob(1, -1);
        return;
      case 'Space':
        e.preventDefault();
        if (!this.sustain) this.setSustain(true);
        return;
      case 'Escape':
        e.preventDefault();
        this.panic();
        return;
      case 'Tab':
        e.preventDefault();
        this.pressKnob(1, e.shiftKey ? -1 : 1);
        return;
      default:
        break;
    }

    const pad = padForCode(e.code);
    if (!pad || e.repeat) return;
    e.preventDefault();
    this.pressPad(pad, null, false);
  }

  onKeyUp(e) {
    if (e.code === 'Space') {
      this.setSustain(false);
      return;
    }
    const pad = padForCode(e.code);
    if (pad) this.releasePad(pad);
  }

  // ---- musical actions ----------------------------------------------------

  velocityFor() {
    const gap = this.time - this.lastPressAt;
    let vel = 0.74 + Math.random() * 0.1;
    if (gap > 0.7) vel += 0.12;
    else if (gap < 0.06) vel -= 0.07;
    vel /= 1 + this.engine.voiceCount * 0.045;
    return Math.max(0.25, Math.min(1, vel));
  }

  pressPad(pad, velocity = null, fromMouse = false) {
    const st = this.keyState[pad.index];
    if (st.down) return;
    const vel = velocity ?? this.velocityFor();
    const midi = degreeToMidi(this.scale, pad.degree);
    const pitchNorm = pad.degree / (PADS.length - 1);

    this.engine.noteOn(`k${pad.index}`, midi, vel);
    st.down = true;
    st.glow = 1;
    st.midi = midi;
    this.held.add(pad.index);
    if (fromMouse) this.mouseHeld.add(pad.index);

    this.lastPressAt = this.time;
    this.lastNoteAt = this.time;
    this.noteLabel = noteLabel(midi);
    this.usage++;

    this.pet.onNote({
      midi,
      degree: pad.degree,
      velocity: vel,
      isTonic: st.tonic,
      pitchNorm,
    });
    this.display.onNote({ pitchNorm, velocity: vel }, this.state.theme);

    const r = keyRect(pad.row, pad.col);
    const cx = r.x + r.w / 2;
    this.sparks.burst(cx, r.y + 2, this.state.theme.fg, 5, 20 + vel * 22);
    this.sparks.label(noteLabel(midi), cx, r.y - 5, this.state.theme.fg, { ttl: 0.6, vy: -18 });
    this.shake = Math.min(3.2, this.shake + vel * 1.6);
  }

  releasePad(pad) {
    const st = this.keyState[pad.index];
    if (!st.down) return;
    st.down = false;
    this.held.delete(pad.index);
    this.mouseHeld.delete(pad.index);
    this.engine.noteOff(`k${pad.index}`);
  }

  releaseMouseKeys() {
    for (const index of [...this.mouseHeld]) this.releasePad(PADS[index]);
  }

  releaseAll() {
    for (const index of [...this.held]) this.releasePad(PADS[index]);
    this.setSustain(false);
  }

  setSustain(on) {
    if (this.sustain === on) return;
    this.sustain = on;
    this.engine.setSustain(on);
    this.engine.tick(on ? 1.6 : 1.1);
  }

  panic() {
    this.releaseAll();
    this.engine.panic();
    for (const st of this.keyState) {
      st.down = false;
      st.glow = 0;
    }
    this.held.clear();
    this.mouseHeld.clear();
    this.display.message('SHHH', null, 0.8);
    this.sparks.clear();
  }

  turnKnob(which, delta) {
    if (!delta) return;
    const knob = this.knobState[which];
    const count = knob.count;
    const next = ((knob.index + delta) % count + count) % count;
    if (next === knob.index) return;
    knob.index = next;
    knob.glow = 1;
    this.engine.tick(which === 0 ? 1 : 1.25);
    if (which === 0) this.setScale(next);
    else this.setPack(next);
  }

  /** Pushing a knob in: the scale knob steps, the sound knob picks a preset. */
  pressKnob(which, delta = 1) {
    const knob = this.knobState[which];
    // No detent glow here — the pop ring is this gesture's light, and stacking
    // both blows the knob out to a solid bright band.
    knob.pop = 1;
    knob.press = 1;
    if (which === 0) {
      this.turnKnob(0, delta);
      return;
    }
    // Lower-pitched than a detent tick, because a button should feel heavier
    // than a notch.
    this.engine.tick(0.72);
    const count = this.pack.presets.length;
    this.setPreset(((this.presetIndex + delta) % count + count) % count);
  }

  setScale(index) {
    this.scaleIndex = index;
    this.refreshTonics();
    // Retune anything still sounding so a knob turn never leaves a wrong note.
    for (const padIndex of [...this.held]) this.releasePad(PADS[padIndex]);
    this.display.message(this.scale.name, 'SCALE', 1.4);
    this.pet.onScaleChange(this.scale);
    this.audition();
  }

  setPack(index) {
    this.packIndex = index;
    // Hold the slot when swapping packs, so the same position in two packs can
    // be compared back to back.
    this.presetIndex = Math.min(this.presetIndex, this.pack.presets.length - 1);
    this.applyPreset();
    this.display.message(this.pack.name, this.preset.name, 1.6);
  }

  setPreset(index) {
    this.presetIndex = index;
    this.applyPreset();
    this.display.message(this.preset.name, this.pack.name, 1.4);
  }

  applyPreset() {
    this.engine.setPreset(this.preset);
    this.state.theme = themeFor(this.preset.accent);
    this.shellDirty = true;
    this.pet.onPresetChange(this.preset);
    this.auditionNote();
  }

  /** Little arpeggio that shows off the new scale and ripples across the keys. */
  audition() {
    const degrees = [10, 12, 14];
    degrees.forEach((degree, i) => {
      setTimeout(() => {
        const midi = degreeToMidi(this.scale, degree);
        const id = `aud${i}`;
        this.engine.noteOn(id, midi, 0.4);
        setTimeout(() => this.engine.noteOff(id), 320);
        const pad = PADS.find((q) => q.degree === degree);
        if (pad) this.keyState[pad.index].glow = 0.85;
        this.pet.gazeTarget.x = (degree / (PADS.length - 1) - 0.5) * 2;
      }, i * 95);
    });
  }

  auditionNote() {
    const midi = degreeToMidi(this.scale, 12);
    this.engine.noteOn('preview', midi, 0.45);
    setTimeout(() => this.engine.noteOff('preview'), 420);
  }

  petTouch() {
    this.lastPetAt = this.time;
    this.pet.onPet();
    this.display.emote('heart', this.state.theme);
    this.engine.tick(1.8);
  }

  refreshTonics() {
    for (const pad of PADS) {
      this.keyState[pad.index].tonic = degreeIndex(this.scale, pad.degree) === 0;
    }
  }

  // ---- frame --------------------------------------------------------------

  frame = (now) => {
    const dt = Math.min(0.05, Math.max(0.001, (now - this.last) / 1000));
    this.last = now;
    this.time += dt;

    const { level } = this.engine.sample();
    const voices = this.engine.voiceCount;

    for (const st of this.keyState) {
      if (st.down) st.glow = Math.min(1, st.glow + dt * 6);
      else st.glow = Math.max(0, st.glow - dt * 2.6);
    }
    this.knobState[0].index = this.scaleIndex;
    this.knobState[1].index = this.packIndex;
    this.knobState[1].sub.index = this.presetIndex;
    this.knobState[1].sub.count = this.pack.presets.length;
    for (const k of this.knobState) {
      k.glow = Math.max(0, k.glow - dt * 2.2);
      k.pop = Math.max(0, k.pop - dt * 2.6);
      // Snaps in, eases back out, so a keyboard press is still visible.
      k.press += ((k.held ? 1 : 0) - k.press) * (1 - Math.exp(-(k.held ? 34 : 12) * dt));
      const target = k.count > 1 ? k.index / (k.count - 1) : 0.5;
      k.norm += (target - k.norm) * (1 - Math.exp(-16 * dt));
    }

    this.shake *= Math.exp(-9 * dt);
    if (this.shake < 0.05) this.shake = 0;
    this.shakeX = Math.round(Math.sin(this.time * 74) * this.shake * 0.55);
    this.shakeY = Math.round(Math.cos(this.time * 61) * this.shake);

    this.pet.update(dt, { level, voices, focused: this.focused });
    const emotes = this.pet.takeEmotes();
    if (emotes) for (const em of emotes) this.display.emote(em.kind, this.state.theme);
    this.display.update(dt, this.pet.energy);
    this.sparks.update(dt);

    const s = this.state;
    s.time = this.time;
    s.scale = this.scale;
    s.pack = this.pack;
    s.preset = this.preset;
    s.level = level;
    s.voices = voices;
    s.scope = this.engine.scope;
    s.expr = this.pet.expression();
    s.noteLabel = this.noteLabel;
    s.since = this.time - this.lastNoteAt;
    s.combo = this.pet.combo;
    s.affection = this.pet.affection;
    s.sustain = this.sustain;
    s.focused = this.focused;
    s.pinned = this.pinned;
    s.hover = this.hover;
    s.usage = this.usage;
    s.hint = HINTS[Math.floor(this.time / 6) % HINTS.length];
    s.shakeX = this.shakeX;
    s.shakeY = this.shakeY;

    const p = this.p;
    if (this.shellDirty || !this.shellCache) {
      p.clear();
      drawShadow(p);
      drawShell(p, s);
      this.shellCache = p.snapshot();
      this.shellDirty = false;
    } else {
      p.blit(this.shellCache);
    }

    drawScreenGlow(p, s);
    drawChrome(p, s);
    this.display.draw(p, s);
    drawKnob(p, KNOBS[0], this.knobState[0], s);
    drawKnob(p, KNOBS[1], this.knobState[1], s);
    drawLeds(p, s);
    drawKeys(p, s);
    // Keep key sparks inside the keyboard panel so flying note names never
    // collide with the info bar.
    p.pushClip(DEVICE.x, INFO.y + INFO.h + 1, DEVICE.w, DEVICE.h);
    this.sparks.draw(p, this.time);
    p.popClip();
    p.commit();

    requestAnimationFrame(this.frame);
  };
}

window.addEventListener('DOMContentLoaded', () => new App());
