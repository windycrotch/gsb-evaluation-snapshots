import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { build } from "esbuild";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cw-react-client-"));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, "config.json");
process.env.CW_RESOURCE_AUTO_UPDATE = "0";
fs.writeFileSync(process.env.CW_CONFIG_PACK, "[]");
const { saveStore, loadStore } = await import("../src/accounts.mjs");
const { createConsole } = await import("../src/server.mjs");
const { GameClient } = await import("../src/client.mjs");
let connections = 0;
GameClient.prototype.connect = async () => {
  connections++;
  throw new Error("测试禁止连接游戏");
};
saveStore({
  version: 1,
  activeId: "a",
  accounts: ["a", "b"].map((id) => ({
    id,
    label: `验收账号 ${id}`,
    url: "wss://fixture.invalid",
    login: {},
    automation: { enabled: false, autoStart: false, paused: true },
  })),
});
const app = createConsole({ port: 0, protocol: {} });
let passed = 0;
async function test(name, run) {
  await run();
  passed++;
  console.log(`通过：${name}`);
}

try {
  const outfile = path.join(directory, "client-contracts.mjs");
  await build({
    stdin: {
      contents:
        'export * from "./src/ui/client/contracts/login-settings.ts"; export * from "./src/ui/client/lib/api.ts"; export * from "./src/ui/client/lib/time.ts";',
      resolveDir: path.resolve(import.meta.dirname, ".."),
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const {
    parseLoginSettings,
    toDraft,
    validateDraft,
    createAccountApi,
    ApiError,
    formatGameTime,
  } = await import(pathToFileURL(outfile).href);
  const base = await app.listen();
  const transport = (url, options) => fetch(new URL(url, base), options);
  const first = createAccountApi("a", transport);
  const second = createAccountApi("b", transport);
  const read = (client) => client.load(new AbortController().signal);
  const initial = await read(first);

  await test("接口契约读取服务器默认值，并拒绝缺字段或错误类型", () => {
    assert.equal(initial.settings.baseDelaySeconds, 900);
    assert.equal(initial.revision, 0);
    for (const payload of [
      null,
      {},
      { ...initial, revision: -1 },
      { ...initial, settings: { ...initial.settings, maxRetries: "5" } },
      { ...initial, settings: { ...initial.settings, deep: null } },
    ]) {
      assert.throws(() => parseLoginSettings(payload), /响应格式无效/);
    }
  });

  await test("数字留空、越界、小数和无效时间均在发送前被拒绝", () => {
    const draft = toDraft(initial.settings);
    assert.deepEqual(validateDraft(draft), {
      settings: initial.settings,
      fields: {},
    });
    const invalid = {
      ...draft,
      jitterSeconds: "",
      baseDelaySeconds: "0",
      maxRetries: "1.5",
      deep: { ...draft.deep, start: "25:00", delaySeconds: "86401" },
    };
    assert.deepEqual(Object.keys(validateDraft(invalid).fields).sort(), [
      "baseDelaySeconds",
      "deep.delaySeconds",
      "deep.start",
      "jitterSeconds",
      "maxRetries",
    ]);
  });

  await test("请求绑定明确账号，切换服务端默认账号也不能串写", async () => {
    const store = loadStore();
    store.activeId = "b";
    saveStore(store);
    const saved = await first.save(
      { ...initial.settings, baseDelaySeconds: 1234 },
      initial.revision,
    );
    assert.equal(saved.settings.baseDelaySeconds, 1234);
    assert.equal((await read(second)).settings.baseDelaySeconds, 900);
    assert.equal((await read(first)).revision, saved.revision);
    await assert.rejects(
      first.save(initial.settings, initial.revision),
      (error) => error instanceof ApiError && !!error.fields.revision,
    );
    assert.equal((await read(first)).settings.baseDelaySeconds, 1234);
  });

  await test("未确认的保存失败只发送一次，读取取消信号传给 fetch", async () => {
    let calls = 0;
    const failing = createAccountApi("a", async () => {
      calls++;
      throw new Error("响应丢失");
    });
    await assert.rejects(failing.save(initial.settings, 0), /响应丢失/);
    assert.equal(calls, 1);
    const controller = new AbortController();
    controller.abort();
    let seen;
    const aborted = createAccountApi("a", async (_url, options) => {
      seen = options.signal;
      options.signal.throwIfAborted();
    });
    await assert.rejects(
      aborted.load(controller.signal),
      (error) => error.name === "AbortError",
    );
    assert.equal(seen, controller.signal);
    assert.throws(() => createAccountApi(""), /选择账号/);
  });

  await test("Day.js 展示使用北京时间，跨日与无效日期结果明确", () => {
    assert.equal(formatGameTime("2026-11-17T15:59:59Z"), "2026-11-17 23:59:59");
    assert.equal(formatGameTime("2026-11-17T16:00:00Z"), "2026-11-18 00:00:00");
    assert.equal(
      formatGameTime(Date.UTC(2026, 10, 17, 16)),
      "2026-11-18 00:00:00",
    );
    for (const value of [null, undefined, "", "invalid"])
      assert.equal(formatGameTime(value), "");
  });

  function raw(url, headers = {}, method = "GET") {
    return new Promise((resolve, reject) => {
      const req = http.request(
        new URL(url, base),
        { headers, method },
        (res) => {
          const parts = [];
          res.on("data", (part) => parts.push(part));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(parts),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  }
  await test("客户端入口支持 gzip、ETag 和 HEAD，入口与哈希资源分别缓存", async () => {
    const entry = await raw("/ui/console-client.js");
    assert.equal(entry.status, 200);
    assert.match(entry.headers["content-type"], /javascript/);
    assert.equal(entry.headers["cache-control"], "no-cache");
    assert.equal(entry.headers["x-content-type-options"], "nosniff");
    const zipped = await raw("/ui/console-client.js", {
      "accept-encoding": "gzip",
    });
    assert.deepEqual(gunzipSync(zipped.body), entry.body);
    assert(zipped.body.length < 4096, "首屏入口 gzip 不超过 4 KiB");
    assert.equal(
      (
        await raw("/ui/console-client.js", {
          "if-none-match": entry.headers.etag,
        })
      ).status,
      304,
    );
    assert.equal(
      (await raw("/ui/console-client.js", {}, "HEAD")).body.length,
      0,
    );
    const chunks = fs.readdirSync(
      new URL("../src/ui/dist/client/chunks/", import.meta.url),
    );
    for (const name of chunks) {
      const result = await raw(`/ui/chunks/${name}`);
      assert.equal(result.status, 200);
      assert.match(result.headers["cache-control"], /immutable/);
      assert(
        gzipSync(result.body).length < 115 * 1024,
        "首张 React 页面 gzip 不超过 115 KiB",
      );
    }
    console.log(
      `入口 gzip ${zipped.body.length} bytes，按需页面 ${chunks.length} 个 JS 分块`,
    );
  });

  await test("静态资源仅允许生成文件，源码、凭证路径与未知资源不可读取", async () => {
    for (const name of [
      "/ui/missing.js",
      "/ui/data/accounts.json",
      "/ui/src/server.mjs",
      "/ui/..%2f..%2fdata/accounts.json",
    ]) {
      assert.equal((await raw(name)).status, 404, name);
    }
    assert.equal((await raw("/ui/console-client.js", {}, "POST")).status, 404);
    const page = await raw("/");
    assert.match(
      page.body.toString(),
      /type="module" src="\/ui\/console-client\.js"/,
    );
    assert.doesNotMatch(page.body.toString(), /function loginSettingsRead/);
    assert.equal(connections, 0);
  });
  console.log(`React 客户端离线测试 ${passed}/${passed} 通过`);
} finally {
  app.server.closeAllConnections();
  await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
