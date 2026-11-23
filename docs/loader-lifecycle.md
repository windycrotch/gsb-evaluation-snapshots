# PLY / SPLAT 加载生命周期与会话隔离

本文说明 PLY（`PlyLoader`）与 SPLAT（`SplatLoader`）两条加载链路在统一生命周期下的状态语义、
会话隔离机制、包围盒口径，以及如何用本地测试与浏览器样例观察结果。

## 1. 统一的生命周期

每次调用 `loadPly(model)` / `loadSplat(model)` 都会通过 `LoadSession.start(model)`
开启一个**新的加载会话**（`model.loadSessionId` 递增），并先把所有可变加载状态重置为干净初值：

| 状态/数据 | 重置结果 |
| --- | --- |
| `status` | `Fetching`，并安装新的 `AbortController` |
| `downloadSplatCount` / `dataSplatCount` / `watermarkCount` / `renderSplatCount` | `0` |
| `splatData` / `xyz` | `null`（按点数重新预分配） |
| `sh12Data` / `sh3Data` / `sh12Count` / `sh3Count` / `palettes` | 空数组 / `0` / `undefined` |
| `minX..maxZ` | `Infinity / -Infinity`，`aabbCenter = null` |
| `abortReason` / `fetchLimitReached` | `None` / `false` |

因此**失败后再次加载、取消后重试、重复加载同一模型都不会残留上一次的计数、SH 数据或包围盒**。

### 终态如何区分

加载结束只有三种终态，由 `LoadSession.resolveTerminalStatus` 统一裁决：

| 触发方式 | `abortReason` | 终态 `ModelStatus` | 已解析数据 |
| --- | --- | --- | --- |
| 文件自然读完 | `None` | `FetchDone` | 保留全量 |
| 达到 `fetchLimit` 主动中止 | `FetchLimit` | **`FetchDone`**（带 `fetchLimitReached=true`） | **保留已解析子集** |
| 用户调用 `model.cancelLoad()` | `UserCancel` | **`FetchAborted`** | **全部丢弃** |
| 网络/解析异常 | `None` | `FetchFailed` | 丢弃 |

关键区别：达到限流是一次“成功的部分加载”，状态是完成而不是中止；用户取消才是 `FetchAborted`，
并由 `discardPartialData()` 清空 `splatData`、SH、计数与包围盒。

### 会话隔离（迟到分片不得写入新会话）

- 每个分片在真正写入前都检查 `session.isCurrent()`（即 `model.loadSessionId === session.id` 且未结束）。
- 同一模型被重复触发加载时，旧会话的 `AbortController` 被中止，其异步分片（含 PLY 的 SH 解析结果）
  在 `await` 之后会因为会话已切换而被直接丢弃，**不会写入新会话的 `splatData`、SH 数组或包围盒**。

## 2. 包围盒口径

`writeSplatData()`（`loaders/LoadSession.ts`）是两条链路唯一的写入入口：

1. 先按 `min(fetchLimit, modelSplatCount)` 截断本分片，**超出限制被丢弃的行不参与任何计算**；
2. 只把实际 `set` 进 `model.splatData` 的行用于 `min/max` 累计；
3. 再由这些行更新 `aabbCenter`、`maxRadius`、`currentRadius`。

因此：

- 当 `fetchLimit < 模型总点数` 时，完成态包围盒只覆盖**已加载子集**（例如总点数 200、限流 60，
  `maxX` 只会到第 59 个点的坐标，而不是第 199 个）；
- 用户取消后包围盒回到 `Infinity / -Infinity`，`SetupDataManager.updateBoundBox` 也会因
  `minX` 非有限值或 `dataSplatCount === 0` 而跳过上屏，避免把无效包围盒传给渲染层。

## 3. 本地自动化测试

无需浏览器，使用 Node 内置 test runner（通过 `tsx` 运行 TS）：

```bash
npm install
npm test
```

覆盖 14 个用例（PLY 与 SPLAT 各一组 + 样例服务器联调）：

| 场景 | 观察点 |
| --- | --- |
| 正常加载 | `status=FetchDone`，点数/计数等于总点数，包围盒覆盖全量 |
| 达到 `fetchLimit` | `status=FetchDone` 且 `fetchLimitReached=true`，计数=限流值，包围盒只反映子集 |
| 用户取消后重试 | 先 `FetchAborted`、数据与包围盒被清空；重试后 `loadSessionId` 递增、计数不翻倍 |
| 失败后重试 | 先 `FetchFailed` 且无残留；重试后 `FetchDone`，包围盒正确 |
| 两个会话交错 | 旧会话迟到分片被丢弃，新会话数据/包围盒只来自第二次加载 |
| 重复加载 | 两次加载后 `dataSplatCount` 仍等于总点数，包围盒一致 |

测试用的可控 `fetch` 实现在 `test/mockFetch.ts`：用真实 `ReadableStream` 按固定字节数分片投递，
中止信号会让流立即以 `AbortError` 报错，与浏览器行为一致；PLY/SPLAT 测试数据由
`buildPlyFile` / `buildSplatFile` 在内存生成，坐标可预测（`x=i, y=10i, z=100i`），
便于直接断言 min/max。

## 4. 浏览器交互样例

```bash
npm run dev
# 打开 http://localhost:3100/demo/loader-lifecycle.html
```

页面顶部可选择格式（.ply/.splat）、总点数与 `fetchLimit`，按钮对应各生命周期：

1. **Normal load** —— 限流 ≥ 总点数的完整加载；
2. **Load until fetchLimit** —— 主动中止，观察状态仍为 `FetchDone`、`fetchLimitReached=true`、
   包围盒停在子集；
3. **Start load → cancel mid-flight** —— 30ms/片的慢速流，可在中途点击取消，观察 `FetchAborted`
   与数据清空；
4. **Retry after cancel** —— 同一模型实例干净重试；
5. **Fail (HTTP 500)** / **Retry after failure**；
6. **Interleaved sessions** / **Load twice** —— 会话交错与重复加载计数。

下方面板每 100ms 刷新一次，实时显示 `status`、`loadSessionId`、`abortReason`、
`fetchLimitReached`、各项计数、SH 块数量以及包围盒 min/max 与 `aabbCenter`，
可直接对照第 1、2 节的语义表核对。

## 5. 涉及的文件

- `src/reall3d/modeldata/ModelData.ts` —— 新增 `FetchAbortReason`、会话/中止字段与 `cancelLoad()`
- `src/reall3d/modeldata/loaders/LoadSession.ts` —— 会话生命周期、干净重置、统一写入与包围盒计算
- `src/reall3d/modeldata/loaders/PlyLoader.ts` / `SplatLoader.ts` —— 接入会话隔离与统一终态
- `src/reall3d/modeldata/SetupDataManager.ts` —— 取消后无效包围盒/空数据不上屏
- `test/`、`demo/loader-lifecycle.html`、`demo/loader-lifecycle-data.ts` —— 测试与样例
