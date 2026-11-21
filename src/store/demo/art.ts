/**
 * The pictures of the demo character "Kit", drawn on canvases from the outlines in kit.ts (PARTS): every part has the same shape as the
 * mesh made from it. Two skins: a red fox and an arctic fox. The canvas works in world coordinates (the y axis is flipped once), so the
 * picture of a part is exactly its picture box.
 */
import { DEMO_IMAGES, PARTS, partBox, tailJoints } from './kit';
import type { ArtKind, SkinName } from './kit';
import type { Pt } from './geometry';

interface Palette {
  body: string;
  bodyShade: string;
  belly: string;
  dark: string;
  darkShade: string;
  inner: string;
  line: string;
}

const PALETTES: Record<SkinName, Palette> = {
  fox: {
    body: '#f08a3c',
    bodyShade: '#c9622a',
    belly: '#fff0d8',
    dark: '#4a312c',
    darkShade: '#2f1f1c',
    inner: '#f2a1a1',
    line: '#3a211a',
  },
  arctic: {
    body: '#eef5fa',
    bodyShade: '#b9cddd',
    belly: '#ffffff',
    dark: '#7f98ad',
    darkShade: '#586f84',
    inner: '#f4c6d4',
    line: '#2c3d4d',
  },
};

const SCARF = { a: '#35d9ae', b: '#1d9c7e', stripe: '#fff3c4', line: '#124a3d' };
const EYE = '#1b1210';

type Ctx = CanvasRenderingContext2D;

function path(ctx: Ctx, poly: Pt[]) {
  ctx.beginPath();
  poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

function vertical(ctx: Ctx, poly: Pt[], a: string, b: string) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [, y] of poly) {
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  const g = ctx.createLinearGradient(0, hi, 0, lo);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  return g;
}

/** Fills the outline with a top-to-bottom gradient and draws the line around it. */
function body(ctx: Ctx, poly: Pt[], a: string, b: string, line: string, width = 2.6) {
  path(ctx, poly);
  ctx.fillStyle = vertical(ctx, poly, a, b);
  ctx.fill();
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = line;
  ctx.stroke();
}

function disc(ctx: Ctx, x: number, y: number, rx: number, ry: number, fill: string) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

/** Draws one part for a skin. */
function drawPart(ctx: Ctx, kind: ArtKind, partName: string, skin: SkinName) {
  const p = PALETTES[skin];
  const part = PARTS[partName];
  switch (kind) {
    case 'body': {
      body(ctx, part.shape, p.body, p.bodyShade, p.line);
      path(ctx, part.extra[0]);
      ctx.fillStyle = p.belly;
      ctx.fill();
      break;
    }
    case 'head': {
      body(ctx, part.shape, p.body, p.bodyShade, p.line);
      ctx.save();
      path(ctx, part.shape);
      ctx.clip();
      // the lighter muzzle and cheek
      disc(ctx, 62, 222, 30, 17, p.belly);
      disc(ctx, 14, 214, 22, 12, p.belly);
      ctx.restore();
      path(ctx, part.shape);
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = p.line;
      ctx.stroke();
      disc(ctx, 77, 229, 5.5, 4.2, p.darkShade); // the nose
      disc(ctx, 75.5, 230.5, 1.6, 1.2, '#ffffff');
      ctx.beginPath();
      ctx.moveTo(72, 215);
      ctx.quadraticCurveTo(60, 207, 48, 211);
      ctx.lineWidth = 2;
      ctx.strokeStyle = p.line;
      ctx.stroke();
      break;
    }
    case 'tail': {
      body(ctx, part.shape, p.body, p.bodyShade, p.line);
      ctx.save();
      path(ctx, part.shape);
      ctx.clip();
      const joints = tailJoints();
      const end = joints[joints.length - 1];
      disc(ctx, end[0], end[1], 30, 30, p.belly); // the light tip
      ctx.restore();
      path(ctx, part.shape);
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = p.line;
      ctx.stroke();
      break;
    }
    case 'arm':
      body(ctx, part.shape, p.body, p.bodyShade, p.line);
      break;
    case 'hand':
    case 'foot':
      body(ctx, part.shape, p.dark, p.darkShade, p.line);
      break;
    case 'leg': {
      body(ctx, part.shape, p.dark, p.darkShade, p.line);
      break;
    }
    case 'ear': {
      body(ctx, part.shape, p.body, p.bodyShade, p.line);
      path(ctx, part.extra[0]);
      ctx.fillStyle = p.inner;
      ctx.fill();
      break;
    }
    case 'scarfTail': {
      body(ctx, part.shape, SCARF.a, SCARF.b, SCARF.line);
      ctx.save();
      path(ctx, part.shape);
      ctx.clip();
      ctx.fillStyle = SCARF.stripe;
      for (const [x, y] of part.shape.filter((_, i) => i % 7 === 3)) ctx.fillRect(x - 10, y - 1.5, 20, 3);
      ctx.restore();
      break;
    }
    case 'scarfRing': {
      body(ctx, part.shape, SCARF.a, SCARF.b, SCARF.line);
      ctx.save();
      path(ctx, part.shape);
      ctx.clip();
      ctx.fillStyle = SCARF.stripe;
      for (const x of [-22, -6, 10, 26]) ctx.fillRect(x, 180, 4, 36);
      ctx.restore();
      break;
    }
    case 'eyeOpen': {
      body(ctx, part.shape, EYE, EYE, EYE, 1);
      disc(ctx, 38, 250, 2.8, 3.2, '#ffffff');
      break;
    }
    case 'eyeClosed': {
      body(ctx, part.shape, EYE, EYE, EYE, 2);
      break;
    }
  }
}

/** Every picture of the demo as a PNG, with the name it is registered under. */
export async function drawDemoImages(): Promise<{ name: string; blob: Blob }[]> {
  const out: { name: string; blob: Blob }[] = [];
  for (const img of DEMO_IMAGES) {
    const box = partBox(img.part);
    const canvas = document.createElement('canvas');
    canvas.width = box.width;
    canvas.height = box.height;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, -1, -box.x0, box.y1);
    drawPart(ctx, PARTS[img.part].kind, img.part, img.skin ?? 'fox');
    const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/png'));
    out.push({ name: img.name, blob });
  }
  return out;
}
