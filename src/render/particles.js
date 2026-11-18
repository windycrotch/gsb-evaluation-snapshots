import { text, textCentered } from './font.js';
import { withAlpha } from './pixel.js';

// One tiny particle system, reused for the screen emotes and the key sparks.

const GLYPH = { note: '&', heart: '@', star: '$', bolt: '*', question: '?', bang: '!' };

export class Particles {
  constructor(limit = 120) {
    this.items = [];
    this.limit = limit;
  }

  spawn(item) {
    if (this.items.length >= this.limit) this.items.shift();
    this.items.push({
      kind: 'dot',
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      gravity: 0,
      life: 0,
      ttl: 1,
      size: 1,
      wobble: 0,
      color: '#ffffff',
      ...item,
    });
  }

  glyph(kind, x, y, color, opts = {}) {
    this.spawn({
      kind: 'glyph',
      char: GLYPH[kind] ?? kind,
      x,
      y,
      vy: -9 - Math.random() * 6,
      vx: (Math.random() - 0.5) * 6,
      wobble: 1 + Math.random(),
      ttl: 1.1 + Math.random() * 0.5,
      color,
      ...opts,
    });
  }

  label(str, x, y, color, opts = {}) {
    this.spawn({ kind: 'label', char: str, x, y, vy: -14, ttl: 0.7, color, ...opts });
  }

  ripple(x, y, color, opts = {}) {
    this.spawn({ kind: 'ripple', x, y, ttl: 0.5, size: 1, color, ...opts });
  }

  burst(x, y, color, count = 6, speed = 26) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.6;
      this.spawn({
        kind: 'dot',
        x,
        y,
        vx: Math.cos(a) * speed * (0.6 + Math.random() * 0.7),
        vy: Math.sin(a) * speed * (0.6 + Math.random() * 0.7),
        gravity: 40,
        ttl: 0.32 + Math.random() * 0.3,
        color,
      });
    }
  }

  update(dt) {
    const keep = [];
    for (const it of this.items) {
      it.life += dt;
      if (it.life >= it.ttl) continue;
      it.x += it.vx * dt;
      it.y += it.vy * dt;
      it.vy += it.gravity * dt;
      it.vx *= 1 - 1.4 * dt;
      keep.push(it);
    }
    this.items = keep;
  }

  draw(p, t) {
    for (const it of this.items) {
      const k = it.life / it.ttl;
      const fade = k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1;
      const alpha = Math.max(0, Math.min(1, fade));
      const color = withAlpha(it.color, alpha);
      switch (it.kind) {
        case 'glyph': {
          const wx = it.wobble ? Math.sin(t * 6 + it.x) * it.wobble : 0;
          text(p, it.char, Math.round(it.x + wx), Math.round(it.y), color);
          break;
        }
        case 'label':
          textCentered(p, it.char, Math.round(it.x), Math.round(it.y), color);
          break;
        case 'ripple': {
          const r = Math.round(1 + k * 13 * it.size);
          p.ring(Math.round(it.x), Math.round(it.y), r, withAlpha(it.color, alpha * 0.75));
          break;
        }
        default: {
          p.px(Math.round(it.x), Math.round(it.y), color);
          if (alpha > 0.7 && it.size > 1) {
            p.px(Math.round(it.x) + 1, Math.round(it.y), withAlpha(it.color, alpha * 0.5));
          }
        }
      }
    }
  }

  clear() {
    this.items.length = 0;
  }
}
