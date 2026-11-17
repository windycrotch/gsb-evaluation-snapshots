import { BTN } from '../sim/constants.js';

// Keyboard + mouse + gamepad → an input frame { fwd, strafe, buttons }.
const KEYS = {
  KeyJ: BTN.LIGHT, KeyK: BTN.HEAVY, KeyU: BTN.S1, KeyQ: BTN.S1, KeyI: BTN.S2, KeyE: BTN.S2, KeyO: BTN.ULT, KeyR: BTN.ULT,
  KeyL: BTN.BLOCK, KeyF: BTN.BLOCK, ShiftLeft: BTN.DASH, ShiftRight: BTN.DASH, Space: BTN.JUMP,
};
const PAD = { 0: BTN.JUMP, 1: BTN.DASH, 2: BTN.LIGHT, 3: BTN.HEAVY, 4: BTN.S1, 5: BTN.BLOCK, 6: BTN.S2, 7: BTN.ULT };

export class Input {
  constructor(target = window) {
    this.down = new Set();
    // Presses are latched until the next read, so a tap that goes down and up between two frames
    // (fast fingers, a slow frame) still counts as one press.
    this.latch = 0;
    this.mouse = 0;
    this.frame = { fwd: 0, strafe: 0, buttons: 0 };
    this.enabled = true;
    this.mouseEnabled = false; // only while a fight is running, so menu clicks do not swing
    this.onKey = null;
    target.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.down.add(e.code);
      if (KEYS[e.code]) this.latch |= KEYS[e.code];
      this.onKey?.(e.code, e);
      if (this.enabled && (KEYS[e.code] || e.code.startsWith('Arrow') || e.code === 'Space')) e.preventDefault();
    });
    target.addEventListener('keyup', (e) => this.down.delete(e.code));
    target.addEventListener('blur', () => { this.down.clear(); this.mouse = 0; this.latch = 0; });
    target.addEventListener('mousedown', (e) => {
      if (!this.mouseEnabled) return;
      const b = e.button === 0 ? BTN.LIGHT : e.button === 2 ? BTN.HEAVY : 0;
      this.mouse |= b;
      this.latch |= b;
    });
    target.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse &= ~BTN.LIGHT;
      if (e.button === 2) this.mouse &= ~BTN.HEAVY;
    });
    target.addEventListener('contextmenu', (e) => { if (this.mouseEnabled) e.preventDefault(); });
  }
  read() {
    const d = this.down, f = this.frame;
    let fwd = 0, strafe = 0, b = (this.mouseEnabled ? this.mouse : 0) | this.latch;
    this.latch = 0;
    if (d.has('KeyW') || d.has('ArrowUp')) fwd += 1;
    if (d.has('KeyS') || d.has('ArrowDown')) fwd -= 1;
    if (d.has('KeyD') || d.has('ArrowRight')) strafe += 1;
    if (d.has('KeyA') || d.has('ArrowLeft')) strafe -= 1;
    for (const k in KEYS) if (d.has(k)) b |= KEYS[k];
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      const ax = p.axes[0] || 0, ay = p.axes[1] || 0;
      if (Math.hypot(ax, ay) > 0.25) { strafe += ax; fwd -= ay; }
      for (const i in PAD) if (p.buttons[i] && p.buttons[i].pressed) b |= PAD[i];
      break;
    }
    f.fwd = Math.max(-1, Math.min(1, fwd));
    f.strafe = Math.max(-1, Math.min(1, strafe));
    f.buttons = this.enabled ? b : 0;
    if (!this.enabled) { f.fwd = 0; f.strafe = 0; }
    return f;
  }
}
