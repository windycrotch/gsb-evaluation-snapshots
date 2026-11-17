// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================
/**
 * 本地文件拖入链路的纯工具函数（不依赖 DOM/three，便于 Node 下直接验证）
 *
 * 设计要点：
 * 1. 拖拽入口先按扩展名判断格式，再决定调用 addModel 还是 addScene；
 * 2. 扩展名比较统一转小写，避免大写后缀被误判为未知格式；
 * 3. PLY 需要读取文件头，点云 PLY 走点云渲染，否则走高斯渲染；
 * 4. GLB 需识别 KHR_gaussian_splatting 与 spz 压缩扩展。
 */
import type { ModelOptions } from '../modeldata/ModelOptions';

/** 支持的本地模型格式 */
export type LocalModelFormat = NonNullable<ModelOptions['format']>;

/** 拖入文件的判定结果 */
export interface LocalFileKind {
    /** 处理方式：模型走 addModel，场景走 addScene，不支持则为 unsupported */
    type: 'model' | 'scene' | 'unsupported';
    /** type=model 时的模型格式 */
    format?: LocalModelFormat;
    /** type=unsupported 时的明确错误信息 */
    error?: string;
}

const SCENE_JSON_SUFFIX = '.scene.json';
const META_JSON_SUFFIX = '.meta.json';

/**
 * 按扩展名判断拖入文件的类型（比较前统一转小写）
 * @param fileName 文件名
 */
export function detectLocalFileKind(fileName: string): LocalFileKind {
    const name = (fileName || '').toLowerCase();
    if (!name) return { type: 'unsupported', error: 'Empty file name' };

    if (name.endsWith(SCENE_JSON_SUFFIX)) {
        return { type: 'scene' };
    }
    if (name.endsWith('.spx')) {
        return { type: 'model', format: 'spx' };
    }
    if (name.endsWith('.splat')) {
        return { type: 'model', format: 'splat' };
    }
    if (name.endsWith('.ply')) {
        return { type: 'model', format: 'ply' };
    }
    if (name.endsWith('.spz')) {
        return { type: 'model', format: 'spz' };
    }
    if (name.endsWith('.sog') || name.endsWith('.zip')) {
        return { type: 'model', format: 'sog' };
    }
    if (name.endsWith('.glb')) {
        return { type: 'model', format: 'glb' };
    }
    // 本地 .meta.json 必须依赖同名模型文件，单独拖入无法定位模型，按不支持处理并给出明确提示
    if (name.endsWith(META_JSON_SUFFIX)) {
        return { type: 'unsupported', error: `Unsupported format: "${fileName}". A .meta.json file must be loaded together with its model file.` };
    }
    return { type: 'unsupported', error: `Unsupported format: "${fileName}". Supported: .spx, .splat, .ply, .spz, .sog/.zip, .glb, .scene.json` };
}

/**
 * 按 URL（去掉查询参数后）的扩展名推断模型格式。
 *
 * 注意：blob: 地址没有可识别扩展名，调用方必须在生成 blob: 地址前
 * 就通过原始文件名确定 format，本函数对 blob: 地址不会误报“未知格式”，
 * 而是返回 undefined 交由调用方处理。
 *
 * @param url 模型地址
 * @returns 模型格式；无法识别时返回 undefined
 */
export function inferModelFormatFromUrl(url: string): LocalModelFormat | undefined {
    if (!url || url.startsWith('blob:')) return undefined;

    const urlFile = url.split('?')[0].toLowerCase();
    if (urlFile.endsWith('.spx')) return 'spx';
    if (urlFile.endsWith('.splat')) return 'splat';
    if (urlFile.endsWith('.ply')) return 'ply';
    if (urlFile.endsWith('.spz')) return 'spz';
    if (urlFile.endsWith('.zip') || urlFile.endsWith('.sog') || urlFile.endsWith('/meta.json') || urlFile === 'meta.json') return 'sog';
    if (urlFile.endsWith('.obj')) return 'obj';
    if (urlFile.endsWith('.glb')) return 'glb';
    return undefined;
}

const PLY_HEADER_SCAN_LIMIT = 2048;

/**
 * 从 PLY 文件字节中读取 ASCII 文件头（不含 end_header 行本身）。
 *
 * 兼容 \n 与 \r\n 两种换行；若在扫描上限内找不到 end_header 则抛错，
 * 与 PlyLoader 的行为保持一致。
 *
 * @param fileBytes PLY 文件字节
 * @returns 规范化为 \n 换行的文件头字符串
 */
export function readPlyHeader(fileBytes: Uint8Array): string {
    const scanLen = Math.min(fileBytes.byteLength, PLY_HEADER_SCAN_LIMIT);
    const rawHeader = new TextDecoder().decode(fileBytes.subarray(0, scanLen));
    // 兼容 LF 与 CRLF：先找 end_header 标记位置，再统一换行为 \n
    const lfIndex = rawHeader.indexOf('end_header\n');
    const crlfIndex = rawHeader.indexOf('end_header\r\n');
    const endIndex = lfIndex >= 0 ? lfIndex : crlfIndex;
    if (endIndex < 0) {
        if (fileBytes.byteLength > PLY_HEADER_SCAN_LIMIT) {
            throw new Error('Unable to read .ply file header');
        }
        throw new Error('Invalid .ply file: end_header not found');
    }
    // 统一换行，兼容 CRLF 文件
    return rawHeader.substring(0, endIndex).replace(/\r\n/g, '\n');
}

/**
 * 判断 PLY 文件头是否为点云 PLY。
 *
 * 判定规则与 PlyLoader.parseHeader 保持一致：同时具备
 * red/green/blue 属性即视为点云 PLY（3DGS 高斯 PLY 使用 f_dc_* 表达颜色）。
 *
 * @param header readPlyHeader 返回的文件头
 */
export function isPointCloudPlyHeader(header: string): boolean {
    const propNames = new Set<string>();
    for (const line of header.split('\n')) {
        if (!line.startsWith('property ')) continue;
        const parts = line.split(' ');
        // property <type> <name> 或 property list ...，属性名在最后一段
        propNames.add(parts[parts.length - 1]);
    }
    return propNames.has('red') && propNames.has('green') && propNames.has('blue');
}

/** GLB 内嵌扩展识别结果 */
export type GlbExtensionKind = 'spz' | 'gaussian' | 'gobox-webp-ply' | 'standard';

/**
 * 读取 GLB 的 JSON chunk 并识别高斯相关扩展：
 * - KHR_gaussian_splatting_compression_spz_2：内嵌 spz 压缩数据
 * - KHR_gaussian_splatting：标准高斯扩展（无压缩）
 * - com_github_gotoeasy_gsbox_webp_rgb_ply：webp 压缩的 RGB 点云 PLY
 * - 其它：普通 GLB（走 three GLTFLoader 网格渲染）
 *
 * @param fileBytes GLB 文件字节
 */
export function detectGlbExtension(fileBytes: Uint8Array): { kind: GlbExtensionKind; json: any; jsonLength4: number } {
    // GLB 布局：12 字节文件头 + JSON chunk（8 字节 chunk 头 + 数据）+ BIN chunk
    // JSON chunk 长度是位于整体字节偏移 12 的 little-endian uint32。
    // 使用 DataView 显式按字节偏移读取，避免 Uint8Array 的 buffer 带 byteOffset 时取错 word
    const dv = new DataView(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength);
    const jsonLength4 = dv.getUint32(12, true);
    // GLB 用 0x20 空格填充，trim 后再解析，避免尾部填充导致 JSON.parse 报错
    const sJson = new TextDecoder().decode(fileBytes.subarray(20, 20 + jsonLength4)).trim();
    const json = JSON.parse(sJson);

    let kind: GlbExtensionKind = 'standard';
    if (json.extensionsUsed?.includes('KHR_gaussian_splatting_compression_spz_2') || /KHR_gaussian_splatting_compression_spz_2/.test(sJson)) {
        kind = 'spz';
    } else if (json.extensionsUsed?.includes('KHR_gaussian_splatting') || /KHR_gaussian_splatting/.test(sJson)) {
        kind = 'gaussian';
    } else if (/com_github_gotoeasy_gsbox_webp_rgb_ply/.test(sJson)) {
        kind = 'gobox-webp-ply';
    }
    return { kind, json, jsonLength4 };
}

/**
 * 在页面上展示一次性的提示信息（错误/警告等），3 秒后自动消失。
 * 复用 .speed-container/.speed-text 样式容器，不存在时自动创建。
 */
export function showLocalFileToast(message: string): void {
    if (typeof document === 'undefined') return;
    let div: HTMLDivElement = document.querySelector('.speed-container .speed-text');
    let container: HTMLDivElement = document.querySelector('.speed-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'speed-container';
        div = document.createElement('div');
        div.className = 'speed-text';
        container.appendChild(div);
        document.body.appendChild(container);
    } else if (!div) {
        div = document.createElement('div');
        div.className = 'speed-text';
        container.appendChild(div);
    }
    div.innerText = message;
    div.classList.remove('hide');

    const timerKey = '_reall3dToastTimer';
    clearTimeout((div as any)[timerKey]);
    (div as any)[timerKey] = setTimeout(() => {
        div.classList.add('hide');
        div.innerText = '';
    }, 3000);
}
