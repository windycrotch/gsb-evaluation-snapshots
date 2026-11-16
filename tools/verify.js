/*
 * Node 侧自动核对（零依赖）：
 *   1. 确定性：同参数两次生成，格子序列与 PNG 字节完全一致；
 *   2. 复现：从样例 JSON 清单重新载入参数，得到同一图集；
 *   3. 约束：相邻格（含首尾环绕）不同色、每种颜色至少出现一次、索引不越界；
 *   4. 像素一致：解码样例 PNG，逐像素核对与清单 cells 完全对应；
 *   5. 拒绝非法输入：越界、非整数、空调色板、格子少于颜色数等；
 *   6. 穷举小网格 + 抽样大网格，验证构造算法普遍可行且满足约束。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');
var core = require('../weave-core.js');
var pngEnc = require('./png-encode.js');

var failures = [];
function assert(cond, msg) {
  if (!cond) failures.push(msg);
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    failures.push(msg + '（' + JSON.stringify(a) + ' !== ' + JSON.stringify(b) + '）');
  }
}

/* ---------- 最小 PNG 解码（RGB 8-bit，支持 0-4 号行过滤器） ---------- */
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件');
  var off = 8;
  var width = 0, height = 0, bitDepth = 0, colorType = 0;
  var idat = [];
  while (off < buf.length) {
    var len = buf.readUInt32BE(off);
    var type = buf.toString('ascii', off + 4, off + 8);
    var data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 2) throw new Error('仅支持 RGB 8-bit PNG');
  var channels = 3;
  var raw = zlib.inflateSync(Buffer.concat(idat));
  var stride = width * channels;
  var pixels = Buffer.alloc(stride * height);
  var pos = 0;
  function paeth(a, b, c) {
    var p = a + b - c;
    var pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  }
  for (var y = 0; y < height; y++) {
    var filter = raw[pos++];
    for (var x = 0; x < stride; x++) {
      var v = raw[pos++];
      var a = x >= channels ? pixels[y * stride + x - channels] : 0;
      var b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      var c = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      if (filter === 0) pixels[y * stride + x] = v;
      else if (filter === 1) pixels[y * stride + x] = (v + a) & 255;
      else if (filter === 2) pixels[y * stride + x] = (v + b) & 255;
      else if (filter === 3) pixels[y * stride + x] = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) pixels[y * stride + x] = (v + paeth(a, b, c)) & 255;
      else throw new Error('未知 PNG 过滤器：' + filter);
    }
  }
  return { width: width, height: height, rgb: pixels };
}

/* ---------- 1-4：样例复现与像素核对 ---------- */
var sampleDir = path.join(__dirname, '..', 'sample');
var manifest = JSON.parse(fs.readFileSync(path.join(sampleDir, 'sample-manifest.json'), 'utf8'));
var pngOnDisk = fs.readFileSync(path.join(sampleDir, 'sample-atlas.png'));

var reloaded = core.evaluate({
  rows: manifest.rows,
  columns: manifest.columns,
  cellSize: manifest.cellSize,
  seed: manifest.seed,
  palette: manifest.palette
});
assert(reloaded.ok, '清单参数应可重新生成');
eq(reloaded.cells, manifest.cells, '重新载入后的格子索引必须与清单一致');

var again = core.evaluate({
  rows: 3, columns: 4, cellSize: 8,
  seed: 'sample-3x4-4c',
  palette: ['#264653', '#2a9d8f', '#e9c46a', '#e76f51']
});
eq(again.cells, reloaded.cells, '同参数两次生成必须一致（确定性）');

var rgb2 = pngEnc.resultToRgb(reloaded, core);
var png2 = pngEnc.encodePNG(manifest.atlas.width, manifest.atlas.height, rgb2);
assert(png2.equals(pngOnDisk), '重新编码的 PNG 必须与样例 PNG 逐字节相同');

var gridCheck = core.validateGrid(manifest.cells, manifest.rows, manifest.columns, manifest.palette.length);
assert(gridCheck.ok, '约束校验失败：' + gridCheck.error);

manifest.palette.forEach(function (_, i) {
  assert(manifest.colorUsage[i] >= 1, '颜色索引 ' + i + ' 至少出现一次');
});
eq(manifest.colorUsage.reduce(function (a, b) { return a + b; }, 0),
  manifest.rows * manifest.columns, '颜色计数总和等于格子总数');

var decoded = decodePNG(pngOnDisk);
assert(decoded.width === manifest.atlas.width && decoded.height === manifest.atlas.height,
  'PNG 尺寸与清单不符');
var mismatch = 0;
var s = manifest.cellSize;
for (var r = 0; r < manifest.rows; r++) {
  for (var c = 0; c < manifest.columns; c++) {
    var want = core.hexToRgb(manifest.palette[manifest.cells[r * manifest.columns + c]]);
    var x0 = c * s, y0 = r * s;
    for (var dy = 0; dy < s && mismatch === 0; dy++) {
      for (var dx = 0; dx < s; dx++) {
        var o = ((y0 + dy) * decoded.width + (x0 + dx)) * 3;
        if (decoded.rgb[o] !== want[0] || decoded.rgb[o + 1] !== want[1] || decoded.rgb[o + 2] !== want[2]) {
          mismatch++;
        }
      }
    }
  }
}
assert(mismatch === 0, 'PNG 实际像素与清单索引存在 ' + mismatch + ' 处不一致');

// 不同种子应产生不同图集（极小概率相同，4 色 12 格可忽略）
var other = core.evaluate({
  rows: 3, columns: 4, cellSize: 8, seed: 'a-different-seed',
  palette: manifest.palette
});
assert(JSON.stringify(other.cells) !== JSON.stringify(manifest.cells), '不同种子应产生不同图集');

/* ---------- 5：输入校验与不可行情形 ---------- */
function expectReject(params, fragment) {
  var res = core.evaluate(params);
  assert(res.ok === false, '应当被拒绝：' + JSON.stringify(params));
  if (!res.ok && fragment) assert(res.error.indexOf(fragment) >= 0, '错误提示应包含「' + fragment + '」，实际：' + res.error);
}
var baseP = { rows: 3, columns: 4, cellSize: 8, seed: 'x', palette: ['#111111', '#222222', '#333333', '#444444'] };
expectReject(Object.assign({}, baseP, { rows: 0 }), '行数');
expectReject(Object.assign({}, baseP, { rows: 65 }), '行数');
expectReject(Object.assign({}, baseP, { columns: 1.5 }), '列数');
expectReject(Object.assign({}, baseP, { columns: 'abc' }), '列数');
expectReject(Object.assign({}, baseP, { cellSize: 3 }), '单元格像素');
expectReject(Object.assign({}, baseP, { cellSize: 33 }), '单元格像素');
expectReject(Object.assign({}, baseP, { rows: '' }), '行数');
expectReject(Object.assign({}, baseP, { seed: '  ' }), '种子');
expectReject(Object.assign({}, baseP, { palette: [] }), '调色板为空');
expectReject(Object.assign({}, baseP, { palette: ['#xyzxyz'] }), '#RRGGBB');
// 格子总数少于颜色数
expectReject({ rows: 2, columns: 2, cellSize: 8, seed: 'x',
  palette: ['#111111', '#222222', '#333333', '#444444', '#555555'] }, '少于调色板颜色数');
// 奇数环只有两色：1×3 需要 3 色
expectReject({ rows: 1, columns: 3, cellSize: 8, seed: 'x',
  palette: ['#111111', '#222222'] }, '至少需要 3 种颜色');
// 2×2 需要 4 色
expectReject({ rows: 2, columns: 2, cellSize: 8, seed: 'x',
  palette: ['#111111', '#222222', '#333333'] }, '至少需要 4 种颜色');
// 边界值本身必须通过（1×1 时调色板也只能有 1 色）
[1, 64].forEach(function (v) {
  var palB = v === 1 ? ['#111111'] : four();
  var ok1 = core.evaluate(Object.assign({}, baseP, { rows: v, columns: v, palette: palB }));
  assert(ok1.ok, '边界值 ' + v + ' 应被接受：' + (ok1.error || ''));
});
[4, 32].forEach(function (v) {
  var ok2 = core.evaluate(Object.assign({}, baseP, { cellSize: v }));
  assert(ok2.ok, '单元格边界值 ' + v + ' 应被接受：' + (ok2.error || ''));
});
function four() { return ['#111111', '#222222', '#333333', '#444444']; }

/* ---------- 6：穷举小网格 + 抽样大网格 ---------- */
var pal = ['#264653', '#2a9d8f', '#e9c46a', '#e76f51', '#8ab17d', '#f4a261'];
var shapes = [];
for (var rr = 1; rr <= 8; rr++) for (var cc = 1; cc <= 8; cc++) shapes.push([rr, cc]);
[[16, 16], [32, 32], [64, 64], [1, 64], [64, 1], [17, 13], [33, 7], [2, 64], [63, 63]].forEach(function (s2) {
  shapes.push(s2);
});
shapes.forEach(function (shape) {
  var R = shape[0], C = shape[1], n = R * C;
  var maxK = Math.min(pal.length, n);
  for (var k = 1; k <= maxK; k++) {
    var subPal = pal.slice(0, k);
    var res = core.evaluate({ rows: R, columns: C, cellSize: 8, seed: 'seed-' + R + '-' + C + '-' + k, palette: subPal });
    var need = core.minColors(R, C);
    if (k < need) {
      assert(res.ok === false, R + 'x' + C + ' k=' + k + ' 应不可行');
      continue;
    }
    if (!res.ok) {
      failures.push(R + 'x' + C + ' k=' + k + ' 意外失败：' + res.error);
      continue;
    }
    var v = core.validateGrid(res.cells, R, C, k);
    if (!v.ok) failures.push(R + 'x' + C + ' k=' + k + ' 约束失败：' + v.error);
    // 确定性复查
    var resB = core.evaluate({ rows: R, columns: C, cellSize: 8, seed: 'seed-' + R + '-' + C + '-' + k, palette: subPal });
    eq(res.cells, resB.cells, R + 'x' + C + ' k=' + k + ' 两次生成不一致');
  }
});

/* ---------- 汇总 ---------- */
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' 项核对未通过');
  failures.forEach(function (f) { console.error('  - ' + f); });
  process.exit(1);
}
console.log('PASS: 全部核对通过（确定性复现、像素一致、环绕异色、颜色全覆盖、输入拒绝、网格穷举）');
