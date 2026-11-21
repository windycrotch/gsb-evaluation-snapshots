/** Applies an animation (bone, slot, IK, deform, draw order timelines) to a skeleton pose at a given time. */
import { deformProgress, findKeyIndex, sampleKeys } from './curve';
import { completeFolderOrder } from './folders';
import { BONE_PROPS, GLOBAL_PHYSICS, PHYSICS_PARAMS } from './model';
import { sequenceIndexAt } from './sequence';
import type { Animation, Id, Timeline } from './model';
import type { AttachmentData, PhysicsConstraintRT, Skeleton, Slot } from './skeleton';

const tmp: number[] = [0, 0, 0, 0, 0, 0, 0];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The attachment whose deform timelines move an attachment: itself, or the source of a linked mesh that shares it. */
function deformOwner(skeleton: Skeleton, att: AttachmentData): AttachmentData {
  return skeleton.data.deformSource.get(att) ?? att;
}

/**
 * The slots a deform timeline of `att` (which belongs to `slot`) moves: the slot while it shows `att` or a linked mesh that follows
 * its deform, and the slots that show such a linked mesh while the source sits in another slot (Spine's `timelineSlots`).
 */
function deformSlots(skeleton: Skeleton, slot: Slot, att: AttachmentData): Slot[] {
  const out: Slot[] = [];
  const shows = (s: Slot) => {
    const cur = skeleton.slotAttachment(s);
    return !!cur && deformOwner(skeleton, cur) === att;
  };
  if (shows(slot)) out.push(slot);
  for (const index of skeleton.data.deformFollowers.get(att) ?? []) {
    const other = skeleton.slots[index];
    if (other && other !== slot && other.bone.active && shows(other)) out.push(other);
  }
  return out;
}

/**
 * Spine's RGBA / RGBA2 timeline applied on top of the current pose (sliders): the light color (and the dark one for two-color
 * keys) moves towards the sampled value by `alpha`. Spine clamps colors to 0..1 (Color.set / Color.add).
 */
function mixColor(slot: Slot, v: number[], alpha: number, dark: boolean) {
  if (alpha === 1) slot.color = [clamp01(v[0]), clamp01(v[1]), clamp01(v[2]), clamp01(v[3])];
  else for (let j = 0; j < 4; j++) slot.color[j] = clamp01(slot.color[j] + (v[j] - slot.color[j]) * alpha);
  if (!dark || !slot.dark) return;
  if (alpha === 1) slot.dark = [clamp01(v[4]), clamp01(v[5]), clamp01(v[6])];
  else for (let j = 0; j < 3; j++) slot.dark[j] = clamp01(slot.dark[j] + (v[4 + j] - slot.dark[j]) * alpha);
}

/** The constraints a physics timeline writes to: its own constraint, or every one that is driven globally for this parameter. */
function physicsTargets(skeleton: Skeleton, id: Id, param: (typeof PHYSICS_PARAMS)[number]): PhysicsConstraintRT[] {
  if (id === GLOBAL_PHYSICS) return skeleton.physicsConstraints.filter((c) => c.active && c.data.global[param]);
  const c = skeleton.physicsById(id);
  return c && c.active ? [c] : [];
}

/**
 * Spine's physics reset timeline: restarts the simulation of the constraints that have a reset key in (lastTime, time]. The
 * caller owns the time (a looping animation passes the two parts of a wrap separately). A key at the very start of an animation
 * counts when `lastTime` is before it, which is what Spine does when an animation starts (it begins at -1).
 */
export function applyPhysicsResets(skeleton: Skeleton, anim: Animation, lastTime: number, time: number) {
  for (const cid in anim.physics ?? {}) {
    const keys = anim.physics[cid].reset;
    if (!keys?.some((k) => k.time > lastTime && k.time <= time)) continue;
    if (cid === GLOBAL_PHYSICS) for (const c of skeleton.physicsConstraints) c.active && c.reset();
    else {
      const c = skeleton.physicsById(cid);
      if (c && c.active) c.reset();
    }
  }
}

/** Last key time of an animation (or 0). */
export function animationEndTime(anim: Animation): number {
  let end = 0;
  const scan = (keys: ReadonlyArray<{ time: number }> | undefined) => {
    if (keys && keys.length) end = Math.max(end, keys[keys.length - 1].time);
  };
  for (const id in anim.bones) {
    const t = anim.bones[id];
    for (const p of BONE_PROPS) scan(t[p]);
  }
  for (const id in anim.slots) {
    const t = anim.slots[id];
    scan(t.attachment);
    scan(t.rgba);
    scan(t.rgba2);
  }
  for (const skin of Object.values(anim.sequence ?? {}))
    for (const slot of Object.values(skin)) for (const keys of Object.values(slot)) scan(keys);
  for (const id in anim.ik) scan(anim.ik[id]);
  for (const id in anim.transform ?? {}) scan(anim.transform[id]);
  for (const id in anim.slider ?? {}) {
    scan(anim.slider[id].time);
    scan(anim.slider[id].mix);
  }
  for (const id in anim.path ?? {}) {
    scan(anim.path[id].position);
    scan(anim.path[id].spacing);
    scan(anim.path[id].mix);
  }
  for (const id in anim.physics ?? {}) for (const p of [...PHYSICS_PARAMS, 'reset'] as const) scan(anim.physics[id][p]);
  for (const skin in anim.deform)
    for (const slot in anim.deform[skin]) for (const att in anim.deform[skin][slot]) scan(anim.deform[skin][slot][att]);
  scan(anim.drawOrder);
  for (const id in anim.drawOrderFolder ?? {}) scan(anim.drawOrderFolder![id]);
  scan(anim.events);
  return end;
}

/**
 * The draw order folder timelines: the slots of each folder with keys take the order of the key in force, among the seats they hold in the
 * draw order the full timeline left (before the first key, setup order). What Spine's DrawOrderFolderTimeline does.
 */
function applyDrawOrderFolders(skeleton: Skeleton, anim: Animation, time: number) {
  const timelines = anim.drawOrderFolder;
  if (!timelines) return;
  for (const f of skeleton.data.folders ?? []) {
    const keys = timelines[f.id];
    if (!keys?.length) continue;
    const members = f.slots.map((i) => skeleton.slots[i]);
    const i = findKeyIndex(keys, time);
    const arrangement =
      i < 0
        ? members
        : completeFolderOrder(
            members.map((m) => m.data.id),
            keys[i].order,
          ).map((id) => skeleton.slotById(id)!);
    const seats = new Set(members);
    let next = 0;
    const out = skeleton.drawOrder.slice();
    for (let seat = 0; seat < out.length && next < arrangement.length; seat++) {
      if (seats.has(out[seat])) out[seat] = arrangement[next++];
    }
    skeleton.drawOrder = out;
  }
}

/** The draw order of the last draw-order key at or before `time`, then the order inside the draw-order folders. */
function applyDrawOrder(skeleton: Skeleton, anim: Animation, time: number) {
  const i = anim.drawOrder.length ? findKeyIndex(anim.drawOrder, time) : -1;
  if (i >= 0) {
    const order: Slot[] = [];
    const seen = new Set<Slot>();
    for (const sid of anim.drawOrder[i].order) {
      const s = skeleton.slotById(sid);
      if (s && !seen.has(s)) {
        order.push(s);
        seen.add(s);
      }
    }
    for (const s of skeleton.slots) if (!seen.has(s)) order.push(s);
    skeleton.drawOrder = order;
  }
  applyDrawOrderFolders(skeleton, anim, time);
}

/** Poses `skeleton` for `anim` at `time` starting from the setup pose. Does not compute world transforms. */
export function applyAnimation(skeleton: Skeleton, anim: Animation | null, time: number) {
  skeleton.setToSetupPose();
  if (!anim) return;

  for (const boneId in anim.bones) {
    const bone = skeleton.boneById(boneId);
    if (!bone || !bone.active) continue; // the official runtime skips what the skin does not activate
    const tl = anim.bones[boneId];
    const d = bone.data;
    if (tl.rotate && tl.rotate.length && sampleKeys(tl.rotate, time, tmp)) bone.rotation = d.rotation + tmp[0];
    if (tl.translate && tl.translate.length && sampleKeys(tl.translate, time, tmp)) {
      bone.x = d.x + tmp[0];
      bone.y = d.y + tmp[1];
    }
    if (tl.scale && tl.scale.length && sampleKeys(tl.scale, time, tmp)) {
      bone.scaleX = d.scaleX * tmp[0];
      bone.scaleY = d.scaleY * tmp[1];
    }
    if (tl.shear && tl.shear.length && sampleKeys(tl.shear, time, tmp)) {
      bone.shearX = d.shearX + tmp[0];
      bone.shearY = d.shearY + tmp[1];
    }
    // the split axes come after the combined timelines, each moving one value
    if (tl.translatex?.length && sampleKeys(tl.translatex, time, tmp)) bone.x = d.x + tmp[0];
    if (tl.translatey?.length && sampleKeys(tl.translatey, time, tmp)) bone.y = d.y + tmp[0];
    if (tl.scalex?.length && sampleKeys(tl.scalex, time, tmp)) bone.scaleX = d.scaleX * tmp[0];
    if (tl.scaley?.length && sampleKeys(tl.scaley, time, tmp)) bone.scaleY = d.scaleY * tmp[0];
    if (tl.shearx?.length && sampleKeys(tl.shearx, time, tmp)) bone.shearX = d.shearX + tmp[0];
    if (tl.sheary?.length && sampleKeys(tl.sheary, time, tmp)) bone.shearY = d.shearY + tmp[0];
  }

  for (const slotId in anim.slots) {
    const slot = skeleton.slotById(slotId);
    if (!slot || !slot.bone.active) continue;
    const tl = anim.slots[slotId];
    if (tl.attachment && tl.attachment.length) {
      const i = findKeyIndex(tl.attachment, time);
      if (i >= 0) slot.attachmentName = tl.attachment[i].name;
    }
    if (tl.rgba && tl.rgba.length && sampleKeys(tl.rgba, time, tmp)) {
      slot.color = [clamp01(tmp[0]), clamp01(tmp[1]), clamp01(tmp[2]), clamp01(tmp[3])];
    }
    if (tl.rgba2 && tl.rgba2.length && sampleKeys(tl.rgba2, time, tmp)) {
      slot.color = [clamp01(tmp[0]), clamp01(tmp[1]), clamp01(tmp[2]), clamp01(tmp[3])];
      if (slot.dark) slot.dark = [clamp01(tmp[4]), clamp01(tmp[5]), clamp01(tmp[6])];
    }
  }

  for (const cid in anim.ik) {
    const c = skeleton.ikById(cid);
    const keys = anim.ik[cid];
    if (!c || !c.active || !keys.length) continue;
    if (sampleKeys(keys, time, tmp)) {
      c.mix = tmp[0];
      c.softness = tmp[1];
      const k = keys[findKeyIndex(keys, time)];
      c.bendDirection = k.bendPositive ? 1 : -1;
      c.compress = k.compress;
      c.stretch = k.stretch;
    }
  }

  for (const cid in anim.transform ?? {}) {
    const c = skeleton.transformById(cid);
    const keys = anim.transform[cid];
    if (!c || !c.active || !keys.length) continue;
    if (sampleKeys(keys, time, tmp)) c.mix = [tmp[0], tmp[1], tmp[2], tmp[3], tmp[4], tmp[5]];
  }

  for (const cid in anim.slider ?? {}) {
    const c = skeleton.sliderById(cid);
    if (!c || !c.active) continue;
    const tl = anim.slider[cid];
    if (tl.time?.length && sampleKeys(tl.time, time, tmp)) c.time = tmp[0];
    if (tl.mix?.length && sampleKeys(tl.mix, time, tmp)) c.mix = tmp[0];
  }

  for (const cid in anim.path ?? {}) {
    const c = skeleton.pathById(cid);
    if (!c || !c.active) continue;
    const tl = anim.path[cid];
    if (tl.position?.length && sampleKeys(tl.position, time, tmp)) c.position = tmp[0];
    if (tl.spacing?.length && sampleKeys(tl.spacing, time, tmp)) c.spacing = tmp[0];
    if (tl.mix?.length && sampleKeys(tl.mix, time, tmp)) c.mix = [tmp[0], tmp[1], tmp[2]];
  }

  for (const cid in anim.physics ?? {}) {
    const tl = anim.physics[cid];
    for (const p of PHYSICS_PARAMS) {
      const keys = tl[p];
      if (!keys?.length || !sampleKeys(keys, time, tmp)) continue;
      for (const c of physicsTargets(skeleton, cid, p)) c.setParam(p, tmp[0]);
    }
  }

  applyDrawOrder(skeleton, anim, time);

  for (const skinId in anim.deform) {
    const skin = skeleton.data.skinById.get(skinId);
    if (!skin) continue;
    for (const slotId in anim.deform[skinId]) {
      const slot = skeleton.slotById(slotId);
      if (!slot || !slot.bone.active) continue;
      const perAtt = anim.deform[skinId][slotId];
      for (const attName in perAtt) {
        const keys = perAtt[attName];
        if (!keys.length) continue;
        const att = skin.attachments[slot.data.index]?.get(attName);
        if (!att || skeleton.data.deformSource.has(att)) continue;
        const out = sampleDeform(keys, time);
        if (!out) continue;
        for (const target of deformSlots(skeleton, slot, att)) target.deform = out;
      }
    }
  }

  applySequences(skeleton, anim, time, false);
}

/**
 * The sequence timelines of an animation: the frame of the slot's current picture sequence. `onto` is a slider applying the animation over
 * the current pose: before the first key it leaves the frame as it is, otherwise it is the setup frame (-1).
 */
function applySequences(skeleton: Skeleton, anim: Animation, time: number, onto: boolean) {
  for (const skinId in anim.sequence ?? {}) {
    const skin = skeleton.data.skinById.get(skinId);
    if (!skin) continue;
    for (const slotId in anim.sequence![skinId]) {
      const slot = skeleton.slotById(slotId);
      if (!slot || !slot.bone.active) continue;
      const perAtt = anim.sequence![skinId][slotId];
      for (const attName in perAtt) {
        const keys = perAtt[attName];
        const att = skin.attachments[slot.data.index]?.get(attName);
        if (
          !keys.length ||
          !att ||
          att !== skeleton.slotAttachment(slot) ||
          (att.kind !== 'region' && att.kind !== 'mesh') ||
          !att.src.sequence
        )
          continue;
        const i = sequenceIndexAt(keys, time, att.src.sequence.count);
        if (i >= 0 || !onto) slot.sequenceIndex = i;
      }
    }
  }
}

/**
 * Applies `anim` on top of the CURRENT pose (Spine's `MixFrom.current`), the way a slider does: values blend from where
 * they are towards the animation by `alpha`, or are added when `additive`. Bones are edited through their applied local
 * transform, so `bone.modifyLocal()` has to be called first (the slider does). Events are ignored.
 */
export function applyAnimationOnto(skeleton: Skeleton, anim: Animation, time: number, alpha: number, additive: boolean, loop: boolean) {
  if (loop && anim.duration !== 0) time %= anim.duration;

  for (const boneId in anim.bones) {
    const bone = skeleton.boneById(boneId);
    if (!bone || !bone.active) continue;
    const tl = anim.bones[boneId];
    const d = bone.data;
    if (tl.rotate?.length && sampleKeys(tl.rotate, time, tmp))
      bone.arotation += (additive ? tmp[0] : tmp[0] + d.rotation - bone.arotation) * alpha;
    if (tl.translate?.length && sampleKeys(tl.translate, time, tmp)) {
      bone.ax += (additive ? tmp[0] : d.x + tmp[0] - bone.ax) * alpha;
      bone.ay += (additive ? tmp[1] : d.y + tmp[1] - bone.ay) * alpha;
    }
    // one axis of a scale: the value the timeline asks for (already times the setup scale) against the current one
    const scaled = (cur: number, setup: number, v: number) => {
      if (alpha === 1 && !additive) return v;
      if (additive) return cur + (v - setup) * alpha;
      const b = Math.abs(cur) * Math.sign(v);
      return b + (v - b) * alpha;
    };
    if (tl.scale?.length && sampleKeys(tl.scale, time, tmp)) {
      bone.ascaleX = scaled(bone.ascaleX, d.scaleX, tmp[0] * d.scaleX);
      bone.ascaleY = scaled(bone.ascaleY, d.scaleY, tmp[1] * d.scaleY);
    }
    if (tl.shear?.length && sampleKeys(tl.shear, time, tmp)) {
      bone.ashearX += (additive ? tmp[0] : d.shearX + tmp[0] - bone.ashearX) * alpha;
      bone.ashearY += (additive ? tmp[1] : d.shearY + tmp[1] - bone.ashearY) * alpha;
    }
    if (tl.translatex?.length && sampleKeys(tl.translatex, time, tmp)) bone.ax += (additive ? tmp[0] : d.x + tmp[0] - bone.ax) * alpha;
    if (tl.translatey?.length && sampleKeys(tl.translatey, time, tmp)) bone.ay += (additive ? tmp[0] : d.y + tmp[0] - bone.ay) * alpha;
    if (tl.scalex?.length && sampleKeys(tl.scalex, time, tmp)) bone.ascaleX = scaled(bone.ascaleX, d.scaleX, tmp[0] * d.scaleX);
    if (tl.scaley?.length && sampleKeys(tl.scaley, time, tmp)) bone.ascaleY = scaled(bone.ascaleY, d.scaleY, tmp[0] * d.scaleY);
    if (tl.shearx?.length && sampleKeys(tl.shearx, time, tmp))
      bone.ashearX += (additive ? tmp[0] : d.shearX + tmp[0] - bone.ashearX) * alpha;
    if (tl.sheary?.length && sampleKeys(tl.sheary, time, tmp))
      bone.ashearY += (additive ? tmp[0] : d.shearY + tmp[0] - bone.ashearY) * alpha;
  }

  for (const slotId in anim.slots) {
    const slot = skeleton.slotById(slotId);
    if (!slot || !slot.bone.active) continue;
    const tl = anim.slots[slotId];
    if (tl.attachment?.length) {
      const i = findKeyIndex(tl.attachment, time);
      if (i >= 0 && tl.attachment[i].name !== slot.attachmentName) {
        // a slot that changes its attachment starts over without the deformation of the old one (the official `SlotPose.setAttachment`),
        // unless the two share their deform timelines (a mesh and the linked meshes that follow its deform)
        const before = skeleton.slotAttachment(slot);
        slot.attachmentName = tl.attachment[i].name;
        const after = skeleton.slotAttachment(slot);
        const sameDeform = !!before && !!after && before !== after && deformOwner(skeleton, before) === deformOwner(skeleton, after);
        if (!sameDeform) slot.deform = [];
        slot.sequenceIndex = -1;
      }
    }
    if (tl.rgba?.length && sampleKeys(tl.rgba, time, tmp)) mixColor(slot, tmp, alpha, false);
    if (tl.rgba2?.length && sampleKeys(tl.rgba2, time, tmp)) mixColor(slot, tmp, alpha, true);
  }

  for (const cid in anim.ik) {
    const c = skeleton.ikById(cid);
    const keys = anim.ik[cid];
    if (!c || !c.active || !keys.length) continue;
    if (sampleKeys(keys, time, tmp)) {
      c.mix += (tmp[0] - c.mix) * alpha;
      c.softness += (tmp[1] - c.softness) * alpha;
      const k = keys[findKeyIndex(keys, time)];
      c.bendDirection = k.bendPositive ? 1 : -1;
      c.compress = k.compress;
      c.stretch = k.stretch;
    }
  }

  for (const cid in anim.transform ?? {}) {
    const c = skeleton.transformById(cid);
    const keys = anim.transform[cid];
    if (!c || !c.active || !keys.length) continue;
    if (sampleKeys(keys, time, tmp)) for (let j = 0; j < 6; j++) c.mix[j] += (additive ? tmp[j] : tmp[j] - c.mix[j]) * alpha;
  }

  for (const cid in anim.slider ?? {}) {
    const c = skeleton.sliderById(cid);
    if (!c || !c.active) continue;
    const tl = anim.slider[cid];
    if (tl.time?.length && sampleKeys(tl.time, time, tmp)) c.time += (additive ? tmp[0] : tmp[0] - c.time) * alpha;
    if (tl.mix?.length && sampleKeys(tl.mix, time, tmp)) c.mix += (additive ? tmp[0] : tmp[0] - c.mix) * alpha;
  }

  for (const cid in anim.path ?? {}) {
    const c = skeleton.pathById(cid);
    if (!c || !c.active) continue;
    const tl = anim.path[cid];
    if (tl.position?.length && sampleKeys(tl.position, time, tmp)) c.position += (additive ? tmp[0] : tmp[0] - c.position) * alpha;
    if (tl.spacing?.length && sampleKeys(tl.spacing, time, tmp)) c.spacing += (tmp[0] - c.spacing) * alpha; // Spine never adds spacing
    if (tl.mix?.length && sampleKeys(tl.mix, time, tmp))
      for (let j = 0; j < 3; j++) c.mix[j] += (additive ? tmp[j] : tmp[j] - c.mix[j]) * alpha;
  }

  for (const cid in anim.physics ?? {}) {
    const tl = anim.physics[cid];
    for (const p of PHYSICS_PARAMS) {
      const keys = tl[p];
      if (!keys?.length || !sampleKeys(keys, time, tmp)) continue;
      // only wind and gravity can be added (Spine's timelines say so); the others are always blended
      const add = additive && (p === 'wind' || p === 'gravity');
      for (const c of physicsTargets(skeleton, cid, p)) {
        const cur = c.getParam(p);
        c.setParam(p, cur + (add ? tmp[0] : tmp[0] - cur) * alpha);
      }
    }
  }

  applyDrawOrder(skeleton, anim, time);

  for (const skinId in anim.deform) {
    const skin = skeleton.data.skinById.get(skinId);
    if (!skin) continue;
    for (const slotId in anim.deform[skinId]) {
      const slot = skeleton.slotById(slotId);
      if (!slot || !slot.bone.active) continue;
      const perAtt = anim.deform[skinId][slotId];
      for (const attName in perAtt) {
        const keys = perAtt[attName];
        if (!keys.length) continue;
        const att = skin.attachments[slot.data.index]?.get(attName);
        if (!att || (att.kind !== 'mesh' && att.kind !== 'path') || skeleton.data.deformSource.has(att)) continue;
        const out = sampleDeform(keys, time);
        if (!out || out.length !== att.deformLength) continue;
        for (const target of deformSlots(skeleton, slot, att)) {
          const current = target.deform.length === att.deformLength ? target.deform : new Array<number>(att.deformLength).fill(0);
          target.deform = current.map((c, i) => c + (additive ? out[i] : out[i] - c) * alpha);
        }
      }
    }
  }

  applySequences(skeleton, anim, time, true);
}

/** Interpolates per vertex deform deltas. Returns null before the first key. */
function sampleDeform(keys: Timeline, time: number): number[] | null {
  const i = findKeyIndex(keys, time);
  if (i < 0) return null;
  const k = keys[i];
  if (i === keys.length - 1 || k.curve === 'stepped') return k.value.slice();
  const k2 = keys[i + 1];
  const dt = k2.time - k.time;
  const u = dt > 0 ? (time - k.time) / dt : 0;
  const p = deformProgress(k, u);
  const n = Math.max(k.value.length, k2.value.length);
  const out = new Array<number>(n);
  for (let j = 0; j < n; j++) {
    const a = k.value[j] ?? 0;
    const b = k2.value[j] ?? 0;
    out[j] = a + (b - a) * p;
  }
  return out;
}

/** Events whose time lies in (from, to]. Handles looping by the caller. */
export function eventsBetween(anim: Animation, from: number, to: number) {
  return anim.events.filter((e) => e.time > from && e.time <= to);
}
