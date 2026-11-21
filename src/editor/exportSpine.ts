/** Builds a Spine 4.3 export bundle: skeleton JSON + texture atlas (.atlas + PNG pages), zipped. */
import { jsonToBinary } from '@/core/export/spineBinary';
import { scaleSpineJson } from '@/core/export/scale';
import { exportSpineJson } from '@/core/export/spineJson';
import { withCleanAnimations } from '@/core/cleanup';
import { composePage, packAtlas, premultiplyAlpha, writeAtlas } from '@/core/export/atlas';
import { findAliases, makeRegion, scaledSize, skinAtlasGroups, usedImages } from '@/core/export/atlasBuild';
import type { AtlasFilter, AtlasPage, PackInput } from '@/core/export/atlas';
import { mixesToText } from '@/core/export/mixes';
import { createZip } from '@/core/export/zip';
import { activeIndex, skeletonList } from '@/core/skeletons';
import type { ZipEntry } from '@/core/export/zip';
import { assets } from '@/store/assets';
import { docStore } from '@/store/doc';
import { canvasToBlob } from './ui/canvas';

export interface ExportOptions {
  /** The skeleton file: Spine JSON, or the smaller binary .skel. */
  format?: 'json' | 'binary';
  /** Size of the export relative to the project: 0.5 makes half-size pictures and a skeleton to match. */
  scale?: number;
  maxSize: number;
  padding: number;
  pretty: boolean;
  nonessential: boolean;
  /** Power-of-two atlas pages (older GPUs and some engines want them). */
  pot?: boolean;
  /** Cut the empty border off every picture (not those a mesh uses); the atlas file tells the runtime where it was. */
  trim?: boolean;
  /** Turn a picture a quarter turn on the page when it fits better. */
  rotate?: boolean;
  /** How the engine should smooth the atlas: Linear, or Nearest for pixel art. */
  filter?: AtlasFilter;
  /** Write the mix table of the skeleton as a JSON file for the game. */
  includeMixes?: boolean;
  /** Write the single-file preview page that plays the export. */
  includePreview?: boolean;
  /** Premultiplied alpha pages. */
  pma?: boolean;
  /** Pages as wide as they are tall. */
  square?: boolean;
  /** Identical pictures share one place in the atlas. */
  alias?: boolean;
  /** Page sizes divisible by four (without power of two). */
  multipleOf4?: boolean;
  /** Take the keys that change nothing out of the exported animations. */
  cleanUp?: boolean;
  /** An atlas for the default skin and one for each other skin (see `skinAtlasGroups`). */
  atlasPerSkin?: boolean;
  /** Write `alpha` / `rgb` timelines where only that part of a colour changes. */
  splitColor?: boolean;
  /** Which skeleton of the project (index in its list; default: the edited one). */
  skeletonIndex?: number;
  /** Animations left out of the export (an animation a slider uses always stays). */
  excludeAnimations?: string[];
  baseName?: string;
}

export interface ExportResult {
  zip: Uint8Array;
  files: { name: string; size: number }[];
  /** The files themselves, as they are in the zip. */
  entries: ZipEntry[];
  pages: number;
  missing: string[];
  json: unknown;
  /** Self-contained preview page (official Spine player). */
  preview?: string;
}

/** The picture at the size it is exported at (a smaller one is drawn from the full picture with smoothing), as straight RGBA. */
function scaledPixels(name: string, w: number, h: number): ImageData {
  const img = assets.get(name)!.bitmap;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const resized = w !== img.width || h !== img.height;
  ctx.imageSmoothingEnabled = resized;
  if (resized) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

async function pageToPng(page: AtlasPage, pixels: Map<string, Uint8ClampedArray>, padding: number, pma = false): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = page.width;
  canvas.height = page.height;
  const ctx = canvas.getContext('2d')!;
  const data = composePage(page, (n) => (pixels.has(n) ? { data: pixels.get(n)! } : undefined), padding);
  if (pma) premultiplyAlpha(data);
  ctx.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, page.width, page.height), 0, 0);
  const blob = await canvasToBlob(canvas);
  return new Uint8Array(await blob.arrayBuffer());
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

/** A single-file preview page using the official Spine 4.3 web player (script from a CDN, data embedded as data URIs). */
function previewHtml(
  base: string,
  skeleton: { file: string; data: Uint8Array; binary: boolean },
  atlas: string,
  pngs: { name: string; data: Uint8Array }[],
  animation: string | null,
  title: string,
  pma = false,
): string {
  const utf8 = (s: string) => bytesToBase64(new TextEncoder().encode(s));
  const uris: Record<string, string> = {
    [skeleton.file]: `data:${skeleton.binary ? 'application/octet-stream' : 'application/json'};base64,${bytesToBase64(skeleton.data)}`,
    [`${base}.atlas`]: `data:text/plain;base64,${utf8(atlas)}`,
  };
  for (const p of pngs) uris[p.name] = `data:image/png;base64,${bytesToBase64(p.data)}`;
  const V = '4.3.13';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title.replace(/[<&]/g, '')} — Spine ${V} preview</title>
<link rel="stylesheet" href="https://unpkg.com/@esotericsoftware/spine-player@${V}/dist/spine-player.css">
<script src="https://unpkg.com/@esotericsoftware/spine-player@${V}/dist/iife/spine-player.js"></script>
<style>html,body{height:100%;margin:0;background:#0d0f13;font-family:system-ui,sans-serif;color:#aab1be}#player{width:100%;height:100%}</style>
</head><body><div id="player"></div>
<script>
// Exported by Bone 2D. Rendered by the OFFICIAL Spine runtime — if it plays here, it plays in your engine.
new spine.SpinePlayer("player", {
  ${skeleton.binary ? 'binary' : 'skeleton'}: ${JSON.stringify(skeleton.file)},
  atlas: ${JSON.stringify(`${base}.atlas`)},
  rawDataURIs: ${JSON.stringify(uris)},
  ${animation ? `animation: ${JSON.stringify(animation)},` : ''}
  premultipliedAlpha: ${pma},
  showControls: true,
  backgroundColor: "#13161c"
});
</script></body></html>`;
}

export async function buildSpineExport(opts: ExportOptions): Promise<ExportResult> {
  const project = docStore.get();
  const full = skeletonList(project)[opts.skeletonIndex ?? activeIndex(project)] ?? project.skeleton;
  const keep = new Set(full.constraints.flatMap((c) => (c.type === 'slider' && c.animation ? [c.animation] : [])));
  const doc = opts.excludeAnimations?.length
    ? { ...full, animations: full.animations.filter((a) => keep.has(a.id) || !opts.excludeAnimations!.includes(a.id)) }
    : full;
  const base = (opts.baseName ?? doc.name ?? 'skeleton').replace(/[^\w-]+/g, '_') || 'skeleton';
  const images = usedImages(full);
  const missing = images.filter((i) => !assets.has(i.name)).map((i) => i.name);
  const scale = opts.scale && opts.scale > 0 ? opts.scale : 1;
  // the pixels of every region (the part of the picture that is packed) and what the packer is told about them
  const pixels = new Map<string, Uint8ClampedArray>();
  const inputs: PackInput[] = [];
  for (const { name, mesh } of images) {
    const a = assets.get(name);
    if (!a) continue;
    const [width, height] = scaledSize(a.width, a.height, scale);
    const region = makeRegion(name, mesh, width, height, scaledPixels(name, width, height).data, !!opts.trim);
    pixels.set(name, region.pixels);
    inputs.push(region.input);
  }

  const enc = new TextEncoder();
  const files: ZipEntry[] = [];
  const binary = opts.format === 'binary';
  const json = scaleSpineJson(
    exportSpineJson(opts.cleanUp ? withCleanAnimations(doc) : doc, {
      nonessential: opts.nonessential,
      imagesPath: './images/',
      splitColor: opts.splitColor,
    }),
    scale,
  );
  const skeletonFile = binary ? `${base}.skel` : `${base}.json`;
  const skeletonData = binary ? jsonToBinary(json) : enc.encode(JSON.stringify(json, null, opts.pretty ? 2 : 0));
  files.push({ name: skeletonFile, data: skeletonData });

  let pages: AtlasPage[] = [];
  let preview: string | undefined;
  // one atlas, or (atlas per skin) one for the default skin and one for each other skin
  const perSkin = !!opts.atlasPerSkin && full.skins.length > 1;
  const groups = perSkin ? skinAtlasGroups(full, base) : [{ skinId: '', stem: base, names: inputs.map((i) => i.name) }];
  const atlasFiles: string[] = [];
  if (inputs.length) {
    const atlasTexts: string[] = [];
    const pngs: { name: string; data: Uint8Array }[] = [];
    for (const group of groups) {
      const wanted = new Set(group.names);
      const part = inputs.filter((i) => wanted.has(i.name));
      if (!part.length) continue;
      if (opts.alias) {
        const aliases = findAliases(
          part.map((i) => ({
            name: i.name,
            width: i.width,
            height: i.height,
            data: pixels.get(i.name)!,
            extra: `${i.offsetX ?? 0},${i.offsetY ?? 0},${i.originalWidth ?? i.width},${i.originalHeight ?? i.height}`,
          })),
        );
        for (const i of part) if (aliases.has(i.name)) i.aliasOf = aliases.get(i.name);
      }
      const groupPages = packAtlas(part, {
        maxSize: opts.maxSize,
        padding: opts.padding,
        pot: opts.pot ?? true,
        rotate: opts.rotate ?? false,
        square: opts.square ?? false,
        multipleOf4: opts.multipleOf4 ?? false,
      });
      pages = pages.concat(groupPages);
      const pageFile = (i: number) => (groupPages.length === 1 ? `${group.stem}.png` : `${group.stem}-${i + 1}.png`);
      const text = writeAtlas(groupPages, pageFile, { pma: !!opts.pma, filter: opts.filter ?? 'Linear' });
      atlasTexts.push(text);
      atlasFiles.push(`${group.stem}.atlas`);
      files.push({ name: `${group.stem}.atlas`, data: enc.encode(text) });
      for (const p of groupPages) {
        const data = await pageToPng(p, pixels, opts.padding, !!opts.pma);
        pngs.push({ name: pageFile(p.index), data });
        files.push({ name: pageFile(p.index), data });
      }
    }
    // the preview plays the whole skeleton: all the atlases in one file (an atlas file may hold any number of pages)
    const atlasText = atlasTexts.join('\n');
    if (opts.includePreview ?? true) {
      const firstAnim = doc.animations[0]?.name ?? null;
      preview = previewHtml(
        base,
        { file: skeletonFile, data: skeletonData, binary },
        atlasText,
        pngs,
        firstAnim,
        doc.name || base,
        !!opts.pma,
      );
      files.push({ name: `${base}-preview.html`, data: enc.encode(preview) });
    }
  }
  // the mix table belongs to the edited skeleton (project.mixes) or waits in the aside of another one
  const mixText =
    opts.includeMixes === false ? null : mixesToText(doc.animations, full === project.skeleton ? project.mixes : full.aside?.mixes);
  if (mixText) files.push({ name: `${base}.mixes.json`, data: enc.encode(mixText) });
  files.push({
    name: 'README.txt',
    data: enc.encode(
      `Exported from Bone 2D.\n\n${skeletonFile.padEnd(base.length + 5)}  Spine 4.3 skeleton data (${binary ? 'binary' : 'JSON'})\n${atlasFiles.length > 1 ? `${atlasFiles.join(', ')}  texture atlases, one for the default skin and one for each other skin (load the default one and the one of the skin you show; ${opts.pma ? 'premultiplied alpha, pma:true' : 'straight alpha, pma:false'})` : `${base}.atlas         texture atlas (${opts.pma ? 'premultiplied alpha, pma:true' : 'straight alpha, pma:false'})`}\n${base}-preview.html  open in a browser: plays the animations with the official Spine 4.3 web player (needs internet for the player script)\n${mixText ? `${base}.mixes.json  crossfade times between animations (defaultMix and setMix of AnimationStateData)\n` : ''}\nLoad with the official Spine 4.3 runtimes (spine-ts, Unity, Godot, ...).\n`,
    ),
  });
  const zip = createZip(files);
  return {
    zip,
    files: files.map((f) => ({ name: f.name, size: f.data.length })),
    entries: files,
    pages: pages.length,
    missing,
    json,
    preview,
  };
}

/** Every skeleton of the project in one zip, each in a folder of its own (named like the skeleton). The pictures are packed separately for each. */
export async function buildAllSkeletonsExport(opts: ExportOptions): Promise<ExportResult> {
  const list = skeletonList(docStore.get());
  const entries: ZipEntry[] = [];
  const missing = new Set<string>();
  let pages = 0;
  let json: unknown;
  const used = new Set<string>();
  for (const [i, d] of list.entries()) {
    let folder = (d.name || 'skeleton').replace(/[^\w-]+/g, '_') || 'skeleton';
    while (used.has(folder)) folder += '_';
    used.add(folder);
    const r = await buildSpineExport({ ...opts, skeletonIndex: i, baseName: folder, includePreview: opts.includePreview });
    json ??= r.json;
    pages += r.pages;
    r.missing.forEach((m) => missing.add(m));
    for (const e of r.entries) if (e.name !== 'README.txt') entries.push({ ...e, name: `${folder}/${e.name}` });
  }
  entries.push({
    name: 'README.txt',
    data: new TextEncoder().encode(
      `Exported from Bone 2D: ${list.length} skeletons, one folder each. Every folder holds Spine 4.3 skeleton data, its texture atlas and a preview page.\n`,
    ),
  });
  return {
    zip: createZip(entries),
    files: entries.map((e) => ({ name: e.name, size: e.data.length })),
    entries,
    pages,
    missing: [...missing],
    json,
  };
}
