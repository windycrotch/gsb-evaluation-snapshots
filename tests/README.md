# 本地测试说明（无摄像头 / 无 GPU）

本目录的测试覆盖「断流重连 → PTS 对齐 → 跟踪续轨 → 长时运行有界」整条链路的
协同逻辑，全部可在普通开发机上运行，不依赖 RTSP 摄像头、NVDEC/GPU 或 TensorRT。

## 运行方式

```bash
# 仓库根目录下
python -I -m pytest tests/ -q
```

`-I`（isolated 模式）保证只从仓库目录导入，避免环境中同名包污染。
`conftest.py` 会把仓库根目录加入 `sys.path`，无需 `pip install`。

唯一的第三方依赖是 `lap`（ByteTrack 线性分配）：`pip install lap`。

## 测试文件与验收项对照

| 测试文件 | 覆盖的验收项 |
| --- | --- |
| `test_pts_align.py` | 正常连续帧 pts 正确；断流重连/源 pts 回退/跳变后仍单调、间隔接近标称帧率；标称间隔长期不漂移 |
| `test_frame_buffer.py` | 尺寸不变复用同一块存储；跨帧持有旧帧读到被覆盖内容（显存复用所有权语义） |
| `test_stub_decoder.py` | 断流重连、连续异常帧触发重拉、重连次数预算、PTS 单调、缓冲分配次数 |
| `test_tracker_resume.py` | 重连后轨迹编号延续（`on_stream_resume`）；超时丢失轨迹清理；`removed_stracks` 有界；多路实例 ID 互不串号 |
| `test_pipeline_integration.py` | 协调层端到端：正常帧、断流续轨、坏帧重拉、8 路并发互不串扰、缓冲覆盖语义、非单调 pts 防御 |
| `test_long_run_bounded.py` | 数千帧长时运行：三张轨迹表有界、pts 无累积漂移、缓冲分配次数恒定、反复断流状态不膨胀 |

## 桩（stub）与生产链路的差异

测试用 `streaming/` 包中的纯 Python 组件替代原生 `cpp` 扩展。两边在**状态机语义**
上保持一致，但以下方面桩**不**等价于生产实现，不能用桩的性能/行为推断线上表现：

| 维度 | 生产链路（`cpp/Decoder.cpp` + NVDEC） | 测试桩（`streaming/`） |
| --- | --- | --- |
| 解码 | FFmpeg + NVDEC 硬件解码，H.264/H.265 码流、B 帧重排、码流容错 | 不解码，按脚本直接生成确定性 numpy 帧 |
| 帧存储 | CUDA 显存（`bgr_buf_`/`resized_buf_`），NPP 做 NV12→BGR 与缩放 | 宿主内存 numpy 数组；复用/覆盖/重分配的**所有权语义一致** |
| 重连触发 | `av_read_frame` 超时、`avcodec_receive_frame` 错误、连续 5 帧 NPP 异常等真实故障 | `StreamScript` 脚本事件（`outage`/`bad`/`pts_jump`/`pts_reset`） |
| 重连耗时 | 真实 `reconnect_delay_ms` 睡眠 + RTSP 建链/打开超时（秒级） | 立即成功，不睡眠 |
| PTS 对齐 | `Decoder::align_pts`（C++） | `streaming/pts_align.py::PtsAligner`，**同一套规则**：只看相邻 delta、异常钳制、重连保留输出轴 |
| 时间戳来源 | 帧的 `best_effort_timestamp × time_base`，可能缺失/回退/跳变 | 按帧号合成，可脚本化注入回退/归零/跳变 |
| 检测/推理 | TensorRT 引擎（`YOLO26DetTRT`），输出真实检测框 | 固定合成检测框，只用于驱动跟踪器状态流转 |
| 编码推流 | libx264 + RTMP/RTSP 封装（`cpp/Encoder.cpp`） | 测试不涉及编码；pts 单调性在进入编码器前已被断言 |
| 并发模型 | 多进程（`mp.Process` + spawn），每进程独立 CUDA 上下文 | 同进程多实例 + 线程池，验证的是**实例级状态隔离**（ID 计数器、轨迹表、解码器状态） |

### 语义一致性是如何保证的

1. **PTS 对齐**：`PtsAligner`（Python 参考）与 `Decoder::align_pts`（C++）按同一
   规则实现——标称间隔为不可变常量、只依赖相邻帧 delta、异常 delta 钳回标称值、
   重连只复位源基准而保留输出轴。C++ 侧旧的 EMA 漂移逻辑已按参考实现移除。
2. **缓冲复用**：`ReusableFrameBuffer` 与 C++ `reusable_buf()` 同样在「尺寸匹配」
   时返回同一存储、尺寸变化时重新分配；覆盖语义由 `test_frame_buffer.py` 固化。
3. **重连协同**：桩与生产 Decoder 都暴露 `consume_reconnect()` 边沿接口，
   `StreamCoordinator` / `main.process_one_frame` 用同一种方式消费它并调用
   `tracker.on_stream_resume()`。
4. **跟踪器**：测试直接使用生产代码 `bytetrack/fast_byte_tracker.py`（不是桩），
   因此续轨、超时清理、ID 分配的行为与线上完全一致。

### 桩无法覆盖、需在真机/集成环境验证的部分

- NVDEC 帧池深度（`surfaces`）与 NPP 异步流的实际显存行为；
- 真实网络抖动下 RTSP 建链耗时、TCP 重传对到达间隔的影响分布；
- 编码器 `Encoder::encode` 内部对 pts 的取整与 0 时长帧防御；
- 多进程 + MPS 下的 CUDA 上下文隔离与显存上限。
