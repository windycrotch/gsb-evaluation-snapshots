/**
 * Frames from one file: a sprite sheet cut into a grid, or an animated GIF taken apart. The frames become numbered pictures
 * (sheet01, sheet02 …) and, when asked, a slot on the scene that plays them as a sequence.
 */
import { upsertKey } from '@/core/edit';
import { uid } from '@/core/ids';
import { cleanImageName } from '@/core/images';
import type { ImageRef } from '@/core/model';
import { cleanSequenceKey } from '@/core/sequence';
import { cellRects, framesToKeep, isBlankPixels, sheetSequence } from '@/core/spritesheet';
import type { SheetGrid } from '@/core/spritesheet';
import { currentAnimation } from './actions';
import { assets } from './assets';
import { docStore } from './doc';
import { placeSequences } from './sequenceActions';
import { toast, uiStore } from './ui';

export interface FramesOptions {
  /** The start of the picture names: frame k is `base` and the number. */
  base: string;
  /** Put the sequence on the scene as a slot. */
  scene: boolean;
  /** Seconds a frame stays: with it the sequence is keyed to loop from the start of the open animation (null: not keyed). */
  delay: number | null;
}

/**
 * Adds the frames as pictures named after `base` and (with `scene`) a slot that plays them. One step in the history. Returns the number of
 * frames added, 0 when something stood in the way (a name taken, nothing to add).
 */
export async function addFrames(blobs: Blob[], opts: FramesOptions): Promise<number> {
  const base = cleanImageName(opts.base);
  if (!base) {
    toast('A sequence needs a name', 'error');
    return 0;
  }
  if (!blobs.length) {
    toast('There are no frames to add', 'error');
    return 0;
  }
  const { names } = sheetSequence(base, blobs.length);
  const taken = names.find((n) => docStore.get().images.some((i) => i.name === n));
  if (taken) {
    toast(`A picture named "${taken}" already exists: choose another name`, 'error');
    return 0;
  }
  const refs: ImageRef[] = [];
  for (const [i, blob] of blobs.entries()) {
    const asset = await assets.decode(names[i], blob);
    assets.swap(names[i], asset);
    refs.push({ id: uid(), name: names[i], width: asset.width, height: asset.height });
  }
  docStore.beginGesture('Add frames');
  try {
    docStore.update('Add frames', (d) => {
      d.images.push(...refs);
    });
    if (opts.scene) {
      const cam = uiStore.get().camera;
      if (placeSequences(names, cam.x, cam.y, false) > 0 && opts.delay !== null) keyLoop(opts.delay);
    }
  } finally {
    docStore.endGesture();
  }
  toast(`Added ${blobs.length} frames`, 'ok');
  return blobs.length;
}

/** Keys the sequence of the selected slot to loop from the start of the open animation, at the given delay (nothing when no animation is open). */
function keyLoop(delay: number) {
  const anim = currentAnimation();
  const sel = uiStore.get().selection;
  if (!anim || !sel.slot || !sel.attachment) return;
  const slotId = sel.slot;
  const name = sel.attachment;
  docStore.update('Key sequence', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    const skin = d.skeleton.skins[0];
    const att = skin?.attachments[slotId]?.[name];
    if (!a || !skin || !att || (att.type !== 'region' && att.type !== 'mesh') || !att.sequence) return;
    const keys = ((((a.sequence ??= {})[skin.id] ??= {})[slotId] ??= {})[name] ??= []);
    upsertKey(keys, cleanSequenceKey({ time: 0, mode: 'loop', index: 0, delay }));
  });
}

export interface SliceOptions extends FramesOptions {
  grid: SheetGrid;
  /** Number the frames down the columns instead of along the rows. */
  byColumns: boolean;
  /** Leave out the empty cells at the end of the sheet. */
  dropBlank: boolean;
}

function canvasOf(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const toPng = (c: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode a frame'))), 'image/png'));

/** Cuts a picture of the project into the cells of a grid, each a picture of its own. Returns the number of frames made. */
export async function sliceSpriteSheet(sheet: string, o: SliceOptions): Promise<number> {
  const asset = assets.get(sheet);
  if (!asset) {
    toast('This picture has no pixels to cut', 'error');
    return 0;
  }
  const rects = cellRects(o.grid, o.byColumns).filter((r) => r.x + r.w <= asset.width && r.y + r.h <= asset.height);
  const canvases: HTMLCanvasElement[] = [];
  const blank: boolean[] = [];
  for (const r of rects) {
    const c = canvasOf(r.w, r.h);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2d canvas');
    ctx.drawImage(asset.bitmap, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    canvases.push(c);
    blank.push(isBlankPixels(ctx.getImageData(0, 0, r.w, r.h).data));
  }
  const keep = o.dropBlank ? framesToKeep(blank) : canvases.length;
  if (keep === 0) {
    toast('Every cell is empty', 'error');
    return 0;
  }
  return addFrames(await Promise.all(canvases.slice(0, keep).map(toPng)), o);
}

/** Whether this browser can take an animated GIF apart (the WebCodecs image decoder). */
export const canReadGif = (): boolean => typeof (globalThis as { ImageDecoder?: unknown }).ImageDecoder !== 'undefined';

interface GifFrame {
  image: { displayWidth: number; displayHeight: number; duration: number | null; close(): void };
}
interface GifDecoder {
  tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null };
  decode(o: { frameIndex: number }): Promise<GifFrame>;
  close(): void;
}

/**
 * Takes an animated GIF apart: every frame becomes a picture, and the delay of the frames (their average) is the delay of the sequence.
 * Returns the number of frames, 0 when the file has a single picture or this browser cannot read GIF frames.
 */
export async function importGif(file: File, opts: { base?: string; scene: boolean }): Promise<number> {
  const Decoder = (globalThis as unknown as { ImageDecoder?: new (init: { data: ArrayBuffer; type: string }) => GifDecoder }).ImageDecoder;
  if (!Decoder) {
    toast('This browser cannot take a GIF apart: cut a sprite sheet instead', 'error');
    return 0;
  }
  const decoder = new Decoder({ data: await file.arrayBuffer(), type: 'image/gif' });
  try {
    await decoder.tracks.ready;
    const count = decoder.tracks.selectedTrack?.frameCount ?? 0;
    if (count < 2) {
      toast('This GIF has one picture: import it as an image', 'info');
      return 0;
    }
    const blobs: Blob[] = [];
    let total = 0;
    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      const c = canvasOf(image.displayWidth, image.displayHeight);
      c.getContext('2d')!.drawImage(image as unknown as CanvasImageSource, 0, 0);
      total += (image.duration ?? 100000) / 1e6;
      image.close();
      blobs.push(await toPng(c));
    }
    return await addFrames(blobs, {
      base: opts.base ?? file.name.replace(/\.[^.]+$/, ''),
      scene: opts.scene,
      delay: Math.round((total / count) * 1000) / 1000,
    });
  } finally {
    decoder.close();
  }
}
