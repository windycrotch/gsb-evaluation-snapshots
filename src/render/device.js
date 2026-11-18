import {
  DEVICE,
  ICONS,
  INFO,
  KNOB_LABEL_Y,
  KNOB_SUB_Y,
  KNOB_VALUE_Y,
  LEDS,
  SCREEN_FRAME,
  TOPBAR,
  keyRect,
} from '../core/layout.js';
import { SHELL } from './theme.js';
import { text, textCentered, textWidth } from './font.js';
import { bayer, mix, withAlpha } from './pixel.js';

const DEG = Math.PI / 180;
const SWEEP = 260;

// The info bar divider sits left of centre: the scale side carries one word, the
// sound side carries the pack and the preset.
const infoMidX = (r) => r.x + Math.round(r.w * 0.46);

// ---------------------------------------------------------------------------
// Static layer: everything that only changes when the theme or window scale
// changes. Rendered once and blitted every frame.
// ---------------------------------------------------------------------------

export function drawShadow(p) {
  const { x, y, w, h } = DEVICE;
  // Stacked translucent rounded rects give a soft falloff without dithering
  // artefacts against whatever is behind the window.
  const layers = [
    [4, 0.1],
    [3, 0.11],
    [2, 0.13],
    [1, 0.15],
    [0, 0.2],
  ];
  for (const [grow, alpha] of layers) {
    p.rrect(x - grow + 1, y - grow + 2, w + grow * 2, h + grow * 2, 7 + grow, withAlpha('#04060c', alpha));
  }
}

export function drawShell(p, s) {
  const { x, y, w, h } = DEVICE;
  p.rrect(x, y, w, h, 7, SHELL.ink);
  for (let j = 1; j < h - 1; j++) {
    const c = mix(SHELL.base, SHELL.lo, Math.min(1, j / h));
    for (let i = 1; i < w - 1; i++) {
      if (Math.min(i, w - 1 - i) + Math.min(j, h - 1 - j) < 6) continue;
      p.px(x + i, y + j, c);
    }
  }
  for (let i = 7; i < w - 7; i++) {
    p.px(x + i, y + 1, SHELL.edgeHi);
    p.px(x + i, y + 2, mix(SHELL.edgeHi, SHELL.base, 0.55));
    p.px(x + i, y + h - 2, SHELL.deep);
  }
  for (let j = 7; j < h - 7; j++) {
    p.px(x + 1, y + j, mix(SHELL.edgeHi, SHELL.base, 0.4));
    p.px(x + w - 2, y + j, SHELL.deep);
  }

  // Top bar: groove, brand, speaker grill.
  for (let i = 4; i < w - 4; i++) {
    p.px(x + i, TOPBAR.y + TOPBAR.h + 1, SHELL.groove);
    p.px(x + i, TOPBAR.y + TOPBAR.h + 2, mix(SHELL.base, SHELL.edgeHi, 0.28));
  }
  text(p, 'DESKSYNTH', x + 7, TOPBAR.y + 5, SHELL.creamLo);
  for (let gy = 0; gy < 2; gy++) {
    for (let gx = 0; gx < 9; gx++) {
      p.px(x + 64 + gx * 3, TOPBAR.y + 4 + gy * 4, SHELL.groove);
      p.px(x + 64 + gx * 3, TOPBAR.y + 5 + gy * 4, mix(SHELL.base, SHELL.edgeHi, 0.22));
    }
  }

  // Recessed screen bezel.
  const f = SCREEN_FRAME;
  p.rrect(f.x - 1, f.y - 1, f.w + 2, f.h + 2, 3, SHELL.ink);
  p.rrect(f.x, f.y, f.w, f.h, 3, SHELL.bezel);
  p.hline(f.x + 2, f.y + 1, f.w - 4, mix(SHELL.bezel, '#000000', 0.6));
  p.vline(f.x + 1, f.y + 2, f.h - 4, mix(SHELL.bezel, '#000000', 0.5));
  p.hline(f.x + 2, f.y + f.h - 2, f.w - 4, SHELL.bezelHi);
  p.vline(f.x + f.w - 2, f.y + 2, f.h - 4, SHELL.bezelHi);

  // LED housing strip.
  const lh = { x: LEDS.x - 2, y: LEDS.y - 2, w: LEDS.w + 4, h: LEDS.h + 4 };
  p.rrect(lh.x, lh.y, lh.w, lh.h, 2, SHELL.groove);
  p.hline(lh.x + 2, lh.y, lh.w - 4, mix(SHELL.groove, '#000000', 0.5));
  p.hline(lh.x + 2, lh.y + lh.h - 1, lh.w - 4, mix(SHELL.base, SHELL.edgeHi, 0.35));

  // Info bar housing.
  const r = INFO;
  p.rrect(r.x, r.y, r.w, r.h, 2, SHELL.ink);
  p.rrect(r.x + 1, r.y + 1, r.w - 2, r.h - 2, 1, mix(SHELL.bezel, s.theme.bg, 0.45));
  p.vline(infoMidX(r), r.y + 2, r.h - 4, mix(SHELL.bezel, SHELL.bezelHi, 0.55));

  // Recessed panel behind the keyboard so the two halves of the device read
  // as separate zones.
  const kp = { x: x + 4, y: r.y + r.h + 2, w: w - 8, h: h - (r.y + r.h + 2 - y) - 11 };
  p.rrect(kp.x, kp.y, kp.w, kp.h, 4, mix(SHELL.lo, SHELL.deep, 0.55));
  p.hline(kp.x + 4, kp.y, kp.w - 8, mix(SHELL.deep, '#000000', 0.45));
  p.hline(kp.x + 4, kp.y + kp.h - 1, kp.w - 8, mix(SHELL.base, SHELL.edgeHi, 0.3));
  p.vline(kp.x, kp.y + 4, kp.h - 8, mix(SHELL.deep, '#000000', 0.3));
  p.vline(kp.x + kp.w - 1, kp.y + 4, kp.h - 8, mix(SHELL.base, SHELL.edgeHi, 0.2));

  // Knob labels and feet screws.
  for (const knob of s.knobs) textCentered(p, knob.label, knob.cx, KNOB_LABEL_Y, SHELL.creamLo);
  const footY = y + h - 8;
  for (const sx of [x + 6, x + w - 9]) {
    p.rect(sx, footY + 1, 3, 3, SHELL.groove);
    p.px(sx + 1, footY + 2, mix(SHELL.base, SHELL.edgeHi, 0.5));
  }
}

// ---------------------------------------------------------------------------
// Dynamic chrome
// ---------------------------------------------------------------------------

export function drawChrome(p, s) {
  drawPin(p, s);
  drawClose(p, s);

  const f = SCREEN_FRAME;
  const pulse = 0.55 + 0.45 * Math.sin(s.time * 2.2);
  p.px(f.x + 3, f.y + f.h - 4, mix(SHELL.bezel, s.theme.fg, 0.35 + pulse * 0.6));

  const r = INFO;
  const midX = infoMidX(r);
  text(p, '&', r.x + 3, r.y + 3, s.theme.dim);
  text(p, s.scale.name, r.x + 10, r.y + 3, s.theme.mid);

  // Right half: pack in context colour, current preset in the accent. The pack
  // is dropped rather than clipped when a long pair won't fit.
  const nameX = r.x + r.w - 4 - textWidth(s.preset.name);
  text(p, s.preset.name, nameX, r.y + 3, s.theme.fg);
  const packX = nameX - 3 - textWidth(s.pack.name);
  if (packX > midX + 4) text(p, s.pack.name, packX, r.y + 3, s.theme.dim);

  if (s.voices > 0) {
    for (let i = 0; i < 3; i++) {
      const on = Math.floor(s.time * 9 + i) % 3 === 0;
      p.px(midX - 7 + i * 2, r.y + r.h - 3, on ? s.theme.fg : s.theme.dim);
    }
  }

  const footY = DEVICE.y + DEVICE.h - 8;
  const fade = Math.max(0, 1 - s.usage / 24);
  if (s.hint && fade > 0.03) {
    textCentered(p, s.hint, DEVICE.x + DEVICE.w / 2, footY, withAlpha(SHELL.creamDeep, 0.3 + fade * 0.6));
  } else {
    for (let i = 0; i < 5; i++) p.px(DEVICE.x + DEVICE.w / 2 - 6 + i * 3, footY + 2, SHELL.groove);
  }
}

function drawPin(p, s) {
  const r = ICONS.pin;
  const c = s.pinned ? SHELL.amber : SHELL.creamDeep;
  if (s.hover === 'pin') p.rrect(r.x - 1, r.y - 1, r.w + 2, r.h + 2, 1, withAlpha('#ffffff', 0.12));
  // Push pin: round head, thin needle.
  p.rrect(r.x + 1, r.y + 1, 6, 4, 1, c);
  p.px(r.x + 3, r.y + 5, c);
  p.px(r.x + 3, r.y + 6, c);
  if (s.pinned) {
    p.rect(r.x + 2, r.y + 2, 4, 2, mix(SHELL.amber, '#ffffff', 0.35));
    p.add(r.x + 3, r.y + 3, SHELL.amber, 0.7);
  }
}

function drawClose(p, s) {
  const r = ICONS.close;
  const hovered = s.hover === 'close';
  const c = hovered ? SHELL.red : SHELL.creamDeep;
  if (hovered) p.rrect(r.x - 1, r.y - 1, r.w + 2, r.h + 2, 1, withAlpha(SHELL.red, 0.2));
  for (let i = 0; i < 5; i++) {
    p.px(r.x + 2 + i, r.y + 2 + i, c);
    p.px(r.x + 6 - i, r.y + 2 + i, c);
  }
}

export function drawScreenGlow(p, s) {
  const f = SCREEN_FRAME;
  const strength = 0.08 + Math.min(0.42, s.level * 1.6);
  for (let ring = 1; ring <= 4; ring++) {
    const a = strength * (1 - ring / 5) * 0.45;
    for (let i = -ring; i < f.w + ring; i++) {
      p.add(f.x + i, f.y - ring, s.theme.fg, a);
      p.add(f.x + i, f.y + f.h - 1 + ring, s.theme.fg, a);
    }
    for (let j = -ring; j < f.h + ring; j++) {
      p.add(f.x - ring, f.y + j, s.theme.fg, a);
      p.add(f.x + f.w - 1 + ring, f.y + j, s.theme.fg, a);
    }
  }
}

/** Additive light on a pixel ring, matching `Pixel.ring`'s shape exactly. */
function addRing(p, cx, cy, r, color, amount) {
  const outer = (r + 0.35) * (r + 0.35);
  const inner = (r - 1 + 0.35) * (r - 1 + 0.35);
  for (let j = -r; j <= r; j++) {
    for (let i = -r; i <= r; i++) {
      const d = i * i + j * j;
      if (d <= outer && d > inner) p.add(cx + i, cy + j, color, amount);
    }
  }
}

export function drawKnob(p, knob, st, s) {
  const { cx, cy, r } = knob;
  const angle = (-SWEEP / 2 + SWEEP * st.norm) * DEG;
  // The cap travels a single pixel into its housing. One pixel is all a 32 px
  // knob has, and it's enough to read as a real button.
  const press = st.press ?? 0;
  const sink = press > 0.45 ? 1 : 0;
  const capY = cy + sink;

  p.circle(cx + 1 - sink, cy + 2 - sink, r, withAlpha('#000000', 0.4 - sink * 0.14));
  p.circle(cx, cy, r, SHELL.ink);
  p.circle(cx, cy, r - 1, SHELL.deep);

  for (let i = 0; i < st.count; i++) {
    const a = (-SWEEP / 2 + (SWEEP * i) / (st.count - 1)) * DEG;
    const tx = Math.round(cx + Math.sin(a) * (r - 1));
    const ty = Math.round(cy - Math.cos(a) * (r - 1));
    const active = i === st.index;
    p.px(tx, ty, active ? s.theme.fg : mix(SHELL.deep, SHELL.edgeHi, 0.45));
    if (active) {
      p.add(tx, ty, s.theme.fg, 0.85);
      p.add(tx + 1, ty, s.theme.fg, 0.3);
      p.add(tx - 1, ty, s.theme.fg, 0.3);
    }
  }

  const cap = r - 4;
  const capHi = sink ? mix(SHELL.hi, SHELL.deep, 0.22) : SHELL.hi;
  const capLo = sink ? mix(SHELL.lo, SHELL.deep, 0.26) : SHELL.lo;
  for (let j = -cap; j <= cap; j++) {
    for (let i = -cap; i <= cap; i++) {
      if (i * i + j * j > (cap + 0.35) * (cap + 0.35)) continue;
      p.px(cx + i, capY + j, mix(capHi, capLo, ((j + cap) / (cap * 2)) * 0.95 + 0.05));
    }
  }
  p.ring(cx, capY, cap, mix(SHELL.deep, SHELL.hi, 0.35));
  if (sink) {
    // The housing shading the sunken cap from above.
    p.hline(cx - cap + 2, capY - cap - 1, cap * 2 - 3, withAlpha('#000000', 0.45));
  } else {
    p.px(cx - 2, capY - cap + 1, mix(SHELL.edgeHi, '#ffffff', 0.35));
    p.px(cx - 1, capY - cap + 1, SHELL.edgeHi);
  }

  for (let i = 0; i < 12; i++) {
    const a = angle + (i * Math.PI) / 6;
    const rx = Math.round(cx + Math.sin(a) * (cap - 1));
    const ry = Math.round(capY - Math.cos(a) * (cap - 1));
    p.px(rx, ry, i % 2 ? SHELL.deep : mix(SHELL.hi, SHELL.edgeHi, 0.4));
  }

  const tipX = Math.round(cx + Math.sin(angle) * (cap - 1));
  const tipY = Math.round(capY - Math.cos(angle) * (cap - 1));
  p.line(cx + Math.sin(angle) * 2, capY - Math.cos(angle) * 2, tipX, tipY, SHELL.cream);
  p.px(tipX, tipY, s.theme.fg);
  p.add(tipX, tipY, s.theme.fg, 0.9);

  if (st.glow > 0.01) {
    p.ring(cx, cy, r + 1, withAlpha(s.theme.fg, st.glow * 0.55));
    p.ring(cx, cy, r + 2, withAlpha(s.theme.fg, st.glow * 0.22));
  }
  // Click feedback: the rim lights up while the cap is down, and one thin ring
  // of light leaves the knob. Light only — painting the ring opaque reads as a
  // gold band stuck around the knob rather than as a flash.
  if (press > 0.05) addRing(p, cx, cy, r, s.theme.fg, press * 0.16);
  const pop = st.pop ?? 0;
  if (pop > 0.01) {
    const spread = Math.round((1 - pop) * 4);
    addRing(p, cx, cy, r + 1 + spread, s.theme.fg, pop * 0.34);
    addRing(p, cx, cy, r + 2 + spread, s.theme.fg, pop * 0.1);
  }
  if (s.hover === knob.id) p.ring(cx, cy, r + 1, withAlpha('#ffffff', 0.13));

  dots(p, cx, KNOB_VALUE_Y, st.count, st.index, s, 2);
  // A knob that carries two values gets a second, finer row: the pack above,
  // the sound inside it below.
  if (st.sub) dots(p, cx, KNOB_SUB_Y, st.sub.count, st.sub.index, s, 1);
}

function dots(p, cx, y, count, index, s, width) {
  const pitch = 3;
  const startX = Math.round(cx - (count * pitch - 1) / 2);
  for (let i = 0; i < count; i++) {
    const on = i === index;
    const dx = startX + i * pitch;
    p.px(dx, y, on ? s.theme.fg : SHELL.groove);
    if (width > 1) p.px(dx + 1, y, on ? s.theme.mid : SHELL.groove);
    if (on) p.add(dx, y, s.theme.fg, 0.7);
  }
}

export function drawLeds(p, s) {
  const { x, y, count } = LEDS;
  const pitch = 7;
  const lit = Math.round(Math.min(1, Math.pow(Math.max(0, s.level) * 2.6, 0.7)) * count);
  for (let i = 0; i < count; i++) {
    const lx = x + i * pitch;
    const hot = i >= count - 2;
    const on = i < lit;
    const off = hot ? mix(SHELL.red, SHELL.deep, 0.74) : mix(s.theme.fg, SHELL.deep, 0.8);
    const color = on ? (hot ? SHELL.red : s.theme.fg) : off;
    p.rrect(lx, y, 5, 5, 1, SHELL.ink);
    p.rect(lx + 1, y + 1, 3, 3, color);
    if (on) {
      p.add(lx + 2, y + 2, color, 0.9);
      p.add(lx + 2, y - 1, color, 0.22);
      p.add(lx + 2, y + 5, color, 0.22);
    }
  }
}

export function drawKeys(p, s) {
  for (const pad of s.pads) {
    const r = keyRect(pad.row, pad.col);
    const st = s.keyState[pad.index];
    const drop = st.down ? 2 : Math.round(st.glow * 1.2);
    const top = r.y + drop;
    const accent = s.theme.fg;
    const bodyH = r.h - drop;

    p.rrect(r.x, r.y + 2, r.w, r.h, 2, SHELL.groove);

    const faceTop = st.down ? mix(SHELL.creamMid, accent, 0.32) : SHELL.cream;
    const faceBot = st.down ? mix(SHELL.creamLo, accent, 0.28) : SHELL.creamMid;

    p.rrect(r.x, top, r.w, bodyH, 2, SHELL.ink);
    for (let j = 1; j < bodyH - 1; j++) {
      const c = mix(faceTop, faceBot, j / Math.max(1, bodyH - 2));
      for (let i = 1; i < r.w - 1; i++) {
        if (Math.min(i, r.w - 1 - i) + Math.min(j, bodyH - 1 - j) < 2) continue;
        p.px(r.x + i, top + j, c);
      }
    }
    if (!st.down) {
      p.hline(r.x + 2, top + bodyH - 1, r.w - 4, SHELL.creamDeep);
      p.hline(r.x + 3, top + bodyH, r.w - 6, mix(SHELL.creamDeep, SHELL.ink, 0.5));
    }
    p.hline(r.x + 3, top + 1, r.w - 6, mix(faceTop, '#ffffff', 0.4));

    if (st.glow > 0.01) {
      for (let j = 1; j < bodyH - 1; j++) {
        for (let i = 1; i < r.w - 1; i++) {
          if (Math.min(i, r.w - 1 - i) + Math.min(j, bodyH - 1 - j) < 2) continue;
          if (bayer(r.x + i, top + j) < st.glow * 0.6) p.add(r.x + i, top + j, accent, st.glow * 0.5);
        }
      }
      p.rrect(r.x - 1, top - 1, r.w + 2, bodyH + 2, 2, withAlpha(accent, st.glow * 0.5), 'stroke');
    }

    const labelColor = st.down
      ? mix(SHELL.ink, accent, 0.3)
      : mix(SHELL.creamDeep, SHELL.ink, 0.2 + st.glow * 0.45);
    textCentered(p, pad.glyph, r.x + r.w / 2, top + 4, labelColor);

    if (st.tonic) {
      const mx = r.x + Math.round(r.w / 2);
      const my = top + bodyH - 4;
      p.px(mx - 1, my, mix(SHELL.creamDeep, accent, 0.65));
      p.px(mx, my, accent);
      p.px(mx + 1, my, mix(SHELL.creamDeep, accent, 0.65));
    }
  }
}
