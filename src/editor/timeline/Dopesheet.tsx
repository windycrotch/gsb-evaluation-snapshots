import { useEffect, useRef } from 'react';
import { drawWhenDirty, localPoint } from '../ui/canvas';
import { keyGrid } from '@/core/edit';
import { decodeKey, encodeKey } from '@/core/keyrefs';
import type { KeyRef } from '@/core/keyrefs';
import { moveKeysBy, setTime } from '@/store/actions';
import { scaleSelectedKeyTimes } from '@/store/keyToolActions';
import { docStore } from '@/store/doc';
import { markerNear, markersOf } from '@/core/markers';
import { loopGhostTimes } from '@/core/loops';
import { peakAt } from '@/core/waveform';
import { sequenceFramePath, sequenceSpans } from '@/core/sequence';
import { assets } from '@/store/assets';
import { soundShape, soundStore } from '@/store/sounds';
import { openKeyDialog } from '@/store/keyDialog';
import { openMarkerDialog } from '@/store/markerActions';
import { uiStore } from '@/store/ui';
import type { Row } from '@/core/timelineRows';
import { MARKER_TOKENS, alpha, token } from '../ui/tokens';

export const ROW_H = 24;

/** The design token of the key colour for each kind of row. */
const TONES: Record<NonNullable<Row['tone']>, `--${string}`> = {
  bone: '--key-bone',
  slot: '--key-slot',
  ik: '--key-ik',
  deform: '--key-deform',
  order: '--key-order',
  event: '--key-event',
};

export interface TimelineMenuRequest {
  x: number;
  y: number;
  refs: KeyRef[];
}

interface Props {
  rows: Row[];
  duration: number;
  fps: number;
  onMenu: (m: TimelineMenuRequest) => void;
}

type Drag =
  | { kind: 'scrub' }
  | { kind: 'pan'; x: number; scroll: number }
  | { kind: 'scale'; pivot: number; anchor: number }
  | { kind: 'keys'; anchor: KeyRef; grab: number; refs: KeyRef[]; ripple: boolean; loop: boolean }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; base: string[] };

function timeToX(t: number, scroll: number, zoom: number) {
  return (t - scroll) * zoom;
}

function frameStep(pxPerFrame: number): number {
  for (const n of [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800]) if (n * pxPerFrame >= 54) return n;
  return 3600;
}

export function Dopesheet({ rows, duration, fps, onMenu }: Props) {
  const rulerRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef({ rows, duration, fps });
  propsRef.current = { rows, duration, fps };
  const drag = useRef<Drag | null>(null);
  const dirty = useRef(true);

  useEffect(() => {
    const ruler = rulerRef.current!;
    const canvas = canvasRef.current!;
    const host = hostRef.current!;
    const rctx = ruler.getContext('2d')!;
    const ctx = canvas.getContext('2d')!;
    let w = 0;
    let hostH = 0;
    let lastRows: Row[] | null = null;

    let paintNow = () => {};
    /** Sets the canvas sizes (which empties them) and, from the resize callback, paints at once so no empty frame is shown. */
    const resize = (repaint = false) => {
      const dpr = window.devicePixelRatio || 1;
      w = host.clientWidth;
      hostH = host.clientHeight;
      const rowsH = Math.max(hostH, propsRef.current.rows.length * ROW_H + 8);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(rowsH * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = rowsH + 'px';
      ruler.width = Math.round(w * dpr);
      ruler.height = Math.round(28 * dpr);
      ruler.style.width = w + 'px';
      ruler.style.height = '28px';
      dirty.current = true;
      if (repaint) paintNow();
    };
    const ro = new ResizeObserver(() => resize(true));
    ro.observe(host);
    resize();

    const mark = () => {
      dirty.current = true;
    };
    const unsubs = [uiStore.subscribe(mark), docStore.subscribe(mark), soundStore.subscribe(mark)];

    const selectedSet = () => new Set(uiStore.get().selectedKeys);

    const draw = () => {
      const { rows, duration, fps } = propsRef.current;
      const ui = uiStore.get();
      const dpr = window.devicePixelRatio || 1;
      if (lastRows !== rows) {
        lastRows = rows;
        resize();
      }
      const zoom = ui.tlZoom;
      const scroll = ui.tlScroll;
      const sel = selectedSet();
      const cw = canvas.width / dpr;
      const ch = canvas.height / dpr;

      rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      rctx.clearRect(0, 0, w, 28);
      rctx.fillStyle = token('--tl-ruler');
      rctx.fillRect(0, 0, w, 28);
      const pxPerFrame = zoom / fps;
      const step = frameStep(pxPerFrame);
      const firstFrame = Math.floor((scroll * fps) / step) * step;
      rctx.font = '10.5px ui-monospace, Consolas, monospace';
      rctx.textBaseline = 'middle';
      for (let f = firstFrame; timeToX(f / fps, scroll, zoom) < w + 40; f += step) {
        const x = Math.round(timeToX(f / fps, scroll, zoom)) + 0.5;
        const isSecond = f % fps === 0;
        rctx.strokeStyle = isSecond ? token('--tl-tick-strong') : token('--tl-tick');
        rctx.beginPath();
        rctx.moveTo(x, 28);
        rctx.lineTo(x, isSecond ? 8 : 14);
        rctx.stroke();
        rctx.fillStyle = isSecond ? token('--tl-label-strong') : token('--tl-label');
        rctx.fillText(isSecond ? `${f / fps}s` : String(f), x + 4, 11);
        if (pxPerFrame >= 7 && step === 1 && !isSecond) {
          rctx.strokeStyle = 'rgba(255,255,255,0.08)';
        }
      }
      if (pxPerFrame >= 6) {
        rctx.strokeStyle = 'rgba(255,255,255,0.1)';
        rctx.beginPath();
        const f0 = Math.floor(scroll * fps);
        for (let f = f0; timeToX(f / fps, scroll, zoom) < w; f++) {
          const x = Math.round(timeToX(f / fps, scroll, zoom)) + 0.5;
          rctx.moveTo(x, 28);
          rctx.lineTo(x, 22);
        }
        rctx.stroke();
      }
      const endX = timeToX(duration, scroll, zoom);
      if (endX < w) {
        rctx.fillStyle = 'rgba(0,0,0,0.4)';
        rctx.fillRect(Math.max(0, endX), 0, w, 28);
      }
      if (ui.range) {
        // the play range (Playback window): a band on the ruler
        const x0 = timeToX(ui.range[0], scroll, zoom);
        const x1 = timeToX(ui.range[1], scroll, zoom);
        rctx.fillStyle = alpha('--animate', 0.2);
        rctx.fillRect(x0, 0, x1 - x0, 28);
        rctx.fillStyle = token('--animate');
        rctx.fillRect(x0 - 1, 0, 2, 28);
        rctx.fillRect(x1 - 1, 0, 2, 28);
      }
      // markers: a flag with the name on the ruler and a faint line down the keys
      for (const m of markersOf(docStore.get().skeleton.animations.find((a) => a.id === ui.animationId))) {
        const mx = timeToX(m.time, scroll, zoom);
        if (mx < -4 || mx > w + 200) continue;
        rctx.globalAlpha = m.resolved ? 0.35 : 1;
        rctx.fillStyle = token(MARKER_TOKENS[m.color]);
        rctx.fillRect(Math.round(mx) - 0.5, 0, 1.5, 28);
        rctx.beginPath();
        rctx.moveTo(mx, 0);
        rctx.lineTo(mx + 7, 3.5);
        rctx.lineTo(mx, 7);
        rctx.closePath();
        rctx.fill();
        if (m.name) {
          rctx.font = '10px ui-sans-serif, system-ui, sans-serif';
          rctx.fillText(m.name, mx + 10, 4);
        }
        rctx.globalAlpha = 1;
      }
      const px = timeToX(ui.time, scroll, zoom);
      rctx.fillStyle = token('--animate');
      rctx.beginPath();
      rctx.moveTo(px - 6, 18);
      rctx.lineTo(px + 6, 18);
      rctx.lineTo(px, 28);
      rctx.closePath();
      rctx.fill();
      rctx.fillRect(px - 0.5, 0, 1, 18);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      ctx.fillStyle = token('--sunken-2');
      ctx.fillRect(0, 0, cw, ch);
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const y = i * ROW_H;
        if (r.type === 'group') {
          ctx.fillStyle = token('--tl-row-group');
          ctx.fillRect(0, y, cw, ROW_H);
        } else if (r.selected) {
          ctx.fillStyle = token('--tl-row-selected');
          ctx.fillRect(0, y, cw, ROW_H);
        } else if (i % 2 === 1) {
          ctx.fillStyle = token('--tl-row-alt');
          ctx.fillRect(0, y, cw, ROW_H);
        }
      }
      for (const m of markersOf(docStore.get().skeleton.animations.find((a) => a.id === ui.animationId))) {
        ctx.fillStyle = alpha(MARKER_TOKENS[m.color], m.resolved ? 0.1 : 0.3);
        ctx.fillRect(Math.round(timeToX(m.time, scroll, zoom)) - 0.5, 0, 1, ch);
      }
      // vertical grid (every second, and every frame when zoomed in)
      ctx.strokeStyle = token('--tl-grid');
      ctx.beginPath();
      const s0 = Math.floor(scroll);
      for (let s = s0; timeToX(s, scroll, zoom) < cw; s++) {
        const x = Math.round(timeToX(s, scroll, zoom)) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, ch);
      }
      ctx.stroke();
      if (pxPerFrame >= 9) {
        ctx.strokeStyle = token('--tl-grid-frame');
        ctx.beginPath();
        for (let f = Math.floor(scroll * fps); timeToX(f / fps, scroll, zoom) < cw; f++) {
          const x = Math.round(timeToX(f / fps, scroll, zoom)) + 0.5;
          ctx.moveTo(x, 0);
          ctx.lineTo(x, ch);
        }
        ctx.stroke();
      }
      // beyond the end
      if (endX < cw) {
        ctx.fillStyle = token('--tl-after-end');
        ctx.fillRect(Math.max(0, endX), 0, cw, ch);
        ctx.fillStyle = alpha('--animate', 0.5);
        ctx.fillRect(Math.round(endX), 0, 1, ch);
      }
      // the sound of each event on the events row: its waveform from the time of the key, as far as it plays
      const eventRow = rows.findIndex((r) => r.id === 'events');
      if (eventRow >= 0) {
        const project = docStore.get();
        const anim = project.skeleton.animations.find((a) => a.id === ui.animationId);
        const top = eventRow * ROW_H;
        for (const k of anim?.events ?? []) {
          const def = project.skeleton.events.find((e) => e.id === k.event);
          const shape = def?.audio ? soundShape(def.audio) : null;
          if (!shape) continue;
          const x0 = timeToX(k.time, scroll, zoom);
          const x1 = timeToX(k.time + shape.duration, scroll, zoom);
          if (x1 < 0 || x0 > cw) continue;
          ctx.fillStyle = alpha(TONES.event, 0.45);
          for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(cw, Math.ceil(x1)); x += 2) {
            const h = peakAt(shape, (x - x0) / zoom) * (ROW_H - 4);
            if (h > 0.4) ctx.fillRect(x, top + (ROW_H - h) / 2, 1.5, h);
          }
        }
      }
      // the pictures of a sequence between its keys: a thumbnail where a frame shows, a line where the next one starts
      for (let i = 0; i < rows.length; i++) {
        const seq = rows[i].sequence;
        if (!seq) continue;
        const top = i * ROW_H + 2;
        const h = ROW_H - 4;
        for (const span of sequenceSpans(seq.keys, seq.def.count, duration, scroll - 0.05, scroll + cw / zoom + 0.05)) {
          const x0 = timeToX(span.start, scroll, zoom);
          const x1 = timeToX(span.end, scroll, zoom);
          if (x1 < 0 || x0 > cw || x1 - x0 < 2) continue;
          ctx.fillStyle = alpha(TONES.slot, 0.16);
          ctx.fillRect(x0, top, x1 - x0, h);
          ctx.fillStyle = alpha(TONES.slot, 0.55);
          ctx.fillRect(Math.round(x0), top, 1, h);
          const bitmap = x1 - x0 >= 10 ? assets.get(sequenceFramePath(seq.path, seq.def, span.index))?.bitmap : undefined;
          if (!bitmap) continue;
          const scale = Math.min((x1 - x0 - 3) / bitmap.width, h / bitmap.height);
          if (!(scale > 0)) continue;
          const dw = bitmap.width * scale;
          ctx.drawImage(bitmap, x0 + 2, top + (h - bitmap.height * scale) / 2, dw, bitmap.height * scale);
          if (x1 - x0 > dw + 22) {
            ctx.fillStyle = token('--text-dim');
            ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(span.index + 1), x0 + dw + 6, top + h / 2);
          }
        }
      }
      // keys
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r.type === 'group') continue;
        const cy = i * ROW_H + ROW_H / 2;
        const keys = r.keys;
        const size = r.type === 'entity' ? 5.6 : 4.6;
        for (const k of keys) {
          const x = timeToX(k.time, scroll, zoom);
          if (x < -10 || x > cw + 10) continue;
          const selected = k.refs.some((ref) => sel.has(encodeKey(ref)));
          ctx.beginPath();
          ctx.moveTo(x, cy - size);
          ctx.lineTo(x + size, cy);
          ctx.lineTo(x, cy + size);
          ctx.lineTo(x - size, cy);
          ctx.closePath();
          ctx.fillStyle = selected ? token('--accent') : token(TONES[r.tone ?? 'bone']);
          if (r.type === 'prop' && !selected) ctx.globalAlpha = 0.82;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = selected ? token('--accent-glow') : token('--key-outline');
          ctx.lineWidth = 1.2;
          ctx.stroke();
          // a looping animation comes round again: faint copies of the key before 0 and after the end show where the seam falls
          if (ui.loop) {
            ctx.globalAlpha = 0.28;
            ctx.fillStyle = token(TONES[r.tone ?? 'bone']);
            for (const gt of loopGhostTimes(k.time, duration, scroll - 12 / zoom, scroll + (cw + 12) / zoom)) {
              const gx = timeToX(gt, scroll, zoom);
              ctx.beginPath();
              ctx.moveTo(gx, cy - size * 0.8);
              ctx.lineTo(gx + size * 0.8, cy);
              ctx.lineTo(gx, cy + size * 0.8);
              ctx.lineTo(gx - size * 0.8, cy);
              ctx.closePath();
              ctx.fill();
            }
            ctx.globalAlpha = 1;
          }
        }
      }
      if (ui.range) {
        // what is outside the play range is dimmed
        const x0 = Math.max(0, timeToX(ui.range[0], scroll, zoom));
        const x1 = Math.min(cw, timeToX(ui.range[1], scroll, zoom));
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        if (x0 > 0) ctx.fillRect(0, 0, x0, ch);
        if (x1 < cw) ctx.fillRect(x1, 0, cw - x1, ch);
      }
      // playhead
      ctx.fillStyle = alpha('--animate', 0.9);
      ctx.fillRect(Math.round(px), 0, 1, ch);
      // marquee
      const d = drag.current;
      if (d?.kind === 'marquee') {
        ctx.fillStyle = alpha('--accent', 0.12);
        ctx.strokeStyle = token('--accent');
        ctx.lineWidth = 1;
        const x = Math.min(d.x0, d.x1);
        const y = Math.min(d.y0, d.y1);
        ctx.fillRect(x, y, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
        ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      }
    };

    const loop = drawWhenDirty(dirty, draw);
    paintNow = loop.now;

    const local = localPoint;
    const xToTime = (x: number) => x / uiStore.get().tlZoom + uiStore.get().tlScroll;

    const hitKey = (x: number, y: number): { row: Row; key: Row['keys'][number] } | null => {
      const rows = propsRef.current.rows;
      const i = Math.floor(y / ROW_H);
      const row = rows[i];
      if (!row || row.type === 'group') return null;
      const { tlZoom, tlScroll } = uiStore.get();
      let best: { row: Row; key: Row['keys'][number]; d: number } | null = null;
      for (const k of row.keys) {
        const d = Math.abs(timeToX(k.time, tlScroll, tlZoom) - x);
        if (d <= 8 && (!best || d < best.d)) best = { row, key: k, d };
      }
      return best;
    };

    // ruler scrubbing
    const scrubTo = (e: PointerEvent) => {
      const [x] = local(e, ruler);
      setTime(xToTime(x));
    };
    /** The marker under a point of the ruler (the flag or its line). */
    const markerAt = (x: number) => {
      const ui = uiStore.get();
      return markerNear(
        docStore.get().skeleton.animations.find((a) => a.id === ui.animationId),
        (x - 3) / ui.tlZoom + ui.tlScroll,
        8 / ui.tlZoom,
      );
    };
    const onRulerDouble = (e: MouseEvent) => {
      const m = markerAt(local(e, ruler)[0]);
      if (m) openMarkerDialog(m.id);
    };
    ruler.addEventListener('dblclick', onRulerDouble);
    const onRulerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      ruler.setPointerCapture(e.pointerId);
      drag.current = { kind: 'scrub' };
      uiStore.patch({ playing: false });
      scrubTo(e);
    };
    const onRulerMove = (e: PointerEvent) => {
      if (drag.current?.kind === 'scrub') scrubTo(e);
    };
    const onRulerUp = () => {
      drag.current = null;
    };
    ruler.addEventListener('pointerdown', onRulerDown);
    ruler.addEventListener('pointermove', onRulerMove);
    ruler.addEventListener('pointerup', onRulerUp);

    // keys canvas
    const onDown = (e: PointerEvent) => {
      const [x, y] = local(e, canvas);
      const hit = hitKey(x, y);
      // Alt on empty space pans; Alt on a key drags it with every later key of its timeline (Shift in Spine)
      if (e.button === 1 || (e.button === 0 && e.altKey && !hit)) {
        canvas.setPointerCapture(e.pointerId);
        drag.current = { kind: 'pan', x: e.clientX, scroll: uiStore.get().tlScroll };
        e.preventDefault();
        return;
      }
      const ui = uiStore.get();
      if (e.button === 2) {
        e.preventDefault();
        if (hit) {
          const enc = hit.key.refs.map(encodeKey);
          let selected = ui.selectedKeys;
          if (!enc.every((s) => selected.includes(s))) {
            selected = enc;
            uiStore.patch({ selectedKeys: selected });
          }
          onMenu({ x: e.clientX, y: e.clientY, refs: selected.map(decodeKey) });
        }
        return;
      }
      if (e.button !== 0) return;
      canvas.setPointerCapture(e.pointerId);
      if (hit) {
        const enc = hit.key.refs.map(encodeKey);
        let selected: string[];
        const already = enc.every((s) => ui.selectedKeys.includes(s));
        // Ctrl+Shift on a selected key: drag it to stretch or squeeze the time of the whole selection around its earliest key
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && already) {
          const pivot = Math.min(...ui.selectedKeys.map((s) => decodeKey(s).time));
          if (hit.key.time - pivot > 1e-6) {
            docStore.beginGesture('Scale key times');
            drag.current = { kind: 'scale', pivot, anchor: hit.key.time };
          }
          return;
        }
        // Ctrl+Alt: Offset keys (the keys go round the loop); the modifiers do not toggle the selection then
        const loop = e.altKey && (e.ctrlKey || e.metaKey);
        if (loop) selected = already ? ui.selectedKeys : enc;
        else if (e.shiftKey || e.ctrlKey || e.metaKey) {
          selected = already ? ui.selectedKeys.filter((s) => !enc.includes(s)) : [...new Set([...ui.selectedKeys, ...enc])];
        } else selected = already ? ui.selectedKeys : enc;
        uiStore.patch({ selectedKeys: selected });
        if (selected.length && (loop || !(already && (e.shiftKey || e.ctrlKey || e.metaKey)))) {
          docStore.beginGesture(loop ? 'Offset keys' : 'Move keys');
          drag.current = {
            kind: 'keys',
            anchor: hit.key.refs[0],
            grab: xToTime(x) - hit.key.time,
            refs: selected.map(decodeKey),
            ripple: e.altKey && !loop,
            loop,
          };
        }
        return;
      }
      // empty space: start marquee
      drag.current = { kind: 'marquee', x0: x, y0: y, x1: x, y1: y, base: e.shiftKey ? ui.selectedKeys : [] };
      if (!e.shiftKey) uiStore.patch({ selectedKeys: [] });
    };
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const [x, y] = local(e, canvas);
      if (d.kind === 'pan') {
        const ui = uiStore.get();
        uiStore.patch({ tlScroll: d.scroll - (e.clientX - d.x) / ui.tlZoom });
      } else if (d.kind === 'keys') {
        // keys snap to whole frames, or to the finer steps of Settings → Key time step (keys between frames)
        const fps = propsRef.current.fps * keyGrid.steps;
        const target = d.loop ? Math.round((xToTime(x) - d.grab) * fps) / fps : Math.max(0, Math.round((xToTime(x) - d.grab) * fps) / fps);
        const delta = target - d.anchor.time;
        if (Math.abs(delta) > 1e-6) {
          const anchorIndex = d.refs.findIndex((r) => encodeKey(r) === encodeKey(d.anchor));
          const moved = moveKeysBy(d.refs, delta, d.ripple, d.loop);
          d.anchor = { ...d.anchor, time: (moved[anchorIndex] ?? moved[0]).time };
          d.refs = moved;
          uiStore.patch({ selectedKeys: moved.map(encodeKey) });
        }
      } else if (d.kind === 'scale') {
        const fps = propsRef.current.fps * keyGrid.steps;
        const target = Math.round(xToTime(x) * fps) / fps;
        const factor = (target - d.pivot) / (d.anchor - d.pivot);
        if (target > d.pivot + 1e-6 && Math.abs(factor - 1) > 1e-6 && scaleSelectedKeyTimes(factor) > 0) d.anchor = target;
      } else if (d.kind === 'marquee') {
        d.x1 = x;
        d.y1 = y;
        const { tlZoom, tlScroll } = uiStore.get();
        const x0 = Math.min(d.x0, d.x1);
        const x1 = Math.max(d.x0, d.x1);
        const y0 = Math.min(d.y0, d.y1);
        const y1 = Math.max(d.y0, d.y1);
        const picked = new Set(d.base);
        const rows = propsRef.current.rows;
        for (let i = Math.floor(y0 / ROW_H); i <= Math.floor(y1 / ROW_H); i++) {
          const r = rows[i];
          if (!r || r.type === 'group') continue;
          for (const k of r.keys) {
            const kx = timeToX(k.time, tlScroll, tlZoom);
            if (kx >= x0 - 4 && kx <= x1 + 4) for (const ref of k.refs) picked.add(encodeKey(ref));
          }
        }
        uiStore.patch({ selectedKeys: [...picked] });
        dirty.current = true;
      }
    };
    const onUp = () => {
      if (drag.current?.kind === 'keys' || drag.current?.kind === 'scale') docStore.endGesture();
      drag.current = null;
      dirty.current = true;
    };
    const onWheel = (e: WheelEvent) => {
      const ui = uiStore.get();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const [x] = local(e, canvas);
        const t = xToTime(x);
        const zoom = Math.min(3000, Math.max(20, ui.tlZoom * Math.exp(-e.deltaY * 0.0022)));
        uiStore.patch({ tlZoom: zoom, tlScroll: t - x / zoom });
      } else if (e.shiftKey) {
        e.preventDefault();
        uiStore.patch({ tlScroll: ui.tlScroll + (e.deltaY + e.deltaX) / ui.tlZoom });
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        uiStore.patch({ tlScroll: ui.tlScroll + e.deltaX / ui.tlZoom });
      }
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    ruler.addEventListener('wheel', onWheel, { passive: false });
    const noCtx = (e: Event) => e.preventDefault();
    canvas.addEventListener('contextmenu', noCtx);
    // a double click on a key opens the key dialog
    const onDouble = (e: MouseEvent) => {
      const [x, y] = local(e, canvas);
      const hit = hitKey(x, y);
      if (hit) openKeyDialog(hit.key.refs[0]);
    };
    canvas.addEventListener('dblclick', onDouble);

    return () => {
      loop.stop();
      ro.disconnect();
      unsubs.forEach((u) => u());
      ruler.removeEventListener('pointerdown', onRulerDown);
      ruler.removeEventListener('pointermove', onRulerMove);
      ruler.removeEventListener('pointerup', onRulerUp);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      ruler.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', noCtx);
      canvas.removeEventListener('dblclick', onDouble);
      ruler.removeEventListener('dblclick', onRulerDouble);
    };
  }, [onMenu]);

  useEffect(() => {
    dirty.current = true;
  });

  return (
    <div className="tl-canvas-wrap" data-learn="timeline">
      <div className="tl-ruler">
        <canvas ref={rulerRef} />
      </div>
      <div
        className="tl-canvas-host"
        ref={hostRef}
        tabIndex={0}
        role="region"
        aria-label="Dopesheet"
        onScroll={(e) => {
          const labels = document.getElementById('tl-label-scroll');
          if (labels && labels.scrollTop !== e.currentTarget.scrollTop) labels.scrollTop = e.currentTarget.scrollTop;
        }}
      >
        <canvas ref={canvasRef} className="tl-canvas" />
      </div>
    </div>
  );
}
