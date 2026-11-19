// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================
import { describe, expect, it } from 'vitest';
import { pumpTextureLayers, PumpableTexture } from '../src/reall3d/meshs/splatmesh/SplatTexturePump';

/** 模拟 DataArrayTexture：needsUpdate 置位后异步回传 onUpdate */
class FakeTexture implements PumpableTexture {
    public onUpdate: (() => void) | null = null;
    public readonly layerUpdates: number[] = [];
    public updateCount: number = 0;
    /** 是否模拟 GPU 永不回传（验证中止后不会卡住） */
    public silent: boolean = false;
    public released: boolean = false;
    /** 每次回传后调用，用于在特定层完成后诱发销毁 */
    public afterUpdate?: (count: number) => void;

    private _needsUpdate = false;
    public get needsUpdate() {
        return this._needsUpdate;
    }
    public set needsUpdate(value: boolean) {
        this._needsUpdate = value;
        if (!value || this.silent) return;
        this.updateCount++;
        const cb = this.onUpdate;
        setTimeout(() => {
            // 纹理已释放时，GPU 回传不得再被当作有效上传
            !this.released && cb && cb();
            this.afterUpdate?.(this.updateCount);
        }, 0);
    }

    public addLayerUpdate(layer: number) {
        if (this.released) throw new Error('texture already released');
        this.layerUpdates.push(layer);
    }
}

describe('纹理分层上传（pumpTextureLayers）', () => {
    it('正常上传逐层推进并返回最后一层（结束层为开区间）', async () => {
        const texture = new FakeTexture();
        const result = await pumpTextureLayers({
            texture,
            fromLayer: 0,
            toLayer: 3,
            delayMs: 0,
            isAborted: () => false,
        });
        expect(result.aborted).toBe(false);
        expect(result.uploadedTo).toBe(2);
        expect(texture.layerUpdates).toEqual([0, 1, 2]);
        expect(texture.updateCount).toBe(3);
    });

    it('从中间层续传：只上传剩余的层', async () => {
        const texture = new FakeTexture();
        const result = await pumpTextureLayers({
            texture,
            fromLayer: 2,
            toLayer: 5,
            delayMs: 0,
            isAborted: () => false,
        });
        expect(result.uploadedTo).toBe(4);
        expect(texture.layerUpdates).toEqual([2, 3, 4]);
    });

    it('已销毁时立即中止：不触碰纹理，也不写 needsUpdate', async () => {
        const texture = new FakeTexture();
        const result = await pumpTextureLayers({
            texture,
            fromLayer: 0,
            toLayer: 2,
            delayMs: 0,
            isAborted: () => true,
        });
        expect(result.aborted).toBe(true);
        expect(result.uploadedTo).toBe(-1);
        expect(texture.layerUpdates).toEqual([]);
        expect(texture.updateCount).toBe(0);
    });

    it('纹理已释放（null）时直接中止', async () => {
        const result = await pumpTextureLayers({
            texture: null,
            fromLayer: 0,
            toLayer: 5,
            isAborted: () => false,
        });
        expect(result.aborted).toBe(true);
        expect(result.uploadedTo).toBe(-1);
    });

    it('上传过程中被销毁：后续层不再写入纹理，且不等待无回传的 onUpdate', async () => {
        const texture = new FakeTexture();
        let disposed = false;
        let sleepCount = 0;
        const result = await pumpTextureLayers({
            texture,
            fromLayer: 0,
            toLayer: 6,
            delayMs: 1,
            isAborted: () => disposed,
            sleep: async () => {
                sleepCount++;
                if (sleepCount === 2) {
                    // 第 2 次等待期间销毁，纹理同时被释放，GPU 不再回传
                    disposed = true;
                    texture.released = true;
                    texture.silent = true;
                }
            },
        });
        expect(result.aborted).toBe(true);
        // 销毁前只上传了第一层，之后不再推进
        expect(result.uploadedTo).toBe(0);
        expect(texture.layerUpdates).toEqual([0]);
    });

    it('等待 GPU 回传期间销毁：通过 abort 通知立即唤醒，不会挂住', async () => {
        const texture = new FakeTexture();
        texture.silent = true; // GPU 永不回传
        let disposed = false;
        let abortFn: (() => void) | null = null;
        const abortable = (fn: () => void) => {
            abortFn = fn;
            return () => (abortFn = null);
        };

        const promise = pumpTextureLayers({
            texture,
            fromLayer: 0,
            toLayer: 3,
            delayMs: 0,
            isAborted: () => disposed,
            onAbort: abortable,
        });

        // 等待第一层进入挂起
        await new Promise(r => setTimeout(r, 0));
        expect(texture.layerUpdates).toEqual([0]);

        // 模拟销毁：设置中止标志并通知
        disposed = true;
        texture.released = true;
        abortFn?.();

        const result = await promise;
        expect(result.aborted).toBe(true);
        expect(result.uploadedTo).toBe(-1); // 第一层未回传，不算已上传
        expect(texture.layerUpdates).toEqual([0]); // 未继续写第二层
    });

    it('abort 通知在一次回传后解除订阅，不会重复 resolve', async () => {
        const texture = new FakeTexture();
        let subscriptions = 0;
        const result = await pumpTextureLayers({
            texture,
            fromLayer: 0,
            toLayer: 2,
            delayMs: 0,
            isAborted: () => false,
            onAbort: () => {
                subscriptions++;
            },
        });
        expect(result.aborted).toBe(false);
        expect(result.uploadedTo).toBe(1);
        expect(subscriptions).toBe(2);
    });

    it('第一层上传期间被销毁：不会写第二层', async () => {
        const texture = new FakeTexture();
        let disposed = false;
        // 第 1 层回传后立即销毁（后续层的顶层检查会中止）
        texture.afterUpdate = count => {
            if (count === 1) disposed = true;
        };
        const result = await pumpTextureLayers({
            texture,
            fromLayer: 0,
            toLayer: 4,
            delayMs: 0,
            isAborted: () => disposed,
        });
        expect(result.aborted).toBe(true);
        expect(result.uploadedTo).toBe(0);
        expect(texture.layerUpdates).toEqual([0]);
    });
});
