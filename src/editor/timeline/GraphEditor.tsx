/** Curve editor: value-over-time graphs for the selected timelines, with draggable keys and bezier handles. */
import { drawWhenDirty, localPoint } from '../ui/canvas';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { segmentProgress } from '@/core/curve';
import { keyGrid } from '@/core/edit';
import { decodeKey, encodeKey } from '@/core/keyrefs';
import type { KeyRef } from '@/core/keyrefs';
import { BONE_PROPS, GLOBAL_PHYSICS } from '@/core/model';
import type { Animation, Id, Key, SkeletonDoc } from '@/core/model';
import { moveKeysBy, setKeyChannelValue, setKeyCurveHandle, setTime } from '@/store/actions';
import { docStore } from '@/store/doc';
import { useSettings } from '@/store/settings';
import { uiStore } from '@/store/ui';
import type { Selection } from '@/store/ui';
import { tr, useLang } from '@/i18n';
import { IconButton } from '../ui/controls';
import { alpha, token } from '../ui/tokens';

interface Curve {
  id: string;
  label: string;
  color: string;
  ref: Pick<KeyRef, 'kind' | 'target' | 'prop'>;
  channel: number;
  channels: number;
  keys: Key[];
}

/** The colour of channel `c` of a curve: x / r, y / g, z / b, w / a. */
const curveColor = (c: number) => token(`--curve-${(c % 4) + 1}` as `--${string}`);
const CHANNEL_NAMES: Record<string, string[]> = {
  rotate: ['rotation'],
  translate: ['x', 'y'],
  translatex: ['x'],
  translatey: ['y'],
  scale: ['scale x', 'scale y'],
  scalex: ['scale x'],
  scaley: ['scale y'],
  shear: ['shear x', 'shear y'],
  shearx: ['shear x'],
  sheary: ['shear y'],
  rgba: ['r', 'g', 'b', 'a'],
  rgba2: ['r', 'g', 'b', 'a', 'dark r', 'dark g', 'dark b'],
  transform: ['mix rotate', 'mix x', 'mix y', 'mix scale x', 'mix scale y', 'mix shear y'],
  ik: ['mix', 'softness'],
  time: ['time'],
  mix: ['mix'],
  position: ['position'],
  spacing: ['spacing'],
  pathMix: ['mix rotate', 'mix x', 'mix y'],
  inertia: ['inertia'],
  strength: ['strength'],
  damping: ['damping'],
  mass: ['mass'],
  wind: ['wind'],
  gravity: ['gravity'],
};

/** The names of the numbers in one key of a timeline (also used by the key dialog). */
export function channelNames(kind: KeyRef['kind'], prop: string): string[] {
  if (kind === 'transform') return CHANNEL_NAMES.transform;
  if (kind === 'ik') return CHANNEL_NAMES.ik;
  if (kind === 'path' && prop === 'mix') return CHANNEL_NAMES.pathMix;
  return CHANNEL_NAMES[prop] ?? [prop];
}

/**
 * Curves for: timelines of selected keys, else all timelines of the selected bones (`sync` 'dopesheet', Spine's dopesheet-centric mode:
 * a key selected in the Dopesheet shows its own timeline). With `sync` 'selection' the keys do not matter: the selected bones' timelines.
 */
export function buildCurves(
  doc: SkeletonDoc,
  anim: Animation | null,
  selection: Selection,
  selectedKeys: string[],
  sync: 'dopesheet' | 'selection' = 'dopesheet',
): Curve[] {
  if (!anim) return [];
  const out: Curve[] = [];
  const seen = new Set<string>();
  const add = (kind: KeyRef['kind'], target: Id, prop: string, keys: Key[] | undefined, title: string, names: string[]) => {
    if (!keys || !keys.length) return;
    const id = `${kind}|${target}|${prop}`;
    if (seen.has(id)) return;
    seen.add(id);
    const channels = keys[0].value.length;
    for (let c = 0; c < channels; c++) {
      out.push({
        id: `${id}|${c}`,
        label: `${title} · ${names[c] ?? c}`,
        color: curveColor(c),
        ref: { kind, target, prop },
        channel: c,
        channels,
        keys,
      });
    }
  };
  const addBone = (boneId: Id, only?: string) => {
    const b = doc.bones.find((x) => x.id === boneId);
    const tl = anim.bones[boneId];
    if (!b || !tl) return;
    for (const p of BONE_PROPS) if (!only || only === p) add('bone', boneId, p, tl[p], b.name, CHANNEL_NAMES[p]);
  };
  const refs = sync === 'selection' ? [] : selectedKeys.map(decodeKey);
  for (const r of refs) {
    if (r.kind === 'bone') addBone(r.target, r.prop);
    else if (r.kind === 'slot' && (r.prop === 'rgba' || r.prop === 'rgba2'))
      add(
        'slot',
        r.target,
        r.prop,
        anim.slots[r.target]?.[r.prop],
        doc.slots.find((s) => s.id === r.target)?.name ?? '?',
        CHANNEL_NAMES[r.prop],
      );
    else if (r.kind === 'transform')
      add(
        'transform',
        r.target,
        '',
        anim.transform?.[r.target],
        doc.constraints.find((c) => c.id === r.target)?.name ?? '?',
        CHANNEL_NAMES.transform,
      );
    else if (r.kind === 'ik')
      add('ik', r.target, '', anim.ik[r.target], doc.constraints.find((c) => c.id === r.target)?.name ?? '?', CHANNEL_NAMES.ik);
    else if (r.kind === 'path' && (r.prop === 'position' || r.prop === 'spacing' || r.prop === 'mix'))
      add(
        'path',
        r.target,
        r.prop,
        anim.path?.[r.target]?.[r.prop],
        doc.constraints.find((c) => c.id === r.target)?.name ?? '?',
        r.prop === 'mix' ? CHANNEL_NAMES.pathMix : CHANNEL_NAMES[r.prop],
      );
    else if (r.kind === 'physics' && r.prop !== 'reset')
      add(
        'physics',
        r.target,
        r.prop,
        anim.physics?.[r.target]?.[r.prop as 'mix'],
        r.target === GLOBAL_PHYSICS ? 'Global physics' : (doc.constraints.find((c) => c.id === r.target)?.name ?? '?'),
        CHANNEL_NAMES[r.prop] ?? [r.prop],
      );
    else if (r.kind === 'slider' && (r.prop === 'time' || r.prop === 'mix'))
      add(
        'slider',
        r.target,
        r.prop,
        anim.slider?.[r.target]?.[r.prop],
        doc.constraints.find((c) => c.id === r.target)?.name ?? '?',
        CHANNEL_NAMES[r.prop],
      );
  }
  if (!out.length) for (const id of selection.bones) addBone(id);
  return out;
}

const PAD_L = 44;

interface Drag {
  kind: 'key' | 'handle' | 'pan' | 'scrub';
  curve?: Curve;
  keyIndex?: number;
  handle?: 1 | 2;
  anchorTime?: number;
  /** Where the dragged key is right now (its time changes while it is dragged; `curve.keys` is only a snapshot). */
  ref?: KeyRef;
  grab?: number;
  panY?: number;
  vCenter?: number;
}

export function GraphEditor({
  anim,
  doc,
  selection,
  selectedKeys,
  fps,
}: {
  anim: Animation | null;
  doc: SkeletonDoc;
  selection: Selection;
  selectedKeys: string[];
  fps: number;
}) {
  const sync = useSettings((s) => s.graphSync);
  const curves = useMemo(() => buildCurves(doc, anim, selection, selectedKeys, sync), [doc, anim, selection, selectedKeys, sync]);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const state = useRef({ curves, hidden, fps, view: { center: 0, scale: 1, auto: true } });
  state.current.curves = curves;
  state.current.hidden = hidden;
  state.current.fps = fps;
  const dirty = useRef(true);
  const drag = useRef<Drag | null>(null);
  const lang = useLang();

  useEffect(() => {
    dirty.current = true; // the hint on the canvas is drawn, not rendered by React
  }, [lang]);

  useEffect(() => {
    state.current.view.auto = true;
    dirty.current = true;
  }, [curves.length]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const host = hostRef.current!;
    const ctx = canvas.getContext('2d')!;
    let w = 0;
    let h = 0;
    let paintNow = () => {};
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      w = host.clientWidth;
      h = host.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      dirty.current = true;
      paintNow(); // a resized canvas is empty: paint it in this frame, not the next
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();
    const mark = () => {
      dirty.current = true;
    };
    const unsubs = [uiStore.subscribe(mark), docStore.subscribe(mark)];

    const visible = () => state.current.curves.filter((c) => !state.current.hidden[c.id]);
    const fit = () => {
      let min = Infinity;
      let max = -Infinity;
      for (const c of visible())
        for (const k of c.keys) {
          min = Math.min(min, k.value[c.channel]);
          max = Math.max(max, k.value[c.channel]);
        }
      if (!isFinite(min)) {
        min = -1;
        max = 1;
      }
      if (max - min < 1e-3) {
        min -= 0.5;
        max += 0.5;
      }
      const pad = (max - min) * 0.18;
      state.current.view = { center: (min + max) / 2, scale: (h - 40) / (max - min + pad * 2), auto: false };
    };
    const tx = (t: number) => (t - uiStore.get().tlScroll) * uiStore.get().tlZoom;
    const vy = (v: number) => h / 2 - (v - state.current.view.center) * state.current.view.scale;
    const toValue = (y: number) => (h / 2 - y) / state.current.view.scale + state.current.view.center;
    const toTime = (x: number) => x / uiStore.get().tlZoom + uiStore.get().tlScroll;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      if (state.current.view.auto) fit();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = token('--sunken-2');
      ctx.fillRect(0, 0, w, h);
      const ui = uiStore.get();
      // time grid
      ctx.strokeStyle = token('--tl-grid');
      ctx.beginPath();
      for (let s = Math.floor(ui.tlScroll); tx(s) < w; s++) {
        const x = Math.round(tx(s)) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      ctx.stroke();
      // value grid
      const span = h / state.current.view.scale;
      const rawStep = span / 6;
      const pow = Math.pow(10, Math.floor(Math.log10(rawStep)));
      const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rawStep) ?? pow * 10;
      ctx.font = '10px ui-monospace, Consolas, monospace';
      ctx.textBaseline = 'middle';
      for (let v = Math.ceil(toValue(h) / step) * step; v <= toValue(0); v += step) {
        const y = Math.round(vy(v)) + 0.5;
        ctx.strokeStyle = Math.abs(v) < step / 2 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.06)';
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        ctx.fillStyle = alpha('--text-dim', 0.75);
        ctx.fillText(String(Math.round(v * 1000) / 1000), 4, y - 7);
      }
      const selectedSet = new Set(ui.selectedKeys);
      for (const c of visible()) {
        ctx.strokeStyle = c.color;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        for (let i = 0; i < c.keys.length; i++) {
          const k = c.keys[i];
          const v = k.value[c.channel];
          const x = tx(k.time);
          if (i === 0) ctx.moveTo(x, vy(v));
          const n = c.keys[i + 1];
          if (!n) break;
          const nv = n.value[c.channel];
          if (k.curve === 'stepped') {
            ctx.lineTo(tx(n.time), vy(v));
            ctx.lineTo(tx(n.time), vy(nv));
          } else {
            const steps = Math.max(2, Math.min(60, Math.ceil(((n.time - k.time) * ui.tlZoom) / 6)));
            for (let s = 1; s <= steps; s++) {
              const u = s / steps;
              const p = segmentProgress(k.curve, c.channel, u);
              ctx.lineTo(tx(k.time + (n.time - k.time) * u), vy(v + (nv - v) * p));
            }
          }
        }
        ctx.stroke();
        // keys + handles
        for (let i = 0; i < c.keys.length; i++) {
          const k = c.keys[i];
          const sel = selectedSet.has(encodeKey({ ...c.ref, time: k.time }));
          const x = tx(k.time);
          const y = vy(k.value[c.channel]);
          const n = c.keys[i + 1];
          if (sel && n && Array.isArray(k.curve)) {
            const cv = k.curve;
            const dv = n.value[c.channel] - k.value[c.channel];
            const dt = n.time - k.time;
            const h1 = [tx(k.time + cv[c.channel * 4] * dt), vy(k.value[c.channel] + cv[c.channel * 4 + 1] * dv)];
            const h2 = [tx(k.time + cv[c.channel * 4 + 2] * dt), vy(k.value[c.channel] + cv[c.channel * 4 + 3] * dv)];
            ctx.strokeStyle = 'rgba(255,255,255,0.45)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(h1[0], h1[1]);
            ctx.moveTo(tx(n.time), vy(n.value[c.channel]));
            ctx.lineTo(h2[0], h2[1]);
            ctx.stroke();
            ctx.fillStyle = c.color;
            for (const hp of [h1, h2]) {
              ctx.beginPath();
              ctx.arc(hp[0], hp[1], 4.5, 0, Math.PI * 2);
              ctx.fill();
              ctx.strokeStyle = token('--bg');
              ctx.stroke();
            }
          }
          ctx.fillStyle = sel ? token('--accent') : c.color;
          ctx.strokeStyle = token('--bg');
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.rect(x - 4.5, y - 4.5, 9, 9);
          ctx.fill();
          ctx.stroke();
        }
      }
      // playhead
      const px = Math.round(tx(ui.time)) + 0.5;
      ctx.strokeStyle = alpha('--animate', 0.9);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
      if (!visible().length) {
        ctx.fillStyle = alpha('--muted', 0.9);
        ctx.textAlign = 'center';
        ctx.font = '12px Inter Variable, system-ui, sans-serif';
        ctx.fillText(tr('Select keys or a keyed bone to edit its curves'), w / 2, h / 2);
        ctx.textAlign = 'start';
      }
    };

    const loop = drawWhenDirty(dirty, draw);
    paintNow = loop.now;

    const local = (e: { clientX: number; clientY: number }) => localPoint(e, canvas);

    const hit = (x: number, y: number): Drag | null => {
      const ui = uiStore.get();
      const selected = new Set(ui.selectedKeys);
      // handles first
      for (const c of visible()) {
        for (let i = 0; i < c.keys.length - 1; i++) {
          const k = c.keys[i];
          const n = c.keys[i + 1];
          if (!Array.isArray(k.curve) || !selected.has(encodeKey({ ...c.ref, time: k.time }))) continue;
          const dv = n.value[c.channel] - k.value[c.channel];
          const dt = n.time - k.time;
          const cv = k.curve;
          const hs: [number, number][] = [
            [tx(k.time + cv[c.channel * 4] * dt), vy(k.value[c.channel] + cv[c.channel * 4 + 1] * dv)],
            [tx(k.time + cv[c.channel * 4 + 2] * dt), vy(k.value[c.channel] + cv[c.channel * 4 + 3] * dv)],
          ];
          for (let hi = 0; hi < 2; hi++)
            if (Math.hypot(hs[hi][0] - x, hs[hi][1] - y) < 8) return { kind: 'handle', curve: c, keyIndex: i, handle: (hi + 1) as 1 | 2 };
        }
      }
      let best: Drag | null = null;
      let bd = 10;
      for (const c of visible()) {
        c.keys.forEach((k, i) => {
          const d = Math.hypot(tx(k.time) - x, vy(k.value[c.channel]) - y);
          if (d < bd) {
            bd = d;
            best = { kind: 'key', curve: c, keyIndex: i, anchorTime: k.time, ref: { ...c.ref, time: k.time }, grab: toTime(x) - k.time };
          }
        });
      }
      return best;
    };

    const onDown = (e: PointerEvent) => {
      const [x, y] = local(e);
      canvas.setPointerCapture(e.pointerId);
      if (e.button === 1 || e.altKey) {
        drag.current = { kind: 'pan', panY: e.clientY, vCenter: state.current.view.center };
        state.current.view.auto = false;
        return;
      }
      const hh = hit(x, y);
      if (hh?.kind === 'handle') {
        drag.current = hh;
        docStore.beginGesture('Edit curve');
        return;
      }
      if (hh?.kind === 'key' && hh.curve) {
        const ref: KeyRef = { ...hh.curve.ref, time: hh.curve.keys[hh.keyIndex!].time };
        const enc = encodeKey(ref);
        const cur = uiStore.get().selectedKeys;
        uiStore.patch({
          selectedKeys: e.shiftKey ? (cur.includes(enc) ? cur.filter((s) => s !== enc) : [...cur, enc]) : cur.includes(enc) ? cur : [enc],
        });
        drag.current = hh;
        docStore.beginGesture('Edit key');
        return;
      }
      if (!e.shiftKey) uiStore.patch({ selectedKeys: [] });
      drag.current = { kind: 'scrub' };
      setTime(toTime(x));
    };
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const [x, y] = local(e);
      if (d.kind === 'scrub') setTime(toTime(x));
      else if (d.kind === 'pan') state.current.view.center = (d.vCenter ?? 0) + (e.clientY - (d.panY ?? 0)) / state.current.view.scale;
      else if (d.kind === 'handle' && d.curve) {
        const c = d.curve;
        const k = c.keys[d.keyIndex!];
        const n = c.keys[d.keyIndex! + 1];
        const dt = n.time - k.time || 1;
        const dv = n.value[c.channel] - k.value[c.channel];
        const nx = (toTime(x) - k.time) / dt;
        const ny = Math.abs(dv) > 1e-6 ? (toValue(y) - k.value[c.channel]) / dv : nx;
        setKeyCurveHandle({ ...c.ref, time: k.time }, c.channel, d.handle!, nx, ny);
      } else if (d.kind === 'key' && d.curve && d.ref) {
        const c = d.curve;
        const fps = state.current.fps * keyGrid.steps;
        // `d.ref` follows the key: after the first move it no longer sits at the time the drag started
        const ref = d.ref;
        setKeyChannelValue(ref, c.channel, toValue(y));
        const target = Math.max(0, Math.round((toTime(x) - (d.grab ?? 0)) * fps) / fps);
        const delta = target - ref.time;
        if (Math.abs(delta) > 1e-6 && c.keys.length > 1) {
          const moved = moveKeysBy([ref], delta);
          if (moved[0]) {
            d.ref = moved[0];
            uiStore.patch({ selectedKeys: [encodeKey(moved[0])] });
          }
        }
      }
    };
    const onUp = () => {
      if (drag.current && (drag.current.kind === 'key' || drag.current.kind === 'handle')) docStore.endGesture();
      drag.current = null;
    };
    const onWheel = (e: WheelEvent) => {
      const ui = uiStore.get();
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const [x] = local(e);
        const t = toTime(x);
        const zoom = Math.min(3000, Math.max(20, ui.tlZoom * Math.exp(-e.deltaY * 0.0022)));
        uiStore.patch({ tlZoom: zoom, tlScroll: t - x / zoom });
      } else if (e.shiftKey) uiStore.patch({ tlScroll: ui.tlScroll + (e.deltaY + e.deltaX) / ui.tlZoom });
      else {
        state.current.view.auto = false;
        state.current.view.scale *= Math.exp(-e.deltaY * 0.0015);
        dirty.current = true;
      }
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      loop.stop();
      ro.disconnect();
      unsubs.forEach((u) => u());
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, []);

  useEffect(() => {
    dirty.current = true;
  });

  return (
    <>
      <div className="tl-labels">
        <div className="tl-labels-head" style={{ gap: 6 }}>
          Curves
          <span style={{ flex: 1 }} />
          <button
            className="btn ghost"
            style={{ height: 20, padding: '0 6px' }}
            onClick={() => ((state.current.view.auto = true), (dirty.current = true))}
            title="Fit values"
          >
            Fit
          </button>
        </div>
        <div className="tl-scroll">
          {curves.map((c) => (
            <div key={c.id} className="tl-label" style={{ height: 24, paddingLeft: 8 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: c.color, flex: 'none', opacity: hidden[c.id] ? 0.3 : 1 }} />
              <span className="lbl" style={{ opacity: hidden[c.id] ? 0.45 : 1 }}>
                {c.label}
              </span>
              <IconButton
                icon={hidden[c.id] ? EyeOff : Eye}
                title="Toggle curve"
                small
                onClick={() => setHidden((h) => ({ ...h, [c.id]: !h[c.id] }))}
              />
            </div>
          ))}
          {!curves.length && <div className="empty">Select keys in the dopesheet, or a bone that has keys.</div>}
        </div>
      </div>
      <div className="tl-canvas-wrap" data-learn="timeline">
        <div className="tl-ruler" style={{ cursor: 'default' }}>
          <GraphRuler />
        </div>
        <div className="tl-canvas-host" ref={hostRef} style={{ overflow: 'hidden' }}>
          <canvas ref={canvasRef} className="tl-canvas" />
        </div>
      </div>
      <span style={{ display: 'none' }}>{PAD_L}</span>
    </>
  );
}

/** Mini time ruler for graph mode (same scale as the dopesheet). */
function GraphRuler() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const host = canvas.parentElement!;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let dirty = true;
    let paintNow = () => {};
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(host.clientWidth * dpr);
      canvas.height = Math.round(28 * dpr);
      canvas.style.width = host.clientWidth + 'px';
      canvas.style.height = '28px';
      dirty = true;
      paintNow();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();
    const mark = () => {
      dirty = true;
    };
    const unsubs = [uiStore.subscribe(mark), docStore.subscribe(mark)];
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = host.clientWidth;
      const ui = uiStore.get();
      const fps = docStore.get().skeleton.fps;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = token('--tl-ruler');
      ctx.fillRect(0, 0, w, 28);
      const px = ui.tlZoom / fps;
      const step = [1, 2, 5, 10, 15, 30, 60, 120, 300].find((n) => n * px >= 54) ?? 600;
      ctx.font = '10.5px ui-monospace, Consolas, monospace';
      ctx.textBaseline = 'middle';
      for (let f = Math.floor((ui.tlScroll * fps) / step) * step; (f / fps - ui.tlScroll) * ui.tlZoom < w; f += step) {
        const x = Math.round((f / fps - ui.tlScroll) * ui.tlZoom) + 0.5;
        ctx.strokeStyle = 'rgba(255,255,255,0.28)';
        ctx.beginPath();
        ctx.moveTo(x, 28);
        ctx.lineTo(x, f % fps === 0 ? 8 : 14);
        ctx.stroke();
        ctx.fillStyle = f % fps === 0 ? token('--tl-label-strong') : token('--tl-label');
        ctx.fillText(f % fps === 0 ? `${f / fps}s` : String(f), x + 4, 11);
      }
      const x = (ui.time - ui.tlScroll) * ui.tlZoom;
      ctx.fillStyle = token('--animate');
      ctx.beginPath();
      ctx.moveTo(x - 6, 18);
      ctx.lineTo(x + 6, 18);
      ctx.lineTo(x, 28);
      ctx.fill();
      ctx.fillRect(x - 0.5, 0, 1, 18);
    };
    paintNow = () => {
      if (!dirty) return;
      dirty = false;
      draw();
    };
    const loop = () => {
      paintNow();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const scrub = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      setTime((e.clientX - r.left) / uiStore.get().tlZoom + uiStore.get().tlScroll);
    };
    let down = false;
    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      down = true;
      scrub(e);
    };
    const onMove = (e: PointerEvent) => down && scrub(e);
    const onUp = () => {
      down = false;
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      unsubs.forEach((u) => u());
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
    };
  }, []);
  return <canvas ref={ref} />;
}
