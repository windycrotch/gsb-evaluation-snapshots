/*
 * 生成本地样例：3 行 × 4 列、4 色、单元格 8px、固定种子 "sample-3x4-4c"。
 * 产出 sample/ 目录下的 PNG 图集与 JSON 清单。
 * 重复运行（以及浏览器中用同参数重新载入）必须得到逐字节相同的文件。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var core = require('../weave-core.js');
var png = require('./png-encode.js');

var params = {
  rows: 3,
  columns: 4,
  cellSize: 8,
  seed: 'sample-3x4-4c',
  palette: ['#264653', '#2a9d8f', '#e9c46a', '#e76f51']
};

var result = core.evaluate(params);
if (!result.ok) {
  throw new Error('样例参数不可行：' + result.error);
}

var check = core.validateGrid(result.cells, result.rows, result.columns, result.palette.length);
if (!check.ok) {
  throw new Error('样例未通过约束校验：' + check.error);
}

var manifest = core.buildManifest(result);
var rgb = png.resultToRgb(result, core);
var pngBuf = png.encodePNG(manifest.atlas.width, manifest.atlas.height, rgb);

var outDir = path.join(__dirname, '..', 'sample');
fs.mkdirSync(outDir, { recursive: true });

var pngPath = path.join(outDir, 'sample-atlas.png');
var jsonPath = path.join(outDir, 'sample-manifest.json');
fs.writeFileSync(pngPath, pngBuf);
fs.writeFileSync(jsonPath, JSON.stringify(manifest, null, 2) + '\n');

console.log('样例已生成：');
console.log('  ' + path.relative(process.cwd(), pngPath) + '  (' + pngBuf.length + ' bytes, ' +
  manifest.atlas.width + 'x' + manifest.atlas.height + ')');
console.log('  ' + path.relative(process.cwd(), jsonPath));
console.log('格子索引（行优先）：');
for (var r = 0; r < result.rows; r++) {
  console.log('  ' + result.cells.slice(r * result.columns, (r + 1) * result.columns).join(' '));
}
console.log('每种颜色出现次数：' + JSON.stringify(manifest.colorUsage));
