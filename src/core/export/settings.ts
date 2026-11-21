/** The settings of the Spine export, kept between sessions and saved to / loaded from a small JSON file to share with a team. */
import type { AtlasFilter } from './atlas';

export interface ExportSettings {
  format: 'json' | 'binary';
  scale: number;
  maxSize: number;
  padding: number;
  pretty: boolean;
  nonessential: boolean;
  pot: boolean;
  includePreview: boolean;
  /** Cut the empty border off the pictures. */
  trim: boolean;
  /** Turn pictures a quarter turn on the pages when it saves room. */
  rotate: boolean;
  filter: AtlasFilter;
  /** Write the mix table (crossfades between animations) as a file next to the skeleton, for the game's animation state. */
  mixes: boolean;
  /** Premultiplied alpha pages (the atlas says pma:true). */
  pma: boolean;
  /** Pages as wide as they are tall. */
  square: boolean;
  /** Identical pictures share one place in the atlas. */
  alias: boolean;
  /** Page sizes divisible by four (when the pages are not powers of two). */
  multipleOf4: boolean;
  /** Take the keys that change nothing out of the exported animations (the project keeps them). */
  cleanUp: boolean;
  /** Write an `alpha` or `rgb` timeline for a slot whose colour keys only change that part (as Spine does), instead of `rgba`. */
  splitColor: boolean;
  /** One atlas for the default skin and one for each other skin (only the pictures the default skin does not use), so a game loads a skin's pictures when it needs them. */
  atlasPerSkin: boolean;
}

const EXPORT_SCALES = [0.25, 0.5, 0.75, 1, 2] as const;
const EXPORT_PAGE_SIZES = [1024, 2048, 4096] as const;
const EXPORT_PADDINGS = [0, 1, 2, 4] as const;

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  format: 'json',
  scale: 1,
  maxSize: 2048,
  padding: 2,
  pretty: false,
  nonessential: true,
  pot: true,
  includePreview: true,
  trim: false,
  rotate: false,
  filter: 'Linear',
  mixes: true,
  pma: false,
  square: false,
  alias: false,
  multipleOf4: false,
  cleanUp: false,
  splitColor: false,
  atlasPerSkin: false,
};

const oneOf = <T>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);
const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

/** Settings from anything: each field that is not a valid value takes its default, unknown fields are dropped. */
export function readExportSettings(raw: unknown): ExportSettings {
  const d = DEFAULT_EXPORT_SETTINGS;
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    format: oneOf(o.format, ['json', 'binary'] as const, d.format),
    scale: oneOf(o.scale, EXPORT_SCALES, d.scale),
    maxSize: oneOf(o.maxSize, EXPORT_PAGE_SIZES, d.maxSize),
    padding: oneOf(o.padding, EXPORT_PADDINGS, d.padding),
    pretty: flag(o.pretty, d.pretty),
    nonessential: flag(o.nonessential, d.nonessential),
    pot: flag(o.pot, d.pot),
    includePreview: flag(o.includePreview, d.includePreview),
    trim: flag(o.trim, d.trim),
    rotate: flag(o.rotate, d.rotate),
    filter: oneOf(o.filter, ['Linear', 'Nearest'] as const, d.filter),
    mixes: flag(o.mixes, d.mixes),
    pma: flag(o.pma, d.pma),
    square: flag(o.square, d.square),
    alias: flag(o.alias, d.alias),
    multipleOf4: flag(o.multipleOf4, d.multipleOf4),
    cleanUp: flag(o.cleanUp, d.cleanUp),
    splitColor: flag(o.splitColor, d.splitColor),
    atlasPerSkin: flag(o.atlasPerSkin, d.atlasPerSkin),
  };
}

const KIND = 'bone2d-export-settings';

/** The text of a settings file. */
export function exportSettingsToText(s: ExportSettings): string {
  return JSON.stringify({ kind: KIND, version: 1, ...s }, null, 2) + '\n';
}

/** The settings in a file's text, or null when it is not a Bone 2D export settings file. */
export function exportSettingsFromText(text: string): ExportSettings | null {
  try {
    const o: unknown = JSON.parse(text);
    if (!o || typeof o !== 'object' || (o as { kind?: unknown }).kind !== KIND) return null;
    return readExportSettings(o);
  } catch {
    return null;
  }
}

const KEY = 'bone2d.export';

export function loadExportSettings(): ExportSettings {
  try {
    const text = localStorage.getItem(KEY);
    return readExportSettings(text ? JSON.parse(text) : null);
  } catch {
    return { ...DEFAULT_EXPORT_SETTINGS };
  }
}

export function rememberExportSettings(s: ExportSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // no storage (a private window): the settings just are not kept
  }
}
