import { uid, uniqueName } from '@/core/ids';
import type { ImageRef } from '@/core/model';

/** Image pixel data lives outside the (immutable) document; attachments refer to images by name. */
export interface ImageAsset {
  name: string;
  width: number;
  height: number;
  blob: Blob;
  bitmap: ImageBitmap;
  /** Changes whenever the pixels behind `name` change (texture re-upload). */
  version: number;
}

let assetCounter = 0;

class AssetRegistry {
  private map = new Map<string, ImageAsset>();
  /** Bumps whenever the set of images changes (renderer reuploads textures). */
  version = 0;
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private emit() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  get(name: string): ImageAsset | undefined {
    return this.map.get(name);
  }
  has(name: string) {
    return this.map.has(name);
  }
  names(): string[] {
    return [...this.map.keys()];
  }

  async addFile(file: File | Blob, suggestedName?: string): Promise<ImageRef> {
    const base = (suggestedName ?? (file instanceof File ? file.name : 'image')).replace(/\.[^.]+$/, '').trim() || 'image';
    const name = uniqueName(base, this.map.keys());
    const bitmap = await createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const asset: ImageAsset = { name, width: bitmap.width, height: bitmap.height, blob: file, bitmap, version: ++assetCounter };
    this.map.set(name, asset);
    this.emit();
    return { id: uid(), name, width: asset.width, height: asset.height };
  }

  /** Decodes an image without registering it (project load decodes everything first, then swaps the whole set). */
  async decode(name: string, blob: Blob): Promise<ImageAsset> {
    const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    return { name, width: bitmap.width, height: bitmap.height, blob, bitmap, version: ++assetCounter };
  }

  /** Replaces every image at once (open project). */
  replaceAll(list: ImageAsset[]) {
    for (const a of this.map.values()) a.bitmap.close?.();
    this.map = new Map(list.map((a) => [a.name, a] as const));
    this.emit();
  }

  remove(name: string) {
    const a = this.map.get(name);
    if (!a) return;
    // a renamed image is kept under both names (so undo and redo find their pixels): the bitmap is shared, close it with the last one
    if (![...this.map.values()].some((o) => o !== a && o.bitmap === a.bitmap)) a.bitmap.close?.();
    this.map.delete(name);
    this.emit();
  }

  /** Makes the pixels of `from` available under `to` as well (renaming an image; the old name stays for undo). */
  alias(from: string, to: string) {
    const a = this.map.get(from);
    if (!a || this.map.has(to)) return;
    this.map.set(to, { ...a, name: to });
    this.emit();
  }

  /** Puts new pixels behind a name (replace image). The version changes, so textures are uploaded again. */
  set(name: string, asset: ImageAsset) {
    const old = this.map.get(name);
    if (old && ![...this.map.values()].some((o) => o !== old && o.bitmap === old.bitmap)) old.bitmap.close?.();
    this.map.set(name, { ...asset, name });
    this.emit();
  }

  /**
   * Puts an asset (or nothing) behind a name without closing the bitmap it replaces: undo and redo of a replaced picture swap the
   * pixels back and forth, so both sets must stay alive.
   */
  swap(name: string, asset: ImageAsset | undefined) {
    if (asset) this.map.set(name, asset);
    else this.map.delete(name);
    this.emit();
  }

  clear() {
    for (const a of this.map.values()) a.bitmap.close?.();
    this.map.clear();
    this.emit();
  }

  /** Reads pixels (for tracing). */
  getImageData(name: string): ImageData | null {
    const a = this.map.get(name);
    if (!a) return null;
    const c = document.createElement('canvas');
    c.width = a.width;
    c.height = a.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(a.bitmap, 0, 0);
    return ctx.getImageData(0, 0, a.width, a.height);
  }
}

export const assets = new AssetRegistry();

export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error('Could not read the file'));
    r.readAsDataURL(blob);
  });
}

/**
 * A data URL as a Blob. Decoded here, not with `fetch(url)`: fetch copies the whole text through the network stack on the main thread
 * (about 80 ms for a 5 MB picture, so a rig of twenty pictures froze the editor for two seconds while it opened).
 */
function decodeDataURL(url: string): Blob {
  const comma = url.indexOf(',');
  if (!url.startsWith('data:') || comma < 0) throw new Error('Not a data URL');
  const head = url.slice(5, comma);
  const mime = head.split(';')[0] || 'application/octet-stream';
  const body = url.slice(comma + 1);
  if (!head.endsWith(';base64')) return new Blob([decodeURIComponent(body)], { type: mime });
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function dataURLToBlob(url: string): Promise<Blob> {
  try {
    return Promise.resolve(decodeDataURL(url));
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
}
