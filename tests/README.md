# 音色生命周期修复的验证套件

本目录是对 `imports/` 下真实应用代码的集成验证，覆盖任务要求的六类验收场景。
Meteor 1.6（2018 年 EOL）在本环境无法安装运行，因此这里用 Node 24 直接加载
**未修改语义的真实应用模块**（`imports/api/*` 集合与方法、`imports/client/components/player/*`
播放器链路、`soundsWatcher`、`evalCode`/`prepareCode`、`MixTable`/`updateParamsInCode`
混音台写回链路），并为它们接上真实引擎：

- **真实 Tone.js r11**（`tone@0.11.11`，与应用 `package.json` 相同版本），
  由 `node-web-audio-api`（真实 Web Audio 实现）驱动，Transport 调度真实发生；
- **真实 Mongo 查询/更新语义**（`mingo`），外加 Meteor 的 `observeChanges`
  协议与 EJSON 克隆语义（`runtime/meteor/*`）——混音台写回经过
  `Meteor.call('tones.update')` → 集合 → `observeTones` → `window.tones` 完整链路；
- **真实 React 16 生命周期**（`react-test-renderer`）：Player 组件的
  mount / `componentWillReceiveProps` / unmount 真实触发。

被测代码没有任何 mock 或重实现；`runtime/` 只是运行环境（Meteor 包接口、
headless 音频与 DOM 环境），应用逻辑全部来自仓库源码。

## 运行

```bash
cd tests
npm install --legacy-peer-deps
npm test          # 8 个集成测试（场景 1-5）
npm run baseline  # 与改动前（git worktree，基线提交 f56c10e）的正常播放行为对照
```

`npm run baseline` 需要基线工作树存在：

```bash
git worktree add ../repo-baseline f56c10e
```

（路径可用 `BASELINE_REPO` 环境变量覆盖。）

## 覆盖的验收场景

| 文件 | 场景 |
| --- | --- |
| `01-normal-edit.test.mjs` | 正常编辑生效：添加→合法编辑替换→静音/取消→混音台写回到达播放实例 |
| `02-eval-failure.test.mjs` | 求值失败（语法/运行时/缺 c 变量）保留原声并显示错误，改回合法代码后恢复 |
| `03-concurrency.test.mjs` | 连续保存收敛到最后结果；跨窗口后到的旧快照被丢弃；静音/取消静音按最后操作 |
| `04-delete.test.mjs` | 删除后播放实例、持久化记录、混音台写回全部失效；残留记录被清理且不重建 |
| `05-unmount.test.mjs` | 卸载后已排定的启动/停止/清理任务不再执行；写回观察器停止 |
| `baseline/` | 同一正常播放流程在改动前/后两棵源码树上运行，14 项可观测行为逐一比对一致 |

## 实现要点（与测试对应）

- `imports/client/components/player/lifecycle.js`：版本（last-write-wins）、
  删除墓碑、播放器代际（卸载使已排定任务失效）三份生命周期状态；
- `imports/api/sounds.js`：`sounds.updateCode`/`sounds.toggleMute` 原子自增
  `version`，跨窗口也有全序；
- `imports/api/tones.js`：`tones.update`/`tones.insert` 拒绝已删音色并清理残留；
- `imports/client/components/player/sounds.js`：先求值校验、成功才替换；
  过期快照与已删音色的更新直接丢弃；
- `imports/client/components/player/tones.js`：调度任务携带代际、观察器返回
  handle 且对残留记录做清理；
- `Player.jsx`：卸载时停止观察器、`killPlayerTasks()` + `Transport.cancel(0)`。

注：基线源码通过 `runtime/hooks.mjs` 加载时仅应用三条机械兼容改写
（去掉 ESM 非法的顶层 `return`、为隐式全局变量补声明），不改变任何运行行为。
