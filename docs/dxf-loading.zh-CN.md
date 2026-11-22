# DXF 加载一致性：编码、图层可见性与实体颜色

本文档说明 `DxfLoader` 在三条容易互相干扰的路径上如何给出一致、可解释的结果，以及如何验证。

## 文本编码

`decodeDxfText(bytes, dxfEncoding?, warnings?)` 按以下顺序决策：

1. 显式 `dxfEncoding` 选项（最高优先级；若解码出现 U+FFFD 会追加警告）。
2. BOM（UTF-8 / UTF-16LE / UTF-16BE）。
3. 合法 UTF-8 字节 +（声明 UTF-8 代码页 或 AC1021 及更新版本）→ UTF-8。
4. 文件头 `$DWGCODEPAGE` 声明的代码页。
5. 无声明时，在 `windows-1252 / gb18030 / big5 / shift_jis / euc-kr / iso-8859-1` 中按评分（替换字符、控制字符、CJK 覆盖率、DXF 结构完整性）选择最佳解码。

**声明与字节不符时的回退**：若声明的代码页解码后出现 U+FFFD 替换字符，说明声明与实际字节不符。加载器依次尝试：合法 UTF-8 → 评分最高的 legacy 候选（要求替换字符更少且无控制字符）。无法可靠判定时，保留声明代码页的解码结果，并在 `document.warnings` 中追加一条可读警告（指明代码页与替换字符数量），绝不静默产出乱码。所有候选编码均兼容 ASCII，因此无论选择哪条路径，DXF 组码与 section 结构都可解析。

## 图层可见性

- 图层表同时来自 `dxf-parser` 与有界元数据补扫（`DxfBomSupplement`），二者都以原始 62 组码为准：负颜色号 → `isVisible: false`，颜色取绝对值。
- 被关闭的图层**仍保留在** `document.layers` 中（含颜色、线型、线宽、冻结/锁定标记），只是 `layerVisible(layer)` 返回 `false`。
- 渲染器（Canvas2D 与 WebGL）对不可见图层上的实体整体跳过，不会以正常颜色绘制；实体数据（颜色、真彩色、几何）在文档中完整保留。

## 实体颜色优先级

`resolveCadColor` 的既有优先级：显式 CSS 颜色 → 真彩色（420 组）→ ACI 索引（62 组）→ 数值 `color` → 图层颜色。

`dxf-parser` 会把 62 组（ACI）和 420 组（真彩色）都改写进同一个数值 `color` 属性，归一化时无法区分。为此元数据补扫会按 handle（或无 handle 时按 section+类型+顺序定位）读取原始 62/420 组码并校正归一化实体：

- 源记录含 420 → `entity.trueColor` 以源为准（真彩色优先于 ACI，且不因图层关闭而丢失）；
- 源记录不含 420 → 删除由 ACI 派生的伪 `trueColor`，恢复 ACI 语义（特别是 ACI 7 的前景色自适应）。

内置 fallback 解析器只读取真实 420 组，因此两条解析路径产出一致的颜色。

## 加载隔离

`DxfLoader` 不保存任何跨加载状态：编码判定、图层表、实体归一化全部基于当次输入的字节。同一字节内容重复加载、并发加载不同编码的文件、加载失败（如输入缺失或主解析器抛错进入 fallback）后重试，结果均一致。回归测试锁定这一性质。

## 验证

```bash
npm run build:lib          # 构建 dist（测试直接引用 dist/cad-viewer.es.js）
node --test test/*.test.mjs
```

重点回归文件：

- `test/dxf-load-consistency.test.mjs` — 编码回退与警告、关闭图层、真彩色优先级、主/fallback 解析一致性、重复/并发/失败重试隔离；所有 DXF 样例均由测试内联构造（`dxfWithText` / `dxfWithLayers`），无需外部文件。
- `test/dxf-text-decoding.test.mjs` — 既有编码矩阵（BOM、版本规则、显式覆盖、转义序列）。
- `test/dxf-layer-table.test.mjs` — 既有图层表归一化（负颜色号、冻结/锁定、真彩色图层）。
