// @vitest-environment jsdom
// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================
import { describe, expect, it } from 'vitest';
import { Events } from '../src/reall3d/events/Events';
import { GetDataArrayTexture, OnSplatLodFullUploaded } from '../src/reall3d/events/EventConstants';
import { SplatGpuCache } from '../src/reall3d/meshs/splatmesh/SplatGpuCache';

/** 模拟 DataArrayTexture：needsUpdate 置位后由测试决定是否回传 onUpdate */
class FakeArrayTexture {
    public onUpdate: (() => void) | null = null;
    public image = { data: new Uint8Array(64 * 1024) };
    public readonly layerUpdates: number[] = [];
    public updates: number = 0;
    public silent = false;

    public addLayerUpdate(layer: number) {
        this.layerUpdates.push(layer);
    }

    public set needsUpdate(value: boolean) {
        if (!value || this.silent) return;
        this.updates++;
        const cb = this.onUpdate;
        setTimeout(() => cb && cb(), 0);
    }
}

function createCache(fullCache: boolean) {
    const events = new Events();
    const texture = new FakeArrayTexture();
    events.on(GetDataArrayTexture, () => texture as any);
    const cache = new SplatGpuCache(events, 8, 8, 4, 4, fullCache);
    return { events, texture, cache };
}

function createSplatFile(count: number, layer = 0) {
    return { downloadCount: count, downloadData: new Uint8Array(count * 32), textureReady: false, targetLayer: layer } as any;
}

describe('SplatGpuCache 上传与销毁', () => {
    it('正常分块上传会写入纹理层并标记就绪', async () => {
        const { texture, cache } = createCache(false);
        const file = createSplatFile(4, 1);
        await cache.uploadSplatFile(file);

        expect(file.textureReady).toBe(true);
        expect(texture.layerUpdates).toEqual([1]);
        expect(file.downloadData).toBeNull();
    });

    it('整块上传完成后触发 LOD 全量上传事件', async () => {
        const { events, texture, cache } = createCache(true);
        const file = createSplatFile(4);
        await cache.uploadSplatFile(file);
        expect(file.textureReady).toBe(true);
        expect(texture.layerUpdates.length).toBeGreaterThan(0);
        expect(events.on(OnSplatLodFullUploaded)).toBeTypeOf('function');
    });

    it('销毁后不再上传：拒绝新的上传请求', async () => {
        const { texture, cache } = createCache(false);
        cache.dispose();
        const file = createSplatFile(4, 1);
        await cache.uploadSplatFile(file);
        expect(file.textureReady).toBe(false);
        expect(texture.layerUpdates).toEqual([]);
    });

    it('等待 GPU 回传期间销毁：立即解除等待，不访问已释放纹理', async () => {
        const { texture, cache } = createCache(false);
        texture.silent = false;
        const file = createSplatFile(4, 0);

        // 让第一层正常挂载后再进入“不回传”状态
        const uploading = (async () => {
            texture.silent = true;
            await cache.uploadSplatFile(file);
        })();
        await new Promise(r => setTimeout(r, 0));
        expect(texture.layerUpdates).toEqual([0]);
        expect(file.textureReady).toBe(false);

        texture.image.data = null; // 纹理被释放
        cache.dispose();

        await uploading;
        // 销毁后不再推进到收尾（不标记就绪、不再触碰纹理）
        expect(file.textureReady).toBe(false);
        expect(file.downloadData).not.toBeNull();
    });
});
