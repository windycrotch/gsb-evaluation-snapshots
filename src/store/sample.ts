/**
 * The built-in demo rig "Kit": a fox with IK legs, a physics tail, ears and scarf, weighted meshes, two skins, four animations.
 * The rig itself is built from data by demo/kit.ts, the pictures by demo/art.ts; this only puts them into the editor.
 */
import { uid } from '@/core/ids';
import type { ImageRef } from '@/core/model';
import { assets } from './assets';
import { docStore } from './doc';
import { drawDemoImages } from './demo/art';
import { buildDemoRig } from './demo/kit';
import { emptySelection, toast, uiStore } from './ui';

export async function loadSample() {
  // The pictures are made and decoded first and swapped in together with the rig. Clearing them up front left the rig that was open
  // on screen without its pictures (white shapes) for as long as the new ones took to draw.
  const decoded = await Promise.all((await drawDemoImages()).map(({ name, blob }) => assets.decode(name, blob)));
  const refs: Record<string, ImageRef> = {};
  for (const a of decoded) refs[a.name] = { id: uid(), name: a.name, width: a.width, height: a.height };
  const project = buildDemoRig(refs);
  const walk = project.skeleton.animations.find((a) => a.name === 'walk')!;
  assets.replaceAll(decoded);
  docStore.replace(project);
  uiStore.patch({
    mode: 'setup',
    selection: emptySelection,
    animationId: walk.id,
    skinId: null,
    time: 0,
    playing: false,
    overrides: {},
    selectedKeys: [],
    camera: { x: 20, y: 150, zoom: 1.5 },
  });
  window.dispatchEvent(new Event('bone2d:frame'));
  toast('Loaded the "Kit" demo rig — switch to Animate and press Space', 'ok');
}
