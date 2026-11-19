# 首帧过渡 / 画质档位 / 显示模式 的协调机制

本文说明 `SplatFlowCoordinator`（`src/reall3d/meshs/splatmesh/SplatFlowCoordinator.ts`）如何把三条原本互相踩踏的流程收口，以及如何在本地验证。

## 背景问题

| 现象 | 根因 |
|------|------|
| 首帧光圈过渡未结束时拖动画质档位，模型闪烁 / 短暂全黑 | 过渡动画与档位切换各自直接改写 `currentVisibleRadius`、`shDegree`、`min/maxPixelDiameter`、`minAlpha`，后写覆盖先写 |
| 过渡动画在切档位后仍在推进 | 帧循环仅检查自身 `stop` 标志，没有感知档位变化 |
| 快速切换正常 / 点云显示模式，出现多次完成回调或半途卡住 | 每次触发都新开帧循环或 `setTimeout`，旧流程只被标记 `stop`，延时任务无法取消 |
| 关闭页面后残留定时器与纹理写入 | 纹理逐层上传是异步的，销毁后 `await` 继续访问已释放的 `image.data`；延时任务无登记无法清除 |

## 收口方案

事件入口完全保留：`SplatMeshCycleZoom`、`SplatMeshSwitchDisplayMode`、`OnQualityLevelChanged`、`SplatMeshDispose`。`SetupSplatMesh` 只做转译，实际调度交给协调器。

### 1. 首帧过渡（`runFirstFrameTransition`）

- 每次启动都会取代仍在推进的旧过渡。
- 过渡帧循环带有会话标识（`FlowSession.active`），被取代后帧回调立即返回且不再续帧。
- 自然完成时：`visibleRadius → 0`（稳定态）→ 按**当前**档位重放参数 → 触发一次完成回调。点云模式下改为经 `SplatMeshSwitchDisplayMode` 继续光圈切换，完成回调由该链路负责。

### 2. 画质档位（`onQualityChanged`）

- 正在推进的过渡立即**收敛**：`visibleRadius → 0`，动画不再推进（`FlowSession.converged`）。
- 随后以新档位参数为准写入：SH 阶数、最小 / 最大直径像素、透明度阈值、近似计算开关。
- 数据已就绪时立即收尾并触发一次完成回调；数据未就绪时保持稳定态等待，避免过早清空纹理造成黑屏。
- 收敛后的过渡不会被旧动画再次改写参数——帧回调在 `converged` 状态下不写任何着色器参数。

### 3. 显示模式（`switchDisplayMode`）

- 新触发先终止旧切换（帧循环停止、延时任务 `clearTimeout`），确保“最后调用的优先响应”。
- 被取代的流程不会触发完成回调；最终只有一条链路收尾。
- 首帧渐显若仍在推进，会先收敛（`visibleRadius → 0`），由显示模式切换接管收尾。

### 4. 球谐阶数仲裁（`ShDegreeArbiter`）

`SplatUpdateShDegree` 需要 `await GetModelShDegree` 夹取上限，异步完成后可能乱序落盘：

- 优先级 0：加载期推断（数据下载完成、调色板到达）。档位显式生效后不再改写阶数，只触发一次按最新上限重放显式阶数。
- 优先级 1：画质档位推导（`OnQualityLevelChanged`）。
- 优先级 2：用户显式指定（`Reall3dViewer` 的 SH 调档接口）。
- 序列号保证最后一次显式写入一定生效，乱序的旧写入被丢弃。

### 5. 纹理上传与资源释放（`SplatTexturePump` / `SplatGpuCache`）

- 逐层上传统一走 `pumpTextureLayers`：每层前检查 `isAborted()`，已销毁时不写 `needsUpdate`、不挂 `onUpdate`。
- 等待 GPU 回传期间若销毁，`onAbort` 立即唤醒挂起的 `Promise`，不会悬挂。
- `SplatGpuCache` 同样带中止订阅；销毁后不再推进 offset、不再触发 `OnSplatLodFullUploaded`。
- `SetupSplatMesh` / `SetupDataManager` 内的所有 `setTimeout` 都登记在 `pendingTimers`，`SplatMeshDispose` / `SplatDataManagerDispose` 时统一 `clearTimeout`，销毁后不再安排新任务。

## 本地验证

### 单元 / 集成测试

```bash
npm install
npm test
```

覆盖的文件：

- `test/splatFlowCoordinator.test.ts`：过渡正常完成、过渡中切档位、快速连切显示模式、销毁、数据未就绪时的收敛、球谐仲裁乱序。
- `test/setupSplatMesh.integration.test.ts`：经真实事件通道驱动 `setupSplatMesh`，验证入口保留、收敛、唯一完成回调、销毁无残留。
- `test/splatTexturePump.test.ts`、`test/splatGpuCache.test.ts`：异步上传中止与销毁。

### 浏览器示例

```bash
npm run dev
# 打开 http://localhost:3100/demo/transition-quality-demo.html
```

面板按钮与验证点：

| 按钮 | 验证点 |
|------|--------|
| ① 重播首帧过渡 | 正常过渡完成，参数最终与当前档位一致 |
| ② 切换显示模式 | 单次切换，完成回调一次 |
| ③ 快速连点切换 ×5 | 只保留最后一次，无重复回调 |
| ④ 过渡中连切档位 ×4 | 参数以最新档位为准，旧动画不再改写 |
| ⑤ 销毁 | 无残留帧回调、无纹理写入 |
| ⑦ 无过渡重载 | 小场景关闭特效直接进入稳定态 |

右侧日志每 1.2 秒采样一次着色器参数，可直接观察 `visibleRadius / lightRadius / shDegree / minPixelDiameter / maxPixelDiameter / minAlpha` 是否被旧动画改写。
