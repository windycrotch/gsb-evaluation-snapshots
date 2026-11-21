/**
 * Constraint presets: the settings of a constraint (the spring of a physics constraint, the stiffness of an IK, the modes of a path) kept under
 * a name and put on another constraint of the same kind. What a constraint points at (its bones, target, slot, animation) is not part of a
 * preset, so it fits any rig. The library is the person's own, kept in the browser for every project.
 */
import type { Constraint, PhysicsParam } from './model';
import { PHYSICS_PARAMS } from './model';
import { uid, uniqueName } from './ids';

type ConstraintKind = Constraint['type'];

/** The fields each kind of constraint keeps in a preset. */
const PRESET_FIELDS: Record<ConstraintKind, string[]> = {
  ik: ['mix', 'softness', 'bendPositive', 'compress', 'stretch', 'scaleY'],
  transform: ['localSource', 'localTarget', 'additive', 'clamp', 'properties', 'offsets', 'mix'],
  slider: ['additive', 'loop', 'mix', 'time', 'property', 'from', 'to', 'scale', 'max', 'local'],
  path: ['positionMode', 'spacingMode', 'rotateMode', 'offsetRotation', 'position', 'spacing', 'mix'],
  physics: [
    'x',
    'y',
    'rotate',
    'scaleX',
    'shearX',
    'scaleY',
    'limit',
    'fps',
    'inertia',
    'strength',
    'damping',
    'mass',
    'wind',
    'gravity',
    'mix',
    'global',
  ],
};

export interface ConstraintPreset {
  id: string;
  name: string;
  type: ConstraintKind;
  settings: Record<string, unknown>;
}

/** The settings of a constraint a preset keeps (a copy). */
export function presetSettings(c: Constraint): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PRESET_FIELDS[c.type]) out[k] = structuredClone((c as unknown as Record<string, unknown>)[k]);
  return out;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** True when `value` can take the place of `current` (same sort of value; objects are checked key by key). */
function fits(current: unknown, value: unknown): boolean {
  if (typeof current === 'number') return isNum(value);
  if (typeof current === 'boolean' || typeof current === 'string') return typeof value === typeof current;
  if (Array.isArray(current)) return Array.isArray(value);
  if (current && typeof current === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.keys(current).every((k) => fits((current as Record<string, unknown>)[k], (value as Record<string, unknown>)[k]));
  }
  return false;
}

/**
 * Puts the settings of a preset on a constraint (in place). A field that is missing or of the wrong sort is left as it is, so a damaged preset
 * cannot break the rig; physics values go through the same limits as the inspector. Returns how many fields changed.
 */
export function applyPresetSettings(
  c: Constraint,
  settings: Record<string, unknown>,
  clamp?: (param: PhysicsParam, v: number) => number,
): number {
  const target = c as unknown as Record<string, unknown>;
  let changed = 0;
  for (const k of PRESET_FIELDS[c.type]) {
    if (!(k in settings) || !fits(target[k], settings[k])) continue;
    let v = structuredClone(settings[k]);
    if (c.type === 'physics' && clamp && PHYSICS_PARAMS.includes(k as PhysicsParam) && isNum(v)) v = clamp(k as PhysicsParam, v);
    if (JSON.stringify(v) === JSON.stringify(target[k])) continue;
    target[k] = v;
    changed++;
  }
  return changed;
}

function presetName(list: readonly ConstraintPreset[], type: ConstraintKind, wanted: string): string {
  return uniqueName(
    wanted.trim() || 'Preset',
    list.filter((p) => p.type === type).map((p) => p.name),
  );
}

export function newPreset(list: readonly ConstraintPreset[], c: Constraint, name: string): ConstraintPreset {
  return { id: uid(), name: presetName(list, c.type, name), type: c.type, settings: presetSettings(c) };
}

const KEY = 'bone2d.constraintPresets';

/** Takes a stored library for what it is worth: entries of an unknown kind or without a name are dropped, names are unique within a kind. */
export function readPresets(raw: string | null): ConstraintPreset[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    const out: ConstraintPreset[] = [];
    for (const p of list as Partial<ConstraintPreset>[]) {
      if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !p.name.trim() || typeof p.id !== 'string') continue;
      if (!p.type || !(p.type in PRESET_FIELDS) || !p.settings || typeof p.settings !== 'object' || Array.isArray(p.settings)) continue;
      out.push({ id: p.id, name: presetName(out, p.type, p.name), type: p.type, settings: p.settings });
    }
    return out;
  } catch {
    return [];
  }
}

export function loadPresets(): ConstraintPreset[] {
  try {
    return readPresets(localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

export function savePresets(list: readonly ConstraintPreset[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage can be blocked */
  }
}
