import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  LINT_DEFAULTS,
  lintErrors,
  lintIssueKey,
  lintOverlayText,
  mergeLintConfig,
  sanitizeLintConfig,
} from "../src/overlay/lint.ts";
import { parseOverlay } from "../src/overlay/types.ts";

/** 三处入口(导入 / 单卡编辑 / 导出前)都调用 lintOverlayText 或 lintParsedOverlay,
 *  这里直接验证它们共用的那套判断,以及阈值合并的容错。 */

const card = (over = {}) => ({
  id: "c1",
  kind: "blur-text",
  start: 0,
  end: 3,
  params: { text: "一句正常的话" },
  ...over,
});

const doc = (cards, extra = {}) => ({
  version: 1,
  cards,
  ...extra,
});

test("parse failures surface as blocking errors with a rule name", () => {
  for (const [text, rule] of [
    ["{ not json", "parse"],
    [JSON.stringify({ nope: true }), "parse"],
  ]) {
    const { doc: parsed, issues } = lintOverlayText(text);
    assert.equal(parsed, undefined);
    const errors = lintErrors(issues);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].rule, rule);
  }
});

test("invalid card time and duplicate ids block, and name the card", () => {
  const badTime = lintErrors(
    lintOverlayText(JSON.stringify(doc([card({ start: 5, end: 2 })]))).issues,
  );
  assert.equal(badTime.length, 1);
  assert.equal(badTime[0].rule, "invalid-time");
  assert.equal(badTime[0].cardId, "c1");

  const duplicate = lintErrors(
    lintOverlayText(JSON.stringify(doc([card(), card({ end: 4 })]))).issues,
  );
  assert.equal(duplicate.length, 1);
  assert.equal(duplicate[0].rule, "duplicate-id");
  assert.equal(duplicate[0].cardId, "c1");
});

test("unknown card kinds are skipped and reported as warnings, never blocking", () => {
  const { doc: parsed, issues } = lintOverlayText(
    JSON.stringify(doc([card(), { id: "x", kind: "nft-card", start: 1, end: 2, params: {} }])),
  );
  assert.ok(parsed);
  assert.equal(parsed.cards.length, 1);
  assert.equal(lintErrors(issues).length, 0);
  const dropped = issues.find((i) => i.rule === "unknown-kind");
  assert.ok(dropped);
  assert.equal(dropped.level, "warn");
  assert.match(dropped.message, /nft-card/);
});

test("a file where every card is unknown is a blocking parse error, not an empty doc", () => {
  const { doc: parsed, issues } = lintOverlayText(
    JSON.stringify(doc([{ id: "x", kind: "nft-card", start: 1, end: 2, params: {} }])),
  );
  assert.equal(parsed, undefined);
  const errors = lintErrors(issues);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, "unknown-kind");
});

test("lintOff on a card silences exactly that rule, and removing it restores the warning", () => {
  const short = doc([card({ id: "flash", start: 0, end: 0.5 })]);
  const base = lintOverlayText(JSON.stringify(short), { minDwell: 2 }).issues;
  assert.ok(base.some((i) => i.rule === "short-dwell" && i.level === "warn"));

  const ignored = doc([
    card({ id: "flash", start: 0, end: 0.5, lintOff: ["short-dwell"] }),
  ]);
  const silenced = lintOverlayText(JSON.stringify(ignored), { minDwell: 2 }).issues;
  assert.ok(!silenced.some((i) => i.rule === "short-dwell"));

  // 清空忽略列表 = 告警回来
  const cleared = doc([card({ id: "flash", start: 0, end: 0.5, lintOff: [] })]);
  const restored = lintOverlayText(JSON.stringify(cleared), { minDwell: 2 }).issues;
  assert.ok(restored.some((i) => i.rule === "short-dwell"));
});

test("lintOff: true exempts the whole card", () => {
  const issues = lintOverlayText(
    JSON.stringify(doc([card({ id: "flash", start: 0, end: 0.5, lintOff: true })])),
    { minDwell: 2 },
  ).issues;
  assert.deepEqual(issues, []);
});

test("over-duration only triggers against a real video duration", () => {
  const d = doc([card({ start: 0, end: 10 })]);
  assert.equal(
    lintOverlayText(JSON.stringify(d), null, {}).issues.filter((i) => i.rule === "over-duration")
      .length,
    0,
  );
  const withDur = lintOverlayText(JSON.stringify(d), null, { duration: 5 }).issues;
  assert.equal(withDur.filter((i) => i.rule === "over-duration").length, 1);
});

test("a corrupt personal config field falls back to the default instead of disabling the check", () => {
  // "minDwell": "2s" 这种手改失误:整包 Object.assign 会让比较永远为假,规则静默失灵
  const cfg = mergeLintConfig({ minDwell: "2s", scaleTiers: 5 }, null, undefined);
  assert.equal(cfg.minDwell, LINT_DEFAULTS.minDwell);
  assert.deepEqual(cfg.scaleTiers, LINT_DEFAULTS.scaleTiers);

  const short = JSON.stringify(doc([card({ id: "flash", start: 0, end: 0.5 })]));
  const issues = lintOverlayText(short, { minDwell: "2s" })
    .issues;
  assert.ok(issues.some((i) => i.rule === "short-dwell"), "坏配置不能把快闪规则整个关掉");
});

test("valid personal overrides still win over the public defaults", () => {
  const cfg = mergeLintConfig({ minDwell: 4 }, { minDwell: 0.5, warnCaptionTrack: false });
  assert.equal(cfg.minDwell, 0.5);
  assert.equal(cfg.warnCaptionTrack, false);
  assert.equal(cfg.maxQuietGap, LINT_DEFAULTS.maxQuietGap);
});

test("sanitizeLintConfig drops only the bad entries of a list, keeping the good ones", () => {
  const cfg = sanitizeLintConfig({
    scaleTiers: [1, "2", 3, null],
    dwellExemptKinds: ["chapter-bar", 7, "caption-track"],
  });
  assert.deepEqual(cfg.scaleTiers, [1, 3]);
  assert.deepEqual(cfg.dwellExemptKinds, ["chapter-bar", "caption-track"]);
});

test("lintIssueKey is stable for the same issue and distinct across cards", () => {
  const a = { level: "warn", rule: "short-dwell", cardId: "c1", message: "m" };
  const b = { level: "warn", rule: "short-dwell", cardId: "c2", message: "m" };
  assert.equal(lintIssueKey(a), lintIssueKey({ ...a }));
  assert.notEqual(lintIssueKey(a), lintIssueKey(b));
});

test("the shipped demo overlay lints clean with the public default config", () => {
  // 未改动配置和文档时,既有示例编排的结论必须和改动前一致(空)
  const demo = fs.readFileSync(
    fileURLToPath(new URL("../public/demo/demo-overlay.json", import.meta.url)),
    "utf8",
  );
  const { doc: parsed, issues } = lintOverlayText(demo, null);
  assert.ok(parsed);
  assert.deepEqual(issues, []);
});

test("parseOverlay exposes structured errors that match the flat message", () => {
  const r = parseOverlay({ version: 1, cards: [card({ start: 9, end: 1 })] });
  assert.ok(r.error);
  assert.equal(r.errors?.length, 1);
  assert.equal(r.errors?.[0].message, r.error);
});
