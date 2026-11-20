// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================
import { Vector3 } from 'three';
import {
    OnFetchStart,
    SplatDataManagerAddModel,
    GetMaxRenderCount,
    SplatMeshCycleZoom,
    SplatTexdataManagerDataChanged,
    OnFetching,
    OnFetchStop,
    Information,
    IsBigSceneMode,
    SetGaussianText,
    GetGaussianText,
    RunLoopByFrame,
    UploadSplatTexture,
    SplatUpdateTopY,
    GetSplatActivePoints,
    GetOptions,
    StopAutoRotate,
    GetShTexheight,
    SplatUpdateSh12Texture,
    SplatUpdateSh3Texture,
    SplatUpdateShDegree,
    GetAabbCenter,
    SplatUpdateBoundBox,
    SplatUpdateMaxRadius,
    SplatUpdatePerformanceAct,
    SplatUpdatePointMode,
    OnSmallSceneShowDone,
    SplatUpdateParticleMode,
    SplatUpdateShPalettesTexture,
    ComputeTextureWidthHeight,
    GetMeta,
    GetSplatTiles,
    TriggerLoadSmallSceneData,
    SetTexdataChangeLastTime,
    GetLodActiveXyz,
    SplatDataManagerDispose,
    GetModelShDegree,
    GetLodModelShDegree,
    OnLoadAndRenderPointCloudPly,
    ResetLoadedModel,
} from '../events/EventConstants';
import { Events } from '../events/Events';
import { ModelStatus, SplatModel } from './ModelData';
import { ModelOptions } from './ModelOptions';
import { loadPly } from './loaders/PlyLoader';
import { loadSplat } from './loaders/SplatLoader';
import { loadSpx } from './loaders/SpxLoader';
import { loadSpz } from './loaders/SpzLoader';
import { computeCompressionRatio, glbKhrGs2Splat, isInverted, isNeedReload } from '../utils/CommonUtils';
import { SplatMeshOptions } from '../meshs/splatmesh/SplatMeshOptions';
import { isMobile, MobileDownloadLimitSplatCount, PcDownloadLimitSplatCount } from '../utils/GlobalConstants';
import { loadSog } from './loaders/SogLoader';
import { SplatFile } from './SplatTiles';
import { MetaData } from './MetaData';
import { globalEv } from '../events/GlobalEV';
import { loadFile } from './loaders/FileLoader';
import { DefaultLodMaxRenderCount, DefaultMaxTextWatermarkCount } from '../utils/DefaultValues';
import { clearSplatWasmMemory } from './wasm/WasmParser';

const BlankingTimeOfSmallScene = isMobile ? 100 : 50;

export function setupDataManager(events: Events) {
    const on = (key: number, fn?: Function, multiFn?: boolean): Function | Function[] => events.on(key, fn, multiFn);
    const fire = (key: number, ...args: any): any => events.fire(key, ...args);

    let disposed: boolean;
    let texdataChangeLastTime: number = Date.now() * 2;

    let fnResolveModelSplatCount: (value: unknown) => void;
    let promiseModelSplatCount: Promise<number> = new Promise(resolve => (fnResolveModelSplatCount = resolve));

    let textWatermarkData: Uint8Array = null; // 水印数据
    let splatModel: SplatModel;
    let texture0: SplatTexdata = { index: 0, version: 0, activeTime: 0 };
    let mergeRunning: boolean = false;
    let initBoundBox: boolean = false;
    let performanceStart = 0; // 小场景粒子加载效果使用
    let palettesUpdated = false;
    let smallSceneActivePoints: any = null; // Object
    let dataShDegree = 0;
    let triggerOnce = false;

    on(GetAabbCenter, () => splatModel?.aabbCenter || new Vector3());

    /**
     * 丢弃当前模型与所有加载中状态，使查看器可以接受下一次加载。
     * 与 dispose 不同，这只是“忘记”当前模型：中断下载、清空统计/水印/包围盒状态，但不销毁渲染器。
     */
    function reset() {
        splatModel?.cancel();
        splatModel = null;
        textWatermarkData = null;
        texture0 = { index: 0, version: 0, activeTime: 0 };
        mergeRunning = false;
        initBoundBox = false;
        performanceStart = 0;
        palettesUpdated = false;
        smallSceneActivePoints = null;
        dataShDegree = 0;
        triggerOnce = false;
        _maxRenderCount = 0;
        // 释放等待模型点数的旧等待者，再换新的未决 promise，避免旧的异步流程悬挂
        fnResolveModelSplatCount?.(0);
        promiseModelSplatCount = new Promise(resolve => (fnResolveModelSplatCount = resolve));
        globalEv.off('Information-ver');
        globalEv.off('Information-ratio');
        globalEv.off('Information-size');
    }

    on(
        OnSmallSceneShowDone,
        () => {
            texture0 = null;
            splatModel = null;
            clearSplatWasmMemory();
        },
        true,
    );

    let _maxRenderCount = 0;
    on(GetMaxRenderCount, async (): Promise<number> => {
        if (_maxRenderCount) return _maxRenderCount;

        if (fire(IsBigSceneMode)) {
            // 大场景有默认限制
            await fire(GetSplatTiles);
            const meta: MetaData = fire(GetMeta);
            const cnt = (isMobile ? meta.maxRenderCountOfMobile : meta.maxRenderCountOfPc) || DefaultLodMaxRenderCount;
            _maxRenderCount = cnt + DefaultMaxTextWatermarkCount;
        } else {
            // 小场景默认不限制（需自行注意控制）
            const modelCnt = await promiseModelSplatCount;
            const meta: MetaData = fire(GetMeta);
            const cnt = (isMobile ? meta.maxRenderCountOfMobile : meta.maxRenderCountOfPc) || 0;
            _maxRenderCount = (cnt ? Math.min(modelCnt, cnt) : modelCnt) + DefaultMaxTextWatermarkCount;
        }

        return _maxRenderCount;
    });

    on(TriggerLoadSmallSceneData, () => {
        if (triggerOnce) return;
        triggerOnce = true;
        fire(
            RunLoopByFrame,
            async () => await mergeAndUploadData(),
            () => !disposed && !splatModel?.smallSceneUploadDone,
            10,
        );
    });

    on(GetShTexheight, async (shDegree: number, texwidth: number): Promise<number> => {
        const opts: SplatMeshOptions = fire(GetOptions);
        if (opts.bigSceneMode) return 1; // 大场景不支持

        let cnt = await fire(GetMaxRenderCount);

        if (!splatModel?.dataShDegree) return 1; // splat
        if (shDegree >= 3) {
            if (splatModel.dataShDegree < 3) return 1; // 无SH3数据
        } else if (shDegree >= 1) {
            if (splatModel.dataShDegree < 1) return 1; // 无SH12数据
        } else {
            return 1;
        }

        const texheight = Math.ceil(cnt / texwidth);
        return texheight;
    });

    on(GetModelShDegree, async (): Promise<number> => {
        if (fire(IsBigSceneMode)) {
            return fire(GetLodModelShDegree);
        } else {
            await promiseModelSplatCount;
            return splatModel?.dataShDegree || dataShDegree;
        }
    });

    on(SetGaussianText, async (text: string, isY: boolean = true) => {
        try {
            const model = splatModel;
            const isNgativeY = isInverted(model?.header); // 是否倒立（superedit打开呈现倒立）
            const data = await fire(GetGaussianText, text, isY, isNgativeY, model?.opts?.format);
            // 文字水印生成是异步的：期间模型可能已被新的加载会话替换，迟到的结果必须丢弃
            if (model !== splatModel || model?.isCancelled()) return;
            textWatermarkData = data;
            model && (model.textWatermarkVersion = Date.now());
        } catch (e) {
            console.info('failed to generate watermark');
        }
    });

    on(GetSplatActivePoints, () => {
        // 大场景按动态计算
        if (fire(IsBigSceneMode)) {
            return fire(GetLodActiveXyz);
        }

        // 小场景下载完成后按分块
        if (smallSceneActivePoints) return smallSceneActivePoints;
        if (!texture0?.xyz) return null; // 尚无数据

        if (splatModel?.status === ModelStatus.FetchDone || splatModel?.status === ModelStatus.FetchAborted) {
            const obj = {};
            const xyzs: Float32Array = texture0.xyz;
            for (let i = 0, count = xyzs.length / 3, x = 0, y = 0, z = 0, key = ''; i < count; i++) {
                x = xyzs[i * 3];
                y = xyzs[i * 3 + 1];
                z = xyzs[i * 3 + 2];
                key = `${Math.floor(x / 2) * 2 + 1},${Math.floor(y / 2) * 2 + 1},${Math.floor(z / 2) * 2 + 1}`;
                (obj[key] = obj[key] || []).push(x, y, z);
            }
            return (smallSceneActivePoints = obj);
        }

        // 小场景没下载完，不分块
        return texture0.xyz;
    });

    async function mergeAndUploadData() {
        if (disposed) return;

        const model = splatModel;
        if (model?.isCancelled()) return; // 会话已作废，不再回写任何状态

        if (model && (model.status === ModelStatus.Invalid || model.status === ModelStatus.FetchFailed)) {
            (fire(GetOptions) as SplatMeshOptions).viewerEvents?.fire(StopAutoRotate);
            return fire(OnFetchStop, 0) || fire(Information, { renderSplatCount: 0, visibleSplatCount: 0, modelSplatCount: 0 }); // 无效
        }
        if (!model || !model.downloadSize) return; // 尚未下载

        const downloadDone = model.status === ModelStatus.FetchDone || model.status === ModelStatus.FetchAborted;
        updateBoundBox(model, downloadDone);
        if (downloadDone) {
            // 已下载完，通知一次进度条
            const downloadCount = Math.min(model.fetchLimit, model.downloadSplatCount);
            downloadCount && !model.notifyFetchStopDone && (model.notifyFetchStopDone = true) && fire(OnFetchStop, downloadCount);
            setTimeout(() => model === splatModel && !model.isCancelled() && !textWatermarkData && fire(SetGaussianText, model.meta?.watermark));
        } else {
            // 没下载完，更新下载进度条
            fire(OnFetching, (100 * model.downloadSize) / model.fileSize);
        }

        if (!model.dataSplatCount) return; // 尚无高斯数据

        // 调色板
        if (!palettesUpdated && model.palettes) {
            fire(SplatUpdateShPalettesTexture, model.palettes);
            palettesUpdated = true;
        }

        if (mergeRunning) return;
        mergeRunning = true;
        setTimeout(async () => {
            await mergeAndUploadSmallSceneData(model, downloadDone);
            mergeRunning = false;
        });
    }

    async function mergeAndUploadSmallSceneData(model: SplatModel, downloadDone: boolean) {
        if (disposed) return;

        const texture = texture0;
        const maxRenderCount = await fire(GetMaxRenderCount);

        // 等待期间模型可能已被新的加载会话替换或取消，此时不得写入任何状态
        if (model !== splatModel || model.isCancelled() || !texture) return;

        const txtWatermarkData = textWatermarkData;
        let dataSplatCount = model.dataSplatCount;
        let watermarkCount = downloadDone ? model.watermarkCount : 0;
        let textWatermarkCount = model.meta.showWatermark && downloadDone ? (txtWatermarkData?.byteLength || 0) / 32 : 0; // 动态输入的文字水印数
        model.renderSplatCount = dataSplatCount + watermarkCount + textWatermarkCount; // 渲染数

        if (model.renderSplatCount >= maxRenderCount) {
            // 中断下载等特殊情况
            model.renderSplatCount = maxRenderCount;
            watermarkCount = 0;
            textWatermarkCount = 0;
            dataSplatCount > maxRenderCount && (dataSplatCount = maxRenderCount);
        }

        fire(Information, { visibleSplatCount: model.renderSplatCount, modelSplatCount: model.modelSplatCount + textWatermarkCount }); // 可见数=模型数据总点数

        if (Date.now() - texture.textureReadyTime < BlankingTimeOfSmallScene) return;
        if (model.smallSceneUploadDone && model.lastTextWatermarkVersion == model.textWatermarkVersion) return; // 已传完(模型数据 + 动态文字水印)

        if (!texture.version) {
            fire(SplatUpdateTopY, (isInverted(model.header) ? model.header.MaxTopY : model.header?.MinTopY) || 0); // 初次传入高点

            let ver: string = model.opts.format;
            let ratio = '　';
            if (model.opts.format == 'spx') {
                ver = 'spx v' + model.header.Version + (model.header.ExclusiveId ? (', ' + model.header.ExclusiveId).substring(0, 5) : '');
                ratio += model.CompressionRatio;
            } else if (model.opts.format == 'spz') {
                ver = 'spz v' + model.spzVersion;
                ratio += model.CompressionRatio;
            } else if (model.opts.format == 'sog') {
                ver = 'sog v' + model.sogVersion;
                ratio += model.CompressionRatio;
            } else if (model.opts.format == 'splat') {
                ratio += model.CompressionRatio;
            }

            ver = globalEv.tryFire('Information-ver') || ver;
            ratio = globalEv.tryFire('Information-ratio') || ratio;
            const size = globalEv.tryFire('Information-size') || '　' + (model.fileSize / 1024 / 1024).toFixed(1) + 'M';
            fire(Information, { scene: `small (${ver}) ${ratio}${size}` }); // 初次提示场景模型版本
            globalEv.off('Information-ver');
            globalEv.off('Information-ratio');
            globalEv.off('Information-size');
        }

        model.lastTextWatermarkVersion = model.textWatermarkVersion;
        texture.textureReady = false;

        // 合并（模型数据 + 动态文字水印）
        const { texwidth, texheight } = fire(ComputeTextureWidthHeight, maxRenderCount);
        const ui32s = texture.texdata || new Uint32Array(texwidth * texheight * 4);
        const f32s = new Float32Array(ui32s.buffer);
        const mergeSplatData = new Uint8Array(ui32s.buffer);
        mergeSplatData.set(model.splatData.subarray(0, dataSplatCount * 32), 0);
        watermarkCount && mergeSplatData.set(model.watermarkData.subarray(0, watermarkCount * 32), dataSplatCount * 32);
        textWatermarkCount && mergeSplatData.set(txtWatermarkData.subarray(0, textWatermarkCount * 32), (dataSplatCount + watermarkCount) * 32);

        const xyz = new Float32Array(maxRenderCount * 3);
        for (let i = 0, n = 0; i < model.renderSplatCount; i++) {
            xyz[i * 3] = f32s[i * 8];
            xyz[i * 3 + 1] = f32s[i * 8 + 1];
            xyz[i * 3 + 2] = f32s[i * 8 + 2];
        }

        if (model !== splatModel || model.isCancelled()) return;

        const sysTime = Date.now();
        texture.version = sysTime;
        texture.texdata = ui32s;
        texture.xyz = xyz;
        texture.renderSplatCount = model.renderSplatCount;
        texture.visibleSplatCount = model.downloadSplatCount + textWatermarkCount;
        texture.modelSplatCount = model.downloadSplatCount + textWatermarkCount;
        texture.watermarkCount = watermarkCount + textWatermarkCount;
        texture.minX = model.minX;
        texture.maxX = model.maxX;
        texture.minY = model.minY;
        texture.maxY = model.maxY;
        texture.minZ = model.minZ;
        texture.maxZ = model.maxZ;

        if (model.meta.particleMode && !performanceStart) {
            performanceStart = performance.now();
            fire(SplatUpdatePerformanceAct, performanceStart);
            fire(SplatUpdatePointMode, false); // 小场景粒子效果时，固定不用点云
            fire(SplatUpdateParticleMode, 1); // 粒子加载效果
        }
        model.maxRadius && fire(SplatUpdateMaxRadius, model.maxRadius);
        fire(UploadSplatTexture, texture, model.currentRadius, model.currentRadius);
        fire(SetTexdataChangeLastTime, sysTime);

        if (downloadDone && !model.smallSceneUploadDone) {
            model.smallSceneUploadDone = true;
            !palettesUpdated && fire(SplatUpdateSh12Texture, model.sh12Data);
            !palettesUpdated && fire(SplatUpdateSh3Texture, model.sh3Data);
            const opts: SplatMeshOptions = fire(GetOptions);
            dataShDegree = model.dataShDegree;
            fire(SplatUpdateShDegree, opts.shDegree === undefined ? 3 : opts.shDegree);
            Promise.resolve().then(() => {
                if (model !== splatModel || model.isCancelled()) return;
                fire(GetSplatActivePoints); // 小场景下载完时主动触发一次坐标分块
                opts.disableTransitionEffectOnLoad && setTimeout(() => model === splatModel && !model.isCancelled() && fire(OnSmallSceneShowDone), 6000); // 禁止特效时延后触发显示完成后期处理
            });

            if (model.meta.particleMode) {
                // 粒子效果，先5秒加载过程，后5秒正常化过程
                setTimeout(
                    () => {
                        if (model !== splatModel || model.isCancelled()) return;
                        fire(SplatUpdatePerformanceAct, performance.now() + 5000); // 后5秒正常化过程
                        fire(SplatUpdateParticleMode, 2); // 逐渐变化到正常
                        setTimeout(() => !disposed && model === splatModel && !model.isCancelled() && fire(OnSmallSceneShowDone, true), 6000); // 显示完成后期处理
                    },
                    Math.max(5000 + performanceStart - performance.now(), 0), // 先5秒加载过程
                );
            }
        }
        fire(Information, { renderSplatCount: model.renderSplatCount });
    }

    async function addModel(opts: ModelOptions, meta: MetaData) {
        if (disposed) return;
        if (opts.session && !opts.session.isActive()) return; // 会话已作废，不再开始新的加载
        opts.fetchReload = isNeedReload(meta.updateDate || 0); // 7天内更新的重新下载

        const orgUrl = opts.url;
        if (opts.format === 'glb') {
            const fileBytes: Uint8Array = await loadFile(opts.url, events, opts.session);
            if (!fileBytes || (opts.session && !opts.session.isActive())) return;
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
                opts.url = opts.session ? opts.session.trackBlob(new Blob([spzBytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' })) : URL.createObjectURL(new Blob([spzBytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
                opts.format = 'spz';

                globalEv.on('Information-ver', () => `glb-spz`);
            } else if (/KHR_gaussian_splatting/.test(sJson)) {
                const splatBytes = glbKhrGs2Splat(fileBytes);
                opts.url = opts.session ? opts.session.trackBlob(new Blob([splatBytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' })) : URL.createObjectURL(new Blob([splatBytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
                opts.format = 'splat';

                const ratio = '　' + computeCompressionRatio(splatBytes.byteLength / 32, fileBytes.byteLength);
                const size = '　' + (fileBytes.byteLength / 1024 / 1024).toFixed(1) + 'M';
                globalEv.on('Information-ver', () => `glb-gs`);
                globalEv.on('Information-ratio', () => ratio);
                globalEv.on('Information-size', () => size);
            } else {
                console.warn('SplatMesh only loads GLB models with the KHR_gaussian_splatting extension.');
            }
        }

        splatModel = new SplatModel(opts, meta);

        // 下载限制（小场景默认1亿点，约等同无限制，需注意按需配置）
        splatModel.fetchLimit = (isMobile ? meta.maxRenderCountOfMobile : meta.maxRenderCountOfPc) || 10000_0000;

        const model = splatModel;
        const fnCheckModelSplatCount = () => {
            if (disposed || model !== splatModel || model.isCancelled()) {
                return fnResolveModelSplatCount(0);
            }
            // 除非下载失败，否则总是等待继续下载，直到得知模型文件的点数为止
            if (model.status == ModelStatus.Invalid || model.status == ModelStatus.FetchFailed) {
                return fnResolveModelSplatCount(0);
            }
            if (model.modelSplatCount > 0) {
                fnResolveModelSplatCount(model.modelSplatCount);
                if (!model.meta.particleMode && model.dataSplatCount) {
                    setTimeout(() => !disposed && model === splatModel && !model.isCancelled() && fire(SplatMeshCycleZoom), 5);
                } else {
                    setTimeout(fnCheckModelSplatCount, 10); // 没数据可以渲染，继续做以便触发过渡效果
                }
            } else {
                setTimeout(fnCheckModelSplatCount, 10);
            }
        };
        fnCheckModelSplatCount();

        if (!loadSplatModel(model)) {
            console.error('Unsupported format:', opts.format);
            fire(OnFetchStop, 0);
            return;
        }
        if (opts.format === 'glb') {
            opts.session ? opts.session.releaseObjectUrl(opts.url) : URL.revokeObjectURL(opts.url);
            opts.url = orgUrl;
        }
        fire(TriggerLoadSmallSceneData);
        fire(OnFetchStart);
        fire(Information, { cuts: `` });
    }

    function loadSplatModel(model: SplatModel) {
        if (model.opts.format === 'spx') {
            loadSpx(model);
        } else if (model.opts.format === 'splat') {
            loadSplat(model);
        } else if (model.opts.format === 'ply') {
            loadPly(model).then(() => {
                if (model !== splatModel || model.isCancelled()) return;
                if (model.isPointCloudPly) {
                    (fire(GetOptions) as SplatMeshOptions).viewerEvents?.fire(OnLoadAndRenderPointCloudPly, model.opts.url);
                }
            });
        } else if (model.opts.format === 'spz') {
            loadSpz(model);
        } else if (model.opts.format === 'sog') {
            loadSog(model);
        } else {
            return false;
        }
        return true;
    }

    function updateBoundBox(model: SplatModel, downloadDone: boolean) {
        // 包围盒
        if (!initBoundBox) {
            if (model.header) {
                initBoundBox = true;
                const min = new Vector3(model.header.MinX, model.header.MinY, model.header.MinZ);
                const max = new Vector3(model.header.MaxX, model.header.MaxY, model.header.MaxZ);
                fire(SplatUpdateBoundBox, min.x, min.y, min.z, max.x, max.y, max.z, model.meta.showBoundBox);
            } else if (downloadDone) {
                initBoundBox = true;
                const min = new Vector3(model.minX, model.minY, model.minZ);
                const max = new Vector3(model.maxX, model.maxY, model.maxZ);
                fire(SplatUpdateBoundBox, min.x, min.y, min.z, max.x, max.y, max.z, model.meta.showBoundBox);
            }
        }
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        splatModel?.cancel();
        splatModel = null;
        textWatermarkData = null;
        texture0 = null;
    }

    on(SplatDataManagerAddModel, (opts: ModelOptions, meta: MetaData) => addModel(opts, meta));
    on(ResetLoadedModel, () => reset(), true);

    on(SetTexdataChangeLastTime, (last: number) => (texdataChangeLastTime = last));
    on(SplatTexdataManagerDataChanged, (msDuring: number = 10000) => Date.now() - texdataChangeLastTime < msDuring);
    on(SplatDataManagerDispose, () => dispose());
}
