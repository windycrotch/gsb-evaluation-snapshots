import { settingsStore } from '@/store/settings';
import { useEffect, useRef } from 'react';
import { GLRenderer } from '@/render/gl';
import { addImageToScene, importDropped } from '@/store/actions';
import { placeSequences } from '@/store/sequenceActions';
import { assets } from '@/store/assets';
import { docStore } from '@/store/doc';
import { toast, uiStore } from '@/store/ui';
import { getScene, screenToWorld } from '@/store/scene';
import { checkpointStore } from '@/store/checkpoints';
import { checkpointGhost, ghostsFor, motionArrows, referenceGhost } from '../ghosts';
import { ViewportController } from './controller';
import { drawMotionArrows, drawOverlay } from './overlay';
import { fpsMeter } from './fps';
import { Breadcrumbs } from './Breadcrumbs';
import { OutlineMap } from './OutlineMap';
import { ReferenceVideo } from './ReferenceVideo';
import { useUi } from '@/store/ui';

export const viewportApi: {
  controller: ViewportController | null;
  frame: () => void;
  frameSelection: () => void;
  zoom100: () => void;
  size: () => [number, number];
} = {
  controller: null,
  frame: () => {},
  frameSelection: () => {},
  zoom100: () => {},
  size: () => [800, 600],
};

export function Viewport() {
  const hostRef = useRef<HTMLDivElement>(null);
  const glRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const outline = useUi((s) => s.view.outline);

  useEffect(() => {
    const host = hostRef.current!;
    const glCanvas = glRef.current!;
    const overlay = overlayRef.current!;
    let renderer: GLRenderer | null = null;
    try {
      renderer = new GLRenderer(glCanvas);
    } catch (e) {
      toast(String((e as Error).message), 'error');
      return;
    }
    renderer.source = {
      get: (name) => {
        const a = assets.get(name);
        return a ? { bitmap: a.bitmap, version: a.version } : null;
      },
    };
    const ctx = overlay.getContext('2d')!;
    const controller = new ViewportController(host, () => {
      dirty = true;
    });
    controller.attach();
    viewportApi.controller = controller;

    let dirty = true;
    let raf = 0;
    let lastW = 0;
    let lastH = 0;
    let lastDpr = 0;
    let ready = false;
    let paintNow = () => {};

    const invalidate = () => {
      dirty = true;
    };
    const unsubs = [docStore.subscribe(invalidate), uiStore.subscribe(invalidate), assets.subscribe(invalidate)];

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w === lastW && h === lastH && dpr === lastDpr) return;
      lastW = w;
      lastH = h;
      lastDpr = dpr;
      for (const c of [glCanvas, overlay]) {
        c.width = Math.max(1, Math.round(w * dpr));
        c.height = Math.max(1, Math.round(h * dpr));
        c.style.width = w + 'px';
        c.style.height = h + 'px';
      }
      dirty = true;
      // Setting a canvas size wipes it. Painting again right here, in the same frame, keeps the viewport from blinking black while a
      // panel is dragged (the loop below would only repaint it in the next frame, after the browser has shown the empty one).
      if (ready) paintNow();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    viewportApi.size = () => [host.clientWidth, host.clientHeight];
    /** Puts the camera over the skeleton, or over the bones in `only` (and the skeleton's bounds only when it is the whole skeleton). */
    const frameBones = (only?: ReadonlySet<number>) => {
      const scene = getScene();
      const b = only ? null : scene.skeleton.getBounds();
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      if (b) {
        minX = b[0];
        minY = b[1];
        maxX = b[0] + b[2];
        maxY = b[1] + b[3];
      }
      for (const bone of scene.skeleton.bones) {
        if (only && !only.has(bone.data.index)) continue;
        for (const [x, y] of [
          [bone.worldX, bone.worldY],
          [bone.tipX, bone.tipY],
        ]) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
      if (!isFinite(minX)) return;
      const w = Math.max(host.clientWidth, 100);
      const h = Math.max(host.clientHeight, 100);
      const pad = 80;
      const zoom = Math.min((w - pad * 2) / Math.max(maxX - minX, 40), (h - pad * 2) / Math.max(maxY - minY, 40), 4);
      uiStore.patch({ camera: { ...uiStore.get().camera, x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom: Math.max(0.05, zoom) } });
    };
    viewportApi.frame = () => frameBones();
    // the selected bones (and the bone of the selected slot); without a selection it is the same as framing the whole skeleton
    viewportApi.frameSelection = () => {
      const scene = getScene();
      const sel = uiStore.get().selection;
      const ids = new Set(sel.bones);
      const slot = sel.slot ? scene.skeleton.slotById(sel.slot) : null;
      if (slot) ids.add(slot.bone.data.id);
      const indices = new Set<number>();
      for (const bone of scene.skeleton.bones) if (ids.has(bone.data.id)) indices.add(bone.data.index);
      frameBones(indices.size ? indices : undefined);
    };
    // one scene unit per pixel of the screen (the size the pictures were made at)
    viewportApi.zoom100 = () => uiStore.patch({ camera: { ...uiStore.get().camera, zoom: 1 } });

    const draw = () => {
      const t0 = performance.now();
      const ui = uiStore.get();
      const dpr = window.devicePixelRatio || 1;
      const w = host.clientWidth;
      const h = host.clientHeight;
      const scene = getScene();
      const doc = docStore.get().skeleton;
      const hiddenSlots = new Set(doc.slots.filter((s) => s.hidden).map((s) => s.id));
      const hiddenBones = new Set(doc.bones.filter((b) => b.hidden).map((b) => b.id));
      const prefs = settingsStore.get();
      renderer.setSmoothing(prefs.smoothing);
      renderer.begin(
        {
          x: ui.camera.x,
          y: ui.camera.y,
          scale: ui.camera.zoom * dpr,
          width: glCanvas.width,
          height: glCanvas.height,
          flip: !!ui.camera.flip,
        },
        [...prefs.viewportBg, 1],
      );
      const onionOn = ui.view.onion && ui.mode === 'animate' && scene.animation;
      const onion = onionOn
        ? ghostsFor(
            scene,
            scene.animation!,
            ui.time,
            doc.fps,
            {
              before: prefs.onionBefore,
              after: prefs.onionAfter,
              gap: prefs.onionGap,
              mode: prefs.onionMode,
              offsetX: prefs.onionOffsetX,
              offsetY: prefs.onionOffsetY,
              style: prefs.onionStyle,
              top: prefs.onionTop,
              colorBefore: prefs.onionColorBefore,
              colorAfter: prefs.onionColorAfter,
            },
            ui.loop,
            ui.skinId,
            ui.selection.bones.length ? { bones: ui.selection.bones, slots: ui.selection.slot ? [ui.selection.slot] : [] } : null,
          )
        : [];
      const drawGhost = (g: (typeof onion)[number]) =>
        renderer.drawSkeleton(g.skeleton, {
          skip: (s) => hiddenSlots.has(s.data.id),
          alpha: g.alpha,
          tint: g.tint,
          flat: g.flat,
          offset: g.offset,
        });
      for (const g of onion) if (!g.top) drawGhost(g);
      if (ui.reference) {
        // the reference (another animation or the setup pose) under the pose being edited
        const other = ui.reference === 'setup' ? null : doc.animations.find((a) => a.id === ui.reference);
        if (ui.reference === 'setup' || other) {
          const g = referenceGhost(scene, other ?? null, ui.mode === 'animate' ? ui.time : 0, ui.loop, ui.skinId);
          renderer.drawSkeleton(g.skeleton, { skip: (s) => hiddenSlots.has(s.data.id), alpha: g.alpha, tint: g.tint });
        }
      }
      if (ui.compare) {
        // a checkpoint: the pose the skeleton had when it was marked, in the same animation at the same time
        const cp = checkpointStore.get().list.find((c) => c.id === ui.compare);
        if (cp) {
          try {
            const g = checkpointGhost(
              cp.skeleton,
              ui.mode === 'animate' ? ui.animationId : null,
              ui.mode === 'animate' ? ui.time : 0,
              ui.loop,
              ui.skinId,
            );
            if (g) renderer.drawSkeleton(g.skeleton, { skip: (s) => hiddenSlots.has(s.data.id), alpha: g.alpha, tint: g.tint });
          } catch (e) {
            console.error(e);
          }
        }
      }
      if (ui.view.images) renderer.drawSkeleton(scene.skeleton, { skip: (s) => hiddenSlots.has(s.data.id) });
      for (const g of onion) if (g.top) drawGhost(g);
      controller.meshTool.drawHeat(renderer, scene);
      renderer.end();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawOverlay({
        ctx,
        w,
        h,
        cam: ui.camera,
        scene,
        ui,
        hoverBone: controller.hoverBone,
        hiddenBones,
        hiddenSlots,
        interaction: controller.interaction,
        under: (o) => {
          controller.pathTool.drawUnder(o);
          controller.polygonTool.drawUnder(o);
        },
        extra: controller.meshTool.drawOverlay,
      });
      if (prefs.onionArrows && onion.length && ui.selection.bones.length)
        drawMotionArrows(
          ctx,
          w,
          h,
          ui.camera,
          motionArrows(scene.skeleton, onion, ui.selection.bones),
          prefs.onionColorBefore,
          prefs.onionColorAfter,
        );
      const t1 = performance.now();
      fpsMeter.tick(t1, t1 - t0);
    };

    paintNow = () => {
      if (!dirty) return;
      dirty = false;
      try {
        draw();
      } catch (e) {
        console.error(e);
      }
    };
    ready = true;
    const loop = () => {
      paintNow();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    // first-open framing, and re-framing on request (demo rig / new project)
    setTimeout(() => viewportApi.frame(), 30);
    const onFrame = () => setTimeout(() => viewportApi.frame(), 40);
    window.addEventListener('bone2d:frame', onFrame);

    return () => {
      window.removeEventListener('bone2d:frame', onFrame);
      cancelAnimationFrame(raf);
      ro.disconnect();
      unsubs.forEach((u) => u());
      controller.detach();
      viewportApi.controller = null;
      renderer?.dispose();
    };
  }, []);

  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/x-bone2d-image')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const host = hostRef.current!;
    const r = host.getBoundingClientRect();
    const [wx, wy] = screenToWorld(uiStore.get().camera, host.clientWidth, host.clientHeight, e.clientX - r.left, e.clientY - r.top);
    const imageName = e.dataTransfer.getData('application/x-bone2d-image');
    if (imageName) {
      addImageToScene(imageName, wx, wy);
      return;
    }
    if (!e.dataTransfer.files.length) return;
    const { names, folder } = await importDropped(e.dataTransfer);
    // a folder of pictures goes to the Images window, not onto the scene as slots; numbered series in it (frame01…) become one slot with a sequence each
    if (folder) {
      placeSequences(names, wx, wy);
      return;
    }
    let off = 0;
    for (const n of names) {
      addImageToScene(n, wx + off, wy - off);
      off += 24;
    }
  };

  return (
    <div ref={hostRef} className="viewport" tabIndex={0} onDragOver={onDragOver} onDrop={onDrop}>
      <canvas ref={glRef} className="vp-canvas" />
      <ReferenceVideo />
      <canvas ref={overlayRef} className="vp-canvas vp-overlay" />
      <Breadcrumbs />
      {outline && <OutlineMap host={hostRef} />}
    </div>
  );
}
