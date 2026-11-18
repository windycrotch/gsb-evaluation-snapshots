import {
  PLUGIN_RPC_TIMEOUT_MS,
  PluginEventNameSchema,
  PluginEventPayloadSchemas,
  PluginSettingsDefinitionsSchema,
  type HostWireMessage,
  type PluginEventName,
  type PluginWireRecord,
  type SandboxWireMessage,
} from './plugin-wire.port';
import { PlayerCommandSchema, ReviewCommandSchema } from '../../shared/ports/protocol.port';

type EventHandler = (payload: unknown) => void;

interface PluginInstance {
  record: PluginWireRecord;
  handlers: Map<PluginEventName, Set<EventHandler>>;
  cleanup: (() => void) | null;
  failed: boolean;
}

export interface VacnetPluginApi {
  plugin: { id: string; name: string; version: string };
  on: (name: string, handler: EventHandler) => () => void;
  emitReviewCommand: (command: unknown) => Promise<void>;
  emitPlayerCommand: (command: unknown) => Promise<void>;
  storage: {
    get: () => Promise<Record<string, unknown>>;
    set: (key: string, value: unknown) => Promise<void>;
    remove: (key: string) => Promise<void>;
  };
  settings: {
    define: (definitions: unknown) => Promise<Record<string, unknown>>;
    get: () => Promise<Record<string, unknown>>;
  };
  net: {
    fetch: (url: string, options?: { method?: string; body?: string; headers?: Record<string, string>; timeoutMs?: number }) =>
      Promise<{ status: number; ok: boolean; text: string }>;
  };
  ui: {
    setCard: (card: {
      title: string;
      text: string;
      slot?: 'metrics' | 'review';
      bars?: Array<{ label: string; value: number }>;
      actions?: Array<{ key: string; label: string }>;
      progress?: { value: number; label?: string } | null;
    }) => Promise<void>;
    clearCard: (slot?: 'metrics' | 'review') => Promise<void>;
  };
  dom: { addCss: (css: string) => Promise<void> };
  log: (...args: unknown[]) => void;
}

export interface PluginSandboxRuntimeOptions {
  post: (message: SandboxWireMessage) => void;
}

interface PendingRpc {
  /** Instance that initiated the call; stale after a reload, so failures never touch the new generation. */
  instance: PluginInstance;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: number;
}

type RpcRequestWire = Extract<SandboxWireMessage, { kind: 'rpc' }>['request'];

const PLUGIN_NET_MAX_BYTES = 2_097_152;
const PLUGIN_NET_DEFAULT_TIMEOUT_MS = 120_000;
const PLUGIN_NET_MIN_TIMEOUT_MS = 1_000;
const PLUGIN_NET_MAX_TIMEOUT_MS = 300_000;
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '0.0.0.0']);

type LocalFetchRequest = { url: string; method: string; headers: Record<string, string>; body?: string; timeoutMs: number };

/**
 * Rejections coming from the RPC layer already reported the plugin status;
 * API wrappers use this marker to avoid posting a second, vaguer error.
 */
class PluginRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginRpcError';
  }
}

/**
 * Plugins may only talk to loopback services (a local model server, etc.).
 * Returns the sanitized request or an error message for the plugin.
 */
const buildLocalFetch = (url: string, options: { method?: string; body?: string; headers?: Record<string, string>; timeoutMs?: number }): LocalFetchRequest | string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'net.fetch: invalid URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'net.fetch: only http/https URLs are allowed';
  }
  if (!LOCAL_HOSTNAMES.has(parsed.hostname)) {
    return 'net.fetch: only localhost services are allowed (127.0.0.1, localhost, [::1], 0.0.0.0)';
  }
  if (typeof options.body !== 'undefined' && typeof options.body !== 'string') {
    return 'net.fetch: body must be a string';
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (typeof value !== 'string') return 'net.fetch: header values must be strings';
    headers[name] = value;
  }
  const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
    ? Math.max(PLUGIN_NET_MIN_TIMEOUT_MS, Math.min(options.timeoutMs, PLUGIN_NET_MAX_TIMEOUT_MS))
    : PLUGIN_NET_DEFAULT_TIMEOUT_MS;
  return {
    url: parsed.href,
    method: typeof options.method === 'string' && options.method.trim() ? options.method : 'GET',
    headers,
    body: options.body,
    timeoutMs,
  };
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Executes user plugin code inside the MV3 sandbox page.
 *
 * The sandbox page has no extension APIs and an opaque origin, so plugin code
 * can only act through the validated RPC surface provided here. Every handler
 * and plugin body runs in its own try/catch: a broken plugin reports an error
 * status but never breaks its neighbours or the runtime.
 *
 * Status reporting is generation-aware: a `load` message and `dispose()` cancel
 * every pending RPC of the previous generation, and an answer arriving after
 * that finds no pending request and can no longer change any state.
 */
export class PluginSandboxRuntime {
  private readonly post: (message: SandboxWireMessage) => void;
  private readonly instances = new Map<string, PluginInstance>();
  private readonly pending = new Map<string, PendingRpc>();
  private isDisposed = false;

  constructor(options: PluginSandboxRuntimeOptions) {
    this.post = options.post;
  }

  handleHostMessage(message: HostWireMessage): void {
    if (this.isDisposed) return;
    switch (message.kind) {
      case 'load': return this.loadPlugins(message.plugins);
      case 'event': return this.dispatchEvent(message.name, message.payload);
      case 'rpc-response': return this.resolveRpc(message.id, message.result);
    }
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    // Reject first; the disposed flag makes sure no teardown rejection is
    // surfaced as a fresh plugin-status message.
    this.rejectAllPending(new PluginRpcError('Plugin sandbox disposed.'));
    this.disposeInstances();
  }

  private loadPlugins(records: PluginWireRecord[]): void {
    // A new batch replaces the whole generation: cancel in-flight requests of
    // the previous instances before tearing them down, so neither their
    // rejections nor a late host answer can touch the plugins loading now.
    this.rejectAllPending(new PluginRpcError('Plugin reloaded before the host answered.'));
    this.disposeInstances();
    for (const record of records) {
      const instance: PluginInstance = {
        record,
        handlers: new Map(),
        cleanup: null,
        failed: false,
      };
      this.instances.set(record.id, instance);
      try {
        const api = this.createApi(instance);
        // User code runs immediately with a single `vacnet` argument.
        const result = new Function('vacnet', record.code)(api) as unknown;
        if (typeof result === 'function') instance.cleanup = result as () => void;
        this.post({ kind: 'plugin-status', id: record.id, status: 'running' });
      } catch (error) {
        this.fail(instance, describeError(error));
      }
    }
  }

  private disposeInstances(): void {
    for (const instance of this.instances.values()) {
      for (const handler of instance.handlers.values()) handler.clear();
      instance.handlers.clear();
      try {
        instance.cleanup?.();
      } catch { /* Cleanup failures must not block the next load. */ }
      instance.cleanup = null;
    }
    this.instances.clear();
  }

  private dispatchEvent(name: string, payload: unknown): void {
    const eventName = PluginEventNameSchema.safeParse(name);
    if (!eventName.success) return;
    const payloadSchema = PluginEventPayloadSchemas[eventName.data];
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) return;
    // Addressed events (settings-changed, card-action) go to the owning
    // plugin only; the rest broadcast to every running instance.
    const targeted = eventName.data === 'card-action' || eventName.data === 'settings-changed';
    const owner = (parsed.data as { pluginId?: string }).pluginId;
    const targets = targeted
      ? [this.instances.get(String(owner))].filter((instance): instance is PluginInstance => Boolean(instance))
      : [...this.instances.values()];
    for (const instance of targets) {
      const handlers = instance.handlers.get(eventName.data);
      if (!handlers) continue;
      for (const handler of handlers) {
        try {
          handler(parsed.data);
        } catch (error) {
          this.fail(instance, `${eventName.data}: ${describeError(error)}`);
        }
      }
    }
  }

  private resolveRpc(id: string, result: { ok: boolean; value?: unknown; error?: string }): void {
    const pending = this.pending.get(id);
    // Unknown id: the request already timed out, was reloaded away or the
    // runtime was disposed. The late answer must not change any state.
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    this.pending.delete(id);
    if (result.ok) {
      pending.resolve(result.value);
      return;
    }
    const error = new PluginRpcError(result.error ?? 'Plugin request failed.');
    this.fail(pending.instance, error.message);
    pending.reject(error);
  }

  private rpc<T>(instance: PluginInstance, request: RpcRequestWire): Promise<T> {
    if (this.isDisposed) return Promise.reject(new PluginRpcError('Plugin sandbox disposed.'));
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const entry: PendingRpc = {
        instance,
        resolve: (value) => resolve(value as T),
        reject,
        timeoutId: 0,
      };
      entry.timeoutId = window.setTimeout(() => {
        this.pending.delete(id);
        const error = new PluginRpcError(`Plugin request timed out: ${request.method}`);
        // Timeout is a real, observable failure: mark the plugin so reviewers
        // can tell a dead local service apart from healthy plugin code.
        this.fail(instance, error.message);
        reject(error);
      }, PLUGIN_RPC_TIMEOUT_MS);
      this.pending.set(id, entry);
      try {
        this.post({ kind: 'rpc', id, pluginId: instance.record.id, request });
      } catch (error) {
        clearTimeout(entry.timeoutId);
        this.pending.delete(id);
        const wrapped = new PluginRpcError(describeError(error));
        this.fail(instance, wrapped.message);
        reject(wrapped);
      }
    });
  }

  /** Rejects (and clears the timers of) every pending request of the current generation. */
  private rejectAllPending(error: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timeoutId);
      entry.reject(error);
    }
  }

  /**
   * Reports an error status for a live instance. Silently drops statuses for
   * instances that have already been reloaded away, or after disposal, so a
   * stale callback can never overwrite the newest real result.
   */
  private fail(instance: PluginInstance, message: string): void {
    if (this.isDisposed || !this.instances.has(instance.record.id)) return;
    instance.failed = true;
    this.post({ kind: 'plugin-status', id: instance.record.id, status: 'error', message });
  }

  private createApi(instance: PluginInstance): VacnetPluginApi {
    const guard = <T>(action: () => Promise<T>, context: string): Promise<T | void> =>
      action().catch((error: unknown) => {
        // RPC failures (timeout, host error, reload/dispose) already reported.
        if (error instanceof PluginRpcError) return;
        this.fail(instance, `${context}: ${describeError(error)}`);
      });

    const rpc = <T>(request: RpcRequestWire): Promise<T> => this.rpc<T>(instance, request);

    const validatedCommand = <T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T } }, command: unknown, context: string): Promise<T> => {
      const parsed = schema.safeParse(command);
      if (!parsed.success) {
        return Promise.reject(new Error(`${context}: invalid command`));
      }
      return Promise.resolve(parsed.data as T);
    };

    return {
      plugin: { id: instance.record.id, name: instance.record.name, version: instance.record.version },
      on: (name, handler) => {
        const parsed = PluginEventNameSchema.safeParse(name);
        if (!parsed.success) return () => undefined;
        const set = instance.handlers.get(parsed.data) ?? new Set();
        set.add(handler);
        instance.handlers.set(parsed.data, set);
        return () => { set.delete(handler); };
      },
      emitReviewCommand: (command) => guard(
        () => validatedCommand(ReviewCommandSchema, command, 'emitReviewCommand')
          .then((parsed) => rpc({ method: 'review-command', command: parsed })),
        'emitReviewCommand',
      ),
      emitPlayerCommand: (command) => guard(
        () => validatedCommand(PlayerCommandSchema, command, 'emitPlayerCommand')
          .then((parsed) => rpc({ method: 'player-command', command: parsed })),
        'emitPlayerCommand',
      ),
      storage: {
        // RPC rejections already flipped the plugin to error; resolve with an
        // empty object so plugin code has a stable fallback to continue with.
        get: () => rpc<Record<string, unknown>>({ method: 'storage.get' }).catch(() => ({})),
        set: (key, value) => guard(
          () => rpc({ method: 'storage.set', key, value }),
          'storage.set',
        ),
        remove: (key) => guard(
          () => rpc({ method: 'storage.remove', key }),
          'storage.remove',
        ),
      },
      settings: {
        define: (definitions) => {
          const parsed = PluginSettingsDefinitionsSchema.safeParse(definitions);
          if (!parsed.success) {
            return Promise.reject(new Error('settings.define: invalid definitions'));
          }
          return rpc<Record<string, unknown>>({ method: 'settings.define', settings: parsed.data }).catch(() => ({}));
        },
        get: () => rpc<Record<string, unknown>>({ method: 'settings.get' }).catch(() => ({})),
      },
      net: {
        fetch: (url, options = {}) => {
          const request = buildLocalFetch(url, options);
          if (typeof request === 'string') {
            return Promise.reject(new Error(request));
          }
          return window.fetch(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            signal: AbortSignal.timeout(request.timeoutMs),
          }).then(async (response) => {
            // Local model services may need a while; cap the payload instead.
            const text = (await response.text()).slice(0, PLUGIN_NET_MAX_BYTES);
            return { status: response.status, ok: response.ok, text };
          });
        },
      },
      ui: {
        setCard: (card) => guard(
          () => rpc({ method: 'ui.card', card: { ...card, slot: card.slot ?? 'metrics' } }),
          'ui.setCard',
        ),
        clearCard: (slot) => guard(
          () => rpc({ method: 'ui.card', card: null, slot: slot ?? 'metrics' }),
          'ui.clearCard',
        ),
      },
      dom: {
        addCss: (css) => guard(
          () => rpc({ method: 'dom.css', css }),
          'dom.addCss',
        ),
      },
      log: (...args) => {
        // The sandbox iframe is hidden; logs land in the extension devtools.
        console.log(`[vacnet-plugin:${instance.record.id}]`, ...args);
      },
    };
  }
}
