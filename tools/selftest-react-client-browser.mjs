import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cw-react-browser-"));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, "config.json");
process.env.CW_RESOURCE_AUTO_UPDATE = "0";
fs.writeFileSync(process.env.CW_CONFIG_PACK, "[]");
const { saveStore } = await import("../src/accounts.mjs");
const { saveAutomationSettings, loadAutomationSettings } = await import(
  "../src/automation-settings.mjs"
);
const { createConsole } = await import("../src/server.mjs");
const { GameClient } = await import("../src/client.mjs");
let connections = 0;
GameClient.prototype.connect = async () => {
  connections++;
  throw new Error("验收禁止连接真实游戏");
};
saveStore({
  version: 1,
  activeId: "a",
  accounts: ["a", "b"].map((id) => ({
    id,
    label: `重构验收账号 ${id}`,
    url: "wss://fixture.invalid",
    login: {},
    automation: { enabled: false, autoStart: false, paused: true },
  })),
});
const output = path.resolve("output/react-client");
fs.mkdirSync(output, { recursive: true });
const app = createConsole({ port: 0, protocol: {} });
let browser;
let passed = 0;
const errors = [];
async function test(name, work) {
  await work();
  passed++;
  console.log(`通过：${name}`);
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

try {
  const base = await app.listen();
  const executablePath = [
    process.env.CW_BROWSER_TEST_EXECUTABLE,
    chromium.executablePath(),
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].find((file) => file && fs.existsSync(file));
  assert(
    executablePath,
    "未找到浏览器；可设置 CW_BROWSER_TEST_EXECUTABLE 或运行 npx playwright-core install chromium",
  );
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1080 },
  });
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  const requests = [];
  page.on("request", (request) =>
    requests.push({ url: request.url(), method: request.method() }),
  );
  const posts = () =>
    requests.filter(
      (row) => row.url.includes("/api/login-settings") && row.method === "POST",
    ).length;
  const saved = () =>
    page
      .locator("#login-settings-state")
      .filter({ hasText: /设置已保存|使用默认设置/ })
      .waitFor();
  async function choose(id) {
    await page.locator("#account-picker-trigger").click();
    await page
      .locator("#account-picker-list [role=option]")
      .filter({ hasText: `重构验收账号 ${id}` })
      .click();
    await page
      .locator("#account-picker-title")
      .filter({ hasText: `重构验收账号 ${id}` })
      .waitFor();
  }

  await test("总览只加载轻量入口，打开登录设置才加载 React 和页面样式", async () => {
    await page.goto(base);
    await page
      .locator("#account-picker-title")
      .filter({ hasText: "重构验收账号 a" })
      .waitFor();
    assert.equal(
      requests.filter((row) => row.url.includes("/ui/chunks/")).length,
      0,
    );
    assert.equal(
      requests.filter((row) => row.url.includes("/api/login-settings")).length,
      0,
    );
    await page.locator('#tabs [data-tab="login-settings"]').click();
    await saved();
    assert.equal(
      await page.locator('[data-react-page="login-settings"]').count(),
      1,
    );
    assert.equal(
      await page.locator("#login-reconnect-delay").inputValue(),
      "900",
    );
    assert.equal(
      requests.filter((row) => row.url.includes("/ui/chunks/")).length,
      1,
    );
    assert(
      requests.some(
        (row) => row.url.includes("/ui/assets/") && row.url.endsWith(".css"),
      ),
    );
  });

  await test("桌面、手机和深色主题保持可读且没有横向溢出", async () => {
    await page.screenshot({
      path: path.join(output, "login-desktop.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(output, "login-mobile.png"),
      fullPage: true,
      animations: "disabled",
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
    await page.screenshot({
      path: path.join(output, "login-mobile-dark.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "light"),
    );
    await page.setViewportSize({ width: 1440, height: 1080 });
  });

  await test("React 开关支持键盘，保存仅修改选中账号，恢复草稿不发送请求", async () => {
    const before = await page
      .locator("#login-reconnect-enabled")
      .getAttribute("aria-checked");
    await page.locator("#login-reconnect-enabled").focus();
    await page.keyboard.press("Space");
    assert.notEqual(
      await page
        .locator("#login-reconnect-enabled")
        .getAttribute("aria-checked"),
      before,
    );
    await page.locator("#login-reconnect-delay").fill("1234");
    await page.locator("#login-deep-start").fill("23:00");
    await page.locator("#login-deep-end").fill("06:00");
    await page.locator("#login-settings-save").click();
    await saved();
    assert.equal(
      loadAutomationSettings("a").settings.login.intervalSeconds,
      1234,
    );
    assert.equal(
      loadAutomationSettings("b").settings.login.intervalSeconds,
      900,
    );
    assert.match(
      await page.locator("#login-settings-state").getAttribute("title"),
      /北京时间/,
    );
    const count = posts();
    await page.locator("#login-reconnect-delay").fill("999");
    await page.locator("#login-settings-reset").click();
    assert.equal(
      await page.locator("#login-reconnect-delay").inputValue(),
      "1234",
    );
    assert.equal(posts(), count);
  });

  await test("空值在客户端阻止保存，服务端版本冲突保留草稿并支持重新载入", async () => {
    const count = posts();
    await page.locator("#login-reconnect-jitter").fill("");
    await page.locator("#login-settings-save").click();
    await page
      .locator('#login-reconnect-jitter[aria-invalid="true"]')
      .waitFor();
    assert.equal(posts(), count);
    await page.locator("#login-reconnect-jitter").fill("0");
    const current = loadAutomationSettings("a");
    current.settings.login.intervalSeconds = 444;
    saveAutomationSettings("a", current.settings, {
      revision: current.revision,
    });
    await page.locator("#login-reconnect-delay").fill("666");
    await page.locator("#login-settings-save").click();
    await page
      .locator("#login-settings-state")
      .filter({ hasText: "其他页面更新" })
      .waitFor();
    assert.equal(
      await page.locator("#login-reconnect-delay").inputValue(),
      "666",
    );
    assert.equal(
      loadAutomationSettings("a").settings.login.intervalSeconds,
      444,
    );
    await page.locator("#login-settings-reload").click();
    await saved();
    assert.equal(
      await page.locator("#login-reconnect-delay").inputValue(),
      "444",
    );
  });

  await test("A 账号读取延迟时切到 B，迟到响应不能覆盖 B 的表单", async () => {
    const started = deferred(),
      release = deferred(),
      finished = deferred();
    await page.route(
      "**/api/login-settings?account=a",
      async (route) => {
        const response = await route.fetch();
        started.resolve();
        await release.promise;
        await route.fulfill({ response }).catch(() => {});
        finished.resolve();
      },
      { times: 1 },
    );
    await page.locator("#login-settings-reload").click();
    await started.promise;
    await choose("b");
    await saved();
    assert.equal(
      await page.locator("#login-reconnect-delay").inputValue(),
      "900",
    );
    release.resolve();
    await finished.promise;
    assert.equal(
      await page.locator("#login-reconnect-delay").inputValue(),
      "900",
    );
  });

  await test("保存中的重复提交只发送一次，切号后的保存响应仍归原账号", async () => {
    await choose("a");
    await saved();
    const started = deferred(),
      release = deferred(),
      finished = deferred();
    await page.route(
      "**/api/login-settings?account=a",
      async (route) => {
        const response = await route.fetch();
        started.resolve();
        await release.promise;
        await route.fulfill({ response });
        finished.resolve();
      },
      { times: 1 },
    );
    await page.locator("#login-reconnect-delay").fill("777");
    const count = posts();
    await page.locator("#login-settings-form").evaluate((form) => {
      form.requestSubmit();
      form.requestSubmit();
    });
    await started.promise;
    assert.equal(posts(), count + 1);
    assert.equal(await page.locator("#login-settings-save").isDisabled(), true);
    await choose("b");
    await saved();
    release.resolve();
    await finished.promise;
    assert.equal(
      await page.locator("#login-reconnect-delay").inputValue(),
      "900",
    );
    assert.equal(
      loadAutomationSettings("a").settings.login.intervalSeconds,
      777,
    );
    await page.waitForFunction(() => {
      const state = window.cwConsoleStore.getState();
      return (
        state.currentAccountId === "b" &&
        !state.slices["loginSettings:a"]?.saving &&
        state.slices["loginSettings:a"]?.data?.settings.baseDelaySeconds === 777
      );
    });
    assert.equal(
      loadAutomationSettings("b").settings.login.intervalSeconds,
      900,
    );
  });

  await test("读取失败可手动重试，离页和切号均保留各账号的未保存草稿", async () => {
    await page.route(
      "**/api/login-settings?account=b",
      (route) =>
        route.fulfill({ status: 503, json: { error: "测试临时失败" } }),
      { times: 1 },
    );
    await page.locator("#login-settings-reload").click();
    await page
      .locator("#login-settings-state")
      .filter({ hasText: "测试临时失败" })
      .waitFor();
    await page.locator("#login-settings-reload").click();
    await saved();
    await page.locator("#login-reconnect-delay").fill("555");
    await page.locator('#tabs [data-tab="overview"]').click();
    await page.locator('#tabs [data-tab="login-settings"]').click();
    assert.equal(
      await page.locator("#login-reconnect-delay").inputValue(),
      "555",
    );
    const count = posts();
    await choose("a");
    await saved();
    assert.equal(
      await page.locator("#login-reconnect-delay").inputValue(),
      "777",
    );
    await choose("b");
    await page
      .locator("#login-settings-state")
      .filter({ hasText: "有未保存修改" })
      .waitFor();
    assert.equal(
      await page.locator("#login-reconnect-delay").inputValue(),
      "555",
    );
    assert.equal(posts(), count, "切号恢复草稿不自动提交");
    assert.equal(
      requests.filter((row) => row.url.includes("/ui/chunks/")).length,
      1,
    );
  });

  await test("没有账号时提供空状态且不请求登录设置", async () => {
    saveStore({ version: 1, activeId: null, accounts: [] });
    requests.length = 0;
    await page.reload();
    await page.locator('#tabs [data-tab="login-settings"]').click();
    await page
      .locator("#login-settings-state")
      .filter({ hasText: "请先选择账号" })
      .waitFor();
    assert.equal(
      requests.filter((row) => row.url.includes("/api/login-settings")).length,
      0,
    );
    assert.equal(await page.locator("#login-settings-save").count(), 0);
  });
  assert.equal(connections, 0);
  assert.deepEqual(errors, []);
  console.log(
    `React 客户端浏览器测试 ${passed}/${passed} 通过；截图：${output}`,
  );
} finally {
  await browser?.close();
  app.server.closeAllConnections();
  await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
