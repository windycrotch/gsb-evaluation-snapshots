// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================
import { Matrix4, Vector3 } from 'three';
import { ModelOptions } from './ModelOptions';
import { SplatTiles } from './SplatTiles';
import { MetaData } from './MetaData';
import { inferModelFormatFromUrl } from '../utils/LocalFileUtils';

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
            // 统一的扩展名推断（小写比较、忽略查询参数）；blob: 地址无扩展名时不在此猜测
            that.opts.format = inferModelFormatFromUrl(opts.url);
            if (!that.opts.format && !opts.url?.startsWith('blob:')) {
                console.error('unknown format!', opts.url);
            }
        }
        that.abortController = new AbortController(); // TODO
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
    /** Completed successfully */
    FetchDone,
    /** Interrupted during request */
    FetchAborted,
    /** Request failed */
    FetchFailed,
    /** Invalid model format or data */
    Invalid,
}
