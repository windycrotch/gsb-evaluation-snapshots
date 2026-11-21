/**
 * Machinery of the property test (see fuzz.test.ts): random sequences of REAL editor actions — the same functions
 * the UI calls — must never
 *   - throw,
 *   - leave anything for the document validator to repair,
 *   - produce an export the official Spine 4.3 runtime rejects,
 *   - make our solver output non-finite numbers;
 * and at the end of every run
 *   - our solver still agrees with the official runtime on the exported result,
 *   - undoing everything restores the starting document exactly, and redoing everything restores the final one.
 */
import { expect } from 'vitest';
import { bakeAnimation, bakeSkips, constrainedBoneIndices, poseFrames } from '../src/core/bake';
import { applyAnimation, applyPhysicsResets } from '../src/core/animate';
import { exportSpineJson } from '../src/core/export/spineJson';
import { deformProp } from '../src/core/keyrefs';
import { makeLink } from '../src/core/links';
import { resolveSequenceIndex, sequenceFrameNames } from '../src/core/sequence';
import { uid } from '../src/core/ids';
import type { KeyRef } from '../src/core/keyrefs';
import { meshWorldPositions } from '../src/core/mesh';
import {
  SEQUENCE_MODES,
  BLEND_MODES,
  GLOBAL_PHYSICS,
  INHERIT_MODES,
  PATH_POSITION_MODES,
  PATH_ROTATE_MODES,
  PATH_SPACING_MODES,
  PHYSICS_PARAMS,
  TRANSFORM_PROPS,
  pathNodeCount,
  polygonVertexCount,
} from '../src/core/model';
import type { Animation, Influence, MeshAttachment, Project } from '../src/core/model';
import { compileSkeleton, createSkeleton, meshWorldVertices, pointWorld } from '../src/core/skeleton';
import { validateProject } from '../src/core/validate';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { setSettings, settingsStore } from '../src/store/settings';
import * as FO from '../src/store/folderActions';
import * as SK from '../src/store/skeletonActions';
import * as AX from '../src/store/axisActions';
import * as SPL from '../src/store/splitActions';
import * as MK from '../src/store/markerActions';
import * as AT from '../src/store/animToolActions';
import * as LIM from '../src/store/limitActions';
import * as CH from '../src/store/chainActions';
import * as PRE from '../src/store/presetActions';
import * as POSE from '../src/store/poseActions';
import * as POLY from '../src/store/polygonActions';
import * as RV from '../src/store/reviewActions';
import * as PRB from '../src/store/problemActions';
import * as CMT from '../src/store/commentActions';
import { listReview } from '../src/core/review';
import { filterTree } from '../src/core/treeFilter';
import { canFix } from '../src/core/problems';
import { projectWarnings } from '../src/core/stats';
import { reconcileDeform } from '../src/core/edit';
import { compareWithProjectText } from '../src/store/checkpoints';
import { makeComment, serializeReview } from '../src/core/review';
import * as NU from '../src/store/nudgeActions';
import * as SS from '../src/store/selectionSetActions';
import * as CP from '../src/store/checkpoints';
import { diffSkeletons } from '../src/core/checkpoints';
import { softMoves, softWeights } from '../src/core/soft';
import { rotationLimits } from '../src/core/limits';
import { chainBones, CHAIN_PARAMS, CHAIN_SHAPES } from '../src/core/chains';
import { skeletonCount } from '../src/core/skeletons';
import * as I from '../src/store/ikActions';
import * as MX from '../src/store/mixActions';
import * as M from '../src/store/meshActions';
import * as PA from '../src/store/pathActions';
import * as PC from '../src/store/pathConstraintActions';
import * as PH from '../src/store/physicsActions';
import * as PO from '../src/store/poseActions';
import * as P from '../src/store/polygonActions';
import * as SL from '../src/store/sliderActions';
import * as SQ from '../src/store/sequenceActions';
import { sheetSequence } from '../src/core/spritesheet';
import { turnAbout, turnSign } from '../src/core/pivot';
import * as T from '../src/store/transformActions';
import * as RN from '../src/store/renameActions';
import { setKeysAutoCurve } from '../src/store/curveActions';
import { favorSelectedKeys, scaleSelectedKeyTimes, storeSelectedKeys, swapStoredKeys } from '../src/store/keyToolActions';
import { encodeKey } from '../src/core/keyrefs';
import { emptySelection, uiStore } from '../src/store/ui';
import { getScene } from '../src/store/scene';
import { addAttachmentRig, buildFixture } from './fixture';
import { addPathRig } from './pathrig';
import { addPhysicsRig } from './physicsrig';
import { S, exportAndLoad, loadOfficial, startLikeOfficial } from './official';
import { compare as compareBinary, compareReadBack } from './binarykit';

// ------------------------------------------------------------------ tiny deterministic RNG

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Ctx {
  r: () => number;
  pick<T>(list: readonly T[]): T | undefined;
  num(min: number, max: number): number;
  chance(p: number): boolean;
}

function makeCtx(seed: number): Ctx {
  const r = mulberry32(seed);
  return {
    r,
    pick: (list) => (list.length ? list[Math.floor(r() * list.length)] : undefined),
    num: (min, max) => min + r() * (max - min),
    chance: (p) => r() < p,
  };
}

// ------------------------------------------------------------------ document helpers

const project = () => docStore.get();
const doc = () => docStore.get().skeleton;
const NAMES = ['a', 'b', 'bone', 'root', 'head', 'arm', '', '  ', 'x"y', 'ünï', 'bone2', 'torso'];

function meshes() {
  const out: { slotId: string; name: string }[] = [];
  const skin = doc().skins[0];
  for (const slotId in skin.attachments)
    for (const name in skin.attachments[slotId]) if (skin.attachments[slotId][name].type === 'mesh') out.push({ slotId, name });
  return out;
}
/** Every linked mesh of every skin. */
function linkedMeshes() {
  const out: { skinId: string; slotId: string; name: string }[] = [];
  for (const skin of doc().skins)
    for (const slotId in skin.attachments)
      for (const name in skin.attachments[slotId]) {
        const a = skin.attachments[slotId][name];
        if (a.type === 'mesh' && a.link) out.push({ skinId: skin.id, slotId, name });
      }
  return out;
}
function regions() {
  const out: { slotId: string; name: string }[] = [];
  const skin = doc().skins[0];
  for (const slotId in skin.attachments)
    for (const name in skin.attachments[slotId]) if (skin.attachments[slotId][name].type === 'region') out.push({ slotId, name });
  return out;
}
function polygons() {
  const out: { slotId: string; name: string; type: 'clipping' | 'boundingbox' }[] = [];
  const skin = doc().skins[0];
  for (const slotId in skin.attachments) {
    for (const name in skin.attachments[slotId]) {
      const t = skin.attachments[slotId][name].type;
      if (t === 'clipping' || t === 'boundingbox') out.push({ slotId, name, type: t });
    }
  }
  return out;
}
function paths() {
  const out: { slotId: string; name: string }[] = [];
  const skin = doc().skins[0];
  for (const slotId in skin.attachments)
    for (const name in skin.attachments[slotId]) if (skin.attachments[slotId][name].type === 'path') out.push({ slotId, name });
  return out;
}
function points() {
  const out: { slotId: string; name: string }[] = [];
  const skin = doc().skins[0];
  for (const slotId in skin.attachments)
    for (const name in skin.attachments[slotId]) if (skin.attachments[slotId][name].type === 'point') out.push({ slotId, name });
  return out;
}

function allKeyRefs(a: Animation): KeyRef[] {
  const out: KeyRef[] = [];
  for (const id in a.bones)
    for (const prop of Object.keys(a.bones[id]))
      for (const k of (a.bones[id] as Record<string, { time: number }[]>)[prop]) out.push({ kind: 'bone', target: id, prop, time: k.time });
  for (const id in a.slots)
    for (const prop of Object.keys(a.slots[id]))
      for (const k of (a.slots[id] as Record<string, { time: number }[]>)[prop]) out.push({ kind: 'slot', target: id, prop, time: k.time });
  for (const id in a.ik) for (const k of a.ik[id]) out.push({ kind: 'ik', target: id, prop: '', time: k.time });
  for (const id in a.transform) for (const k of a.transform[id]) out.push({ kind: 'transform', target: id, prop: '', time: k.time });
  for (const id in a.slider)
    for (const prop of Object.keys(a.slider[id]))
      for (const k of (a.slider[id] as Record<string, { time: number }[]>)[prop])
        out.push({ kind: 'slider', target: id, prop, time: k.time });
  for (const id in a.path)
    for (const prop of Object.keys(a.path[id]))
      for (const k of (a.path[id] as Record<string, { time: number }[]>)[prop]) out.push({ kind: 'path', target: id, prop, time: k.time });
  for (const id in a.physics)
    for (const prop of Object.keys(a.physics[id]))
      for (const k of (a.physics[id] as Record<string, { time: number }[]>)[prop])
        out.push({ kind: 'physics', target: id, prop, time: k.time });
  for (const skinId in a.deform)
    for (const slotId in a.deform[skinId])
      for (const att in a.deform[skinId][slotId])
        for (const k of a.deform[skinId][slotId][att])
          out.push({ kind: 'deform', target: slotId, prop: deformProp(skinId, att), time: k.time });
  for (const k of a.drawOrder) out.push({ kind: 'drawOrder', target: '', prop: '', time: k.time });
  for (const id in a.drawOrderFolder ?? {})
    for (const k of a.drawOrderFolder![id]) out.push({ kind: 'drawOrderFolder', target: id, prop: '', time: k.time });
  for (const k of a.events) out.push({ kind: 'event', target: '', prop: '', time: k.time });
  return out;
}

// ------------------------------------------------------------------ the operations

type Op = { name: string; run: (c: Ctx) => void };

const ops: Op[] = [
  // ---- bones
  {
    name: 'createBone',
    run: (c) => {
      const p = c.pick(doc().bones)!;
      const x = c.num(-200, 200);
      const y = c.num(-200, 200);
      A.createBoneWorld({ parent: p.id, x, y, tipX: x + c.num(-90, 90), tipY: y + c.num(-90, 90) });
    },
  },
  {
    name: 'renameBone',
    run: (c) => {
      const b = c.pick(doc().bones)!;
      A.renameBone(b.id, c.pick(NAMES)!);
    },
  },
  {
    name: 'deleteBones',
    run: (c) => {
      const n = 1 + Math.floor(c.r() * 2);
      A.deleteBones(Array.from({ length: n }, () => c.pick(doc().bones)!.id));
    },
  },
  {
    name: 'reparentBone',
    run: (c) => {
      const b = c.pick(doc().bones)!;
      const p = c.chance(0.1) ? null : c.pick(doc().bones)!.id;
      A.reparentBone(b.id, p);
    },
  },
  {
    name: 'setBoneProps',
    run: (c) => {
      const b = c.pick(doc().bones)!;
      A.setBoneProps(b.id, { length: c.num(0, 120), inherit: c.pick(INHERIT_MODES)!, hidden: c.chance(0.2) });
    },
  },
  {
    name: 'setBonePose',
    run: (c) => {
      const b = c.pick(doc().bones)!;
      A.setBonePose([
        {
          id: b.id,
          props: c.chance(0.5)
            ? { rotation: c.num(-180, 180) }
            : { x: c.num(-100, 100), y: c.num(-100, 100), scaleX: c.num(-2, 2), scaleY: c.num(0.2, 2), shearX: c.num(-30, 30) },
        },
      ]);
    },
  },
  {
    name: 'splitBone',
    run: (c) => {
      A.setMode('setup');
      const b = c.pick(doc().bones)!;
      SPL.splitBone(b.id, 2 + Math.floor(c.r() * 3), {
        nested: c.chance(0.7),
        fibonacci: c.chance(0.3),
        weights: c.pick(['keep', 'split', 'blend'] as const),
      });
    },
  },
  {
    name: 'rotationLimit',
    run: (c) => {
      A.setMode(c.chance(0.7) ? 'setup' : 'animate');
      const k = c.r();
      const limits = rotationLimits(doc());
      if (k < 0.45) LIM.addLimit(c.pick(doc().bones)!.id, c.num(10, 120));
      else if (k < 0.6 && limits.length) LIM.removeLimit(c.pick(limits)!.bone);
      else if (k < 0.8 && limits.length) {
        const l = c.pick(limits)!;
        const lo = c.num(-170, 0);
        LIM.setLimit(l.bone, lo, lo + c.num(5, 180));
      } else if (limits.length) {
        const l = c.pick(limits)!;
        A.setBonePose([{ id: c.chance(0.5) ? l.bone : l.control, props: { rotation: c.num(-300, 300) } }]);
      }
    },
  },
  {
    name: 'tween',
    run: (c) => {
      A.setMode('animate');
      A.setTime(c.num(0, 2));
      A.selectBone(c.pick(doc().bones)!.id);
      AT.tweenSelected(c.num(-0.3, 1.3));
    },
  },
  {
    name: 'constraintPreset',
    run: (c) => {
      const all = doc().constraints;
      const from = c.pick(all);
      if (!from) return;
      const to = c.pick(all.filter((x) => x.type === from.type));
      if (process.env.SKIP_PRESET) return;
      const preset = PRE.savePreset(from.id, `fuzz ${from.type}`);
      if (preset && to) PRE.applyPreset(to.id, preset.id);
      PRE.deletePreset(preset!.id);
    },
  },
  {
    name: 'nudge',
    run: (c) => {
      A.setMode(c.chance(0.6) ? 'setup' : 'animate');
      A.setTime(c.num(0, 2));
      A.setSelection({ bones: [c.pick(doc().bones)!.id, c.pick(doc().bones)!.id] });
      const dx = c.num(-12, 12);
      const dy = c.num(-12, 12);
      if (!process.env.SKIP_NUDGE) NU.nudgeBones(dx, dy);
    },
  },
  {
    name: 'selectionSet',
    run: (c) => {
      A.setSelection({ bones: [c.pick(doc().bones)!.id, c.pick(doc().bones)!.id] });
      const id = SS.saveSelectionSet();
      if (id) {
        A.setSelection({});
        SS.selectSet(id);
        if (c.chance(0.3)) SS.deleteSelectionSet(id);
      }
    },
  },
  {
    name: 'softMove',
    run: (c) => {
      const m = c.pick(meshes());
      if (!m) return;
      const { mats, slotMat } = M.setupMats();
      const w = meshWorldPositions(M.getMesh(m.slotId, m.name)!, slotMat(m.slotId), mats);
      const n = w.length / 2;
      const picked = Array.from({ length: 1 + Math.floor(c.r() * 3) }, () => Math.floor(c.r() * n));
      M.moveMeshVertices(
        m.slotId,
        m.name,
        softMoves(
          w,
          softWeights(w, picked, c.num(0, 120), c.pick(['smooth', 'linear', 'sharp'] as const)!),
          c.num(-30, 30),
          c.num(-30, 30),
        ),
      );
    },
  },
  { name: 'checkpoint', run: () => void CP.markCheckpoint() },
  {
    name: 'backToCheckpoint',
    run: (c) => {
      const cp = c.pick(CP.checkpointsOfActive());
      if (!cp) return;
      if (
        CP.restoreCheckpoint(cp.id) &&
        (docStore.get().skeleton !== cp.skeleton || diffSkeletons(cp.skeleton, docStore.get().skeleton).length)
      )
        throw new Error('a restored checkpoint differs from what was marked');
      getScene();
    },
  },
  {
    name: 'skinMix',
    run: (c) => {
      const s = c.pick(doc().skins);
      if (s) A.toggleSkinMix(s.id);
      getScene();
    },
  },
  {
    name: 'swapSides',
    run: (c) => {
      A.setMode(c.chance(0.6) ? 'animate' : 'setup');
      if (c.chance(0.5)) A.selectBone(c.pick(doc().bones)!.id);
      PO.swapSides();
    },
  },
  {
    name: 'chainCurve',
    run: (c) => {
      A.setMode('setup');
      const ids = chainBones(doc(), [c.pick(doc().bones)!.id]);
      CH.applyChainCurve(ids, {
        param: c.pick(CHAIN_PARAMS)!,
        from: c.num(-1, 400),
        to: c.num(-1, 400),
        shape: c.pick(CHAIN_SHAPES)!,
        power: c.num(0.25, 6),
        create: c.chance(0.7),
      });
    },
  },
  {
    name: 'marker',
    run: (c) => {
      A.setMode('animate');
      A.setTime(c.num(0, 2));
      const id = MK.addMarkerAtPlayhead();
      MK.closeMarkerDialog();
      if (id && c.chance(0.3)) MK.splitAtMarkersAction();
      else if (id && c.chance(0.3)) MK.deleteMarker(id);
    },
  },
  {
    name: 'animTool',
    run: (c) => {
      A.setMode('animate');
      const k = c.r();
      if (k < 0.4) AT.mirrorCurrentCycle({ flipCentre: c.chance(0.5) });
      else if (k < 0.7) AT.hideUnkeyedBones();
      else
        AT.wiggleSelected({
          amount: c.num(0, 5),
          every: 1 + Math.floor(c.r() * 6),
          seed: Math.floor(c.r() * 100),
          smooth: c.chance(0.5),
          keepEnds: c.chance(0.5),
        });
    },
  },
  {
    name: 'splitAxes',
    run: (c) => {
      A.setMode('animate');
      AX.setAxesSplit([c.pick(doc().bones)!.id], c.pick(['translate', 'scale', 'shear'] as const)!, c.chance(0.7));
    },
  },
  {
    name: 'setBoneAxis',
    run: (c) => {
      A.setMode('animate');
      const b = c.pick(doc().bones)!;
      const axis = c.pick([
        { x: c.num(-100, 100) },
        { y: c.num(-100, 100) },
        { scaleX: c.num(-2, 2) },
        { scaleY: c.num(0.2, 2) },
        { shearX: c.num(-30, 30) },
        { shearY: c.num(-30, 30) },
      ])!;
      A.setBonePose([{ id: b.id, props: axis }]);
    },
  },
  {
    name: 'keySelectedBones',
    run: (c) => {
      A.selectBone(c.pick(doc().bones)!.id);
      A.keySelectedBones(c.chance(0.5) ? ['rotate'] : undefined);
    },
  },
  {
    name: 'duplicateBones',
    run: (c) => {
      A.setMode('setup');
      A.selectBone(c.pick(doc().bones)!.id);
      PO.duplicateSelection(c.chance(0.5));
    },
  },
  {
    name: 'resetPose',
    run: (c) => {
      A.setMode('animate');
      A.selectBone(c.pick(doc().bones)!.id);
      PO.resetPose();
    },
  },
  {
    name: 'copyPastePose',
    run: (c) => {
      A.setMode('animate');
      A.setSelection({ bones: [c.pick(doc().bones)!.id, c.pick(doc().bones)!.id] });
      PO.copyPose();
      A.selectBone(c.pick(doc().bones)!.id);
      PO.pastePose();
    },
  },
  {
    name: 'poseLibrary',
    run: (c) => {
      A.setSelection({ bones: c.chance(0.3) ? [] : [c.pick(doc().bones)!.id, c.pick(doc().bones)!.id] });
      const made = PO.savePose(c.pick(NAMES));
      const t = made ?? c.pick(project().poses ?? []);
      if (t && c.chance(0.7)) {
        A.setMode(c.chance(0.5) ? 'animate' : 'setup');
        A.selectBone(c.pick(doc().bones)!.id);
        PO.applyPose(t.id, c.chance(0.5) ? 1 : c.r());
      }
      if (t && c.chance(0.3)) PO.renamePose(t.id, c.pick(NAMES)!);
      if (t && c.chance(0.2)) PO.overwritePose(t.id);
      if (t && c.chance(0.2)) PO.deletePose(t.id);
    },
  },
  // ---- slots / images / attachments
  {
    name: 'addImageToScene',
    run: (c) => {
      const img = c.pick(project().images);
      if (img) A.addImageToScene(img.name, c.num(-150, 150), c.num(-50, 250), c.chance(0.5) ? c.pick(doc().bones)!.id : null);
    },
  },
  {
    name: 'setSlotProps',
    run: (c) => {
      const s = c.pick(doc().slots);
      if (s)
        A.setSlotProps(s.id, { blend: c.pick(BLEND_MODES)!, hidden: c.chance(0.2), dark: c.chance(0.3) ? [c.r(), c.r(), c.r()] : null });
    },
  },
  {
    name: 'renameSlot',
    run: (c) => {
      const s = c.pick(doc().slots);
      if (s) A.renameSlot(s.id, c.pick(NAMES)!);
    },
  },
  {
    name: 'deleteSlots',
    run: (c) => {
      const s = c.pick(doc().slots);
      if (s) A.deleteSlots([s.id]);
    },
  },
  {
    name: 'setSlotFolder',
    run: (c) => {
      const s = c.pick(doc().slots);
      if (!s) return;
      const f = c.pick(doc().drawOrderFolders ?? []);
      const r = c.r();
      FO.setSlotFolder(s.id, r < 0.3 ? 'new' : r < 0.45 ? null : (f?.id ?? 'new'));
    },
  },
  {
    name: 'deleteFolder',
    run: (c) => {
      const f = c.pick(doc().drawOrderFolders ?? []);
      if (f && c.chance(0.4)) FO.deleteFolder(f.id);
    },
  },
  {
    name: 'renameFolder',
    run: (c) => {
      const f = c.pick(doc().drawOrderFolders ?? []);
      if (f) FO.renameFolder(f.id, c.chance(0.5) ? 'wings' : 'tail');
    },
  },
  {
    name: 'moveSlot',
    run: (c) => {
      const s = c.pick(doc().slots);
      if (s) A.moveSlot(s.id, Math.floor(c.r() * (doc().slots.length + 1)));
    },
  },
  {
    name: 'setSlotBone',
    run: (c) => {
      const s = c.pick(doc().slots);
      if (s) A.setSlotBone(s.id, c.pick(doc().bones)!.id);
    },
  },
  {
    name: 'setSlotAttachment',
    run: (c) => {
      const s = c.pick(doc().slots);
      if (!s) return;
      const names = Object.keys(doc().skins[0].attachments[s.id] ?? {});
      A.setSlotAttachment(s.id, c.chance(0.2) ? null : (c.pick(names) ?? null));
    },
  },
  {
    name: 'setSlotColor',
    run: (c) => {
      const s = c.pick(doc().slots);
      if (s) A.setSlotColor(s.id, [c.r(), c.r(), c.r(), c.r()]);
    },
  },
  {
    name: 'setSlotColors',
    run: (c) => {
      const s = c.pick(doc().slots);
      if (s) A.setSlotColor(s.id, [c.r(), c.r(), c.r(), c.r()], [c.r(), c.r(), c.r()]);
    },
  }, // light + dark (two-color tinting)
  {
    name: 'deleteAttachment',
    run: (c) => {
      const a = c.pick([...meshes(), ...regions(), ...polygons(), ...points(), ...paths()]);
      if (a) A.deleteAttachment(a.slotId, a.name);
    },
  },
  {
    name: 'setAttachmentProps',
    run: (c) => {
      const a = c.pick(regions());
      if (a) A.setAttachmentProps(a.slotId, a.name, { x: c.num(-40, 40), rotation: c.num(-90, 90), scaleX: c.num(0.5, 2) });
    },
  },
  // ---- clipping / bounding box / point attachments
  {
    name: 'createPolygon',
    run: (c) => {
      A.selectBone(c.pick(doc().bones)!.id);
      const n = 3 + Math.floor(c.r() * 4);
      const pts = Array.from({ length: n }, () => [c.num(-150, 150), c.num(-50, 250)] as [number, number]);
      P.createPolygon(c.chance(0.5) ? 'clipping' : 'boundingbox', pts);
    },
  },
  {
    name: 'createPoint',
    run: (c) => {
      A.selectBone(c.pick(doc().bones)!.id);
      P.createPoint(c.num(-150, 150), c.num(-50, 250));
    },
  },
  {
    name: 'movePolygonVertices',
    run: (c) => {
      const a = c.pick(polygons());
      if (!a) return;
      const n = polygonVertexCount(P.getPolygon(a.slotId, a.name)!);
      P.movePolygonVertices(a.slotId, a.name, [{ index: Math.floor(c.r() * n), x: c.num(-100, 100), y: c.num(-100, 200) }]);
    },
  },
  {
    name: 'addPolygonVertex',
    run: (c) => {
      const a = c.pick(polygons());
      if (a) P.addPolygonVertex(a.slotId, a.name, c.num(-100, 100), c.num(-100, 200));
    },
  },
  {
    name: 'deletePolygonVertices',
    run: (c) => {
      const a = c.pick(polygons());
      if (!a) return;
      const n = polygonVertexCount(P.getPolygon(a.slotId, a.name)!);
      P.deletePolygonVertices(a.slotId, a.name, [Math.floor(c.r() * n), Math.floor(c.r() * n)]);
    },
  },
  {
    name: 'setClipping',
    run: (c) => {
      const a = c.pick(polygons().filter((x) => x.type === 'clipping'));
      if (a)
        A.setAttachmentProps(a.slotId, a.name, {
          end: c.chance(0.25) ? null : (c.pick(doc().slots)?.id ?? null),
          convex: c.chance(0.5),
          inverse: c.chance(0.4),
        });
    },
  },
  {
    name: 'setPointProps',
    run: (c) => {
      const a = c.pick(points());
      if (a) A.setAttachmentProps(a.slotId, a.name, { x: c.num(-50, 50), y: c.num(-50, 50), rotation: c.num(-180, 180) });
    },
  },
  // ---- path attachments and path constraints
  {
    name: 'createPath',
    run: (c) => {
      A.selectBone(c.pick(doc().bones)!.id);
      const n = 2 + Math.floor(c.r() * 4);
      const nodes = Array.from({ length: n }, () => {
        const x = c.num(-200, 200);
        const y = c.num(-100, 250);
        return { x, y, inX: x - c.num(-60, 60), inY: y - c.num(-60, 60), outX: x + c.num(-60, 60), outY: y + c.num(-60, 60) };
      });
      PA.createPath(nodes, c.chance(0.4));
    },
  },
  {
    name: 'movePathPoints',
    run: (c) => {
      const a = c.pick(paths());
      if (!a) return;
      const n = polygonVertexCount(PA.getPath(a.slotId, a.name)!);
      P.movePolygonVertices(a.slotId, a.name, [{ index: Math.floor(c.r() * n), x: c.num(-150, 150), y: c.num(-100, 250) }]);
    },
  },
  {
    name: 'insertPathNode',
    run: (c) => {
      const a = c.pick(paths());
      if (a) PA.insertPathNode(a.slotId, a.name, c.num(-150, 150), c.num(-100, 250));
    },
  },
  {
    name: 'deletePathNodes',
    run: (c) => {
      const a = c.pick(paths());
      if (!a) return;
      const n = pathNodeCount(PA.getPath(a.slotId, a.name)!);
      PA.deletePathNodes(a.slotId, a.name, [Math.floor(c.r() * n), Math.floor(c.r() * n)]);
    },
  },
  {
    name: 'setPathClosed',
    run: (c) => {
      const a = c.pick(paths());
      if (a) PA.setPathClosed(a.slotId, a.name, c.chance(0.5));
    },
  },
  {
    name: 'bindPathToBones',
    run: (c) => {
      const a = c.pick(paths());
      if (a)
        PA.bindPathToBones(
          a.slotId,
          a.name,
          Array.from({ length: 1 + Math.floor(c.r() * 3) }, () => c.pick(doc().bones)!.id),
        );
    },
  },
  {
    name: 'unbindPath',
    run: (c) => {
      const a = c.pick(paths());
      if (a) PA.unbindPath(a.slotId, a.name);
    },
  },
  {
    name: 'setPathFlags',
    run: (c) => {
      const a = c.pick(paths());
      if (a) A.setAttachmentProps(a.slotId, a.name, { constantSpeed: c.chance(0.5) });
    },
  },
  {
    name: 'createPathConstraint',
    run: (c) => {
      const p = c.pick(paths());
      if (!p) return;
      A.setSelection({
        slot: p.slotId,
        attachment: p.name,
        bones: Array.from({ length: 1 + Math.floor(c.r() * 3) }, () => c.pick(doc().bones)!.id),
      });
      PC.createPathConstraint();
    },
  },
  {
    name: 'updatePathConstraint',
    run: (c) => {
      const k = c.pick(doc().constraints.filter((x) => x.type === 'path'));
      if (k)
        PC.updatePathConstraint(k.id, (x) => {
          x.positionMode = c.pick(PATH_POSITION_MODES)!;
          x.spacingMode = c.pick(PATH_SPACING_MODES)!;
          x.rotateMode = c.pick(PATH_ROTATE_MODES)!;
          x.offsetRotation = c.num(-90, 90);
          x.mix = { rotate: c.r(), x: c.r(), y: c.r() };
          if (c.chance(0.3)) x.target = c.pick(doc().slots)!.id;
        });
    },
  },
  {
    name: 'setPathValues',
    run: (c) => {
      const k = c.pick(doc().constraints.filter((x) => x.type === 'path'));
      if (k)
        PC.setPathValues(k.id, {
          position: c.chance(0.5) ? c.num(-0.5, 1.5) : c.num(-100, 400),
          spacing: c.num(-20, 60),
          ...(c.chance(0.5) ? { mix: { rotate: c.r(), x: c.r(), y: c.r() } } : {}),
        });
    },
  },
  // ---- physics constraints
  {
    name: 'createPhysicsConstraint',
    run: (c) => {
      A.selectBone(c.pick(doc().bones)!.id);
      PH.createPhysicsConstraint();
    },
  },
  {
    name: 'updatePhysicsConstraint',
    run: (c) => {
      const k = c.pick(doc().constraints.filter((x) => x.type === 'physics'));
      if (k)
        PH.updatePhysicsConstraint(k.id, (x) => {
          x.x = c.chance(0.5) ? c.r() : 0;
          x.y = c.chance(0.5) ? c.r() : 0;
          x.rotate = c.chance(0.6) ? c.r() : 0;
          x.scaleX = c.chance(0.3) ? c.r() : 0;
          x.shearX = c.chance(0.3) ? c.r() : 0;
          x.scaleY = c.pick(['none', 'uniform', 'volume'] as const)!;
          x.limit = c.chance(0.3) ? c.num(0, 100) : 5000;
          x.fps = c.pick([15, 30, 60, 120] as const)!;
          x.global[c.pick(PHYSICS_PARAMS)!] = c.chance(0.5);
          if (c.chance(0.2)) x.bone = c.pick(doc().bones)!.id;
        });
    },
  },
  {
    name: 'setPhysicsValue',
    run: (c) => {
      const k = c.pick(doc().constraints.filter((x) => x.type === 'physics'));
      if (k) {
        const p = c.pick(PHYSICS_PARAMS)!;
        const range: Record<typeof p, [number, number]> = {
          inertia: [0, 1],
          strength: [0, 200],
          damping: [0, 1],
          mass: [0.3, 10],
          wind: [-40, 40],
          gravity: [-40, 40],
          mix: [0, 1.2],
        };
        PH.setPhysicsValue(k.id, p, c.num(range[p][0], range[p][1]));
      }
    },
  },
  {
    name: 'addPhysicsReset',
    run: (c) => {
      const k = c.pick(doc().constraints.filter((x) => x.type === 'physics'));
      if (k) {
        A.setMode('animate');
        PH.addPhysicsReset(c.chance(0.2) ? GLOBAL_PHYSICS : k.id);
      }
    },
  },
  // ---- skins / events
  {
    name: 'createSkin',
    run: (c) => {
      A.createSkin(c.pick(NAMES));
    },
  },
  {
    name: 'renameSkin',
    run: (c) => {
      const s = c.pick(doc().skins)!;
      A.renameSkin(s.id, c.pick(NAMES)!);
    },
  },
  {
    name: 'deleteSkin',
    run: (c) => {
      A.deleteSkin(c.pick(doc().skins)!.id);
    },
  },
  {
    name: 'setSkinImage',
    run: (c) => {
      const s = c.pick(doc().skins.slice(1));
      const r = c.pick(regions());
      const img = c.pick(project().images);
      if (s && r && img) A.setSkinImage(s.id, r.slotId, r.name, img.name);
    },
  },
  // a skin from pictures: pictures named like attachments with a prefix are added, then the skin is made (more pictures later add to the same skin)
  {
    name: 'skinFromImages',
    run: (c) => {
      const prefix = `fz${Math.floor(c.num(0, 3))}`;
      const picked = [...regions(), ...meshes()].filter(() => c.chance(0.5)).slice(0, 4);
      const seps = picked.map(() => c.pick(['/', '-', '_'])!);
      docStore.update('fuzz skin pictures', (d) => {
        picked.forEach((t, i) => {
          const name = `${prefix}${seps[i]}${t.name}`;
          if (!d.images.some((im) => im.name === name)) d.images.push({ id: uid(), name, width: 16, height: 16 });
        });
      });
      A.createSkinFromImages(prefix);
    },
  },
  // a linked mesh: the skin picture of a mesh, and a mesh in another slot that follows one
  {
    name: 'setSkinImageMesh',
    run: (c) => {
      const s = c.pick(doc().skins.slice(1));
      const m = c.pick(meshes());
      const img = c.pick(project().images);
      if (s && m && img) A.setSkinImage(s.id, m.slotId, m.name, img.name);
    },
  },
  {
    name: 'linkMeshAcrossSlots',
    run: (c) => {
      const m = c.pick(meshes());
      const slot = c.pick(doc().slots);
      const img = c.pick(project().images);
      if (!m || !slot || !img) return;
      const src = doc().skins[0].attachments[m.slotId][m.name];
      if (src.type !== 'mesh' || src.link) return;
      const name = `link${Math.floor(c.r() * 1000)}`;
      if (doc().skins[0].attachments[slot.id]?.[name]) return;
      const copy = {
        ...structuredClone(src),
        name,
        path: img.name,
        link: makeLink(doc(), slot.id, { skinId: doc().skins[0].id, slotId: m.slotId, name: m.name }, c.chance(0.7)),
      };
      delete copy.sequence;
      docStore.update('Link mesh', (d) => {
        (d.skeleton.skins[0].attachments[slot.id] ??= {})[name] = copy;
      });
    },
  },
  {
    name: 'linkDeform',
    run: (c) => {
      const l = c.pick(linkedMeshes());
      if (l) A.setLinkDeform(l.skinId, l.slotId, l.name, c.chance(0.5));
    },
  },
  {
    name: 'unlinkMesh',
    run: (c) => {
      const l = c.pick(linkedMeshes());
      if (l) A.unlinkMesh(l.skinId, l.slotId, l.name);
    },
  },
  {
    name: 'removeSkinImage',
    run: (c) => {
      const s = c.pick(doc().skins.slice(1));
      const r = c.pick(regions());
      if (s && r) A.removeSkinImage(s.id, r.slotId, r.name);
    },
  },
  {
    name: 'duplicateSkin',
    run: (c) => {
      A.duplicateSkinAction(c.pick(doc().skins)!.id, { scope: c.chance(0.7), animations: c.chance(0.7), relink: c.chance(0.7) });
    },
  },
  {
    name: 'skinPin',
    run: (c) => {
      A.toggleSkinPin(c.pick(doc().skins)!.id);
    },
  },
  // store the values of some keys, change them, swap
  {
    name: 'storeSwapKeys',
    run: (c) => {
      const a = A.currentAnimation();
      if (!a) return;
      uiStore.patch({
        selectedKeys: allKeyRefs(a)
          .filter(() => c.chance(0.4))
          .map(encodeKey),
      });
      storeSelectedKeys();
      if (c.chance(0.5)) favorSelectedKeys('neutral', c.num(0.1, 1));
      swapStoredKeys();
      uiStore.patch({ selectedKeys: [] });
    },
  },
  {
    name: 'skinRequiredBone',
    run: (c) => {
      A.setSkinRequiredAction('bone', c.pick(doc().bones)!.id, c.chance(0.7));
    },
  },
  {
    name: 'skinRequiredConstraint',
    run: (c) => {
      const k = c.pick(doc().constraints);
      if (k) A.setSkinRequiredAction('constraint', k.id, c.chance(0.7));
    },
  },
  {
    name: 'skinScopeBone',
    run: (c) => {
      const s = c.pick(doc().skins);
      const b = c.pick(doc().bones);
      if (s && b) A.setSkinScopeAction(s.id, 'bone', b.id, c.chance(0.7));
    },
  },
  {
    name: 'skinScopeConstraint',
    run: (c) => {
      const s = c.pick(doc().skins);
      const k = c.pick(doc().constraints);
      if (s && k) A.setSkinScopeAction(s.id, 'constraint', k.id, c.chance(0.7));
    },
  },
  {
    name: 'toggleSkinOverride',
    run: (c) => {
      const s = c.pick(doc().skins.slice(1));
      const r = c.pick(regions());
      if (s && r) A.toggleSkinOverride(s.id, r.slotId, r.name);
    },
  },
  {
    name: 'renameImage',
    run: (c) => {
      const img = c.pick(project().images);
      if (img) A.renameImageAction(img.name, c.chance(0.5) ? `folder/${c.pick(NAMES)}` : c.pick(NAMES)!);
    },
  },
  {
    name: 'removeUnusedImages',
    run: () => {
      A.removeUnusedImages();
    },
  },
  {
    name: 'setActiveSkin',
    run: (c) => {
      A.setActiveSkin(c.chance(0.3) ? null : c.pick(doc().skins)!.id);
    },
  },
  {
    name: 'createEvent',
    run: (c) => {
      A.createEvent(c.pick(NAMES));
    },
  },
  {
    name: 'updateEvent',
    run: (c) => {
      const e = c.pick(doc().events);
      if (e) A.updateEvent(e.id, { name: c.pick(NAMES)!, int: c.num(-5, 5), float: c.num(-3, 3), string: c.pick(NAMES)! });
    },
  },
  {
    name: 'deleteEvent',
    run: (c) => {
      const e = c.pick(doc().events);
      if (e) A.deleteEvent(e.id);
    },
  },
  {
    name: 'keyEvent',
    run: (c) => {
      const e = c.pick(doc().events);
      if (e) {
        A.setMode('animate');
        A.keyEvent(e.id);
      }
    },
  },
  {
    name: 'eventSound',
    run: (c) => {
      const e = c.pick(doc().events);
      if (!e) return;
      A.updateEvent(e.id, { audio: c.chance(0.2) ? '' : c.pick(['a.ogg', 'sfx/b.wav', 'c d.mp3'])!, volume: c.r(), balance: c.num(-1, 1) });
      const a = A.currentAnimation();
      if (a && a.events.length && c.chance(0.5))
        docStore.update('fuzz event key', (d) => {
          const an = d.skeleton.animations.find((x) => x.id === a.id);
          const k = an ? c.pick(an.events) : undefined;
          if (k) {
            k.volume = c.r();
            k.balance = c.num(-1, 1);
          }
        });
    },
  },
  // ---- meshes and weights
  {
    name: 'convertToMesh',
    run: (c) => {
      const r = c.pick(regions());
      if (r) M.convertToMesh(r.slotId, r.name, 'quad');
    },
  },
  {
    name: 'addMeshVertex',
    run: (c) => {
      const m = c.pick(meshes());
      if (!m) return;
      const { mats, slotMat } = M.setupMats();
      const w = meshWorldPositions(M.getMesh(m.slotId, m.name)!, slotMat(m.slotId), mats);
      const i = Math.floor(c.r() * (w.length / 2));
      M.addMeshVertex(m.slotId, m.name, w[i * 2] + c.num(-30, 30), w[i * 2 + 1] + c.num(-30, 30));
    },
  },
  {
    name: 'deleteMeshVertices',
    run: (c) => {
      const m = c.pick(meshes());
      if (!m) return;
      const n = M.getMesh(m.slotId, m.name)!.uvs.length / 2;
      M.deleteMeshVertices(m.slotId, m.name, [Math.floor(c.r() * n), Math.floor(c.r() * n)]);
    },
  },
  {
    name: 'retriangulateMesh',
    run: (c) => {
      const m = c.pick(meshes());
      if (m) M.retriangulateMesh(m.slotId, m.name);
    },
  },
  {
    name: 'moveMeshVertices',
    run: (c) => {
      const m = c.pick(meshes());
      if (!m) return;
      const n = M.getMesh(m.slotId, m.name)!.uvs.length / 2;
      M.moveMeshVertices(m.slotId, m.name, [{ index: Math.floor(c.r() * n), x: c.num(-100, 100), y: c.num(-100, 100) }]);
    },
  },
  {
    name: 'bindMeshToBones',
    run: (c) => {
      const m = c.pick(meshes());
      if (m)
        M.bindMeshToBones(
          m.slotId,
          m.name,
          Array.from({ length: 1 + Math.floor(c.r() * 3) }, () => c.pick(doc().bones)!.id),
        );
    },
  },
  {
    name: 'unbindMeshFromBones',
    run: (c) => {
      const m = c.pick(meshes());
      if (m) M.unbindMeshFromBones(m.slotId, m.name);
    },
  },
  {
    name: 'autoWeightMesh',
    run: (c) => {
      const m = c.pick(meshes());
      if (m) M.autoWeightMesh(m.slotId, m.name);
    },
  },
  {
    name: 'pruneMeshWeights',
    run: (c) => {
      const m = c.pick(meshes());
      if (m) M.pruneMeshWeights(m.slotId, m.name, c.num(0, 0.4), 1 + Math.floor(c.r() * 4));
    },
  },
  {
    name: 'toggleMeshEdge',
    run: (c) => {
      const m = c.pick(meshes());
      if (!m) return;
      const n = M.getMesh(m.slotId, m.name)!.uvs.length / 2;
      M.toggleMeshEdge(m.slotId, m.name, Math.floor(c.r() * n), Math.floor(c.r() * n));
    },
  },
  {
    name: 'clearMeshEdges',
    run: (c) => {
      const m = c.pick(meshes());
      if (m && c.chance(0.3)) M.clearMeshEdges(m.slotId, m.name);
    },
  },
  {
    name: 'removeBoneFromMesh',
    run: (c) => {
      const m = c.pick(meshes());
      const w = m && M.getMesh(m.slotId, m.name)?.weights;
      if (m && w) M.removeBoneFromMesh(m.slotId, m.name, c.pick(w.flat())?.[0] ?? doc().bones[0].id);
    },
  },
  {
    name: 'updateMeshBindings',
    run: (c) => {
      const m = c.pick(meshes());
      if (m) M.updateMeshBindings(m.slotId, m.name);
    },
  },
  {
    name: 'weldMeshWeights',
    run: (c) => {
      const m = c.pick(meshes());
      const o = c.pick(meshes());
      if (m && o) M.weldMeshWeights(m.slotId, m.name, o.slotId, o.name, c.chance(0.5) ? 'all' : 'overlapping');
    },
  },
  {
    name: 'mirrorMeshWeights',
    run: (c) => {
      const m = c.pick(meshes());
      if (m) M.mirrorMeshWeights(m.slotId, m.name, c.chance(0.5));
    },
  },
  {
    name: 'smoothMeshWeights',
    run: (c) => {
      const m = c.pick(meshes());
      if (m) M.smoothMeshWeights(m.slotId, m.name, 1 + Math.floor(c.r() * 3));
    },
  },
  {
    name: 'paintWeights',
    run: (c) => {
      const m = c.pick(meshes());
      if (!m) return;
      const bone = c.pick(doc().bones)!.id;
      uiStore.patch({
        brush: {
          size: c.num(10, 300),
          strength: c.num(0.1, 1),
          mode: c.pick(['add', 'subtract', 'smooth', 'replace'] as const)!,
          bone,
          feather: c.pick([0, 30, 100])!,
          shape: c.pick(['soft', 'linear', 'smooth', 'sharp'] as const)!,
          curve: c.pick(['linear', 'fine', 'bold'] as const)!,
          locked: doc()
            .bones.filter(() => c.r() < 0.2)
            .map((b) => b.id),
        },
      });
      const { mats, slotMat } = M.setupMats();
      const w = meshWorldPositions(M.getMesh(m.slotId, m.name)!, slotMat(m.slotId), mats);
      const i = Math.floor(c.r() * (w.length / 2));
      M.paintWeights(m.slotId, m.name, { x: w[i * 2], y: w[i * 2 + 1] }, bone);
    },
  },
  {
    name: 'setDeformKey',
    run: (c) => {
      A.setMode('animate');
      const sc = getScene();
      const cands = sc.skeleton.slots.filter((s) => {
        const k = sc.skeleton.slotAttachment(s)?.kind;
        return k === 'mesh' || k === 'path';
      });
      const s = c.pick(cands);
      if (!s) return;
      const att = sc.skeleton.slotAttachment(s)!;
      const base = M.currentDeform(s.data.id);
      if (!base) return;
      M.setDeformKey(s.data.id, att.name, base, [
        {
          index: Math.floor(c.r() * (att.kind === 'mesh' || att.kind === 'path' ? att.vertexCount : 1)),
          dx: c.num(-20, 20),
          dy: c.num(-20, 20),
        },
      ]);
    },
  },
  // ---- constraints
  {
    name: 'createIkFromDrag',
    run: (c) => {
      const end = c.pick(doc().bones)!;
      const target = c.chance(0.5) ? c.pick(doc().bones)!.id : null;
      I.createIkFromDrag(end.id, target, c.num(-150, 150), c.num(-50, 250), c.chance(0.3));
    },
  },
  {
    name: 'createTransformConstraint',
    run: (c) => {
      const target = c.pick(doc().bones)!;
      const source = c.pick(doc().bones)!;
      T.createTransformConstraint([target.id], source.id, c.pick(['rotation', 'mirror', 'position', 'scale', 'rotateToX'] as const)!);
    },
  },
  {
    name: 'deleteConstraint',
    run: (c) => {
      const k = c.pick(doc().constraints);
      if (k) I.deleteConstraint(k.id);
    },
  },
  {
    name: 'moveConstraint',
    run: (c) => {
      const k = c.pick(doc().constraints);
      if (k) I.moveConstraint(k.id, c.chance(0.5) ? -1 : 1);
    },
  },
  {
    name: 'renameConstraint',
    run: (c) => {
      const k = c.pick(doc().constraints);
      if (k) I.renameConstraint(k.id, c.pick(NAMES)!);
    },
  },
  {
    name: 'setIkValues',
    run: (c) => {
      const k = c.pick(doc().constraints.filter((x) => x.type === 'ik'));
      if (k)
        I.setIkValues(k.id, {
          mix: c.r(),
          softness: c.num(0, 30),
          bendPositive: c.chance(0.5),
          stretch: c.chance(0.3),
          compress: c.chance(0.3),
        });
    },
  },
  {
    name: 'setConstraintSetup',
    run: (c) => {
      const k = c.pick(doc().constraints.filter((x) => x.type === 'ik'));
      if (k) I.setConstraintSetup(k.id, { mix: c.r(), softness: c.num(0, 30), bendPositive: c.chance(0.5) });
    },
  },
  {
    name: 'createSlider',
    run: (c) => {
      SL.createSlider(c.chance(0.6) ? c.pick(doc().bones)!.id : null);
    },
  },
  {
    name: 'updateSlider',
    run: (c) => {
      const s = c.pick(doc().constraints.filter((x) => x.type === 'slider'));
      if (s)
        SL.updateSlider(s.id, {
          additive: c.chance(0.5),
          loop: c.chance(0.5),
          local: c.chance(0.5),
          property: c.pick(TRANSFORM_PROPS)!,
          from: c.num(-50, 50),
          to: c.num(0, 1),
          scale: c.num(-0.05, 0.05),
          animation: c.chance(0.85) ? (c.pick(doc().animations)?.id ?? null) : null,
          bone: c.chance(0.7) ? c.pick(doc().bones)!.id : null,
          mix: c.r(),
          time: c.num(0, 2),
        });
    },
  },
  {
    name: 'setSliderValues',
    run: (c) => {
      const s = c.pick(doc().constraints.filter((x) => x.type === 'slider'));
      if (s) SL.setSliderValues(s.id, { mix: c.r(), ...(c.chance(0.5) ? { time: c.num(0, 2) } : {}) });
    },
  },
  {
    name: 'setTransformMix',
    run: (c) => {
      const k = c.pick(doc().constraints.filter((x) => x.type === 'transform'));
      if (k)
        T.setTransformMix(k.id, {
          [c.pick(TRANSFORM_PROPS)!]: c.r(),
          ...(c.chance(0.3) ? { [c.pick(TRANSFORM_PROPS)!]: c.num(0, 1.5) } : {}),
        });
    },
  },
  {
    name: 'updateTransform',
    run: (c) => {
      const k = c.pick(doc().constraints.filter((x) => x.type === 'transform'));
      if (k)
        T.updateTransform(k.id, (t) => {
          t.clamp = c.chance(0.5);
          t.additive = c.chance(0.5);
          t.localTarget = c.chance(0.5);
          t.mix.rotate = c.r();
        });
    },
  },
  // ---- animations / keys
  {
    name: 'setMode',
    run: (c) => {
      A.setMode(c.chance(0.6) ? 'animate' : 'setup');
    },
  },
  {
    name: 'createAnimation',
    run: (c) => {
      A.createAnimation(c.pick(NAMES), c.num(0.2, 3));
    },
  },
  {
    name: 'selectAnimation',
    run: (c) => {
      const a = c.pick(doc().animations);
      if (a) A.selectAnimation(a.id);
    },
  },
  {
    name: 'duplicateAnimation',
    run: (c) => {
      const a = c.pick(doc().animations);
      if (a) A.duplicateAnimation(a.id);
    },
  },
  {
    name: 'renameAnimation',
    run: (c) => {
      const a = c.pick(doc().animations);
      if (a) A.renameAnimation(a.id, c.pick(NAMES)!);
    },
  },
  {
    name: 'createSkeleton',
    run: (c) => {
      if (skeletonCount(docStore.get()) < 4 && c.chance(0.3)) SK.createSkeleton(c.chance(0.5) ? 'extra' : 'x');
    },
  },
  {
    name: 'copySkeleton',
    run: (c) => {
      if (skeletonCount(docStore.get()) < 4 && c.chance(0.3)) SK.copySkeleton();
    },
  },
  {
    name: 'switchSkeleton',
    run: (c) => {
      const n = skeletonCount(docStore.get());
      if (n > 1 && c.chance(0.5)) SK.switchToSkeleton(Math.floor(c.r() * n));
    },
  },
  {
    name: 'deleteSkeleton',
    run: (c) => {
      const n = skeletonCount(docStore.get());
      if (n > 1 && c.chance(0.25)) SK.deleteSkeletonAt(Math.floor(c.r() * n));
    },
  },
  {
    name: 'renameSkeleton',
    run: (c) => {
      const n = skeletonCount(docStore.get());
      if (n > 1 && c.chance(0.4)) SK.renameSkeletonAt(Math.floor(c.r() * n), c.chance(0.5) ? 'hero' : 'same');
    },
  },
  {
    name: 'setDefaultMix',
    run: (c) => {
      MX.setDefaultMix(c.chance(0.3) ? 0 : c.num(0, 1.5));
    },
  },
  {
    name: 'setMixPair',
    run: (c) => {
      const a = c.pick(doc().animations);
      const b = c.pick(doc().animations);
      if (a && b) MX.setMixPair(a.id, b.id, c.chance(0.3) ? 0 : c.num(0, 2));
    },
  },
  {
    name: 'deleteAnimation',
    run: (c) => {
      const a = c.pick(doc().animations);
      if (a) A.deleteAnimation(a.id);
    },
  },
  {
    name: 'setAnimationDuration',
    run: (c) => {
      const a = c.pick(doc().animations);
      if (a) A.setAnimationDuration(a.id, c.num(0, 3));
    },
  },
  {
    name: 'setFps',
    run: (c) => {
      A.setFps(c.pick([12, 24, 30, 60, 240, 0, 1000])!);
    },
  },
  {
    name: 'setTime',
    run: (c) => {
      A.setTime(c.num(0, 3), c.chance(0.7));
    },
  },
  {
    name: 'moveKeysBy',
    run: (c) => {
      const a = A.currentAnimation();
      if (!a) return;
      const refs = allKeyRefs(a);
      const k = c.pick(refs);
      if (k)
        A.moveKeysBy(
          refs.filter((r) => r.kind === k.kind && r.target === k.target && r.prop === k.prop && c.chance(0.6)).concat(k),
          c.num(-1, 1),
        );
    },
  },
  {
    name: 'moveKeysOffset',
    run: (c) => {
      const a = A.currentAnimation();
      if (!a) return;
      const refs = allKeyRefs(a);
      const k = c.pick(refs);
      if (k)
        A.moveKeysBy(
          refs.filter((r) => r.kind === k.kind && r.target === k.target && r.prop === k.prop && c.chance(0.5)).concat(k),
          c.num(-2, 2),
          false,
          true,
        );
    },
  },
  {
    name: 'moveKeysRipple',
    run: (c) => {
      const a = A.currentAnimation();
      if (!a) return;
      const refs = allKeyRefs(a);
      const k = c.pick(refs);
      if (k)
        A.moveKeysBy(
          refs.filter((r) => r.kind === k.kind && r.target === k.target && r.prop === k.prop && c.chance(0.4)).concat(k),
          c.num(-1, 1),
          true,
        );
    },
  },
  {
    name: 'cleanUpKeys',
    run: () => {
      const a = A.currentAnimation();
      if (a) A.cleanUpKeys(a.id);
    },
  },
  {
    name: 'sequenceOn',
    run: (c) => {
      const r = c.pick([...regions(), ...meshes()]);
      if (!r) return;
      const att = doc().skins[0].attachments[r.slotId][r.name];
      if (att.type !== 'region' && att.type !== 'mesh') return;
      const count = 2 + Math.floor(c.r() * 4);
      const def = { count, start: c.pick([0, 1, 3])!, digits: c.pick([0, 2, 3])!, setupIndex: Math.floor(c.r() * count) };
      // every frame is a picture the export has to find
      docStore.update('fuzz frames', (d) => {
        for (const n of sequenceFrameNames(att.path, def))
          if (!d.images.some((i) => i.name === n)) d.images.push({ id: uid(), name: n, width: 16, height: 16 });
      });
      SQ.setSequence(r.slotId, r.name, def);
    },
  },
  {
    name: 'sequenceKey',
    run: (c) => {
      const withSeq = [...regions(), ...meshes()].filter((r) => {
        const a = doc().skins[0].attachments[r.slotId][r.name];
        return (a.type === 'region' || a.type === 'mesh') && !!a.sequence;
      });
      const r = c.pick(withSeq);
      if (!r) return;
      A.setMode('animate');
      A.setTime(Math.round(c.r() * 20) / 10);
      SQ.keySequence(r.slotId, r.name, {
        mode: c.pick(SEQUENCE_MODES)!,
        index: Math.floor(c.r() * 6),
        delay: c.pick([0.04, 0.1, 0.0333, 0.25])!,
      });
    },
  },
  // the frames of a cut sprite sheet: numbered pictures (their names from the sheet rules) put on the scene as one sequence, in one step
  {
    name: 'framesFromSheet',
    run: (c) => {
      const count = 2 + Math.floor(c.num(0, 5));
      const { names } = sheetSequence(`fs${Math.floor(c.num(0, 3))}`, count);
      docStore.update('fuzz sheet frames', (d) => {
        for (const n of names) if (!d.images.some((i) => i.name === n)) d.images.push({ id: uid(), name: n, width: 16, height: 16 });
      });
      SQ.placeSequences(names, c.num(-150, 150), c.num(-50, 250));
    },
  },
  // a turn about a point (the rotate tool with a pivot): rotation and position change together; the pose stays finite and exports
  {
    name: 'turnAboutPoint',
    run: (c) => {
      const b = c.pick(doc().bones);
      const live = b ? getScene().skeleton.boneById(b.id) : undefined;
      const pose = b ? A.currentPose(b.id) : null;
      if (!b || !live || !pose) return;
      const p = live.parent;
      const parent = p ? { a: p.a, b: p.b, c: p.c, d: p.d, x: p.worldX, y: p.worldY } : null;
      const next = turnAbout(
        { x: pose.x, y: pose.y, rotation: pose.rotation, sign: turnSign(parent), parent },
        c.num(-150, 150),
        c.num(-50, 250),
        c.num(-120, 120),
      );
      if (![next.x, next.y, next.rotation].every(Number.isFinite)) throw new Error('a turn about a point gave a pose that is not finite');
      A.setBonePose([{ id: b.id, props: next }], 'Rotate');
    },
  },
  // an animation layered on top of the current one: a new animation with finite keys that exports and loads
  {
    name: 'layerAnimation',
    run: (c) => {
      const cur = A.currentAnimation();
      const other = c.pick(doc().animations.filter((a) => a.id !== cur?.id));
      if (!cur || !other) return;
      const id = A.layerCurrentAnimation(other.id, { weight: c.num(0, 2), loop: c.chance(0.6), step: c.chance(0.3) ? 2 : 1 });
      const made = id ? doc().animations.find((a) => a.id === id) : undefined;
      if (
        made &&
        !Object.values(made.bones).every((tl) =>
          (Object.values(tl) as { value: number[] }[][]).every((t) => t.every((k) => k.value.every(Number.isFinite))),
        )
      )
        throw new Error('a layered animation has a key that is not finite');
    },
  },
  // the pictures of a slot fade into each other: a partner slot shows the old picture (refused when the slot has no picture keys or has color keys)
  {
    name: 'crossfadeSlot',
    run: (c) => {
      const keyed = doc().slots.filter((s) => A.currentAnimation()?.slots[s.id]?.attachment?.length);
      const s = c.pick(keyed.length && c.chance(0.8) ? keyed : doc().slots);
      if (s) A.crossfadeSlot(s.id, c.num(0.02, 0.6));
    },
  },
  // names in bulk: a find and replace over a random set of kinds (the document must stay valid: no empty or duplicate names)
  {
    name: 'findReplaceNames',
    run: (c) => {
      const kinds = (['bone', 'slot', 'skin', 'event', 'constraint', 'animation', 'image'] as const).filter(() => c.chance(0.5));
      RN.findReplaceNames({
        find: c.pick(['a', 'e', 'o', '[0-9]', '^.', '_', 'r'])!,
        replace: c.pick(['', 'x', '_a', 'Q', '$&$&'])!,
        regex: c.chance(0.5),
        matchCase: c.chance(0.5),
        firstOnly: c.chance(0.5),
        kinds,
        scope: RN.renameScope(c.pick(['all', 'all', 'selection', 'skin'] as const)!),
      });
    },
  },
  // automatic bezier handles on some keys (smooth through the neighbours)
  {
    name: 'autoCurveKeys',
    run: (c) => {
      const a = A.currentAnimation();
      if (!a) return;
      setKeysAutoCurve(allKeyRefs(a).filter(() => c.chance(0.3)));
    },
  },
  // the offsets of a transform constraint matched to the Setup pose
  {
    name: 'matchTransform',
    run: (c) => {
      const k = c.pick(doc().constraints.filter((x) => x.type === 'transform'));
      if (k) T.matchTransform(k.id);
    },
  },
  // Setup mode compensation: the children and the pictures of an edited bone keep their place (the document must stay finite and valid)
  {
    name: 'compensatedEdit',
    run: (c) => {
      const bone = c.pick(doc().bones);
      if (!bone) return;
      const was = uiStore.get().compensate;
      uiStore.patch({ compensate: { bones: c.chance(0.6), images: c.chance(0.6) } });
      try {
        if (uiStore.get().mode === 'setup')
          A.setBonePose(
            [
              {
                id: bone.id,
                props: c.chance(0.5)
                  ? { rotation: bone.rotation + c.num(-60, 60) }
                  : { x: bone.x + c.num(-30, 30), y: bone.y + c.num(-30, 30) },
              },
            ],
            'Edit bone',
          );
      } finally {
        uiStore.patch({ compensate: was });
      }
    },
  },
  // Favor and Scale time on a random selection of keys
  {
    name: 'keyTools',
    run: (c) => {
      const a = A.currentAnimation();
      if (!a) return;
      uiStore.patch({
        selectedKeys: allKeyRefs(a)
          .filter(() => c.chance(0.4))
          .map(encodeKey),
      });
      if (c.chance(0.5))
        favorSelectedKeys(c.pick(['previous', 'next', 'average', 'neutral', 'shiftPrevious', 'shiftNext'] as const)!, c.num(0.1, 1));
      else scaleSelectedKeyTimes(c.pick([0.5, 0.75, 1.5, 2])!);
      uiStore.patch({ selectedKeys: [] });
    },
  },
  {
    name: 'sequenceOff',
    run: (c) => {
      const withSeq = [...regions(), ...meshes()];
      const r = c.pick(withSeq);
      if (r && c.chance(0.5)) SQ.setSequence(r.slotId, r.name, null);
    },
  },
  {
    name: 'closeLoop',
    run: (c) => {
      A.closeCurrentLoop(c.chance(0.7) ? 'first' : 'last', c.chance(0.3));
    },
  },
  {
    name: 'deleteKeys',
    run: (c) => {
      const a = A.currentAnimation();
      if (!a) return;
      const refs = allKeyRefs(a);
      A.deleteKeys(refs.filter(() => c.chance(0.15)));
    },
  },
  {
    name: 'setKeysCurve',
    run: (c) => {
      const a = A.currentAnimation();
      if (!a) return;
      const refs = allKeyRefs(a).filter(
        (r) => r.kind !== 'drawOrder' && r.kind !== 'drawOrderFolder' && r.kind !== 'event' && r.prop !== 'attachment',
      );
      const k = c.pick(refs);
      if (k) A.setKeysCurve([k], c.pick(['linear', 'stepped', 'bezier', [0.1, 0.2, 0.9, 0.8]] as const)! as 'linear');
    },
  },
  {
    name: 'setKeyChannelValue',
    run: (c) => {
      const a = A.currentAnimation();
      if (!a) return;
      const refs = allKeyRefs(a).filter(
        (r) =>
          r.kind === 'bone' ||
          r.kind === 'ik' ||
          r.kind === 'slider' ||
          r.kind === 'transform' ||
          r.kind === 'path' ||
          (r.kind === 'physics' && r.prop !== 'reset'),
      );
      const k = c.pick(refs);
      if (k) A.setKeyChannelValue(k, 0, c.num(-50, 50));
    },
  },
  {
    name: 'setKeyCurveHandle',
    run: (c) => {
      const a = A.currentAnimation();
      if (!a) return;
      const refs = allKeyRefs(a).filter(
        (r) =>
          r.kind === 'bone' ||
          r.kind === 'ik' ||
          r.kind === 'deform' ||
          r.kind === 'transform' ||
          r.kind === 'path' ||
          (r.kind === 'physics' && r.prop !== 'reset'),
      );
      const k = c.pick(refs);
      if (k) A.setKeyCurveHandle(k, 0, c.chance(0.5) ? 1 : 2, c.r(), c.num(-1, 2));
    },
  },
  {
    name: 'copyPasteKeys',
    run: (c) => {
      const a = A.currentAnimation();
      if (!a) return;
      const refs = allKeyRefs(a).filter((r) => r.kind !== 'drawOrder' && r.kind !== 'drawOrderFolder');
      const k = c.pick(refs);
      if (!k) return;
      A.copyKeys([k]);
      A.pasteKeys(c.num(0, 2));
    },
  },
  // ---- triangle order, keys between frames, pictures of a duplicated skin, alpha-only and colour-only keys
  {
    name: 'moveTriangle',
    run: (c) => {
      const m = c.pick(meshes());
      if (!m) return;
      const n = M.getMesh(m.slotId, m.name)!.triangles.length / 3;
      M.moveMeshTriangle(m.slotId, m.name, Math.floor(c.r() * n), c.pick(['first', 'earlier', 'later', 'last'] as const)!);
    },
  },
  {
    name: 'keyStep',
    run: (c) => {
      setSettings({ keyGrid: c.pick([1, 2, 4, 10])! });
    },
  },
  {
    name: 'duplicateSkinPictures',
    run: (c) => {
      const s = c.pick(doc().skins.slice(1));
      const a = c.pick(project().images);
      const b = c.pick(project().images);
      if (s && a && b) A.duplicateSkinAction(s.id, { scope: c.chance(0.7) }, { find: a.name, replace: b.name });
    },
  },
  {
    name: 'mergeSkins',
    run: (c) => {
      const a = c.pick(doc().skins);
      const b = c.pick(doc().skins);
      if (a && b) A.mergeSkinAction(a.id, b.id, { overwrite: c.chance(0.5), scope: c.chance(0.7), animations: c.chance(0.7) });
    },
  },
  {
    name: 'keyConstrained',
    run: (c) => {
      const b = c.pick(doc().bones);
      if (!b || !A.currentAnimation()) return;
      A.setMode('animate');
      A.setSelection({ bones: [b.id] });
      A.keyConstrainedBones();
    },
  },
  {
    name: 'lastCurve',
    run: (c) => {
      setSettings({ lastChosenCurve: c.chance(0.5) });
    },
  },
  {
    name: 'boneOrder',
    run: (c) => {
      const b = c.pick(doc().bones);
      if (!b) return;
      A.setSelection({ bones: [b.id] });
      POSE.moveBoneOrderAction(c.chance(0.5) ? -1 : 1);
    },
  },
  {
    name: 'flipScale',
    run: (c) => {
      const b = c.pick(doc().bones);
      if (!b) return;
      A.setSelection({ bones: [b.id] });
      POSE.flipScale(c.chance(0.5) ? 'x' : 'y');
    },
  },
  {
    name: 'resetShape',
    run: (c) => {
      const polys: { slotId: string; name: string }[] = [];
      for (const slotId of Object.keys(doc().skins[0].attachments))
        for (const a of Object.values(doc().skins[0].attachments[slotId]))
          if (a.type === 'clipping' || a.type === 'boundingbox') polys.push({ slotId, name: a.name });
      const p = c.pick(polys);
      if (p) POLY.resetPolygonShape(p.slotId, p.name);
    },
  },
  {
    name: 'importReview',
    run: (c) => {
      const a = c.pick(doc().animations);
      if (!a) return;
      RV.importReviewText(
        serializeReview('fuzz', [makeComment(`f${Math.floor(c.r() * 1000)}`, a.name, c.r() * a.duration * 1.2, 'a note', 'Fuzz')]),
      );
    },
  },
  {
    name: 'takeFromCheckpoint',
    run: (c) => {
      const cp = c.pick(CP.checkpointsOfActive());
      if (!cp) return;
      const can = diffSkeletons(cp.skeleton, docStore.get().skeleton).filter((x) => x.kind !== 'added' && (x.area === 'skeleton' || x.id));
      if (!can.length) return;
      const picked = can.filter(() => c.chance(0.5));
      if (!picked.length) picked.push(can[0]);
      CP.takeNow(
        cp,
        picked.map((x) => ({ area: x.area, id: x.id })),
      );
      getScene();
    },
  },
  {
    name: 'backToFile',
    run: (c) => {
      const cp = c.pick(CP.checkpointsOfActive().filter((x) => x.fromFile));
      if (!cp) return;
      if (CP.restoreNow(cp) && diffSkeletons(cp.skeleton, docStore.get().skeleton).filter((x) => x.area !== 'skeleton').length)
        throw new Error('a restored project file differs from the file');
      getScene();
    },
  },
  {
    name: 'compareFile',
    run: () => {
      compareWithProjectText(JSON.stringify({ bone2d: 1, project: project(), images: {} }), 'fuzz.bone2d');
    },
  },
  {
    name: 'keyAlphaOnly',
    run: (c) => {
      const s = c.pick(doc().slots);
      if (!s || !A.currentAnimation()) return;
      A.setMode('animate');
      A.setSlotColor(s.id, [s.color[0], s.color[1], s.color[2], c.r()]);
    },
  },
  {
    name: 'keyColorOnly',
    run: (c) => {
      const s = c.pick(doc().slots);
      if (!s || !A.currentAnimation()) return;
      A.setMode('animate');
      A.setSlotColor(s.id, [c.r(), c.r(), c.r(), s.color[3]]);
    },
  },
  {
    name: 'overweight',
    run: (c) => {
      const found: { slotId: string; name: string }[] = [];
      for (const slotId of Object.keys(doc().skins[0].attachments))
        for (const a of Object.values(doc().skins[0].attachments[slotId]))
          if (a.type === 'mesh' && a.weights && !a.link) found.push({ slotId, name: a.name });
      const m = c.pick(found);
      if (!m || doc().bones.length < 2) return;
      // a vertex that follows more bones than the editor likes: still a valid document, with deform keys that have to follow
      docStore.update('Add influences', (d) => {
        const mesh = d.skeleton.skins[0].attachments[m.slotId][m.name] as MeshAttachment;
        if (!mesh.weights?.length) return;
        const before = { ...mesh };
        const vi = Math.floor(c.r() * mesh.weights.length);
        const bones = d.skeleton.bones.slice(0, 6);
        const w = mesh.weights[vi];
        mesh.weights = mesh.weights.map((list, i) =>
          i === vi
            ? [...w, ...bones.filter((b) => !w.some((x) => x[0] === b.id)).map((b) => [b.id, 1, 1, 0.1] as Influence)].map(
                (e, _k, all) => [e[0], e[1], e[2], e[3] / all.reduce((s, x) => s + x[3], 0)] as Influence,
              )
            : list,
        );
        reconcileDeform(d.skeleton, m.slotId, m.name, before, mesh);
      });
    },
  },
  {
    name: 'resetPath',
    run: (c) => {
      const paths: { slotId: string; name: string }[] = [];
      for (const slotId of Object.keys(doc().skins[0].attachments))
        for (const a of Object.values(doc().skins[0].attachments[slotId])) if (a.type === 'path') paths.push({ slotId, name: a.name });
      const p = c.pick(paths);
      if (p) PA.resetPathShape(p.slotId, p.name);
    },
  },
  {
    name: 'copyPasteBones',
    run: (c) => {
      const a = A.currentAnimation();
      if (!a || doc().bones.length < 4) return;
      const refs = allKeyRefs(a).filter((r) => r.kind === 'bone');
      const from = [...new Set(refs.map((r) => r.target))].slice(0, 2);
      if (from.length < 2) return;
      A.copyKeys(refs.filter((r) => from.includes(r.target)));
      const others = doc().bones.filter((b) => !from.includes(b.id));
      if (others.length < 2) return;
      A.setSelection({ bones: [c.pick(others)!.id, c.pick(others)!.id].filter((x, i, l) => l.indexOf(x) === i) });
      A.pasteKeys(c.r() * a.duration);
    },
  },
  {
    name: 'meshGroup',
    run: (c) => {
      const m = c.pick(meshes());
      if (!m) return;
      const bone = c.pick(doc().bones)!.id;
      A.setSelection({ slot: m.slotId, attachment: m.name, bones: [bone] });
      for (const s of doc().slots) if (s.id !== m.slotId && c.chance(0.4)) A.toggleExtraSlot(s.id);
      const k = Math.floor(c.r() * 8);
      if (k === 0) M.pruneMeshesWeights(0.05, 1 + Math.floor(c.r() * 4));
      else if (k === 1) M.smoothMeshesWeights(1);
      else if (k === 2) M.autoWeightMeshes();
      else if (k === 3) M.unbindMeshesFromBones();
      else if (k === 4) M.bindMeshesToBones([bone]);
      else if (k === 5) M.convertImagesToMeshes('quad');
      else if (k === 6) M.removeBoneFromMeshes(bone);
      else {
        uiStore.patch({ brush: { size: c.num(10, 300), strength: c.num(0.1, 1), mode: 'add', bone, feather: 100, locked: [] } });
        M.paintWeightsGroup({ x: c.num(-100, 100), y: c.num(-100, 100) }, bone);
      }
    },
  },
  {
    name: 'pasteHold',
    run: (c) => {
      const a = A.currentAnimation();
      if (!a) return;
      const refs = allKeyRefs(a).filter((r) => r.kind !== 'drawOrder' && r.kind !== 'drawOrderFolder');
      const k = c.pick(refs);
      if (!k) return;
      A.copyKeys([k]);
      A.pasteKeys(c.r() * a.duration, true);
    },
  },
  {
    name: 'flipView',
    run: () => {
      A.flipViewport();
    },
  },
  {
    name: 'insertTime',
    run: (c) => {
      const a = A.currentAnimation();
      if (!a) return;
      A.setTime(c.r() * a.duration);
      A.insertTimeAtPlayhead(1 + Math.floor(c.r() * 12));
    },
  },
  {
    name: 'deleteTime',
    run: (c) => {
      const a = A.currentAnimation();
      if (!a) return;
      A.setTime(c.r() * a.duration);
      A.deleteTimeAtPlayhead(1 + Math.floor(c.r() * 12));
    },
  },
  {
    name: 'saveCurve',
    run: (c) => {
      const a = A.currentAnimation();
      if (!a) return;
      const refs = allKeyRefs(a).filter((r) => r.kind === 'bone');
      const k = c.pick(refs);
      if (!k) return;
      if (c.chance(0.5)) A.setKeysCurve([k], [c.num(0, 1), c.num(-1, 2), c.num(0, 1), c.num(-1, 2)]);
      if (c.chance(0.8)) A.saveKeyCurve(k);
      else A.forgetSavedCurve(Math.floor(c.r() * 3));
      const saved = settingsStore.get().savedCurves[0];
      if (saved && c.chance(0.5)) A.setKeysCurve(refs.slice(0, 3), saved.curve);
    },
  },
  {
    name: 'selectMatches',
    run: (c) => {
      A.selectMatches(filterTree(doc(), c.pick(['a', 'arm', 'sw', 'tail', 'b*', '/^[hp]/', 'zz'])!));
    },
  },
  {
    name: 'comments',
    run: (c) => {
      const it = c.pick(listReview(doc()));
      if (!it) return;
      const k = c.r();
      if (k < 0.4) CMT.setCommentResolved(it.animationId, it.marker.id, c.chance(0.6));
      else if (k < 0.8) CMT.goToComment(it.animationId, it.marker.id);
      else CMT.resolveAllComments();
    },
  },
  {
    name: 'fixProblems',
    run: (c) => {
      const w = c.pick(projectWarnings(project()).filter(canFix));
      if (c.chance(0.5) || !w) PRB.fixAllSafeWarnings();
      else PRB.fixWarning(w);
    },
  },
  // ---- history
  { name: 'undo', run: () => docStore.undo() },
  { name: 'redo', run: () => docStore.redo() },
];

// ------------------------------------------------------------------ invariants

function finiteSkeleton(p: Project, label: string) {
  const data = compileSkeleton(p.skeleton);
  const sk = createSkeleton(data);
  const poses: [Animation | null, number][] = [[null, 0]];
  for (const a of p.skeleton.animations) poses.push([a, 0], [a, a.duration * 0.5], [a, a.duration]);
  for (const [anim, t] of poses) {
    applyAnimation(sk, anim, t);
    sk.updateWorldTransform();
    for (const b of sk.bones)
      for (const v of [b.a, b.b, b.c, b.d, b.worldX, b.worldY])
        if (!Number.isFinite(v))
          throw new Error(`${label}: non-finite matrix on bone "${b.data.name}" (animation ${anim?.name ?? 'setup'} t=${t})`);
  }
}

/**
 * Bones whose pose hangs on a knife-edge: a transform constraint or slider that reads a WORLD rotation sitting on the
 * 0/360 wrap gets 0 from one runtime and 360 from the other, depending on ~1e-6 degrees of float noise. That is how
 * Spine's formula behaves (the official runtimes disagree among themselves), not a solver bug, so such bones are skipped.
 */
function ambiguousBones(ours: ReturnType<typeof createSkeleton>, official: any): Set<number> {
  const out = new Set<number>();
  const mark = (b: (typeof ours.bones)[number]) => {
    out.add(b.data.index);
    for (const c of b.children) mark(c);
  };
  const nearWrap = (b: (typeof ours.bones)[number]) => {
    let a = (Math.atan2(b.c, b.a) * 180) / Math.PI;
    if (a < 0) a += 360;
    return a < 1e-3 || a > 360 - 1e-3;
  };
  // (the constraint may have read its source before a slider moved it, so the pose that is left says nothing about the wrap)
  const nearWrapValue = (v: number) => v < 1e-3 || v > 360 - 1e-3;
  for (const c of ours.constraints) {
    if (
      c.kind === 'transform' &&
      !c.data.localSource &&
      c.data.properties.some((p) => p.prop === 'rotate') &&
      (nearWrap(c.source) || nearWrapValue(c.lastSourceRotation))
    )
      for (const b of c.bones) mark(b);
    // a path bone that has to turn by exactly half a turn goes either way on a nanometre of noise
    if (c.kind === 'path' && c.onBranchCut) for (const b of c.bones) mark(b);
    if (c.kind === 'slider') {
      const o = official.constraints.find((x: any) => x.data.name === c.data.name);
      if (o && Math.abs(o.appliedPose.time - c.time) > 1e-2) for (const i of c.data.animatedBones) mark(ours.bones[i]);
    }
  }
  // A path constraint that follows the path with `chain` / `chainScale` points each bone at the next one. When bones sit on the
  // same spot (a closed path and a spacing of 4 whole path lengths, spaces that wrap to the same point) there is no direction:
  // the angle is the atan2 of float noise, which differs between two runtimes (one gets an exact 0, the other 1e-14).
  for (const o of official.constraints) {
    if (!(o instanceof S.PathConstraint) || o.data.rotateMode === S.RotateMode.Tangent) continue;
    let coincident = false;
    for (let i = 0; i < o.bones.length; i++) {
      const dx = o.positions[3 * (i + 1)] - o.positions[3 * i];
      const dy = o.positions[3 * (i + 1) + 1] - o.positions[3 * i + 1];
      if (o.spaces[i + 1] !== 0 && Math.hypot(dx, dy) < 1e-3) coincident = true;
    }
    if (!coincident) continue;
    const mine = ours.constraints.find((c) => c.kind === 'path' && c.data.name === o.data.name);
    if (mine && mine.kind === 'path') for (const b of mine.bones) mark(b);
  }
  // What follows an ambiguous bone is ambiguous too: a path constraint moves its bones along a path that sits on the slot's bone
  // (or on the bones the path is skinned to), and an IK / transform constraint reads its target / source.
  for (let changed = true; changed;) {
    changed = false;
    for (const c of ours.constraints) {
      let reads: (typeof ours.bones)[number][] = [];
      if (c.kind === 'path') {
        const att = ours.slotAttachment(c.slot);
        reads = [c.slot.bone];
        if (att && att.kind === 'path' && att.bones)
          for (const i of influencingBones(att.bones, att.vertexCount)) reads.push(ours.bones[i]);
      } else if (c.kind === 'ik') reads = [c.target];
      else if (c.kind === 'transform') reads = [c.source];
      else if (c.kind === 'slider' && c.bone) reads = [c.bone];
      else if (c.kind === 'physics') continue; // it only reads and moves its own bone
      if (!reads.some((b) => out.has(b.data.index))) continue;
      const before = out.size;
      for (const b of c.kind === 'slider' ? c.data.animatedBones.map((i) => ours.bones[i]) : c.bones) mark(b);
      if (out.size !== before) changed = true;
    }
  }
  return out;
}

export interface Mismatch {
  bone: string;
  what: string;
  ours: number;
  official: number;
  animation: string;
  time: number;
}

/** The official runtime after a game loop of `dts` frames (state.update, state.apply, skeleton.update, updateWorldTransform(Physics.update)). */
function officialPlayed(skeletonData: unknown, animation: string, dts: number[]) {
  const official = new S.Skeleton(skeletonData);
  official.setupPose();
  const state = new S.AnimationState(new S.AnimationStateData(skeletonData));
  state.setAnimation(0, animation, false);
  for (const dt of dts) {
    state.update(dt);
    state.apply(official);
    official.update(dt);
    official.updateWorldTransform(S.Physics.update);
  }
  return official;
}

/** The official runtime at time `t` of an animation: the first update of a fresh skeleton, like our side of the comparison. */
function officialAt(skeletonData: unknown, animation: string, t: number) {
  const official = new S.Skeleton(skeletonData);
  official.setupPose();
  const state = new S.AnimationState(new S.AnimationStateData(skeletonData));
  state.setAnimation(0, animation, false);
  state.update(t);
  state.apply(official);
  official.updateWorldTransform(S.Physics.update);
  return official;
}

/**
 * Copy of an exported document with every non-integer number nudged by up to `absolute + relative * |x|` (deterministic).
 * Integers are counts, indices and flags (vertex bone counts, triangles, hull lengths) and stay as they are.
 */
function jitterNumbers(value: unknown, absolute: number, relative: number, state: { n: number }): unknown {
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value;
    state.n = (Math.imul(state.n, 1664525) + 1013904223) >>> 0;
    return value + (absolute + relative * Math.abs(value)) * ((state.n / 4294967296) * 2 - 1);
  }
  if (Array.isArray(value)) return value.map((v) => jitterNumbers(v, absolute, relative, state));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = jitterNumbers(v, absolute, relative, state);
    return out;
  }
  return value;
}

/** A difference between the runtimes is let through when it is at most this many times what the official runtime moves by itself. */
const NOISE_FACTOR = 10;
/**
 * Size of the nudges: the exporter rounds to 5 decimals (5e-6), the official runtime keeps animation data in float32 (6e-8
 * relative); these are a few times that. Several runs, because some poses sit on a knife-edge (a slider whose time lands exactly on
 * a key time: float32 decides whether the key counts) and each run falls on either side with probability 1/2 (fourteen runs: seed 569 of the layered op list needed more than six to see both sides); they are made only
 * when a difference has to be judged.
 */
const NUDGES: [number, number][] = [
  [2e-5, 2e-6],
  [2e-5, 2e-6],
  [2e-5, 2e-6],
  [2e-5, 2e-6],
  [2e-5, 2e-6],
  [2e-5, 2e-6],
  [2e-5, 2e-6],
  [2e-5, 2e-6],
  [2e-5, 2e-6],
  [2e-5, 2e-6],
  [2e-5, 2e-6],
  [2e-5, 2e-6],
  [2e-5, 2e-6],
  [2e-5, 2e-6],
];

type OfficialSkeleton = ReturnType<typeof officialAt>;

/** The same pose from exports whose numbers are nudged by about the size of the exporter's rounding (made on first use). */
function nudgedRuns(json: unknown, atlasText: string, make: (skeletonData: unknown) => OfficialSkeleton): () => OfficialSkeleton[] {
  let runs: OfficialSkeleton[] | undefined;
  return () => {
    if (!runs) {
      runs = [];
      NUDGES.forEach(([absolute, relative], i) => {
        try {
          runs!.push(make(loadOfficial(jitterNumbers(json, absolute, relative, { n: 12345 + i * 7919 }), atlasText)));
        } catch {
          /* a nudged export the loader refuses tells nothing */
        }
      });
    }
    return runs;
  };
}

/**
 * Whether `difference` (ours minus official) is only what the official runtime moves by itself when its input is nudged:
 * `read` pulls the compared number out of an official skeleton. A bug does not move with the input, noise does.
 */
type Judge = (read: (skeleton: OfficialSkeleton) => number, difference: number) => boolean;

function judgeBy(official: OfficialSkeleton, runs: () => OfficialSkeleton[]): Judge {
  return (read, difference) => {
    const reference = read(official);
    for (const run of runs()) {
      const moved = Math.abs(read(run) - reference);
      if (Number.isFinite(moved) && Math.abs(difference) <= NOISE_FACTOR * moved) return true;
    }
    return false;
  };
}

/**
 * Physics keeps state, so a single pose says nothing about it (the first frame of a simulation is at rest): a document with
 * physics constraints is also PLAYED for a few frames in both runtimes, and the bones where the simulation ended are compared.
 */
function physicsMismatch(p: Project, sd: any, json: unknown, atlasText: string, data: ReturnType<typeof compileSkeleton>): Mismatch | null {
  if (!p.skeleton.constraints.some((c) => c.type === 'physics')) return null;
  const anim = p.skeleton.animations.find((a) => a.duration > 0.05 && sd.findAnimation(a.name));
  if (!anim) return null;
  const dts = Array.from({ length: 40 }, (_, i) => (i < 28 ? 1 / 60 : 0.009 + (i % 3) * 0.013));
  // A key of a physics timeline (a wind that jumps, a reset) that sits exactly on a frame of the run is ambiguous: the official runtime keeps key
  // times as float32 (0.3 -> 0.30000001), so on that very frame it has not reached the key yet while we have, and the simulation remembers the one
  // frame of difference. (Seed 527: wind keyed at 0.3 = frame 18 of the run.)
  let at = 0;
  const frameTimes = dts.map((dt) => (at += dt));
  const keyTimes = [...JSON.stringify(anim.physics ?? {}).matchAll(/"time":(-?[\d.]+(?:e[+-]?\d+)?)/gi)].map((m) => Number(m[1]));
  if (keyTimes.some((k) => frameTimes.some((t) => Math.abs(t - k) < 1e-5))) return null;
  const official = officialPlayed(sd, anim.name, dts);
  const judge = judgeBy(
    official,
    nudgedRuns(json, atlasText, (nudgedData) => officialPlayed(nudgedData, anim.name, dts)),
  );
  const ours = createSkeleton(data);
  startLikeOfficial(ours);
  let last = -1;
  let time = 0;
  for (const dt of dts) {
    time += dt;
    applyAnimation(ours, anim, time);
    applyPhysicsResets(ours, anim, last, time);
    last = time;
    ours.update(dt);
    ours.updateWorldTransform('update');
    // A bone of a chain / chainScale path constraint with no size at all (a, c = 0) gives its neighbour a spacing that is 0 in one
    // runtime and 1e-17 in the other, and the exact test `spaces[i + 1] === 0` then picks another angle for one frame. The physics
    // of the bone remembers that frame for the rest of the run, so a run where it happens says nothing about the physics.
    for (const c of ours.constraints)
      if (c.kind === 'path' && c.data.rotateMode !== 'tangent' && c.bones.some((b) => Math.hypot(b.a, b.c) < 1e-6)) return null;
  }
  const ambiguous = ambiguousBones(ours, official);
  for (const ob of official.bones) {
    const id = p.skeleton.bones.find((b) => b.name === ob.data.name)!.id;
    const mine = ours.bones[data.boneIndex.get(id)!];
    if (ambiguous.has(mine.data.index)) continue;
    const q = ob.appliedPose;
    const mag = Math.max(Math.abs(q.a), Math.abs(q.b), Math.abs(q.c), Math.abs(q.d));
    const parentMag = ob.parent
      ? Math.max(
          Math.abs(ob.parent.appliedPose.a),
          Math.abs(ob.parent.appliedPose.b),
          Math.abs(ob.parent.appliedPose.c),
          Math.abs(ob.parent.appliedPose.d),
        )
      : 1;
    const wscale = 0.004 * (Math.abs(mine.ax) + Math.abs(mine.ay)) * parentMag;
    const pairs: [string, number, number, number][] = [
      ['a', mine.a, q.a, mag],
      ['b', mine.b, q.b, mag],
      ['c', mine.c, q.c, mag],
      ['d', mine.d, q.d, mag],
      ['worldX', mine.worldX, q.worldX, wscale],
      ['worldY', mine.worldY, q.worldY, wscale],
    ];
    for (const [what, x, y, scale] of pairs) {
      if (Math.abs(x - y) <= 5e-3 * Math.max(1, Math.abs(x), Math.abs(y), scale)) continue;
      if (judge((sk) => sk.bones.find((b: { data: { name: string } }) => b.data.name === ob.data.name)?.appliedPose[what] ?? NaN, x - y))
        continue;
      return { bone: ob.data.name, what, ours: x, official: y, animation: `${anim.name} (played ${dts.length} frames)`, time };
    }
  }
  return null;
}

/**
 * First difference between our solver and the official runtime on what the editor would export right now.
 *
 * Some random documents are ill-conditioned: a path constraint at a position of 27.6 path lengths multiplies the 1e-5 relative
 * noise of a slider output (float32 key values and the exporter's 5 decimals reach the official runtime, our side computes in
 * doubles) by the length of the path, a chain of constraints turns a 1e-5 rotation error into a displacement along a lever
 * arm. For those the official runtime ITSELF answers differently when every number of the export is nudged by the size of the
 * exporter's rounding, and a difference between the runtimes that is within a tenth of that is not something the editor could
 * ever be asked to reproduce. A bug is different: it does not move when the input is nudged.
 */
export function parityMismatch(p: Project): Mismatch | null {
  const { skeletonData: sd, json, atlasText } = exportAndLoad(p, { splitColor: true });
  const data = compileSkeleton(p.skeleton);
  for (const anim of p.skeleton.animations) {
    const exported = sd.findAnimation(anim.name);
    if (!exported) continue;
    const end = Math.min(anim.duration, exported.duration);
    // The official runtime keeps key times in Float32Array (1.2 -> 1.20000004), so sampling EXACTLY on a key time is
    // ambiguous. Probe slightly off the frame grid instead.
    for (const t of [0, end * 0.37 + 0.00137, end * 0.8 + 0.00137, end - 0.00137]) {
      if (t < 0 || t > end) continue;
      const official = officialAt(sd, anim.name, t);
      const judge = judgeBy(
        official,
        nudgedRuns(json, atlasText, (nudgedData) => officialAt(nudgedData, anim.name, t)),
      );
      const ours = createSkeleton(data);
      startLikeOfficial(ours);
      applyAnimation(ours, anim, t);
      ours.updateWorldTransform('update');
      const ambiguous = ambiguousBones(ours, official);
      for (const ob of official.bones) {
        const id = p.skeleton.bones.find((b) => b.name === ob.data.name)!.id;
        const mine = ours.bones[data.boneIndex.get(id)!];
        if (ambiguous.has(mine.data.index)) continue;
        const q = ob.appliedPose;
        // The matrix elements are compared relative to the size of the whole matrix: an element can be a small difference of
        // large terms (a = 3.5 next to b = 75), and the exporter's rounding (5 decimals for mixes, 7 digits for slider times)
        // is amplified by a slider with mix 48 into 0.01 degrees of a 3492 degree rotation — 3e-6 relative, harmless.
        const mag = Math.max(Math.abs(q.a), Math.abs(q.b), Math.abs(q.c), Math.abs(q.d));
        // The position is a sum of terms the size of (local offset x parent matrix): a bone 7000 units out on a parent with a
        // 1e-5 relative difference (an IK solve, a slider mix of 48) is off by a few tenths, which is still the same pose.
        const parentMag = ob.parent
          ? Math.max(
              Math.abs(ob.parent.appliedPose.a),
              Math.abs(ob.parent.appliedPose.b),
              Math.abs(ob.parent.appliedPose.c),
              Math.abs(ob.parent.appliedPose.d),
            )
          : 1;
        const wscale = 0.004 * (Math.abs(mine.ax) + Math.abs(mine.ay)) * parentMag;
        const pairs: [string, number, number, number][] = [
          ['a', mine.a, q.a, mag],
          ['b', mine.b, q.b, mag],
          ['c', mine.c, q.c, mag],
          ['d', mine.d, q.d, mag],
          ['worldX', mine.worldX, q.worldX, wscale],
          ['worldY', mine.worldY, q.worldY, wscale],
        ];
        for (const [what, x, y, scale] of pairs) {
          if (Math.abs(x - y) <= 5e-3 * Math.max(1, Math.abs(x), Math.abs(y), scale)) continue;
          // ill-conditioned (see above)
          if (
            judge((sk) => sk.bones.find((b: { data: { name: string } }) => b.data.name === ob.data.name)?.appliedPose[what] ?? NaN, x - y)
          )
            continue;
          return { bone: ob.data.name, what, ours: x, official: y, animation: anim.name, time: t };
        }
      }
      // (a slider whose driver sits on the 0/360 wrap applies its animation at time 0 in one runtime and at 360 in the other)
      const colors = ambiguous.size ? null : colorMismatch(p, ours, official, judge);
      if (colors) return { ...colors, animation: anim.name, time: t };
      const shapes = attachmentMismatch(p, ours, official, ambiguous, judge);
      if (shapes) return { ...shapes, animation: anim.name, time: t };
    }
  }
  return physicsMismatch(p, sd, json, atlasText, data);
}

/**
 * Slot colors, light and dark. They travel as 8-bit hex in the JSON and a bezier can extrapolate the rounding error, hence the
 * tolerance: a wrong channel, clamp or mix is off by far more.
 */
function colorMismatch(
  p: Project,
  ours: ReturnType<typeof createSkeleton>,
  official: any,
  judge: (read: (sk: any) => number, diff: number) => boolean,
): Omit<Mismatch, 'animation' | 'time'> | null {
  for (const os of official.slots) {
    const slotDoc = p.skeleton.slots.find((s) => s.name === os.data.name);
    const slot = slotDoc && ours.slotById(slotDoc.id);
    if (!slot) continue;
    const c = os.appliedPose.color;
    const dk = os.appliedPose.darkColor;
    const pairs: [string, number, number][] = [
      ['color.r', slot.color[0], c.r],
      ['color.g', slot.color[1], c.g],
      ['color.b', slot.color[2], c.b],
      ['color.a', slot.color[3], c.a],
    ];
    if (dk)
      pairs.push(
        ['dark.r', slot.dark ? slot.dark[0] : NaN, dk.r],
        ['dark.g', slot.dark ? slot.dark[1] : NaN, dk.g],
        ['dark.b', slot.dark ? slot.dark[2] : NaN, dk.b],
      );
    else if (slot.dark) pairs.push(['dark (the official slot has none)', 1, 0]);
    // the picture of a sequence the slot shows
    const shown = os.appliedPose.attachment;
    if (shown?.sequence?.hasPathSuffix()) {
      const mine = ours.slotAttachment(slot);
      const seq = mine && (mine.kind === 'region' || mine.kind === 'mesh') ? mine.src.sequence : undefined;
      pairs.push([
        `sequence frame (ours: ${mine ? mine.kind + ' ' + mine.name : 'none'} seq=${JSON.stringify(seq)} idx=${slot.sequenceIndex}; official: ${shown.name} ${shown.sequence.regions.length} frames)`,
        seq ? resolveSequenceIndex(seq, slot.sequenceIndex) : NaN,
        shown.sequence.resolveIndex(os.appliedPose),
      ]);
    }
    // a slider whose mix is 13 hands the 8-bit rounding of the colour keys back 13 times larger
    for (const [what, x, y] of pairs) {
      if (Math.abs(x - y) <= 1.5e-2 * colorAmplification(p)) continue;
      // a slider whose time lands on a key of the colour (to within the rounding of the file) takes it in one runtime and not in the other: the same knife edge as for bones
      const ch = /^color\.([rgba])$/.exec(what)?.[1];
      if (
        ch &&
        judge((sk) => sk.slots.find((q: { data: { name: string } }) => q.data.name === os.data.name)?.appliedPose.color[ch] ?? NaN, x - y)
      )
        continue;
      return { bone: `slot "${os.data.name}"`, what, ours: x, official: y };
    }
  }
  return null;
}

/** The biggest mix a slider can have (set up or keyed), at least 1: how much the rounding of a colour in the file can grow in the pose. */
function colorAmplification(p: Project): number {
  let amp = 1;
  for (const c of p.skeleton.constraints) if (c.type === 'slider') amp = Math.max(amp, Math.abs(c.mix));
  for (const a of p.skeleton.animations)
    for (const t of Object.values(a.slider ?? {})) for (const k of t.mix ?? []) amp = Math.max(amp, Math.abs(k.value[0]));
  return amp;
}

/** Bone indices that influence a weighted attachment (`bones` = per vertex [count, bone…] as compiled by `compileSkeleton`). */
function influencingBones(bones: Int32Array, vertexCount: number): number[] {
  const out: number[] = [];
  for (let i = 0, v = 0; i < vertexCount; i++) {
    const count = bones[v++];
    for (let k = 0; k < count; k++) out.push(bones[v++]);
  }
  return out;
}

/** Clipping polygons, bounding boxes and points: world geometry and flags against the official runtime. */
function attachmentMismatch(
  p: Project,
  ours: ReturnType<typeof createSkeleton>,
  official: any,
  ambiguous: Set<number>,
  judge: Judge,
): Omit<Mismatch, 'animation' | 'time'> | null {
  for (const os of official.slots) {
    const oa = os.appliedPose.attachment;
    const kind =
      oa instanceof S.ClippingAttachment
        ? 'clipping'
        : oa instanceof S.BoundingBoxAttachment
          ? 'boundingbox'
          : oa instanceof S.PointAttachment
            ? 'point'
            : oa instanceof S.PathAttachment
              ? 'path'
              : null;
    if (!kind) continue;
    const slotDoc = p.skeleton.slots.find((s) => s.name === os.data.name);
    const slot = slotDoc && ours.slotById(slotDoc.id);
    if (!slot) continue;
    const label = `slot "${os.data.name}" ${kind}`;
    const att = ours.slotAttachment(slot);
    if (!att || att.kind !== kind) return { bone: label, what: `attachment kind (ours ${att?.kind ?? 'none'})`, ours: 0, official: 1 };
    const driving = [slot.data.bone, ...(att.kind !== 'point' && att.bones ? influencingBones(att.bones, att.vertexCount) : [])];
    if (driving.some((i) => ambiguous.has(i))) continue;
    // A bone matrix is only guaranteed to ~5e-3 of its own size (see `parityMismatch`), so a vertex that is a small number
    // made of large terms (matrix size x local extent + translation) is compared against the size of those terms.
    let extent = 0;
    if (att.kind === 'point') extent = Math.max(Math.abs(att.x), Math.abs(att.y));
    else
      for (let i = 0; i < att.positions.length; i++)
        if (!att.weighted || i % 3 !== 2) extent = Math.max(extent, Math.abs(att.positions[i]));
    let terms = 0;
    for (const bi of new Set(driving)) {
      const b = ours.bones[bi];
      terms = Math.max(
        terms,
        Math.max(Math.abs(b.a), Math.abs(b.b), Math.abs(b.c), Math.abs(b.d)) * extent + Math.abs(b.worldX) + Math.abs(b.worldY),
      );
    }
    const near = (x: number, y: number) => Math.abs(x - y) <= 5e-3 * Math.max(1, Math.abs(x), Math.abs(y), terms);
    /** The same number read from another official skeleton (a nudged run), for `judge`. */
    const slotOf = (sk: OfficialSkeleton) => sk.slots.find((s: { data: { name: string } }) => s.data.name === os.data.name);
    if (att.kind === 'point') {
      const pos = oa.computeWorldPosition(os.bone.appliedPose, new S.Vector2());
      const mine = pointWorld(att, slot.bone);
      const pointOf = (sk: OfficialSkeleton) => {
        const s = slotOf(sk);
        const a = s?.appliedPose.attachment;
        return a instanceof S.PointAttachment ? a.computeWorldPosition(s.bone.appliedPose, new S.Vector2()) : { x: NaN, y: NaN };
      };
      if (!near(mine.x, pos.x) && !judge((sk) => pointOf(sk).x, mine.x - pos.x))
        return { bone: label, what: 'x', ours: mine.x, official: pos.x };
      if (!near(mine.y, pos.y) && !judge((sk) => pointOf(sk).y, mine.y - pos.y))
        return { bone: label, what: 'y', ours: mine.y, official: pos.y };
      const rotationOf = (sk: OfficialSkeleton) => {
        const s = slotOf(sk);
        const a = s?.appliedPose.attachment;
        return a instanceof S.PointAttachment ? a.computeWorldRotation(s.bone.appliedPose) : NaN;
      };
      const rot = oa.computeWorldRotation(os.bone.appliedPose);
      const d = ((((mine.rotation - rot + 180) % 360) + 360) % 360) - 180;
      // 0.1° = 1.7e-3 rad: ill-conditioned matrices (see above)
      if (Math.abs(d) > 0.1 && !judge((sk) => ((((rotationOf(sk) - rot + 180) % 360) + 360) % 360) - 180, d))
        return { bone: label, what: 'rotation', ours: mine.rotation, official: rot };
      continue;
    }
    const n = oa.worldVerticesLength;
    if (att.vertexCount * 2 !== n) return { bone: label, what: 'vertex count', ours: att.vertexCount, official: n / 2 };
    const out = new Array(n).fill(0);
    oa.computeWorldVertices(official, os, 0, n, out, 0, 2);
    const mine = new Float32Array(n);
    meshWorldVertices(ours, slot, att, att.kind === 'path' && slot.deform.length ? slot.deform : null, mine);
    const vertexOf = (sk: OfficialSkeleton, i: number) => {
      const s = slotOf(sk);
      const a = s?.appliedPose.attachment;
      if (!a || a.worldVerticesLength !== n) return NaN;
      const w = new Array(n).fill(0);
      a.computeWorldVertices(sk, s, 0, n, w, 0, 2);
      return w[i];
    };
    for (let i = 0; i < n; i++)
      if (!near(mine[i], out[i]) && !judge((sk) => vertexOf(sk, i), mine[i] - out[i]))
        return { bone: label, what: `vertex[${i}]`, ours: mine[i], official: out[i] };
    if (att.kind === 'clipping') {
      const endName = att.end ? (p.skeleton.slots.find((s) => s.id === att.end)?.name ?? null) : null;
      if ((oa.endSlot?.name ?? null) !== endName)
        return { bone: label, what: `end slot (ours ${endName}, official ${oa.endSlot?.name ?? null})`, ours: 0, official: 1 };
      if (oa.convex !== att.convex || oa.inverse !== att.inverse)
        return {
          bone: label,
          what: 'convex / inverse flag',
          ours: Number(att.convex) * 2 + Number(att.inverse),
          official: Number(oa.convex) * 2 + Number(oa.inverse),
        };
    }
  }
  return null;
}

/**
 * Baking an animation turns the constraints into bone keys: the baked animation (constraints off) has to pose every bone the way the
 * original does on every frame, whatever the document contains.
 */
function bakeMismatch(p: Project): string | null {
  const doc = p.skeleton;
  for (const anim of doc.animations.slice(0, 2)) {
    if (!(anim.duration > 0)) continue;
    const baked = bakeAnimation(doc, anim, { simplify: null });
    const withBaked = { ...structuredClone(doc), animations: [...doc.animations, baked] };
    const names = doc.bones.map((b) => b.name);
    // a bone that no skin switches on is not posed by the update order, but a constraint can still write to it; that is not baked (and cannot be seen)
    const probeData = compileSkeleton(structuredClone(doc));
    const probe = createSkeleton(probeData, null);
    // A constrained bone whose parent is constrained as well can be left in a state that its parent's final pose does not explain
    // (a constraint ordered after the child moved the parent; the child keeps the world it had). Its local pose then cannot be read back
    // from the parent, in the official runtime either, so such a pair is not compared.
    const constrained = new Set(constrainedBoneIndices(probeData));
    // ...and neither is anything below such a pair: the child follows the parent it is given, whatever its own pose says
    const unexplained = new Set<number>();
    const pairs = new Set<number>();
    // A path constraint whose slot has no path attachment on some frame (an attachment key that turns it off) does not touch its bones then, and a
    // constrained bone is not updated on its own: it keeps the world pose of the last frame that solved. That is in the official runtime too,
    // and a baked local pose cannot say it, so the bones of such a path are not compared (nor what hangs on them).
    // (The same when the slot shows something that is not a path at all: a mesh, or no attachment, in the setup pose or on a key; bakeSkips says which.)
    const off = new Set(bakeSkips(doc, anim));
    for (const c of doc.constraints) {
      if (c.type !== 'path' || !off.has(c.name)) continue;
      for (const id of c.bones) pairs.add(doc.bones.findIndex((b) => b.id === id));
    }
    for (let i = 0; i < probe.bones.length; i++) {
      const parent = probe.bones[i].parent;
      if (!parent) continue;
      if (constrained.has(i) && constrained.has(parent.data.index)) pairs.add(i);
      if (pairs.has(i) || unexplained.has(parent.data.index)) unexplained.add(i);
    }
    const want = poseFrames(doc, anim);
    const got = poseFrames(withBaked, baked);
    for (let f = 0; f < want.length; f++) {
      for (let i = 0; i < want[f].length; i++) {
        if (!probe.bones[i].active) continue;
        if (pairs.has(i)) continue;
        // a world position beyond 1e9 (a runaway scale chain) has lost the float32 precision a baked local pose is read back with
        if (want[f][i].some((v) => Math.abs(v) > 1e9)) continue;
        // a flat world matrix (a scale of 0 on one axis, determinant 0) has no local pose that the applied-transform read-back finds: the rotation of a
        // matrix whose first column is 0 is undefined, the baked pose comes out as all zeros
        if (Math.abs(want[f][i][0] * want[f][i][3] - want[f][i][1] * want[f][i][2]) < 1e-9) continue;
        // a flat PARENT (a scale that passes through 0 on a frame) has no inverse: a child that does not take the whole parent matrix (onlyTranslation,
        // noScale...) keeps a world pose of its own, but where it sits relative to that parent cannot be read back, so the baked local position is 0
        const parentOf = probe.bones[i].parent;
        if (parentOf) {
          const pm = want[f][parentOf.data.index];
          if (Math.abs(pm[0] * pm[3] - pm[1] * pm[2]) < 1e-6) continue;
        }
        if (unexplained.has(i)) {
          // allowed to differ only because the parent differs: a child that differs under a parent that matches is a real bake error
          const p = probe.bones[i].parent!.data.index;
          const differs = (j: number) =>
            want[f][j].some(
              (x, k) => !(Math.abs(x - got[f][j][k]) <= (k < 4 ? 1e-3 : 5e-3) * Math.max(1, Math.abs(x), Math.abs(got[f][j][k]))),
            );
          if (differs(i) && !differs(p))
            return `animation "${anim.name}" frame ${f} bone "${names[i]}" differs from its baked pose although its parent matches (original ${want[f][i].map((v) => v.toFixed(4))}, baked ${got[f][i].map((v) => v.toFixed(4))}; parent original ${want[f][p].map((v) => v.toFixed(4))}, baked ${got[f][p].map((v) => v.toFixed(4))})`;
          continue;
        }
        for (let k = 0; k < 6; k++) {
          const x = want[f][i][k];
          const y = got[f][i][k];
          const scale = Math.max(1, Math.abs(x), Math.abs(y));
          if (!(Math.abs(x - y) <= (k < 4 ? 1e-3 : 5e-3) * scale))
            return `animation "${anim.name}" frame ${f} bone "${names[i]}" element ${k}: original ${x}, baked ${y}`;
        }
      }
    }
  }
  return null;
}

function parity(p: Project, label: string) {
  const m = parityMismatch(p);
  if (m)
    throw new Error(`${label}: bone "${m.bone}".${m.what} ours=${m.ours} official=${m.official} (animation ${m.animation} t=${m.time})`);
}

/** What the selection may refer to: after any action (undo included) no panel is asked about a slot / bone / constraint that is gone. */
function checkSelection(label: string) {
  const sel = uiStore.get().selection;
  const d = doc();
  if (sel.slot && !d.slots.some((s) => s.id === sel.slot)) throw new Error(`${label}: the selection refers to a missing slot`);
  if (sel.attachment && !(sel.slot && d.skins[0]?.attachments[sel.slot]?.[sel.attachment]))
    throw new Error(`${label}: the selection refers to a missing attachment`);
  for (const id of sel.bones) if (!d.bones.some((b) => b.id === id)) throw new Error(`${label}: the selection refers to a missing bone`);
  if (sel.constraint && !d.constraints.some((c) => c.id === sel.constraint))
    throw new Error(`${label}: the selection refers to a missing constraint`);
}

function check(label: string) {
  const p = project();
  const issues = validateProject(p);
  if (issues.length) throw new Error(`${label}: the document needs repair:\n  - ${issues.join('\n  - ')}`);
  checkSelection(label);
  try {
    exportAndLoad(p, { splitColor: true });
  } catch (e) {
    throw new Error(`${label}: the official loader rejected the export: ${(e as Error).message}`);
  }
  finiteSkeleton(p, label);
  const bad = findNonFinite(exportSpineJson(p.skeleton, { splitColor: true }), 'export');
  if (bad) throw new Error(`${label}: non-finite number in the export at ${bad}`);
}

/** Path of the first NaN / Infinity inside a JSON-like tree (JSON.stringify would silently turn them into null). */
function findNonFinite(value: unknown, path: string): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? null : path;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const r = findNonFinite(value[i], `${path}[${i}]`);
      if (r) return r;
    }
  } else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      const r = findNonFinite((value as Record<string, unknown>)[k], `${path}.${k}`);
      if (r) return r;
    }
  }
  return null;
}

// ------------------------------------------------------------------ the runs

let sanitizerInstalled = false;

function freshSession() {
  if (!sanitizerInstalled) {
    docStore.subscribe(A.sanitizeSelection); // the app does the same (App.tsx)
    sanitizerInstalled = true;
  }
  const f = buildFixture();
  addAttachmentRig(f.project); // clipping / bounding boxes (also weighted) / a point, so edits meet them from the first step
  addPathRig(f.project); // paths (open, closed, weighted) and path constraints in every mode
  addPhysicsRig(f.project); // physics constraints of every flavour, animated
  setSettings({ keyGrid: 1, lastChosenCurve: false, savedCurves: [] }); // keys between frames are a preference of the person: every run starts on whole frames
  docStore.replace(f.project);
  uiStore.patch({
    mode: 'setup',
    tool: 'select',
    animationId: f.project.skeleton.animations[0].id,
    skinId: null,
    time: 0,
    selection: emptySelection,
    overrides: {},
    autoKey: true,
    playing: false,
    defaultCurve: 'bezier',
  });
  return f;
}

/** Plays `steps` random actions of one session and returns what was done (throws on the first violated invariant). */
export function playSession(seed: number, steps: number, opts: { parity?: boolean; history?: boolean } = {}): string[] {
  freshSession();
  const initial = structuredClone(docStore.get());
  const c = makeCtx(seed);
  const log: string[] = [];
  for (let step = 0; step < steps; step++) {
    const op = c.pick(ops)!;
    log.push(op.name);
    try {
      op.run(c);
    } catch (e) {
      throw new Error(`seed ${seed}, step ${step} "${op.name}" threw: ${(e as Error).stack}\nsteps: ${log.join(', ')}`);
    }
    try {
      check(`seed ${seed}, step ${step} after "${op.name}"`);
    } catch (e) {
      throw new Error(`${(e as Error).message}\nsteps: ${log.join(', ')}`);
    }
  }
  if (opts.parity !== false) {
    try {
      parity(docStore.get(), `seed ${seed} final state`);
      // the binary export must load as the same skeleton as the JSON
      const bin = compareBinary(docStore.get(), { splitColor: true });
      if (bin.diffs.length) throw new Error(`seed ${seed} final state: binary differs from JSON: ${bin.diffs.slice(0, 5).join('; ')}`);
      const baked = bakeMismatch(docStore.get());
      if (baked) throw new Error(`seed ${seed} final state: a baked animation poses differently: ${baked}`);
      const back = compareReadBack(docStore.get());
      if (back.length) throw new Error(`seed ${seed} final state: the binary reads back differently: ${back.slice(0, 5).join('; ')}`);
    } catch (e) {
      throw new Error(`${(e as Error).message}\nsteps: ${log.join(', ')}`);
    }
  }
  if (opts.history !== false) {
    // history: go to the newest state, undo everything -> exactly the starting document, redo everything -> the newest state again
    let guard = 0;
    while (docStore.canRedo && guard++ < 1000) docStore.redo();
    const newest = structuredClone(docStore.get());
    try {
      check(`seed ${seed} newest state of the history`);
    } catch (e) {
      throw new Error(`${(e as Error).message}\nsteps: ${log.join(', ')}`);
    }
    guard = 0;
    while (docStore.canUndo && guard++ < 1000) docStore.undo();
    expect(docStore.get(), `seed ${seed}: undoing everything\nsteps: ${log.join(', ')}`).toEqual(initial);
    guard = 0;
    while (docStore.canRedo && guard++ < 1000) docStore.redo();
    expect(docStore.get(), `seed ${seed}: redoing everything\nsteps: ${log.join(', ')}`).toEqual(newest);
  }
  return log;
}
