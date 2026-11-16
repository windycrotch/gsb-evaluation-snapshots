/*
 * VoxelWeave 纹理工坊 — 确定性织纹生成核心
 *
 * 同一种子 + 同一组参数永远得到完全相同的格子索引序列，
 * 因此渲染出的 PNG 图集逐像素一致。
 *
 * 约束保证（构造式算法，非随机重试）：
 *   1. 每个格子从调色板取色（值为调色板索引）；
 *   2. 相邻格子（上/下/左/右，含首尾环绕）颜色索引不同；
 *   3. 调色板中每种颜色至少出现一次；
 *   4. 不可行的参数（格子太少、调色板为空、奇数环绕结构却只有两色等）
 *      直接返回明确错误，而不是画出残缺图。
 *
 * 无外部依赖：浏览器中用 <script> 直接引入，Node 中用 require 引入。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WeaveCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    rows: { min: 1, max: 64, label: '行数' },
    columns: { min: 1, max: 64, label: '列数' },
    cellSize: { min: 4, max: 32, label: '单元格像素' }
  };

  var HEX_RE = /^#[0-9a-f]{6}$/i;

  /* ---------------- 确定性随机数：FNV-1a 哈希 + mulberry32 ---------------- */

  function hashSeed(seed) {
    var h = 0x811c9dc5 >>> 0;
    var s = String(seed);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function mulberry32(seedUint32) {
    var a = seedUint32 >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffled(input, rng) {
    var arr = input.slice();
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /* ---------------- 输入校验 ---------------- */

  function validateInteger(value, spec) {
    if (typeof value === 'string' && value.trim() === '') {
      return { ok: false, error: spec.label + '不能为空' };
    }
    var n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return { ok: false, error: spec.label + '必须是整数（当前值：' + String(value) + '）' };
    }
    if (n < spec.min || n > spec.max) {
      return { ok: false, error: spec.label + '必须是 ' + spec.min + '–' + spec.max + ' 之间的整数（当前值：' + n + '）' };
    }
    return { ok: true, value: n };
  }

  function validateSeed(value) {
    var s = String(value == null ? '' : value).trim();
    if (!s) return { ok: false, error: '种子不能为空' };
    if (s.length > 128) return { ok: false, error: '种子长度不能超过 128 个字符' };
    return { ok: true, value: s };
  }

  function validatePalette(palette) {
    if (!Array.isArray(palette) || palette.length === 0) {
      return { ok: false, error: '调色板为空，请先添加至少一种颜色。' };
    }
    for (var i = 0; i < palette.length; i++) {
      if (!HEX_RE.test(String(palette[i]))) {
        return { ok: false, error: '调色板第 ' + (i + 1) + ' 项不是合法的 #RRGGBB 颜色：' + String(palette[i]) };
      }
    }
    return { ok: true, value: palette.map(function (c) { return String(c).toLowerCase(); }) };
  }

  /* ---------------- 环面网格的色数与基础着色 ----------------
   * 把网格视作环面图（上下、左右首尾相连）：
   *   - 1×1 退化情形：没有“不同的”相邻格，1 色即可；
   *   - 单行/单列：长度 L 的环，偶数 L 需 2 色，奇数 L 需 3 色；
   *   - 2×2：四个格子两两相邻（K4），需 4 色；
   *   - 行列都为偶数：棋盘格 2 色；
   *   - 其余（至少一维为奇数）：两个环着色按模 3 相加，3 色。
   * --------------------------------------------------------- */

  function minColors(rows, cols) {
    if (rows === 1 && cols === 1) return 1;
    if (rows === 1 || cols === 1) {
      var L = Math.max(rows, cols);
      if (L === 2) return 2;
      return L % 2 === 0 ? 2 : 3;
    }
    if (rows === 2 && cols === 2) return 4;
    return rows % 2 === 0 && cols % 2 === 0 ? 2 : 3;
  }

  /* 长度 L 的环的正常着色：相邻（含首尾）不同，使用尽量少的颜色 */
  function cycleColor(L) {
    var a = new Array(L);
    if (L % 2 === 0) {
      for (var i = 0; i < L; i++) a[i] = i % 2;
      return a;
    }
    for (var j = 0; j < L - 1; j++) a[j] = j % 2;
    a[L - 1] = 2; // 奇数环的收尾用第 3 色，与首尾都不同
    return a;
  }

  function baseColoring(rows, cols) {
    var n = rows * cols;
    var base = new Array(n);
    var classCount;

    if (rows === 1 && cols === 1) {
      base[0] = 0;
      return { base: base, classCount: 1 };
    }

    if (rows === 1 || cols === 1) {
      var L = Math.max(rows, cols);
      var cyc = cycleColor(L);
      for (var r1 = 0; r1 < rows; r1++) {
        for (var c1 = 0; c1 < cols; c1++) {
          base[r1 * cols + c1] = rows === 1 ? cyc[c1] : cyc[r1];
        }
      }
      return { base: base, classCount: L % 2 === 0 ? 2 : 3 };
    }

    if (rows === 2 && cols === 2) {
      for (var k4 = 0; k4 < 4; k4++) base[k4] = k4; // K4 每格一类
      return { base: base, classCount: 4 };
    }

    if (rows % 2 === 0 && cols % 2 === 0) {
      for (var r2 = 0; r2 < rows; r2++) {
        for (var c2 = 0; c2 < cols; c2++) {
          base[r2 * cols + c2] = (r2 + c2) % 2;
        }
      }
      return { base: base, classCount: 2 };
    }

    // 至少一维为奇数：两个环着色按模 3 相加，横/竖一步都必定变色
    var rowCyc = cycleColor(rows);
    var colCyc = cycleColor(cols);
    for (var r3 = 0; r3 < rows; r3++) {
      for (var c3 = 0; c3 < cols; c3++) {
        base[r3 * cols + c3] = (rowCyc[r3] + colCyc[c3]) % 3;
      }
    }
    return { base: base, classCount: 3 };
  }

  function checkFeasibility(rows, cols, paletteLength) {
    if (paletteLength === 0) {
      return { ok: false, error: '调色板为空，请先添加至少一种颜色。' };
    }
    var n = rows * cols;
    if (n < paletteLength) {
      return {
        ok: false,
        error: '格子总数（' + n + ' = ' + rows + '×' + cols +
          '）少于调色板颜色数（' + paletteLength +
          '），无法保证每种颜色都至少出现一次。请增加格子或减少颜色。'
      };
    }
    var need = minColors(rows, cols);
    if (paletteLength < need) {
      return {
        ok: false,
        error: '当前环绕网格至少需要 ' + need +
          ' 种颜色才能保证相邻格子（含首尾环绕）不同色，当前只有 ' + paletteLength + ' 种。'
      };
    }
    return { ok: true };
  }

  /* ---------------- 主入口：评估参数并生成格子索引 ---------------- */

  function evaluate(params) {
    var rv = validateInteger(params.rows, LIMITS.rows);
    if (!rv.ok) return rv;
    var rows = rv.value;

    var cv = validateInteger(params.columns, LIMITS.columns);
    if (!cv.ok) return cv;
    var cols = cv.value;

    var sv = validateInteger(params.cellSize, LIMITS.cellSize);
    if (!sv.ok) return sv;
    var cellSize = sv.value;

    var seedV = validateSeed(params.seed);
    if (!seedV.ok) return seedV;
    var seed = seedV.value;

    var pv = validatePalette(params.palette);
    if (!pv.ok) return pv;
    var palette = pv.value;

    var feas = checkFeasibility(rows, cols, palette.length);
    if (!feas.ok) return feas;

    var cells = generateCells(rows, cols, palette.length, seed);
    return {
      ok: true,
      rows: rows,
      columns: cols,
      cellSize: cellSize,
      seed: seed,
      palette: palette,
      cells: cells
    };
  }

  /* 构造式生成（种子只决定洗牌顺序，结果确定可复现）：
   * 1. baseColoring() 给出环面网格的正常着色，把格子分成 m 个独立集，
   *    同一独立集内的格子互不相邻；
   * 2. 每种颜色整体归属一个独立集（跨集就会出现相邻同色），回溯分配，
   *    要求每个集至少分到一种颜色——这正是可行性检查中 k≥m 的情形；
   * 3. 各集把自己的格子均衡分给归属它的颜色，每种颜色至少拿到 1 格；
   * 4. 集内部用种子洗牌位置与颜色顺序。
   * 相邻格必不同色（独立集性质），每种颜色至少出现一次（归属+非空保证）。 */
  function generateCells(rows, cols, k, seed) {
    var n = rows * cols;
    var rng = mulberry32(hashSeed(seed));

    var bc = baseColoring(rows, cols);
    var base = bc.base;
    var m = bc.classCount;

    var positions = [];
    for (var c = 0; c < m; c++) positions.push([]);
    for (var i = 0; i < n; i++) positions[base[i]].push(i);
    var classSizes = positions.map(function (p) { return p.length; });

    // colorClass[color] = 该颜色归属的独立集编号
    var colorClass = assignColorClasses(classSizes, k, rng);
    if (!colorClass) {
      throw new Error('内部错误：可行性已通过却无法分配颜色归属');
    }

    var colorsOf = [];
    for (var j0 = 0; j0 < m; j0++) colorsOf.push([]);
    colorClass.forEach(function (cls, col) { colorsOf[cls].push(col); });

    var cells = new Array(n);
    for (var cls = 0; cls < m; cls++) {
      var size = classSizes[cls];
      var colsHere = colorsOf[cls];
      // 均衡分摊：前 rem 种颜色拿 q+1 格，其余 q 格（q≥1），总和恰为集大小
      var q = Math.floor(size / colsHere.length);
      var rem = size % colsHere.length;
      var seq = [];
      colsHere.forEach(function (col, localIdx) {
        var take = q + (localIdx < rem ? 1 : 0);
        for (var t = 0; t < take; t++) seq.push(col);
      });
      var pos = shuffled(positions[cls], rng);
      seq = shuffled(seq, rng);
      for (var idx = 0; idx < pos.length; idx++) {
        cells[pos[idx]] = seq[idx];
      }
    }
    return cells;
  }

  function range(k) {
    var a = [];
    for (var i = 0; i < k; i++) a.push(i);
    return a;
  }

  /* 把 k 种颜色分配给 m 个独立集，要求：
   *   - 每个集至少一种颜色；
   *   - 每集分到的颜色数不超过集的格子数（否则该颜色分不到格子）。
   * 可行性检查（n≥k 且 k≥m）保证解存在；m≤4，回溯量很小。
   * 集顺序由 rng 洗牌，输出随种子确定。 */
  function assignColorClasses(classSizes, k, rng) {
    var m = classSizes.length;
    var assignment = new Array(k);
    var colorCount = new Array(m).fill(0);
    var classOrder = shuffled(range(m), rng);

    function dfs(colorIdx) {
      if (colorIdx === k) {
        for (var j = 0; j < m; j++) if (colorCount[j] === 0) return false;
        return true;
      }
      var emptyClasses = 0;
      for (var e = 0; e < m; e++) if (colorCount[e] === 0) emptyClasses++;
      if (emptyClasses > k - colorIdx) return false;

      for (var t = 0; t < m; t++) {
        var cls = classOrder[t];
        if (colorCount[cls] >= classSizes[cls]) continue; // 容量约束
        assignment[colorIdx] = cls;
        colorCount[cls]++;
        if (dfs(colorIdx + 1)) return true;
        colorCount[cls]--;
      }
      return false;
    }

    return dfs(0) ? assignment : null;
  }

  /* ---------------- 清单与渲染辅助 ---------------- */

  function buildManifest(result) {
    var usage = new Array(result.palette.length).fill(0);
    result.cells.forEach(function (idx) { usage[idx]++; });
    return {
      format: 'voxelweave-atlas/1',
      generator: 'weave-core.js',
      seed: result.seed,
      rows: result.rows,
      columns: result.columns,
      cellSize: result.cellSize,
      atlas: {
        width: result.columns * result.cellSize,
        height: result.rows * result.cellSize
      },
      palette: result.palette.slice(),
      cells: result.cells.slice(),
      colorUsage: usage
    };
  }

  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /* 在任意具备 fillRect/fillStyle 的 2D 上下文上渲染（浏览器 Canvas 或测试桩） */
  function renderToContext(ctx, result) {
    var rgb = result.palette.map(hexToRgb);
    var rows = result.rows, cols = result.columns, s = result.cellSize;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var px = rgb[result.cells[r * cols + c]];
        ctx.fillStyle = 'rgb(' + px[0] + ',' + px[1] + ',' + px[2] + ')';
        ctx.fillRect(c * s, r * s, s, s);
      }
    }
  }

  /* 独立校验：供测试核对生成结果确实满足全部约束 */
  function validateGrid(cells, rows, cols, paletteLength) {
    var n = rows * cols;
    if (cells.length !== n) return { ok: false, error: '格子数不匹配' };
    var seen = new Array(paletteLength).fill(false);
    for (var i = 0; i < n; i++) {
      var idx = cells[i];
      if (!Number.isInteger(idx) || idx < 0 || idx >= paletteLength) {
        return { ok: false, error: '存在越界颜色索引：' + idx };
      }
      seen[idx] = true;
    }
    for (var p = 0; p < paletteLength; p++) {
      if (!seen[p]) return { ok: false, error: '颜色索引 ' + p + ' 从未出现' };
    }
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var cur = cells[r * cols + c];
        var neighbors = [
          [r, (c + 1) % cols],
          [(r + 1) % rows, c]
        ];
        for (var t = 0; t < neighbors.length; t++) {
          var nr = neighbors[t][0], nc = neighbors[t][1];
          if (nr === r && nc === c) continue; // 1×1 自环退化
          if (cells[nr * cols + nc] === cur) {
            return { ok: false, error: '相邻格子同色：(' + r + ',' + c + ') 与 (' + nr + ',' + nc + ')' };
          }
        }
      }
    }
    return { ok: true };
  }

  return {
    LIMITS: LIMITS,
    hashSeed: hashSeed,
    mulberry32: mulberry32,
    validateInteger: validateInteger,
    validateSeed: validateSeed,
    validatePalette: validatePalette,
    minColors: minColors,
    checkFeasibility: checkFeasibility,
    baseColoring: baseColoring,
    evaluate: evaluate,
    generateCells: generateCells,
    buildManifest: buildManifest,
    hexToRgb: hexToRgb,
    renderToContext: renderToContext,
    validateGrid: validateGrid
  };
});
