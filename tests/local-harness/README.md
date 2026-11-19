# 本地自造样例：启动状态机 + Service Worker 验证

这个目录用一个最小 mock 站点驱动**仓库里的真实生产代码**
（`src/run.js`、`src/splashScreen.html`、`src/splashScreen.css`、
`serviceWorker.js`），验证启动链路的可观察性、可重试性、单次执行，
以及离线缓存的配合。

## 组成

| 文件 | 作用 |
| --- | --- |
| `build-site.mjs` | 把真实源文件做 `{{GSDAW-VERSION}}` 占位符替换后组装到 `runtime/`，并生成缺失子模块（gs-utils、gswaContext、GSDAW、assets）的 mock |
| `server.mjs` | 静态服务器，带一次性故障注入端点（`POST /__control/fail`、`POST /__control/clear`） |
| `run-tests.mjs` | 用 Playwright 驱动真实 Chromium 的端到端测试，覆盖下列 5 个场景 |
| `runtime/` | 生成的 mock 站点（git 忽略） |

## 前置

- Node.js ≥ 18（开发环境验证于 Node 24）
- 首次运行需要安装依赖与 Chromium：

```bash
cd tests/local-harness
npm install
npx playwright install chromium
```

## 一键运行

```bash
node run-tests.mjs
```

退出码为 0 表示全部通过；每个断言都会打印 ✓/✗。

## 场景与预期结果

### 1. 采样库脚本加载失败 → 从失败阶段重试成功

**自动化步骤**：打开 `?nosw=1` 页面 → 注入一次性
`gsuiLibrarySamples` 500 故障 → 点击启动 → 点 Retry。

**手动复现**：

1. `node build-site.mjs && node server.mjs`，浏览器开
   `http://localhost:8123/?nosw=1`
2. DevTools Console 执行
   `window.__gs.fail["gsuiLibrarySamples"]="simulated HTTP 500"`
3. 点 `[ click to start ]`，再点错误面板里的 `Retry`

**预期**：

- 启动中按钮禁用，依次显示 `Resuming audio...` →
  `Loading sample library...`；失败后进入 error 状态，面板显示
  失败阶段 `Loading sample library` 与错误信息 `simulated HTTP 500`，
  按钮恢复可用
- `window.__gs.resumeCalls === 1`：重试**不会**重新执行已成功的
  resume 阶段，阶段事件序列为
  `resume, samples, samples, wavetable, init`
- 采样库与波表各只加载一次，GSDAW 只构造/初始化一次；成功后启动页移除

### 2. 连续快速点击只跑一条链路

**手动复现**：打开 `?nosw=1`，Console 执行
`for (let i=0;i<5;++i) document.querySelector("#splashScreen > div > button").click()`

**预期**：`resumeCalls`、GSDAW 构造与初始化次数均为 1，两个启动脚本
各加载一次，4 个阶段事件各出现一次。进行中按钮处于 disabled，后续点击
被状态机的 `chain` 守卫直接忽略。

### 3. 离线刷新

**手动复现**：打开 `http://localhost:8123/`（不带 nosw），等 SW 激活、
缓存 `daw-<version>` 填满（Application → Cache Storage 可见）；
DevTools → Network 勾选 Offline → 刷新页面 → 点启动。

**预期**：离线状态下页面与全部预缓存资源由 SW 的 fetch 回退返回，
四个阶段全部成功，启动页正常移除，GSDAW 初始化一次。

### 4. 版本号变化后旧缓存清理

**手动复现**：

1. `node build-site.mjs 2.60.2` 后访问站点，确认存在
   `daw-2.60.2` 缓存
2. `node build-site.mjs 2.61.0-testB` 重新生成站点，刷新页面并在
   Console 执行
   `navigator.serviceWorker.ready.then(r => r.update())`
   （显式触发更新检查，绕过浏览器的更新节流）

**预期**：新 SW 安装后出现 `daw-2.61.0-testB`；激活后
`daw-2.60.2` 被删除，Cache Storage 中只剩新版本一个 `daw-*` 缓存。

### 5. 预缓存失败不留半成品

**手动复现**：重新构建一个新版本后，删除
`runtime/assets/fonts/inconsolata-400-latin.woff2`（使一个预缓存
URL 返回 404），刷新并触发 `registration.update()`；观察 Cache
Storage；把文件恢复后再刷新一次。

**预期**：`cache.addAll` 因 404 reject，安装回调立即
`caches.delete(CACHE_NAME)`，不存在任何新版本缓存；资源恢复后的下一次
安装从零开始并成功，缓存条目完整。

## 与生产构建的差异（仅限 harness）

- mock 站点的 `run.js`、`mock-utils.js` 以独立脚本提供（真实构建会把
  应用代码打进 `index.html`），因此构建器会把这两个 URL 注入运行时
  SW 的 `PRECACHE_URLS`，使离线刷新场景成立；生产 `serviceWorker.js`
  本身不包含这两项
- SW 脚本响应附带 `Cache-Control: no-store`，保证重新构建后字节比对
  能立即发现更新（生产环境对 SW 脚本同样应如此配置）
- mock 的 `GSUloadJSFile` 通过真实 `<script>` 标签发网络请求，因此
  SW 缓存与离线回退被真实执行；浏览器的脚本 onerror 不暴露 HTTP
  状态码，场景 1 的错误文案通过 `window.__gs.fail` 在客户端注入
