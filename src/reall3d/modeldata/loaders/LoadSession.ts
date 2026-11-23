// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================
import { Vector3 } from 'three';
import { FetchAbortReason, ModelStatus, SplatModel } from '../ModelData';

/**
 * A single load session of a SplatModel.
 *
 * Every loader invocation (`loadPly` / `loadSplat`) creates one session, which:
 *  - resets all mutable load state so retries never inherit counts, SH data or
 *    bounding boxes of a previous attempt;
 *  - owns a monotonic session id so late chunks of an aborted previous session
 *    can never be written into the new session's splatData / bounding box;
 *  - distinguishes an active stop at fetchLimit (keep parsed data, finish as
 *    FetchDone) from a user cancellation (discard data, finish as FetchAborted).
 */
export class LoadSession {
    /** Monotonic id of this session inside the model */
    public readonly id: number;
    /** The model this session belongs to */
    public readonly model: SplatModel;
    /** Set when the session has ended (any terminal status) */
    private ended: boolean = false;

    private constructor(model: SplatModel) {
        this.model = model;
        this.id = ++model.loadSessionId;
    }

    /**
     * Open a new session for the model and reset every piece of mutable load
     * state, guaranteeing a clean start for both first loads and retries.
     */
    static start(model: SplatModel): LoadSession {
        // A previous session (cancelled / failed / limit-stopped) must never
        // keep affecting this new one.
        model.abortController?.abort();
        model.abortController = new AbortController();
        model.abortReason = FetchAbortReason.None;
        model.fetchLimitReached = false;

        model.status = ModelStatus.Fetching;
        model.fileSize = 0;
        model.downloadSize = 0;
        model.modelSplatCount = -1;
        model.rowLength = 0;
        model.dataShDegree = 0;
        model.downloadSplatCount = 0;
        model.dataSplatCount = 0;
        model.watermarkCount = 0;
        model.renderSplatCount = 0;
        model.splatData = null;
        model.xyz = null;
        model.watermarkData = new Uint8Array(0);
        model.sh12Data = [];
        model.sh3Data = [];
        model.sh12Count = 0;
        model.sh3Count = 0;
        model.palettes = undefined;
        model.isPointCloudPly = false;
        model.notifyFetchStopDone = false;
        model.smallSceneUploadDone = false;
        model.textWatermarkVersion = 0;
        model.lastTextWatermarkVersion = 0;

        // Bounding box: no point has been written yet.
        // Infinity/-Infinity guarantee the first written point seeds min/max.
        model.minX = Infinity;
        model.maxX = -Infinity;
        model.minY = Infinity;
        model.maxY = -Infinity;
        model.minZ = Infinity;
        model.maxZ = -Infinity;
        model.topY = 0;
        model.currentRadius = 0;
        model.maxRadius = 0;
        model.aabbCenter = null;

        return new LoadSession(model);
    }

    /** True when this session is still the active one of the model */
    public isCurrent(): boolean {
        return this.model.loadSessionId === this.id && !this.ended;
    }

    /**
     * Request the active stop because fetchLimit points have been parsed.
     * The fetch is aborted but the parsed subset is retained and the load
     * completes successfully.
     */
    public stopAtFetchLimit(): void {
        if (!this.isCurrent()) return;
        this.model.abortReason = FetchAbortReason.FetchLimit;
        this.model.fetchLimitReached = true;
        this.model.abortController.abort();
    }

    /**
     * Resolve the terminal status for an abort/error thrown by the fetch loop.
     *
     * - fetchLimit reached -> FetchDone (partial data already parsed is kept)
     * - user cancel        -> FetchAborted (partial data discarded)
     * - any other error    -> FetchFailed
     *
     * Stale sessions (already superseded by a newer load) never overwrite the
     * model status.
     */
    public resolveTerminalStatus(e?: any): ModelStatus {
        if (!this.isCurrent()) return this.model.status;

        let status: ModelStatus;
        const aborted = e?.name === 'AbortError';
        if (aborted && this.model.abortReason === FetchAbortReason.FetchLimit) {
            status = ModelStatus.FetchDone;
        } else if (aborted) {
            status = ModelStatus.FetchAborted;
        } else {
            status = ModelStatus.FetchFailed;
        }
        return this.finish(status);
    }

    /**
     * Move to a terminal status. A user cancellation clears all partial data;
     * a limit stop keeps the parsed subset.
     */
    public finish(status: ModelStatus): ModelStatus {
        if (!this.isCurrent()) return this.model.status;
        this.ended = true;

        if (status === ModelStatus.FetchAborted) {
            // Explicit cancellation: nothing parsed may survive into a later load.
            discardPartialData(this.model);
        }
        this.model.status = status;
        return status;
    }
}

/**
 * Discard every partial artifact of an aborted session.
 * Counts, SH data, bounding box and parsed splat bytes are all cleared.
 */
export function discardPartialData(model: SplatModel): void {
    model.splatData = null;
    model.xyz = null;
    model.watermarkData = new Uint8Array(0);
    model.sh12Data = [];
    model.sh3Data = [];
    model.sh12Count = 0;
    model.sh3Count = 0;
    model.dataSplatCount = 0;
    model.downloadSplatCount = 0;
    model.watermarkCount = 0;
    model.palettes = undefined;

    model.minX = Infinity;
    model.maxX = -Infinity;
    model.minY = Infinity;
    model.maxY = -Infinity;
    model.minZ = Infinity;
    model.maxZ = -Infinity;
    model.currentRadius = 0;
    model.maxRadius = 0;
    model.aabbCenter = null;
}

/**
 * Write parsed splat rows into the model and update the bounding box.
 *
 * Shared by the PLY and SPLAT loaders. Only the rows that are actually copied
 * into model.splatData participate in min/max; rows dropped because fetchLimit
 * is reached never influence the bounding box.
 *
 * @returns the number of splats actually written
 */
export function writeSplatData(model: SplatModel, data: Uint8Array): number {
    let dataCnt = data.byteLength / 32;
    const maxSplatDataCnt = Math.min(model.fetchLimit, model.modelSplatCount);

    // Drop everything that does not fit within the limit.
    if (model.dataSplatCount + dataCnt > maxSplatDataCnt) {
        dataCnt = maxSplatDataCnt - model.dataSplatCount;
        if (dataCnt <= 0) return 0;
        data = data.subarray(0, dataCnt * 32);
    }

    if (!model.splatData) {
        // Invariant: both loaders pre-allocate splatData as soon as the point
        // count is known, before any chunk is parsed.
        throw new Error('splatData is not allocated before writeSplatData');
    }
    model.splatData.set(data, model.dataSplatCount * 32);

    // Bounding box is computed only from the rows written above.
    const f32s: Float32Array = new Float32Array(data.buffer, data.byteOffset, dataCnt * 8);
    for (let i = 0; i < dataCnt; i++) {
        const x = f32s[i * 8];
        const y = f32s[i * 8 + 1];
        const z = f32s[i * 8 + 2];
        if (x < model.minX) model.minX = x;
        if (x > model.maxX) model.maxX = x;
        if (y < model.minY) model.minY = y;
        if (y > model.maxY) model.maxY = y;
        if (z < model.minZ) model.minZ = z;
        if (z > model.maxZ) model.maxZ = z;
    }

    model.dataSplatCount += dataCnt;

    const topY = model.header?.MinTopY || 0;
    model.currentRadius = Math.sqrt(model.maxX * model.maxX + topY * topY + model.maxZ * model.maxZ);
    model.aabbCenter = new Vector3((model.minX + model.maxX) / 2, (model.minY + model.maxY) / 2, (model.minZ + model.maxZ) / 2);
    model.maxRadius = 0.5 * Math.sqrt((model.maxX - model.minX) ** 2 + (model.maxY - model.minY) ** 2 + (model.maxZ - model.minZ) ** 2);
    model.metaMatrix && model.aabbCenter.applyMatrix4(model.metaMatrix);

    return dataCnt;
}
