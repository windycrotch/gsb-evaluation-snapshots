/**
 * 导出前检查 · 出口闸门(纯函数,方便单测)。
 *
 * 同一份编排在三处必须得到一致结论:编辑台检查器、lint:overlay CLI、导出前拦截。
 * 规则本体在 src/overlay/lint.ts(lintOverlay),这里只做「拿到问题列表后怎么办」:
 *   - 有 error 且用户没确认免检 → 拦在渲染前(blocked),列出规则名和卡 id;
 *   - 只有 warn → 放行,但提示必须看得见;
 *   - 用户确认免检(lintAck)→ 本次放行,问题列表照样打出来留痕。
 *
 * 被拦时必须可以安全重试:闸门排在建目录、抽帧、起浏览器之前,
 * 不产生半成品文件,也不占导出进程。
 */
import fs from "node:fs";
import path from "node:path";

/**
 * 阈值来源和 lint:overlay CLI 完全一致:
 * lint-rules.default.json(公共)+ lint-rules.local.json(个人,可缺省)。
 */
export function loadExportLintConfig(root) {
  const read = (name) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
    } catch {
      return null;
    }
  };
  return { ...read("lint-rules.default.json"), ...read("lint-rules.local.json") };
}

/** 一条问题 → 一行「规则名 + 位置(卡 id 或时间点)+ 人话」,三处同一措辞 */
export function formatLintIssue(issue) {
  const where =
    issue.cardId != null
      ? `卡「${issue.cardId}」`
      : issue.at != null
        ? `${Number(issue.at).toFixed(1)}s`
        : "整份编排";
  return `[${issue.rule}] ${where} — ${issue.message}`;
}

/**
 * 导出闸门。
 * @param issues  lintOverlay 的返回(只报告,不改写)
 * @param acknowledged  用户已在编辑台确认「这些问题免检,照常导出」(job.lintAck)
 * @returns { blocked, errors, warns, lines } lines 是要给用户看的完整说明
 */
export function exportLintGate(issues, { acknowledged = false } = {}) {
  const errors = issues.filter((i) => i.level === "error");
  const warns = issues.filter((i) => i.level === "warn");
  const blocked = errors.length > 0 && !acknowledged;
  const lines = [];
  if (errors.length) {
    lines.push(`导出前检查发现 ${errors.length} 个必修问题:`);
    for (const i of errors) lines.push(`  ❌ ${formatLintIssue(i)}`);
  }
  if (warns.length) {
    lines.push(`导出前检查有 ${warns.length} 个提醒(不阻断导出):`);
    for (const i of warns) lines.push(`  ⚠️ ${formatLintIssue(i)}`);
  }
  if (blocked) {
    lines.push(
      "已拦在渲染前:没有产生任何文件,重试不受本次影响。",
      '确认免检后重导即可;想长期免检就在对应卡片上加 "lintOff": ["规则名"]。',
    );
  }
  return { blocked, errors, warns, lines };
}
