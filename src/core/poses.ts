/** The pose library: keeping a pose by name, putting it back whole or part of the way. Pure functions; the store actions are in store/poseActions.ts. */
import { uid, uniqueName } from './ids';
import type { BonePose, PoseEntry } from './model';

const POSE_FIELDS: (keyof BonePose)[] = ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'shearX', 'shearY'];

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The angle `to` as the nearest one to `from` (a difference of at most half a turn), so a blend goes the short way round. */
function near(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  return from + d;
}

/**
 * The pose between the current one and a kept one: amount 0 is the current pose, 1 the kept pose. Angles go the short way round,
 * so a blend never swings through a turn the animator did not mean; scales blend linearly.
 */
export function blendPose(current: BonePose, target: BonePose, amount: number): BonePose {
  const t = Math.min(1, Math.max(0, amount));
  if (t === 1) return { ...target };
  const out = { ...current };
  for (const k of POSE_FIELDS) {
    if (k === 'rotation' || k === 'shearX' || k === 'shearY') out[k] = current[k] + (near(current[k], target[k]) - current[k]) * t;
    else out[k] = current[k] + (target[k] - current[k]) * t;
  }
  return out;
}

/** A name for a new pose that no other pose has. */
export function newPoseName(poses: readonly PoseEntry[], wanted = 'Pose'): string {
  return uniqueName(
    wanted.trim() || 'Pose',
    poses.map((p) => p.name),
  );
}

export function newPose(poses: readonly PoseEntry[], bones: Record<string, BonePose>, name?: string): PoseEntry {
  return { id: uid(), name: newPoseName(poses, name), bones };
}

/** Makes a damaged library valid in place: only poses with a name and finite numbers stay, ids and names are unique. Returns what was dropped or changed. */
export function repairPoses(list: unknown): { poses: PoseEntry[]; notes: string[] } {
  const notes: string[] = [];
  const poses: PoseEntry[] = [];
  if (list === undefined) return { poses, notes };
  if (!Array.isArray(list)) return { poses, notes: ['the pose library was not a list'] };
  const ids = new Set<string>();
  for (const raw of list as Partial<PoseEntry>[]) {
    if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !raw.bones || typeof raw.bones !== 'object') {
      notes.push('a pose without a name or bones was dropped');
      continue;
    }
    const bones: Record<string, BonePose> = {};
    for (const [name, p] of Object.entries(raw.bones)) {
      if (p && typeof p === 'object' && POSE_FIELDS.every((k) => finite(p[k])))
        bones[name] = Object.fromEntries(POSE_FIELDS.map((k) => [k, p[k]])) as unknown as BonePose;
      else notes.push(`pose "${raw.name}": bone "${name}" had no valid numbers`);
    }
    if (!Object.keys(bones).length) {
      notes.push(`pose "${raw.name}" had no bones and was dropped`);
      continue;
    }
    let id = typeof raw.id === 'string' && raw.id ? raw.id : uid();
    if (ids.has(id)) id = uid();
    ids.add(id);
    const name = uniqueName(
      raw.name.trim() || 'Pose',
      poses.map((p) => p.name),
    );
    if (name !== raw.name) notes.push(`pose name "${raw.name}" was made unique`);
    poses.push({ id, name, bones });
  }
  return { poses, notes };
}
