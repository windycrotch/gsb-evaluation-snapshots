/**
 * 验收:导入解析 → 检查器 → 导出前拦截,三处对同一份编排结论一致。
 *
 * 覆盖:
 *  - 正常编排:lint 零问题,导出闸门放行,CLI 退出码 0
 *  - 示例文案残留:placeholder-text error,闸门拦截并列出规则名 + 卡 id
 *  - lintOff(整卡 / 指定规则)后同一问题不再报
 *  - 未知卡被跳过(dropped 汇总),其余卡照常检查、照常过闸门
 *  - 卡片 end 超过视频时长报 over-duration(时长参数可注入;不给时长不触发)
 *  - 拦截后重试无残留:export-frames 被拦时不建目录、退出码非零,可反复重试
 *  - 检查器只报告不改写;missing-cam 同时看卡片 camSrc 和全局 doc.cam
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { exportLintGate, formatLintIssue, loadExportLintConfig } from "./export-preflight.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSCONFIG = path.join(ROOT, "tsconfig.app.json");

const { parseOverlay } = await tsImport("../src/overlay/types.ts", {
  parentURL: import.meta.url,
  tsconfig: TSCONFIG,
});
const { lintOverlay, lintOverlayText } = await tsImport("../src/overlay/lint.ts", {
  parentURL: import.meta.url,
  tsconfig: TSCONFIG,
});

/** 一张干净的卡:自定义文案(不是组件示例文案)、不碰运镜、驻留够长 */
const CLEAN_CARD = {
  id: "c1",
  kind: "blur-text",
  start: 0,
  end: 5,
  params: { text: "真实文案|已经写好" },
};
/** focus-card 默认 items/eyebrow 是中文示例文案;params 留空 → 解析后补回默认 → 触发 placeholder-text */
const DEMO_COPY_CARD = { id: "card-demo", kind: "focus-card", start: 0, end: 5, params: {} };

function parse(docLike) {
  const { doc, error } = parseOverlay(JSON.stringify(docLike));
  assert.equal(error, undefined);
  assert.ok(doc);
  return doc;
}

// ---------- 解析层:未知卡跳过,其余保留 ----------

test("parse: 未知 kind 跳过并给出 dropped 汇总,其余卡保留且不再参与检查", () => {
  const { doc, error, dropped } = parseOverlay(
    JSON.stringify({
      version: 1,
      cards: [
        { id: "u1", kind: "hologram-3d", start: 0, end: 3, params: {} },
        { id: "u2", kind: "hologram-3d", start: 3, end: 6, params: {} },
        { id: "u3", kind: "laser-grid", start: 1, end: 4, params: {} },
        CLEAN_CARD,
      ],
    }),
  );
  assert.equal(error, undefined);
  assert.deepEqual(dropped, [
    { kind: "hologram-3d", n: 2 },
    { kind: "laser-grid", n: 1 },
  ]);
  assert.deepEqual(doc.cards.map((c) => c.id), ["c1"]);
  // 被丢弃的卡不在 doc 里,lint 不可能对不存在的卡报错
  const issues = lintOverlay(doc, null, { duration: 60 });
  assert.ok(issues.every((i) => i.cardId !== "u1" && i.cardId !== "u2" && i.cardId !== "u3"));
  // 其余卡照常过导出闸门
  assert.equal(exportLintGate(issues).blocked, false);
});

test("parse: 全部卡都不认识或缺 cards 才整份报错", () => {
  const all = parseOverlay(
    JSON.stringify({ version: 1, cards: [{ id: "u1", kind: "nope", start: 0, end: 1, params: {} }] }),
  );
  assert.ok(all.error);
  assert.equal(all.doc, undefined);
  assert.ok(parseOverlay(JSON.stringify({ version: 1 })).error);
});

// ---------- 检查层:规则、分级、lintOff ----------

test("placeholder-text: 示例文案残留是 error;lintOff 指定规则后不再报", () => {
  const doc = parse({ version: 1, cards: [DEMO_COPY_CARD] });
  const issues = lintOverlay(doc, null, {});
  const placeholder = issues.filter((i) => i.rule === "placeholder-text");
  assert.ok(placeholder.length >= 1);
  assert.ok(placeholder.every((i) => i.level === "error" && i.cardId === "card-demo"));

  // lintOff: ["placeholder-text"] → 同一张卡同一问题不再报(其余规则照查)
  const offRule = parse({
    version: 1,
    cards: [{ ...DEMO_COPY_CARD, lintOff: ["placeholder-text"] }],
  });
  const stillThere = lintOverlay(offRule, null, {});
  assert.equal(stillThere.filter((i) => i.rule === "placeholder-text").length, 0);

  // lintOff: true → 整卡免检,什么规则都不报
  const offAll = parse({ version: 1, cards: [{ ...DEMO_COPY_CARD, lintOff: true }] });
  assert.deepEqual(lintOverlay(offAll, null, {}), []);
});

test("over-duration: 只在提供视频时长时触发,是 error", () => {
  const long = { id: "c-long", kind: "blur-text", start: 0, end: 10, params: { text: "真实文案|已经写好" } };
  const doc = parse({ version: 1, cards: [long] });
  assert.equal(lintOverlay(doc, null, {}).filter((i) => i.rule === "over-duration").length, 0);
  const withDur = lintOverlay(doc, null, { duration: 5 });
  const od = withDur.find((i) => i.rule === "over-duration");
  assert.equal(od?.level, "error");
  assert.equal(od?.cardId, "c-long");
  // lintOff 单列规则同样生效
  const off = parse({ version: 1, cards: [{ ...long, lintOff: ["over-duration"] }] });
  assert.equal(lintOverlay(off, null, { duration: 5 }).filter((i) => i.rule === "over-duration").length, 0);
});

test("missing-cam: 卡片 camSrc 或全局 doc.cam 有一个就不报,是 warn", () => {
  const bare = parse({ version: 1, cards: [{ ...DEMO_COPY_CARD, lintOff: ["placeholder-text"] }] });
  const warn = lintOverlay(bare, null, {}).find((i) => i.rule === "missing-cam");
  assert.equal(warn?.level, "warn");
  const withGlobal = parse({
    version: 1,
    cam: "/_media/talk.mp4",
    cards: [{ ...DEMO_COPY_CARD, lintOff: ["placeholder-text"] }],
  });
  assert.equal(lintOverlay(withGlobal, null, {}).filter((i) => i.rule === "missing-cam").length, 0);
  const withCard = parse({
    version: 1,
    cards: [{ ...DEMO_COPY_CARD, lintOff: ["placeholder-text"], params: { camSrc: "/_media/talk.mp4" } }],
  });
  assert.equal(lintOverlay(withCard, null, {}).filter((i) => i.rule === "missing-cam").length, 0);
});

test("stack-overlap: 任一张卡免检(整卡或单列规则)这对叠卡都不报", () => {
  const a = { id: "a", kind: "blur-text", start: 0, end: 6, params: { text: "自定义一|不叠字", position: "left" } };
  const b = { id: "b", kind: "blur-text", start: 3, end: 9, params: { text: "自定义二|不叠字", position: "left" } };
  const doc = parse({ version: 1, cards: [a, b] });
  assert.equal(lintOverlay(doc, null, {}).filter((i) => i.rule === "stack-overlap").length, 1);
  const offEarlier = parse({ version: 1, cards: [{ ...a, lintOff: true }, b] });
  assert.equal(lintOverlay(offEarlier, null, {}).filter((i) => i.rule === "stack-overlap").length, 0);
  const offLater = parse({ version: 1, cards: [a, { ...b, lintOff: ["stack-overlap"] }] });
  assert.equal(lintOverlay(offLater, null, {}).filter((i) => i.rule === "stack-overlap").length, 0);
});

test("检查器只报告不改写:深度冻结的文档也能查", () => {
  const doc = parse({ version: 1, cards: [DEMO_COPY_CARD] });
  const snapshot = JSON.stringify(doc);
  (function freeze(o) {
    if (o && typeof o === "object") {
      Object.values(o).forEach(freeze);
      Object.freeze(o);
    }
  })(doc);
  assert.ok(lintOverlay(doc, null, { duration: 4 }).length > 0);
  assert.equal(JSON.stringify(doc), snapshot);
});

test("lintOverlayText: 解析失败算 error;dropped 原样带出供调用方告知", () => {
  const bad = lintOverlayText("{ 不是 JSON");
  assert.equal(bad.issues[0]?.level, "error");
  assert.equal(bad.issues[0]?.rule, "parse");

  const mixed = lintOverlayText(
    JSON.stringify({
      version: 1,
      cards: [{ id: "u1", kind: "hologram-3d", start: 0, end: 3, params: {} }, CLEAN_CARD],
    }),
  );
  assert.deepEqual(mixed.dropped, [{ kind: "hologram-3d", n: 1 }]);
  assert.equal(mixed.doc.cards.length, 1);
  assert.deepEqual(mixed.issues, []);
});

// ---------- 导出闸门 ----------

test("闸门:有 error 拦截并列出规则名与卡 id;确认免检后放行;只有 warn 放行但提示", () => {
  const errIssues = lintOverlay(parse({ version: 1, cards: [DEMO_COPY_CARD] }), null, {});
  const gate = exportLintGate(errIssues);
  assert.equal(gate.blocked, true);
  const text = gate.lines.join("\n");
  assert.match(text, /placeholder-text/);
  assert.match(text, /card-demo/);

  // 用户确认免检(lintAck)→ 放行,但问题列表照样留痕
  const acked = exportLintGate(errIssues, { acknowledged: true });
  assert.equal(acked.blocked, false);
  assert.ok(acked.lines.length > 0);

  // 只有 warn → 放行,提示在
  const warnOnly = lintOverlay(
    parse({ version: 1, cards: [{ ...DEMO_COPY_CARD, lintOff: ["placeholder-text"] }] }),
    null,
    {},
  );
  assert.ok(warnOnly.length > 0 && warnOnly.every((i) => i.level === "warn"));
  const warnGate = exportLintGate(warnOnly);
  assert.equal(warnGate.blocked, false);
  assert.match(warnGate.lines.join("\n"), /missing-cam/);

  // 干净编排 → 放行且没有任何要提示的
  const clean = exportLintGate(lintOverlay(parse({ version: 1, cards: [CLEAN_CARD] }), null, {}));
  assert.equal(clean.blocked, false);
  assert.deepEqual(clean.lines, []);
});

test("formatLintIssue: 规则名 + 卡 id + 人话都在一行里", () => {
  assert.equal(
    formatLintIssue({ level: "error", rule: "over-duration", cardId: "c9", message: "end 超了" }),
    "[over-duration] 卡「c9」 — end 超了",
  );
  assert.equal(
    formatLintIssue({ level: "warn", rule: "quiet-gap", at: 12, message: "空太久" }),
    "[quiet-gap] 12.0s — 空太久",
  );
});

test("阈值配置来源和 CLI 一致(lint-rules.default.json,local 可缺省)", () => {
  const cfg = loadExportLintConfig(ROOT);
  assert.equal(cfg.minDwell, 2);
  assert.equal(cfg.maxQuietGap, 10);
});

// ---------- CLI:退出码语义(有 error 非零,仅 warn 为零) ----------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-lint-test-"));
function writeFixture(name, content) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}
function runCli(args) {
  return spawnSync(
    process.execPath,
    [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "--tsconfig", TSCONFIG,
      path.join(ROOT, "scripts", "lint-overlay.ts"), ...args],
    { cwd: ROOT, encoding: "utf8", timeout: 120_000 },
  );
}

test("CLI: 干净编排退出码 0;示例文案残留退出码非零并列出规则名和卡 id", () => {
  const clean = runCli([writeFixture("clean.json", { version: 1, cards: [CLEAN_CARD] })]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /没有发现问题/);

  const dirty = runCli([writeFixture("dirty.json", { version: 1, cards: [DEMO_COPY_CARD] })]);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stdout, /placeholder-text/);
  assert.match(dirty.stdout, /card-demo/);
});

test("CLI: 仅 warn 退出码为 0;lintOff 指定规则后同一问题不再报", () => {
  const warnOnly = runCli([
    writeFixture("warn.json", {
      version: 1,
      cards: [{ ...DEMO_COPY_CARD, lintOff: ["placeholder-text"] }],
    }),
  ]);
  assert.equal(warnOnly.status, 0, warnOnly.stdout);
  assert.match(warnOnly.stdout, /missing-cam/);
  assert.ok(!warnOnly.stdout.includes("placeholder-text"));
});

test("CLI: --duration 注入视频时长才触发 over-duration", () => {
  const file = writeFixture("long.json", {
    version: 1,
    cards: [{ id: "c-long", kind: "blur-text", start: 0, end: 10, params: { text: "真实文案|已经写好" } }],
  });
  assert.equal(runCli([file]).status, 0);
  const withDur = runCli([file, "--duration", "5"]);
  assert.equal(withDur.status, 1);
  assert.match(withDur.stdout, /over-duration/);
  assert.match(withDur.stdout, /c-long/);
});

test("CLI: 未知卡提示 dropped 但不影响退出码,其余卡照常检查", () => {
  const mixed = runCli([
    writeFixture("mixed.json", {
      version: 1,
      cards: [
        { id: "u1", kind: "hologram-3d", start: 0, end: 3, params: {} },
        CLEAN_CARD,
      ],
    }),
  ]);
  assert.equal(mixed.status, 0, mixed.stdout);
  assert.match(mixed.stdout, /hologram-3d/);
  assert.match(mixed.stdout, /1 张卡/);
});

// ---------- 导出进程:拦截在渲染前,重试无残留 ----------

test("export-frames: 示例文案残留被拦在渲染前,不留半成品,可反复重试", () => {
  const jobFile = writeFixture("job-blocked.json", {
    mode: "timeline",
    duration: 6,
    fps: 30,
    doc: { version: 1, cards: [DEMO_COPY_CARD] },
    videoDuration: 4,
    outputDir: tmp,
  });
  const exportsDir = path.join(ROOT, "exports");
  const before = fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir) : [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "export-frames.mjs"), jobFile], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 180_000,
    });
    assert.equal(r.status, 1, `第 ${attempt} 次应被拦截`);
    const out = r.stdout + r.stderr;
    assert.match(out, /placeholder-text/);
    assert.match(out, /card-demo/);
    assert.match(out, /未渲染任何帧/);
    const after = fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir) : [];
    assert.deepEqual(after, before, "被拦后不得在 exports/ 留下任何半成品");
  }
});

test("export-frames: 只有 warn 不拦截,提示照打", () => {
  const jobFile = writeFixture("job-warn.json", {
    mode: "timeline",
    duration: 0.2,
    fps: 30,
    // lintOff 掉 placeholder,只留下 missing-cam warn;没有视频卡,不需要 ffmpeg
    doc: { version: 1, cards: [{ ...DEMO_COPY_CARD, lintOff: ["placeholder-text"] }] },
    // 故意给一个不存在的输出文件夹,让任务在闸门之后、建目录之前的文件夹校验处停下:
    // 这样只需断言「lint 没拦它、warn 打出来了」,不用真的起浏览器
    outputDir: path.join(tmp, "no-such-folder"),
  });
  const exportsDir = path.join(ROOT, "exports");
  const before = fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir) : [];
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "export-frames.mjs"), jobFile], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180_000,
  });
  const out = r.stdout + r.stderr;
  assert.match(out, /missing-cam/, "warn 提示必须打出来");
  assert.ok(!/导出前检查未通过/.test(out), "只有 warn 不得拦截");
  assert.match(out, /导出文件夹不存在/, "应停在闸门之后的文件夹校验");
  const after = fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir) : [];
  assert.deepEqual(after, before, "exports/ 不得有残留");
});
