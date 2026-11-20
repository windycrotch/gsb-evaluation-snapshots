import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RadioNowPlaying, RadioStation } from "@hyperplayer/schemas";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vite-plus/test";
import { buildApp } from "../src/app.ts";
import { setupAdmin, testConfig } from "./helpers.ts";

const METAINT = 1000;
/** Audio bytes are 0xAA here, like in radio-live.test.ts. */
const AUDIO = 0xaa;

/** An endless (or short) ICY stream: METAINT audio bytes, then a metadata block, again and again. */
function icyStream(signal: AbortSignal | null | undefined, title: string, endAfter = Infinity) {
  let blocks = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener(
        "abort",
        () => {
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        },
        { once: true },
      );
    },
    async pull(controller) {
      if (signal?.aborted || blocks >= endAfter) return controller.close();
      await new Promise((r) => setTimeout(r, 2));
      if (signal?.aborted || blocks >= endAfter) return controller.close();
      const meta = Buffer.from(`StreamTitle='${title}';StreamUrl='';`);
      const padded = Buffer.alloc(Math.ceil(meta.length / 16) * 16);
      meta.copy(padded);
      const block = Buffer.concat([Buffer.alloc(METAINT, AUDIO), Buffer.from([padded.length / 16]), padded]);
      controller.enqueue(block.subarray(0, 700));
      controller.enqueue(block.subarray(700));
      blocks++;
    },
  });
}

/** A plain audio body that ends after a few blocks (a station that stops giving audio). */
function finiteStream(signal: AbortSignal | null | undefined, blocks: number) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener(
        "abort",
        () => {
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        },
        { once: true },
      );
    },
    async pull(controller) {
      if (signal?.aborted || sent >= blocks) return controller.close();
      await new Promise((r) => setTimeout(r, 2));
      if (signal?.aborted || sent >= blocks) return controller.close();
      controller.enqueue(Buffer.alloc(METAINT, AUDIO));
      sent++;
    },
  });
}

/**
 * A stand-in for every station the tests play. Host names pick the behaviour; the number
 * of times each one was connected to is counted, so reconnect and sharing are observable.
 */
const mock = {
  connections: new Map<string, number>(),
  /** Hosts whose fetch fails at the network layer: connect() hands them straight to ffmpeg. */
  ffmpegOnly: new Set<string>(),
  reset() {
    this.connections.clear();
    this.ffmpegOnly.clear();
  },
  async fetch(url: string, init: RequestInit): Promise<Response> {
    const u = new URL(url);
    if (this.ffmpegOnly.has(u.host)) throw new TypeError(`fetch failed for ${u.host}`);
    const n = (this.connections.get(u.host) ?? 0) + 1;
    this.connections.set(u.host, n);
    switch (u.host) {
      case "shared.example.com":
        return new Response(icyStream(init.signal, "Shared - Song"), {
          headers: { "content-type": "audio/mpeg", "icy-metaint": String(METAINT) },
        });
      case "renamed.example.com":
        // Each new upstream connection names a different song, so a new listener can tell
        // a title its own stream earned from one the departed session left behind.
        return new Response(icyStream(init.signal, `Renamed - Take ${n}`), {
          headers: { "content-type": "audio/mpeg", "icy-metaint": String(METAINT) },
        });
      case "reconnect.example.com":
        // The first connection drops after one block; the next ones stay and name the new song.
        return new Response(icyStream(init.signal, `Take ${n}`, n === 1 ? 1 : Infinity), {
          headers: { "content-type": "audio/mpeg", "icy-metaint": String(METAINT) },
        });
      case "always-drops.example.com":
        // Every connection closes almost at once: the reconnect budget must run out.
        return new Response(icyStream(init.signal, "Dropping - Tune", 1), {
          headers: { "content-type": "audio/mpeg", "icy-metaint": String(METAINT) },
        });
      case "ogg.example.com":
        // A type players can't take as-is: the server pipes it through ffmpeg.
        return new Response(finiteStream(init.signal, 100_000), { headers: { "content-type": "audio/ogg" } });
      default:
        return new Response(null, { status: 404 });
    }
  },
};

let dir: string;
let ffmpegExe = "";
let ffmpegLog = "";
let ctx: Awaited<ReturnType<typeof buildApp>>;
let base: string;
let token: string;

/**
 * The fake ffmpeg is compiled once, at module scope and synchronously: `test.skipIf`
 * evaluates its condition before any `beforeAll` runs, so the binary must exist already.
 * Its directory is reused as the app's temp root and removed in `afterAll`.
 */
const gccAvailable = spawnSync("gcc", ["--version"]).status === 0;
if (gccAvailable) {
  dir = mkdtempSync(join(tmpdir(), "hyperplayer-radio-session-"));
  ffmpegExe = join(dir, "fakeffmpeg.exe");
  ffmpegLog = join(dir, "ffmpeg.log");
  const built = spawnSync("gcc", [
    join(import.meta.dirname, "fixtures/ffmpeg/fakeffmpeg.c"),
    "-o",
    ffmpegExe,
  ]);
  if (built.status !== 0) ffmpegExe = "";
}
// Every spawned fake ffmpeg inherits this and records its pid and input mode there.
if (ffmpegLog) process.env.FAKE_FFMPEG_LOG = ffmpegLog;

const spawned = () =>
  existsSync(ffmpegLog)
    ? readFileSync(ffmpegLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [pid, , mode] = line.split(" ");
          return { pid: Number(pid), mode: mode! };
        })
    : [];

const waitDead = async (pid: number) => {
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

beforeAll(async () => {
  if (!dir) dir = mkdtempSync(join(tmpdir(), "hyperplayer-radio-session-"));
  mkdirSync(join(dir, "music"));
  ctx = await buildApp(testConfig(join(dir, "music"), join(dir, "data"), { ffmpeg: ffmpegExe || "ffmpeg" }), {
    logger: false,
    fetch: (url, init) => mock.fetch(url, init),
    // Keep the backoff honest (exponential, capped) but fast enough for the tests.
    liveRetry: { maxReconnects: 2, baseDelayMs: 5 },
  });
  token = await setupAdmin(ctx.app);
  base = await ctx.app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => mock.reset());

afterEach(() => {
  delete process.env.FAKE_FFMPEG_DELAY_MS;
  delete process.env.FAKE_FFMPEG_FAIL;
});

const api = (
  path: string,
  init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
) => {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  Object.assign(headers, init.headers);
  return fetch(base + path, { ...init, headers });
};

/**
 * A JSON request with a few retries. The loopback test server occasionally hands back an
 * empty body on a loaded Windows runner; that's a transport flake, not a server behaviour,
 * so a short retry keeps the assertions about radio state deterministic.
 */
async function apiJson(path: string, init: Parameters<typeof api>[1] = {}) {
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await api(path, init);
      const text = await r.text();
      if (text) return JSON.parse(text) as unknown;
      last = new Error(`empty body from ${path} (status ${r.status})`);
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw last;
}

const addStation = (streamUrl: string) =>
  apiJson("/api/radio/stations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Station ${streamUrl}`, streamUrl }),
  }).then((json) => RadioStation.parse(json));

const nowPlaying = async (id: string) =>
  RadioNowPlaying.parse((await apiJson(`/api/radio/stations/${id}/now-playing`)) as never);

const until = async (check: () => Promise<boolean>, tries = 250) => {
  for (let i = 0; i < tries && !(await check()); i++) await new Promise((r) => setTimeout(r, 20));
};

/** Reads `bytes` (or until the stream ends), then hangs up. */
async function listen(res: Response, bytes: number): Promise<{ done: boolean; data: Buffer }> {
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  while (total < bytes) {
    const r = await reader.read();
    if (r.done) {
      done = true;
      break;
    }
    chunks.push(r.value);
    total += r.value.length;
  }
  await reader.cancel();
  reader.releaseLock();
  return { done, data: Buffer.concat(chunks) };
}

test("concurrent listeners share the title and count; one leaving keeps it, the last clears it", async () => {
  const station = await addStation("http://shared.example.com/live");
  const first = await api(`/api/radio/stations/${station.id}/stream`);
  const second = await api(`/api/radio/stations/${station.id}/stream`);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  // Each listener has its own upstream connection.
  await until(async () => mock.connections.get("shared.example.com") === 2);
  expect(mock.connections.get("shared.example.com")).toBe(2);

  const r1 = first.body!.getReader();
  const r2 = second.body!.getReader();
  await r1.read();
  await r2.read();
  await until(async () => (await nowPlaying(station.id)).title === "Shared - Song");
  expect(await nowPlaying(station.id)).toMatchObject({
    title: "Shared - Song",
    artist: "Shared",
    song: "Song",
  });

  // One listener goes: the station is still listened to, so the song stays.
  await r1.cancel();
  await new Promise((r) => setTimeout(r, 40));
  expect(await nowPlaying(station.id)).toMatchObject({ title: "Shared - Song" });
  expect(mock.connections.get("shared.example.com")).toBe(2);

  // The last listener goes: count back to zero, title recycled with the session.
  await r2.cancel();
  await until(async () => (await nowPlaying(station.id)).title === null);
  expect((await nowPlaying(station.id)).title).toBeNull();

  // A brand-new listener gets a recycled, title-free session and only ever learns a song
  // from its own upstream — never the departed session's "Shared - Song". A station whose
  // every connection names a new song makes inherited vs earned unambiguous.
  const fresh = await addStation("http://renamed.example.com/live");
  const third = await api(`/api/radio/stations/${fresh.id}/stream`);
  expect(third.status).toBe(200);
  const tReader = third.body!.getReader();
  // Stay connected long enough for the ICY metadata block to be parsed server-side.
  let thirdBytes = 0;
  while (thirdBytes < 2 * METAINT) thirdBytes += (await tReader.read()).value!.length;
  // The first title it reports is its own connection's — never a stale one.
  await until(async () => (await nowPlaying(fresh.id)).title === "Renamed - Take 1");
  expect((await nowPlaying(fresh.id)).title).toBe("Renamed - Take 1");
  await tReader.cancel();
  // The count falls to zero and the title clears with the session.
  await until(async () => (await nowPlaying(fresh.id)).title === null);
  expect((await nowPlaying(fresh.id)).title).toBeNull();

  // A later connection reports its own new title; the old one must never come back.
  const fourth = await api(`/api/radio/stations/${fresh.id}/stream`);
  const fReader = fourth.body!.getReader();
  let fourthBytes = 0;
  while (fourthBytes < 2 * METAINT) fourthBytes += (await fReader.read()).value!.length;
  await until(async () => (await nowPlaying(fresh.id)).title === "Renamed - Take 2");
  expect((await nowPlaying(fresh.id)).title).toBe("Renamed - Take 2");
  await fReader.cancel();
  await until(async () => (await nowPlaying(fresh.id)).title === null);
});

test("a dropped stream reconnects with backoff, and the new song is readable at once", async () => {
  const station = await addStation("http://reconnect.example.com/live");
  const res = await api(`/api/radio/stations/${station.id}/stream`);
  // Read past the first connection's data while still listening, so the title the
  // reconnected stream reports can be observed before this client hangs up.
  const reader = res.body!.getReader();
  let audio = 0;
  while (audio < 6 * METAINT) {
    const r = await reader.read();
    if (r.done) break;
    audio += r.value.length;
  }
  expect(audio).toBe(6 * METAINT);
  // First connection dropped; a second one was made and took over.
  await until(async () => mock.connections.get("reconnect.example.com") === 2);
  expect(mock.connections.get("reconnect.example.com")).toBe(2);
  await until(async () => (await nowPlaying(station.id)).title === "Take 2");
  expect((await nowPlaying(station.id)).title).toBe("Take 2");
  await reader.cancel();
  await until(async () => (await nowPlaying(station.id)).title === null);
});

test("aborting a listener stops its reconnect loop and leaves no session behind", async () => {
  const station = await addStation("http://reconnect.example.com/live");
  const res = await api(`/api/radio/stations/${station.id}/stream`);
  const reader = res.body!.getReader();
  await reader.read();
  await until(async () => (await nowPlaying(station.id)).title !== null);
  await reader.cancel();
  const connectionsAtAbort = mock.connections.get("reconnect.example.com");
  await new Promise((r) => setTimeout(r, 60));
  // No lingering reconnect attempts after the abort, and the session is gone.
  expect(mock.connections.get("reconnect.example.com")).toBe(connectionsAtAbort);
  await until(async () => (await nowPlaying(station.id)).title === null);
  expect((await nowPlaying(station.id)).title).toBeNull();
});

test("when the upstream keeps failing, reconnects are capped and the stream ends cleanly", async () => {
  const station = await addStation("http://always-drops.example.com/live");
  const res = await api(`/api/radio/stations/${station.id}/stream`);
  expect(res.status).toBe(200);
  const { done } = await listen(res, 10 * METAINT);
  // The audio side ended instead of hanging forever.
  expect(done).toBe(true);
  // First try plus exactly the capped number of reconnects (maxReconnects = 2).
  expect(mock.connections.get("always-drops.example.com")).toBe(3);
  await until(async () => (await nowPlaying(station.id)).title === null);
  expect((await nowPlaying(station.id)).title).toBeNull();

  // Listening again starts a fresh session, not a reused dead one.
  mock.connections.delete("always-drops.example.com");
  const again = await api(`/api/radio/stations/${station.id}/stream`);
  expect(again.status).toBe(200);
  await until(async () => (mock.connections.get("always-drops.example.com") ?? 0) > 0);
  const reader = again.body!.getReader();
  await reader.cancel();
  await until(async () => (await nowPlaying(station.id)).title === null);
});

test("an upstream that stops giving audio ends the stream and drops the listener count", async () => {
  const station = await addStation("http://always-drops.example.com/live");
  const res = await api(`/api/radio/stations/${station.id}/stream`);
  const reader = res.body!.getReader();
  let ended = false;
  for (;;) {
    const r = await reader.read();
    if (r.done) {
      ended = true;
      break;
    }
  }
  expect(ended).toBe(true);
  await until(async () => (await nowPlaying(station.id)).title === null);
  expect((await nowPlaying(station.id)).title).toBeNull();
});

test.skipIf(!gccAvailable || !ffmpegExe)(
  "aborting a transcoded listener kills ffmpeg and frees the upstream",
  async () => {
    writeFileSync(ffmpegLog, "");
    const station = await addStation("http://ogg.example.com/live");
    const res = await api(`/api/radio/stations/${station.id}/stream?direct=&format=opus&bitrate=64`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/ogg");

    await until(async () => spawned().length === 1);
    const proc = spawned().at(-1)!;
    expect(proc.mode).toBe("piped");
    // Confirm audio is actually flowing through the transcoder.
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value!.length).toBeGreaterThan(0);
    const connectionsAtAbort = mock.connections.get("ogg.example.com");

    // The listener hangs up: ffmpeg must be reaped and the upstream stream released.
    await reader.cancel();
    expect(await waitDead(proc.pid)).toBe(true);
    // The upstream isn't reconnected to after the listener is gone.
    await new Promise((r) => setTimeout(r, 60));
    expect(mock.connections.get("ogg.example.com")).toBe(connectionsAtAbort);
    await until(async () => (await nowPlaying(station.id)).title === null);
    expect((await nowPlaying(station.id)).title).toBeNull();
  },
);

test.skipIf(!gccAvailable || !ffmpegExe)(
  "an ffmpeg-read station is reaped on abort, even while it is still starting",
  async () => {
    writeFileSync(ffmpegLog, "");
    process.env.FAKE_FFMPEG_DELAY_MS = "2000";
    const station = await addStation("http://nativeff.example.com/live");
    mock.ffmpegOnly.add("nativeff.example.com");

    const stop = new AbortController();
    const pending = api(`/api/radio/stations/${station.id}/stream?direct=&format=mp3&bitrate=64`, {
      signal: stop.signal,
    });
    await until(async () => spawned().length === 1);
    const proc = spawned().at(-1)!;
    expect(proc.mode).toBe("url");

    stop.abort();
    await expect(pending).rejects.toThrow();
    expect(await waitDead(proc.pid)).toBe(true);
    await until(async () => (await nowPlaying(station.id)).title === null);
    expect((await nowPlaying(station.id)).title).toBeNull();
  },
);

test.skipIf(!gccAvailable || !ffmpegExe)(
  "an ffmpeg that never starts is an error response with no session left",
  async () => {
    writeFileSync(ffmpegLog, "");
    process.env.FAKE_FFMPEG_FAIL = "1";
    const station = await addStation("http://ogg.example.com/live");
    const res = await api(`/api/radio/stations/${station.id}/stream?direct=&format=opus&bitrate=64`);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "station_unavailable" });
    expect((await nowPlaying(station.id)).title).toBeNull();
    const proc = spawned().at(-1)!;
    expect(await waitDead(proc.pid)).toBe(true);
  },
);
