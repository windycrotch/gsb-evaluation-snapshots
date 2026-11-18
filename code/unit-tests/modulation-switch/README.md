# FM/AM 开关路径本地验证（Sound Builder）

本目录用于验证 `code/sound/modulator-set.js` 中频率调制（FM）与幅度调制（AM）
开关的修复。所有音频对象都是 `fake-audio.js` 提供的**假 Web Audio 实现**：
不产生任何声音，但会完整记录每次 `AudioParam.value` 写入、参数调度调用和
`connect()` 连线，因此可以断言真实声音类（`Tone` / `Instrument` /
`ModulatorSet`）在各种开关先后顺序下的行为。

## 文件

| 文件 | 作用 |
| --- | --- |
| `fake-audio.js` | 假 `AudioContext` / `GainNode` / `OscillatorNode` / `BiquadFilterNode`，记录全部增益写入与连线 |
| `modulation-switch-tests.js` | 测试用例本体，浏览器与 Node 共用同一份测试函数 `runModulationSwitchTests()` |
| `modulation-switch-test.html` | 可直接在浏览器打开的验证页面 |
| `run-node-test.js` | Node 无头运行器，把**真实**的 `code/sound/*` 源码与假音频环境装入同一 VM 上下文执行 |

## 运行方式

### 方式一：浏览器（无需服务器、无需构建）

直接双击或在浏览器中打开：

```
code/unit-tests/modulation-switch/modulation-switch-test.html
```

页面会加载真实的声音源码和假音频环境，自动运行全部检查，并在页面表格和
浏览器控制台（`console.table`）中逐条显示 `PASS` / `FAIL`；顶部汇总为
`N/N checks passed` 即全部通过。`file://` 协议下可直接运行，没有跨域请求。

### 方式二：Node（无头，适合命令行/CI）

在仓库根目录执行：

```bash
node code/unit-tests/modulation-switch/run-node-test.js
```

全部通过时进程退出码为 0，并打印 `76/76 checks passed`；任一检查失败时
退出码为 1，方便脚本判断。

## 覆盖的四种要求情形

FM 与 AM 两条路径对称地各跑一遍：

1. **正常开关**：调制器已连接、主深度节点已建立后，关闭写入 0、再开启恢复
   关闭前保存的深度（如 FM 0.5 → 0 → 0.5）。
2. **关闭后连接**：在 `Instrument.data` 建立连线（即创建主深度增益节点）
   之前反复关闭/开启都不抛异常；之后才建立连接时，节点增益必须保持 0
   （保持关闭），再开启可正常恢复并继续可逆切换。
3. **重复关闭再开启**：第一次关闭时保存深度，连续第二次、第三次关闭不得把
   已保存深度覆盖成 0；重新开启后必须回到最初保存的深度
   （如 0.25 → 0 → 0 → 0 → 0.25）。
4. **未知 usage**：`Instrument.playWith` 收到 `0`、`255`、`undefined`、`-7`
   等未知位值时静默返回，不抛异常、不产生任何音频写入、不改动现有深度。

此外还固定验证了：

- `soundDefinitionSet.playControl.usage` 的八个位值保持不变
  （FM=1、AM=2、增益包络=4、失谐包络=8、FM 包络=16、AM 包络=32、
  滤波器=64、增益补偿=128），`playWith` 对这八种 usage 的分发均可观察
  （包络使能位、滤波器重新连线、增益补偿回退与恢复）。
- `Tone.play(on, frequency, dynamicGain)` 在 `on` 为真时先设置主振荡器频率
  与动态增益，然后按固定顺序触发四个包络：增益 → 失谐 → 频率调制 → 幅度调制；
  `on` 为假时四个包络同样被驱动，且缺省参数（`null`）回退到初始频率/单位增益。

## 预期结果

修复后的代码下，两种运行方式均显示全部检查通过：

```
76/76 checks passed
```

可通过临时还原修复前的 `code/sound/modulator-set.js` 对照观察：旧代码会在
“关闭后连接”各步抛出 `TypeError: Cannot read properties of undefined
(reading 'gain')`，且“重复关闭再开启”恢复出的深度为 0 而非保存值——这些正是
本测试要拦截的回归。
