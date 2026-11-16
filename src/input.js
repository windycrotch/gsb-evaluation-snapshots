// Unified input: keyboard, mouse, gamepad (standard mapping) and on-screen touch controls.
// On blur / pause every source is reset together, so no direction, charge, menu repeat or double tap
// survives a break, and physically held keys/buttons must be released before they count again.
import { G, clamp } from './core.js';

// Physical bindings per action. Codes are KeyboardEvent.code, 'Mouse0/2', 'Pad<n>' or 'Touch<name>'.
const BIND = {
  left:    ['KeyA', 'ArrowLeft', 'Pad14'],
  right:   ['KeyD', 'ArrowRight', 'Pad15'],
  up:      ['KeyW', 'ArrowUp', 'Pad12'],
  down:    ['KeyS', 'ArrowDown', 'Pad13'],
  fire:    ['KeyJ', 'Space', 'KeyZ', 'Mouse0', 'Pad0', 'TouchFire'],
  bomb:    ['KeyK', 'KeyB', 'KeyX', 'Mouse2', 'Pad1', 'Pad3', 'TouchBomb'],
  boost:   ['KeyL', 'ShiftLeft', 'ShiftRight', 'KeyC', 'Pad7', 'TouchBoost'],
  brake:   ['KeyI', 'KeyV', 'Pad6', 'Pad2', 'TouchBrake'],
  rollL:   ['KeyQ', 'KeyU', 'Pad4', 'TouchRollL'],
  rollR:   ['KeyE', 'KeyO', 'Pad5', 'TouchRollR'],
  pause:   ['Escape', 'KeyP', 'Pad9'],
  confirm: ['Enter', 'NumpadEnter', 'Space', 'KeyJ', 'KeyZ', 'Pad0'],
  back:    ['Escape', 'Backspace', 'KeyX', 'KeyK', 'Pad1'],
  mUp:     ['ArrowUp', 'KeyW', 'Pad12', 'PadSU'],
  mDown:   ['ArrowDown', 'KeyS', 'Pad13', 'PadSD'],
  mLeft:   ['ArrowLeft', 'KeyA', 'Pad14', 'PadSL'],
  mRight:  ['ArrowRight', 'KeyD', 'Pad15', 'PadSR'],
};

const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Backspace',
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyJ', 'KeyK', 'KeyL', 'KeyI', 'KeyQ', 'KeyE', 'KeyU', 'KeyO', 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyP', 'ShiftLeft', 'ShiftRight']);

// Timings are exported so dev tools and the regression test use the same numbers as the game.
export const INPUT_TUNING = {
  doubleTap: 0.3,      // two presses of the same action closer than this make a double tap
  menuDelay: 0.38,     // hold a menu direction this long before the first auto-repeat…
  menuRate: 0.09,      // …then repeat at this fixed interval
  padDeadzone: 0.18,
};

const held = new Set();
const justDown = new Set();
const justUp = new Set();
const actionHeld = {};
const actionPressed = {};
const actionReleased = {};
const actionDouble = {};
const lastPressTime = {};
const menuRepeat = {};
const menuNextRepeat = {};
let anyPress = false;
let stickX = 0, stickY = 0;       // gamepad analog
let touchX = 0, touchY = 0;       // touch stick
let touchStale = false;           // touch stick must return to neutral after a reset
let padPrev = [];
let padSeeded = false;            // padPrev already reflects the hardware
const padStale = new Set();       // pad buttons held through a reset; ignored until released
let axisStale = false;            // ignore the analog stick until it recentres after a reset
let now = 0;
const resetHooks = [];

export const Input = {
  x: 0, y: 0,
  device: 'keyboard',
  touchEnabled: false,
  held: a => !!actionHeld[a],
  pressed: a => !!actionPressed[a],
  released: a => !!actionReleased[a],
  double: a => !!actionDouble[a],
  any: () => anyPress,
  menu: a => !!menuRepeat[a],
  setTouchStick(x, y) {
    if (touchStale) {
      if (Math.abs(x) > 0.02 || Math.abs(y) > 0.02) { touchX = touchY = 0; return; }
      touchStale = false;
    }
    touchX = x; touchY = y;
  },
  touchButton(code, down) {
    if (down) {
      if (held.has(code)) return;              // repeated pointerdown without a pointerup
      justDown.add(code); held.add(code); anyPress = true; this.device = 'touch';
    } else {
      if (held.has(code)) justUp.add(code);
      held.delete(code);
    }
  },
  // Drop every source of input and forget transient judgements (double taps, menu repeat).
  // Held key/button state is cleared even if the matching release never arrives (blur, swiped
  // pointer, tab switch); the gamepad is re-armed from its real buttons instead of synthetic presses.
  reset() {
    held.clear(); justDown.clear(); justUp.clear();
    for (const a in actionHeld) {
      actionHeld[a] = false; actionPressed[a] = false; actionReleased[a] = false; actionDouble[a] = false;
    }
    for (const a in lastPressTime) delete lastPressTime[a];
    for (const a in menuRepeat) delete menuRepeat[a];
    for (const a in menuNextRepeat) delete menuNextRepeat[a];
    // Pad buttons/stick physically held right now stay inert until they are released (or, for the
    // stick, recentred), so an alt-tab with a thumb on the pad cannot resume into a drift or shot.
    for (let i = 0; i < padPrev.length; i++) if (padPrev[i]) padStale.add(i);
    axisStale = true;
    touchStale = true;
    anyPress = false;
    touchX = touchY = 0;
    stickX = stickY = 0;
    this.x = 0; this.y = 0;
    for (const fn of resetHooks) { try { fn(); } catch (e) { /* UI cleanup is best effort */ } }
  },
  clearAll() { this.reset(); },     // old name, kept for callers outside this module
  onReset(fn) { resetHooks.push(fn); },
};

function isTypingTarget(t) {
  return t && (t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
}

export function initInput(canvasEl) {
  window.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    if (PREVENT.has(e.code) && G.state !== 'loading') e.preventDefault();
    Input.device = 'keyboard';
    if (e.repeat || held.has(e.code)) return;      // OS key repeat is not a new press
    held.add(e.code); justDown.add(e.code); anyPress = true;
  }, { passive: false });
  window.addEventListener('keyup', e => {
    if (held.has(e.code)) justUp.add(e.code);
    held.delete(e.code);
  });
  // Losing the window (alt-tab, minimise, clicking another app) is an input boundary for every
  // device, not just the keyboard. The game also pauses from the same event (see main.js).
  window.addEventListener('blur', () => Input.reset());
  document.addEventListener('visibilitychange', () => { if (document.hidden) Input.reset(); });
  const target = canvasEl || window;
  target.addEventListener('mousedown', e => {
    const code = e.button === 2 ? 'Mouse2' : e.button === 0 ? 'Mouse0' : null;
    if (!code || held.has(code)) return;
    held.add(code); justDown.add(code); anyPress = true; Input.device = 'keyboard';
  });
  window.addEventListener('mouseup', e => {
    const code = e.button === 2 ? 'Mouse2' : e.button === 0 ? 'Mouse0' : null;
    if (!code) return;
    if (held.has(code)) justUp.add(code);
    held.delete(code);
  });
  target.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('gamepadconnected', () => { Input.device = 'gamepad'; });
}

function pollGamepad() {
  stickX = 0; stickY = 0;
  const testPad = __DEV__ && window.__testPad;
  const pads = testPad ? [testPad] : (navigator.getGamepads ? navigator.getGamepads() : []);
  let pad = null;
  for (const p of pads) { if (p && p.connected) { pad = p; break; } }
  if (!pad) {
    padPrev.length = 0; padStale.clear(); padSeeded = false;
    // Leave axisStale alone: a pad that reconnects while its stick is deflected must recentre
    // before it can steer.
    return;
  }
  if (!padSeeded) {
    // First sight of this pad: take its buttons as already-known state, so a button that happens
    // to be held on connect (or when the window regains focus) is not mistaken for a fresh press.
    for (let i = 0; i < pad.buttons.length; i++) { const b = pad.buttons[i]; padPrev[i] = b.pressed || b.value > 0.5; }
    padSeeded = true;
  }
  const dz = INPUT_TUNING.padDeadzone;
  const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
  const mag = Math.hypot(ax, ay);
  if (axisStale) {
    // The stick was deflected when input was suspended: wait for it to come back to the centre
    // before it can steer again, otherwise a resumed game would keep drifting.
    if (mag <= dz) axisStale = false;
  } else if (mag > dz) {
    const k = Math.min(1, (mag - dz) / (1 - dz)) / mag;
    stickX = ax * k; stickY = -ay * k;
    Input.device = 'gamepad';
  }
  for (let i = 0; i < pad.buttons.length; i++) {
    const b = pad.buttons[i];
    const pressed = b.pressed || b.value > 0.5;
    const code = 'Pad' + i;
    if (padStale.has(i)) {
      // Was down before the reset: track the physical state but stay inert until released.
      padPrev[i] = pressed;
      if (!pressed) padStale.delete(i);
      continue;
    }
    if (pressed && !padPrev[i]) { held.add(code); justDown.add(code); anyPress = true; Input.device = 'gamepad'; }
    else if (!pressed && padPrev[i]) { held.delete(code); justUp.add(code); }
    padPrev[i] = pressed;
  }
  // Virtual stick "buttons" for menu navigation
  const dirs = [['PadSU', -ay > 0.6], ['PadSD', ay > 0.6], ['PadSL', ax < -0.6], ['PadSR', ax > 0.6]];
  for (const [code, on] of dirs) {
    const usable = on && !axisStale;
    if (usable && !held.has(code)) { held.add(code); justDown.add(code); }
    else if (!usable && held.has(code)) { held.delete(code); justUp.add(code); }
  }
}

// Call once at the start of every frame.
export function updateInput(realDt) {
  now += realDt;
  pollGamepad();
  for (const a in BIND) {
    const codes = BIND[a];
    let h = false, p = false, r = false;
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (held.has(c)) h = true;
      if (justDown.has(c)) p = true;
      if (justUp.has(c)) r = true;
    }
    actionHeld[a] = h;
    actionPressed[a] = p;
    actionReleased[a] = r && !h;
    actionDouble[a] = false;
    if (p) {
      const last = lastPressTime[a];
      if (last !== undefined && now - last < INPUT_TUNING.doubleTap) {
        actionDouble[a] = true;
        delete lastPressTime[a];      // a double consumes both taps: a rapid third press starts over
      } else lastPressTime[a] = now;
    }
    // Menu auto-repeat: the first press acts at once, holding repeats at a fixed rate, release stops.
    if (a[0] === 'm') {
      menuRepeat[a] = false;
      if (p) { menuRepeat[a] = true; menuNextRepeat[a] = now + INPUT_TUNING.menuDelay; }
      else if (h && menuNextRepeat[a] !== undefined && now >= menuNextRepeat[a]) {
        menuRepeat[a] = true;
        // Advance on the schedule (not from `now`) so the rate does not drift with frame length;
        // a long frame gets one move rather than a burst to catch up.
        menuNextRepeat[a] += INPUT_TUNING.menuRate;
        if (menuNextRepeat[a] <= now) menuNextRepeat[a] = now + INPUT_TUNING.menuRate;
      }
      if (!h) delete menuNextRepeat[a];
    }
  }
  // Movement axes
  let x = (actionHeld.right ? 1 : 0) - (actionHeld.left ? 1 : 0);
  let y = (actionHeld.up ? 1 : 0) - (actionHeld.down ? 1 : 0);
  if (Math.abs(stickX) > Math.abs(x)) x = stickX;
  if (Math.abs(stickY) > Math.abs(y)) y = stickY;
  if (Math.abs(touchX) > 0.02 || Math.abs(touchY) > 0.02) { x = touchX; y = touchY; }
  if (G.settings && G.settings.invertY) y = -y;
  Input.x = clamp(x, -1, 1);
  Input.y = clamp(y, -1, 1);
}

// Call once at the end of every frame.
export function endInputFrame() {
  justDown.clear();
  justUp.clear();
  anyPress = false;
}

// Dev-build introspection (used by __inputState / __inputTest).
export function inputDebug() {
  const actions = {};
  for (const a in BIND) actions[a] = {
    held: !!actionHeld[a], pressed: !!actionPressed[a], released: !!actionReleased[a], double: !!actionDouble[a],
  };
  return {
    held: [...held].sort(), axisStale, x: Input.x, y: Input.y,
    stick: { x: stickX, y: stickY }, touch: { x: touchX, y: touchY },
    actions, menu: { ...menuRepeat }, lastPress: { ...lastPressTime }, time: now,
  };
}
