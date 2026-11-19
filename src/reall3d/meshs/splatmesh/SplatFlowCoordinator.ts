// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================
import { TransitionEffects } from './SplatMeshOptions';

/**
 * 首帧过渡与画质档位切换的协调器。
 *
 * 目标：
 * 1. 首帧过渡（SplatMeshCycleZoom：光圈由内向外渐显）与画质档位（OnQualityLevelChanged）
 *    不再各自独立改写着色器参数。画质档位变化时，正在推进的过渡会被安全终止并收敛到
 *    稳定态（visibleRadius/lightRadius 归零），随后再以上一次档位参数为准写入，旧动画
 *    不会再覆盖新的球谐阶数、最小/最大像素直径与透明度阈值。
 * 2. 过渡自然完成时，收尾再次应用当前档位参数，保证最终参数与当前档位一致，并且
 *    “完成回调”在一次过渡链路中只触发一次。
 * 3. 显示模式（正常/点云）切换互相排挤：多次快速触发只保留最后一次，被取代的流程
 *    立即停止推进（帧循环不再续帧、延时任务被清除），且不会触发完成回调。
 * 4. 销毁后不再安排任何帧循环或延时任务，已排队的工作全部作废。
 *
 * 本类不依赖 three.js 与 WebGL，所有副作用通过 {@link SplatFlowHost} 注入，
 * 便于在单元测试中验证时序与收敛行为。
 */
export interface SplatFlowHost {
    /** 是否已销毁。销毁后协调器不再作任何推进。 */
    isDisposed(): boolean;
    /** 写入可见半径（0 表示无剔除、全量可见，即稳定态） */
    setVisibleRadius(value: number): void;
    /** 写入光圈半径（0 表示光圈停止） */
    setLightRadius(value: number): void;
    /** 写入点云/正常模式（不传值表示按当前模式取反） */
    setPointMode(value?: boolean): void;
    /** 写入过渡特效类型 */
    setTransitionEffect(value: number): void;
    /** 写入过渡动画起始时刻（屏幕中心类过渡使用） */
    setPerformanceAct(value: number): void;
    /** 重新应用当前质量档位对应的着色器参数（幂等，后写覆盖先写） */
    applyQuality(): void;
    /** 过渡链路自然完成时回调，同一条链路内至多一次 */
    onTransitionDone(showMark: boolean): void;
    /** 由首帧过渡收尾时触发显示模式切换（走统一的事件入口） */
    triggerSwitchDisplayMode(showMark: boolean): void;
    /** 当前是否为点云显示模式 */
    isPointcloudMode(): boolean;
    /** 小场景渲染数据是否全部就绪（决定光圈渐显是否可以收尾） */
    isSmallSceneDataReady(): boolean;
    /** 帧循环（对应 RunLoopByFrame），div>0 时按帧数取模执行 */
    runFrame(fnRun: () => void, fnIsContinue: () => boolean, div?: number): void;
    /** 延时任务，返回取消函数；销毁后不得再安排新任务 */
    scheduleTimeout(fn: () => void, ms: number): () => void;
    /** 当前时间（毫秒） */
    now(): number;
}

/** 首帧过渡参数 */
export interface FirstFrameTransitionParams {
    /** 大场景不支持光圈过渡 */
    isBigSceneMode: boolean;
    /** 关闭首帧过渡特效时直接进入稳定态 */
    disableTransitionEffectOnLoad: boolean;
    /** 模型最大半径（用于计算渐显进度） */
    maxRadius: number;
    /** 当前可用数据半径（渐显目标） */
    currentMaxRadius: number;
}

/** 显示模式切换参数 */
export interface DisplayModeSwitchParams {
    /** 过渡特效类型 */
    transitionEffect: number;
    /** 完成后是否显示标注 */
    showMark: boolean;
    /** 模型最大半径 */
    maxRadius: number;
    /** 大场景不响应光圈过渡 */
    isBigSceneMode?: boolean;
}

interface FlowSession {
    id: number;
    active: boolean;
    showMark: boolean;
    /** 已被外部收敛（如切档位）：只等待数据就绪完成收尾，不再推进动画 */
    converged: boolean;
    cancels: Array<() => void>;
}

/**
 * 球谐阶数写入优先级。
 * - 0：加载流程内部推断（如数据下载完成、调色板到达）。档位已显式生效后不再覆盖。
 * - 1：画质档位推导出的阶数。始终以最新一次为准。
 * - 2：用户显式指定阶数。始终以最新一次为准。
 */
export type ShDegreePriority = 0 | 1 | 2;

/**
 * 球谐阶数写入仲裁器。
 *
 * {@link SplatUpdateShDegree} 的处理需要 await 模型数据（GetModelShDegree）才能夹取上限，
 * 异步完成后可能乱序落盘：加载收尾的写入会覆盖用户刚切过的档位，或旧的档位写入覆盖新的。
 * 另外，画质档位往往在模型数据就绪前就写入（此时上限为 0），夹取后会暂时退化为 0。
 *
 * 这里的规则：
 * - 显式写入（画质档位 / 用户指定）立即生效并被记住，后写覆盖先写；
 * - 加载期推断写入在显式写入生效后不再改写阶数，而是触发一次“按最新上限重新夹取”的
 *   重放，保证数据就绪后最终阶数仍与当前档位一致；
 * - 加载期写入在没有任何显式写入时按后写覆盖先写生效。
 */
export class ShDegreeArbiter {
    private explicitSeq: number = 0;
    private lazySeq: number = 0;
    /** 最近一次显式写入的未夹取阶数；null 表示尚无显式写入 */
    private explicitValue: number | null = null;

    /**
     * @param value 期望的球谐阶数
     * @param priority 写入优先级
     * @param modelShDegree 模型实际可用阶数（可能为异步 Promise）
     * @param write 真正落盘的回调
     * @returns 本次写入被采纳时的最终阶数，未被采纳返回 undefined
     */
    public async apply(
        value: number,
        priority: ShDegreePriority,
        modelShDegree: number | Promise<number>,
        write: (degree: number, maxDegree: number) => void,
    ): Promise<number | undefined> {
        const isExplicit = priority >= 1;
        const seq = isExplicit ? ++this.explicitSeq : ++this.lazySeq;
        const replayValue = isExplicit ? value : this.explicitValue;

        const maxDegree = await modelShDegree;
        if (isExplicit) {
            // 已有更新的显式写入，本次作废
            if (seq !== this.explicitSeq) return undefined;
            this.explicitValue = value;
        } else if (replayValue === null) {
            // 无显式写入时，加载期写入按后写覆盖先写
            if (seq !== this.lazySeq) return undefined;
        }
        // 否则：加载期写入只作为“数据就绪”的触发点，重放最近的显式阶数

        const upper = typeof maxDegree === 'number' && isFinite(maxDegree) ? maxDegree : replayValue ?? value;
        const degree = Math.max(0, Math.min(replayValue ?? value, upper));
        write(degree, upper);
        return degree;
    }

    /** 使所有在途写入作废（销毁时使用） */
    public invalidate(): void {
        this.explicitSeq++;
        this.lazySeq++;
        this.explicitValue = null;
    }
}

export class SplatFlowCoordinator {
    private readonly host: SplatFlowHost;
    private disposed: boolean = false;
    private sessionSeq: number = 0;
    private qualityEpoch: number = 0;
    private zoomSession: FlowSession | null = null;
    private modeSession: FlowSession | null = null;

    constructor(host: SplatFlowHost) {
        this.host = host;
    }

    /** 当前质量档位版本号，异步参数写入可据此丢弃过期结果 */
    public get epoch(): number {
        return this.qualityEpoch;
    }

    /** 是否有首帧过渡正在推进 */
    public get isTransitionRunning(): boolean {
        return !!this.zoomSession;
    }

    /** 是否有显示模式切换正在推进 */
    public get isDisplayModeSwitching(): boolean {
        return !!this.modeSession;
    }

    /**
     * 质量档位变化：终止进行中的过渡并收敛，再应用新档位参数。
     * @returns 当前档位版本号
     */
    public onQualityChanged(): number {
        if (this.disposed) return this.qualityEpoch;
        this.qualityEpoch++;

        // 首帧过渡动画不得继续推进：立即收敛到稳定态（全量可见）。
        // 显示模式切换只写光圈半径，与档位参数不冲突，无需终止。
        const zoom = this.zoomSession;
        const dataReady = this.host.isSmallSceneDataReady();
        if (zoom) {
            zoom.converged = true;
            this.host.setVisibleRadius(0);
        }

        // 以新档位参数为准（后写覆盖先写，旧动画此后再无机会改写）
        if (!this.disposed) this.host.applyQuality();

        // 数据已就绪：过渡链路立即收尾（完成回调恰好一次、旧动画此后再无机会改写）；
        // 数据未就绪：链路保持收敛状态，待数据就绪后再收尾，避免提前清空纹理造成黑屏。
        // 注意：被档位变化打断的收尾不再派生新的显示模式切换动画，只保持稳定态。
        if (zoom && dataReady) this.finishZoom(zoom, { skipQuality: true, startModeSwitch: false });

        return this.qualityEpoch;
    }

    /**
     * 启动首帧光圈渐显过渡。新的过渡会取代仍在推进的旧过渡。
     */
    public runFirstFrameTransition(params: FirstFrameTransitionParams): void {
        if (this.disposed || params.isBigSceneMode) return;

        // 旧的过渡整体作废（新的从头开始，且由新链路负责收尾回调）
        this.cancelZoom(false);

        // 不需要这个特效时直接进入稳定态，且不安排任何帧循环；
        // 该路径不产生过渡完成回调（收尾由数据管理流程负责）
        if (params.disableTransitionEffectOnLoad) {
            this.host.setVisibleRadius(0);
            return;
        }

        const session: FlowSession = { id: ++this.sessionSeq, active: true, showMark: true, converged: false, cancels: [] };
        this.zoomSession = session;

        let stepRate = 0.01;
        let currentVisibleRadius = 0.01;
        let startTime: number = 0;

        this.host.setVisibleRadius(currentVisibleRadius);

        this.host.runFrame(
            () => {
                if (!session.active || this.disposed) return;

                // 已被切档位收敛：不再推进动画，等数据就绪后收尾
                if (session.converged) {
                    if (this.host.isSmallSceneDataReady()) this.finishZoom(session);
                    return;
                }

                currentVisibleRadius += (params.currentMaxRadius - currentVisibleRadius) * stepRate;
                this.host.setVisibleRadius(currentVisibleRadius);

                const isDataReady = this.host.isSmallSceneDataReady();
                const now = this.host.now();
                isDataReady && !startTime && (startTime = now);
                const visibleRate = params.maxRadius > 0 ? currentVisibleRadius / params.maxRadius : 1;
                if (isDataReady && (visibleRate > 0.9 || (startTime > 0 && now - startTime > 2500))) {
                    this.finishZoom(session);
                } else if (isDataReady && visibleRate > 0.7) {
                    stepRate = Math.min(stepRate * 1.2, 0.3);
                } else if (isDataReady && visibleRate > 0.5) {
                    stepRate = Math.min(stepRate * 1.2, 0.2);
                } else if (visibleRate > 0.4) {
                    stepRate = Math.min(stepRate * 1.05, 0.1);
                }
            },
            () => session.active && !this.disposed,
            3,
        );
    }

    /** 首帧过渡收尾：收敛、按当前档位重放参数，并只在整条链路内触发一次完成回调 */
    private finishZoom(session: FlowSession, opts: { skipQuality?: boolean; startModeSwitch?: boolean } = {}): void {
        if (!session.active || this.disposed) return;
        const { skipQuality = false, startModeSwitch = true } = opts;
        session.active = false;
        if (this.zoomSession === session) this.zoomSession = null;

        // 收敛到稳定态：全量可见
        this.host.setVisibleRadius(0);
        // 收尾时再次应用当前档位，保证最终参数与当前档位一致
        !skipQuality && this.host.applyQuality();

        if (startModeSwitch && this.host.isPointcloudMode()) {
            // 点云模式继续走光圈切换，由模式切换负责完成回调
            this.host.triggerSwitchDisplayMode(true);
        } else {
            this.notifyDone(session.showMark);
        }
    }

    /**
     * 显示模式切换（正常/点云）。多次快速触发时只有最后一次生效，
     * 被取代的流程立即停止且不触发完成回调。
     */
    public switchDisplayMode(params: DisplayModeSwitchParams): void {
        if (this.disposed || params.isBigSceneMode) return;

        // 首帧渐显若还在推进，先安全终止并收敛，避免两套动画互相踩踏；
        // 显示模式切换接管收尾责任，被取代的过渡链路不再单独触发完成回调
        this.cancelZoom(true);
        this.cancelMode(false);

        const session = this.newModeSession(params.showMark);
        this.host.setTransitionEffect(params.transitionEffect);

        if (params.transitionEffect === TransitionEffects.ModelCenterCirccle) {
            const startPointMode = this.host.isPointcloudMode();
            let stepRate = 0.0015;
            let currentLightRadius = params.maxRadius * 0.001;

            this.host.runFrame(
                () => {
                    if (!session.active || this.disposed) return;

                    currentLightRadius += params.maxRadius * stepRate;
                    this.host.setLightRadius(currentLightRadius);
                    if (currentLightRadius > params.maxRadius) {
                        session.active = false;
                        if (this.modeSession === session) this.modeSession = null;
                        // 根据开始时的显示模式进行切换
                        this.host.setPointMode(!startPointMode);
                        this.host.setLightRadius(0);
                        this.notifyDone(session.showMark);
                    } else if (currentLightRadius / params.maxRadius < 0.4) {
                        stepRate = Math.min(stepRate * 1.02, 0.03);
                    } else {
                        stepRate *= 1.04;
                    }
                },
                () => session.active && !this.disposed,
            );
            return;
        }

        // 以屏幕中心过渡
        this.host.setPerformanceAct(this.host.now());
        this.host.setLightRadius(0.1);
        session.cancels.push(
            this.host.scheduleTimeout(() => {
                if (!session.active || this.disposed) return;
                session.active = false;
                if (this.modeSession === session) this.modeSession = null;
                session.cancels = [];
                this.host.setPointMode();
                this.host.setLightRadius(0);
                this.notifyDone(session.showMark);
            }, 500),
        );
    }

    /** 销毁：终止全部流程，清除延时任务，此后不再安排任何工作 */
    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.cancelZoom(false);
        this.cancelMode(false);
    }

    private notifyDone(showMark: boolean): void {
        if (this.disposed) return;
        this.host.onTransitionDone(showMark);
    }

    private newModeSession(showMark: boolean): FlowSession {
        const session: FlowSession = { id: ++this.sessionSeq, active: true, showMark, converged: false, cancels: [] };
        this.modeSession = session;
        return session;
    }

    private cancelZoom(converge: boolean): void {
        const session = this.zoomSession;
        if (!session) return;
        session.active = false;
        this.zoomSession = null;
        if (converge && !this.disposed) this.host.setVisibleRadius(0);
    }

    private cancelMode(converge: boolean): void {
        const session = this.modeSession;
        if (!session) return;
        session.active = false;
        this.modeSession = null;
        const cancels = session.cancels;
        session.cancels = [];
        cancels.forEach(cancel => cancel());
        if (converge && !this.disposed) this.host.setLightRadius(0);
    }
}
