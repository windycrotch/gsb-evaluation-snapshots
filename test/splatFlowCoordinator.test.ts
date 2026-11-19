// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================
import { describe, expect, it } from 'vitest';
import {
    DisplayModeSwitchParams,
    FirstFrameTransitionParams,
    ShDegreeArbiter,
    SplatFlowCoordinator,
    SplatFlowHost,
} from '../src/reall3d/meshs/splatmesh/SplatFlowCoordinator';
import { TransitionEffects } from '../src/reall3d/meshs/splatmesh/SplatMeshOptions';

/** 模拟帧循环：手动推进，不依赖 requestAnimationFrame */
class FakeFrameLoop {
    public frames: number = 0;
    public readonly queues: Array<{ fnRun: () => void; fnIsContinue: () => boolean; div: number }> = [];

    public runFrame(fnRun: () => void, fnIsContinue: () => boolean, div = 0) {
        this.queues.push({ fnRun, fnIsContinue, div });
    }

    /** 推进一步（div 帧）；返回是否仍有存活的循环 */
    public tick(steps: number = 1): boolean {
        for (const q of this.queues) {
            if (q.div > 0 && this.frames % q.div !== 0) continue;
            if (!q.fnIsContinue()) continue;
            q.fnRun();
        }
        this.frames += steps;
        return this.queues.some(q => q.fnIsContinue());
    }

    /** 连续推进直到没有存活循环，或达到上限 */
    public drain(maxSteps = 5000): number {
        let steps = 0;
        while (this.queues.some(q => q.fnIsContinue()) && steps < maxSteps) {
            this.tick();
            steps++;
        }
        return steps;
    }
}

/** 可手动触发的定时器 */
class FakeTimers {
    public pending: Array<{ fn: () => void; ms: number; timer: { cancelled: boolean } }> = [];

    public schedule(fn: () => void, ms: number): () => void {
        const timer = { cancelled: false };
        this.pending.push({ fn, ms, timer });
        return () => {
            timer.cancelled = true;
        };
    }

    public fireAll(): void {
        const list = this.pending.slice();
        this.pending = [];
        list.filter(t => !t.timer.cancelled).forEach(t => t.fn());
    }

    public countLive(): number {
        return this.pending.filter(t => !t.timer.cancelled).length;
    }
}

interface Harness {
    host: SplatFlowHost;
    flow: SplatFlowCoordinator;
    frames: FakeFrameLoop;
    timers: FakeTimers;
    state: Record<string, any>;
    log: Record<string, number>;
}

function createHarness(overrides: Partial<SplatFlowHost> = {}, initial: Record<string, any> = {}): Harness {
    const frames = new FakeFrameLoop();
    const timers = new FakeTimers();
    const log = { onTransitionDone: 0, applyQuality: 0, visibleWrites: 0, lightWrites: 0, pointModeWrites: 0, transitionDoneWithData: 0 };
    const state: Record<string, any> = { visibleRadius: 0, lightRadius: 0, pointMode: false, dataReady: true, ...initial };

    const host: SplatFlowHost = {
        isDisposed: () => !!state.disposed,
        setVisibleRadius: (value: number) => {
            log.visibleWrites++;
            state.visibleRadius = value;
        },
        setLightRadius: (value: number) => {
            log.lightWrites++;
            state.lightRadius = value;
        },
        setPointMode: (value?: boolean) => {
            log.pointModeWrites++;
            state.pointMode = value === undefined ? !state.pointMode : value;
        },
        setTransitionEffect: (value: number) => (state.transitionEffect = value),
        setPerformanceAct: (value: number) => (state.performanceAct = value),
        applyQuality: () => {
            log.applyQuality++;
            state.appliedQuality = (state.appliedQuality || 0) + 1;
        },
        onTransitionDone: (showMark: boolean) => {
            log.onTransitionDone++;
            state.lastShowMark = showMark;
        },
        triggerSwitchDisplayMode: (showMark: boolean) => {
            state.switched = true;
            flow!.switchDisplayMode({ transitionEffect: TransitionEffects.ModelCenterCirccle, showMark, maxRadius: state.maxRadius ?? 10 });
        },
        isPointcloudMode: () => !!state.pointMode,
        isSmallSceneDataReady: () => !!state.dataReady,
        runFrame: (fnRun, fnIsContinue, div = 0) => frames.runFrame(fnRun, fnIsContinue, div),
        scheduleTimeout: (fn, ms) => timers.schedule(fn, ms),
        now: () => (state.now = (state.now || 0) + 16),
        ...overrides,
    };

    const flow = new SplatFlowCoordinator(host);
    return { host, flow, frames, timers, state, log };
}

describe('首帧过渡（SplatMeshCycleZoom）', () => {
    it('正常过渡能推进并只触发一次完成回调，收尾参数与当前档位一致', () => {
        const h = createHarness();
        const params: FirstFrameTransitionParams = { isBigSceneMode: false, disableTransitionEffectOnLoad: false, maxRadius: 10, currentMaxRadius: 10 };
        h.flow.runFirstFrameTransition(params);

        // 初始写入小半径（内圈开始）
        expect(h.state.visibleRadius).toBeCloseTo(0.01, 5);
        expect(h.flow.isTransitionRunning).toBe(true);

        const steps = h.frames.drain(700);
        expect(steps).toBeGreaterThan(0);

        // 收敛到稳定态
        expect(h.state.visibleRadius).toBe(0);
        // 完成回调恰好一次
        expect(h.log.onTransitionDone).toBe(1);
        // 过渡自然完成后再次应用当前档位
        expect(h.log.applyQuality).toBe(1);
        // 帧循环全部结束，不再续帧
        expect(h.frames.queues.every(q => !q.fnIsContinue())).toBe(true);
    });

    it('大场景模式不启动过渡，也不安排帧循环', () => {
        const h = createHarness();
        h.flow.runFirstFrameTransition({ isBigSceneMode: true, disableTransitionEffectOnLoad: false, maxRadius: 10, currentMaxRadius: 10 });
        expect(h.flow.isTransitionRunning).toBe(false);
        expect(h.frames.queues.length).toBe(0);
        expect(h.log.onTransitionDone).toBe(0);
    });

    it('小场景关闭过渡特效时直接进入稳定态，不安排任何帧循环', () => {
        const h = createHarness();
        h.flow.runFirstFrameTransition({ isBigSceneMode: false, disableTransitionEffectOnLoad: true, maxRadius: 10, currentMaxRadius: 10 });
        expect(h.state.visibleRadius).toBe(0);
        expect(h.flow.isTransitionRunning).toBe(false);
        expect(h.frames.queues.length).toBe(0);
        expect(h.log.onTransitionDone).toBe(0);
    });
});

describe('过渡中切换画质档位', () => {
    it('正在进行的过渡被安全终止并收敛，随后以新档位为准且不再被旧动画改写', () => {
        const h = createHarness();
        h.flow.runFirstFrameTransition({ isBigSceneMode: false, disableTransitionEffectOnLoad: false, maxRadius: 10, currentMaxRadius: 10 });

        // 推进几步，让过渡处于进行中
        for (let i = 0; i < 20; i++) h.frames.tick();
        const midRadius = h.state.visibleRadius;
        expect(midRadius).toBeGreaterThan(0);
        expect(h.flow.isTransitionRunning).toBe(true);

        // 切档位：旧过渡必须停止推进
        h.flow.onQualityChanged();
        expect(h.state.visibleRadius).toBe(0);
        // 档位一变，过渡链路就应结束推进（不再由旧动画写参数）
        const qualityAppliedAt = h.state.appliedQuality;
        expect(qualityAppliedAt).toBe(1);

        const writesAfterQuality = h.log.visibleWrites;

        // 继续推进帧循环：没有任何存活循环会再写参数
        const steps = h.frames.drain(1000);
        expect(steps).toBe(0);
        expect(h.log.visibleWrites).toBe(writesAfterQuality);
        expect(h.state.visibleRadius).toBe(0);
        expect(h.state.appliedQuality).toBe(qualityAppliedAt);
        // 被中途终止的过渡链路完成回调仍只触发一次（资源收尾）
        expect(h.log.onTransitionDone).toBe(1);
    });

    it('过渡完成后再切档位，不再补偿回调', () => {
        const h = createHarness();
        h.flow.runFirstFrameTransition({ isBigSceneMode: false, disableTransitionEffectOnLoad: false, maxRadius: 10, currentMaxRadius: 10 });
        h.frames.drain(700);
        expect(h.log.onTransitionDone).toBe(1);

        h.flow.onQualityChanged();
        expect(h.log.onTransitionDone).toBe(1);
        expect(h.log.applyQuality).toBe(2);
        expect(h.state.visibleRadius).toBe(0);
    });

    it('数据尚未就绪时切档位：立即收敛但不提前收尾，数据就绪后只收尾一次', () => {
        const h = createHarness({}, { dataReady: false });
        h.flow.runFirstFrameTransition({ isBigSceneMode: false, disableTransitionEffectOnLoad: false, maxRadius: 10, currentMaxRadius: 10 });
        h.frames.tick();
        expect(h.flow.isTransitionRunning).toBe(true);

        h.flow.onQualityChanged();
        // 立即收敛到稳定态，动画不再推进
        expect(h.state.visibleRadius).toBe(0);
        // 数据未就绪：不得触发完成回调，避免过早清空纹理数据
        expect(h.log.onTransitionDone).toBe(0);

        // 数据就绪后收敛中的链路只收尾一次
        h.state.dataReady = true;
        h.frames.drain(700);
        expect(h.log.onTransitionDone).toBe(1);
        expect(h.state.visibleRadius).toBe(0);
    });
});

describe('显示模式快速连续切换', () => {
    function switchParams(): DisplayModeSwitchParams {
        return { transitionEffect: TransitionEffects.ModelCenterCirccle, showMark: false, maxRadius: 10 };
    }

    it('多次快速触发只保留最后一次，被取代的流程停止推进且不触发完成回调', () => {
        const h = createHarness();
        h.flow.switchDisplayMode(switchParams());
        h.frames.tick();
        h.frames.tick();
        expect(h.flow.isDisplayModeSwitching).toBe(true);
        expect(h.log.onTransitionDone).toBe(0);

        // 快速再触发两次
        h.flow.switchDisplayMode(switchParams());
        h.frames.tick();
        h.flow.switchDisplayMode(switchParams());

        // 只保留最后一次（相干队列里只有一个存活）
        const liveLoops = h.frames.queues.filter(q => q.fnIsContinue());
        expect(liveLoops.length).toBe(1);

        // 推进到完成：只切换一次显示模式、只触发一次完成回调
        const steps = h.frames.drain(3000);
        expect(steps).toBeGreaterThan(0);
        expect(h.log.onTransitionDone).toBe(1);
        expect(h.log.pointModeWrites).toBe(1);
        expect(h.state.pointMode).toBe(true);
        expect(h.state.lightRadius).toBe(0);
        expect(h.flow.isDisplayModeSwitching).toBe(false);
    });

    it('屏幕中心过渡的延时任务在销毁时被清除，不再触发回调', () => {
        const h = createHarness();
        h.flow.switchDisplayMode({ transitionEffect: TransitionEffects.ScreenCenterCircle, showMark: true, maxRadius: 10 });
        expect(h.timers.countLive()).toBe(1);

        h.state.disposed = true;
        h.flow.dispose();
        h.timers.fireAll();
        expect(h.log.onTransitionDone).toBe(0);
        expect(h.log.pointModeWrites).toBe(0);
    });
});

describe('首帧过渡与显示模式切换互相协调', () => {
    it('过渡进行中触发显示模式切换：渐显先收敛，随后只由切换链路收尾一次', () => {
        const h = createHarness();
        h.flow.runFirstFrameTransition({ isBigSceneMode: false, disableTransitionEffectOnLoad: false, maxRadius: 10, currentMaxRadius: 10 });
        for (let i = 0; i < 10; i++) h.frames.tick();
        expect(h.state.visibleRadius).toBeGreaterThan(0);

        h.flow.switchDisplayMode({ transitionEffect: TransitionEffects.ModelCenterCirccle, showMark: true, maxRadius: 10 });
        expect(h.state.visibleRadius).toBe(0);
        expect(h.flow.isTransitionRunning).toBe(false);

        h.frames.drain(3000);
        // 完成回调恰好一次（由显示模式切换触发）
        expect(h.log.onTransitionDone).toBe(1);
        expect(h.log.pointModeWrites).toBe(1);
    });

    it('首帧过渡收尾时若处于点云模式，会经统一入口触发显示模式切换', () => {
        const h = createHarness({}, { pointMode: true, maxRadius: 10 });
        h.flow.runFirstFrameTransition({ isBigSceneMode: false, disableTransitionEffectOnLoad: false, maxRadius: 10, currentMaxRadius: 10 });
        h.frames.drain(3000);
        expect(h.state.switched).toBe(true);
        expect(h.log.applyQuality).toBeGreaterThanOrEqual(1);
    });
});

describe('销毁', () => {
    it('销毁后不再安排新的帧循环或延时任务，也无残留帧回调', () => {
        const h = createHarness();
        h.flow.runFirstFrameTransition({ isBigSceneMode: false, disableTransitionEffectOnLoad: false, maxRadius: 10, currentMaxRadius: 10 });
        h.frames.tick();

        h.state.disposed = true;
        h.flow.dispose();

        const writesAtDispose = h.log.visibleWrites + h.log.lightWrites + h.log.pointModeWrites;
        h.frames.drain(1000);
        h.timers.fireAll();

        expect(h.log.visibleWrites + h.log.lightWrites + h.log.pointModeWrites).toBe(writesAtDispose);
        expect(h.log.onTransitionDone).toBe(0);

        // 销毁后的任何入口都不再安排工作
        h.flow.onQualityChanged();
        h.flow.runFirstFrameTransition({ isBigSceneMode: false, disableTransitionEffectOnLoad: false, maxRadius: 10, currentMaxRadius: 10 });
        h.flow.switchDisplayMode({ transitionEffect: TransitionEffects.ModelCenterCirccle, showMark: true, maxRadius: 10 });
        expect(h.frames.queues.filter(q => q.fnIsContinue()).length).toBe(0);
        expect(h.timers.countLive()).toBe(0);
    });
});

describe('球谐阶数仲裁（ShDegreeArbiter）', () => {
    it('加载期写入不会覆盖已生效的画质档位', async () => {
        const arbiter = new ShDegreeArbiter();
        const writes: number[] = [];

        // 档位先写入（模型数据尚未就绪，上限为 0）
        await arbiter.apply(3, 1, Promise.resolve(0), degree => writes.push(degree));
        expect(writes).toEqual([0]);

        // 加载收尾的推断写入（0 优先级）不得改写阶数，但会按最新上限重放档位值
        await arbiter.apply(3, 0, Promise.resolve(3), degree => writes.push(degree));
        expect(writes).toEqual([0, 3]);
    });

    it('多次显式写入以最后一次为准，乱序的旧写入被丢弃', async () => {
        const arbiter = new ShDegreeArbiter();
        const writes: string[] = [];

        let resolveOld: (v: number) => void;
        let resolveNew: (v: number) => void;
        const oldMax = new Promise<number>(r => (resolveOld = r));
        const newMax = new Promise<number>(r => (resolveNew = r));

        const pOld = arbiter.apply(1, 1, oldMax, degree => writes.push(`old:${degree}`));
        const pNew = arbiter.apply(3, 1, newMax, degree => writes.push(`new:${degree}`));

        // 后发的先完成
        resolveNew!(3);
        await pNew;
        // 先发的后完成，应被丢弃
        resolveOld!(3);
        await pOld;

        expect(writes).toEqual(['new:3']);
    });

    it('用户显式阶数（优先级 2）会覆盖档位（优先级 1），反之亦然', async () => {
        const arbiter = new ShDegreeArbiter();
        const writes: number[] = [];

        await arbiter.apply(3, 1, 3, d => writes.push(d));
        await arbiter.apply(1, 2, 3, d => writes.push(d));
        expect(writes).toEqual([3, 1]);

        // 档位再次变化（优先级 1 也是显式写入，后写覆盖先写）
        await arbiter.apply(2, 1, 3, d => writes.push(d));
        expect(writes).toEqual([3, 1, 2]);
    });

    it('invalidate 之后所有在途写入都作废', async () => {
        const arbiter = new ShDegreeArbiter();
        const writes: number[] = [];
        let resolveMax: (v: number) => void;
        const maxP = new Promise<number>(r => (resolveMax = r));

        const p = arbiter.apply(3, 1, maxP, d => writes.push(d));
        arbiter.invalidate();
        resolveMax!(3);
        await p;
        expect(writes).toEqual([]);
    });
});
