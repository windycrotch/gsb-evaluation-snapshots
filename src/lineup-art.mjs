import fs from 'node:fs';
import { iconIndex, atlasFile } from './art.mjs';
import { cropIcon, decodePng, encodePng } from './art-thumbs.mjs';

const names = new Set(['bg_formation', 'bg_position', 'bg_pos_2']);
const images = new Map();

// These three board textures retain their original resolution.
export async function lineupArt(name) {
  if (!names.has(name)) return null;
  const icon = iconIndex().icons['ui_formation/' + name];
  if (!icon || icon.bundle !== 'ui_formation') return null;
  const file = atlasFile(icon.bundle, icon.page);
  if (!file) return null;
  const key = JSON.stringify(icon);
  if (images.get(name)?.key === key) return images.get(name).promise;
  const promise = new Promise(resolve => setImmediate(resolve)).then(() =>
    encodePng(cropIcon(decodePng(fs.readFileSync(file)), icon)));
  images.set(name, { key, promise });
  try { return await promise; }
  catch (error) { images.delete(name); throw error; }
}
