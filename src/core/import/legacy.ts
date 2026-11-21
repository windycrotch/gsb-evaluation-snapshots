/**
 * Spine 4.0 / 4.1 / 4.2 JSON -> the 4.3 structure that `importSpineJson` reads.
 *
 * What changed between the versions (read from the official runtimes' `SkeletonJson` of each version):
 *   4.0  separate top-level arrays `ik` / `transform` / `path`; deform timelines in `animations.<n>.deform`
 *   4.1  deform (and sequence) timelines moved to `animations.<n>.attachments`
 *   4.2  `physics` constraints (with their own defaults), bone `transform` renamed `inherit` (the importer reads both)
 *   4.3  one ordered `constraints` array with a `type` per entry; transform constraints are a table of
 *        "source property -> constrained property" (`properties`) instead of six fixed channels; path constraints name their
 *        slot under `slot` instead of `target`
 *
 * A 4.0-4.2 transform constraint maps onto the 4.3 one exactly for everything but two corners that 4.3 computes differently:
 * a LOCAL constraint that applies scale in absolute mode (4.2 divides by the bone's scale, 4.3 does not; reported when a
 * constrained bone's scale is not 1) and the shear offset of a world constraint whose target is MIRRORED (4.2 flips the offset
 * with the mirror, 4.3 does not; not reported, a mirrored target with a shear offset is too rare to warn about every file).
 */

type J = Record<string, any>;

const obj = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export interface LegacyUpgrade {
  /** The document in the 4.3 structure (the input is not modified). */
  root: J;
  /** The version the file came from, e.g. "4.2.43". */
  version: string;
  /** Things the conversion could not carry over exactly. */
  warnings: string[];
}

/** "4.2.43" -> [4, 2]; undefined for anything that does not look like a version. */
export function parseSpineVersion(v: unknown): [number, number] | undefined {
  const m = typeof v === 'string' ? /^(\d+)\.(\d+)/.exec(v.trim()) : null;
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/** Whether the document is older than the 4.3 structure (a `constraints` array is what 4.3 has and nothing older does). */
export function isLegacySpineJson(root: J): boolean {
  if (Array.isArray(root.constraints)) return false;
  const version = parseSpineVersion(obj(root.skeleton).spine);
  if (version && (version[0] < 4 || (version[0] === 4 && version[1] < 3))) return true;
  return ['ik', 'transform', 'path', 'physics'].some((k) => Array.isArray(root[k]));
}

const TRANSFORM_OFFSETS = ['rotation', 'x', 'y', 'scaleX', 'scaleY', 'shearY'] as const;
const TRANSFORM_MIXES = ['mixRotate', 'mixX', 'mixY', 'mixScaleX', 'mixScaleY', 'mixShearY'] as const;
const TRANSFORM_PROPS = ['rotate', 'x', 'y', 'scaleX', 'scaleY', 'shearY'] as const;

function copyDefined(from: J, to: J, keys: readonly string[]) {
  for (const k of keys) if (from[k] !== undefined) to[k] = from[k];
}

function convertIk(map: J): J {
  const o: J = { type: 'ik', name: map.name, bones: map.bones, target: map.target };
  copyDefined(map, o, ['skin', 'mix', 'softness', 'bendPositive', 'compress', 'stretch']);
  if (map.uniform === true) o.scaleY = 'uniform'; // 4.2: the thickness follows the stretch
  return o;
}

/** `scales(name)` = the setup scale of a bone; the constraint only differs from 4.3 where a constrained bone is not at scale 1. */
function convertTransform(map: J, warn: (m: string) => void, scales: (bone: string) => [number, number]): J {
  const local = map.local === true;
  const relative = map.relative === true;
  const properties: J = {};
  for (const p of TRANSFORM_PROPS) properties[p] = { to: { [p]: {} } };
  const o: J = { type: 'transform', name: map.name, bones: map.bones, source: map.target, properties };
  if (map.skin !== undefined) o.skin = map.skin;
  if (local) {
    o.localSource = true;
    o.localTarget = true;
  }
  if (relative) o.additive = true;
  copyDefined(map, o, TRANSFORM_OFFSETS);
  copyDefined(map, o, TRANSFORM_MIXES);
  // 4.2 computes the scale of a local, absolute constraint as `(scale + (target - scale + offset) * mix) / scale`, which is the
  // intended value only for a bone at scale 1; 4.3 uses the value itself
  if (local && !relative) {
    const mixX = num(map.mixScaleX, 1);
    const mixY = num(map.mixScaleY, mixX);
    const odd = arr(map.bones).some((b) => {
      const [sx, sy] = scales(String(b));
      return (mixX !== 0 && sx !== 1) || (mixY !== 0 && sy !== 1);
    });
    if (odd)
      warn(
        `transform constraint "${String(map.name)}": the scale of a local, absolute constraint on a bone whose scale is not 1 is computed differently in 4.3`,
      );
  }
  return o;
}

function convertPath(map: J): J {
  const o: J = { type: 'path', name: map.name, bones: map.bones, slot: map.target };
  copyDefined(map, o, [
    'skin',
    'positionMode',
    'spacingMode',
    'rotateMode',
    'rotation',
    'position',
    'spacing',
    'mixRotate',
    'mixX',
    'mixY',
  ]);
  return o;
}

/** A 4.2 physics constraint: the keys are the same, but the 4.2 loader's defaults are inertia 1 and damping 1 (4.3: 0.5 and 0.85). */
function convertPhysics(map: J): J {
  return { ...map, type: 'physics', inertia: map.inertia ?? 1, damping: map.damping ?? 1 };
}

/** Converts a 4.0 - 4.2 document. Call only for documents `isLegacySpineJson` accepts. */
export function upgradeLegacySpineJson(input: J): LegacyUpgrade {
  const warnings: string[] = [];
  const warn = (m: string) => {
    if (!warnings.includes(m)) warnings.push(m);
  };
  const version = String(obj(input.skeleton).spine ?? '');
  const parsed = parseSpineVersion(version);
  if (parsed && parsed[0] < 4) warn(`Spine ${version} files are not supported (only 4.0 and newer): the result is probably wrong`);

  const root: J = { ...input };

  interface Entry {
    kind: 'ik' | 'transform' | 'path' | 'physics';
    order: number;
    seq: number;
    map: J;
  }
  const entries: Entry[] = [];
  let seq = 0;
  for (const kind of ['ik', 'transform', 'path', 'physics'] as const) {
    for (const m of arr(input[kind])) entries.push({ kind, order: num(obj(m).order, 0), seq: seq++, map: obj(m) });
  }
  // the runtime visits the constraints by their `order`; files from the editor number them 0..n-1 across all kinds
  entries.sort((a, b) => a.order - b.order || a.seq - b.seq);
  const boneScale = new Map<string, [number, number]>();
  for (const b of arr(input.bones)) boneScale.set(String(obj(b).name), [num(obj(b).scaleX, 1), num(obj(b).scaleY, 1)]);
  const scales = (name: string): [number, number] => boneScale.get(name) ?? [1, 1];
  root.constraints = entries.map(({ kind, map }) => {
    if (kind === 'ik') return convertIk(map);
    if (kind === 'transform') return convertTransform(map, warn, scales);
    if (kind === 'path') return convertPath(map);
    return convertPhysics(map);
  });
  if (entries.some((e) => e.kind === 'physics'))
    warn('physics constraints use the 4.3 simulation, which smooths the motion between steps: it moves slightly differently from 4.2');
  for (const kind of ['ik', 'transform', 'path', 'physics']) delete root[kind];

  const animations: J = {};
  for (const [name, am] of Object.entries(obj(input.animations))) {
    const a = obj(am);
    if (!a.deform) {
      animations[name] = a;
      continue;
    }
    const attachments: J = { ...obj(a.attachments) };
    for (const [skin, perSkin] of Object.entries(obj(a.deform))) {
      const skinOut: J = (attachments[skin] = { ...obj(attachments[skin]) });
      for (const [slot, perSlot] of Object.entries(obj(perSkin))) {
        const slotOut: J = (skinOut[slot] = { ...obj(skinOut[slot]) });
        for (const [att, frames] of Object.entries(obj(perSlot))) slotOut[att] = { ...obj(slotOut[att]), deform: frames };
      }
    }
    animations[name] = { ...a, deform: undefined, attachments };
  }
  if (input.animations !== undefined) root.animations = animations;

  return { root, version, warnings };
}
