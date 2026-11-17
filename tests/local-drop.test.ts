// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================
/**
 * 本地拖入链路的自动化验证（Node 内置 test runner，零第三方依赖）。
 *
 * 运行：
 *   1. node tests/generate-samples.mjs   （先生成样例文件）
 *   2. node --experimental-strip-types tests/local-drop.test.ts
 *
 * 覆盖：
 * - detectLocalFileKind：.spx/.splat/.ply/.spz/.sog/.zip/.glb/.scene.json
 *   的扩展名判定，以及大写后缀、不支持扩展名（负向）、.meta.json 负向；
 * - inferModelFormatFromUrl：URL 推断格式、查询参数、大小写，
 *   以及 blob: 地址不会被误报为未知格式（返回 undefined 交由调用方）；
 * - readPlyHeader + isPointCloudPlyHeader：点云 PLY、CRLF 点云 PLY、
 *   高斯 PLY 的文件头读取与渲染分支判定；
 * - detectGlbExtension：KHR_gaussian_splatting、spz 压缩扩展、普通 GLB。
 *
 * 渲染分支（addModel/addScene/OnLoadAndRenderPointCloudPly 等）依赖 WebGL，
 * 在 tests/local-drop-demo.html 浏览器验证页中以事件桩方式观察，本文件只验证
 * “决定走哪条分支”的纯逻辑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    detectLocalFileKind,
    inferModelFormatFromUrl,
    readPlyHeader,
    isPointCloudPlyHeader,
    detectGlbExtension,
} from '../src/reall3d/utils/LocalFileUtils.ts';

const here = dirname(fileURLToPath(import.meta.url));
const sample = (name: string) => readFileSync(join(here, 'samples', name));

/* ---------------- 1) 扩展名判定 ---------------- */

test('detectLocalFileKind: 各支持扩展名映射到正确的 model 格式', () => {
    const cases: Array<[string, string]> = [
        ['a.spx', 'spx'],
        ['b.splat', 'splat'],
        ['c.ply', 'ply'],
        ['d.spz', 'spz'],
        ['e.sog', 'sog'],
        ['f.zip', 'sog'],
        ['g.glb', 'glb'],
    ];
    for (const [fileName, format] of cases) {
        const kind = detectLocalFileKind(fileName);
        assert.equal(kind.type, 'model', `${fileName} 应为 model`);
        assert.equal(kind.format, format, `${fileName} 应推断为 ${format}`);
        assert.equal(kind.error, undefined);
    }
});

test('detectLocalFileKind: .scene.json 走大场景流程', () => {
    const kind = detectLocalFileKind('big.scene.json');
    assert.equal(kind.type, 'scene');
    assert.equal(kind.format, undefined);
});

test('detectLocalFileKind: 大写后缀同样可识别（不区分大小写）', () => {
    assert.equal(detectLocalFileKind('CLOUD.PLY').format, 'ply');
    assert.equal(detectLocalFileKind('Model.SPX').format, 'spx');
    assert.equal(detectLocalFileKind('Pack.ZIP').format, 'sog');
    assert.equal(detectLocalFileKind('Asset.GLB').format, 'glb');
    assert.equal(detectLocalFileKind('Big.SCENE.JSON').type, 'scene');
});

test('detectLocalFileKind: 不支持扩展名给出明确错误（负向用例）', () => {
    const kind = detectLocalFileKind('unsupported.txt');
    assert.equal(kind.type, 'unsupported');
    assert.ok(kind.error && kind.error.includes('unsupported.txt'), '错误信息应包含文件名');
    assert.ok(kind.error.includes('Unsupported format'), '错误信息应说明是格式不支持');
});

test('detectLocalFileKind: 单独拖入 .meta.json 也按不支持处理并提示原因', () => {
    const kind = detectLocalFileKind('abc.meta.json');
    assert.equal(kind.type, 'unsupported');
    assert.ok(kind.error.includes('.meta.json'));
});

test('detectLocalFileKind: 空文件名不崩溃', () => {
    assert.equal(detectLocalFileKind('').type, 'unsupported');
});

/* ---------------- 2) URL 推断 ---------------- */

test('inferModelFormatFromUrl: 常规 URL 扩展名推断', () => {
    assert.equal(inferModelFormatFromUrl('https://x/a.spx'), 'spx');
    assert.equal(inferModelFormatFromUrl('https://x/a.splat?v=1'), 'splat');
    assert.equal(inferModelFormatFromUrl('/path/a.PLY'), 'ply');
    assert.equal(inferModelFormatFromUrl('/path/a.spz'), 'spz');
    assert.equal(inferModelFormatFromUrl('/path/a.sog'), 'sog');
    assert.equal(inferModelFormatFromUrl('/path/a.zip'), 'sog');
    assert.equal(inferModelFormatFromUrl('/path/meta.json'), 'sog');
    assert.equal(inferModelFormatFromUrl('meta.json'), 'sog');
    assert.equal(inferModelFormatFromUrl('/path/a.obj'), 'obj');
    assert.equal(inferModelFormatFromUrl('/path/a.glb'), 'glb');
});

test('inferModelFormatFromUrl: blob: 地址返回 undefined 而非误报未知格式', () => {
    // blob: 地址没有扩展名，调用方（拖入链路）必须在创建 blob: 前确定 format
    assert.equal(inferModelFormatFromUrl('blob:https://localhost:3100/550e8400-e29b-41d4-a716-446655440000'), undefined);
    assert.equal(inferModelFormatFromUrl('blob:null/aaaaaaaa'), undefined);
});

test('inferModelFormatFromUrl: 无法识别的普通 URL 返回 undefined', () => {
    assert.equal(inferModelFormatFromUrl('https://x/readme'), undefined);
});

/* ---------------- 3) PLY 文件头与点云/高斯分支 ---------------- */

test('点云 PLY 文件头被识别为点云渲染分支', () => {
    const bytes = sample('point-cloud.ply');
    const header = readPlyHeader(bytes);
    assert.ok(header.startsWith('ply'));
    assert.equal(isPointCloudPlyHeader(header), true, '含 red/green/blue 的 PLY 应判为点云 PLY');
});

test('CRLF 换行的点云 PLY 同样被识别（换行兼容）', () => {
    const bytes = sample('point-cloud-crlf.ply');
    const header = readPlyHeader(bytes);
    assert.equal(isPointCloudPlyHeader(header), true);
});

test('普通高斯 PLY 文件头被识别为高斯渲染分支', () => {
    const bytes = sample('gaussian.ply');
    const header = readPlyHeader(bytes);
    assert.equal(isPointCloudPlyHeader(header), false, '使用 f_dc_* 表达颜色的 PLY 不应判为点云 PLY');
    assert.ok(header.includes('f_dc_0'));
    assert.ok(header.includes('scale_0'));
});

test('大写后缀的高斯 PLY 仍按扩展名进入 PLY 分支且判为高斯', () => {
    // 扩展名判定（小写比较）
    assert.equal(detectLocalFileKind('gaussian-upper.PLY').format, 'ply');
    // 文件头判定
    const bytes = sample('gaussian-upper.PLY');
    assert.equal(isPointCloudPlyHeader(readPlyHeader(bytes)), false);
});

test('readPlyHeader: 缺少 end_header 时抛错', () => {
    assert.throws(() => readPlyHeader(new TextEncoder().encode('ply\nformat binary_little_endian 1.0\n')), /end_header/);
});

/* ---------------- 4) GLB 扩展识别 ---------------- */

test('GLB: KHR_gaussian_splatting 扩展识别为 gaussian 分支', () => {
    const { kind } = detectGlbExtension(sample('khr-gs.glb'));
    assert.equal(kind, 'gaussian');
});

test('GLB: spz 压缩扩展识别为 spz 分支', () => {
    const { kind } = detectGlbExtension(sample('khr-spz.glb'));
    assert.equal(kind, 'spz');
});

test('GLB: 无高斯扩展的普通 GLB 识别为 standard（GLTFLoader 网格分支）', () => {
    const { kind } = detectGlbExtension(sample('standard.glb'));
    assert.equal(kind, 'standard');
});
