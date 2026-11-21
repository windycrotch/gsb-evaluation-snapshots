/** The skeleton as compiled data: index based, immutable, shared by every instance that poses it. */
import type {
  Animation,
  BlendMode,
  BoundingBoxAttachment,
  ClippingAttachment,
  Id,
  Inherit,
  MeshAttachment,
  PathAttachment,
  PathPositionMode,
  PathRotateMode,
  PathSpacingMode,
  PhysicsParam,
  PointAttachment,
  RGB,
  RGBA,
  RegionAttachment,
  TransformProp,
} from '../model';

export interface BoneData {
  index: number;
  id: Id;
  name: string;
  parent: number;
  children: number[];
  length: number;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  shearX: number;
  shearY: number;
  inherit: Inherit;
  skinRequired: boolean;
  color: RGBA;
}

export interface SlotData {
  index: number;
  id: Id;
  name: string;
  bone: number;
  color: RGBA;
  dark: RGB | null;
  blend: BlendMode;
  attachment: string | null;
}

export interface RegionData {
  kind: 'region';
  src: RegionAttachment;
  name: string;
  path: string;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  width: number;
  height: number;
  color: RGBA;
}

/** Skinned vertex data shared by meshes and polygon attachments (see `meshWorldVertices`). */
export interface VertexData {
  vertexCount: number;
  weighted: boolean;
  /** Unweighted: x,y per vertex. Weighted: (x, y, weight) per influence. */
  positions: Float32Array;
  /** Weighted only: per vertex [influenceCount, boneIndex...]. */
  bones: Int32Array | null;
  /** Length of a deform array for this attachment. */
  deformLength: number;
}

interface MeshData extends VertexData {
  kind: 'mesh';
  src: MeshAttachment;
  name: string;
  path: string;
  color: RGBA;
  width: number;
  height: number;
  uvs: Float32Array;
  triangles: Uint16Array;
  hull: number;
}

interface BoundingBoxData extends VertexData {
  kind: 'boundingbox';
  src: BoundingBoxAttachment;
  name: string;
  color: RGBA;
}

export interface ClippingData extends VertexData {
  kind: 'clipping';
  src: ClippingAttachment;
  name: string;
  color: RGBA;
  /** Id of the last clipped slot (null = until the end). */
  end: Id | null;
  convex: boolean;
  inverse: boolean;
}

export interface PointData {
  kind: 'point';
  src: PointAttachment;
  name: string;
  color: RGBA;
  x: number;
  y: number;
  rotation: number;
}

/** A Bezier path: `vertexCount` points, three per node (in-handle, anchor, out-handle). */
export interface PathAttachmentData extends VertexData {
  kind: 'path';
  src: PathAttachment;
  name: string;
  color: RGBA;
  closed: boolean;
  constantSpeed: boolean;
  /** Setup pose curve lengths (see `pathCurveLengths`). Filled by `compileSkeleton`; every compiled skin owns its copy. */
  lengths: number[];
}

export type AttachmentData = RegionData | MeshData | BoundingBoxData | ClippingData | PointData | PathAttachmentData;

export interface SkinData {
  id: Id;
  name: string;
  /** Indexed by slot index. */
  attachments: Map<string, AttachmentData>[];
  bones: number[];
  constraints: number[];
}

export interface IkData {
  kind: 'ik';
  index: number;
  id: Id;
  name: string;
  bones: number[];
  target: number;
  mix: number;
  softness: number;
  bendDirection: 1 | -1;
  compress: boolean;
  stretch: boolean;
  scaleY: 'none' | 'uniform' | 'volume';
  skinRequired: boolean;
}
interface TransformToData {
  prop: TransformProp;
  offset: number;
  max: number;
  scale: number;
}
interface TransformFromData {
  prop: TransformProp;
  offset: number;
  to: TransformToData[];
}
export interface TransformData {
  kind: 'transform';
  index: number;
  id: Id;
  name: string;
  bones: number[];
  source: number;
  localSource: boolean;
  localTarget: boolean;
  additive: boolean;
  clamp: boolean;
  properties: TransformFromData[];
  /** rotation, x, y, scaleX, scaleY, shearY */
  offsets: number[];
  /** setup mixes: rotate, x, y, scaleX, scaleY, shearY */
  mix: number[];
  skinRequired: boolean;
}
/** Spine 4.3 slider: applies `animation` at a manual time or at a time driven by a bone property. */
export interface SliderData {
  kind: 'slider';
  index: number;
  id: Id;
  name: string;
  /** The animation that is applied (`null`: the slider does nothing). */
  animation: Animation | null;
  /** Bones whose local transform the animation modifies. */
  animatedBones: number[];
  additive: boolean;
  loop: boolean;
  /** Setup mix and setup time. */
  mix: number;
  time: number;
  /** Driver bone index, or -1. */
  bone: number;
  property: TransformProp;
  from: number;
  to: number;
  scale: number;
  local: boolean;
  skinRequired: boolean;
}
/** Spine 4.3 path constraint: bones follow the path attachment shown in `slot`. */
export interface PathConstraintData {
  kind: 'path';
  index: number;
  id: Id;
  name: string;
  bones: number[];
  slot: number;
  positionMode: PathPositionMode;
  spacingMode: PathSpacingMode;
  rotateMode: PathRotateMode;
  offsetRotation: number;
  position: number;
  spacing: number;
  /** setup mixes: rotate, x, y */
  mix: number[];
  skinRequired: boolean;
}
/** Spine 4.3 physics constraint on one bone. `massInverse` and `step` (= 1 / fps) are what the simulation uses. */
export interface PhysicsData {
  kind: 'physics';
  index: number;
  id: Id;
  name: string;
  bone: number;
  x: number;
  y: number;
  rotate: number;
  scaleX: number;
  shearX: number;
  scaleY: 'none' | 'uniform' | 'volume';
  limit: number;
  step: number;
  inertia: number;
  strength: number;
  damping: number;
  massInverse: number;
  wind: number;
  gravity: number;
  mix: number;
  global: Record<PhysicsParam, boolean>;
  skinRequired: boolean;
}
export type ConstraintData = IkData | TransformData | SliderData | PathConstraintData | PhysicsData;

export interface SkeletonData {
  name: string;
  fps: number;
  /** What wind and gravity of the physics constraints are measured against. */
  referenceScale: number;
  bones: BoneData[];
  slots: SlotData[];
  skins: SkinData[];
  defaultSkin: SkinData;
  constraints: ConstraintData[];
  boneIndex: Map<Id, number>;
  slotIndex: Map<Id, number>;
  constraintIndex: Map<Id, number>;
  skinById: Map<Id, SkinData>;
  /** A linked mesh that shares the deform of its source -> the source (the deform timelines of the source move it, its own are ignored). */
  deformSource: Map<AttachmentData, AttachmentData>;
  /** A source mesh -> the slots (other than its own) that can show a linked mesh sharing its deform. */
  deformFollowers: Map<AttachmentData, number[]>;
  /** Token that changes whenever the bone id order changes (invalidates weighted attachment caches). */
  boneOrderKey: string;
  /** The draw order folders: id and the setup indices of their slots in setup order. */
  folders: { id: Id; slots: number[] }[];
}
