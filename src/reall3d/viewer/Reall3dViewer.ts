// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================
import '../assets/style/style.less';
import { Scene, AmbientLight, WebGLRenderer, Color, Matrix4, Camera, DirectionalLight, Mesh, MeshStandardMaterial } from 'three';
import { DRACOLoader, GLTFLoader } from 'three/examples/jsm/Addons.js';
import {
    GetCurrentDisplayShDegree,
    GetModelShDegree,
    IsBigSceneMode,
    IsControlPlaneVisible,
    OnSetFlyPositions,
    OnSetFlyTargets,
    SplatUpdateShDegree,
    ClearMarkPoint,
    CommonUtilsDispose,
    ViewerDispose,
    Information,
    IsCameraChangedNeedUpdate,
    KeyActionCheckAndExecute,
    LoadSmallSceneMetaData,
    MetaMarkSaveData,
    MarkUpdateVisible,
    OnViewerAfterUpdate,
    OnViewerUpdate,
    RunLoopByTime,
    SetGaussianText,
    SplatSetPointcloudMode,
    SplatSwitchDisplayMode,
    SplatUpdateLightFactor,
    SplatUpdateShowWaterMark,
    TraverseDisposeAndClear,
    ViewerUtilsDispose,
    ViewerCheckNeedUpdate,
    ViewerSetPointcloudMode,
    OnSetWaterMark,
    GetCachedWaterMark,
    AddFlyPosition,
    Flying,
    ClearFlyPosition,
    GetScene,
    OnViewerBeforeUpdate,
    GetOptions,
    GetControls,
    GetCanvas,
    GetRenderer,
    GetCamera,
    ViewerNeedUpdate,
    MetaMarkRemoveData,
    PrintInfo,
    GetSplatMesh,
    FlySavePositions,
    GetMeta,
    OnLoadAndRenderObj,
    GetMetaMatrix,
    UpdateQualityLevel,
    UpdateSortType,
    CountFpsReal,
    IsDebugMode,
    OnSetFlyDuration,
    StopBgAudio,
    ShowJoystick,
    OnViewerDispose,
    OnFetchStop,
    FocusAabbCenter,
    SplatUpdateFocal,
    IncreaseCameraFov,
    OnInitMarks,
    CheckViewerUpdateRow,
    IsDefaultPipeline,
    OnMetaDataLoaded,
    RenderCSS2D3D,
    RenderMinimap,
    LoadCircularAudioMask,
    PlaytBgAudio,
    OnLoadAndRenderPointCloudPly,
    SetViewerApi,
    GetOrignMetaString,
    ResetLoadingState,
    OnSceneLoadFailed,
} from '../events/EventConstants';
import { SplatMesh } from '../meshs/splatmesh/SplatMesh';
import { ModelOptions } from '../modeldata/ModelOptions';
import { Events } from '../events/Events';
import { copyGsViewerOptions, genDefaultSceneMeta, initCamera, initGsViewerOptions, initRenderer } from '../utils/ViewerUtils';
import { Reall3dViewerOptions } from './Reall3dViewerOptions';
import { SplatMeshOptions } from '../meshs/splatmesh/SplatMeshOptions';
import { computeCompressionRatio, getUrl, glbKhrGs2Splat, isPointCloudPly, isString, parseRgbPly } from '../utils/CommonUtils';
import { DecoderPath, isMobile, QualityLevels, SortTypes, ViewerVersion } from '../utils/GlobalConstants';
import { MetaData } from '../modeldata/MetaData';
import { globalEv } from '../events/GlobalEV';
import { setupPlayer } from '../scene/SetupPlayer';
import { loadFile } from '../modeldata/loaders/FileLoader';
import { MinimapOptions } from '../scene/SetupMinimap';
import { setupAllEventsVerwer } from '../scene/SetupAllEvents';
import { CameraControls } from '../scene/SetupCameraControls';
import { LoadSession } from '../modeldata/LoadSession';

/**
 * Built-in Gaussian Splatting model viewer
 */
export class Reall3dViewer {
    private disposed: boolean = false;
    private splatMesh: SplatMesh;
    private events: Events;
    private metaMatrix: Matrix4;

    /** 当前加载会话（本地拖拽等），同一时刻至多一个有效 */
    private loadSession: LoadSession = null;
    private loadSessionSeq: number = 0;
    /** 拖拽监听器只需绑定一次，reset 后仍可继续接受拖拽 */
    private dropLocalFileEnabled: boolean = false;

    public needUpdate: boolean = true;

    constructor(opts: Reall3dViewerOptions = {}) {
        console.info('Reall3dViewer', ViewerVersion);
        this.init(initGsViewerOptions(opts));
        !opts.disableDropLocalFile && this.enableDropLocalFile();
    }

    private init(opts: Reall3dViewerOptions) {
        const that = this;
        opts.position = opts.position ? [...opts.position] : [0, -5, 15];
        opts.lookAt = opts.lookAt ? [...opts.lookAt] : [0, 0, 0];
        opts.lookUp = opts.lookUp ? [...opts.lookUp] : [0, -1, 0];

        const renderer: WebGLRenderer = initRenderer(opts);
        const scene: Scene = (opts.scene = opts.scene || new Scene());
        scene.background = new Color(opts.background);

        initCamera(opts);
        const controls = (opts.controls = new CameraControls(opts));
        controls.updateByOptions(opts);
        const camera = controls.object as Camera;

        let renterTime = 0;
        const events = new Events();
        opts.viewerEvents = events;
        that.events = events;
        const on = (key: number, fn?: Function, multiFn?: boolean): Function | Function[] => events.on(key, fn, multiFn);
        const fire = (key: number, ...args: any): any => events.fire(key, ...args);

        on(GetMetaMatrix, () => that.metaMatrix);
        on(GetOptions, () => opts);
        on(GetCanvas, () => renderer.domElement);
        on(GetRenderer, () => renderer);
        on(GetScene, () => scene);
        on(GetControls, () => controls);
        on(GetCamera, () => camera);
        on(IsBigSceneMode, () => opts.bigSceneMode);
        on(ViewerSetPointcloudMode, (pointMode: boolean) => (opts.pointcloudMode = pointMode));

        let lastTimeNeedUpdate = 0;
        const aryUpdaters: any[] = [];
        on(ViewerNeedUpdate, () => {
            if (Date.now() - lastTimeNeedUpdate < 1000) return;
            lastTimeNeedUpdate = Date.now();

            that.needUpdate = true;
            // 稍微多点更新
            while (aryUpdaters.length) aryUpdaters.pop().stop = true; // 已有的都停掉
            let oUpdater = { count: 0, stop: false };
            aryUpdaters.push(oUpdater);

            fire(
                RunLoopByTime,
                () => {
                    that.needUpdate = true;
                    oUpdater.count++ >= 600 && (oUpdater.stop = true);
                },
                () => !that.disposed && (fire(IsControlPlaneVisible) || !oUpdater.stop),
                10,
            );
        });

        const splatMesh = new SplatMesh(copyGsViewerOptions(opts));
        that.splatMesh = splatMesh;
        on(GetSplatMesh, () => splatMesh);
        scene.add(splatMesh);

        setupAllEventsVerwer(events);

        on(UpdateQualityLevel, (qualityLevel: number) => {
            opts.qualityLevel = qualityLevel;
            splatMesh.options({ qualityLevel, renderer: undefined, scene: undefined });
        });

        on(UpdateSortType, (sortType: number) => {
            opts.sortType = sortType;
            splatMesh.options({ sortType, renderer: undefined, scene: undefined });
        });

        on(IncreaseCameraFov, (add = true) => {
            opts.fov += add ? 1 : -1;
            opts.fov = Math.max(10, Math.min(opts.fov, 80));
            const fov = opts.fov;
            controls.updateByOptions({ fov });
            splatMesh.fire(SplatUpdateFocal);
        });

        let minimapOpts: MinimapOptions;
        on(
            OnMetaDataLoaded,
            () => {
                minimapOpts = (fire(GetMeta) as MetaData).minimap;
                if (minimapOpts && isMobile) {
                    minimapOpts.size = minimapOpts.mobileSize || minimapOpts.size;
                    minimapOpts.corner = minimapOpts.mobileCorner || minimapOpts.corner || 'bottom-right';
                    minimapOpts.marginX = minimapOpts.mobileMarginX || 0;
                    minimapOpts.marginY = minimapOpts.mobileMarginY || 0;
                }
            },
            true,
        );

        const dirLight = new DirectionalLight(0xffffff, 1);
        dirLight.position.set(0, 2e3, 1e3);
        scene.add(dirLight);
        scene.add(new AmbientLight('#ffffff', 2));
        renderer.setAnimationLoop(that.update.bind(that));

        on(ViewerCheckNeedUpdate, () => {
            controls.update();
            !that.needUpdate && fire(IsCameraChangedNeedUpdate) && fire(ViewerNeedUpdate);
        });
        on(OnViewerBeforeUpdate, () => fire(KeyActionCheckAndExecute), true);
        on(OnViewerBeforeUpdate, () => fire(ViewerCheckNeedUpdate), true);
        // on(OnViewerBeforeUpdate, () => Date.now() - lastTimeNeedUpdate < 5000 && (that.needUpdate = true), true);
        on(CheckViewerUpdateRow, () => that.needUpdate && Date.now() - renterTime >= (isMobile ? 20 : opts.qualityLevel > 5 ? 1 : 18));

        on(
            OnViewerUpdate,
            () => {
                !(that.needUpdate = false) && (renterTime = Date.now()) && fire(IsDebugMode) && fire(CountFpsReal);
                if (!fire(IsDefaultPipeline)) return;

                renderer.render(scene, camera);
                fire(RenderCSS2D3D);
                minimapOpts && fire(RenderMinimap, minimapOpts);
            },
            true,
        );

        on(ViewerDispose, () => that.dispose());
        on(
            OnSceneLoadFailed,
            () => {
                // 场景元数据/场景树加载失败：结束本次会话并清理状态，保证下一次拖拽仍可用
                if (!that.loadSession) return;
                const failed = that.loadSession;
                that.loadSession = null;
                failed.cancel();
                that.resetLoadState();
            },
            true,
        );
        on(PrintInfo, () => console.info(JSON.stringify(fire(GetSplatMesh).meta || {}, null, 2)));

        let watermark: string = '';
        on(OnSetWaterMark, (text: string = '') => {
            watermark = text;
            that.splatMesh.fire(SetGaussianText, watermark, true); // 水印文字水平朝向
        });
        on(GetCachedWaterMark, () => watermark);
        fire(Information, { scale: `1 : ${fire(GetOptions).meterScale} m` });

        fire(SetViewerApi);
    }

    /**
     * 允许拖拽本地文件进行渲染（支持模型文件、*.meta.json文件、*.scene.json文件）
     *
     * 每次拖拽是一次可取消的加载会话：新的拖拽会先作废旧会话（中断下载、清理临时对象 URL），
     * 旧会话迟到的回调不再改动模型状态、水印或统计信息。
     */
    private enableDropLocalFile(): void {
        if (this.dropLocalFileEnabled) return;
        this.dropLocalFileEnabled = true;

        const that = this;
        document.addEventListener('dragover', function (e) {
            e.preventDefault();
            e.stopPropagation();
        });
        document.addEventListener('drop', async function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (that.disposed) return;
            globalEv.fire(StopBgAudio);
            let file = e.dataTransfer.files[0];
            if (!file) return;

            let format: 'ply' | 'splat' | 'spx' | 'spz' | 'sog' | 'obj' | 'glb';
            let isSceneJson = false;
            if (file.name.endsWith('.spx')) {
                format = 'spx';
            } else if (file.name.endsWith('.splat')) {
                format = 'splat';
            } else if (file.name.endsWith('.ply')) {
                format = 'ply';
            } else if (file.name.endsWith('.spz')) {
                format = 'spz';
            } else if (file.name.endsWith('.sog') || file.name.endsWith('.zip')) {
                format = 'sog';
            } else if (file.name.endsWith('.obj')) {
                format = 'obj';
            } else if (file.name.endsWith('.scene.json')) {
                isSceneJson = true;
            } else if (file.name.endsWith('.glb')) {
                format = 'glb';
                globalEv.on('Information-ver', () => `glb`);
            } else if (file.name.endsWith('.meta.json')) {
                // 不得而知，待后续进一步检查
            } else {
                return console.error('unsupported format:', file.name);
            }

            // 开始新会话：先作废旧会话并重建渲染器，保证旧会话的下载与解析写入立刻停止
            const opts: Reall3dViewerOptions = that.events.fire(GetOptions);
            opts.bigSceneMode = false;
            opts.debugMode = true;
            opts.autoRotate = false; // 本地拖拽大多是要看质量，默认不旋转
            opts.qualityLevel = QualityLevels.Default5; // 兼顾性能使用默认级别
            opts.disableTransitionEffectOnLoad = true; // 不要渐进过渡特效
            opts.pointcloudMode = false;
            opts.minDistance = 0.01;
            opts.maxDistance = 10000;
            opts.disableRightClickFocus = false;
            opts.viewMode = undefined;
            opts.shDegree = 3;
            opts.sortType = 1;
            opts.fov = 45;
            that.reset(opts); // 内部会作废上一次的加载会话
            if (that.disposed) return;
            const session = that.beginLoadSession();
            const url = session.trackFile(file);
            try {
                if (isSceneJson) {
                    const sceneMeta = await that.parseSceneJsonFile(url, session);
                    if (sceneMeta) await that.addScene(sceneMeta, session);
                    else that.abortLoadSession(session);
                } else {
                    await that.addModel({ url, format, session });
                    if (session.isActive() && !that.disposed) that.events.fire(FocusAabbCenter);
                }
            } catch (e) {
                console.error('drop local file failed', e);
                that.abortLoadSession(session);
            } finally {
                // 会话结束（成功或被新会话取代）时释放本次的临时对象 URL
                session.releaseObjectUrl(url);
            }
        });
    }

    /**
     * 读取本地拖入的 *.scene.json 场景文件。
     * blob url 不以 .scene.json 结尾，无法走 addScene 的 URL 判断，故在此单独读取解析，
     * 场景文件内的相对地址以当前页面地址为基准解析。
     */
    private async parseSceneJsonFile(url: string, session: LoadSession): Promise<MetaData> {
        try {
            const res = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'reload', signal: session?.signal });
            if (res.status !== 200) {
                console.error('scene file fetch failed, status:', res.status);
                return null;
            }
            const meta: MetaData = await res.json();
            return session && !session.isActive() ? null : meta;
        } catch (e) {
            console.error('scene file fetch failed', e.message);
            return null;
        }
    }

    /**
     * 清除上一次加载残留的进度、统计与已上传数据，使查看器回到“尚未加载任何模型”的可用状态。
     */
    private resetLoadState(): void {
        if (this.disposed) return;
        this.events?.tryFire(ResetLoadingState);
        this.splatMesh?.reset();
    }

    /**
     * 开始一次新的加载会话，作废上一次会话（中断下载、清理临时对象 URL、清空残留的加载状态）。
     */
    private beginLoadSession(): LoadSession {
        const that = this;
        // 作废旧会话
        that.cancelLoadSession();

        const session = new LoadSession(++that.loadSessionSeq);
        that.loadSession = session;
        session.signal.addEventListener(
            'abort',
            () => {
                if (that.loadSession !== session) return;
                that.loadSession = null;
                that.resetLoadState();
            },
            { once: true },
        );
        return session;
    }

    /** 取消当前会话（若存在）。 */
    private cancelLoadSession(cleanState: boolean = true): void {
        const session = this.loadSession;
        this.loadSession = null;
        if (!session) return;
        session.cancel();
        // 取消后清理残留的进度和模型状态（迟到的会话回调已被会话标记屏蔽）
        cleanState && this.resetLoadState();
    }

    /** 加载失败或中途取消：结束当前会话并清理状态。 */
    private abortLoadSession(session: LoadSession): void {
        if (session !== this.loadSession) return;
        this.loadSession = null;
        session.cancel();
        this.resetLoadState();
    }

    /**
     * 刷新
     */
    public update(): void {
        const that = this;
        if (that.disposed) return;
        const fire = (key: number, ...args: any): any => that.events.fire(key, ...args);
        fire(OnViewerBeforeUpdate);
        fire(CheckViewerUpdateRow) && fire(OnViewerUpdate);
        fire(OnViewerAfterUpdate);
    }

    // 开发调试用临时接口
    public fire(n: number, p1?: any, p2?: any): void {
        const that = this;
        n === 1 && that.splatMesh.fire(SplatUpdateShowWaterMark, p1); // 显示/隐藏水印
        n === 2 && that.events.fire(AddFlyPosition);
        n === 3 && that.events.fire(Flying, true);
        n === 4 && that.events.fire(ClearFlyPosition);
        n === 5 && that.events.fire(FlySavePositions, true);
        n === 6 && that.events.fire(MetaMarkSaveData);
        n === 7 && that.events.fire(MetaMarkRemoveData);
        if (n === 8) {
            (async () => {
                let shDegree: number = await that.splatMesh.fire(GetModelShDegree);
                if (p1) shDegree = that.splatMesh.fire(GetCurrentDisplayShDegree) + p1;
                that.splatMesh.fire(SplatUpdateShDegree, shDegree);
            })();
        }
        if (n === 9) {
            if (!p1) {
                that.events.fire(UpdateQualityLevel, QualityLevels.Default5);
            } else {
                const level: number = (that.events.fire(GetOptions) as Reall3dViewerOptions).qualityLevel;
                that.events.fire(UpdateQualityLevel, Math.max(QualityLevels.L1, Math.min(level + p1, QualityLevels.L9)));
            }
        }
        if (n === 10) {
            if (!p1) {
                that.events.fire(UpdateSortType, SortTypes.Default1);
            } else {
                const types = that.events.fire(IsBigSceneMode) ? [1, 2] : [1, 2, 2010, 2011];
                const sortType: number = (that.events.fire(GetOptions) as Reall3dViewerOptions).sortType;
                let idx = types.indexOf(sortType) + p1;
                idx = Math.max(0, Math.min(idx, types.length - 1));
                that.events.fire(UpdateSortType, types[idx]);
            }
        }
    }

    /**
     * 设定或者获取最新配置项
     * @param opts 配置项
     * @returns 最新配置项
     */
    public options(opts?: Reall3dViewerOptions): Reall3dViewerOptions {
        const that = this;
        if (that.disposed) return {};
        const fire = (key: number, ...args: any): any => that.events.fire(key, ...args);
        let splatOpts: SplatMeshOptions;
        const scene: Scene = fire(GetScene);
        scene.traverse((obj: any) => !splatOpts && obj instanceof SplatMesh && (splatOpts = (obj as SplatMesh).options()));

        if (opts) {
            const viewOpts = fire(GetOptions);
            if (opts.autoRotate !== undefined) {
                viewOpts.autoRotate = opts.autoRotate;
                fire(GetControls).autoRotate = opts.autoRotate;
            }
            opts.pointcloudMode !== undefined && fire(SplatSetPointcloudMode, opts.pointcloudMode);
            opts.lightFactor !== undefined && fire(SplatUpdateLightFactor, opts.lightFactor);

            opts.debugMode !== undefined && (viewOpts.debugMode = opts.debugMode);
            opts.qualityLevel !== undefined &&
                (viewOpts.qualityLevel = opts.qualityLevel) &&
                this.splatMesh.options({ qualityLevel: opts.qualityLevel } as any);
            opts.sortType !== undefined && (viewOpts.sortType = opts.sortType) && this.splatMesh.options({ sortType: opts.sortType } as any);

            opts.markType !== undefined && (viewOpts.markType = opts.markType);
            if (opts.markVisible !== undefined) {
                fire(MarkUpdateVisible, opts.markVisible);
            }
            if (opts.meterScale !== undefined) {
                viewOpts.meterScale = opts.meterScale;
            }
            if (opts.markMode !== undefined) {
                viewOpts.markMode = opts.markMode;
                !opts.markMode && fire(ClearMarkPoint);
                fire(GetControls).autoRotate = fire(GetOptions).autoRotate = false;
            }
            if (opts.disableRightClickFocus !== undefined) {
                viewOpts.disableRightClickFocus = opts.disableRightClickFocus;
            }
            if (opts.disableTransitionEffectOnLoad !== undefined) {
                viewOpts.disableTransitionEffectOnLoad = opts.disableTransitionEffectOnLoad;
                this.splatMesh.options({ disableTransitionEffectOnLoad: opts.disableTransitionEffectOnLoad } as any);
            }
        }

        const controls: CameraControls = fire(GetControls);
        controls.updateByOptions(opts);

        fire(Information, { scale: `1 : ${fire(GetOptions).meterScale} m` });
        return Object.assign({ ...fire(GetOptions) }, splatOpts);
    }

    /**
     * 重置
     * @param opts 新的配置项
     * @param keepSession 内部重入时（例如拖入场景文件）保留正在进行的加载会话
     */
    public reset(opts: Reall3dViewerOptions = {}, keepSession: LoadSession = null): void {
        const that = this;
        that.dispose(keepSession);
        that.disposed = false;
        that.init(initGsViewerOptions(opts));
        // 重建后重新关联仍在进行的加载会话，保证其取消时仍能清理本次加载状态
        keepSession && (that.loadSession = keepSession);
    }

    /**
     * 光圈过渡切换显示
     * @returns
     */
    public switchDeiplayMode() {
        const that = this;
        if (that.disposed) return;
        that.events.fire(SplatSwitchDisplayMode);
    }

    /**
     * 添加大场景
     * @param sceneUrl 场景地址，或已经解析好的场景元数据
     * @param session 可选的加载会话，取消后本次加载立即停止且不再写入查看器状态
     */
    public async addScene(sceneUrl: string | MetaData, session?: LoadSession) {
        const that = this;
        if (that.disposed) return;
        // 捕获当前事件系统：即使加载期间查看器被 reset，迟到的回调也不会写入新的查看器状态
        const events: Events = that.events;
        let on = (key: number, fn?: Function, multiFn?: boolean): Function | Function[] => events.on(key, fn, multiFn);
        let fire = (key: number, ...args: any): any => events.fire(key, ...args);
        const isSessionActive = () => !that.disposed && (session ? session.isActive() : that.events === events);

        let meta: MetaData = {};
        if (!isString(sceneUrl)) {
            // 本地拖入的场景文件已由调用方解析完成（blob url 无法以 .scene.json 结尾，故在此区分）
            meta = sceneUrl as MetaData;
        } else if ((sceneUrl as string).endsWith('.scene.json')) {
            try {
                const res = await fetch(sceneUrl as string, { mode: 'cors', credentials: 'omit', cache: 'reload', signal: session?.signal });
                if (res.status === 200) {
                    meta = await res.json();
                } else {
                    return console.error('scene file fetch failed, status:', res.status);
                }
            } catch (e) {
                return console.error('scene file fetch failed', e.message);
            }
        } else {
            meta = await genDefaultSceneMeta(sceneUrl as string, session);
        }
        if (!isSessionActive()) return; // 会话已作废，不再写入任何状态
        const orignMetaString = JSON.stringify(meta);

        if (!meta.url) return console.error('missing lod meta url');
        if (!meta.url.endsWith('.json')) return console.error('The format is unsupported in the large scene mode', meta.url);
        meta.disableTransitionEffectOnLoad && that.options({ disableTransitionEffectOnLoad: true, pointcloudMode: false });
        meta.disableTransitionEffectOnLoad && that.splatMesh.options({ pointcloudMode: false } as any);

        // 重置
        const orgOpts: Reall3dViewerOptions = fire(GetOptions);
        const opts: Reall3dViewerOptions = { root: orgOpts.root, ...meta, ...(meta.cameraInfo || {}) };
        opts.bigSceneMode = true;
        opts.qualityLevel = meta.qualityLevel || QualityLevels.Default5;
        opts.sortType = meta.sortType || SortTypes.Radial2;
        opts.viewMode = meta.viewMode;
        meta.background && (opts.background = meta.background);
        // 内部 reset 会重建事件系统，作废检查需要在 reset 之前完成
        if (!isSessionActive()) return;
        that.reset({ ...opts }, session);
        if (!isSessionActive()) return;

        // reset 重建了事件系统，后续必须使用新的事件对象，否则元数据与回调都写在已废弃的对象上
        const sceneEvents: Events = that.events;
        on = (key: number, fn?: Function, multiFn?: boolean): Function | Function[] => sceneEvents.on(key, fn, multiFn);
        fire = (key: number, ...args: any): any => sceneEvents.fire(key, ...args);

        on(GetOrignMetaString, () => orignMetaString);
        // 场景文件内的相对地址以场景地址为基准；直接传入已解析的元数据时，以当前页面地址为基准
        const sceneBase = isString(sceneUrl) ? (sceneUrl as string) : location.href;
        const baseUrl = getUrl(sceneBase, location.href);

        meta.player?.url && (meta.player.url = getUrl(meta.player.url, baseUrl));
        meta.player?.trigerRunMp3 && (meta.player.trigerRunMp3 = getUrl(meta.player.trigerRunMp3, baseUrl));
        meta.collisionUrl && (meta.collisionUrl = getUrl(meta.collisionUrl, baseUrl));
        meta.minimap && (meta.minimap.url = getUrl(meta.minimap.url, baseUrl));
        meta.audioMask && (meta.audioMask.audioUrl = getUrl(meta.audioMask.audioUrl, baseUrl));
        meta.audioMask?.audioUrl && fire(LoadCircularAudioMask, meta.audioMask);
        meta.url = getUrl(meta.url, baseUrl);
        meta.bgAudio && (meta.bgAudio = getUrl(meta.bgAudio, baseUrl));
        meta.audio?.mp3 && (meta.audio.mp3 = getUrl(meta.audio.mp3, baseUrl));

        on(GetMeta, () => meta);
        fire(OnMetaDataLoaded);
        if (!isSessionActive()) return;
        setupPlayer(that.events);

        meta.bgAudio && globalEv.fire(PlaytBgAudio, meta.bgAudio, true);

        that.metaMatrix = meta.transform ? new Matrix4().fromArray(meta.transform) : null;

        // 按元数据调整更新相机、标注等信息
        that.splatMesh.meta = meta;
        isMobile && (meta.cameraInfo?.position || meta.cameraInfo?.lookAt) && that.events.fire(GetControls)._dollyOut(0.7); // 手机适当缩小

        fire(OnSetFlyPositions, meta.flyPositions || []);
        fire(OnSetFlyTargets, meta.flyTargets || []);
        fire(OnSetFlyDuration, meta.flyDuration);
        fire(OnInitMarks, meta);
        // 加载模型
        const modelBaseUrl = sceneUrl && isString(sceneUrl) ? getUrl(sceneUrl as string, location.href) : '';
        that.splatMesh.addModel({ url: meta.url, baseUrl: modelBaseUrl, session }, meta);
        await fire(OnSetWaterMark, meta.watermark || meta.name);
        if (!isSessionActive()) return;
        fire(GetControls).updateRotateAxis();

        ((isMobile && meta.mobileEnableJoystick) || (!isMobile && meta.pcEnableJoystick)) && fire(ShowJoystick);
    }

    /**
     * 添加要渲染的高斯模型（小场景模式）
     * @param urlOpts 高斯模型链接或元数据文件链接或选项
     */
    public async addModel(urlOpts: string | ModelOptions): Promise<void> {
        const that = this;
        if (that.disposed) return;
        // 捕获当前事件系统：即使加载期间查看器被 reset（事件系统被重建），迟到的回调也只会写入已废弃的旧事件对象
        const events: Events = that.events;
        const on = (key: number | string, fn?: Function, multiFn?: boolean): Function | Function[] => events.on(key, fn, multiFn);
        const fire = (key: number, ...args: any): any => events.fire(key, ...args);

        // 参数整理
        const session: LoadSession = isString(urlOpts) ? null : (urlOpts as ModelOptions).session;
        // 捕获当前事件系统与网格：即使加载期间查看器被 reset，迟到的回调也只会写入已废弃的旧对象
        const splatMesh: SplatMesh = that.splatMesh;
        // 会话状态检查：会话取消或查看器重置后，任何迟到的回调都不得改动当前模型状态
        const isSessionActive = () => !that.disposed && that.events === events && that.splatMesh === splatMesh && (!session || session.isActive());
        let isMetaUrl = false;
        let metaUrl = '';
        let modelOpts: ModelOptions = { url: '' };
        if (isString(urlOpts)) {
            if ((urlOpts as string).endsWith('.meta.json')) {
                metaUrl = urlOpts as string;
                isMetaUrl = true;
            } else {
                modelOpts.url = urlOpts as string;
            }
        } else if (!(urlOpts as ModelOptions).format) {
            metaUrl = (urlOpts as ModelOptions).url;
            isMetaUrl = true;
        } else {
            modelOpts = urlOpts as ModelOptions;
        }
        if (!modelOpts.url && !metaUrl) return console.error('model url is empty');

        // 获取元数据
        const opts: Reall3dViewerOptions = fire(GetOptions);
        opts.bigSceneMode = false;
        let meta: MetaData = {};
        if (!modelOpts.url.startsWith('blob:')) {
            try {
                metaUrl = metaUrl || modelOpts.url.substring(0, modelOpts.url.lastIndexOf('.')) + '.meta.json'; // xxx/abc.spx => xxx/abc.meta.json
                const res = await fetch(metaUrl, { mode: 'cors', credentials: 'omit', cache: 'reload', signal: session?.signal });
                if (res.status === 200) {
                    meta = await res.json();
                } else {
                    console.warn('meta file fetch failed, status:', res.status);
                }
            } catch (e) {
                console.warn('meta file fetch failed', e.message, modelOpts.url);
            }
        }
        if (!isSessionActive()) return; // 会话已作废，不再写入任何状态
        const orignMetaString = JSON.stringify(meta);
        on(GetOrignMetaString, () => orignMetaString);

        // 检查整理
        meta.showWatermark = !!meta.showWatermark; // 是否显示水印文字
        meta.disableTransitionEffectOnLoad && that.options({ disableTransitionEffectOnLoad: true, pointcloudMode: false });
        meta.disableTransitionEffectOnLoad && splatMesh.options({ pointcloudMode: false } as any);

        meta.url && (meta.url = getUrl(meta.url, metaUrl));
        meta.url = meta.url || modelOpts.url;
        if (!modelOpts.format) {
            modelOpts.url = isMetaUrl ? meta.url : modelOpts.url;
            const urlfile = modelOpts.url.split('?')[0];
            if (urlfile.endsWith('.spx')) {
                modelOpts.format = 'spx';
            } else if (urlfile.endsWith('.splat')) {
                modelOpts.format = 'splat';
            } else if (urlfile.endsWith('.ply')) {
                modelOpts.format = 'ply';
            } else if (urlfile.endsWith('.spz')) {
                modelOpts.format = 'spz';
            } else if (urlfile.endsWith('.zip') || urlfile.endsWith('.sog') || urlfile.endsWith('/meta.json') || urlfile == 'meta.json') {
                modelOpts.format = 'sog';
            } else if (urlfile.endsWith('.obj')) {
                modelOpts.format = 'obj';
            } else if (urlfile.endsWith('.glb')) {
                modelOpts.format = 'glb';
            } else {
                console.error('unknow format!', modelOpts.url);
                return;
            }
        }

        // 优先顺序： meta -> opts -> default
        meta.qualityLevel = meta.qualityLevel || opts.qualityLevel || QualityLevels.Default5;
        meta.sortType = meta.sortType || opts.sortType || SortTypes.Default1;
        meta.minimap && (meta.minimap.url = getUrl(meta.minimap.url, getUrl(metaUrl, location.href)));
        meta.audioMask && (meta.audioMask.audioUrl = getUrl(meta.audioMask.audioUrl, getUrl(metaUrl, location.href)));
        meta.audioMask?.audioUrl && fire(LoadCircularAudioMask, meta.audioMask);
        meta.disableTransitionEffectOnLoad && that.options({ disableTransitionEffectOnLoad: true, pointcloudMode: false });
        meta.disableTransitionEffectOnLoad && splatMesh.options({ pointcloudMode: false } as any);
        meta.bgAudio && (meta.bgAudio = getUrl(meta.bgAudio, getUrl(metaUrl, location.href)));
        meta.audio?.mp3 && (meta.audio.mp3 = getUrl(meta.audio.mp3, getUrl(metaUrl, location.href)));

        on(GetMeta, () => meta);
        fire(OnMetaDataLoaded);
        if (!isSessionActive()) return;
        setupPlayer(that.events);
        fire(OnSetFlyDuration, meta.flyDuration);

        meta.bgAudio && globalEv.fire(PlaytBgAudio, meta.bgAudio, true);

        that.metaMatrix = meta.transform ? new Matrix4().fromArray(meta.transform) : null;

        // 按元数据调整更新相机、标注等信息
        fire(LoadSmallSceneMetaData, meta);
        that.options({ qualityLevel: meta.qualityLevel, sortType: meta.sortType, background: meta.background }); // 允许根据具体模型特点在meta中定义渲染质量级别，均衡质量性能资源

        // 模型本体交由会话持有，取消会话时中断其下载与解析
        modelOpts.session = session || modelOpts.session;

        // 加载模型
        if (modelOpts.format === 'glb') {
            const fileBytes: Uint8Array = await loadFile(modelOpts.url, that.events, session);
            if (!fileBytes || !isSessionActive()) return;
            fire(OnFetchStop, 100);
            const ui32s = new Uint32Array(fileBytes.slice(0, 32).buffer);
            const jsonLength4 = Math.floor((ui32s[3] + 3) / 4) * 4;
            const sJson = new TextDecoder().decode(fileBytes.slice(20, 20 + jsonLength4));

            // 扩展标准尚未发布，当前先初步对应
            if (/KHR_gaussian_splatting_compression_spz_2/.test(sJson)) {
                const oJson = JSON.parse(sJson);
                const buffersOffset = 20 + jsonLength4 + 8;
                const spzBytes = fileBytes
                    .subarray(buffersOffset, buffersOffset + oJson.buffers[0].byteLength)
                    .subarray(oJson.bufferViews[0].byteOffset || 0, oJson.bufferViews[0].byteLength);
                const glburl = modelOpts.url;
                modelOpts.url = session ? session.trackBlob(new Blob([spzBytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' })) : URL.createObjectURL(new Blob([spzBytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
                modelOpts.format = 'spz';

                globalEv.on('Information-ver', () => `glb-spz`);

                splatMesh.addModel(modelOpts, meta);
                await fire(OnSetWaterMark, meta.watermark || meta.name);
                session ? session.releaseObjectUrl(modelOpts.url) : URL.revokeObjectURL(modelOpts.url);
                modelOpts.url = glburl;
            } else if (/KHR_gaussian_splatting/.test(sJson)) {
                const splatBytes = glbKhrGs2Splat(fileBytes);
                const glburl = modelOpts.url;
                modelOpts.url = session ? session.trackBlob(new Blob([splatBytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' })) : URL.createObjectURL(new Blob([splatBytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
                modelOpts.format = 'splat';

                const ratio = '　' + computeCompressionRatio(splatBytes.byteLength / 32, fileBytes.byteLength);
                const size = '　' + (fileBytes.byteLength / 1024 / 1024).toFixed(1) + 'M';
                globalEv.on('Information-ver', () => `glb-gs`);
                globalEv.on('Information-ratio', () => ratio);
                globalEv.on('Information-size', () => size);

                splatMesh.addModel(modelOpts, meta);
                await fire(OnSetWaterMark, meta.watermark || meta.name);
                session ? session.releaseObjectUrl(modelOpts.url) : URL.revokeObjectURL(modelOpts.url);
                modelOpts.url = glburl;
            } else if (/com_github_gotoeasy_gsbox_webp_rgb_ply/.test(sJson)) {
                const oJson = JSON.parse(sJson);
                const buffersOffset = 20 + jsonLength4 + 8;
                const dataBytes = fileBytes
                    .subarray(buffersOffset, buffersOffset + oJson.buffers[0].byteLength)
                    .subarray(oJson.bufferViews[0].byteOffset || 0, oJson.bufferViews[0].byteLength);

                const { count, plyBytes, xyzs, minY, maxY } = await parseRgbPly(dataBytes);
                if (!isSessionActive()) return;
                on('GetRgbPlyXyzs', () => xyzs);
                on('GetRgbPlyMinY', () => minY);
                on('GetRgbPlyMaxY', () => maxY);
                const urlBlob = session ? session.trackBlob(new Blob([plyBytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' })) : URL.createObjectURL(new Blob([plyBytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
                modelOpts.format = 'ply';

                await fire(OnLoadAndRenderPointCloudPly, urlBlob, session);
                if (!isSessionActive()) return;
                fire(Information, { renderSplatCount: count, visibleSplatCount: count, modelSplatCount: count, scene: 'small (glb-ply)' });
                session ? session.releaseObjectUrl(urlBlob) : URL.revokeObjectURL(urlBlob);
            } else {
                const urlBlob = session ? session.trackBlob(new Blob([fileBytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' })) : URL.createObjectURL(new Blob([fileBytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
                await this.loadGlb(urlBlob, meta, session);
                session ? session.releaseObjectUrl(urlBlob) : URL.revokeObjectURL(urlBlob);
            }
        } else if (modelOpts.format === 'obj') {
            that.options({ autoRotate: false });
            await fire(OnLoadAndRenderObj, modelOpts.url, session);
        } else if (modelOpts.format === 'ply' && modelOpts.url.startsWith('blob:')) {
            const fileBytes: Uint8Array = await loadFile(modelOpts.url, that.events, session);
            if (!fileBytes || !isSessionActive()) return;
            fire(OnFetchStop, 100);

            let header = new TextDecoder().decode(fileBytes.slice(0, 1024 * 2));
            const header_end = 'end_header\n';
            const header_end_index = header.indexOf(header_end);
            if (header_end_index < 0) {
                if (fileBytes.byteLength > 1024 * 2) throw new Error('Unable to read .ply file header');
                return;
            }
            header = header.substring(0, header_end_index);
            if (isPointCloudPly(header)) {
                await fire(OnLoadAndRenderPointCloudPly, modelOpts.url, session);
            } else {
                splatMesh.addModel(modelOpts, meta);
                await fire(OnSetWaterMark, meta.watermark || meta.name);
            }
        } else {
            splatMesh.addModel(modelOpts, meta);
            await fire(OnSetWaterMark, meta.watermark || meta.name);
        }

        if (!isSessionActive()) return;
        isMobile && fire(GetControls)._dollyOut?.(0.7); // 手机适当缩小
        ((isMobile && meta.mobileEnableJoystick) || (!isMobile && meta.pcEnableJoystick)) && fire(ShowJoystick);
    }

    private async loadGlb(urlBlob: string, meta: MetaData, session?: LoadSession) {
        const fire = (key: number, ...args: any): any => this.events.fire(key, ...args);

        const loader = new GLTFLoader();
        const dracoLoader = new DRACOLoader();
        dracoLoader.setDecoderPath(DecoderPath);
        loader.setDRACOLoader(dracoLoader);

        loader.load(
            urlBlob,
            gltf => {
                if (session && !session.isActive()) return; // 会话已作废，迟到的回调不再改动场景
                const model = gltf.scene;

                // 对 MeshStandardMaterial 的极端参数进行修复，改为非金属，保证漫反射
                model.traverse(obj => {
                    if (!(obj as Mesh).isMesh) return;
                    const mat = (obj as Mesh).material;
                    if (mat instanceof MeshStandardMaterial && mat.metalness >= 1 && mat.roughness >= 1) mat.metalness = 0;
                });

                (fire(GetScene) as Scene).add(model);
                fire(LoadSmallSceneMetaData, meta);
                fire(MarkUpdateVisible, true);
                fire(ViewerNeedUpdate);
            },
            () => {},
            err => console.error(err),
        );
    }

    /**
     * 销毁渲染器不再使用
     * @param keepSession 内部重入时保留正在进行的加载会话（不要中断它）
     */
    public dispose(keepSession: LoadSession = null): void {
        const that = this;
        if (that.disposed) return;
        that.disposed = true;
        // 作废当前加载会话：中断下载、停止后续解析写入、释放临时对象 URL
        if (keepSession) {
            // 保留该会话，仅解除引用，会话仍由调用方持有
            that.loadSession === keepSession && (that.loadSession = null);
        } else {
            that.cancelLoadSession(false);
        }
        const fire = (key: number, ...args: any): any => that.events.fire(key, ...args);

        const renderer: WebGLRenderer = fire(GetRenderer);
        const canvas = renderer.domElement as HTMLCanvasElement;

        fire(OnViewerDispose);
        fire(CommonUtilsDispose);
        fire(ViewerUtilsDispose);
        (fire(GetControls) as CameraControls).dispose();

        fire(TraverseDisposeAndClear, fire(GetScene));

        renderer.clear();
        renderer.dispose();

        canvas.parentElement.removeChild(canvas);
        that.splatMesh = null;
        that.events.clear();
        that.events = null;
    }
}
