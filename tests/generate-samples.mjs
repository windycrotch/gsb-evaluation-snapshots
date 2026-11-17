// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================
/**
 * 本地拖入链路验证用的样例文件生成器（纯 Node，零第三方依赖）。
 *
 * 运行：node tests/generate-samples.mjs
 * 输出：tests/samples/ 下的一组最小可解析样例文件
 *
 * 生成的文件：
 * - point-cloud.ply        点云 PLY（含 red/green/blue 属性）        -> 期望走点云渲染分支
 * - point-cloud-crlf.ply   与上相同但使用 CRLF 换行（验证换行兼容）  -> 期望走点云渲染分支
 * - gaussian.ply           3DGS 高斯 PLY（含 f_dc、scale、rot 等属性）  -> 期望走高斯渲染分支
 * - gaussian-upper.PLY     大写后缀的高斯 PLY（验证大小写不敏感）    -> 期望走高斯渲染分支
 * - khr-gs.glb             含 KHR_gaussian_splatting 扩展的 GLB      -> 期望识别为 gaussian
 * - khr-spz.glb            含 KHR_gaussian_splatting_compression_spz_2 扩展 -> 期望识别为 spz
 * - standard.glb           普通 GLB（无高斯扩展）                    -> 期望走 GLTFLoader 网格分支
 * - unsupported.txt        不支持的扩展名（负向用例）
 * - demo.scene.json        大场景描述文件（走 addScene 流程用）
 *
 * 设计原则：只生成“能被格式判定/文件头解析逻辑识别”的最小字节，
 * 不追求可被 WebGL 实际渲染（渲染分支的调用在浏览器验证页中用桩观察）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'samples');
mkdirSync(outDir, { recursive: true });

const write = (name, bytes) => {
    const filePath = join(outDir, name);
    writeFileSync(filePath, bytes);
    console.log(`written ${name} (${bytes.byteLength} bytes)`);
};

const enc = new TextEncoder();

/* ---------------- PLY 样例 ---------------- */

// 点云 PLY：xyz + rgb，4 个点
function buildPointCloudPly(eol = '\n') {
    const header = [
        'ply',
        'format binary_little_endian 1.0',
        'element vertex 4',
        'property float x',
        'property float y',
        'property float z',
        'property uchar red',
        'property uchar green',
        'property uchar blue',
        'end_header',
        '', // 使最后一行带换行
    ].join(eol);
    const head = enc.encode(header);
    // 每行 15 字节：3 个 float32(12) + 3 个 uchar(3)
    const row = 15;
    const body = new Uint8Array(4 * row);
    const dv = new DataView(body.buffer);
    const points = [
        [0, 0, 0, 255, 0, 0],
        [1, 0, 0, 0, 255, 0],
        [0, 1, 0, 0, 0, 255],
        [0, 0, 1, 255, 255, 0],
    ];
    points.forEach((p, i) => {
        dv.setFloat32(i * row + 0, p[0], true);
        dv.setFloat32(i * row + 4, p[1], true);
        dv.setFloat32(i * row + 8, p[2], true);
        body[i * row + 12] = p[3];
        body[i * row + 13] = p[4];
        body[i * row + 14] = p[5];
    });
    const out = new Uint8Array(head.byteLength + body.byteLength);
    out.set(head, 0);
    out.set(body, head.byteLength);
    return out;
}

// 3DGS 高斯 PLY：标准 17 个核心属性（SH degree 0），2 个高斯
function buildGaussianPly() {
    const props = [
        'property float x',
        'property float y',
        'property float z',
        'property float nx',
        'property float ny',
        'property float nz',
        'property float f_dc_0',
        'property float f_dc_1',
        'property float f_dc_2',
        'property float opacity',
        'property float scale_0',
        'property float scale_1',
        'property float scale_2',
        'property float rot_0',
        'property float rot_1',
        'property float rot_2',
        'property float rot_3',
    ];
    const header = ['ply', 'format binary_little_endian 1.0', 'element vertex 2', ...props, 'end_header\n'].join('\n');
    const head = enc.encode(header);
    const row = 17 * 4; // 全 float32
    const body = new Uint8Array(2 * row);
    const dv = new DataView(body.buffer);
    for (let i = 0; i < 2; i++) {
        for (let f = 0; f < 17; f++) {
            // 四元数第 1 个分量给 1，其余给小数值，保证是结构合法的高斯记录
            dv.setFloat32(i * row + f * 4, f === 13 ? 1 : (i + 1) * 0.1 * (f + 1), true);
        }
    }
    const out = new Uint8Array(head.byteLength + body.byteLength);
    out.set(head, 0);
    out.set(body, head.byteLength);
    return out;
}

write('point-cloud.ply', buildPointCloudPly('\n'));
write('point-cloud-crlf.ply', buildPointCloudPly('\r\n'));
const gaussianPly = buildGaussianPly();
write('gaussian.ply', gaussianPly);
write('gaussian-upper.PLY', gaussianPly);

/* ---------------- GLB 样例 ---------------- */
// GLB 结构：12 字节头 + JSON chunk（8 字节 chunk 头 + 数据）+ BIN chunk
function buildGlb({ extensionName = '', withBin = true } = {}) {
    const gltf = {
        asset: { version: '2.0' },
        // 该字段仅用于让 JSON 长度不落在 4 字节边界上，从而产生真实的 0x20 填充，
        // 验证解析方能处理 GLB JSON chunk 的尾部填充
        generator: 'reall3d-local-drop-tests',
        extensionsUsed: extensionName ? [extensionName] : [],
        buffers: withBin ? [{ byteLength: 8 }] : [],
        bufferViews: withBin ? [{ buffer: 0, byteOffset: 0, byteLength: 8 }] : [],
        accessors: [{ componentType: 5126, count: 1, type: 'VEC3', bufferView: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        nodes: [{ mesh: 0 }],
        scenes: [{ nodes: [0] }],
        scene: 0,
    };
    if (extensionName) {
        gltf.extensions = { [extensionName]: { splatCount: 1 } };
        // 让 KHR_gaussian_splatting 的转换函数也能找到属性名
        if (extensionName === 'KHR_gaussian_splatting') {
            gltf.meshes[0].primitives[0].attributes = {
                POSITION: 0,
                'KHR_gaussian_splatting:SCALE': 0,
                'KHR_gaussian_splatting:SH_DEGREE_0_COEF_0': 0,
                'KHR_gaussian_splatting:OPACITY': 0,
                'KHR_gaussian_splatting:ROTATION': 0,
            };
        }
    }
    const jsonBytes = enc.encode(JSON.stringify(gltf));
    // GLB 规范要求 chunk 按 4 字节对齐并用 0x20 填充
    const jsonPadded = padTo4(jsonBytes, 0x20);
    const binBytes = new Uint8Array(8);
    const binPadded = padTo4(binBytes, 0x00);

    const total = 12 + 8 + jsonPadded.byteLength + (withBin ? 8 + binPadded.byteLength : 0);
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    let off = 0;
    // GLB header
    dv.setUint32(off, 0x46546c67, true); // "glTF"
    dv.setUint32(off + 4, 2, true); // version
    dv.setUint32(off + 8, total, true); // total length
    off += 12;
    // JSON chunk
    dv.setUint32(off, jsonPadded.byteLength, true);
    dv.setUint32(off + 4, 0x4e4f534a, true); // "JSON"
    out.set(jsonPadded, off + 8);
    off += 8 + jsonPadded.byteLength;
    // BIN chunk
    if (withBin) {
        dv.setUint32(off, binPadded.byteLength, true);
        dv.setUint32(off + 4, 0x004e4942, true); // "BIN\0"
        out.set(binPadded, off + 8);
    }
    return out;
}

function padTo4(bytes, padByte) {
    const rem = bytes.byteLength % 4;
    if (!rem) return bytes;
    const out = new Uint8Array(bytes.byteLength + (4 - rem));
    out.set(bytes, 0);
    out.fill(padByte, bytes.byteLength);
    return out;
}

write('khr-gs.glb', buildGlb({ extensionName: 'KHR_gaussian_splatting' }));
write('khr-spz.glb', buildGlb({ extensionName: 'KHR_gaussian_splatting_compression_spz_2' }));
write('standard.glb', buildGlb({}));

/* ---------------- 负向与大场景样例 ---------------- */
write('unsupported.txt', enc.encode('this is not a supported model file\n'));
write(
    'demo.scene.json',
    enc.encode(
        JSON.stringify(
            {
                name: 'drop-scene-demo',
                version: '1.0',
                url: 'https://example.com/lod-meta.json',
                autoRotate: false,
                pointcloudMode: false,
            },
            null,
            2,
        ),
    ),
);

console.log(`\nall samples generated under: ${outDir}`);
