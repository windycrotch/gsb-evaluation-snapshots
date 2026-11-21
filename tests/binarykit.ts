/** Shared by the binary export tests and the fuzz run: loads a project from JSON and from binary with the official loaders and diffs the two. */
import { packAtlas, writeAtlas } from '../src/core/export/atlas';
import { exportSpineBinary } from '../src/core/export/spineBinary';
import { binaryToJson } from '../src/core/import/spineBinary';
import { exportSpineJson } from '../src/core/export/spineJson';
import type { Project } from '../src/core/model';
import { loadOfficial, loadOfficialBinary, usedImages } from './official';

const IGNORED = new Set(['hash', 'name', 'version', 'imagesPath', 'audioPath', 'visible', 'id']);

/** Walks two object graphs of the official runtime side by side and collects what differs. */
export function diffGraphs(a: any, b: any, path = '', diffs: string[] = [], seen = new Set<any>()): string[] {
  if (diffs.length > 25) return diffs;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return diffs;
    if (Math.abs(a - b) > 2e-5 * Math.max(1, Math.abs(a), Math.abs(b))) diffs.push(`${path}: ${a} vs ${b}`);
    return diffs;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (typeof a === 'function' || typeof b === 'function') return diffs;
    if (a !== b && !(a == null && b == null)) diffs.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    return diffs;
  }
  if (seen.has(a)) return diffs;
  seen.add(a);
  if (a instanceof Map) {
    const keys = [...a.keys()];
    if (keys.length !== b.size) diffs.push(`${path}: map size ${keys.length} vs ${b.size}`);
    for (const k of keys) diffGraphs(a.get(k), b.get(k), `${path}[${String(k)}]`, diffs, seen);
    return diffs;
  }
  if (Array.isArray(a) || ArrayBuffer.isView(a)) {
    const x = a as any;
    const y = b;
    if (x.length !== y.length) {
      diffs.push(`${path}: length ${x.length} vs ${y.length}`);
      return diffs;
    }
    for (let i = 0; i < x.length; i++) diffGraphs(x[i], y[i], `${path}[${i}]`, diffs, seen);
    return diffs;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (IGNORED.has(k)) continue;
    diffGraphs(a[k], b[k], `${path}.${k}`, diffs, seen);
  }
  return diffs;
}

export function atlasFor(project: Project): string {
  const pages = packAtlas(usedImages(project), { maxSize: 2048, padding: 2 });
  return writeAtlas(pages, (i) => `atlas${i}.png`);
}

/**
 * What the formats cannot say alike, by design:
 * - hull edges (the JSON has none), the alpha of a dark color, a clip with no end slot (binary: the last slot);
 * - the ids of attachments come from a counter that every load advances, and deform timelines carry them in their property ids.
 */
export const KNOWN_DIFFS = /\.hullLength:|\.edges:|darkColor\.a:|\.endSlot: null|propertyIds|timelineIds/;

/** Without editor-only data the binary keeps the loader's defaults for colors and sizes that the JSON loader fills in itself. */
const ESSENTIAL_ONLY = /\.color\.|\.(width|height): |\.max: /;

/**
 * A skeleton with no attachments at all: the JSON loader keeps the (empty) default skin, the binary reader returns none for a default skin with no
 * slots. Nothing can be looked up in either, so it is not a difference that matters.
 */
function emptyDefaultSkin(fromJson: any) {
  const empty = !!fromJson.defaultSkin && fromJson.defaultSkin.attachments.every((a: unknown) => !a || Object.keys(a).length === 0);
  return (d: string) => {
    if (!empty) return false;
    const m = /^skeleton\.skins: length (\d+) vs (\d+)$/.exec(d);
    return (!!m && Number(m[1]) - Number(m[2]) === 1) || /^skeleton\.defaultSkin: .* vs null$/.test(d);
  };
}

/** A physics constraint with a scale mode but no scale: the mode has nothing to act on and is not written. */
function idleScaleMode(fromJson: any) {
  return (d: string) => {
    const m = /^skeleton\.constraints\[(\d+)\]\._scaleYMode: \d vs 0$/.exec(d);
    if (m) return fromJson.constraints[Number(m[1])].scaleX === 0;
    // the same constraint seen through the list of a skin that needs it (which place it has in the skeleton's list is not in the message)
    return (
      /^skeleton\.skins\[\d+\]\.constraints\[\d+\]\._scaleYMode: \d vs 0$/.test(d) &&
      fromJson.constraints.some((c: { scaleX?: number; _scaleYMode?: number }) => c.scaleX === 0 && c._scaleYMode)
    );
  };
}

export function compare(project: Project, options: { nonessential?: boolean; splitColor?: boolean } = {}) {
  const json = exportSpineJson(project.skeleton, options);
  const bytes = exportSpineBinary(project.skeleton, options);
  const atlas = atlasFor(project);
  const fromJson = loadOfficial(json, atlas);
  const fromBinary = loadOfficialBinary(bytes, atlas);
  const idle = idleScaleMode(fromJson);
  const noSkin = emptyDefaultSkin(fromJson);
  const diffs = diffGraphs(fromJson, fromBinary, 'skeleton').filter(
    (d) => !KNOWN_DIFFS.test(d) && !idle(d) && !noSkin(d) && !(options.nonessential === false && ESSENTIAL_ONLY.test(d)),
  );
  return { diffs, bytes, json, fromJson, fromBinary };
}

/** What the binary reader makes of our own binary, against the JSON it came from, both loaded by the official JSON loader. */
export function compareReadBack(project: Project) {
  const json = exportSpineJson(project.skeleton);
  const back = binaryToJson(exportSpineBinary(project.skeleton));
  const atlas = atlasFor(project);
  const fromJson = loadOfficial(json, atlas);
  const idle = idleScaleMode(fromJson);
  return diffGraphs(fromJson, loadOfficial(back, atlas), 'skeleton').filter((d) => !KNOWN_DIFFS.test(d) && !idle(d));
}
