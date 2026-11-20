// Helpers for the local WebSocket tests: start `wrangler dev` on a free port,
// connect real WebSocket clients to it and wait for the room's messages.
//
// Nothing here touches YouTube, a Cloudflare account or the production Worker:
// the server runs locally in workerd with the test config in this folder.

import { spawn } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join as joinPath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const repo = joinPath(here, "..");
const WRANGLER = joinPath(repo, "node_modules", "wrangler", "bin", "wrangler.js");

export const ROOM_PATH = "/ws/lobby";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Any HTTP answer means workerd is listening. A plain GET never creates a player,
// unlike a probe WebSocket, so it can't disturb what a test is about to check.
function httpProbe(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: ROOM_PATH, method: "GET", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

async function waitForPort(port, timeoutMs, exited) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited()) throw new Error("wrangler dev exited before listening");
    if (await httpProbe(port)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`wrangler dev did not come up on port ${port} in time`);
}

/**
 * Start the room Worker locally with short limits for the test run.
 * `options.persist` reuses an earlier run's storage (to test that state survives
 * a restart); otherwise a throwaway directory is used and removed by stop().
 */
export async function startServer(vars = {}, options = {}) {
  const port = await freePort();
  const ownsPersist = !options.persist;
  const persist = options.persist || mkdtempSync(joinPath(tmpdir(), "lofi-lobby-test-"));
  const args = [
    WRANGLER,
    "dev",
    "--config",
    joinPath(here, "wrangler.toml"),
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    persist,
    "--log-level",
    "error",
    "--show-interactive-dev-session=false",
  ];
  // test password: never the real secret, and it only lives in this process
  const allVars = { ADMIN_PASSWORD: "test-password", ...vars };
  for (const [k, v] of Object.entries(allVars)) args.push("--var", `${k}:${v}`);

  const child = spawn(process.execPath, args, {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exited = () => child.exitCode !== null;

  const stop = () => {
    if (child.exitCode === null) {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGKILL");
      }
    }
    if (ownsPersist) {
      try { rmSync(persist, { recursive: true, force: true }); } catch {}
    }
  };

  try {
    await waitForPort(port, 90_000, exited);
  } catch (err) {
    stop();
    throw new Error(`${err.message}\n--- wrangler output ---\n${output}`);
  }
  return { port, persist, stop, output: () => output };
}

/**
 * One client connection. Messages are queued so a test can await the next one
 * matching a predicate without caring about unrelated traffic.
 */
export function client(port, { ip = "127.0.0.1", clientId } = {}) {
  const url = `ws://127.0.0.1:${port}${ROOM_PATH}` + (clientId ? `?client=${encodeURIComponent(clientId)}` : "");
  const ws = new WebSocket(url, {
    origin: `http://127.0.0.1:${port}`,
    headers: { "cf-connecting-ip": ip },
  });
  const queue = []; // every message, in order
  const waiters = [];
  const errors = [];
  let closed = null;

  const settle = () => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      const idx = queue.findIndex((m) => w.match(m));
      if (idx === -1) continue;
      const [msg] = queue.splice(idx, 1);
      waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    }
  };

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    queue.push(msg);
    settle();
  });
  const opened = new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.on("error", (e) => errors.push(e));
  ws.on("close", (code, reason) => {
    closed = { code, reason: String(reason || "") };
    for (const w of waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error(`socket closed (${code}) while waiting: ${JSON.stringify(queue)}`));
    }
  });

  const api = {
    ws,
    errors,
    get closed() { return closed; },
    opened,
    send(msg) {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg));
    },
    /** Resolve with the first (queued or future) message that matches. */
    next(match, timeoutMs = 6000) {
      const predicate = typeof match === "function" ? match : (m) => m.t === match;
      const idx = queue.findIndex(predicate);
      if (idx !== -1) return Promise.resolve(queue.splice(idx, 1)[0]);
      if (closed) return Promise.reject(new Error(`socket already closed (${closed.code})`));
      return new Promise((resolve, reject) => {
        const w = { match: predicate, resolve, reject };
        w.timer = setTimeout(() => {
          const at = waiters.indexOf(w);
          if (at !== -1) waiters.splice(at, 1);
          reject(new Error(`timed out waiting for ${String(match)}; queued: ${JSON.stringify(queue)}`));
        }, timeoutMs);
        waiters.push(w);
      });
    },
    /** Resolve when no matching message arrives within `ms` (used for "must not happen"). */
    async none(match, ms = 500) {
      try {
        const m = await api.next(match, ms);
        throw new Error(`unexpected message: ${JSON.stringify(m)}`);
      } catch (err) {
        if (/timed out waiting/.test(err.message)) return;
        throw err;
      }
    },
    close() {
      try { ws.close(1000, "test done"); } catch {}
    },
    /** Wait for the socket to be fully closed, or give up after `ms`. */
    async waitClosed(ms = 3000) {
      if (closed) return closed;
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), ms);
        ws.once("close", (code, reason) => {
          clearTimeout(timer);
          resolve({ code, reason: String(reason || "") });
        });
      });
    },
  };
  return api;
}

/**
 * Connect like the page does: wait for `you` + `state`, then send `hello`
 * (an unnamed connection is a player too, but `joined` is only announced on hello).
 */
export async function join(port, opts = {}) {
  const c = client(port, opts);
  await c.opened;
  const you = await c.next("you");
  const state = await c.next("state");
  c.send({ t: "hello", name: opts.name || "trainer", gender: opts.gender || "male" });
  return { c, id: you.id, state: state.players || [] };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
