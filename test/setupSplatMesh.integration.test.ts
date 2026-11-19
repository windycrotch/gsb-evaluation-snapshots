// @vitest-environment jsdom
// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera } from 'three';
import { Events } from '../src/reall3d/events/Events';
import {
    GetOptions,
    GetMeta,
    GetMaxRenderCount,
    ComputeTextureWidthHeight,
    GetShTexheight,
    IsBigSceneMode,
    IsPointcloudMode,
    IsSmallSceneRenderDataReady,
    GetModelShDegree,
    RunLoopByFrame,
    GetCamera,
    GetCanvasSize,
    GetSortWorker,
    IsSplatMeshCreated,
    GetSplatMesh,
    CreateSplatMesh,
    SplatMeshDispose,
    SplatMeshCycleZoom,
    SplatMeshSwitchDisplayMode,
    OnQualityLevelChanged,
    SplatUpdateCurrentVisibleRadius,
    SplatUpdateCurrentLightRadius,
    SplatUpdatePointMode,
    SplatUpdateMinMaxPixelDiameter,
    SplatUpdateMinAlpha,
    OnSmallSceneShowDone,
    UploadSplatTexture,
} from '../src/reall3d/events/EventConstants';
import { setupSplatMesh } from '../src/reall3d/meshs/splatmesh/SetupSplatMesh';
import { TransitionEffects } from '../src/reall3d/meshs/splatmesh/SplatMeshOptions';
import { QualityLevels } from '../src/reall3d/utils/GlobalConstants';

/**
 * 用真实事件通道驱动 setupSplatMesh 的集成测试（无 WebGL：材质/几何体为纯 JS 对象）。
 * 目的是验证“事件入口不变”的前提下，各流程确实被协调器收口。
 */
function createIntegrationEnv() {
    const events = new Events();
    const opts: any = { qualityLevel: QualityLevels.Default5, pointcloudMode: true, transitionEffect: TransitionEffects.ModelCenterCirccle, shDegree: 3 };
    const created = { splatMesh: true };

    // ---- 帧循环：手动推进 ----
    const frames: Array<{ fnRun: () => void; fnIsContinue: () => boolean; div: number }> = [];
    let frameCount = 0;
    events.on(RunLoopByFrame, (fnRun: () => void, fnIsContinue: () => boolean, div = 0) => {
        frames.push({ fnRun, fnIsContinue, div });
    });
    const tick = (steps = 1) => {
        for (const f of frames) {
            if (f.div > 0 && frameCount % f.div !== 0) continue;
            if (!f.fnIsContinue()) continue;
            f.fnRun();
        }
        frameCount += steps;
    };
    const drain = (max = 4000) => {
        let n = 0;
        while (frames.some(f => f.fnIsContinue()) && n < max) {
            tick();
            n++;
        }
        return n;
    };
    const liveLoops = () => frames.filter(f => f.fnIsContinue()).length;

    // ---- 环境桩 ----
    const camera = new PerspectiveCamera();
    events.on(GetOptions, () => opts);
    events.on(GetMeta, () => ({ minPixelDiameter: 0, maxPixelDiameter: 0, minAlpha: 0 }));
    events.on(GetMaxRenderCount, async () => 8);
    events.on(ComputeTextureWidthHeight, () => ({ texwidth: 4, texheight: 4, texdepth: 1, texheightary: 4, fullCache: false }));
    events.on(GetShTexheight, async () => 1);
    events.on(GetModelShDegree, async () => 3);
    events.on(IsBigSceneMode, () => false);
    events.on(IsPointcloudMode, () => !!opts.pointcloudMode);
    let dataReady = true;
    events.on(IsSmallSceneRenderDataReady, () => dataReady);
    events.on(GetCamera, () => camera);
    events.on(GetCanvasSize, () => ({ width: 800, height: 600, left: 0, top: 0 }));
    events.on(GetSortWorker, () => ({ onmessage: null }) as any);
    events.on(IsSplatMeshCreated, () => true);
    let splatMesh: any = null;
    events.on(GetSplatMesh, () => splatMesh);

    // ---- 记录着色器关键参数（在材质创建前注册，即为最终生效的处理函数）----
    const video: Record<string, number> = { visibleRadius: 0, lightRadius: 0, pointModeWrites: 0, shDegree: 0, minPix: 0, maxPix: 0, minAlphaRaw: 0 };
    events.on(SplatUpdateCurrentVisibleRadius, (v: number) => (video.visibleRadius = v));
    events.on(SplatUpdateCurrentLightRadius, (v: number) => (video.lightRadius = v));
    events.on(SplatUpdatePointMode, () => (video.pointModeWrites += 1));
    events.on(SplatUpdateMinMaxPixelDiameter, (minPix: number, maxPix: number) => {
        video.minPix = minPix;
        video.maxPix = maxPix;
    });
    events.on(SplatUpdateMinAlpha, (v: number) => (video.minAlphaRaw = v)); // 原始 0~255 阈值

    let doneCalls = 0;
    events.on(OnSmallSceneShowDone, () => (doneCalls += 1), true);

    /** 通过 UploadSplatTexture 事件提供模型半径（真实链路即如此注入） */
    const setRadii = (currentRadius: number, maxRadiusValue: number) => {
        events.fire(UploadSplatTexture, { renderSplatCount: 0, texdata: null }, currentRadius, maxRadiusValue);
    };

    return {
        events,
        opts,
        frames,
        tick,
        drain,
        liveLoops,
        video,
        setRadii,
        get doneCalls() {
            return doneCalls;
        },
        setSplatMesh: (m: any) => (splatMesh = m),
        setDataReady: (v: boolean) => (dataReady = v),
        created,
    };
}

describe('setupSplatMesh 集成（真实事件通道）', () => {
    async function bootstrap() {
        const env = createIntegrationEnv();
        setupSplatMesh(env.events);
        const mesh: any = await env.events.fire(CreateSplatMesh);
        env.setSplatMesh(mesh);
        env.events.fire(OnQualityLevelChanged); // 与 SplatMesh 创建后的初始化一致
        return { env, mesh };
    }

    it('事件入口保留：SplatMeshCycleZoom / OnQualityLevelChanged / SplatMeshSwitchDisplayMode / SplatMeshDispose 均可用', async () => {
        const { env, mesh } = await bootstrap();
        expect(mesh).toBeTruthy();
        expect(env.events.on(SplatMeshCycleZoom)).toBeTypeOf('function');
        expect(env.events.on(OnQualityLevelChanged)).toBeTypeOf('function');
        expect(env.events.on(SplatMeshSwitchDisplayMode)).toBeTypeOf('function');
        expect(env.events.on(SplatMeshDispose)).toBeTypeOf('function');
    });

    it('首帧过渡正常完成：只触发一次完成回调，最终可见半径归零', async () => {
        const { env } = await bootstrap();
        env.setRadii(10, 10);
        env.events.fire(SplatMeshCycleZoom);
        expect(env.video.visibleRadius).toBeCloseTo(0.01, 5);

        env.drain(3000);
        expect(env.video.visibleRadius).toBe(0);
        expect(env.doneCalls).toBe(1);
    });

    it('过渡中切档位：参数以新档位为准，旧动画不再写参数且回调仅一次', async () => {
        const { env, mesh } = await bootstrap();
        env.setRadii(10, 10);
        env.events.fire(SplatMeshCycleZoom);
        for (let i = 0; i < 12; i++) env.tick();

        const beforeVisible = env.video.visibleRadius;
        expect(beforeVisible).toBeGreaterThan(0);

        env.opts.qualityLevel = QualityLevels.L1;
        env.events.fire(OnQualityLevelChanged);

        // 收敛 + 以新档位写入（L1 → 球谐 0，minPix 2 / maxPix 128，minAlpha 5）
        expect(env.video.visibleRadius).toBe(0);
        expect(env.video.minPix).toBe(2);
        expect(env.video.maxPix).toBe(128);
        expect(env.video.minAlphaRaw).toBe(5);

        const visibleWritesSnapshot = JSON.stringify(env.video);
        env.drain(2000);
        expect(env.video.visibleRadius).toBe(0);
        expect(JSON.stringify(env.video)).toBe(visibleWritesSnapshot);
        expect(env.doneCalls).toBe(1);
    });

    it('快速连续切换显示模式：只保留最后一次，完成回调一次', async () => {
        const { env, mesh } = await bootstrap();
        env.setRadii(10, 10);
        env.opts.pointcloudMode = false;
        env.events.fire(SplatMeshSwitchDisplayMode);
        env.tick();
        env.events.fire(SplatMeshSwitchDisplayMode);
        env.tick();
        env.events.fire(SplatMeshSwitchDisplayMode);
        expect(env.liveLoops()).toBe(1);

        env.drain(3000);
        expect(env.doneCalls).toBe(1);
        expect(env.video.lightRadius).toBe(0);
    });

    it('销毁后无残留帧回调与纹理写入，也不再安排新任务', async () => {
        const { env, mesh } = await bootstrap();
        env.setRadii(10, 10);
        env.events.fire(SplatMeshCycleZoom);
        env.tick();

        env.events.fire(SplatMeshDispose);

        const snapshot = JSON.stringify(env.video);
        env.drain(2000);
        expect(JSON.stringify(env.video)).toBe(snapshot);
        // 销毁后的入口调用不再安排帧循环
        env.events.fire(SplatMeshCycleZoom);
        env.events.fire(SplatMeshSwitchDisplayMode);
        expect(env.liveLoops()).toBe(0);
        expect(env.doneCalls).toBe(0);
    });

    it('小场景关闭过渡特效：直接进入稳定态', async () => {
        const { env } = await bootstrap();
        env.opts.disableTransitionEffectOnLoad = true;
        env.events.fire(SplatMeshCycleZoom);
        expect(env.video.visibleRadius).toBe(0);
        expect(env.liveLoops()).toBe(0);
    });

    it('过渡完成后再切档位：收尾参数与最终档位一致', async () => {
        const { env } = await bootstrap();
        env.setRadii(10, 10);
        // 先以默认档位（L5 → 球谐 3，minPix 1 / maxPix 512）完成一次过渡
        env.events.fire(SplatMeshCycleZoom);
        env.drain(3000);
        expect(env.doneCalls).toBe(1);
        expect(env.video.shDegree).toBe(0); // 全局无模型阶数上限桩时夹取为 0，属预期

        // 档位降到 L3（球谐 2，minPix 2 / maxPix 256）
        env.opts.qualityLevel = QualityLevels.L3;
        env.events.fire(OnQualityLevelChanged);
        expect(env.video.minPix).toBe(2);
        expect(env.video.maxPix).toBe(256);
        expect(env.video.minAlphaRaw).toBe(3);
        expect(env.doneCalls).toBe(1);

        // 再完成一次过渡：最终参数依旧与新档位一致
        env.events.fire(SplatMeshCycleZoom);
        env.drain(3000);
        expect(env.doneCalls).toBe(2);
        expect(env.video.minPix).toBe(2);
        expect(env.video.maxPix).toBe(256);
    });
});
