// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================
import { Matrix4, Vector3 } from 'three';
import { ModelOptions } from './ModelOptions';
import { SplatTiles } from './SplatTiles';
import { MetaData } from './MetaData';

/**
 * SPX file header information
 */
export class SpxHeader {
    public Fixed: string;
    public Version: number;
    public SplatCount: number;
    public MinX: number;
    public MaxX: number;
    public MinY: number;
    public MaxY: number;
    public MinZ: number;
    public MaxZ: number;
    public MinTopY: number;
    public MaxTopY: number;
    public CreateDate: number;
    public CreaterId: number;
    public ExclusiveId: number;
    public ShDegree: number;
    public Flags: number;
    public Lod: number;
    public Reserve3: number;
    public Reserve1: number;
    public Reserve2: number;
    public Comment: string;

    public HashCheck: boolean;
}

/**
 * Splat model
 */
export class SplatModel {
    /** Model options */
    public readonly opts: ModelOptions;

    /** File size (bytes) */
    public fileSize: number = 0;
    /** Downloaded size (bytes) */
    public downloadSize: number = 0;

    /** Current model status */
    public status: ModelStatus = ModelStatus.FetchReady;

    /** Raw model data */
    public splatData: Uint8Array = null;
    /** Raw model data (xyz) */
    public xyz: Float32Array = null;
    /** Watermark data */
    public watermarkData: Uint8Array = null;
    /** Number of Gaussians in the model */
    public dataSplatCount: number = 0;
    /** Number of watermark Gaussians */
    public watermarkCount: number = 0;

    /** Spherical harmonics (level 1 or 1+2) */
    public sh12Data: Uint8Array[] = [];
    /** Spherical harmonics (level 3 only) */
    public sh3Data: Uint8Array[] = [];
    /** Downloaded SH (level 1 or 1+2) count */
    public sh12Count: number = 0;
    /** Downloaded SH (level 3 only) count */
    public sh3Count: number = 0;

    /** Byte length of a single Gaussian record */
    public rowLength: number = 0;
    /** Total Gaussian count in the model */
    public modelSplatCount: number = -1;
    /** Downloaded Gaussian count */
    public downloadSplatCount: number = 0;
    /** Render-ready Gaussian count (dynamic for large scenes) */
    public renderSplatCount: number = 0;

    /** Abort controller for fetch cancellation */
    public abortController: AbortController;

    /**
     * Monotonic id of the currently running load session.
     * Every call to a loader opens a new session; late chunks of an old session
     * carry a smaller id and must never be written into the current session.
     */
    public loadSessionId: number = 0;

    /**
     * Why the current/last fetch was aborted.
     * Distinguishes an active stop at fetchLimit (data is kept, status becomes FetchDone)
     * from a user cancellation (data is discarded, status becomes FetchAborted).
     */
    public abortReason: FetchAbortReason = FetchAbortReason.None;
    /** True while the running session has already reached fetchLimit */
    public fetchLimitReached: boolean = false;

    /** Header info for .spx format */
    public header: SpxHeader = null;

    public spzVersion: number;
    public sogVersion: number;

    public CompressionRatio: string = '';

    public dataShDegree: number = 0;

    /** Model metadata */
    public meta: MetaData;

    /** Bounding box extents */
    public minX: number = Infinity;
    public maxX: number = -Infinity;
    public minY: number = Infinity;
    public maxY: number = -Infinity;
    public minZ: number = Infinity;
    public maxZ: number = -Infinity;
    /** Highest Y coordinate */
    public topY: number = 0;
    public currentRadius: number = 0;
    public aabbCenter: Vector3;
    /** Bounding sphere radius for .spx */
    public maxRadius: number = 0;
    public metaMatrix: Matrix4;

    /** Flags */
    public notifyFetchStopDone: boolean;
    public smallSceneUploadDone: boolean;
    public textWatermarkVersion: number = 0;
    public lastTextWatermarkVersion: number = 0;

    public fetchLimit: number = 0;

    /** sh palettes */
    public palettes?: Uint8Array;

    public isPointCloudPly?: boolean;

    constructor(opts: ModelOptions, meta: MetaData = {}) {
        this.opts = { ...opts };
        const that = this;

        that.meta = meta;
        that.metaMatrix = meta.transform ? new Matrix4().fromArray(meta.transform) : null;

        if (!opts.format) {
            if (opts.url?.endsWith('.spx')) {
                that.opts.format = 'spx';
            } else if (opts.url?.endsWith('.splat')) {
                that.opts.format = 'splat';
            } else if (opts.url?.endsWith('.ply')) {
                that.opts.format = 'ply';
            } else if (opts.url?.endsWith('.spz')) {
                that.opts.format = 'spz';
            } else if (opts.url?.endsWith('.zip') || opts.url?.endsWith('.sog') || opts.url?.endsWith('meta.json')) {
                that.opts.format = 'sog';
            } else if (opts.url?.endsWith('.glb')) {
                that.opts.format = 'glb';
            } else {
                console.error('unknown format!');
            }
        }
        that.abortController = new AbortController(); // TODO
    }

    /**
     * User-initiated cancellation of the running fetch.
     * Unlike hitting fetchLimit, an explicit cancel discards the partial data
     * and the load ends in ModelStatus.FetchAborted.
     */
    public cancelLoad(): void {
        this.abortReason = FetchAbortReason.UserCancel;
        this.fetchLimitReached = false;
        this.abortController?.abort();
    }
}

/**
 * Model status
 */
export enum ModelStatus {
    /** Ready */
    FetchReady = 0,
    /** In progress */
    Fetching,
    /**
     * Completed successfully. This also covers an active stop at fetchLimit:
     * the parsed subset is kept and considered a finished (partial) load.
     */
    FetchDone,
    /**
     * Interrupted by an explicit user cancellation.
     * Partial data is discarded; a subsequent load starts from a clean state.
     */
    FetchAborted,
    /** Request failed */
    FetchFailed,
    /** Invalid model format or data */
    Invalid,
}

/**
 * Why a fetch was aborted
 */
export enum FetchAbortReason {
    /** Not aborted */
    None = 0,
    /** Stopped on purpose because fetchLimit points were parsed; keep data and finish */
    FetchLimit,
    /** Cancelled by the user; discard partial data and mark FetchAborted */
    UserCancel,
}
