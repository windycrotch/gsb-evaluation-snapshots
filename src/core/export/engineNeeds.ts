/**
 * What an export asks of the engine that plays it: the features the skeleton uses and the settings it is exported with, each with what the
 * runtime or the material has to do. The most common reason an animation looks different in the game than in the editor is a mismatch
 * between the two (the version of the runtime, the alpha mode of the texture, a feature the integration does not draw), so the export dialog
 * lists them before the file is sent off. Only facts about the data: nothing here guesses what a given engine does.
 */
import type { SkeletonDoc } from '../model';

export interface EngineNeed {
  /** Stable name, for tests. */
  id: string;
  /** `needs`: the engine has to support it or the animation breaks; `note`: something to set or check on the engine side. */
  level: 'needs' | 'note';
  /** English text, written once (the interface translates it). */
  text: string;
}

export interface EngineNeedsOptions {
  format?: 'json' | 'binary';
  scale?: number;
  pma?: boolean;
  rotate?: boolean;
  filter?: 'Linear' | 'Nearest';
  /** One atlas per skin (only matters for a skeleton with more than one skin). */
  atlasPerSkin?: boolean;
}

const TEXT = {
  version:
    'The data is Spine 4.3: load it with the 4.3 runtimes. A runtime of another version is the most common reason an animation looks different in the game.',
  binary: 'Binary data (.skel): load it with the binary loader of the runtime, not the JSON one.',
  scale: 'The export is scaled: pictures and data are scaled together, so leave the scale of the skeleton in the engine at 1.',
  pma: 'Premultiplied alpha pages: set the texture to premultiplied alpha and use the premultiplied blend function, or the edges get a light or dark halo.',
  nearest: 'Sharp pixels (Nearest): the engine has to sample the atlas without smoothing, or the pixel art blurs.',
  perSkin:
    'An atlas per skin: load the atlas of the default skin and the atlas of the skin you show; the pictures of a skin that the default skin does not use are only in its own atlas.',
  rotate: 'The atlas has pictures turned a quarter turn (rotate: 90): the loader has to read rotated regions (the official runtimes do).',
  twoColor:
    'Two colour tint (slots with a dark colour): the engine needs the two colour tint shader and a vertex format with the second colour.',
  blend: 'Additive, multiply or screen blend modes: the engine needs a material with the matching blend function for each.',
  clipping: 'Clipping attachments: the renderer has to support clipping (stencil or in software).',
  inverse: 'Inverse clipping: runtime 4.3 or later.',
  physics: 'Physics constraints: runtime 4.2 or later, and the game has to update the skeleton every frame with the real time step.',
  slider: 'Slider constraints: runtime 4.3 or later.',
  sequence: 'Sequences (frame by frame pictures): runtime 4.2 or later; every frame is a picture in the atlas.',
  folder: 'Draw order folders with their own keys: runtime 4.3 or later.',
  linked: 'A linked mesh in another slot than its source mesh: runtime 4.3 or later.',
  audio: 'Events with audio: the runtime only fires the event; the game plays the sound named in its audio path.',
} as const;

/** The needs of an export of `doc` with `opts`, in a fixed order. */
export function engineNeeds(doc: SkeletonDoc, opts: EngineNeedsOptions = {}): EngineNeed[] {
  const out: EngineNeed[] = [];
  const add = (id: keyof typeof TEXT, level: EngineNeed['level']) => out.push({ id, level, text: TEXT[id] });

  add('version', 'note');
  if (opts.format === 'binary') add('binary', 'note');
  if (opts.scale !== undefined && opts.scale !== 1) add('scale', 'note');
  if (opts.pma) add('pma', 'note');
  if (opts.filter === 'Nearest') add('nearest', 'note');
  if (opts.rotate) add('rotate', 'note');
  if (opts.atlasPerSkin && doc.skins.length > 1) add('perSkin', 'note');

  if (doc.slots.some((s) => s.dark)) add('twoColor', 'needs');
  if (doc.slots.some((s) => s.blend !== 'normal')) add('blend', 'needs');

  let clipping = false;
  let inverse = false;
  let sequence = false;
  let linkedElsewhere = false;
  for (const skin of doc.skins) {
    for (const slotId of Object.keys(skin.attachments)) {
      for (const a of Object.values(skin.attachments[slotId])) {
        if (a.type === 'clipping') {
          clipping = true;
          if (a.inverse) inverse = true;
        } else if ((a.type === 'region' || a.type === 'mesh') && a.sequence) sequence = true;
        if (a.type === 'mesh' && a.link && a.link.slot && a.link.slot !== slotId) linkedElsewhere = true;
      }
    }
  }
  if (clipping) add('clipping', 'needs');
  if (inverse) add('inverse', 'needs');
  if (doc.constraints.some((c) => c.type === 'physics')) add('physics', 'needs');
  if (doc.constraints.some((c) => c.type === 'slider')) add('slider', 'needs');
  if (sequence) add('sequence', 'needs');
  if (doc.animations.some((a) => a.drawOrderFolder && Object.keys(a.drawOrderFolder).length > 0)) add('folder', 'needs');
  if (linkedElsewhere) add('linked', 'needs');
  if (doc.events.some((e) => e.audio)) add('audio', 'note');
  return out;
}

/** Every text the list can show, for the translation table and its test. */
export const ENGINE_NEED_TEXTS: readonly string[] = Object.values(TEXT);
