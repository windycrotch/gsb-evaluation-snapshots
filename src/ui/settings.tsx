import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Button } from "./button"
import { HelpTip } from "./help-tip"

export function settingsPage() {
  return renderToStaticMarkup(<div id="config-root">
    <div className="config-toolbar">
      <div className="config-owner"><div className="title-with-help"><strong id="config-account-name">当前账号的挂机配置</strong><HelpTip title="挂机配置">各模块的挂机开关与执行细项、策略、权限和参数统一在对应配置中设置。关闭模块会保留已选细项。修改后自动保存，无需点击保存。停止输入约0.6秒后提交，校验失败会提示修正。只更新当前账号，不会启动挂机；已有挂机在下次检查时使用新设置。全局挂机启停和间隔在页头控制。</HelpTip></div><span id="config-state" role="status" aria-live="polite">尚未载入</span></div>
      <div className="config-actions">
        <Button id="config-import" type="button" size="sm" variant="outline" disabled>导入</Button>
        <Button id="config-export" type="button" size="sm" variant="outline" disabled>导出</Button>
        <Button id="config-retry" type="button" size="sm" variant="outline" hidden disabled>重试自动保存</Button>
        <input id="config-file" type="file" accept=".json,application/json" hidden />
      </div>
    </div>
    <div className="config-message" id="config-message" role="alert" hidden />
    <div className="config-tabs" role="tablist" aria-label="配置分类">
      {[["base", "基地"], ["world", "世界"], ["heroes", "英雄"], ["antique", "藏品"], ["equipment", "装备"], ["daily", "日常与活动"]].map(([key, title], index) =>
        <button key={key} type="button" role="tab" id={"config-tab-" + key} data-config-tab={key} aria-controls={"config-panel-" + key} aria-selected={index === 0} tabIndex={index === 0 ? 0 : -1}>{title}</button>
      )}
    </div>
    <form id="config-form" noValidate>
      <div id="config-fields" className="config-sheet"><p className="config-empty">载入当前账号后即可设置。</p></div>
    </form>
    <section id="config-weekly-ranking" className="config-preview config-ranking" aria-labelledby="config-weekly-ranking-title" hidden>
      <div className="config-preview-head"><div className="title-with-help"><h3 id="config-weekly-ranking-title">军备竞赛排行</h3><HelpTip title="军备竞赛排行">只读显示服务器当前返回的榜单和本人数据。进入本页时更新，30秒内切回使用缓存；点击刷新榜单可立即重新读取，不改变挂机配置。</HelpTip></div><Button id="config-weekly-ranking-refresh" type="button" size="sm" variant="outline">刷新榜单</Button></div>
      <p id="config-weekly-ranking-status" className="config-help" role="status" aria-live="polite">进入军备竞赛后读取榜单。</p>
      <div id="config-weekly-ranking-summary" className="config-ranking-summary" hidden />
      <p id="config-weekly-ranking-updated" className="config-help" hidden />
      <div id="config-weekly-ranking-table" className="config-ranking-scroll" role="region" aria-label="军备竞赛服务端榜单，可横向滚动" tabIndex={0} hidden />
    </section>
    <section className="config-preview" aria-labelledby="config-preview-title">
      <div className="config-preview-head"><div className="title-with-help"><h3 id="config-preview-title">执行预览</h3><HelpTip title="只读预览">预览会根据当前草稿和游戏状态列出所选项目的计划。执行前会重新核对条件。</HelpTip></div><div className="config-preview-controls"><label htmlFor="config-preview-scope">范围</label><select id="config-preview-scope" aria-label="预览范围" className="config-select" defaultValue="current"><option value="current">当前分类</option><option value="base">基地全部项目</option><option value="world">万吨巨轮</option><option value="radar">联盟情报</option><option value="pirateHunt">海盗首杀</option><option value="pirateSweep">海盗日常扫荡</option><option value="worldBoss">世界Boss首战</option><option value="cityWar">联盟/城战</option><option value="forge">装备锻造</option><option value="heroes">英雄养成</option><option value="antique">藏品养成</option><option value="daily">日常任务与领奖</option><option value="activity">活动状态（只读）</option><option value="fleetDispatch">舰队调度（只读）</option></select><Button id="config-preview" type="button" size="sm" variant="outline" aria-label="只读预览计划" disabled>只读预览</Button></div></div>
      <div id="config-usage" />
      <div id="config-preview-result" aria-live="polite" />
    </section>
    <template id="config-switch-template"><button type="button" role="switch" aria-checked="false" data-state="unchecked" className="config-switch"><span className="config-switch-track" aria-hidden="true"><span className="config-switch-thumb" /></span></button></template>
  </div>)
}
