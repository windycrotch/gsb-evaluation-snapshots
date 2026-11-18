import { SCREEN } from '../core/layout.js';
import { drawFace } from './face.js';
import { Particles } from './particles.js';
import { text, textCentered, textWidth } from './font.js';
import { bayer, mix, withAlpha } from './pixel.js';

const HEADER_H = 7;
const FOOT_Y = 47;
const HORIZON = 34;

export class Display {
  constructor() {
    this.parts = new Particles(90);
    this.flash = null;
    this.t = 0;
    this.floorPhase = 0;
  }

  /** Where the pet lives: a hovering blob above a horizon line. */
  get area() {
    return {
      x: SCREEN.x,
      y: SCREEN.y + HEADER_H + 1,
      w: SCREEN.w,
      h: FOOT_Y - HEADER_H - 1,
      cx: SCREEN.x + Math.round(SCREEN.w / 2),
      cy: SCREEN.y + 23,
      floorY: SCREEN.y + HORIZON + 5,
    };
  }

  onNote(ev, th) {
    const a = this.area;
    const x = a.x + 8 + Math.round(ev.pitchNorm * (a.w - 16));
    this.parts.ripple(x, a.y + a.h - 6, th.mid, { ttl: 0.55, size: 0.7 + ev.velocity * 0.5 });
    if (Math.random() < 0.5) {
      this.parts.spawn({
        kind: 'dot',
        x,
        y: a.y + a.h - 4,
        vx: (Math.random() - 0.5) * 10,
        vy: -20 - Math.random() * 20,
        gravity: 30,
        ttl: 0.5,
        color: th.hi,
      });
    }
  }

  emote(kind, th) {
    const a = this.area;
    // Beside the pet rather than on top of it, so the face stays readable.
    const side = Math.random() < 0.5 ? -1 : 1;
    const x = a.cx + side * (17 + Math.random() * 14);
    this.parts.glyph(kind, Math.round(x), a.cy - 4, kind === 'heart' ? th.hi : th.fg, {
      vx: side * (3 + Math.random() * 5),
    });
  }

  message(line, sub = null, ttl = 1.35) {
    this.flash = { line, sub, life: 0, ttl };
  }

  update(dt, energy = 0) {
    this.t += dt;
    this.floorPhase = (this.floorPhase + (0.12 + energy * 1.4) * dt) % 1;
    this.parts.update(dt);
    if (this.flash) {
      this.flash.life += dt;
      if (this.flash.life >= this.flash.ttl) this.flash = null;
    }
  }

  draw(p, s) {
    const th = s.theme;
    const t = this.t;
    const { x, y, w, h } = SCREEN;

    p.pushClip(x, y, w, h);
    p.rect(x, y, w, h, th.bg);

    // The picture inside the glass vibrates on every hit; the glass itself and
    // the HUD stay put.
    p.setOffset(s.shakeX, s.shakeY);
    this.drawBackdrop(p, s, th, t);
    this.parts.draw(p, t);
    drawFace(p, this.area, s.expr, th, t);
    p.setOffset(0, 0);

    this.drawHeader(p, s, th, t);
    this.drawScope(p, s, th);
    if (this.flash) this.drawFlash(p, th);
    if (!s.focused) this.drawSleepHint(p, s, th, t);
    this.drawGlass(p, th, s);

    p.popClip();

    if (s.expr.glitch > 0.05) {
      const g = s.expr.glitch;
      p.shiftRows(x, y, w, h, (j) => {
        const band = Math.sin(j * 0.7 + t * 40) + Math.sin(j * 0.13 + t * 11);
        return band > 1.2 - g ? Math.round((Math.random() - 0.5) * 9 * g) : 0;
      });
    }
  }

  drawBackdrop(p, s, th, t) {
    const { x, y, w } = SCREEN;
    const horizon = y + HORIZON;
    const bottom = y + FOOT_Y - 1;
    const energy = Math.min(1, s.expr.energy);

    // Sky, brightening towards the horizon.
    p.vgrad(x, y + HEADER_H, w, HORIZON - HEADER_H, th.bg, mix(th.bg, th.dim, 0.28), 5);
    p.vgrad(x, horizon, w, bottom - horizon + 1, mix(th.bg, '#000000', 0.35), th.bg, 4);

    // Stars, brighter the longer the pet has been left alone.
    const starGlow = 0.35 + s.expr.zzz * 0.65;
    for (let i = 0; i < 16; i++) {
      const sx = x + ((i * 41 + 7) % w);
      const sy = y + HEADER_H + 1 + ((i * 23 + 5) % (HORIZON - HEADER_H - 2));
      const twinkle = Math.sin(t * 1.7 + i * 2.1);
      if (twinkle > 0.75) p.px(sx, sy, withAlpha(th.mid, starGlow));
      else if (twinkle > 0.1) p.px(sx, sy, withAlpha(th.grid, starGlow));
    }

    // Perspective floor. It scrolls towards the viewer with the music.
    const vpx = x + w / 2;
    const depth = bottom - horizon;
    const lane = mix(th.grid, th.dim, 0.55);
    for (let k = -5; k <= 5; k++) {
      p.line(vpx, horizon + 1, vpx + k * 28, bottom + 1, lane);
    }
    const rows = 5;
    for (let i = 0; i < rows; i++) {
      const f = ((i + this.floorPhase) / rows) ** 2.3;
      const ry = Math.round(horizon + 1 + f * depth);
      if (ry <= horizon || ry > bottom) continue;
      const c = mix(th.grid, th.dim, 0.2 + f * 0.7);
      for (let ix = 0; ix < w; ix++) p.px(x + ix, ry, c);
    }

    // Horizon line: the sound lights it up from the middle outwards.
    for (let ix = 0; ix < w; ix++) {
      const falloff = 1 - Math.abs(ix - w / 2) / (w / 2);
      const wobble = Math.sin(ix * 0.13 + t * 2.6) * 0.35 + 0.65;
      p.px(x + ix, horizon, mix(th.dim, th.fg, energy * wobble * falloff));
    }
    if (energy > 0.05) {
      for (let j = 1; j <= 5; j++) {
        const a = energy * (1 - j / 6) * 0.4;
        for (let ix = 0; ix < w; ix++) {
          const falloff = 1 - Math.abs(ix - w / 2) / (w / 2);
          if (bayer(x + ix, horizon - j) < a * falloff) p.px(x + ix, horizon - j, th.dim);
        }
      }
    }
  }

  drawHeader(p, s, th, t) {
    const { x, y, w } = SCREEN;
    p.rect(x, y, w, HEADER_H, mix(th.bg, '#000000', 0.35));
    for (let i = 0; i < w; i += 2) p.px(x + i, y + HEADER_H, th.grid);

    const label = s.noteLabel ?? '--';
    const bright = s.since < 0.16;
    text(p, label, x + 2, y + 1, bright ? th.hi : th.mid);

    if (s.sustain) {
      const cx = x + w / 2;
      textCentered(p, 'SUS', cx, y + 1, Math.sin(t * 6) > -0.3 ? th.fg : th.dim);
    } else if (s.combo > 2) {
      textCentered(p, `X${s.combo}`, x + w / 2, y + 1, th.fg);
    }

    // Affection hearts.
    const hearts = Math.min(3, Math.ceil(s.affection * 3));
    for (let i = 0; i < 3; i++) {
      const hx = x + w - 3 - (3 - i) * 5;
      text(p, '@', hx, y + 1, i < hearts ? th.hi : th.grid);
    }
  }

  drawScope(p, s, th) {
    const { x, y, w } = SCREEN;
    const top = y + FOOT_Y;
    for (let i = 0; i < w; i += 2) p.px(x + i, top, th.grid);

    const center = top + 8;
    const scope = s.scope;
    const amp = 6;
    let prevY = center;
    for (let i = 0; i < w; i++) {
      const si = Math.floor((i / w) * scope.length);
      const v = (scope[si] - 128) / 128;
      const yy = Math.round(center - v * amp);
      const c = Math.abs(v) > 0.55 ? th.hi : th.mid;
      if (i > 0) {
        const a = Math.min(prevY, yy);
        const b = Math.max(prevY, yy);
        for (let j = a; j <= b; j++) p.px(x + i, j, c);
      } else {
        p.px(x + i, yy, c);
      }
      prevY = yy;
    }
    if (s.level < 0.005) {
      for (let i = 0; i < w; i += 3) p.px(x + i, center, th.dim);
    }
  }

  drawFlash(p, th) {
    const { x, y, w } = SCREEN;
    const f = this.flash;
    const k = f.life / f.ttl;
    const fade = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
    const slide = k < 0.12 ? Math.round((1 - k / 0.12) * 6) : 0;
    const lines = f.sub ? 2 : 1;
    const boxH = 5 + lines * 7;
    const boxW = Math.max(textWidth(f.line), f.sub ? textWidth(f.sub) : 0) + 10;
    const bx = Math.round(x + (w - boxW) / 2);
    const by = y + 12 - slide;

    p.rrect(bx, by, boxW, boxH, 2, withAlpha(mix(th.bg, '#000000', 0.25), 0.9 * fade));
    p.rrect(bx, by, boxW, boxH, 2, withAlpha(th.mid, fade), 'stroke');
    textCentered(p, f.line, x + w / 2, by + 3, withAlpha(th.hi, fade));
    if (f.sub) textCentered(p, f.sub, x + w / 2, by + 10, withAlpha(th.mid, fade));
  }

  drawSleepHint(p, s, th, t) {
    const { x, y, w, h } = SCREEN;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (bayer(x + i, y + j) < 0.45) p.px(x + i, y + j, withAlpha('#000814', 0.55));
      }
    }
    const blinkOn = Math.sin(t * 2.4) > -0.2;
    textCentered(p, 'CLICK TO WAKE', x + w / 2, y + h - 12, blinkOn ? th.mid : th.dim);
  }

  drawGlass(p, th, s) {
    const { x, y, w, h } = SCREEN;
    // Scanlines.
    for (let j = 0; j < h; j += 3) {
      for (let i = 0; i < w; i++) p.px(x + i, y + j, withAlpha('#000000', 0.13));
    }
    // Corner vignette.
    for (let j = 0; j < h; j++) {
      const dy = Math.abs(j - h / 2) / (h / 2);
      for (let i = 0; i < w; i++) {
        const dx = Math.abs(i - w / 2) / (w / 2);
        const d = Math.max(0, dx * dx * 0.8 + dy * dy - 0.7);
        if (d > 0 && bayer(x + i, y + j) < d * 0.75) p.px(x + i, y + j, withAlpha('#000208', 0.45));
      }
    }
    // A single soft highlight in the top-left corner reads as glass.
    for (let j = 0; j < 14; j++) {
      for (let i = 0; i < 22 - j; i++) {
        if (bayer(x + i, y + j) < 0.12) p.px(x + i, y + j, withAlpha('#ffffff', 0.09));
      }
    }
    if (s.expr.energy > 0.05) {
      const a = s.expr.energy * 0.16;
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          if (bayer(x + i, y + j) < a) p.add(x + i, y + j, th.fg, 0.25);
        }
      }
    }
  }
}
