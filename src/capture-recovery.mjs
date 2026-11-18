import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pointsToCapture, resumeCaptureProxy } from './platform/proxy.mjs';
import { atomicJson } from './json-store.mjs';

const PROXY_FIELDS = ['ProxyEnable', 'ProxyServer', 'ProxyOverride'];
const dataDirectory = process.env.CW_DATA_DIR ? path.resolve(process.env.CW_DATA_DIR) : path.resolve(import.meta.dirname, '../data');
export const CAPTURE_STATE_PATH = process.env.CW_CAPTURE_STATE ? path.resolve(process.env.CW_CAPTURE_STATE) : path.join(dataDirectory, 'capture-session.json');

export function createCaptureJournal(file = CAPTURE_STATE_PATH) {
  return {
    read() {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    write(record) { atomicJson(file, record); },
    clear() { fs.rmSync(file, { force: true }); },
  };
}

function validate(record) {
  if (record?.version !== 1 || typeof record.id !== 'string' || !record.ca
    || typeof record.ca.installedBefore !== 'boolean' || typeof record.ca.installAttempted !== 'boolean'
    || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) {
    throw new Error('上次采集恢复记录格式异常，请检查 capture-session.json');
  }
  if (record.ca.thumbprint != null && !/^[a-f0-9]{40}$/i.test(record.ca.thumbprint)) throw new Error('上次采集证书指纹格式异常');
  const proxy = record.proxy;
  if (proxy && (!proxy.original || !proxy.target || !Array.isArray(proxy.pending)
    || proxy.pending.some(name => !PROXY_FIELDS.includes(name)) || !pointsToCapture(proxy.target, record.port))) {
    throw new Error('上次采集代理恢复记录格式异常');
  }
  return record;
}

function capturePort(values) {
  const addresses = String(values?.ProxyServer ?? '').split(';');
  for (const address of addresses) {
    const match = /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)$/i.exec(address.split('=').at(-1).trim());
    const port = Number(match?.[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65535 && pointsToCapture(values, port)) return port;
  }
  return null;
}

export function createCaptureRecovery({ journal, ca, proxySettings, acquireLock, isRunning = () => false }) {
  function load() {
    const saved = journal.read();
    if (saved) return validate(saved);
    const backup = proxySettings.readBackup?.();
    if (!backup) return null;
    const active = proxySettings.readCurrent();
    const port = capturePort(active);
    if (!port) return null;
    return {
      version: 1, id: randomUUID(), legacy: true, startedAt: backup.savedAt, phase: 'legacy-proxy', port,
      ca: { installedBefore: true, installAttempted: false, fingerprint: null },
      proxy: { original: backup.values, target: { ProxyEnable: '0x1', ProxyServer: active.ProxyServer, ProxyOverride: '<local>' },
        ready: true, owned: true, pending: [...PROXY_FIELDS] },
    };
  }

  function inspect({ ignoreActive = false } = {}) {
    if (!ignoreActive && isRunning()) return { pending: false, recoverable: false, active: true };
    try {
      const record = load();
      if (!record) return { pending: false, recoverable: false, active: false };
      return { pending: true, recoverable: true, active: false, phase: record.phase, startedAt: record.startedAt,
        port: record.port, legacy: !!record.legacy, proxy: !!record.proxy?.owned,
        certificate: record.ca.installAttempted && !record.ca.installedBefore,
        message: record.legacy ? '检测到旧版采集代理备份，可恢复原代理设置。' : '检测到上次采集未完成清理，可恢复本次采集改动。' };
    } catch (error) {
      return { pending: true, recoverable: false, active: false, error: error.message };
    }
  }

  async function recover() {
    if (isRunning()) throw new Error('采集仍在运行，请先停止当前采集');
    const release = await acquireLock();
    try {
      const record = load();
      if (!record) return inspect();
      const save = () => journal.write(record);
      save();
      if (record.proxy) {
        const proxy = resumeCaptureProxy(proxySettings, record.proxy, {
          onChange(snapshot) { record.proxy = snapshot; save(); },
        });
        proxy.restore();
      }
      if (record.ca.installAttempted && !record.ca.installedBefore && !(record.keepCa && record.ready)) {
        const fingerprint = ca.caFingerprint();
        if (!record.ca.thumbprint && (!record.ca.fingerprint || fingerprint !== record.ca.fingerprint)) {
          throw new Error('本地 CA 已变化，无法确认上次采集证书归属，恢复记录已保留');
        }
        if (ca.isInstalled(record.ca.thumbprint)) ca.uninstallCa(record.ca.thumbprint);
        if (ca.isInstalled(record.ca.thumbprint)) throw new Error('上次采集 CA 移除后校验失败，请重试恢复');
        record.ca.installAttempted = false;
        record.ca.filesPending = record.ca.created && fingerprint === record.ca.fingerprint && record.ca.file === ca.CA_CRT;
        save();
      }
      if (record.ca.filesPending && record.ca.file === ca.CA_CRT && ca.caFingerprint() === record.ca.fingerprint) ca.removeCaFiles?.();
      journal.clear();
      return inspect();
    } finally { await release(); }
  }

  return { inspect, recover };
}
