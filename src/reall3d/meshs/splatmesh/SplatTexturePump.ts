// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================
/**
 * 纹理分层的受控上传。
 *
 * 纹理上传是异步的（每层都要等 GPU 回传 onUpdate），期间可能发生销毁。
 * 这里把“逐层上传”收口成单一实现，保证：
 * - 已销毁/已中止时不再触碰纹理（不写 layer、不设置 needsUpdate）；
 * - 中止后不再等待 pending 的 onUpdate；
 * - 返回已成功上传到的层，便于上层决定是否继续上报“就绪”状态。
 */
export interface PumpableTexture {
    addLayerUpdate(layer: number): void;
    needsUpdate: boolean;
    onUpdate?: (() => void) | null;
}

export interface PumpTextureLayersOptions {
    /** 目标纹理；为 null 时直接中止 */
    texture: PumpableTexture | null;
    /** 起始层（含） */
    fromLayer: number;
    /** 结束层（不含） */
    toLayer: number;
    /** 每层上传前的等待（毫秒），<= 0 不等待 */
    delayMs?: number;
    /** 是否已中止（通常是“已销毁”） */
    isAborted: () => boolean;
    /**
     * 订阅“中止”通知，返回取消订阅函数。
     * 提供后，若在等待 GPU 回传期间中止，挂起的 Promise 会被立即唤醒，避免悬挂。
     */
    onAbort?: (fn: () => void) => (() => void) | void;
    /** 睡眠实现，默认 setTimeout */
    sleep?: (ms: number) => Promise<void>;
}

export interface PumpTextureLayersResult {
    /** 已上传到的最靠后的层（未上传任何层时为 fromLayer - 1） */
    uploadedTo: number;
    /** 是否因中止而提前结束 */
    aborted: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => (ms > 0 ? setTimeout(resolve, ms) : resolve()));

export async function pumpTextureLayers(opts: PumpTextureLayersOptions): Promise<PumpTextureLayersResult> {
    const { texture, fromLayer, toLayer, delayMs = 0, isAborted, onAbort, sleep = defaultSleep } = opts;
    let uploadedTo = fromLayer - 1;

    if (!texture || isAborted()) return { uploadedTo, aborted: true };

    for (let layer = fromLayer; layer < toLayer; layer++) {
        if (delayMs > 0) {
            await sleep(delayMs);
            if (isAborted()) return { uploadedTo, aborted: true };
        }
        if (isAborted()) return { uploadedTo, aborted: true };

        // 等待 GPU 回传，同时订阅中止通知：销毁时不至于一直挂着等 onUpdate
        let abortedWhileWaiting = false;
        let unsubscribe: (() => void) | void;
        await new Promise<void>(resolve => {
            const done = (fromAbort: boolean) => {
                abortedWhileWaiting = fromAbort;
                typeof unsubscribe === 'function' && unsubscribe();
                texture.onUpdate = null;
                resolve();
            };
            texture.addLayerUpdate(layer);
            texture.onUpdate = () => done(false);
            texture.needsUpdate = true;
            unsubscribe = onAbort?.(() => done(true));
        });
        if (abortedWhileWaiting) return { uploadedTo, aborted: true };
        // 该层已成功上传；若此刻刚被销毁，仍记录已上传的层以便上层判断
        uploadedTo = layer;
        if (isAborted()) return { uploadedTo, aborted: true };
    }

    return { uploadedTo, aborted: isAborted() };
}
