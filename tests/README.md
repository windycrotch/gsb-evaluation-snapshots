# 本地拖入链路验证

本目录用于验证“把本地高斯/点云/场景文件拖进浏览器页面”的加载链路，覆盖格式判定、
PLY 点云/高斯分支、GLB 扩展识别以及不支持类型的负向用例。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `generate-samples.mjs` | 零依赖 Node 脚本，生成最小可解析的样例文件到 `samples/` |
| `local-drop.test.ts` | Node 内置 test runner 的纯逻辑自动化测试（17 个断言用例） |
| `local-drop-demo.html` | 浏览器验证页，模拟拖入并观察实际命中的渲染分支 |
| `samples/` | 生成出来的样例文件（由脚本生成，可随时重建） |

## 一、自动化测试（纯逻辑，无需浏览器）

```bash
# 1. 生成样例文件
node tests/generate-samples.mjs

# 2. 运行测试（Node 24 自带 TS 类型擦除，无需安装依赖）
node --experimental-strip-types tests/local-drop.test.ts
```

测试覆盖：

- `detectLocalFileKind`：`.spx/.splat/.ply/.spz/.sog/.zip/.glb/.scene.json` 的扩展名判定，
  大写后缀、不支持扩展名（负向）、单独 `.meta.json`（负向）；
- `inferModelFormatFromUrl`：URL 推断、查询参数、大小写，
  以及 `blob:` 地址**不会**被误报为未知格式（返回 `undefined`，由拖入链路在创建 blob 前定好格式）；
- `readPlyHeader + isPointCloudPlyHeader`：点云 PLY、CRLF 点云 PLY、高斯 PLY 的文件头分支判定；
- `detectGlbExtension`：`KHR_gaussian_splatting`、`..._compression_spz_2`、普通 GLB 三种识别。

## 二、浏览器验证（观察真实渲染分支）

```bash
npm run dev      # 默认 http://localhost:3100
```

然后打开：

```
http://localhost:3100/tests/local-drop-demo.html
```

页面左侧每个按钮调用 `viewer.handleDroppedFile(file)`——这与真实 `drop` 事件监听器
内部调用的是**同一个方法**。页面通过 `viewer.testHooks` 暴露的事件总线与 `splatMesh.addModel`
桩，记录每个样例实际命中的分支，并与“期望分支”自动比对。也可以把本地文件直接拖入页面做真实验证。

### 如何观察命中了哪条渲染分支

| 样例 | 日志中应出现的分支记录 | 含义 |
| --- | --- | --- |
| `point-cloud.ply` | `OnLoadAndRenderPointCloudPly … ← 点云渲染分支` | three `Points` 点云渲染 |
| `point-cloud-crlf.ply` | 同上 | 验证 CRLF 换行兼容 |
| `gaussian.ply` | `splatMesh.addModel(format=ply) ← 高斯渲染分支` | 3DGS 高斯渲染 |
| `gaussian-upper.PLY` | 同上 | 验证扩展名大小写不敏感 |
| `khr-gs.glb` | `splatMesh.addModel(format=splat)` | GLB 高斯扩展转 `.splat` 后渲染 |
| `khr-spz.glb` | `splatMesh.addModel(format=spz)` | GLB 抽出内嵌 spz 后渲染 |
| `standard.glb` | 仅 `viewer.addModel(format=glb)`，无 `splatMesh.addModel` | three `GLTFLoader` 网格渲染 |
| `demo.scene.json` | `viewer.addScene(...)` | 大场景流程 |
| `unsupported.txt` | **无任何加载调用**，并弹出错误提示 | 不 reset、不改当前场景 |

## 三、样例文件是怎么构造的

`generate-samples.mjs` 只生成“能被格式判定/文件头解析识别”的最小字节，不追求可被 WebGL
真实渲染（渲染分支用桩观察）：

- **点云 PLY**：ASCII 文件头声明 `property uchar red/green/blue` + 4 个点，
  每点 15 字节（3×float32 坐标 + 3×uchar 颜色）。命中点云判定的关键是同时存在 `red/green/blue`。
- **高斯 PLY**：文件头声明 3DGS 标准属性（`f_dc_0..2`、`scale_0..2`、`rot_0..3`、`opacity` 等），
  不含 `red/green/blue`，因此不会被判为点云，而走高斯分支。
- **GLB**：12 字节文件头 + JSON chunk（含/不含高斯扩展名字符串，按规范用 `0x20` 填充到 4 字节对齐）
  + BIN chunk。JSON 的 `extensionsUsed` 决定 `detectGlbExtension` 的识别结果。
- **负向样例**：`unsupported.txt` 纯文本，扩展名不在支持列表。
- **大场景样例**：`demo.scene.json` 是一个最小 scene 描述（其内部 `url` 为占位地址，
  仅用于验证它被路由到 `addScene`，不会真正拉取 LOD 数据）。

## 四、关键约束的验证点

1. **blob: 地址不再请求同名 `.meta.json`**：`Reall3dViewer.addModel` 中
   `if (!modelOpts.url.startsWith('blob:'))` 才探测 meta；自动化测试通过
   `inferModelFormatFromUrl('blob:...') === undefined` 保证 blob 地址不会触发“未知格式”误报。
2. **不支持类型不改场景**：`handleDroppedFile` 在 `detectLocalFileKind` 返回 `unsupported` 时
   直接 `return`，位于 `reset()` 之前；浏览器页第 ⑨ 个用例断言“无任何加载调用”。
3. **加载完成聚焦包围盒并重绘**：`focusLoadedModelAndRepaint` 对高斯 SplatMesh 轮询等待
   AABB 就绪后 `CameraSetLookAt`，对点云/网格用预计算的 `boundingBox`，随后 `ViewerNeedUpdate` 重绘。
