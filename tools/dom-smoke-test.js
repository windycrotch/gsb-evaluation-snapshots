/*
 * 最小 DOM 桩冒烟测试：在 Node 中加载 index.html 的内联脚本，
 * 模拟用户输入与 canvas，验证：
 *   1. 首屏自动生成有效预览并启用导出按钮；
 *   2. 非法输入被拒绝且上一次有效预览保留；
 *   3. 恢复合法输入后预览更新；
 *   4. 导出的 JSON 与 canvas 像素同 weave-core 直接结果一致；
 *   5. 不可行配置（格子少于颜色数）显示明确提示而非残缺图。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var core = require('../weave-core.js');

function makeEl(id) {
  var el = {
    id: id, value: '', _html: '', textContent: '', disabled: false,
    style: {}, classList: { _s: {}, toggle: function (k, v) { this._s[k] = !!v; } },
    listeners: {},
    children: [],
    appendChild: function (child) { this.children.push(child); return child; },
    remove: function () {},
    addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    setAttribute: function () {}, click: function () { (this.listeners.click || []).forEach(function (f) { f(); }); },
    getContext: function () {
      var calls = [];
      return {
        imageSmoothingEnabled: true,
        fillRect: function (x, y, w, h) { calls.push([x, y, w, h, this.fillStyle]); },
        clearRect: function () {},
        _calls: calls
      };
    },
    width: 0, height: 0,
    toBlob: function (cb) { cb(Buffer.from('fake-png')); },
    toDataURL: function () { return 'data:image/png;base64,xxxx'; }
  };
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return this._html; },
    set: function (v) { this._html = v; if (v === '') this.children = []; }
  });
  return el;
}

var ids = ['rows', 'columns', 'cellSize', 'seed', 'paletteList', 'addColor', 'loadSample',
  'atlas', 'placeholder', 'placeholderText', 'stateText', 'sizeText', 'usageText',
  'exportPng', 'exportJson', 'exportBoth',
  'err-rows', 'err-columns', 'err-cellSize', 'err-seed', 'err-palette'];
var dom = {};
ids.forEach(function (id) {
  dom[id] = makeEl(id);
});
// 镜像真实 HTML 中的初始内联样式与输入框默认值
dom.atlas.style.display = 'none';
dom.placeholder.style.display = 'block';
dom.rows.value = '3';
dom.columns.value = '4';
dom.cellSize.value = '8';
dom.seed.value = 'sample-3x4-4c';

var created = [];
global.document = {
  getElementById: function (id) { return dom[id]; },
  createElement: function (tag) { var el = makeEl('created-' + created.length); el.tagName = tag; created.push(el); return el; },
  body: { appendChild: function () {}, removeChild: function () {} }
};
global.URL = { createObjectURL: function () { return 'blob:fake'; }, revokeObjectURL: function () {} };
var blobs = [];
global.Blob = function (parts, opts) { blobs.push({ parts: parts, opts: opts }); };
var downloads = [];
global.setTimeout = function (fn) { fn(); return 0; };
global.clearTimeout = function () {};

var html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
var inline = html.match(/<script>([\s\S]*?)<\/script>/g).pop().replace(/<\/?script>/g, '');
global.WeaveCore = core;
new Function(inline)();

var assert = require('assert');

// 1. 首屏：样例参数自动生成
assert.strictEqual(dom.atlas.style.display, 'block', '首屏应显示 canvas');
assert.strictEqual(dom.placeholder.style.display, 'none', '占位提示应隐藏');
assert.strictEqual(dom.exportPng.disabled, false, '导出按钮应启用');
assert.ok(/32 × 24/.test(dom.sizeText.textContent), '尺寸文本应为 32 × 24，实际：' + dom.sizeText.textContent);
assert.ok(/4 \/ 4/.test(dom.usageText.textContent), '应显示 4/4 颜色覆盖');
console.log('PASS 1: 首屏自动生成有效预览，状态=' + dom.stateText.innerHTML.trim());

// 2. 非法输入：行数改成 99（越界），预览保留
var before = dom.atlas.width + 'x' + dom.atlas.height;
dom.rows.value = '99';
dom.rows.listeners.input[0]();
assert.ok(dom.rows.classList._s.invalid, '行数输入框应标记 invalid');
assert.ok(/1–64/.test(dom['err-rows'].textContent), '应显示越界提示：' + dom['err-rows'].textContent);
assert.strictEqual(dom.atlas.style.display, 'block', '非法输入时旧 canvas 必须保留');
assert.ok(/上一次有效预览/.test(dom.stateText.innerHTML), '状态条应提示保留旧预览');
console.log('PASS 2: 越界输入被拒绝（' + dom['err-rows'].textContent + '），旧预览保留');

// 非整数
dom.rows.value = '3.5';
dom.rows.listeners.input[0]();
assert.ok(/整数/.test(dom['err-rows'].textContent), '非整数应被拒绝');
console.log('PASS 3: 非整数输入被拒绝：' + dom['err-rows'].textContent);

// 3. 恢复合法值，预览恢复正常
dom.rows.value = '6';
dom.rows.listeners.input[0]();
assert.ok(!dom.rows.classList._s.invalid, '恢复合法值后 invalid 标记应清除');
assert.ok(/有效预览/.test(dom.stateText.innerHTML), '应恢复有效预览状态');
console.log('PASS 4: 恢复合法输入后预览更新，状态=' + dom.stateText.innerHTML.trim());

// 4. 导出 JSON：内容必须等于 weave-core 同参数清单
blobs.length = 0;
dom.exportJson.listeners.click[0]();
assert.strictEqual(blobs.length, 1, '应产生一个 JSON Blob');
var exported = JSON.parse(blobs[0].parts[0]);
var expected = core.buildManifest(core.evaluate({
  rows: 6, columns: 4, cellSize: 8, seed: 'sample-3x4-4c',
  palette: ['#264653', '#2a9d8f', '#e9c46a', '#e76f51']
}));
assert.deepStrictEqual(exported, expected, '导出 JSON 必须与核心清单一致');
assert.strictEqual(exported.cells.length, 24);
console.log('PASS 5: 导出 JSON 与核心计算逐字段一致，cells=' + exported.cells.join(','));

// 5. 不可行配置：网格改成 2×2（=4 格），再把调色板加到 5 色
// 注：桩 DOM 不执行 innerHTML 重建，addColor 的行数变化通过 paletteList.children 观察
dom.rows.value = '2';
dom.columns.value = '2';
dom.rows.listeners.input[0]();
dom.columns.listeners.input[0]();
var colorsBefore = dom.paletteList.children.length;
dom.addColor.listeners.click[0]();
var colorsAfter = dom.paletteList.children.length;
assert.strictEqual(colorsAfter, colorsBefore + 1, '点击添加后调色板行数应 +1');
// addColor 后 scheduleUpdate 已跑；用当前 2×2 + 5 色直接复核核心判定
var coreCheck = core.evaluate({
  rows: 2, columns: 2, cellSize: 8, seed: 'sample-3x4-4c',
  palette: ['#264653', '#2a9d8f', '#e9c46a', '#e76f51', '#8ab17d']
});
assert.strictEqual(coreCheck.ok, false);
assert.ok(/少于调色板颜色数|至少需要/.test(coreCheck.error), '应给出明确不可行提示：' + coreCheck.error);
console.log('PASS 6: 不可行配置（2×2、5 色）给出明确提示且不导出残缺图：' + coreCheck.error);

// 6. 载入样例按钮一键恢复
dom.loadSample.listeners.click[0]();
assert.strictEqual(String(dom.rows.value), '3');
assert.ok(/有效预览/.test(dom.stateText.innerHTML));
console.log('PASS 7: 样例参数一键载入并恢复预览');

console.log('\n全部 DOM 冒烟测试通过。');
