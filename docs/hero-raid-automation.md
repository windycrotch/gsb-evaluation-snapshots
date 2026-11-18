# 超凡英雄活动：功能与协议依据

核对日期为 2026-11-17。依据本机微信版本 76 的主包 `HeroRaidPanel`、`HeroRaidOrderPanel`、`HeroRaidLotteryPanel`、`HeroRaidUtil`、活动模型和配套 protobuf 类型。使用真实协议与离线假客户端回归，线上执行效果待实测。

## 对照结果

入口统一位于 **活动 → 超凡英雄活动**，页面归入周期活动，未开放入口、当前期次和历史记录使用同一分类。支持未连接、活动未开放和挂机暂停时预先配置。修改按账号自动保存，已有订单与奖励选择继续使用。活动开放后随挂机执行，详情展示已通过关卡、订单与累计抽奖进度。

支持以下配置。

- `heroRaid.enabled` 控制整个模块，关闭时保留全部子项选择。
- `heroRaid.challenge` 自动挑战下一关，默认关闭，每轮每个活动最多挑战一次。
- `heroRaid.retryTimes` 为同一期活动、同一关卡首次挑战后的额外战败重试次数，默认 10，允许 0–100。设为 0 时仍会首次挑战。已确认战败次数持久保存，下一关单独计数，调高上限可继续当前关卡。
- `heroRaid.orders` 自动完成已解锁且库存足够的当前活动订单，每轮每个活动最多一单。缺料进入工厂已有 `heroRaid` 需求来源，由工厂总开关和按需生产策略处理。
- `heroRaid.lottery` 自动转盘抽奖，默认关闭，每轮每个活动根据已有英雄副本抽卡券执行 1 次或 10 次抽取。
- `heroRaid.rewards` 分别领取已经达标的累计订单奖励、累计抽取奖励，沿用已有默认开启的选择。
- 工厂需求仅在总开关和订单开关均开启、活动实际开放且订单没有未知写入时生成。重复材料先合并计算，达最终订单后停止备料。

转盘使用 `HERO_RAID_ITEM = 英雄副本抽卡券`。客户端 `_onBtnGo` 先检查券库存，再发送 `{raidId,times}`。自动抽奖的授权范围为现有券库存，实际消费前重新核对库存与资源保留量。

## 实际数据和协议

| 动作／状态 | 实际协议 | 关键证据 |
| --- | --- | --- |
| 登录全量活动 | `SCAllActivity.raid[]` | 活动模型 `_onSCAllActvity` 用其替换当前英雄活动列表 |
| 新开放单项 | `SCHeroRaidOpen.raid` | 活动模型加入新的 `DispHeroRaid` |
| 当前活动 | `DispHeroRaid` | `raidId/startTime/finishTime/passedStage/order/drawTimesInfo`，时间以服务端偏移校准 |
| 挑战下一关 | `HeroRaidChallengeRequest({raidId,stageId})` → `HeroRaidChallengeResponse` | 核对活动、关卡和战斗数据，按客户端使用 `reward` 判断通关 |
| 转盘抽奖 | `HeroRaidPrizeRequest({raidId,times})` → `HeroRaidPrizeResponse` | 核对累计抽取进度和奖励回执 |
| 完成当前订单 | `HeroRaidFinishOrderRequest({raidId})` → `HeroRaidOrderResponse` | 回执同时返回新 `order` 和 `reward` |
| 领取累计订单奖励 | `HeroRaidGotOrderRewardRequest({raidId})` → `HeroRaidOrderResponse` | `HeroRaidOrderRewardCfg.orderCount <= gotOrderId` 且 `orderCount > gotTimes` |
| 领取累计抽取奖励 | `HeroRaidGotRewardRequest({raidId})` → `HeroRaidGotRewardResponse` | `HeroRaidLotteryTimesCfg.reqTimes <= times` 且 `index > gotIndex` |

没有独立 `HeroRaidInfoRequest`。因此不能通过虚构的读取接口「刷新活动」，也不能仅凭配置表推定活动已经开放。`watchHeroRaidPushes` 必须在登录前注册，只使用当前连接收到的完整推送以及经过校验的本模块回执；断开或重新登录清空旧状态。

`HeroRaidOrder.orderId` 为当前单号，`gotOrderId` 为已完成单号，`gotTimes` 为已领取的累计订单奖励阈值。客户端按北京时间开服天数检查 `HeroRaidOrderCfg.unlockDay`，不是简单从开启时间经过 24 小时计一天。

## 保护与未知结果

- 实际下单前重新读取完整库存与周订单、贸易港、居民订单预留；下单使用 `beginOrderMaterialSpend`，避免活动吞掉高优先级订单材料。
- 初始活动进度、活动期间标识、账号身份、开关及时间窗在等待库存读取后再次核对。读取期间推送了新进度或者关闭开关时，不发送旧计划。
- 持久唯一键含账号、活动编号、开始／结束时间与当前订单或已领档位。超时或不完整回执保留 pending，重启后不重复提交。
- 未知订单只有同一活动期间的实际 `gotOrderId` 进展能核销；未知领奖只由对应已领阈值或档位进展核销。库存净下降不能作为唯一成功证据。
- 挑战仅在收到可确认的战败回执后消耗重试次数。未知挑战保留记录并等待业务进度确认，抽奖同样用累计次数核对未知结果。
- 真实奖励回执与业务进度确认后，才读完整库存结算材料预留；后续读取的 `notSent` 不会释放已经发送的消费票据。

## 接线与测试

- `watchHeroRaidPushes(client)` 返回 `{observed, invalid, raids: Map, revision}`，可供只读状态预览使用。
- `runHeroRaidAutomation(client, protocol, config, player, {getSettings, ledger, enabled, report})` 执行一轮，接入原账号串行队列。
- `heroRaidDemands(client, config, player, settings, {ledger})` 为工厂返回需求，未知请求不继续备料。
- `tools/selftest-hero-raid-automation.mjs` 使用真实配置和实际 protobuf 编解码。覆盖首次推送、登录全量、重连清空、重复材料、日解锁、活动截止、材料预留、发送前配置变化、未知结果、明确拒绝／未发送、领奖档位确认、挑战重试、转盘用券和并发防重。
- `tools/selftest-hero-raid-settings-http.mjs` 验证单项保存、账号隔离、旧设置兼容、参数校验及版本冲突。活动页回归覆盖离线编辑、账号切换和保存失败回读，`tools/selftest-extended-loop.mjs` 覆盖独立挂机执行与设置变更唤醒。
