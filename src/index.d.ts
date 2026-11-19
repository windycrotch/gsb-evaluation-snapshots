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
  /** Every level in one geometry. Draw it through ClodBatch, not directly. */
  geometry: BufferGeometry;
  /** Bounding sphere in model space. */
  sphere: Sphere;
  /** 0 when all geometry is loaded; larger while a streaming asset is partial. */
  loadedLevel: number;
  residentBytes: number;
  fullBytes: number;
  /** Streaming assets only. */
  stream?: true;
  /**
   * Streaming assets: fetch geometry down to `level`. Resolves once the bytes are in memory; the bigger
   * geometry is swapped in by the next ClodSelector.select(). While one request is in flight, every call
   * returns that same Promise. A rejected load leaves the current (coarser) geometry in place; call again
   * to retry.
   */
  loadTo?(level: number): Promise<void>;
  loading?: Promise<void> | null;
  /** Streaming assets: the fetched prefix waiting for the next select() to swap it in. */
  pending?: { level: number; bytes: number } | null;
  /** Streaming assets: the finest level the last selection wanted but did not have; 255 = nothing. */
  wantLevel?: number;
  /** Streaming assets: the error of the last failed load, cleared by the next successful one. */
  loadError?: Error | null;
  /** Streaming assets: Range requests issued so far (four per level fetch). */
  requests?: number;
  [key: string]: unknown;
}

export function loadClod(base: string, name: string): Promise<ClodAsset>;
export function loadClodStream(base: string, name: string, options?: { rootBytes?: number; delayMs?: number } | number): Promise<ClodAsset>;
/**
 * Call once per frame after select(). Starts a fetch for each streaming asset whose last selection wanted
 * a finer level than is loaded, and returns the pending promises (they resolve when bytes are fetched,
 * before the swap; failures are recorded on `asset.loadError` rather than rejecting). Callers that want to
 * see failures should use `asset.loadTo()` directly.
 */
export function updateStreaming(assets: ClodAsset[]): Promise<void>[];
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
