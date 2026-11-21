import { useEffect, useRef } from 'react';
import { boxOf, fitMap, fromMap, toMap, unionBox, viewBox } from '@/core/minimap';
import { docStore } from '@/store/doc';
import { uiStore } from '@/store/ui';
import { getScene } from '@/store/scene';
import { alpha, token } from '../ui/tokens';

const W = 190;
const H = 130;

/**
 * The outline map: the whole skeleton in a corner of the viewport, with a frame around the part that is on screen. Click or drag on it to
 * move the viewport there (Spine's Outline view, to find the way in a big rig when zoomed far in).
 */
export function OutlineMap({ host }: { host: React.RefObject<HTMLDivElement | null> }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(W * dpr);
    el.height = Math.round(H * dpr);
    const ctx = el.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    const size = () => [host.current?.clientWidth ?? 800, host.current?.clientHeight ?? 600] as const;

    const layout = () => {
      const [w, h] = size();
      const sk = getScene().skeleton;
      const pts: [number, number][] = [];
      for (const b of sk.bones) pts.push([b.worldX, b.worldY], [b.tipX, b.tipY]);
      const imgs = sk.getBounds();
      let content = boxOf(pts);
      if (imgs) content = unionBox(content, { minX: imgs[0], minY: imgs[1], maxX: imgs[0] + imgs[2], maxY: imgs[1] + imgs[3] });
      return fitMap(content, viewBox(uiStore.get().camera, w, h), W, H);
    };

    const draw = () => {
      raf = 0;
      const [w, h] = size();
      const ui = uiStore.get();
      const sk = getScene().skeleton;
      const m = layout();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const hidden = new Set(
        docStore
          .get()
          .skeleton.bones.filter((b) => b.hidden)
          .map((b) => b.id),
      );
      const imgs = sk.getBounds();
      if (imgs) {
        const [x0, y0] = toMap(m, imgs[0], imgs[1] + imgs[3]);
        const [x1, y1] = toMap(m, imgs[0] + imgs[2], imgs[1]);
        ctx.fillStyle = alpha('--muted', 0.12);
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
      ctx.lineWidth = 1.5;
      for (const b of sk.bones) {
        if (hidden.has(b.data.id)) continue;
        const [ax, ay] = toMap(m, b.worldX, b.worldY);
        const [bx, by] = toMap(m, b.tipX, b.tipY);
        ctx.strokeStyle = ui.selection.bones.includes(b.data.id) ? token('--accent') : alpha('--text', 0.55);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
      const v = viewBox(ui.camera, w, h);
      const [vx0, vy0] = toMap(m, v.minX, v.maxY);
      const [vx1, vy1] = toMap(m, v.maxX, v.minY);
      ctx.strokeStyle = token('--accent');
      ctx.lineWidth = 1;
      ctx.strokeRect(vx0 + 0.5, vy0 + 0.5, vx1 - vx0, vy1 - vy0);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    schedule();
    const off = [uiStore.subscribe(schedule), docStore.subscribe(schedule)];
    return () => {
      off.forEach((f) => f());
      if (raf) cancelAnimationFrame(raf);
    };
  }, [host]);

  // the viewport moves to the point that was clicked, and follows the pointer while it is held
  const go = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = canvas.current!;
    const r = el.getBoundingClientRect();
    const hostEl = host.current;
    const w = hostEl?.clientWidth ?? 800;
    const h = hostEl?.clientHeight ?? 600;
    const sk = getScene().skeleton;
    const pts: [number, number][] = [];
    for (const b of sk.bones) pts.push([b.worldX, b.worldY], [b.tipX, b.tipY]);
    const imgs = sk.getBounds();
    let content = boxOf(pts);
    if (imgs) content = unionBox(content, { minX: imgs[0], minY: imgs[1], maxX: imgs[0] + imgs[2], maxY: imgs[1] + imgs[3] });
    const cam = uiStore.get().camera;
    const m = fitMap(content, viewBox(cam, w, h), W, H);
    const [x, y] = fromMap(m, e.clientX - r.left, e.clientY - r.top);
    uiStore.patch({ camera: { ...cam, x, y } });
  };
  return (
    <canvas
      ref={canvas}
      className="outline-map"
      style={{ width: W, height: H }}
      aria-label="Outline map"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        e.stopPropagation();
        go(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) go(e);
      }}
    />
  );
}
