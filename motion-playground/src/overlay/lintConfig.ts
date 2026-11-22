/**
 * 检查阈值:公共默认 < 个人覆盖,只此一份。
 *
 * 以前合并逻辑散在 App.tsx 和 CLI 两处:个人配置一旦写坏(手改 JSON 很常见),
 * 一处整包覆盖、一处 try/catch 回落,两边的结论就可能不一样 —— 而「导入时没问题、
 * 导出前才有硬伤」正是用户最怕的那类不一致。合并与容错都收在 lint.ts 的
 * mergeLintConfig / sanitizeLintConfig 里,这里只负责把两份文件读出来。
 *
 * 个人文件用 ?raw 读、自己 JSON.parse:直接 import JSON 的话,文件里多一个逗号
 * 会让整个页面在模块加载阶段就崩掉 —— 用户看到的是白屏,而不是「个人配置坏了,
 * 先用公共默认」。检查可以降级,不能消失。
 */
import defaults from "../../lint-rules.default.json";
import { lintOverlay, lintParsedOverlay, mergeLintConfig, type LintConfig, type LintIssue } from "./lint";
import { parseOverlay, type OverlayDoc } from "./types";

const localRaw = import.meta.glob("../../lint-rules.local.json", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function parseLocal(raw: string | undefined): Partial<LintConfig> | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null; // 坏文件不影响公共默认
  }
}

/** 本次会话实际生效的阈值 */
export const LINT_CFG: LintConfig = mergeLintConfig(
  defaults as Partial<LintConfig>,
  parseLocal(Object.values(localRaw)[0]),
);

/**
 * 对一个已解析的文档跑检查(导出前、单卡编辑后共用)。
 * duration 传视频秒数;没视频就不查越界 —— 和 CLI 不传 --duration 时一致。
 */
export function checkOverlayIssues(
  doc: OverlayDoc | null,
  duration?: number,
): LintIssue[] {
  if (!doc) return [];
  return lintParsedOverlay(parseOverlay(doc), LINT_CFG, { duration: duration || undefined });
}

/** 直接对内存里的文档跑卡片级规则(不做二次解析) */
export function checkOverlayDoc(doc: OverlayDoc | null, duration?: number): LintIssue[] {
  if (!doc) return [];
  return lintOverlay(doc, LINT_CFG, { duration: duration || undefined });
}
