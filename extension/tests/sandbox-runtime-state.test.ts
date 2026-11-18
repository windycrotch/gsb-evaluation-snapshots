import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginSandboxRuntime } from '../src/features/plugins/sandbox-runtime.service';
import {
  PLUGIN_RPC_TIMEOUT_MS,
  type PluginWireRecord,
  type SandboxWireMessage,
} from '../src/features/plugins/plugin-wire.port';

type StatusMessage = Extract<SandboxWireMessage, { kind: 'plugin-status' }>;
type RpcMessage = Extract<SandboxWireMessage, { kind: 'rpc' }>;

interface Harness {
  posted: SandboxWireMessage[];
  rpcs: RpcMessage[];
  runtime: PluginSandboxRuntime;
  statuses: (id?: string) => StatusMessage[];
  respond: (id: string, result: { ok: boolean; value?: unknown; error?: string }) => void;
}

const harness = (): Harness => {
  const posted: SandboxWireMessage[] = [];
  const rpcs: RpcMessage[] = [];
  const runtime = new PluginSandboxRuntime({
    post: (message) => {
      posted.push(message);
      if (message.kind === 'rpc') rpcs.push(message);
    },
  });
  return {
    posted,
    rpcs,
    runtime,
    statuses: (id) => posted.filter(
      (message): message is StatusMessage => message.kind === 'plugin-status'
        && (id === undefined || message.id === id),
    ),
    respond: (id, result) => runtime.handleHostMessage({ kind: 'rpc-response', id, result }),
  };
};

const plugin = (id: string, code: string): PluginWireRecord => ({ id, name: id, version: '1.0.0', code });

const load = (h: Harness, ...records: PluginWireRecord[]): void => {
  h.runtime.handleHostMessage({ kind: 'load', plugins: records });
};

const clipPayload = (): unknown => ({
  clip: {
    taskId: 'task-1', sourceWebmUrl: 'https://replay-video.valve.net/a.webm', videoId: 'v1',
    range: { start: 0, end: 60 }, eventTime: 10, reviewType: 'cheating', clipCount: null,
    app: '730', matchTimestamp: null, webmDuration: null,
  },
  deduplication: 'new-match',
});

const readGlobal = <T>(key: string): T | undefined => (globalThis as Record<string, unknown>)[key] as T | undefined;
const clearGlobal = (key: string): void => { delete (globalThis as Record<string, unknown>)[key]; };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PluginSandboxRuntime: load / replace lifecycle', () => {
  it('reports running on success and error with the message on throw, isolating batch members', () => {
    const h = harness();
    load(
      h,
      plugin('aaa', 'throw new Error("boom")'),
      plugin('bbb', 'vacnet.log("healthy");'),
      plugin('ccc', 'throw new Error("kaput")'),
    );
    const statuses = h.statuses();
    expect(statuses).toHaveLength(3);
    expect(statuses[0]).toMatchObject({ id: 'aaa', status: 'error', message: 'boom' });
    expect(statuses[1]).toMatchObject({ id: 'bbb', status: 'running' });
    expect(statuses[2]).toMatchObject({ id: 'ccc', status: 'error', message: 'kaput' });
    // The healthy plugin still receives broadcast events.
    (globalThis as Record<string, unknown>).__hits = [];
    load(h, plugin('bbb', 'vacnet.on("clip-loaded", () => globalThis.__hits.push(1));'));
    h.runtime.handleHostMessage({ kind: 'event', name: 'clip-loaded', payload: clipPayload() });
    expect(readGlobal<unknown[]>('__hits')).toEqual([1]);
    clearGlobal('__hits');
    h.runtime.dispose();
  });

  it('a fresh load replaces a previous error with the newest real status', () => {
    const h = harness();
    load(h, plugin('aaa', 'throw new Error("first failure")'));
    expect(h.statuses('aaa').at(-1)).toMatchObject({ status: 'error' });
    load(h, plugin('aaa', 'vacnet.log("reloaded");'));
    expect(h.statuses('aaa').map((s) => s.status)).toEqual(['error', 'running']);
    h.runtime.dispose();
  });

  it('clears pending RPCs and runs cleanups of the previous batch before loading the new one', async () => {
    vi.useFakeTimers();
    const h = harness();
    load(h, plugin('aaa', `
      vacnet.storage.get().then((value) => { globalThis.__oldGeneration = value; });
      return () => { globalThis.__cleanedUp = true; };
    `));
    const oldRpc = h.rpcs[0];
    expect(oldRpc).toBeDefined();
    expect(vi.getTimerCount()).toBe(1);

    load(h, plugin('bbb', 'vacnet.log("new generation");'));

    // Cleanup of the replaced instance ran, its timeout was cleared...
    expect(readGlobal<boolean>('__cleanedUp')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    // ...the old pending RPC rejected (fallback resolves to {}) without an
    // error status being attributed to the reloaded-away plugin.
    await vi.advanceTimersByTimeAsync(0);
    expect(readGlobal<unknown>('__oldGeneration')).toEqual({});
    expect(h.statuses('aaa').map((s) => s.status)).toEqual(['running']);
    // A late answer to the cancelled request changes nothing.
    h.respond(oldRpc!.id, { ok: true, value: { secret: true } });
    expect(h.statuses('aaa')).toHaveLength(1);
    expect(readGlobal<unknown>('__oldGeneration')).toEqual({});
    clearGlobal('__cleanedUp');
    clearGlobal('__oldGeneration');
    h.runtime.dispose();
  });

  it('keeps a failing neighbour\'s pending RPCs working in the same batch', async () => {
    vi.useFakeTimers();
    const h = harness();
    load(
      h,
      plugin('aaa', 'throw new Error("boom")'),
      plugin('bbb', 'vacnet.storage.get();'),
    );
    expect(h.statuses('aaa').at(-1)).toMatchObject({ status: 'error' });
    const bbbRpc = h.rpcs.find((m) => m.pluginId === 'bbb');
    expect(bbbRpc).toBeDefined();
    h.respond(bbbRpc!.id, { ok: true, value: { ok: true } });
    await vi.advanceTimersByTimeAsync(PLUGIN_RPC_TIMEOUT_MS + 1);
    expect(h.statuses('bbb').map((s) => s.status)).toEqual(['running']);
    h.runtime.dispose();
  });
});

describe('PluginSandboxRuntime: RPC timeouts and late answers', () => {
  it('rejects the RPC and flips the plugin to error after PLUGIN_RPC_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    const h = harness();
    load(h, plugin('aaa', 'vacnet.storage.get();'));
    const rpc = h.rpcs[0]!;
    await vi.advanceTimersByTimeAsync(PLUGIN_RPC_TIMEOUT_MS - 1);
    expect(h.statuses('aaa').map((s) => s.status)).toEqual(['running']);
    await vi.advanceTimersByTimeAsync(1);
    const last = h.statuses('aaa').at(-1)!;
    expect(last.status).toBe('error');
    expect(last.message).toContain('timed out');
    expect(vi.getTimerCount()).toBe(0);

    // Neither a successful nor a failed late answer may touch state again.
    const postsBefore = h.posted.length;
    h.respond(rpc.id, { ok: true, value: { late: true } });
    h.respond(rpc.id, { ok: false, error: 'late failure' });
    expect(h.posted).toHaveLength(postsBefore);
    expect(h.statuses('aaa').at(-1)).toEqual(last);
    h.runtime.dispose();
  });

  it('times out only the offending plugin while neighbours keep running', async () => {
    vi.useFakeTimers();
    const h = harness();
    load(
      h,
      plugin('aaa', 'vacnet.storage.get();'),
      plugin('bbb', 'vacnet.storage.get();'),
    );
    const [aaaRpc, bbbRpc] = h.rpcs;
    h.respond(bbbRpc!.id, { ok: true, value: {} });
    await vi.advanceTimersByTimeAsync(PLUGIN_RPC_TIMEOUT_MS + 1);
    expect(h.statuses('aaa').at(-1)).toMatchObject({ status: 'error' });
    expect(h.statuses('bbb').map((s) => s.status)).toEqual(['running']);
    expect(aaaRpc).toBeDefined();
    h.runtime.dispose();
  });

  it('reports host-side RPC errors with the host message', () => {
    const h = harness();
    load(h, plugin('aaa', 'vacnet.storage.get();'));
    h.respond(h.rpcs[0]!.id, { ok: false, error: 'local service unreachable' });
    expect(h.statuses('aaa').at(-1)).toMatchObject({
      status: 'error',
      message: 'local service unreachable',
    });
    h.runtime.dispose();
  });

  it('resolves successful RPCs without changing plugin status', async () => {
    const h = harness();
    (globalThis as Record<string, unknown>).__value = null;
    load(h, plugin('aaa', `
      vacnet.storage.get().then((value) => { globalThis.__value = value; });
    `));
    h.respond(h.rpcs[0]!.id, { ok: true, value: { count: 3 } });
    await vi.waitFor(() => expect(readGlobal<unknown>('__value')).toEqual({ count: 3 }));
    expect(h.statuses('aaa').map((s) => s.status)).toEqual(['running']);
    clearGlobal('__value');
    h.runtime.dispose();
  });
});

describe('PluginSandboxRuntime: net.fetch restrictions', () => {
  const blockedCases: Array<[string, string]> = [
    ['https://example.com/data', 'non-loopback host'],
    ['http://192.168.1.5/model', 'private but non-loopback host'],
    ['http://127.0.0.1.evil.com/x', 'hostname ending in loopback suffix'],
    ['http://[::2]/', 'non-loopback IPv6'],
    ['ftp://127.0.0.1/file', 'non-http(s) protocol'],
    ['file:///etc/passwd', 'file protocol'],
    ['not a url', 'unparseable URL'],
    ['http://localhost.attacker.test/', 'localhost lookalike host'],
  ];

  it('rejects invalid URLs, protocols and hosts without calling window.fetch', async () => {
    const h = harness();
    const fetchSpy = vi.fn(() => Promise.reject(new Error('fetch must not be called')));
    vi.stubGlobal('fetch', fetchSpy);
    (globalThis as Record<string, unknown>).__netErrors = [];
    load(h, plugin('aaa', `
      const attempts = ${JSON.stringify(blockedCases.map(([url]) => url))};
      Promise.all(attempts.map((url) => vacnet.net.fetch(url)
        .then(() => 'resolved')
        .catch((error) => error.message)))
        .then((messages) => { globalThis.__netErrors = messages; });
    `));
    await vi.waitFor(() => {
      const messages = readGlobal<string[]>('__netErrors');
      expect(messages).toHaveLength(blockedCases.length);
    });
    const messages = readGlobal<string[]>('__netErrors')!;
    // Every rejection is a validation error explaining which rule failed.
    expect(messages.every((m) => m.startsWith('net.fetch:'))).toBe(true);
    expect(new Set(messages).size).toBeGreaterThan(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    clearGlobal('__netErrors');
    h.runtime.dispose();
  });

  it('rejects non-string bodies and header values without calling window.fetch', async () => {
    const h = harness();
    const fetchSpy = vi.fn(() => Promise.reject(new Error('fetch must not be called')));
    vi.stubGlobal('fetch', fetchSpy);
    (globalThis as Record<string, unknown>).__optionErrors = [];
    load(h, plugin('aaa', `
      const calls = [
        () => vacnet.net.fetch('http://127.0.0.1/', { body: 42 }),
        () => vacnet.net.fetch('http://localhost/', { headers: { 'X-Token': 7 } }),
      ];
      Promise.all(calls.map((call) => call().catch((error) => error.message)))
        .then((messages) => { globalThis.__optionErrors = messages; });
    `));
    await vi.waitFor(() => expect(readGlobal<string[]>('__optionErrors')).toHaveLength(2));
    expect(readGlobal<string[]>('__optionErrors')!.every((m) => m.startsWith('net.fetch:'))).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    clearGlobal('__optionErrors');
    h.runtime.dispose();
  });

  it.each([
    'http://127.0.0.1:8770/analyze',
    'http://localhost:8770/analyze',
    'http://[::1]:8770/analyze',
    'http://0.0.0.0:8770/analyze',
    'https://127.0.0.1/analyze',
  ])('allows the loopback URL %s', async (url) => {
    const h = harness();
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchSpy);
    (globalThis as Record<string, unknown>).__ok = false;
    load(h, plugin('aaa', `
      vacnet.net.fetch(${JSON.stringify(url)}).then(() => { globalThis.__ok = true; });
    `));
    await vi.waitFor(() => expect(readGlobal<boolean>('__ok')).toBe(true));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(url);
    clearGlobal('__ok');
    h.runtime.dispose();
  });

  it('passes method, headers and body through unchanged and returns status, ok and text', async () => {
    const h = harness();
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('hello', { status: 500, statusText: 'Server Error' })));
    vi.stubGlobal('fetch', fetchSpy);
    (globalThis as Record<string, unknown>).__response = undefined;
    load(h, plugin('aaa', `
      vacnet.net.fetch('http://127.0.0.1:9000/infer', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Model': 'local' },
        body: '{"frame":42}',
      }).then((response) => { globalThis.__response = response; });
    `));
    await vi.waitFor(() => expect(readGlobal<unknown>('__response')).toBeDefined());
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9000/infer');
    expect(init.method).toBe('PATCH');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'X-Model': 'local' });
    expect(init.body).toBe('{"frame":42}');
    const response = readGlobal<{ status: number; ok: boolean; text: string }>('__response')!;
    expect(response.status).toBe(500);
    expect(response.ok).toBe(false);
    expect(response.text).toBe('hello');
    clearGlobal('__response');
    h.runtime.dispose();
  });

  it('truncates response text to 2 MiB', async () => {
    const h = harness();
    const oversized = 'a'.repeat(3 * 1024 * 1024);
    const fetchSpy = vi.fn(() => Promise.resolve(new Response(oversized, { status: 200 })));
    vi.stubGlobal('fetch', fetchSpy);
    (globalThis as Record<string, unknown>).__length = 0;
    load(h, plugin('aaa', `
      vacnet.net.fetch('http://localhost/big').then((r) => { globalThis.__length = r.text.length; });
    `));
    await vi.waitFor(() => expect(readGlobal<number>('__length')).toBe(2_097_152));
    clearGlobal('__length');
    h.runtime.dispose();
  });

  it('clamps the fetch timeout into the 1s..300s range and defaults invalid values to 120s', async () => {
    const h = harness();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms) => new AbortController().signal);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))));
    (globalThis as Record<string, unknown>).__done = 0;
    const cases: Array<[number | undefined, number]> = [
      [500, 1_000],
      [1_000, 1_000],
      [60_000, 60_000],
      [300_000, 300_000],
      [999_999, 300_000],
    ];
    load(h, plugin('aaa', `
      const cases = ${JSON.stringify(cases.map(([ms]) => ms))};
      Promise.all(cases.map((ms) => vacnet.net.fetch('http://127.0.0.1/', { timeoutMs: ms })))
        .then(() => { globalThis.__done = cases.length; });
    `));
    await vi.waitFor(() => expect(readGlobal<number>('__done')).toBe(cases.length));
    expect(timeoutSpy.mock.calls.map(([ms]) => ms)).toEqual(cases.map(([, expected]) => expected));
    clearGlobal('__done');
    h.runtime.dispose();

    // Non-finite / missing timeouts fall back to the 120s default.
    const h2 = harness();
    const timeoutSpy2 = vi.spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => new AbortController().signal);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))));
    (globalThis as Record<string, unknown>).__done2 = 0;
    load(h2, plugin('bbb', `
      Promise.all([
        vacnet.net.fetch('http://127.0.0.1/a', { timeoutMs: Infinity }),
        vacnet.net.fetch('http://127.0.0.1/b', { timeoutMs: Number.NaN }),
        vacnet.net.fetch('http://127.0.0.1/c'),
      ]).then(() => { globalThis.__done2 = 3; });
    `));
    await vi.waitFor(() => expect(readGlobal<number>('__done2')).toBe(3));
    expect(timeoutSpy2.mock.calls.every(([ms]) => ms === 120_000)).toBe(true);
    clearGlobal('__done2');
    h2.runtime.dispose();
  });
});

describe('PluginSandboxRuntime: dispose', () => {
  it('rejects all pending RPCs and ignores every host message arriving afterwards', async () => {
    vi.useFakeTimers();
    const h = harness();
    (globalThis as Record<string, unknown>).__settled = null;
    load(h, plugin('aaa', `
      vacnet.storage.get().then(
        (value) => { globalThis.__settled = ['resolved', value]; },
        (error) => { globalThis.__settled = ['rejected', error.message]; },
      );
    `));
    const rpc = h.rpcs[0]!;
    expect(vi.getTimerCount()).toBe(1);

    h.runtime.dispose();
    expect(vi.getTimerCount()).toBe(0);
    // The wrapper converts the rejection into the documented {} fallback,
    // proving the pending promise actually settled instead of hanging.
    await vi.advanceTimersByTimeAsync(0);
    expect(readGlobal<unknown>('__settled')).toEqual(['resolved', {}]);
    const postsAfterDispose = h.posted.length;

    h.respond(rpc.id, { ok: true, value: { late: true } });
    h.runtime.handleHostMessage({ kind: 'load', plugins: [plugin('ccc', 'vacnet.log("x");')] });
    h.runtime.handleHostMessage({ kind: 'event', name: 'clip-loaded', payload: clipPayload() });
    h.runtime.handleHostMessage({ kind: 'event', name: 'card-action', payload: { pluginId: 'aaa', key: 'go' } });
    expect(h.posted).toHaveLength(postsAfterDispose);
    clearGlobal('__settled');
  });

  it('dispose is idempotent and posts no status of its own', () => {
    const h = harness();
    load(h, plugin('aaa', 'vacnet.log("up");'));
    const before = h.posted.length;
    h.runtime.dispose();
    h.runtime.dispose();
    expect(h.posted).toHaveLength(before);
  });
});

describe('PluginSandboxRuntime: event routing and validation', () => {
  it('delivers card-action and settings-changed only to the owning plugin', () => {
    const h = harness();
    (globalThis as Record<string, unknown>).__actions = [];
    (globalThis as Record<string, unknown>).__settings = [];
    load(
      h,
      plugin('aaa', `
        vacnet.on('card-action', (event) => globalThis.__actions.push(['aaa', event.key]));
        vacnet.on('settings-changed', (event) => globalThis.__settings.push(['aaa', event.values]));
      `),
      plugin('bbb', `
        vacnet.on('card-action', (event) => globalThis.__actions.push(['bbb', event.key]));
        vacnet.on('settings-changed', (event) => globalThis.__settings.push(['bbb', event.values]));
      `),
    );
    h.runtime.handleHostMessage({ kind: 'event', name: 'card-action', payload: { pluginId: 'aaa', key: 'run' } });
    h.runtime.handleHostMessage({
      kind: 'event',
      name: 'settings-changed',
      payload: { pluginId: 'bbb', values: { threshold: 0.8 } },
    });
    // Unknown owner: nothing is delivered.
    h.runtime.handleHostMessage({ kind: 'event', name: 'card-action', payload: { pluginId: 'zzz', key: 'run' } });
    expect(readGlobal<unknown[]>('__actions')).toEqual([['aaa', 'run']]);
    expect(readGlobal<unknown[]>('__settings')).toEqual([['bbb', { threshold: 0.8 }]]);
    clearGlobal('__actions');
    clearGlobal('__settings');
    h.runtime.dispose();
  });

  it('broadcasts all other events to every running instance', () => {
    const h = harness();
    (globalThis as Record<string, unknown>).__hits = [];
    load(
      h,
      plugin('aaa', 'vacnet.on("clip-loaded", () => globalThis.__hits.push("aaa"));'),
      plugin('bbb', 'vacnet.on("clip-loaded", () => globalThis.__hits.push("bbb"));'),
    );
    h.runtime.handleHostMessage({ kind: 'event', name: 'clip-loaded', payload: clipPayload() });
    expect(readGlobal<string[]>('__hits')?.sort()).toEqual(['aaa', 'bbb']);
    clearGlobal('__hits');
    h.runtime.dispose();
  });

  it('silently drops events whose payload fails validation', () => {
    const h = harness();
    (globalThis as Record<string, unknown>).__hits = [];
    load(
      h,
      plugin('aaa', `
        vacnet.on('card-action', () => globalThis.__hits.push('card'));
        vacnet.on('history-changed', () => globalThis.__hits.push('history'));
      `),
    );
    expect(() => {
      h.runtime.handleHostMessage({ kind: 'event', name: 'card-action', payload: { pluginId: 'aaa' } });
      h.runtime.handleHostMessage({ kind: 'event', name: 'card-action', payload: { pluginId: 'aaa', key: '' } });
      h.runtime.handleHostMessage({
        kind: 'event',
        name: 'history-changed',
        payload: { entryCount: -1, repeats: 0 },
      });
      h.runtime.handleHostMessage({ kind: 'event', name: 'history-changed', payload: { entryCount: 1 } });
    }).not.toThrow();
    expect(readGlobal<unknown[]>('__hits')).toEqual([]);
    clearGlobal('__hits');
    h.runtime.dispose();
  });

  it('reports a throwing event handler as an error without breaking later delivery', () => {
    const h = harness();
    (globalThis as Record<string, unknown>).__hits = 0;
    load(h, plugin('aaa', `
      let calls = 0;
      vacnet.on('history-changed', () => {
        calls += 1;
        globalThis.__hits = calls;
        if (calls === 1) throw new Error('handler broke');
      });
    `));
    const validPayload = { entryCount: 1, repeats: 0 };
    h.runtime.handleHostMessage({ kind: 'event', name: 'history-changed', payload: validPayload });
    expect(h.statuses('aaa').at(-1)).toMatchObject({ status: 'error', message: 'history-changed: handler broke' });
    h.runtime.handleHostMessage({ kind: 'event', name: 'history-changed', payload: validPayload });
    expect(readGlobal<number>('__hits')).toBe(2);
    clearGlobal('__hits');
    h.runtime.dispose();
  });
});
