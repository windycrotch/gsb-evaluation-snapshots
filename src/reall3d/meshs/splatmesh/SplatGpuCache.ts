// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================
import { DataArrayTexture } from 'three';
import { GetDataArrayTexture, OnSplatLodFullUploaded } from '../../events/EventConstants';
import { Events } from '../../events/Events';
import { SplatFile } from '../../modeldata/SplatTiles';
import { calcPartDepthRange, extractSplatXYZ, sleep } from '../../utils/CommonUtils';

export class SplatGpuCache {
    protected disposed = false;
    protected events: Events;
    private layerWidth: number;
    private layerHeight: number;
    private fullCache: boolean;
    private texture: DataArrayTexture;
    private offset: number = 0;
    private dataCount: number = 0;
    /** 销毁通知订阅者：挂起的上传等待据此立即退出，避免等待不会到来的 GPU 回传 */
    private abortListeners: Set<() => void> = new Set();

    constructor(events: Events, width: number, height: number, depth: number, dataCount: number, fullCache: boolean) {
        const that = this;
        that.events = events;
        that.layerWidth = width;
        that.layerHeight = height;
        that.dataCount = dataCount;
        that.fullCache = fullCache;
        that.texture = events.fire(GetDataArrayTexture);
        events.on(OnSplatLodFullUploaded, () => !that.disposed && that.texture && (that.texture.image.data = null));
    }

    /** 等待一次纹理层上传完成；销毁时立即解除等待 */
    private waitLayerUpload(dataArrayTexture: DataArrayTexture, applyLayers: () => void): Promise<void> {
        const that = this;
        return new Promise<void>(resolve => {
            if (that.disposed || !dataArrayTexture?.image?.data) return resolve();
            let settled = false;
            const done = () => {
                if (settled) return;
                settled = true;
                that.abortListeners.delete(done);
                dataArrayTexture.onUpdate = null;
                resolve();
            };
            applyLayers();
            dataArrayTexture.onUpdate = done;
            dataArrayTexture.needsUpdate = true;
            that.abortListeners.add(done);
        });
    }

    public async uploadSplatFile(file: SplatFile) {
        const that = this;
        that.fullCache ? await that.uploadSplatFileFull(file) : await that.uploadSplatFilePart(file);
    }

    protected async uploadSplatFileFull(file: SplatFile) {
        const that = this;
        if (that.disposed || file.textureReady) return; // 需要检查避免已就绪又重新上传

        file.textureReady = false;
        const { startDepth, endDepth } = calcPartDepthRange(that.layerWidth, that.layerHeight, that.offset, file.downloadCount);
        const dataArrayTexture = that.texture;
        if (!dataArrayTexture?.image?.data) return; // 纹理已释放
        const downloadData = file.downloadData.subarray(0, file.downloadCount * 32);
        const ui8sTex = new Uint8Array(dataArrayTexture.image.data.buffer);
        ui8sTex.set(downloadData, that.offset * 32);

        await that.waitLayerUpload(dataArrayTexture, () => {
            for (let i = startDepth; i <= endDepth; i++) dataArrayTexture.addLayerUpdate(i);
        });
        if (that.disposed) return; // 上传期间已销毁，不再推进
        // 纹理可能已在此刻被释放，不再访问 image.data
        if (!dataArrayTexture.image?.data) return;

        file.xyz = extractSplatXYZ(downloadData);
        file.downloadData = null;

        file.lastTime = Math.max(Date.now(), file.lastTime);
        file.offset = that.offset;
        file.textureReady = true;
        that.offset += file.downloadCount;
        that.offset >= that.dataCount && !that.disposed && that.events.tryFire(OnSplatLodFullUploaded);
    }

    protected async uploadSplatFilePart(file: SplatFile) {
        const that = this;
        if (that.disposed || file.textureReady) return; // 避免就绪重新上传

        file.textureReady = false;
        await that.updateLayer(file);
        if (that.disposed) return;
        file.lastTime = Math.max(Date.now(), file.lastTime);
        file.textureReady = true;
    }

    protected async updateLayer(file: SplatFile) {
        const that = this;
        file.offset = (that.layerWidth * that.layerHeight * file.targetLayer) / 2;

        const dataArrayTexture = that.texture;
        if (!dataArrayTexture?.image?.data) return; // 纹理已释放
        const downloadData = file.downloadData.subarray(0, file.downloadCount * 32);
        const ui8sTex = new Uint8Array(dataArrayTexture.image.data.buffer);
        ui8sTex.set(downloadData, file.offset * 32);

        await that.waitLayerUpload(dataArrayTexture, () => dataArrayTexture.addLayerUpdate(file.targetLayer));
        if (that.disposed) return; // 上传期间已销毁，不再推进

        file.downloadData = null;
    }

    public dispose() {
        const that = this;
        if (that.disposed) return;
        that.disposed = true;
        that.texture = null;
        const listeners = Array.from(that.abortListeners);
        that.abortListeners.clear();
        listeners.forEach(fn => fn());
    }
}
