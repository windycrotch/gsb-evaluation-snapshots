/** Motion trails in the viewport: where the selected bones travel during the current animation, with the keys marked on the path. */
import { BONE_PROPS } from '@/core/model';
import { sampleTrails, trailAt } from '@/core/trails';
import type { Trail } from '@/core/trails';
import { docStore } from '@/store/doc';
import { worldToScreen } from '@/store/scene';
import { alpha } from '../ui/tokens';
import type { OverlayInput } from './overlay';

/** At most this many bones get a trail at once. */
const MAX_BONES = 4;

let cache: { data: unknown; anim: unknown; skin: string | null; ids: string; fps: number; trails: Trail[] } | null = null;

function trailsFor(o: OverlayInput): Trail[] {
  const { scene, ui } = o;
  const anim = scene.animation;
  if (!anim) return [];
  const ids = ui.selection.bones.slice(0, MAX_BONES);
  const fps = docStore.get().skeleton.fps;
  const key = ids.join(',');
  if (cache && cache.data === scene.data && cache.anim === anim && cache.skin === ui.skinId && cache.ids === key && cache.fps === fps)
    return cache.trails;
  const trails = ids.length ? sampleTrails(scene.data, anim, ids, fps, ui.skinId, 'origin') : [];
  cache = { data: scene.data, anim, skin: ui.skinId, ids: key, fps, trails };
  return trails;
}

/** The times at which a bone has any key. */
function keyTimes(o: OverlayInput, boneId: string): number[] {
  const tl = o.scene.animation?.bones[boneId];
  if (!tl) return [];
  const times = new Set<number>();
  for (const p of BONE_PROPS) for (const k of tl[p] ?? []) times.add(Math.round(k.time * 1e5) / 1e5);
  return [...times].sort((a, b) => a - b);
}

export function drawTrails(o: OverlayInput) {
  const { ctx, w, h, cam, ui } = o;
  if (!ui.view.trails || ui.mode !== 'animate' || !o.scene.animation) return;
  const trails = trailsFor(o);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const trail of trails) {
    const pts = trail.points;
    if (pts.length < 2) continue;
    const screen = pts.map((p) => worldToScreen(cam, w, h, p.x, p.y));
    // what has been travelled is cool, what is still to come is warm
    for (const [from, to, color, width] of [
      [0, pts.findIndex((p) => p.time > ui.time), alpha('--accent', 0.85), 2],
      [Math.max(0, pts.findIndex((p) => p.time > ui.time) - 1), pts.length, alpha('--animate', 0.85), 2],
    ] as [number, number, string, number][]) {
      const end = to < 0 ? pts.length : to + 1;
      if (end - from < 2) continue;
      ctx.beginPath();
      for (let i = from; i < Math.min(end, pts.length); i++)
        i === from ? ctx.moveTo(screen[i][0], screen[i][1]) : ctx.lineTo(screen[i][0], screen[i][1]);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    }
    // the keys
    ctx.fillStyle = alpha('--text', 0.95);
    ctx.strokeStyle = alpha('--bg', 0.9);
    ctx.lineWidth = 1.5;
    for (const t of keyTimes(o, trail.boneId)) {
      const p = trailAt(trail, t);
      if (!p) continue;
      const [sx, sy] = worldToScreen(cam, w, h, p[0], p[1]);
      ctx.beginPath();
      ctx.arc(sx, sy, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // the playhead
    const now = trailAt(trail, ui.time);
    if (now) {
      const [sx, sy] = worldToScreen(cam, w, h, now[0], now[1]);
      ctx.beginPath();
      ctx.arc(sx, sy, 6, 0, Math.PI * 2);
      ctx.strokeStyle = alpha('--animate', 1);
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
  ctx.restore();
}
