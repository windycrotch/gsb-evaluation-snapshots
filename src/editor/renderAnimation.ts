/**
 * Renders an animation to pictures: the frames of a GIF, a PNG sequence or a video. The skeleton is posed and drawn exactly as the viewport does it
 * (same solver, same physics stepping, same renderer), into a canvas of its own; the picture is cropped to the bounds of the whole animation.
 */
import { makePoser } from '@/core/framepose';
import type { Animation, Id, SkeletonDoc } from '@/core/model';
import { compileSkeleton, createSkeleton } from '@/core/skeleton';
import type { Skeleton } from '@/core/skeleton';
import { GLRenderer } from '@/render/gl';
import { assets } from '@/store/assets';
import { canvasToBlob } from './ui/canvas';

export interface RenderOptions {
  doc: SkeletonDoc;
  animation: Animation;
  skinId?: Id | null;
  fps: number;
  /** Pixels per unit of the skeleton. */
  scale: number;
  /** Empty border around the animation's bounds, in output pixels. */
  padding: number;
  /** Background color (r g b in 0..1); null keeps it transparent. */
  background: [number, number, number] | null;
  /** The frames rendered: from the first (default 0) up to, not including, the last (default: all). */
  from?: number;
  to?: number;
  /** Seconds the animation runs before the first frame, so the physics has settled (as if it had been looping). */
  warmUp?: number;
}

export interface Prepared {
  width: number;
  height: number;
  /** Number of frames: the animation without its last instant (it is the first one again in a loop). */
  count: number;
  fps: number;
  /** The picture of frame `i`; the canvas is reused, so copy what you need before asking for the next one. */
  frame(i: number): ImageData;
  dispose(): void;
}

const MAX_SIDE = 4096;

/** The number of frames of an animation at `fps`. */
export const frameCount = (duration: number, fps: number) => Math.max(1, Math.round(duration * fps));

export function prepareRender(opts: RenderOptions): Prepared {
  const { animation: anim, fps } = opts;
  const data = compileSkeleton(opts.doc);
  const skeleton: Skeleton = createSkeleton(data, opts.skinId ?? null);
  const hasPhysics = data.constraints.some((c) => c.kind === 'physics');
  const total = frameCount(anim.duration, fps);
  // the range of frames asked for (clamped, at least one frame)
  const first = Math.max(0, Math.min(total - 1, Math.floor(opts.from ?? 0)));
  const count = Math.max(1, Math.min(total, Math.floor(opts.to ?? total)) - first);

  // posing runs forward: physics keeps its state from the frame before
  const { pose: poseFrame } = makePoser(skeleton, anim, fps, hasPhysics, opts.warmUp ?? 0);
  const pose = (i: number) => poseFrame(first + i);

  // the bounds of the whole animation, so every frame has the same size and the character does not jump about
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    pose(i);
    const b = skeleton.getBounds();
    if (!b) continue;
    minX = Math.min(minX, b[0]);
    minY = Math.min(minY, b[1]);
    maxX = Math.max(maxX, b[0] + b[2]);
    maxY = Math.max(maxY, b[1] + b[3]);
  }
  if (minX === Infinity) {
    minX = -50;
    minY = -50;
    maxX = 50;
    maxY = 50;
  }
  const pad = Math.max(0, opts.padding);
  let scale = opts.scale;
  const side = (v: number) => Math.ceil((v - 0) * scale + pad * 2);
  while ((side(maxX - minX) > MAX_SIDE || side(maxY - minY) > MAX_SIDE) && scale > 0.01) scale *= 0.9;
  const width = Math.max(1, side(maxX - minX));
  const height = Math.max(1, side(maxY - minY));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const renderer = new GLRenderer(canvas, { alpha: true, preserveDrawingBuffer: true });
  renderer.source = {
    get: (name) => {
      const a = assets.get(name);
      return a ? { bitmap: a.bitmap, version: a.version } : null;
    },
  };
  const copy = document.createElement('canvas');
  copy.width = width;
  copy.height = height;
  const ctx = copy.getContext('2d', { willReadFrequently: true })!;
  const cam = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, scale, width, height };
  const bg = opts.background;

  return {
    width,
    height,
    count,
    fps,
    frame(i) {
      pose(Math.min(count - 1, Math.max(0, i)));
      renderer.begin(cam, bg ? [bg[0], bg[1], bg[2], 1] : [0, 0, 0, 0]);
      renderer.drawSkeleton(skeleton);
      renderer.end();
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(canvas, 0, 0);
      return ctx.getImageData(0, 0, width, height);
    },
    dispose() {
      renderer.dispose();
    },
  };
}

const blobBytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

/** A PNG of one frame. */
export function frameToPng(image: ImageData): Promise<Uint8Array> {
  const c = document.createElement('canvas');
  c.width = image.width;
  c.height = image.height;
  c.getContext('2d')!.putImageData(image, 0, 0);
  return canvasToBlob(c).then(blobBytes);
}

/** A JPEG of one frame (it has no transparency: the frame has to be drawn on a solid background). */
export function frameToJpeg(image: ImageData, quality = 0.92): Promise<Uint8Array> {
  const c = document.createElement('canvas');
  c.width = image.width;
  c.height = image.height;
  c.getContext('2d')!.putImageData(image, 0, 0);
  return canvasToBlob(c, 'image/jpeg', quality).then(blobBytes);
}

/** A WebM video of the frames, recorded in real time from a canvas (the browser's encoder). */
export async function framesToWebm(prepared: Prepared, onProgress: (done: number) => void, cancelled: () => boolean): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = prepared.width;
  c.height = prepared.height;
  const ctx = c.getContext('2d')!;
  const stream = c.captureStream(0);
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error('This browser cannot record WebM video');
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
  rec.start();
  for (let i = 0; i < prepared.count && !cancelled(); i++) {
    ctx.putImageData(prepared.frame(i), 0, 0);
    track.requestFrame?.();
    onProgress(i + 1);
    await new Promise((r) => setTimeout(r, 1000 / prepared.fps));
  }
  rec.stop();
  await stopped;
  return new Blob(chunks, { type: 'video/webm' });
}
