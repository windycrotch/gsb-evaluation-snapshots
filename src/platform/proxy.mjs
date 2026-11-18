import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { atomicJson } from '../json-store.mjs';

export const KEY = process.env.CW_REG_KEY
  ?? 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
export const BACKUP = process.env.CW_PROXY_BACKUP
  ?? path.resolve(import.meta.dirname, '../../certificates/proxy-backup.json');
const VALUES = ['ProxyEnable', 'ProxyServer', 'ProxyOverride'];

export function pointsToCapture(values, port) {
  if (Number(values.ProxyEnable) !== 1) return false;
  return String(values.ProxyServer ?? '').split(';').some((part) => {
    const address = part.split('=').at(-1).trim().replace(/^https?:\/\//i, '').toLowerCase();
    return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(address);
  });
}

function equals(name, left, right) {
  if (name === 'ProxyEnable' && left !== undefined && right !== undefined) return Number(left) === Number(right);
  return left === right;
}

export function prepareCaptureProxy(settings, port, options) {
  const original = settings.readCurrent();
  if (pointsToCapture(original, port)) throw new Error('系统代理已指向本机采集端口，请先恢复上次的代理设置，避免覆盖原始备份');
  const target = { ProxyEnable: '0x1', ProxyServer: `127.0.0.1:${port}`, ProxyOverride: '<local>' };
  return resumeCaptureProxy(settings, { original, target, ready: false, owned: false, pending: [] }, options);
}

export function resumeCaptureProxy(settings, saved, { onChange = () => {} } = {}) {
  const { original, target } = saved;
  let ready = saved.ready, owned = saved.owned;
  let pending = [...saved.pending];
  const snapshot = () => ({ original: { ...original }, target: { ...target }, ready, owned, pending: [...pending] });
  return {
    original,
    snapshot,
    enable() {
      owned = true;
      pending = VALUES.filter((name) => !equals(name, original[name], target[name]));
      onChange(snapshot());
      settings.backup(original);
      const port = Number(target.ProxyServer.split(':').at(-1));
      settings.setProxy('127.0.0.1', port, { backedUp: true });
      const active = settings.readCurrent();
      if (!VALUES.every((name) => equals(name, active[name], target[name]))) throw new Error('代理设置写入后校验失败');
      ready = true;
      onChange(snapshot());
    },
    restore() {
      if (!pending.length) {
        if (owned) { settings.removeBackup?.(); owned = false; onChange(snapshot()); }
        return;
      }
      // Restore the enable flag first. If that write fails, leave the server
      // untouched so a retry can still establish which session owns the route.
      for (const name of [...pending]) {
        const active = settings.readCurrent();
        const switchedServer = active.ProxyServer !== target.ProxyServer && active.ProxyServer !== original.ProxyServer;
        if (equals(name, active[name], target[name]) && !(switchedServer && name === 'ProxyEnable')) {
          settings.restore(original, [name]);
          if (!equals(name, settings.readCurrent()[name], original[name])) throw new Error('代理还原校验失败');
        }
        pending = pending.filter((field) => field !== name);
        onChange(snapshot());
      }
      if (owned) { settings.removeBackup?.(); owned = false; onChange(snapshot()); }
    },
  };
}

function reg(args) {
  try {
    return execFileSync('reg', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (error) {
    return error.stdout?.toString() ?? '';
  }
}

export function readCurrent() {
  const out = execFileSync('reg', ['query', KEY], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const values = {};
  for (const line of out.split(/\r?\n/)) {
    const match = line.match(/^\s*(ProxyEnable|ProxyServer|ProxyOverride)\s+REG_\w+\s+(.*)$/);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

export function backup(values = readCurrent()) {
  atomicJson(BACKUP, { key: KEY, values, savedAt: new Date().toISOString() });
  return values;
}

export function readBackup() {
  if (!fs.existsSync(BACKUP)) return null;
  const saved = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
  if (saved.key !== KEY || !saved.values || typeof saved.values !== 'object' || Array.isArray(saved.values)) {
    throw new Error('代理备份格式或注册表位置不匹配');
  }
  return saved;
}

export function removeBackup() {
  fs.rmSync(BACKUP, { force: true });
}

export function setProxy(host, port, { backedUp = false } = {}) {
  if (!backedUp) backup();
  reg(['add', KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
  reg(['add', KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', `${host}:${port}`, '/f']);
  reg(['add', KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', '<local>', '/f']);
  return readCurrent();
}

export function restore(values, names = VALUES) {
  if (values === undefined) {
    const saved = readBackup();
    if (!saved) throw new Error(`no backup at ${BACKUP}`);
    values = saved.values;
  }
  for (const name of names) {
    const original = values[name];
    if (original === undefined) {
      reg(['delete', KEY, '/v', name, '/f']);
    } else {
      const type = name === 'ProxyEnable' ? 'REG_DWORD' : 'REG_SZ';
      reg(['add', KEY, '/v', name, '/t', type, '/d', original, '/f']);
    }
  }
  const restored = readCurrent();
  if (!names.every(name => equals(name, restored[name], values[name]))) throw new Error('代理还原校验失败，已保留原始备份');
  return restored;
}

export function isProxyOn() {
  return readCurrent().ProxyEnable === '0x1';
}

export function proxyCommand(args = process.argv.slice(2)) {
  const [cmd, host = '127.0.0.1', port = '17321'] = args;
  if (cmd === 'show') {
    console.log(readCurrent());
  } else if (cmd === 'backup') {
    console.log('backed up:', backup());
  } else if (cmd === 'set') {
    console.log('now:', setProxy(host, Number(port)));
  } else if (cmd === 'restore') {
    console.log('restored:', restore());
    removeBackup();
  } else {
    console.log('usage: proxy-settings.mjs show | backup | set [host] [port] | restore');
  }
}
