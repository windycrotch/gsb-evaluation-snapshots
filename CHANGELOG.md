# Changelog

格式：平台差异说明见 scripts/changelog_gen.py（发版草稿自动生成入口）；
本文件为按版本手校的汇总，发版时以生成器草稿为准微调。

## 未发布

- HLS 续传安全化：进度文件新增逐片长度与内容摘要（sha256），仅当「已提交分片数/字节数与目标文件真实大小一致、逐片长度自洽、摘要吻合」才续传；指纹（分片 URI / 密钥 URI·IV / BYTERANGE）变化、目标文件缺失/大小不符/被改写、进度越界一律清掉旧文件全量重下，杜绝「能播放但内容错位」的拼接视频
- HLS 失败收尾：任一分片重试后仍失败即返回 None，已落盘内容保证是从第 0 片开始的连续前缀，进度文件与之对齐可安全续传；全部成功才删除进度，进度写入改为临时文件 + 原子替换
- HLS 提交修复：写盘失败时截回上一个已提交位置，且不再在写盘重试中重复排队等待自己的提交（原实现会互等卡死）

## 1.0.9（2026-08-20）可观测性批

- 定时真实冒烟：GitHub Actions cron 每天对抖音/快手/B站真实页面跑「渲染→接口捕获→提取」链路，页面能加载但提取 0 资源自动开 issue（治"无声坏掉"）；传输层失败仅警告不误报
- 适配器单测化：4 平台 fixture JSON 喂 extract()，无需网络/浏览器，CI 直接可跑（unit_adapters）
- API 任务取消：POST /api/cancel 协作式取消（discover 立即停队列、download 停新分片）；任务状态新增 cancelled
- 每域名限速：RESOURCES_PER_HOST_INTERVAL（默认 0.05s/域名/请求）软限流，下载并发不再无约束打爆单站点

## 1.0.8（2026-08-20）无头化批

- CLI（headless）：`webscoop discover / download / follow add|list|remove|clear|run / serve / doctor / gui`，不依赖 tkinter，为 Docker/服务器铺路
- REST API（127.0.0.1 仅回环、可选 token）：`POST /api/discover`、`POST /api/download`、`GET /api/tasks[/{id}]`、`GET /api/stats`、`GET /api/health`；stdlib 实现零新增依赖；供 iOS 快捷指令/脚本批处理
- 无头核心 headless.py：任务注册表（排队/运行/完成/失败 + 进度），CLI 与 API 共用
- pyproject 入口调整：`webscoop`=CLI，`webscoop-gui`=GUI；新增模块入 py-modules
- README 首屏重排：定位一句话 → 功能 → 截图 → 下载 → 三种使用方式

## 1.0.7（2026-08-20）质量门禁批

- 依赖锁定：requirements.txt 全量精确锁定并实测核实（scrapy 2.17.0 / requests 2.34.2 / beautifulsoup4 4.15.0 / Pillow 12.3.0 / scrapling 0.4.14 / curl_cffi 0.16.0 / python-vlc 3.0.21203 / gallery-dl 1.32.9 / pycryptodome 3.23.0 / playwright 1.62.0）
- 类型检查：mypy 渐进式落地，7 个核心模块 strict（proxy / cookies / secret_store / kvjournal / download_archive / dead_list / format_selector）
- 覆盖率：.coveragerc 全量单测 31.3%，CI 门槛 30%
- CI 流水线：ruff → compileall → mypy 白名单 → 单测+覆盖率 → 本地 e2e
- 社区文档：CONTRIBUTING.md、Issue 模板（bug/feature）、PR 模板

## 1.0.6（2026-08-19）安全加固批

- 密钥落盘：API Key / LLM 配置 DPAPI（Windows）加密、POSIX 0600；cookies.txt 明文但限权；RESOURCES_SECRET_PLAINTEXT 逃生门
- HLS：FetchSession 上下文管理 + 每线程会话池，修复会话泄漏；AES 密钥缓存 TTL 6h、上限 128
- 代理池：上限可配（RESOURCES_PROXY_POOL_MAX，默认 200）
- 机器人存档：kvjournal（JSONL + 容量上限循环清理），下载存档 / 死链表不再全量重读
- 安全防线：LLM 正则 ReDoS 拒绝（超长/嵌套量词）、URL 模板路径穿越防护
- 修正并发文档：CONCURRENT_REQUESTS_PER_DOMAIN 实际为 6

## 1.0.5（2026-08-19）代理与格式标准化批

- 代理池：加权选择（延迟采样）+ 失败吊销 + 站点出口绑定 + 后台周期探活、GUI 代理设置弹窗
- 格式：多清晰度 formats 标准化（douyin 等→统一择优，FORMAT_SELECT_SPEC 可配）
- 视频修复：签名 CDN 直链播放（弃用需 Cookie 端点）+ 禁硬件解码兜底；gallery-dl 自动补站
- 文档：path_regex 文档化；README 精简并加 Release 下载入口
- 打包：PyInstaller spec（含图标）、--doctor 无头自检、定时跟进、B站搜索/抖音热榜

## 1.0.4（历史版本）

- 更早的发布版本（变更明细未归档，见各 Release 说明）