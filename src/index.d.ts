import type { BufferGeometry, Camera, Frustum, Group, InstancedMesh, Material, Matrix4, Mesh, MeshStandardMaterial, MeshStandardMaterialParameters, Sphere, Vector3 } from 'three';

/** Contents of <name>.json as written by the preprocessor. */
export interface ClodMeta {
  name: string;
  version: number;
  sourceTris: number;
  clusters: number;
  groups: number;
  levels: number;
  coarsestTris: number;
  vertices: number;
  binBytes: number;
  bbMin: [number, number, number];
  bbMax: [number, number, number];
  lods: { start: number; count: number; tris: number; error: number }[];
  levelRanges: { level: number; indexEnd: number; vertexEnd: number; bytes: number }[];
  textures: { basecolor?: string; normal?: string; orm?: string };
  material?: { baseColorFactor: number[]; metallicFactor: number; roughnessFactor: number; doubleSided: boolean };
  sections: Record<string, { offset: number; bytes: number; type: string }>;
  [key: string]: unknown;
}

export interface ClodAsset {
  name: string;
  meta: ClodMeta;
  /** Every level in one geometry (streaming assets: the levels currently resident). Draw it through ClodBatch, not directly. */
  geometry: BufferGeometry;
  /** Bounding sphere in model space. */
  sphere: Sphere;
  /** Coarsest level that is resident: 0 when all geometry is loaded, larger while a streaming asset is partial. */
  loadedLevel: number;
  /** Bytes of geometry currently held; shrinks again when detail is released. */
  residentBytes: number;
  /** Bytes of the whole level prefix (all detail). */
  fullBytes: number;
  /** Streaming assets only. */
  stream?: true;
  /** Coarsest level loaded up front by `rootBytes`. */
  rootLevel?: number;
  /** Level the asset is heading for (>= loadedLevel while loading, < loadedLevel after a zoom-out). */
  targetLevel?: number;
  /** Last request failure, or null. A failed asset retries on the next updateStreaming(). */
  lastError?: Error | null;
  /** The in-flight load operation, or null. There is at most one per asset. */
  loading?: Promise<boolean> | null;
  /** Number of HTTP Range requests issued so far (including retries). */
  requests?: number;
  /** Streaming: fetch geometry down to `level` and release anything finer. Resolves true when the
   *  asset is at that level, false when it is not (failure or a newer target). */
  loadTo?(level: number): Promise<boolean>;
  [key: string]: unknown;
}

export function loadClod(base: string, name: string): Promise<ClodAsset>;
export function loadClodStream(base: string, name: string, options?: { rootBytes?: number; delayMs?: number } | number): Promise<ClodAsset>;
/** Starts/continues loads for assets whose last selection needed levels they do not have, and releases
 *  levels the cut no longer uses. The returned promises never reject; check `asset.lastError`. */
export function updateStreaming(assets: ClodAsset[]): Promise<boolean>[];
export function loadClodMaterial(base: string, asset: ClodAsset, params?: MeshStandardMaterialParameters): MeshStandardMaterial;

export class ClodBatch extends Mesh {
  constructor(asset: ClodAsset, material: Material, matrices: Matrix4[]);
  readonly asset: ClodAsset;
  /** Number of instances. */
  readonly count: number;
}

export interface ClodSelectOptions {
  /** Allowed geometric error in pixels. In budget mode: the floor below which refinement stops. */
  errorPx: number;
  /** Triangle budget for all batches of this selector; 0 or undefined = threshold mode. */
  budget?: number;
}
export interface ClodStats { tris: number; clusters: number; visited: number; ms: number; threshold: number; occluded?: number }
export interface HzbSnapshot { data: Float32Array; w: number; h: number; vp: Float32Array; near: number; far: number; px: number; py: number }

export class ClodSelector {
  constructor(batches: ClodBatch[]);
  batches: ClodBatch[];
  frustumCull: boolean;
  hzb?: HzbSnapshot | null;
  readonly stats: ClodStats;
  select(camera: Camera, viewportHeightPx: number, options: ClodSelectOptions): ClodStats;
}

export class DiscreteLodSet extends Group {
  constructor(asset: ClodAsset, material: Material, matrices: Matrix4[]);
  levels: InstancedMesh[];
  select(cameraPosition: Vector3, frustum: Frustum, K: number, errorPx: number, forceFull?: boolean): { tris: number; drawn: number };
}

export function patchDebug<T extends Material>(material: T): T;
export const debugUniform: { value: 0 | 1 | 2 | number };
export function sphereOccluded(hzb: HzbSnapshot, x: number, y: number, z: number, r: number): boolean;
