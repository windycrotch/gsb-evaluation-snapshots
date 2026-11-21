/**
 * Document model. Plain JSON — every entity has a stable `id` and cross references use ids (never names),
 * so renaming is always safe. Animation data mirrors the Spine 4.3 export structure on purpose.
 */

export type Id = string;
export type RGBA = [number, number, number, number];
export type RGB = [number, number, number];

export type Inherit = 'normal' | 'onlyTranslation' | 'noRotationOrReflection' | 'noScale' | 'noScaleOrReflection';
export const INHERIT_MODES: Inherit[] = ['normal', 'onlyTranslation', 'noRotationOrReflection', 'noScale', 'noScaleOrReflection'];

export type BlendMode = 'normal' | 'additive' | 'multiply' | 'screen';
export const BLEND_MODES: BlendMode[] = ['normal', 'additive', 'multiply', 'screen'];

export interface Bone {
  id: Id;
  name: string;
  parent: Id | null;
  length: number;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  shearX: number;
  shearY: number;
  inherit: Inherit;
  /** Editor color (nonessential). */
  color: RGBA;
  skinRequired: boolean;
  /** Editor-only flags. */
  hidden: boolean;
  locked: boolean;
  /** Editor-only: the name of this bone is drawn in the viewport even when Bone names is off. */
  showName?: boolean;
}

export interface Slot {
  id: Id;
  name: string;
  bone: Id;
  color: RGBA;
  dark: RGB | null;
  /** Setup pose attachment name (key in the skin). */
  attachment: string | null;
  blend: BlendMode;
  hidden: boolean;
}

/** The frames of a region or mesh that changes its picture over time (Spine's sequence). */
export interface SequenceDef {
  /** Number of frames (pictures). */
  count: number;
  /** The number of the first picture (the name is the path with this number added, zero padded to `digits`). */
  start: number;
  /** Zero padding of the number in the picture names. 0 for none. */
  digits: number;
  /** The frame that shows in the setup pose and while no sequence key is active. */
  setupIndex: number;
}

export const SEQUENCE_MODES = ['hold', 'once', 'loop', 'pingpong', 'onceReverse', 'loopReverse', 'pingpongReverse'] as const;
export type SequenceMode = (typeof SEQUENCE_MODES)[number];

/** A sequence timeline key: from this time the frame is `index`, then advances by one every `delay` seconds the way `mode` says. */
export interface SequenceKey {
  time: number;
  mode: SequenceMode;
  index: number;
  delay: number;
}

export interface RegionAttachment {
  type: 'region';
  name: string;
  /** Image name used to look up the texture region (with a sequence: the start of the name of every frame). */
  path: string;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  width: number;
  height: number;
  color: RGBA;
  /** Frame-by-frame pictures (see core/sequence.ts). */
  sequence?: SequenceDef;
}

/** [bone id, bind x, bind y, weight]. Bind position is in the bone's setup-world local space. */
export type Influence = [bone: Id, x: number, y: number, weight: number];

export interface MeshAttachment {
  type: 'mesh';
  name: string;
  path: string;
  color: RGBA;
  /** Source image size in pixels (used for editing/tracing). */
  width: number;
  height: number;
  /** Texture coordinates in 0..1 relative to the image, 2 per vertex. */
  uvs: number[];
  triangles: number[];
  /** Number of leading vertices that form the outline polygon. */
  hull: number;
  /** Vertex index pairs for editor wire edges (nonessential). */
  edges: number[];
  /** Unweighted: x,y per vertex in slot bone space. Empty when `weights` is set. */
  vertices: number[];
  /** Weighted: per vertex influences. `null` when unweighted. */
  weights: Influence[][] | null;
  /** Editor metadata: the region transform this mesh was generated from (used to re-trace). Not exported. */
  region?: { x: number; y: number; rotation: number; scaleX: number; scaleY: number; width: number; height: number };
  /** Frame-by-frame pictures; every frame is a picture the uvs fit. */
  sequence?: SequenceDef;
  /**
   * A linked mesh (Spine's `linkedmesh`): the shape (uvs, triangles, vertices, weights) is the one of the source mesh, the picture
   * (`path`), the colour and the sequence are its own. The shape fields above are a copy that the editor keeps equal to the source
   * (see core/links.ts); the export writes the link instead of the shape.
   */
  link?: MeshLink;
}

export interface MeshLink {
  /** Name of the source mesh (a mesh that is not linked itself). */
  source: string;
  /** Slot of the source mesh; `null` = the slot of this mesh. */
  slot: Id | null;
  /** Skin of the source mesh; `null` = the default skin (the first one). */
  skin: Id | null;
  /** The deform timelines of the source move this mesh too. */
  deform: boolean;
}

/** A single point + rotation in the slot bone's space (spawn points, muzzles …). Never drawn by runtimes. */
export interface PointAttachment {
  type: 'point';
  name: string;
  x: number;
  y: number;
  rotation: number;
  /** Editor color (nonessential). */
  color: RGBA;
}

/**
 * Outline shared by bounding boxes and clipping polygons. Vertex data has the layout of a mesh: unweighted = x,y per
 * vertex in the slot bone's space (`vertices`), weighted = per vertex influences (`weights`, `vertices` empty).
 * Weights are kept (imports, bone deletion) and skinned, but the editor only edits vertex positions.
 */
interface PolygonBase {
  name: string;
  /** Editor color (nonessential). */
  color: RGBA;
  vertices: number[];
  weights: Influence[][] | null;
}

/** A hit test polygon (see Spine's `SkeletonBounds`). */
export interface BoundingBoxAttachment extends PolygonBase {
  type: 'boundingbox';
}

/** Clips the slots from its own slot up to and including `end` (`null` = until the end of the draw order). */
export interface ClippingAttachment extends PolygonBase {
  type: 'clipping';
  /** Id of the last slot that is clipped. */
  end: Id | null;
  /** Treat the polygon as convex (its convex hull is used when it is not). */
  convex: boolean;
  /** Show everything *outside* the polygon (always convex). */
  inverse: boolean;
}

export type PolygonAttachment = BoundingBoxAttachment | ClippingAttachment;

/**
 * A composite Bezier path (Spine's `path` attachment) that bones can follow through a path constraint. Its points have the
 * layout of the file format: three per node — in-handle, anchor, out-handle — in `vertices` (x,y in the slot bone's space) or
 * in `weights` when the path is skinned to bones. A path with `n` nodes therefore has `3n` points; an open one has `n - 1`
 * curves (its first in-handle and last out-handle are unused placeholders), a closed one `n` curves.
 */
export interface PathAttachment extends PolygonBase {
  type: 'path';
  closed: boolean;
  /**
   * Constant speed along the path: curve lengths are measured every frame. Otherwise the lengths of the setup pose are used
   * (they are computed when the skeleton is compiled and exported, never stored).
   */
  constantSpeed: boolean;
}

export type Attachment = RegionAttachment | MeshAttachment | PolygonAttachment | PointAttachment | PathAttachment;

/** Number of vertices of a polygon (or number of points of a path) attachment. */
export function polygonVertexCount(p: { vertices: number[]; weights: Influence[][] | null }): number {
  return p.weights ? p.weights.length : p.vertices.length >> 1;
}

/** Number of nodes (anchors) of a path. */
export function pathNodeCount(p: { vertices: number[]; weights: Influence[][] | null }): number {
  return Math.floor(polygonVertexCount(p) / 3);
}

export const DEFAULT_CLIPPING_COLOR: RGBA = [0.808, 0.227, 0.227, 1];
export const DEFAULT_BOUNDING_BOX_COLOR: RGBA = [0.38, 0.94, 0, 1];
export const DEFAULT_POINT_COLOR: RGBA = [0.945, 0.945, 0, 1];
export const DEFAULT_PATH_COLOR: RGBA = [1, 0.5, 0, 1];

/** Image (atlas region) name of an attachment, or null for attachments that have no image. */
export function attachmentImage(a: Attachment): string | null {
  return a.type === 'region' || a.type === 'mesh' ? a.path : null;
}

export interface Skin {
  id: Id;
  name: string;
  /** slot id -> attachment name -> attachment */
  attachments: Record<Id, Record<string, Attachment>>;
  bones: Id[];
  constraints: Id[];
}

export interface IkConstraint {
  id: Id;
  type: 'ik';
  name: string;
  /** 1 or 2 bones. For 2 bones the second must be a direct child of the first. */
  bones: Id[];
  target: Id;
  mix: number;
  softness: number;
  bendPositive: boolean;
  compress: boolean;
  stretch: boolean;
  /** How scaleY follows scaleX when compress/stretch scales a bone. */
  scaleY: 'none' | 'uniform' | 'volume';
  skinRequired: boolean;
}
/** Transform constraint properties (Spine 4.3). */
export type TransformProp = 'rotate' | 'x' | 'y' | 'scaleX' | 'scaleY' | 'shearY';
export const TRANSFORM_PROPS: TransformProp[] = ['rotate', 'x', 'y', 'scaleX', 'scaleY', 'shearY'];

/** One constrained property: value = offset + (source - from.offset) * scale, optionally clamped to offset..max. */
interface TransformTo {
  prop: TransformProp;
  offset: number;
  max: number;
  scale: number;
}

/** A source property and the target properties it drives. */
export interface TransformFrom {
  prop: TransformProp;
  offset: number;
  to: TransformTo[];
}

export interface TransformConstraint {
  id: Id;
  type: 'transform';
  name: string;
  /** Bones that are modified. */
  bones: Id[];
  /** Bone whose transform is read. */
  source: Id;
  localSource: boolean;
  localTarget: boolean;
  additive: boolean;
  clamp: boolean;
  properties: TransformFrom[];
  /** Offsets applied to the source value (rotation, x, y, scaleX, scaleY, shearY). */
  offsets: { rotation: number; x: number; y: number; scaleX: number; scaleY: number; shearY: number };
  /** Setup mixes, 0..1. */
  mix: { rotate: number; x: number; y: number; scaleX: number; scaleY: number; shearY: number };
  skinRequired: boolean;
}

/**
 * Spine 4.3 slider: applies an animation at a time that is set by hand (and can be keyed) or driven by a bone property:
 * `time = to + (value(property) - from) * scale`.
 */
export interface SliderConstraint {
  id: Id;
  type: 'slider';
  name: string;
  /** Id of the animation to apply. `null` until one is chosen — such a slider does nothing and is not exported. */
  animation: Id | null;
  /** Add the animation's values to the current pose instead of replacing them. */
  additive: boolean;
  /** Wrap the time around the animation's duration instead of clamping it. */
  loop: boolean;
  /** Setup mix (0..1) and setup time in seconds; the time is only used when no bone drives it. */
  mix: number;
  time: number;
  /** Optional driver bone. */
  bone: Id | null;
  property: TransformProp;
  from: number;
  to: number;
  scale: number;
  /** Upper end of the driven range (editor metadata, the runtime does not use it). */
  max: number;
  /** Read the bone's local transform instead of its world transform. */
  local: boolean;
  skinRequired: boolean;
}

export type PathPositionMode = 'fixed' | 'percent';
export type PathSpacingMode = 'length' | 'fixed' | 'percent' | 'proportional';
export type PathRotateMode = 'tangent' | 'chain' | 'chainScale';
export const PATH_POSITION_MODES: PathPositionMode[] = ['fixed', 'percent'];
export const PATH_SPACING_MODES: PathSpacingMode[] = ['length', 'fixed', 'percent', 'proportional'];
export const PATH_ROTATE_MODES: PathRotateMode[] = ['tangent', 'chain', 'chainScale'];

/**
 * Spine 4.3 path constraint: moves (and rotates / scales) bones along the path attachment that is currently shown in `target`
 * (a slot). The first bone sits at `position`, the others follow with `spacing`.
 */
export interface PathConstraint {
  id: Id;
  type: 'path';
  name: string;
  /** Bones that follow the path. */
  bones: Id[];
  /** Slot whose path attachment is followed. */
  target: Id;
  /** `fixed`: `position` is a distance along the path; `percent`: 0..1 of its length. */
  positionMode: PathPositionMode;
  /** `length`: the bones' lengths plus `spacing`; `fixed`: `spacing` apart; `percent`: of the path length; `proportional`: relative to the bone lengths. */
  spacingMode: PathSpacingMode;
  /** `tangent`: bones face along the path; `chain`: bones keep their lengths and point at the next one; `chainScale`: bones are also stretched to reach it. */
  rotateMode: PathRotateMode;
  /** Degrees added to the rotation of the bones. */
  offsetRotation: number;
  /** Setup position of the first bone and setup spacing (animatable). */
  position: number;
  spacing: number;
  /** Setup mixes, 0..1. */
  mix: { rotate: number; x: number; y: number };
  skinRequired: boolean;
}

/** Which animatable parameters of a physics constraint are driven by the animation's GLOBAL physics timelines. */
export type PhysicsParam = 'inertia' | 'strength' | 'damping' | 'mass' | 'wind' | 'gravity' | 'mix';
export const PHYSICS_PARAMS: PhysicsParam[] = ['inertia', 'strength', 'damping', 'mass', 'wind', 'gravity', 'mix'];

/**
 * Spine 4.2+ physics constraint: a spring simulation that moves, rotates, scales or shears ONE bone as if it hung on the
 * bone's own movement. The simulation advances in steps of `1 / fps` seconds and only runs while an animation plays.
 */
export interface PhysicsConstraint {
  id: Id;
  type: 'physics';
  name: string;
  bone: Id;
  /** How much the simulation moves / rotates / scales / shears the bone, 0..1 (0 = not at all). */
  x: number;
  y: number;
  rotate: number;
  scaleX: number;
  shearX: number;
  /** How scaleY follows scaleX. */
  scaleY: 'none' | 'uniform' | 'volume';
  /** Movement beyond this many units per second makes no more effect. */
  limit: number;
  /** Simulation steps per second. */
  fps: number;
  /** Setup values of the animatable parameters. */
  inertia: number;
  strength: number;
  damping: number;
  /** The mass; the runtime stores 1 / mass. */
  mass: number;
  wind: number;
  gravity: number;
  mix: number;
  /** Parameters taken from the global physics timelines of the animation instead of the constraint's own. */
  global: Record<PhysicsParam, boolean>;
  skinRequired: boolean;
}

export type Constraint = IkConstraint | TransformConstraint | SliderConstraint | PathConstraint | PhysicsConstraint;

export function constraintBoneIds(c: Constraint): Id[] {
  if (c.type === 'ik') return [...c.bones, c.target];
  if (c.type === 'transform') return [...c.bones, c.source];
  if (c.type === 'path') return [...c.bones];
  if (c.type === 'physics') return [c.bone];
  return c.bone ? [c.bone] : [];
}

export interface EventDef {
  id: Id;
  name: string;
  int: number;
  float: number;
  string: string;
  /** The sound that goes with the event (a path the engine resolves). The editor keeps it for the export; it does not play it. */
  audio?: string;
  /** 0..1, default 1; only with `audio`. */
  volume?: number;
  /** -1 (left) .. 1 (right), default 0; only with `audio`. */
  balance?: number;
}

/** `undefined` = linear, `'stepped'`, or normalized bezier: 4 numbers (x1,y1,x2,y2) per channel, x/y in 0..1 of the segment. */
export type Curve = 'stepped' | number[];

export interface Key {
  time: number;
  value: number[];
  curve?: Curve;
}
export type Timeline = Key[];

export interface AttachmentKey {
  time: number;
  name: string | null;
}

export interface IkKey extends Key {
  /** value = [mix, softness] */
  bendPositive: boolean;
  compress: boolean;
  stretch: boolean;
}

/** A group of slots whose draw order can be keyed on its own (Spine 4.3 "draw order folder"): the slots swap places among the seats they hold. */
export interface DrawOrderFolder {
  id: Id;
  name: string;
  slots: Id[];
}

interface DrawOrderKey {
  time: number;
  /** Complete slot id order (bottom to top). */
  order: Id[];
}

export interface EventKey {
  time: number;
  event: Id;
  int?: number;
  float?: number;
  string?: string;
  /** Overrides of the definition's volume and balance (an event with audio). */
  volume?: number;
  balance?: number;
}

/** Slider timelines. value = [seconds] / [mix]. */
interface SliderTimelines {
  time?: Timeline;
  mix?: Timeline;
}

/** Path constraint timelines. value = [position] / [spacing] / [mixRotate, mixX, mixY]. */
export interface PathTimelines {
  position?: Timeline;
  spacing?: Timeline;
  mix?: Timeline;
}

/** The key of `Animation.physics` that holds the GLOBAL timelines (the file stores them under an empty constraint name). */
export const GLOBAL_PHYSICS = '*';

/** Physics constraint timelines, one value per key (the mass is NOT inverted). `reset` keys restart the simulation; their value is ignored. */
export interface PhysicsTimelines {
  inertia?: Timeline;
  strength?: Timeline;
  damping?: Timeline;
  mass?: Timeline;
  wind?: Timeline;
  gravity?: Timeline;
  mix?: Timeline;
  reset?: Timeline;
}

export interface BoneTimelines {
  /** value = [degrees] relative to setup */
  rotate?: Timeline;
  /** value = [x, y] relative to setup */
  translate?: Timeline;
  /** value = [x] relative to setup: the X of a split translate (Spine's `translatex`; its own key times and curves) */
  translatex?: Timeline;
  translatey?: Timeline;
  /** value = [x, y] multiplier of setup scale */
  scale?: Timeline;
  /** value = [x] multiplier of the setup scale (a split scale) */
  scalex?: Timeline;
  scaley?: Timeline;
  /** value = [x, y] degrees relative to setup */
  shear?: Timeline;
  /** value = [x] degrees relative to setup (a split shear) */
  shearx?: Timeline;
  sheary?: Timeline;
}

/** Every timeline name a bone can carry. */
export type BoneProp = keyof BoneTimelines;
export const BONE_PROPS: BoneProp[] = [
  'rotate',
  'translate',
  'translatex',
  'translatey',
  'scale',
  'scalex',
  'scaley',
  'shear',
  'shearx',
  'sheary',
];
/** The three channels that can be keyed per axis, and the two timelines each splits into. */
export type AxisGroup = 'translate' | 'scale' | 'shear';
export const AXIS_GROUPS: Record<AxisGroup, [BoneProp, BoneProp]> = {
  translate: ['translatex', 'translatey'],
  scale: ['scalex', 'scaley'],
  shear: ['shearx', 'sheary'],
};
/** The group a timeline belongs to (a combined one or one of its axes), or null for rotate. */
export function axisGroupOf(prop: string): AxisGroup | null {
  for (const g of Object.keys(AXIS_GROUPS) as AxisGroup[]) if (g === prop || AXIS_GROUPS[g].includes(prop as BoneProp)) return g;
  return null;
}

interface SlotTimelines {
  attachment?: AttachmentKey[];
  /** value = [r, g, b, a] absolute (the light color) */
  rgba?: Timeline;
  /**
   * Two-color tinting: value = [r, g, b, a, darkR, darkG, darkB] absolute. Needs `slot.dark` (the setup dark color) and
   * replaces `rgba` on that slot (Spine's `rgba2` timeline).
   */
  rgba2?: Timeline;
}

export interface Animation {
  id: Id;
  name: string;
  /** Explicit length in seconds (>= last key). */
  duration: number;
  bones: Record<Id, BoneTimelines>;
  slots: Record<Id, SlotTimelines>;
  ik: Record<Id, IkKey[]>;
  /** Transform constraint mixes over time. value = [mixRotate, mixX, mixY, mixScaleX, mixScaleY, mixShearY]. */
  transform: Record<Id, Timeline>;
  /** Slider time / mix over time, by constraint id. */
  slider: Record<Id, SliderTimelines>;
  /** Path constraint position / spacing / mixes over time, by constraint id. */
  path: Record<Id, PathTimelines>;
  /** Physics constraint parameters over time, by constraint id (`GLOBAL_PHYSICS` = the global timelines). */
  physics: Record<Id, PhysicsTimelines>;
  /** skin id -> slot id -> attachment name -> keys; Key.value = per vertex deltas (x,y pairs; per influence for weighted meshes). */
  deform: Record<Id, Record<Id, Record<string, Timeline>>>;
  /** skin id -> slot id -> attachment name -> sequence keys (only for a region or mesh that has a `sequence`). Absent in older projects. */
  sequence?: Record<Id, Record<Id, Record<string, SequenceKey[]>>>;
  drawOrder: DrawOrderKey[];
  /** Draw order keys of the folders (SkeletonDoc.drawOrderFolders), by folder id; each key's `order` lists the slots of that folder. */
  drawOrderFolder?: Record<Id, DrawOrderKey[]>;
  events: EventKey[];
  /** How the editor plays this animation (loop, ping-pong, play range). Editor metadata: not part of the Spine export. Absent = looping, whole animation. */
  play?: PlaySettings;
  /** Notes on the timeline (a beat, a sound cue, a comment for the team). Editor metadata: not part of the Spine export. */
  markers?: Marker[];
}

/** A flag on the timeline of one animation. `color` is a position in the marker palette (0 to MARKER_COLORS - 1). */
export interface Marker {
  id: Id;
  time: number;
  name: string;
  color: number;
  text: string;
  /** A comment that came from a review (core/review.ts): who wrote it, which bone it points at, and whether it is dealt with. */
  review?: boolean;
  author?: string;
  bone?: string;
  resolved?: boolean;
}
export const MARKER_COLORS = 6;

export interface PlaySettings {
  loop: boolean;
  pingPong: boolean;
  /** Seconds [start, end] to play instead of the whole animation, or null. */
  range: [number, number] | null;
}

/** A group of bones kept under a name so that one click selects them (editor data, not exported; see core/selsets.ts). */
export interface SelectionSet {
  id: Id;
  name: string;
  bones: Id[];
}

export interface SkeletonDoc {
  name: string;
  fps: number;
  /** Size that wind and gravity of the physics constraints are measured against (Spine's default is 100). */
  referenceScale?: number;
  bones: Bone[];
  slots: Slot[];
  skins: Skin[];
  constraints: Constraint[];
  events: EventDef[];
  animations: Animation[];
  /** Groups of slots with a draw order of their own (absent = none). */
  drawOrderFolders?: DrawOrderFolder[];
  /** Groups of bones the animator selects with one click (absent = none). Editor data: the export does not carry it. */
  selectionSets?: SelectionSet[];
  /** Editor data that belongs to this skeleton and is kept here while another skeleton of the project is being edited (see core/skeletons.ts). */
  aside?: { poses?: PoseEntry[]; mixes?: { default: number; pairs: { from: Id; to: Id; time: number }[] } };
}

export interface ImageRef {
  id: Id;
  /** Unique name; also the atlas region name. */
  name: string;
  width: number;
  height: number;
  /** Where the middle of this picture was in the scene when it came from a PSD layer (editor metadata, not exported): "Update from PSD" moves the attachments by how far the layer moved. */
  psd?: [number, number];
  /** How many times the pixels behind this picture were replaced (editor metadata: it makes a same-size repaint a step of the history). */
  rev?: number;
}

/** The local transform of one bone. */
export interface BonePose {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  shearX: number;
  shearY: number;
}

/** A pose kept in the pose library: the local transforms of some bones by bone name (so it survives renaming ids and works after a bone is added). Not exported. */
export interface PoseEntry {
  id: Id;
  name: string;
  bones: Record<string, BonePose>;
}

export interface Project {
  format: 'bone2d';
  version: 1;
  name: string;
  /** The skeleton being edited. */
  skeleton: SkeletonDoc;
  /** The other skeletons of the project, in the order of the list without the edited one (absent = the project has one skeleton). */
  others?: SkeletonDoc[];
  /** Where the edited skeleton stands in the list of all of them. */
  activeAt?: number;
  images: ImageRef[];
  /** The pose library of the editor (poses are not part of the Spine export). */
  poses?: PoseEntry[];
  /** Guide lines laid over the scene in the editor (not part of the Spine export). */
  guides?: { x: number[]; y: number[] };
  /** Crossfade times between animations for the Preview window (not part of the Spine export; see core/preview.ts). */
  mixes?: { default: number; pairs: { from: Id; to: Id; time: number }[] };
}

import { uid } from './ids';

export function newBone(partial: Partial<Bone> & { name: string }): Bone {
  return {
    id: uid(),
    parent: null,
    length: 0,
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    shearX: 0,
    shearY: 0,
    inherit: 'normal',
    color: [0.6, 0.6, 0.6, 1],
    skinRequired: false,
    hidden: false,
    locked: false,
    ...partial,
  };
}

export function newSlot(partial: Partial<Slot> & { name: string; bone: Id }): Slot {
  return {
    id: uid(),
    color: [1, 1, 1, 1],
    dark: null,
    attachment: null,
    blend: 'normal',
    hidden: false,
    ...partial,
  };
}

export function newSkin(name: string): Skin {
  return { id: uid(), name, attachments: {}, bones: [], constraints: [] };
}

export function newAnimation(name: string, duration = 1): Animation {
  return {
    id: uid(),
    name,
    duration,
    bones: {},
    slots: {},
    ik: {},
    transform: {},
    slider: {},
    path: {},
    physics: {},
    deform: {},
    drawOrder: [],
    events: [],
  };
}

export function newPathConstraint(partial: Partial<PathConstraint> & { name: string; bones: Id[]; target: Id }): PathConstraint {
  return {
    id: uid(),
    type: 'path',
    positionMode: 'percent',
    spacingMode: 'length',
    rotateMode: 'chain',
    offsetRotation: 0,
    position: 0,
    spacing: 0,
    mix: { rotate: 1, x: 1, y: 1 },
    skinRequired: false,
    ...partial,
  };
}

export function newPhysicsConstraint(partial: Partial<PhysicsConstraint> & { name: string; bone: Id }): PhysicsConstraint {
  return {
    id: uid(),
    type: 'physics',
    x: 0,
    y: 0,
    rotate: 1,
    scaleX: 0,
    shearX: 0,
    scaleY: 'none',
    limit: 5000,
    fps: 60,
    inertia: 0.5,
    strength: 100,
    damping: 0.85,
    mass: 1,
    wind: 0,
    gravity: 0,
    mix: 1,
    global: { inertia: false, strength: false, damping: false, mass: false, wind: false, gravity: false, mix: false },
    skinRequired: false,
    ...partial,
  };
}

export function newSliderConstraint(partial: Partial<SliderConstraint> & { name: string }): SliderConstraint {
  return {
    id: uid(),
    type: 'slider',
    animation: null,
    additive: false,
    loop: false,
    mix: 1,
    time: 0,
    bone: null,
    property: 'rotate',
    from: 0,
    to: 0,
    scale: 1,
    max: 0,
    local: false,
    skinRequired: false,
    ...partial,
  };
}

export function newTransformConstraint(
  partial: Partial<TransformConstraint> & { name: string; bones: Id[]; source: Id },
): TransformConstraint {
  return {
    id: uid(),
    type: 'transform',
    localSource: false,
    localTarget: false,
    additive: false,
    clamp: false,
    properties: [{ prop: 'rotate', offset: 0, to: [{ prop: 'rotate', offset: 0, max: 1, scale: 1 }] }],
    offsets: { rotation: 0, x: 0, y: 0, scaleX: 0, scaleY: 0, shearY: 0 },
    mix: { rotate: 1, x: 1, y: 1, scaleX: 1, scaleY: 1, shearY: 1 },
    skinRequired: false,
    ...partial,
  };
}

/** Fills fields that older project files lack. Safe to call repeatedly. */
export function migrateProject(p: Project): Project {
  p.format = 'bone2d'; // files saved before the project was renamed from "Marrow" carry the old tag
  for (const doc of [p.skeleton, ...(p.others ?? [])]) {
    for (const a of doc.animations) {
      if (!a.transform) a.transform = {};
      if (!a.slider) a.slider = {};
      if (!a.path) a.path = {};
      if (!a.physics) a.physics = {};
    }
  }
  return p;
}

export function emptyProject(name = 'untitled'): Project {
  const root = newBone({ name: 'root' });
  return {
    format: 'bone2d',
    version: 1,
    name,
    skeleton: {
      name,
      fps: 30,
      bones: [root],
      slots: [],
      skins: [newSkin('default')],
      constraints: [],
      events: [],
      animations: [],
    },
    images: [],
  };
}
