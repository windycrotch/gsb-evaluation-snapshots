import type { Break, Timeline } from '../timeline';
import type { Ctx2D, Pt } from './types';

/**
 * Breaks in the `breaks` mode. The right hand leaves the frame, comes back holding a coffee mug
 * or a cigarette, raises it to the (off-screen) mouth, puts it away and returns to typing.
 * Like everything else, a pure function of t: the pose is computed from the break interval.
 */

export interface BreakPose {
  /** Whole-hand offset, scene points. */
  offset: Pt;
  /** What the hand holds right now. */
  prop: Break['kind'] | null;
  /** 0..1: how high the prop is raised (1 = at the mouth). */
  raise: number;
  /** The break itself — for smoke and steam that depend on time since its start. */
  brk: Break;
}

/** Hand fully out of the frame (down and to the right), prop included. */
const OUT: Pt = { x: 280, y: 420 };
/** Holding the prop in view (the hand itself is placed by ANCHOR). */
const HOLD: Pt = { x: 0, y: 0 };
/**
 * At the mouth. The camera is the person's eyes, hands come from the bottom of the frame,
 * so the mouth is just below the bottom edge: the prop moves down and towards the camera.
 */
const MOUTH: Pt = { x: -130, y: 230 };
/** Scale of the hand + prop at the mouth (closer to the camera = bigger). */
export const MOUTH_SCALE = 1.6;

const ease = (p: number) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: Pt, b: Pt, p: number): Pt => ({ x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p });
/** Progress of segment [a, b] at time u, eased. */
const seg = (u: number, a: number, b: number) => ease(clamp01((u - a) / (b - a)));

export function breakAt(tl: Timeline, t: number): Break | null {
  for (const b of tl.breaks ?? []) if (t >= b.t0 && t <= b.t1) return b;
  return null;
}

/**
 * Choreography in fractions of the break (so it survives the timeline being stretched or squeezed):
 * out → in with the prop → hold → raise → hold at the mouth → lower → hold → out → in empty-handed.
 */
export function breakPose(brk: Break, t: number): BreakPose {
  const u = (t - brk.t0) / (brk.t1 - brk.t0);
  const raised = Math.min(seg(u, 0.36, 0.46), 1 - seg(u, 0.56, 0.66));
  if (u < 0.1) return { offset: lerp({ x: 0, y: 0 }, OUT, seg(u, 0, 0.1)), prop: null, raise: 0, brk };
  if (u < 0.13) return { offset: OUT, prop: null, raise: 0, brk };
  if (u < 0.82) {
    const inView = lerp(OUT, HOLD, seg(u, 0.13, 0.25));
    const out = lerp(HOLD, OUT, seg(u, 0.74, 0.82));
    const base = u < 0.74 ? inView : out;
    return { offset: lerp(base, MOUTH, raised), prop: brk.kind, raise: raised, brk };
  }
  if (u < 0.86) return { offset: OUT, prop: null, raise: 0, brk };
  return { offset: lerp(OUT, { x: 0, y: 0 }, seg(u, 0.86, 1)), prop: null, raise: 0, brk };
}

/** Where the holding hand sits while in view (scene points, before the offset). */
const ANCHOR: Pt = { x: 322, y: 812 };
/** The hand points up-left, the forearm goes off the bottom-right corner. */
const HAND_ANGLE = -0.62;

/**
 * A finger (or the forearm): a quadratic curve base → bend → tip whose width tapers from w0 to w1.
 * `nail` — the nail shows at the tip (extended fingers seen from above); `joint` — where to draw
 * the knuckle crease (fraction along the finger), if anywhere.
 */
interface Limb {
  pts: [Pt, Pt, Pt];
  w0: number;
  w1: number;
  nail?: boolean;
  joint?: number;
}
type Layer = Limb | 'hand' | 'cig' | 'cup' | 'handle';

const P = (x: number, y: number): Pt => ({ x, y });
const finger = (w0: number, w1: number, a: Pt, b: Pt, c: Pt, extra: Partial<Limb> = {}): Limb => ({
  pts: [a, b, c],
  w0,
  w1,
  ...extra,
});

/*
 * A right hand seen from above (back of the hand), local coordinates: fingers point to −y, the wrist is at +y.
 * Knuckles sit on a slight arc at y ≈ −20: index x −30, middle −8, ring 13, pinky 32.
 * Layers are listed back to front.
 */
const FOREARM = finger(78, 86, P(16, 330), P(8, 160), P(2, 60));
const THUMB_SIDE = finger(27, 21, P(-34, 46), P(-62, 22), P(-66, -10), { nail: true, joint: 0.55 });

/**
 * Cigarette between index and middle fingers, held near the middle knuckles: seen from above it lies
 * over the middle finger and passes under the index finger. Ring and pinky are relaxed and curled.
 */
const SMOKE: Layer[] = [
  FOREARM,
  finger(19, 16, P(31, -8), P(40, -30), P(37, -44), { joint: 0.6 }),
  finger(21, 18, P(12, -14), P(19, -44), P(15, -60), { joint: 0.6 }),
  'hand',
  THUMB_SIDE,
  finger(23, 19, P(-8, -18), P(-6, -76), P(-1, -126), { nail: true, joint: 0.5 }),
  'cig',
  finger(22, 18, P(-30, -16), P(-38, -70), P(-42, -114), { nail: true, joint: 0.5 }),
];

/**
 * A cappuccino cup by its handle: the index finger hooks under the handle (its tip hides under the cup),
 * the middle finger supports it from below, ring and pinky are curled, the thumb pinches the handle from above.
 */
const COFFEE: Layer[] = [
  FOREARM,
  finger(19, 17, P(31, -8), P(34, -26), P(25, -33)),
  finger(21, 19, P(12, -14), P(14, -34), P(3, -42)),
  finger(23, 20, P(-8, -18), P(-10, -42), P(-22, -52)),
  finger(22, 18, P(-30, -16), P(-31, -58), P(-46, -80), { joint: 0.5 }),
  'hand',
  'cup',
  'handle',
  finger(27, 21, P(-34, 46), P(-66, 0), P(-38, -74), { nail: true, joint: 0.5 }),
];

const CUP = { c: P(-40, -176), r: 80 };
const HANDLE = { from: P(-32, -100), to: P(-27, -68), w: 19 };
/** Cigarette from the filter (peeking out past the index finger) to the lit end (out over the middle finger, away from the hand). */
const CIG = { from: P(-62, -74), to: P(84, -54), w: 10 };

const SKIN = { fill: '#efc3a0', edge: '#c98e6b', crease: 'rgba(170,110,80,0.45)', nail: '#f9e2d6', nailEdge: '#ddb19c' };

const quad = (l: Limb, s: number): Pt => {
  const [a, b, c] = l.pts;
  const m = 1 - s;
  return { x: m * m * a.x + 2 * m * s * b.x + s * s * c.x, y: m * m * a.y + 2 * m * s * b.y + s * s * c.y };
};
const tangent = (l: Limb, s: number): Pt => {
  const [a, b, c] = l.pts;
  const x = 2 * (1 - s) * (b.x - a.x) + 2 * s * (c.x - b.x);
  const y = 2 * (1 - s) * (b.y - a.y) + 2 * s * (c.y - b.y);
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
};

/** Outline of a tapered limb with rounded ends. */
function traceLimb(ctx: Ctx2D, l: Limb, grow = 0): void {
  const N = 14;
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    const p = quad(l, s);
    const tg = tangent(l, s);
    const hw = (l.w0 + (l.w1 - l.w0) * s) / 2 + grow;
    left.push({ x: p.x - tg.y * hw, y: p.y + tg.x * hw });
    right.push({ x: p.x + tg.y * hw, y: p.y - tg.x * hw });
  }
  const tip = quad(l, 1);
  const base = quad(l, 0);
  const tipDir = tangent(l, 1);
  const baseDir = tangent(l, 0);
  ctx.beginPath();
  ctx.moveTo(left[0]!.x, left[0]!.y);
  for (const p of left) ctx.lineTo(p.x, p.y);
  const a1 = Math.atan2(tipDir.x, -tipDir.y);
  ctx.arc(tip.x, tip.y, l.w1 / 2 + grow, a1, a1 + Math.PI, true);
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i]!.x, right[i]!.y);
  const a0 = Math.atan2(-baseDir.x, baseDir.y);
  ctx.arc(base.x, base.y, l.w0 / 2 + grow, a0, a0 + Math.PI, true);
  ctx.closePath();
}

function drawLimb(ctx: Ctx2D, l: Limb): void {
  traceLimb(ctx, l, 1.5);
  ctx.fillStyle = SKIN.edge;
  ctx.fill();
  traceLimb(ctx, l);
  ctx.fillStyle = SKIN.fill;
  ctx.fill();

  if (l.joint !== undefined) {
    // Knuckle crease: two short arcs across the finger
    const p = quad(l, l.joint);
    const tg = tangent(l, l.joint);
    const hw = (l.w0 + (l.w1 - l.w0) * l.joint) / 2;
    ctx.strokeStyle = SKIN.crease;
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'round';
    for (const k of [0, 3.5]) {
      ctx.beginPath();
      const c = { x: p.x + tg.x * k, y: p.y + tg.y * k };
      ctx.moveTo(c.x - tg.y * hw * 0.45, c.y + tg.x * hw * 0.45);
      ctx.quadraticCurveTo(c.x + tg.x * 2, c.y + tg.y * 2, c.x + tg.y * hw * 0.45, c.y - tg.x * hw * 0.45);
      ctx.stroke();
    }
  }

  if (l.nail) {
    const tip = quad(l, 1);
    const tg = tangent(l, 1);
    ctx.save();
    ctx.translate(tip.x - tg.x * l.w1 * 0.32, tip.y - tg.y * l.w1 * 0.32);
    ctx.rotate(Math.atan2(tg.y, tg.x));
    ctx.fillStyle = SKIN.nail;
    ctx.strokeStyle = SKIN.nailEdge;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.ellipse(0, 0, l.w1 * 0.4, l.w1 * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

/** Back of the hand: a rounded trapezoid from the wrist to the knuckles, with knuckle bumps. */
function traceHand(ctx: Ctx2D, grow = 0): void {
  const g = grow;
  ctx.beginPath();
  ctx.moveTo(-38 - g, 70 + g);
  ctx.bezierCurveTo(-52 - g, 30, -50 - g, -6, -40 - g, -20 - g);
  ctx.bezierCurveTo(-20, -34 - g, 20, -32 - g, 42 + g, -14 - g);
  ctx.bezierCurveTo(50 + g, 10, 46 + g, 40, 38 + g, 70 + g);
  ctx.closePath();
}

function drawHand(ctx: Ctx2D): void {
  traceHand(ctx, 1.5);
  ctx.fillStyle = SKIN.edge;
  ctx.fill();
  traceHand(ctx);
  ctx.fillStyle = SKIN.fill;
  ctx.fill();
  // Knuckles, very subtle
  ctx.strokeStyle = 'rgba(170,110,80,0.22)';
  ctx.lineWidth = 1.3;
  ctx.lineCap = 'round';
  for (const [x, y] of [[-30, -14], [-8, -20], [13, -18], [32, -10]] as const) {
    ctx.beginPath();
    ctx.arc(x, y + 7, 5, Math.PI * 1.2, Math.PI * 1.8);
    ctx.stroke();
  }
}

/** Local hand coordinates → scene coordinates (before the offset/scale applied by the caller). */
function toScene(p: Pt): Pt {
  const c = Math.cos(HAND_ANGLE);
  const s = Math.sin(HAND_ANGLE);
  return { x: ANCHOR.x + p.x * c - p.y * s, y: ANCHOR.y + p.x * s + p.y * c };
}

/** Scale origin for “bringing it to the mouth”. */
export const HOLD_ANCHOR = ANCHOR;

/**
 * The right hand holding the prop. Shadow first (one silhouette, so overlaps don't darken),
 * then the layers back to front with the prop sandwiched between the fingers.
 */
export function drawHoldingHand(ctx: Ctx2D, pose: BreakPose, t: number, pxPerPt: number): void {
  const smoke = pose.prop === 'smoke';
  const layers = smoke ? SMOKE : COFFEE;
  const lift = pose.raise;

  ctx.save();
  ctx.translate(ANCHOR.x, ANCHOR.y);
  ctx.rotate(HAND_ANGLE);

  // Shadow offsets are in device space (unaffected by the rotation), so it always falls down-right.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.28)';
  ctx.shadowBlur = (14 + 10 * lift) * pxPerPt;
  ctx.shadowOffsetX = (9 + 8 * lift) * pxPerPt;
  ctx.shadowOffsetY = (13 + 10 * lift) * pxPerPt;
  ctx.fillStyle = SKIN.edge;
  for (const l of layers) {
    if (l === 'hand') traceHand(ctx, 1.5);
    else if (l === 'cup') {
      ctx.beginPath();
      ctx.arc(CUP.c.x, CUP.c.y, CUP.r, 0, Math.PI * 2);
    } else if (typeof l === 'object') traceLimb(ctx, l, 1.5);
    else continue;
    ctx.fill();
  }
  ctx.restore();

  for (const l of layers) {
    if (l === 'hand') drawHand(ctx);
    else if (l === 'cig') drawCigarette(ctx, t, lift);
    else if (l === 'cup') drawCup(ctx, pxPerPt);
    else if (l === 'handle') drawHandle(ctx);
    else drawLimb(ctx, l);
  }
  ctx.restore();

  // Smoke rises in scene space, not along the rotated hand.
  if (smoke) {
    const ember = toScene(CIG.to);
    for (let i = 0; i < 2; i++) drawWisp(ctx, ember, 110, t * 1.3 + i * 2.1, 'rgba(150,152,158,0.6)', 3.5);
  }
}

const CUP_COLOR = { body: '#fbfaf7', shade: '#e4dfd6', edge: '#cfc8bc' };

/** Soft-edged shape: fill it with a blur halo of its own colour (shadow with zero offset). */
function soft(ctx: Ctx2D, color: string, blurPx: number, draw: () => void): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = blurPx;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  draw();
  ctx.fill();
  ctx.restore();
}

/**
 * Top-down cup (local hand coordinates). Drawn upright on screen, light from the top-left:
 * porcelain rim, the inner wall in shadow, then the drink surface.
 */
function drawCup(ctx: Ctx2D, pxPerPt: number): void {
  const { c, r } = CUP;
  const col = CUP_COLOR;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(-HAND_ANGLE);

  // Porcelain: outer rim with a soft highlight
  const body = ctx.createLinearGradient(-r, -r, r, r);
  body.addColorStop(0, '#ffffff');
  body.addColorStop(0.5, col.body);
  body.addColorStop(1, col.shade);
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = col.edge;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // Inner wall: darker on the lit side's opposite edge
  const R = r * 0.84;
  const wall = ctx.createLinearGradient(-R, -R, R, R);
  wall.addColorStop(0, col.shade);
  wall.addColorStop(1, '#ffffff');
  ctx.fillStyle = wall;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.9, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.clip();
  drawLatte(ctx, R, pxPerPt);
  // The wall casts a soft shadow onto the drink near the top-left edge
  const sh = ctx.createRadialGradient(R * 0.12, R * 0.12, R * 0.75, 0, 0, R * 1.02);
  sh.addColorStop(0, 'rgba(0,0,0,0)');
  sh.addColorStop(1, 'rgba(40,20,5,0.35)');
  ctx.fillStyle = sh;
  ctx.fillRect(-R, -R, R * 2, R * 2);
  ctx.restore();

  // Glint on the rim
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(0, 0, r - 3, Math.PI * 1.08, Math.PI * 1.38);
  ctx.stroke();
  ctx.restore();
}

/** Milky coffee with a pale foam ring at the edge and soft latte-art hearts (already clipped to R). */
function drawLatte(ctx: Ctx2D, R: number, pxPerPt: number): void {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
  g.addColorStop(0, '#d6b08a');
  g.addColorStop(0.8, '#c0905f');
  g.addColorStop(0.93, '#a8784c');
  g.addColorStop(1, '#e9d9c4');
  ctx.fillStyle = g;
  ctx.fillRect(-R, -R, R * 2, R * 2);

  const heart = (cy: number, s: number) => () => {
    ctx.beginPath();
    ctx.moveTo(0, cy + s * 0.95);
    ctx.bezierCurveTo(-s * 1.35, cy + s * 0.05, -s * 0.95, cy - s * 1.05, 0, cy - s * 0.4);
    ctx.bezierCurveTo(s * 0.95, cy - s * 1.05, s * 1.35, cy + s * 0.05, 0, cy + s * 0.95);
  };
  const foam = 'rgba(250,243,232,0.97)';
  soft(ctx, foam, 5 * pxPerPt, heart(R * 0.02, R * 0.52));
  soft(ctx, 'rgba(196,150,104,0.9)', 3 * pxPerPt, heart(R * 0.1, R * 0.34));
  soft(ctx, foam, 3 * pxPerPt, heart(R * 0.15, R * 0.22));
}

/** The handle, seen from above as a short rounded ear sticking out of the cup towards the hand. */
function drawHandle(ctx: Ctx2D): void {
  const { from, to, w } = HANDLE;
  const col = CUP_COLOR;
  ctx.lineCap = 'round';
  ctx.strokeStyle = col.edge;
  ctx.lineWidth = w + 3;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.strokeStyle = col.body;
  ctx.lineWidth = w;
  ctx.stroke();
}

/** Cigarette between the fingers (local hand coordinates): filter, paper, ash, ember. */
function drawCigarette(ctx: Ctx2D, t: number, lift: number): void {
  const { from, to, w } = CIG;
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  ctx.save();
  ctx.translate(from.x, from.y);
  ctx.rotate(Math.atan2(to.y - from.y, to.x - from.x));
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = '#d98b3a';
  ctx.beginPath();
  ctx.roundRect(0, -w / 2, 32, w, [2, 0, 0, 2]);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = 'rgba(120,60,10,0.35)';
  for (let x = 4; x < 30; x += 7) ctx.fillRect(x, -w / 2 + 2, 2, 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(32, -w / 2, len - 44, w);
  ctx.fillStyle = '#9a9a9a';
  ctx.fillRect(len - 12, -w / 2, 7, w);
  const glow = 0.6 + 0.4 * Math.max(lift, 0.5 + 0.5 * Math.sin(t * 5));
  ctx.fillStyle = `rgba(255,${Math.round(90 - 50 * glow)},20,${glow})`;
  ctx.beginPath();
  ctx.roundRect(len - 6, -w / 2, 6, w, 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0, -w / 2, len, w);
  ctx.restore();
}

/** A thin rising wisp: a wavy line that drifts and fades upwards. */
function drawWisp(ctx: Ctx2D, from: Pt, height: number, phase: number, color: string, width: number): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  const steps = 12;
  for (let i = 0; i < steps; i++) {
    const a = i / steps;
    const b = (i + 1) / steps;
    const x = (p: number) => from.x + Math.sin(phase * 2 + p * 7) * 9 * p + p * 10;
    ctx.globalAlpha = 1 - a;
    ctx.beginPath();
    ctx.moveTo(x(a), from.y - a * height);
    ctx.lineTo(x(b), from.y - b * height);
    ctx.stroke();
  }
  ctx.restore();
}

/** After a drag: a cloud of smoke is blown over the phone from the bottom of the frame and dissolves. */
export function drawExhale(ctx: Ctx2D, tl: Timeline, t: number, frameBottom: number): void {
  for (const b of tl.breaks ?? []) {
    if (b.kind !== 'smoke') continue;
    const start = b.t0 + (b.t1 - b.t0) * 0.6;
    const p = (t - start) / 2.2;
    if (p < 0 || p > 1) continue;
    const alpha = 0.95 * Math.sin(Math.PI * Math.min(1, p * 1.4)) * (1 - p);
    const puffs = [
      [150, 0, 60],
      [210, -30, 75],
      [270, 5, 62],
      [180, -90, 52],
      [245, -80, 58],
      [205, -150, 48],
    ] as const;
    ctx.save();
    for (const [x, y, r] of puffs) {
      const rr = r * (0.6 + 1.1 * p);
      const cy = frameBottom + 10 + y * (0.4 + p) - p * 260;
      const g = ctx.createRadialGradient(x, cy, 0, x, cy, rr);
      g.addColorStop(0, `rgba(176,178,184,${alpha})`);
      g.addColorStop(0.55, `rgba(188,190,196,${alpha * 0.75})`);
      g.addColorStop(1, 'rgba(200,202,208,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, cy, rr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
