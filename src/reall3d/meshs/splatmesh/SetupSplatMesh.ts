// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================
import {
    BufferAttribute,
    DataArrayTexture,
    DataTexture,
    DoubleSide,
    DynamicDrawUsage,
    InstancedBufferAttribute,
    InstancedBufferGeometry,
    Mesh,
    NearestFilter,
    NormalBlending,
    PerspectiveCamera,
    RGBAIntegerFormat,
    ShaderMaterial,
    UnsignedByteType,
    UnsignedIntType,
    Vector2,
    Vector4,
} from 'three';
import { Events } from '../../events/Events';
import {
    GetCamera,
    GetCurrentDisplayShDegree,
    GetModelShDegree,
    GetShTexheight,
    SplatUpdateSh12Texture,
    SplatUpdateSh3Texture,
    SplatUpdateShDegree,
    UploadSplatTexture,
    OnUploadDblIndexDone,
    NotifyViewerNeedUpdate,
    SplatUpdateViewport,
    GetSplatMaterial,
    CreateSplatGeometry,
    CreateSplatMaterial,
    CreateSplatUniforms,
    SplatUpdateFocal,
    SplatUpdateSplatIndex,
    GetSortWorker,
    GetCanvasSize,
    Information,
    GetSplatGeometry,
    CreateSplatMesh,
    GetOptions,
    SplatMeshDispose,
    SplatGeometryDispose,
    SplatMaterialDispose,
    GetMaxRenderCount,
    SplatUpdateSglTexture,
    SplatUpdateUsingIndex,
    SplatUpdatePointMode,
    SplatUpdateBigSceneMode,
    SplatUpdateLightFactor,
    SplatUpdateTopY,
    SplatUpdateCurrentVisibleRadius,
    SplatUpdateCurrentLightRadius,
    IsBigSceneMode,
    SplatMeshSwitchDisplayMode,
    RunLoopByFrame,
    IsPointcloudMode,
    SplatMeshCycleZoom,
    IsSmallSceneRenderDataReady,
    OnTextureReadySplatCount,
    SplatUpdateMarkPoint,
    MarkUpdateVisible,
    SplatUpdatePerformanceNow,
    SplatUpdateShowWaterMark,
    FlyOnce,
    SplatUpdateDebugEffect,
    SplatUpdateFlagValue,
    SplatUpdateMaxRadius,
    SplatUpdatePerformanceAct,
    OnSmallSceneShowDone,
    SplatUpdateParticleMode,
    SplatUpdateTransitionEffect,
    SplatUpdateMinMaxPixelDiameter,
    SplatUpdateMinAlpha,
    OnQualityLevelChanged,
    WorkerUpdateParams,
    GetSplatMesh,
    IsSplatMeshCreated,
    SplatUpdateUseSimilarExp,
    SplatUpdateActiveFlagValue,
    SplatUpdateShPalettesTexture,
    SplatUpdateShPalettesReady,
    ComputeTextureWidthHeight,
    GetSplatShaderDefines,
    SplatUpdateUseLod,
    GetMeta,
    NotifyWkA09SortPart,
    GetDataArrayTexture,
    SplatUploadTextureGpuCache,
    GetLodDataInfo,
    GetShaderMaterial,
    NotifyWkA01BackXyz,
    NotifyWkA01BackXyzIndex,
    NotifyWkA01SetTextureSize,
    SplatUpdateDblTexture,
    NotifyWkA01BackSplatBuffer,
    NotifyWkA09DblTextureReady,
    NotifyWkA09SglTextureReady,
} from '../../events/EventConstants';
import { SplatMeshOptions, TransitionEffects } from './SplatMeshOptions';
import { SplatFlowCoordinator, SplatFlowHost, ShDegreeArbiter, ShDegreePriority } from './SplatFlowCoordinator';
import { pumpTextureLayers } from './SplatTexturePump';
import {
    VarActiveFlagValue,
    VarBigSceneMode,
    VarCurrentLightRadius,
    VarCurrentVisibleRadius,
    VarDebugEffect,
    VarFlagValue,
    VarFocal,
    VarLightFactor,
    VarMarkPoint,
    VarMaxPixelDiameter,
    VarMaxRadius,
    VarMinAlpha,
    VarMinPixelDiameter,
    VarParticleMode,
    VarPerformanceAct,
    VarPerformanceNow,
    VarPointMode,
    VarShDegree,
    VarShowWaterMark,
    VarShPalettes,
    VarShPalettesReady,
    VarSplatIndex,
    VarSplatShTexture12,
    VarSplatShTexture3,
    VarSplatTexture0,
    VarSplatTexture1,
    VarSplatTextureHeightAry,
    VarSplatTextureWidth,
    VarTopY,
    VarTransitionEffect,
    VarUseLod,
    VarUseSimilarExp,
    VarUsingIndex,
    VarViewport,
    VarWaterMarkColor,
} from './WebglVars';
import {
    WkIndex,
    WkRenderSplatCount,
    WkSortTime,
    WkDepthIndex,
    WkSortStartTime,
    WkXyz,
    WkBucketBits,
    WkSortType,
    WkA09BackDepthIndex,
    WkXyzIndex,
    WkA90BackXyz,
    WkA90BackXyzIndex,
    WkA90DepthIndex,
} from '../../modeldata/worker/WkConstants';
import vertexShader from './shaders/SplatVertex.glsl';
import fragmentShader from './shaders/SplatFragment.glsl';
import { MetaData } from '../../modeldata/MetaData';
import { SplatMesh } from './SplatMesh';
import { shaderChunk, sleep } from '../../utils/CommonUtils';
import CmnFns from './shaders/chunks/CmnFns.glsl';
import FvEffect from './shaders/chunks/FvEffect.glsl';
import WatermarkEffect from './shaders/chunks/WatermarkEffect.glsl';
import { SplatFile } from '../../modeldata/SplatTiles';
import { SplatGpuCache } from './SplatGpuCache';
import { isMobile, QualityLevels } from '../../utils/GlobalConstants';

export function setupSplatMesh(events: Events) {
    let disposed = false;
    const on = (key: number, fn?: Function, multiFn?: boolean): Function | Function[] => events.on(key, fn, multiFn);
    const fire = (key: number, ...args: any): any => events.fire(key, ...args);

    let maxRenderCount: number = 0;
    let maxRadius: number = 0;
    let currentMaxRadius: number = 0;
    let bucketBits: number = 0;
    let sortType: number = 0;
    const PalettesWidth = 960;
    let splatCacheManager: SplatGpuCache = null;

    // ---- 首帧过渡 / 画质档位 / 显示模式切换的协调（统一收口，避免各自踩踏）----
    const pendingTimers: Set<ReturnType<typeof setTimeout>> = new Set();
    // 销毁通知订阅者：挂起的异步工作（如纹理上传等待 GPU 回传）据此立即退出
    const abortListeners: Set<() => void> = new Set();
    const onAbort = (fn: () => void): (() => void) => {
        if (disposed) return (fn(), () => {});
        abortListeners.add(fn);
        return () => abortListeners.delete(fn);
    };
    const flowHost: SplatFlowHost = {
        isDisposed: () => disposed,
        setVisibleRadius: (value: number) => !disposed && fire(SplatUpdateCurrentVisibleRadius, value),
        setLightRadius: (value: number) => !disposed && fire(SplatUpdateCurrentLightRadius, value),
        setPointMode: (value?: boolean) => !disposed && fire(SplatUpdatePointMode, value),
        setTransitionEffect: (value: number) => !disposed && fire(SplatUpdateTransitionEffect, value),
        setPerformanceAct: (value: number) => !disposed && fire(SplatUpdatePerformanceAct, value),
        applyQuality: () => applyQualityLevel(),
        onTransitionDone: (showMark: boolean) => !disposed && fire(OnSmallSceneShowDone, showMark),
        triggerSwitchDisplayMode: (showMark: boolean) => !disposed && fire(SplatMeshSwitchDisplayMode, showMark),
        isPointcloudMode: () => !!fire(IsPointcloudMode),
        isSmallSceneDataReady: () => !!fire(IsSmallSceneRenderDataReady),
        runFrame: (fnRun: () => void, fnIsContinue: () => boolean, div: number = 0) => {
            if (disposed) return;
            fire(RunLoopByFrame, fnRun, fnIsContinue, div);
        },
        scheduleTimeout: (fn: () => void, ms: number): (() => void) => {
            if (disposed) return () => {};
            const timer = setTimeout(() => {
                pendingTimers.delete(timer);
                !disposed && fn();
            }, ms);
            pendingTimers.add(timer);
            return () => {
                pendingTimers.delete(timer);
                clearTimeout(timer);
            };
        },
        now: () => Date.now(),
    };
    const flow = new SplatFlowCoordinator(flowHost);
    const shArbiter = new ShDegreeArbiter();

    function clearPendingTimers() {
        pendingTimers.forEach(timer => clearTimeout(timer));
        pendingTimers.clear();
    }

    function notifyAbort() {
        const listeners = Array.from(abortListeners);
        abortListeners.clear();
        listeners.forEach(fn => fn());
    }

    let currentDisplayShDegree: number = 0;
    on(GetCurrentDisplayShDegree, () => currentDisplayShDegree);

    on(SplatGeometryDispose, () => {}, true);
    on(SplatMaterialDispose, () => {}, true);
    on(SplatUpdateFocal, () => {}, true);
    on(SplatUpdateViewport, () => {}, true);

    on(CreateSplatGeometry, async () => {
        const baseGeometry = new InstancedBufferGeometry();
        baseGeometry.setIndex([0, 1, 2, 0, 2, 3]);
        const positionsArray = new Float32Array(4 * 3);
        const positions = new BufferAttribute(positionsArray, 3);
        baseGeometry.setAttribute('position', positions);
        positions.setXYZ(0, -2.0, -2.0, 0.0);
        positions.setXYZ(1, -2.0, 2.0, 0.0);
        positions.setXYZ(2, 2.0, 2.0, 0.0);
        positions.setXYZ(3, 2.0, -2.0, 0.0);
        positions.needsUpdate = true;

        let geometry = new InstancedBufferGeometry().copy(baseGeometry);

        if (disposed) return;
        const indexArray = new Uint32Array(maxRenderCount);
        const indexAttribute = new InstancedBufferAttribute(indexArray, 1, false);
        indexAttribute.setUsage(DynamicDrawUsage);
        indexAttribute.needsUpdate = true;
        geometry.setAttribute(VarSplatIndex, indexAttribute);
        geometry.instanceCount = 0;

        on(SplatUpdateSplatIndex, (datas: Uint32Array, index: number, sortTime: number, sortStartTime: number, renderSplatCount: number) => {
            fire(SplatUpdateUsingIndex, index);
            indexArray.set(datas, 0);
            indexAttribute.clearUpdateRanges();
            indexAttribute.addUpdateRange(0, renderSplatCount);
            indexAttribute.needsUpdate = true;
            indexAttribute.onUpload(() => {
                fire(OnUploadDblIndexDone, index);
                fire(Information, { renderSplatCount });
            });
            geometry.instanceCount = renderSplatCount;
            fire(NotifyViewerNeedUpdate);
            fire(Information, { sortTime: `${sortTime} / ${Date.now() - sortStartTime}`, bucketBits, sortType });
        });

        on(GetSplatGeometry, () => geometry);
        on(
            SplatGeometryDispose,
            () => {
                indexAttribute.array = null;
                geometry.dispose();
            },
            true,
        );

        return geometry;
    });

    on(GetSplatShaderDefines, () => {
        const defines: any = {};
        const opts: SplatMeshOptions = fire(GetOptions);
        if (opts.bigSceneMode) {
            defines.BigSceneMode = '';
        }
        return defines;
    });

    on(CreateSplatMaterial, async () => {
        if (disposed) return;
        const opts: SplatMeshOptions = fire(GetOptions);
        const meta: MetaData = fire(GetMeta);

        const fnCounts = async () => {
            if (!fire(IsBigSceneMode)) return { dataCount: maxRenderCount };
            const { totalCount, lodTargetsTotalCount, lodTargetsFileCount, maxFileSplatCount } = await fire(GetLodDataInfo);
            const dataCount = meta.useGpuCache ? lodTargetsTotalCount : maxRenderCount;
            return { dataCount, totalCount, lodTargetsTotalCount, lodTargetsFileCount, maxFileSplatCount };
        };
        const { dataCount, lodTargetsFileCount, maxFileSplatCount } = await fnCounts();
        const oTexSize = fire(ComputeTextureWidthHeight, dataCount, maxFileSplatCount, lodTargetsFileCount);
        fire(NotifyWkA01SetTextureSize, oTexSize);
        // console.log('--------oTexSize--------', dataCount, oTexSize);
        const { texwidth, texheight, texdepth, texheightary, fullCache } = oTexSize;
        const material: ShaderMaterial = new ShaderMaterial({
            uniforms: fire(CreateSplatUniforms, texwidth, texheightary),
            vertexShader: genShaderSource(vertexShader),
            fragmentShader: genShaderSource(fragmentShader),
            transparent: true,
            alphaTest: 1.0,
            blending: NormalBlending,
            depthTest: opts.depthTest !== false, // 是否启用深度测试。深度测试用于确保只有离相机更近的物体才会被渲染
            depthWrite: false, // 是否将深度值写入深度缓冲区
            side: DoubleSide,
            defines: fire(GetSplatShaderDefines),
        });
        on(GetShaderMaterial, () => material);

        const isBigScene: boolean = fire(IsBigSceneMode);
        let dataTexture0: DataArrayTexture = null;
        let dataTexture1: DataArrayTexture = null;
        const isLodFileCache = isBigScene && !meta.useGpuCache;
        const [texwidth1, texheight1, texheightary1, texdepth1] = isLodFileCache ? [texwidth, texheight, texheightary, texdepth] : [16, 1, 1, 1];

        on(GetDataArrayTexture, () => {
            if (dataTexture0) return dataTexture0;
            const dataArray0 = new Uint32Array(texwidth * texheightary * texdepth * 4);
            dataTexture0 = new DataArrayTexture(dataArray0, texwidth, texheightary, texdepth);
            dataTexture0.format = RGBAIntegerFormat;
            dataTexture0.type = UnsignedIntType;
            // ------ 显式写避免版本差异，虽然可能就是默认值 ------
            dataTexture0.generateMipmaps = false;
            dataTexture0.minFilter = NearestFilter;
            dataTexture0.magFilter = NearestFilter;
            dataTexture0.flipY = false;
            // -------------------------------------------------
            dataTexture0.needsUpdate = true;
            material.uniforms[VarSplatTexture0].value = dataTexture0;
            return dataTexture0;
        });
        isBigScene && meta.useGpuCache && (splatCacheManager = new SplatGpuCache(events, texwidth, texheightary, texdepth, dataCount, fullCache));
        dataTexture0 = fire(GetDataArrayTexture);

        const dataArray1 = new Uint32Array(texwidth1 * texheight1 * 4);
        dataTexture1 = new DataArrayTexture(dataArray1, texwidth1, texheightary1, texdepth1);
        dataTexture1.format = RGBAIntegerFormat;
        dataTexture1.type = UnsignedIntType;
        dataTexture1.internalFormat = 'RGBA32UI';
        // ------ 显式写避免版本差异，虽然可能就是默认值 ------
        dataTexture1.generateMipmaps = false;
        dataTexture1.minFilter = NearestFilter;
        dataTexture1.magFilter = NearestFilter;
        dataTexture1.flipY = false;
        // -------------------------------------------------
        dataTexture1.needsUpdate = true;
        material.uniforms[VarSplatTexture1].value = dataTexture1;

        const shTexheight12 = await fire(GetShTexheight, 1, texwidth);
        const dataArraySh12 = new Uint32Array(4);
        let dataTextureSh12 = new DataTexture(dataArraySh12, 1, 1, RGBAIntegerFormat, UnsignedIntType);
        dataTextureSh12.internalFormat = 'RGBA32UI';
        dataTextureSh12.needsUpdate = true;
        material.uniforms[VarSplatShTexture12].value = dataTextureSh12;
        const dataArraySh3 = new Uint32Array(4);
        let dataTextureSh3 = new DataTexture(dataArraySh3, 1, 1, RGBAIntegerFormat, UnsignedIntType);
        dataTextureSh3.internalFormat = 'RGBA32UI';
        dataTextureSh3.needsUpdate = true;
        material.uniforms[VarSplatShTexture3].value = dataTextureSh3;

        const dataShPalettes = new Uint8Array(4);
        dataShPalettes.fill(128);
        let dataTextureShPalettes = new DataTexture(dataShPalettes, 1, 1, RGBAIntegerFormat, UnsignedByteType);
        dataTextureShPalettes.internalFormat = 'RGBA8UI';
        dataTextureShPalettes.needsUpdate = true;
        material.uniforms[VarShPalettes].value = dataTextureShPalettes;

        let isLastEmpty: boolean = false;
        let lastLayer = 0;
        on(SplatUpdateSglTexture, async (texture: SplatTexdata) => {
            if (disposed || !dataTexture0) return; // 已销毁，不再触碰纹理
            if (isLastEmpty && !texture.renderSplatCount) return; // 小场景，不要重复提交空数据
            isLastEmpty = !texture.renderSplatCount;

            const dataArray = texture.texdata;
            const dataTexture = dataTexture0;
            if (!dataArray || !dataTexture.image?.data) return;
            dataTexture.image.data.set(dataArray);

            const maxLayer = Math.min(Math.ceil((texture.visibleSplatCount * 32) / (texwidth * texheightary * 16)), texdepth);
            // 异步逐层上传：销毁/中止后立即停止，且不再触碰纹理
            const { aborted } = await pumpTextureLayers({
                texture: dataTexture,
                fromLayer: lastLayer,
                toLayer: maxLayer,
                delayMs: 10,
                isAborted: () => disposed,
                onAbort,
            });
            if (aborted || disposed) return;
            lastLayer = Math.max(lastLayer, maxLayer - 1);

            texture.textureReady = true;
            texture.textureReadyTime = Date.now();
            fire(NotifyWkA09SglTextureReady, texture);
            fire(OnTextureReadySplatCount, texture.renderSplatCount); // 用于判断小场景是否可以开始光圈过渡
            fire(NotifyViewerNeedUpdate);
        });

        on(SplatUpdateDblTexture, async (texture: SplatTexdata) => {
            if (disposed || !dataTexture0 || !dataTexture1) return; // 已销毁，不再触碰纹理
            const dataArray = texture.texdata;
            texture.texdata = null;
            if (!dataArray) return;
            const dataTexture = texture.index ? dataTexture1 : dataTexture0;
            if (!dataTexture.image?.data) return (fire(NotifyWkA01BackSplatBuffer, dataArray), void 0);
            dataTexture.image.data.set(dataArray);

            const maxLayer = Math.ceil((texture.renderSplatCount * 32) / (texwidth * texheightary * 16));
            // 异步逐层上传：销毁/中止后立即停止，且不再触碰纹理
            const { aborted } = await pumpTextureLayers({
                texture: dataTexture,
                fromLayer: 0,
                toLayer: maxLayer,
                delayMs: 1,
                isAborted: () => disposed,
                onAbort,
            });
            if (aborted || disposed) return;

            fire(NotifyWkA09DblTextureReady, texture);
            fire(NotifyWkA01BackSplatBuffer, dataArray);
        });

        let cacheDoing = false;
        on(SplatUploadTextureGpuCache, async (splatFile: SplatFile) => {
            if (disposed || !splatCacheManager) return;
            if (cacheDoing) return (await sleep(5)) && !disposed && fire(SplatUploadTextureGpuCache, splatFile);
            cacheDoing = true;

            await splatCacheManager.uploadSplatFile(splatFile);
            if (disposed) return; // 上传期间已销毁
            splatFile.textureReady = true;

            fire(NotifyViewerNeedUpdate);
            cacheDoing = false;
        });

        on(SplatUpdateSh12Texture, async (datas: Uint8Array[]) => {
            if (disposed || fire(IsBigSceneMode) || !datas || !datas.length) return;
            const dataArray = new Uint32Array(texwidth * (await fire(GetShTexheight, 1, texwidth)) * 4);
            if (disposed) return;
            const ui8s = new Uint8Array(dataArray.buffer);
            for (let i = 0, offset = 0; i < datas.length; i++) {
                ui8s.set(datas[i], offset);
                offset += datas[i].byteLength;
            }
            const dataTexture = new DataTexture(dataArray, texwidth, shTexheight12, RGBAIntegerFormat, UnsignedIntType);
            dataTexture.internalFormat = 'RGBA32UI';
            dataTexture.needsUpdate = true;
            material.uniforms[VarSplatShTexture12].value = dataTexture;
            dataTextureSh12?.dispose();
            dataTextureSh12 = dataTexture;
            fire(NotifyViewerNeedUpdate);
        });

        on(SplatUpdateSh3Texture, async (datas: Uint8Array[]) => {
            if (disposed || fire(IsBigSceneMode) || !datas || !datas.length) return;
            const dataArray = new Uint32Array(texwidth * (await fire(GetShTexheight, 3, texwidth)) * 4);
            if (disposed) return;
            const ui8s = new Uint8Array(dataArray.buffer);
            for (let i = 0, offset = 0; i < datas.length; i++) {
                ui8s.set(datas[i], offset);
                offset += datas[i].byteLength;
            }
            const dataTexture = new DataTexture(dataArray, texwidth, shTexheight12, RGBAIntegerFormat, UnsignedIntType);
            dataTexture.internalFormat = 'RGBA32UI';
            dataTexture.needsUpdate = true;
            material.uniforms[VarSplatShTexture3].value = dataTexture;
            dataTextureSh3?.dispose();
            dataTextureSh3 = dataTexture;
            fire(NotifyViewerNeedUpdate);
        });

        on(SplatUpdateShPalettesTexture, async (ui8s: Uint8Array) => {
            if (disposed || !ui8s || !ui8s.length) return;

            const height = 1024;
            const dataShPalettes = new Uint8Array(PalettesWidth * height * 4);
            dataShPalettes.fill(128);
            dataShPalettes.set(ui8s);
            const dataTexture = new DataTexture(dataShPalettes, PalettesWidth, height, RGBAIntegerFormat, UnsignedByteType);
            dataTextureShPalettes.internalFormat = 'RGBA8UI';
            dataTexture.onUpdate = () => fire(SplatUpdateShPalettesReady);
            dataTexture.needsUpdate = true;
            material.uniforms[VarShPalettes].value = dataTexture;
            dataTextureShPalettes?.dispose();
            dataTextureShPalettes = dataTexture;
            fire(NotifyViewerNeedUpdate);
        });

        on(GetSplatMaterial, () => material);

        on(
            SplatUpdateFocal,
            () => {
                const camera: PerspectiveCamera = fire(GetCamera);
                const { width, height } = fire(GetCanvasSize, true);
                const fx = Math.abs(camera.projectionMatrix.elements[0]) * 0.5 * width;
                const fy = Math.abs(camera.projectionMatrix.elements[5]) * 0.5 * height;
                const material: ShaderMaterial = fire(GetSplatMaterial);
                material.uniforms[VarFocal].value.set(fx, fy);
                material.uniformsNeedUpdate = true;
                fire(NotifyViewerNeedUpdate);
            },
            true,
        );
        on(
            SplatUpdateViewport,
            () => {
                const { width, height } = fire(GetCanvasSize, true);
                material.uniforms[VarViewport].value.set(width, height);
                material.uniformsNeedUpdate = true;
                fire(NotifyViewerNeedUpdate);
            },
            true,
        );
        on(SplatUpdateUsingIndex, (index: number) => {
            material.uniforms[VarUsingIndex].value = index;
            material.uniformsNeedUpdate = true;
            fire(NotifyViewerNeedUpdate);
        });
        on(SplatUpdateTransitionEffect, (value: number) => {
            material.uniforms[VarTransitionEffect].value = value;
            material.uniformsNeedUpdate = true;
            fire(NotifyViewerNeedUpdate);
        });
        on(SplatUpdatePointMode, (isPointcloudMode: boolean) => {
            const opts: SplatMeshOptions = fire(GetOptions);
            isPointcloudMode === undefined && (isPointcloudMode = !opts.pointcloudMode);
            material.uniforms[VarPointMode].value = isPointcloudMode;
            material.uniformsNeedUpdate = true;
            opts.pointcloudMode = isPointcloudMode;
            fire(NotifyViewerNeedUpdate);
            opts.viewerEvents && (opts.viewerEvents.fire(GetOptions).pointcloudMode = isPointcloudMode);
        });
        on(SplatUpdateBigSceneMode, (isBigSceneMode: boolean) => {
            material.uniforms[VarBigSceneMode].value = isBigSceneMode;
            material.uniformsNeedUpdate = true;
            const opts: SplatMeshOptions = fire(GetOptions);
            opts.bigSceneMode = isBigSceneMode;
            fire(NotifyViewerNeedUpdate);
        });
        on(SplatUpdateUseLod, (useLod: boolean) => {
            material.uniforms[VarUseLod].value = useLod;
            material.uniformsNeedUpdate = true;
            fire(NotifyViewerNeedUpdate);
        });
        on(SplatUpdateLightFactor, (value: number) => {
            material.uniforms[VarLightFactor].value = value;
            material.uniformsNeedUpdate = true;
            fire(NotifyViewerNeedUpdate);
        });

        let initTopY: boolean = false;
        on(SplatUpdateTopY, (value: number) => {
            if (fire(IsBigSceneMode) || initTopY) return;
            initTopY = true;
            material.uniforms[VarTopY].value = value;
            material.uniformsNeedUpdate = true;
            fire(NotifyViewerNeedUpdate);
        });
        on(SplatUpdateCurrentVisibleRadius, (value: number) => {
            material.uniforms[VarCurrentVisibleRadius].value = value;
            material.uniformsNeedUpdate = true;
            fire(NotifyViewerNeedUpdate);
        });
        on(SplatUpdateCurrentLightRadius, (value: number) => {
            material.uniforms[VarCurrentLightRadius].value = value;
            material.uniformsNeedUpdate = true;
            fire(NotifyViewerNeedUpdate);
        });
        on(SplatUpdateMaxRadius, (value: number) => {
            material.uniforms[VarMaxRadius].value = value;
            material.uniformsNeedUpdate = true;
            fire(NotifyViewerNeedUpdate);
        });
        on(SplatUpdateMarkPoint, (x: number, y: number, z: number, isMark: boolean) => {
            material.uniforms[VarMarkPoint].value = [x, y, z, isMark ? 1 : -1];
            material.uniformsNeedUpdate = true;
            fire(NotifyViewerNeedUpdate);
        });
        on(SplatUpdateShowWaterMark, (show: boolean = true) => {
            material.uniforms[VarShowWaterMark].value = show;
            material.uniformsNeedUpdate = true;
            fire(NotifyViewerNeedUpdate);
        });
        on(SplatUpdateShPalettesReady, (val: boolean = true) => {
            material.uniforms[VarShPalettesReady].value = val;
            material.uniformsNeedUpdate = true;
            fire(NotifyViewerNeedUpdate);
        });
        on(SplatUpdatePerformanceNow, (value: number) => {
            material.uniforms[VarPerformanceNow].value = value;
            material.uniformsNeedUpdate = true;
        });
        on(SplatUpdatePerformanceAct, (value: number) => {
            material.uniforms[VarPerformanceAct].value = value;
            material.uniformsNeedUpdate = true;
            fire(NotifyViewerNeedUpdate);
        });
        on(SplatUpdateMinMaxPixelDiameter, (minPix: number, maxPix: number) => {
            material.uniforms[VarMinPixelDiameter].value = minPix;
            material.uniforms[VarMaxPixelDiameter].value = maxPix;
            material.uniformsNeedUpdate = true;
            fire(NotifyViewerNeedUpdate);
        });
        on(SplatUpdateMinAlpha, (minAlpha: number) => {
            material.uniforms[VarMinAlpha].value = Math.min(Math.max(0, minAlpha), 255) / 255;
            material.uniformsNeedUpdate = true;
            fire(NotifyViewerNeedUpdate);
        });
        on(SplatUpdateUseSimilarExp, (useSimilarExp: boolean = false) => {
            material.uniforms[VarUseSimilarExp].value = useSimilarExp;
            material.uniformsNeedUpdate = true;
            fire(NotifyViewerNeedUpdate);
        });
        on(SplatUpdateParticleMode, (value: number) => {
            material.uniforms[VarParticleMode].value = value;
            material.uniformsNeedUpdate = true;
            fire(NotifyViewerNeedUpdate);
        });
        on(SplatUpdateDebugEffect, (value: boolean) => {
            material.uniforms[VarDebugEffect].value = value;
            material.uniformsNeedUpdate = true;
        });
        on(SplatUpdateShDegree, async (value: number, priority: ShDegreePriority = 1) => {
            if (disposed) return;
            // 异步夹取模型上限后可能乱序落盘，交给仲裁器保证最后一次显式写入生效，
            // 且档位显式生效后不再被加载期推断值覆盖
            await shArbiter.apply(value, priority, fire(GetModelShDegree), (degree: number, maxDegree: number) => {
                if (disposed) return;
                currentDisplayShDegree = degree;
                material.uniforms[VarShDegree].value = currentDisplayShDegree;
                material.uniformsNeedUpdate = true;
                fire(Information, { shDegree: `${currentDisplayShDegree} / max ${maxDegree}` });
                fire(NotifyViewerNeedUpdate);
            });
        });
        on(SplatUpdateFlagValue, (fvHide: number = 0, fvShow: number = 0) => {
            material.uniforms[VarFlagValue].value = (fvHide << 16) | fvShow;
            material.uniforms[VarPerformanceAct].value = performance.now();
            material.uniformsNeedUpdate = true;
            fire(NotifyViewerNeedUpdate);
        });
        on(SplatUpdateActiveFlagValue, (activeFlagValue: number = -1) => {
            if (activeFlagValue < 0) return material.uniforms[VarActiveFlagValue].value;
            material.uniforms[VarActiveFlagValue].value = activeFlagValue;
            material.uniforms[VarPerformanceAct].value = performance.now();
            material.uniformsNeedUpdate = true;
            fire(NotifyViewerNeedUpdate);
        });
        on(
            OnSmallSceneShowDone,
            () => {
                if (disposed) return;
                console.info('OnSmallSceneShowDone, clear image.data');
                dataTexture0 && (dataTexture0.image.data = null);
                dataTexture1 && (dataTexture1.image.data = null);
                dataTextureSh12 && (dataTextureSh12.image.data = null);
                dataTextureSh3 && (dataTextureSh3.image.data = null);
                dataTextureShPalettes && (dataTextureShPalettes.image.data = null);
            },
            true,
        );
        on(
            SplatMaterialDispose,
            () => {
                shArbiter.invalidate();
                material.dispose();
                splatCacheManager?.dispose();
                splatCacheManager = null;
                dataTexture0?.dispose();
                dataTexture1?.dispose();
                dataTextureSh12?.dispose();
                dataTextureSh3?.dispose();
                dataTextureShPalettes?.dispose();
            },
            true,
        );

        return material;
    });

    function genShaderSource(src: string) {
        shaderChunk['cmn'] = CmnFns.trim();
        shaderChunk['FvEffect'] = (shaderChunk['custom-FvEffect'] || FvEffect).trim();
        shaderChunk['WatermarkEffect'] = (shaderChunk['custom-WatermarkEffect'] || WatermarkEffect).trim();
        return '#include <cmn>\n#include <FvEffect>\n#include <WatermarkEffect>\n' + src;
    }

    on(CreateSplatMesh, async () => {
        maxRenderCount = await fire(GetMaxRenderCount);
        const mesh = new Mesh(await fire(CreateSplatGeometry), await fire(CreateSplatMaterial));
        fire(SplatUpdateFocal);
        fire(SplatUpdateViewport);
        fire(SplatUpdateBigSceneMode, fire(IsBigSceneMode));
        fire(SplatUpdatePointMode, fire(IsPointcloudMode));
        return mesh;
    });

    function resize() {
        setTimeout(() => {
            if (!disposed) {
                fire(SplatUpdateFocal);
                fire(SplatUpdateViewport);
            }
        });
    }
    window.addEventListener('resize', resize);

    on(SplatMeshDispose, () => {
        if (disposed) return;
        disposed = true;
        window.removeEventListener('resize', resize);
        // 终止一切过渡/切换流程，并清除已排队的延时任务与挂起的异步等待，销毁后不再安排新任务
        flow.dispose();
        clearPendingTimers();
        notifyAbort();
        fire(SplatGeometryDispose);
        fire(SplatMaterialDispose);
    });

    /** 按当前画质档位写入全部相关着色器参数（幂等，后写覆盖先写） */
    function applyQualityLevel() {
        if (disposed || !fire(IsSplatMeshCreated)) return;

        const opts: SplatMeshOptions = fire(GetOptions);
        if (!opts) return;
        const meta: MetaData = (fire(GetSplatMesh) as SplatMesh)?.meta || {};
        const level: number = opts.qualityLevel || QualityLevels.Default5;
        const maxShDegrees = [0, 1, 2, 3, 3, 3, 3, 3, 3];
        fire(SplatUpdateShDegree, maxShDegrees[level - 1], 1);
        if (isMobile) {
            const minPixs = [4, 3, 3, 2, 1, 1, 1, 1, 1];
            const maxPixs = [128, 128, 128, 256, 256, 256, 512, 512, 512];
            const minAlphas = [7, 6, 5, 4, 4, 3, 2, 2, 2];
            const minPix = meta.minPixelDiameter || minPixs[level - 1];
            const maxPix = meta.maxPixelDiameter || maxPixs[level - 1];
            fire(SplatUpdateMinMaxPixelDiameter, minPix, maxPix);
            fire(SplatUpdateMinAlpha, meta.minAlpha || minAlphas[level - 1]);
            fire(SplatUpdateUseSimilarExp, level < QualityLevels.L4);
        } else {
            const minPixs = [2, 2, 2, 1, 1, 1, 1, 1, 1];
            const maxPixs = [128, 256, 256, 512, 512, 1024, 1024, 1024, 1024];
            const minAlphas = [5, 4, 3, 2, 2, 1, 1, 1, 1];
            const minPix = meta.minPixelDiameter || minPixs[level - 1];
            const maxPix = meta.maxPixelDiameter || maxPixs[level - 1];
            fire(SplatUpdateMinMaxPixelDiameter, minPix, maxPix);
            fire(SplatUpdateMinAlpha, meta.minAlpha || minAlphas[level - 1]);
            fire(SplatUpdateUseSimilarExp, level < QualityLevels.L2);
        }
        fire(WorkerUpdateParams);
    }

    on(OnQualityLevelChanged, () => {
        if (disposed) return;
        // 材质尚未创建时无参数可写，等创建后再初始化（与原有行为一致）
        if (!fire(IsSplatMeshCreated)) return;
        // 档位变化：安全终止进行中的过渡并收敛，再以新档位参数为准
        flow.onQualityChanged();
    });

    // 小场景圆圈扩大渐进渲染（首帧过渡）
    on(SplatMeshCycleZoom, () => {
        if (disposed) return;
        const opts: SplatMeshOptions = fire(GetOptions);
        flow.runFirstFrameTransition({
            isBigSceneMode: !!fire(IsBigSceneMode), // 大场景模式不支持
            disableTransitionEffectOnLoad: !!opts.disableTransitionEffectOnLoad, // 关闭特效时直接进入稳定态
            maxRadius,
            currentMaxRadius,
        });
    });

    // 切换渲染模式（0:正常模式，1:点云模式），相互排挤，最后调用的优先响应
    on(SplatMeshSwitchDisplayMode, (showMark: boolean = false) => {
        if (disposed) return;
        const opts: SplatMeshOptions = fire(GetOptions);
        flow.switchDisplayMode({
            transitionEffect: opts.transitionEffect,
            showMark,
            maxRadius, // 大场景模式下不响应光圈过渡效果
            isBigSceneMode: !!fire(IsBigSceneMode),
        });
    });

    on(
        OnSmallSceneShowDone,
        (showMark: boolean = false) => {
            if (disposed || fire(IsBigSceneMode)) return;
            fire(SplatUpdateParticleMode, 0); // 若有，停止粒子加载效果
            showMark && fire(GetOptions).viewerEvents?.fire(MarkUpdateVisible);
            fire(GetOptions).viewerEvents?.fire(FlyOnce);
        },
        true,
    );

    on(CreateSplatUniforms, (texwidth: number, texheight: number = 0) => {
        return {
            [VarSplatTextureWidth]: { type: 'int', value: texwidth },
            [VarSplatTextureHeightAry]: { type: 'int', value: texheight },
            [VarSplatTexture0]: { type: 't', value: null },
            [VarSplatTexture1]: { type: 't', value: null },
            [VarSplatShTexture12]: { type: 't', value: null },
            [VarSplatShTexture3]: { type: 't', value: null },
            [VarShPalettes]: { type: 't', value: null },
            [VarShPalettesReady]: { type: 'bool', value: false },
            [VarFocal]: { type: 'v2', value: new Vector2() },
            [VarViewport]: { type: 'v2', value: new Vector2() },
            [VarUsingIndex]: { type: 'int', value: 0 },
            [VarTransitionEffect]: { type: 'int', value: 1 },
            [VarPointMode]: { type: 'bool', value: false },
            [VarDebugEffect]: { type: 'bool', value: true },
            [VarBigSceneMode]: { type: 'bool', value: false },
            [VarUseLod]: { type: 'bool', value: false },
            [VarShDegree]: { type: 'int', value: 0 },
            [VarLightFactor]: { type: 'float', value: 1 },
            [VarTopY]: { type: 'float', value: 0 },
            [VarCurrentVisibleRadius]: { type: 'float', value: 0 },
            [VarCurrentLightRadius]: { type: 'float', value: 0 },
            [VarMaxRadius]: { type: 'float', value: 0 },
            [VarMarkPoint]: { type: 'v4', value: new Vector4(0, 0, 0, -1) },
            [VarParticleMode]: { type: 'int', value: 0 },
            [VarPerformanceNow]: { type: 'float', value: performance.now() },
            [VarPerformanceAct]: { type: 'float', value: 0 },
            [VarMinPixelDiameter]: { type: 'float', value: 1.0 },
            [VarMaxPixelDiameter]: { type: 'float', value: 1024.0 },
            [VarMinAlpha]: { type: 'float', value: 2 / 255 },
            [VarWaterMarkColor]: { type: 'v4', value: new Vector4(1, 1, 0, 0.5) },
            [VarShowWaterMark]: { type: 'bool', value: false },
            [VarUseSimilarExp]: { type: 'bool', value: true },
            [VarFlagValue]: { type: 'uint', value: 1 },
            [VarActiveFlagValue]: { type: 'uint', value: 0 },
        };
    });

    const sortWorker: Worker = fire(GetSortWorker);
    sortWorker.onmessage = e => {
        const data: any = e.data;
        if (data[WkA90DepthIndex]) {
            bucketBits = data[WkBucketBits];
            sortType = data[WkSortType];
            const ui32s: Uint32Array = data[WkDepthIndex];
            fire(SplatUpdateSplatIndex, ui32s, data[WkIndex], data[WkSortTime], data[WkSortStartTime], data[WkRenderSplatCount]);
            ui32s.length && sortWorker.postMessage({ [WkA09BackDepthIndex]: true, [WkDepthIndex]: ui32s }, [ui32s.buffer]);
        } else if (data[WkA90BackXyz]) {
            fire(NotifyWkA01BackXyz, new Float32Array(data[WkXyz].buffer));
        } else if (data[WkA90BackXyzIndex]) {
            fire(NotifyWkA01BackXyzIndex, new Uint32Array(data[WkXyzIndex].buffer));
        }
    };

    on(UploadSplatTexture, (texture: SplatTexdata, dataCurrentRadius: number, dataMaxRadius: number) => {
        if (!fire(IsBigSceneMode)) {
            currentMaxRadius = dataCurrentRadius;
            maxRadius = dataMaxRadius;
        }
        fire(SplatUpdateSglTexture, texture);
    });
}
