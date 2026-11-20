import type { ClodMeta } from './index.js';

export interface BuildOptions {
  /** Path of the .glb to read. */
  input: string;
  /** Output folder; created if missing. */
  outDir: string;
  /** Output file stem. Default: the input file name without extension. */
  name?: string;
  /** Resize textures to N x N JPEG with ffmpeg; 0 (default) copies them unchanged. */
  textureSize?: number;
  /** Simplify the source to at most this many triangles first; 0 (default) keeps all. */
  maxTriangles?: number;
  /** Cap group error at N x longest edge (clusterlod.h style); 0 (default) = off. */
  edgeLimit?: number;
  /** Also write four discrete LODs for DiscreteLodSet. Default true. */
  lods?: boolean;
  normalWeight?: number;
  uvWeight?: number;
  sloppyAt?: number;
  errorCap?: number;
  log?: (message: string) => void;
}

export function buildClod(options: BuildOptions): Promise<{ name: string; bin: string; json: string; meta: ClodMeta }>;
export function verifyClod(dir: string, name: string, log?: (message: string) => void): Promise<{ ok: boolean; extraOpenEdges: number; monotonicityViolations: number }>;
export function cutStats(dir: string, name: string, radius?: number, log?: (message: string) => void): { distance: number; px1: number; px2: number; px4: number }[];
