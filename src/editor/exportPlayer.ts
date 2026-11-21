/** Builds the single-file player page of a skeleton (see core/export/playerPage.ts): the skeleton and its pictures, with the player inside. */
import playerScript from 'virtual:bone2d-player';
import { usedImages } from '@/core/export/atlasBuild';
import { playerPageHtml } from '@/core/export/playerPage';
import type { PlayerPayload } from '@/core/export/playerPage';
import type { Project } from '@/core/model';
import { assets } from '@/store/assets';

/** The picture as a PNG data URI, or null when the editor does not have it. */
function pictureUri(name: string): string | null {
  const a = assets.get(name);
  if (!a) return null;
  const canvas = document.createElement('canvas');
  canvas.width = a.width;
  canvas.height = a.height;
  canvas.getContext('2d')!.drawImage(a.bitmap, 0, 0);
  return canvas.toDataURL('image/png');
}

/** The page for `doc`; `missing` lists the pictures the editor could not find (their slots stay empty). */
export function buildPlayerPage(
  doc: Project['skeleton'],
  opts: { smooth?: boolean } = {},
): { html: string; missing: string[]; bytes: number } {
  const images: Record<string, string> = {};
  const missing: string[] = [];
  for (const { name } of usedImages(doc)) {
    const uri = pictureUri(name);
    if (uri) images[name] = uri;
    else missing.push(name);
  }
  const payload: PlayerPayload = { title: doc.name || 'Bone 2D', skeleton: doc, images, smooth: opts.smooth ?? true };
  const html = playerPageHtml(payload, playerScript);
  return { html, missing, bytes: html.length };
}
