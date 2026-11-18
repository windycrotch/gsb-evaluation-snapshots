import { bayer, mix, withAlpha } from './pixel.js';
import { text } from './font.js';

// The pet is drawn as a glowing LCD sprite: soft filled body, bright features.

const STAR = ['..#..', '.###.', '#####', '.###.', '..#..'];
const HEART = ['.#.#.', '#####', '#####', '.###.', '..#..'];

function sprite(p, rows, x, y, color) {
  for (let j = 0; j < rows.length; j++) {
    for (let i = 0; i < rows[j].length; i++) {
      if (rows[j][i] === '#') p.px(x + i, y + j, color);
    }
  }
}

function arc(p, cx, cy, halfW, depth, color) {
  for (let i = -halfW; i <= halfW; i++) {
    const t = halfW ? i / halfW : 0;
    p.px(cx + i, Math.round(cy + depth * (1 - t * t)), color);
  }
}

function drawEye(p, cx, cy, expr, th, t, side) {
  const { eyes, blink, gaze } = expr;
  const gx = Math.round(gaze.x * 1.6);
  const gy = Math.round(gaze.y * 1.2);
  const white = th.hi;
  const dark = th.shadow;

  const lid = (top, h) => {
    // Eyelid closes from the top; at full blink we draw a lash line instead.
    const cover = Math.round(blink * (h + 1));
    if (cover <= 0) return;
    for (let j = 0; j < cover; j++) p.hline(cx - 3, top + j, 7, th.dim);
    if (blink > 0.72) p.hline(cx - 3, top + Math.max(0, cover - 1), 7, th.mid);
  };

  switch (eyes) {
    case 'happy': {
      arc(p, cx, cy + 2, 3, -3, white);
      arc(p, cx, cy + 3, 3, -3, mix(white, th.dim, 0.5));
      return;
    }
    case 'closed': {
      arc(p, cx, cy + 1, 3, 1, white);
      p.px(cx - 4, cy, mix(white, th.dim, 0.4));
      p.px(cx + 4, cy, mix(white, th.dim, 0.4));
      return;
    }
    case 'sleepy': {
      p.ellipse(cx, cy + 1, 3, 2, white);
      p.rect(cx - 4, cy - 3, 9, 3, th.dim);
      arc(p, cx, cy - 1, 3, 1, th.mid);
      p.px(cx + gx, cy + 1, dark);
      p.px(cx + gx, cy + 2, dark);
      return;
    }
    case 'star': {
      sprite(p, STAR, cx - 2, cy - 2, white);
      p.px(cx - 3, cy, mix(white, th.dim, 0.4));
      p.px(cx + 3, cy, mix(white, th.dim, 0.4));
      p.px(cx, cy - 3, mix(white, th.dim, 0.4));
      p.px(cx, cy + 3, mix(white, th.dim, 0.4));
      return;
    }
    case 'heart': {
      const pulse = Math.sin(t * 7 + (side > 0 ? 0.6 : 0)) > 0.2 ? 0 : 1;
      sprite(p, HEART, cx - 2, cy - 2 + pulse, white);
      return;
    }
    case 'spiral': {
      const turns = 2.1;
      const steps = 22;
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        const a = t * 6 * side + f * Math.PI * 2 * turns;
        const r = 0.4 + f * 3.4;
        p.px(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), white);
      }
      return;
    }
    case 'angry': {
      p.ellipse(cx, cy + 1, 3, 3, white);
      p.rect(cx + gx - 1, cy + gy, 2, 2, dark);
      for (let i = 0; i < 6; i++) {
        const dy = side > 0 ? Math.round(i * 0.5) : Math.round((5 - i) * 0.5);
        p.px(cx - 3 + i, cy - 4 + dy, th.fg);
      }
      return;
    }
    case 'shock': {
      p.ellipse(cx, cy, 4, 4, white);
      p.rect(cx + gx, cy + gy, 1, 1, dark);
      lid(cy - 4, 8);
      return;
    }
    case 'wide': {
      p.ellipse(cx, cy, 3, 4, white);
      p.rect(cx + gx - 1, cy + gy - 1, 2, 3, dark);
      lid(cy - 4, 8);
      return;
    }
    default: {
      p.ellipse(cx, cy, 3, 3, white);
      p.rect(cx + gx - 1, cy + gy - 1, 2, 2, dark);
      p.px(cx - 2, cy - 2, mix(white, '#ffffff', 0.7));
      lid(cy - 3, 6);
    }
  }
}

function drawMouth(p, cx, cy, expr, th, t) {
  const c = th.hi;
  const open = expr.openness;
  switch (expr.mouth) {
    case 'smallSmile':
      arc(p, cx, cy - 1, 2, 2, c);
      break;
    case 'grin': {
      arc(p, cx, cy - 1, 4, 3, c);
      p.hline(cx - 3, cy - 1, 7, c);
      p.hline(cx - 2, cy, 5, mix(c, th.dim, 0.55));
      break;
    }
    case 'smile':
      arc(p, cx, cy - 1, 3, 2, c);
      break;
    case 'o': {
      const r = 1 + Math.round(open * 1.4);
      p.ellipse(cx, cy, r, r, c);
      p.ellipse(cx, cy, Math.max(0, r - 1), Math.max(0, r - 1), th.shadow);
      break;
    }
    case 'bigO': {
      const rx = 2 + Math.round(open * 1.6);
      const ry = 2 + Math.round(open * 2.2);
      p.ellipse(cx, cy, rx, ry, c);
      p.ellipse(cx, cy, rx - 1, ry - 1, th.shadow);
      p.hline(cx - 1, cy + ry - 1, 3, mix(c, th.dim, 0.4));
      break;
    }
    case 'gasp': {
      p.ellipse(cx, cy + 1, 3, 2 + Math.round(open * 1.5), c);
      p.ellipse(cx, cy + 1, 2, 1 + Math.round(open * 1.5), th.shadow);
      break;
    }
    case 'wave': {
      for (let i = -4; i <= 4; i++) {
        p.px(cx + i, Math.round(cy + Math.sin(t * 6 + i * 0.9) * 1.4), c);
      }
      break;
    }
    case 'wobble': {
      for (let i = -3; i <= 3; i++) p.px(cx + i, cy + (i % 2 ? 1 : -1), c);
      break;
    }
    case 'cat': {
      p.px(cx - 3, cy - 1, c);
      p.px(cx - 2, cy, c);
      p.px(cx - 1, cy, c);
      p.px(cx, cy - 1, c);
      p.px(cx + 1, cy, c);
      p.px(cx + 2, cy, c);
      p.px(cx + 3, cy - 1, c);
      break;
    }
    case 'frown':
      arc(p, cx, cy + 1, 3, -2, c);
      break;
    case 'sleep': {
      const r = 1 + (Math.sin(t * 1.1) > 0 ? 1 : 0);
      p.ellipse(cx, cy, r + 1, r, c);
      p.ellipse(cx, cy, r, Math.max(0, r - 1), th.shadow);
      break;
    }
    case 'flat':
      p.hline(cx - 2, cy, 5, c);
      break;
    default:
      p.hline(cx - 1, cy, 3, c);
  }
}

/**
 * @param {{cx:number,cy:number,floorY:number}} area  where the pet lives
 */
export function drawFace(p, area, expr, th, t) {
  const cx = Math.round(area.cx + expr.lean);
  const cy = Math.round(area.cy + expr.bob);
  const sq = Math.max(-2, Math.min(2, expr.squash));
  const hw = 14 + Math.round(sq);
  const hh = 11 - Math.round(sq);

  // Ground shadow: shrinks as the pet hops, which sells the hover.
  const lift = Math.max(0, area.cy - cy);
  const srx = Math.max(4, 10 - Math.round(lift * 0.6));
  for (let j = -1; j <= 1; j++) {
    for (let i = -srx; i <= srx; i++) {
      const v = (i * i) / (srx * srx) + (j * j) / 1.6;
      if (v > 1) continue;
      if (bayer(cx + i, area.floorY + j) < 0.75 - v * 0.4) {
        p.px(cx + i, area.floorY + j, mix(th.bg, '#000000', 0.55));
      }
    }
  }

  // Antennae, wobbling with the audio level.
  const wob = 1 + expr.energy * 2.2;
  for (const side of [-1, 1]) {
    const bx = cx + side * 6;
    const by = cy - hh + 1;
    const sway = Math.sin(t * 3.1 + (side > 0 ? 1.7 : 0)) * wob;
    const tipX = Math.round(bx + side * 2 + sway);
    const tipY = by - 5 - Math.round(expr.energy * 2);
    p.line(bx, by, tipX, tipY, th.mid);
    p.px(tipX, tipY - 1, th.hi);
    if (expr.energy > 0.2) {
      p.add(tipX, tipY - 1, th.fg, expr.energy);
      p.add(tipX - 1, tipY - 1, th.fg, expr.energy * 0.5);
      p.add(tipX + 1, tipY - 1, th.fg, expr.energy * 0.5);
      p.add(tipX, tipY - 2, th.fg, expr.energy * 0.5);
    }
  }

  // Body: filled blob, bright outline, soft top highlight.
  const bw = hw * 2 + 1;
  const bh = hh * 2 + 1;
  p.rrect(cx - hw, cy - hh, bw, bh, 4, th.dim);
  p.rrect(cx - hw, cy - hh, bw, bh, 4, th.mid, 'stroke');
  for (let j = 1; j < hh; j++) {
    for (let i = -hw + 2; i < 1; i++) {
      if (bayer(cx + i, cy - hh + j) < 0.3 - j * 0.035) p.px(cx + i, cy - hh + j, th.mid);
    }
  }
  p.hline(cx - hw + 4, cy - hh + 1, bw - 8, mix(th.mid, th.hi, 0.35));
  // Bottom inner shade grounds the blob.
  p.hline(cx - hw + 3, cy + hh - 1, bw - 6, mix(th.dim, '#000000', 0.35));

  // Little side nubs that flap when the pet is excited.
  const flap = Math.round(Math.sin(t * 9) * (expr.intensity > 0.35 ? 1.5 : 0.4));
  for (const side of [-1, 1]) {
    const ax = cx + side * (hw + 1);
    const ay = cy + 1 + flap * side;
    p.rect(side < 0 ? ax - 1 : ax, ay, 2, 3, th.dim);
    p.px(side < 0 ? ax - 1 : ax + 1, ay, th.mid);
  }

  const eyeY = cy - 2;
  drawEye(p, cx - 7, eyeY, expr, th, t, -1);
  drawEye(p, cx + 7, eyeY, expr, th, t, 1);

  // Brows follow the mood; they do a lot of the emotional work.
  if (expr.brow !== 0 && expr.eyes !== 'angry' && expr.eyes !== 'spiral') {
    const browLift = Math.round(-expr.brow * 2);
    for (const side of [-1, 1]) {
      const bx = cx + side * 7;
      const tiltDir = expr.brow < 0 ? side : -side;
      for (let i = -2; i <= 2; i++) {
        const yy = eyeY - 6 + browLift + Math.round(i * tiltDir * 0.5);
        p.px(bx + i, yy, mix(th.mid, th.hi, Math.abs(expr.brow) * 0.7));
      }
    }
  }

  drawMouth(p, cx, cy + 5, expr, th, t);

  if (expr.blush > 0.12) {
    const a = Math.min(1, expr.blush);
    for (const side of [-1, 1]) {
      for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 4; i++) {
          const px = cx + side * 11 - 1 + i;
          const py = cy + 2 + j;
          if (bayer(px, py) < a * 0.6) p.px(px, py, mix(th.dim, th.fg, 0.6));
        }
      }
    }
  }

  if (expr.sweat > 0.15) {
    const phase = (t * 1.4) % 1;
    const sx = cx + hw - 1;
    const sy = cy - hh - 2 + Math.round(phase * 8);
    p.px(sx, sy, th.hi);
    p.px(sx, sy + 1, th.hi);
    p.px(sx - 1, sy + 1, th.mid);
    p.px(sx + 1, sy + 1, th.mid);
  }

  if (expr.zzz > 0.2) {
    const n = expr.zzz > 0.6 ? 3 : 1;
    for (let i = 0; i < n; i++) {
      const phase = ((t * 0.55 + i / n) % 1);
      const zx = cx + hw + Math.round(phase * 7);
      const zy = cy - hh - 1 - Math.round(phase * 11);
      const fade = phase > 0.7 ? 0.35 : 1;
      text(p, 'Z', zx, zy, withAlpha(th.hi, fade));
    }
  }
}
