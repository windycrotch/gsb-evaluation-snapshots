import { readProtocolSource, protocolSourceInfo } from './protocol-source.mjs';
export { PROTO_BUNDLE } from './protocol-source.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const TARGET = 'chunks:///_virtual/proto-bundle.js';

function instanceOf(n, t) {
  return t != null && typeof Symbol !== 'undefined' && t[Symbol.hasInstance]
    ? !!t[Symbol.hasInstance](n)
    : n instanceof t;
}

const SWC_HELPERS = {
  _instanceof: { _: instanceOf },
  _type_of: { _: (v) => typeof v },
};

const emptyHelpers = new Proxy({}, { get: () => () => undefined });

function makeSystem(collector) {
  return {
    register(name, deps, declare) {
      if (typeof name !== 'string') {
        collector.outer = { deps: name, declare: deps };
        return;
      }
      if (name === TARGET) collector.target = { deps, declare };
    },
  };
}

function moduleRequire(name) {
  const base = name.slice(name.lastIndexOf('/') + 1);
  if (SWC_HELPERS[base]) return SWC_HELPERS[base];
  return emptyHelpers;
}

export function loadProtocol(bundlePath) {
  const src = readProtocolSource(bundlePath);
  const collector = { outer: null, target: null };

  const System = makeSystem(collector);
  const defined = new Map();
  const cache = new Map();

  function define(name, factory) {
    defined.set(name, factory);
  }

  function req(name) {
    if (cache.has(name)) return cache.get(name);
    const factory = defined.get(name);
    if (!factory) return moduleRequire(name);
    const mod = { exports: {} };
    cache.set(name, mod.exports);
    factory(req, mod, mod.exports);
    cache.set(name, mod.exports);
    return mod.exports;
  }

  const runtimeRequire = (name) => moduleRequire(name);

  new Function('define', 'require', 'System', 'console', src)(
    define,
    req,
    System,
    console,
  );

  const entry = [...defined.keys()].find((k) => /^src\/chunks\/bundle\..*\.js$/.test(k));
  if (!entry) throw new Error('bundle entry module not found');
  req(entry);

  if (!collector.outer) throw new Error('outer System.register not found');

  const outerApi = collector.outer.declare(() => {}, { id: '', meta: { url: '' } });
  outerApi.execute();

  if (!collector.target) throw new Error(`module not captured: ${TARGET}`);
  if (collector.target.deps.length !== 2) {
    throw new Error(`unexpected deps: ${JSON.stringify(collector.target.deps)}`);
  }

  let exports = {};
  const _export = (k, v) => {
    if (typeof k === 'object') Object.assign(exports, k);
    else exports[k] = v;
  };
  const api = collector.target.declare(_export, { id: TARGET, meta: { url: TARGET } });
  const minimal = require('protobufjs/minimal');
  api.setters[1]({ default: minimal });
  api.execute();

  const protocol = exports.protocol;
  if (!protocol) throw new Error('protocol table not exported');
  return protocol;
}

const sourceByProtocol = new WeakMap();
let latestProtocol = null;
const REQUIRED_MESSAGES = ['LoginRequest', 'LoginResponse', 'PingRequest', 'PingResponse', 'Ack', 'Nack'];

// The cache is only adopted after the selected file has loaded and its basic
// codecs have passed validation. Never silently reuse an older protocol when
// a newly discovered package is corrupt or incompatible.
export function getProtocol(bundlePath) {
  let source;
  try {
    source = protocolSourceInfo(bundlePath);
    if (latestProtocol?.source.signature === source.signature) return latestProtocol.protocol;
    const protocol = loadProtocol(source.file);
    for (const name of REQUIRED_MESSAGES) {
      const message = protocol[name];
      if (typeof message?.encode !== 'function' || typeof message?.decode !== 'function')
        throw new Error('缺少基础消息编解码：' + name);
      // Generated protobuf messages may encode required fields unconditionally.
      // Their defaults live on the constructor's prototype, not on a plain {}.
      const body = typeof message === 'function' ? new message() : message.create?.() ?? {};
      const bytes = message.encode(body).finish();
      message.decode(bytes);
    }
    if (protocolSourceInfo(bundlePath).signature !== source.signature)
      throw new Error('协议文件在加载期间发生变化，请重试连接');
    sourceByProtocol.set(protocol, source);
    latestProtocol = { protocol, source };
    return protocol;
  } catch (cause) {
    const error = new Error('无法加载当前协议，已阻止建立新连接：' + cause.message, { cause });
    error.name = 'ProtocolUpdateError';
    error.code = 'PROTOCOL_UPDATE_FAILED';
    error.source = source ?? null;
    throw error;
  }
}

export function getProtocolSource(protocol) {
  return sourceByProtocol.get(protocol) ?? null;
}

export function describe(protocol) {
  const keys = Object.keys(protocol);
  let messages = 0;
  let enums = 0;
  const services = [];
  for (const k of keys) {
    const v = protocol[k];
    if (typeof v === 'function' && typeof v.encode === 'function') messages++;
    else if (typeof v === 'function' && /Service/.test(k)) services.push(k);
    else if (v && typeof v === 'object' && !v.encode) enums++;
  }
  return { total: keys.length, messages, enums, services };
}
