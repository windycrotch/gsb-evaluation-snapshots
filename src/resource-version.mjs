import fs from 'node:fs';
import path from 'node:path';
import { wechatUsersDirectory } from './platform/client-paths.mjs';
import { decrypt, inspectArchive } from '../tools/wxapkg.mjs';

export const WECHAT_RESOURCE_SERVER = 'https://dhyaoj-cdn.khlgamen.com/HotUpdateRes/wx/';
const APPID = 'wx2ea52a972ea18e5e';
const token = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const parsedFiles = new Map();

// Compare numeric release components, not strings or opaque bundle hashes.
export function compareResourceVersions(left, right) {
  const valid = value => typeof value === 'string' && value.length <= 80 && /^\d+(?:\.\d+)+$/.test(value);
  if (!valid(left) || !valid(right)) return null;
  const a = left.split('.').map(BigInt), b = right.split('.').map(BigInt);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] ?? 0n) !== (b[index] ?? 0n)) return (a[index] ?? 0n) < (b[index] ?? 0n) ? -1 : 1;
  }
  return 0;
}

// Version checks run on the execution path too. Reuse parsed metadata until the
// underlying package/cache file changes; never cache a missing file indefinitely.
function readParsed(file, parse) {
  const stat = fs.statSync(file);
  const signature = stat.mtimeMs + ':' + stat.ctimeMs + ':' + stat.size;
  const saved = parsedFiles.get(file);
  if (saved?.signature === signature) return saved.value;
  const value = parse(fs.readFileSync(file));
  if (parsedFiles.size >= 24) parsedFiles.delete(parsedFiles.keys().next().value);
  parsedFiles.set(file, { signature, value });
  return value;
}
const readJson = file => readParsed(file, bytes => JSON.parse(bytes.toString('utf8')));

export function readWechatResourceBootstrap(options) {
  const directories = root => {
    try { return fs.readdirSync(root, { withFileTypes: true }).filter(row => row.isDirectory()).map(row => row.name); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []; throw error; }
  };
  const users = wechatUsersDirectory(options), candidates = [];
  for (const user of directories(users)) {
    const root = path.join(users, user, 'applet', 'packages', APPID);
    for (const version of directories(root).filter(name => /^\d+$/.test(name))) {
      const directory = path.join(root, version), file = path.join(directory, '__APP__.wxapkg');
      if (fs.existsSync(file) || fs.existsSync(path.join(directory, '_src_chunks_.wxapkg')))
        candidates.push({ directory, file, version: Number(version), modified: fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0 });
    }
  }
  const candidate = candidates.sort((a, b) => b.version - a.version || b.modified - a.modified)[0];
  if (!candidate) return null;
  const { directory: packageDirectory, file } = candidate;
  // The newest package defines the branch. A damaged or partially downloaded
  // newest package must not silently select a previous client's release branch.
  const metadata = readParsed(file, bytes => {
    const { data } = decrypt(APPID, bytes);
    const entry = inspectArchive(data).files.find(item => /^src\/settings(?:\.[^/]+)?\.json$/.test(item.relativePath));
    if (!entry) throw new Error('最新微信游戏包缺少资源版本清单');
    const settings = JSON.parse(data.toString('utf8', entry.off, entry.off + entry.size));
    const resourcesVersion = settings.assets?.bundleVers?.resources;
    if (settings.assets?.server !== WECHAT_RESOURCE_SERVER || !token(resourcesVersion))
      throw new Error('最新微信游戏包的资源服务器或 resources 版本不支持');
    return { resourcesVersion };
  });
  const appletDirectory = path.resolve(packageDirectory, '../../..');
  return {
    packageVersion: Number(path.basename(packageDirectory)), resourcesVersion: metadata.resourcesVersion,
    server: WECHAT_RESOURCE_SERVER,
    indexUrl: WECHAT_RESOURCE_SERVER + 'remote/resources/config.' + metadata.resourcesVersion + '.json',
    cacheDirectory: path.join(appletDirectory, 'local', APPID, 'usr', 'gamecaches'),
  };
}

// Cocos stores UUIDs as 22 base64 characters in bundle indexes.
function decodeUuid(value) {
  if (typeof value !== 'string') throw new Error('appConfig 资源编号无效');
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) return value;
  if (!/^[0-9a-f]{2}[A-Za-z0-9+/]{20}$/.test(value)) throw new Error('appConfig 资源编号无效');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let hex = value.slice(0, 2);
  for (let i = 2; i < 22; i += 2) {
    const bits = alphabet.indexOf(value[i]) * 64 + alphabet.indexOf(value[i + 1]);
    hex += bits.toString(16).padStart(3, '0');
  }
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export function resourceAppConfigUrl(index) {
  const entries = Object.entries(index?.paths ?? {}).filter(([, row]) => Array.isArray(row)
    && row[0] === 'appConfig' && index.types?.[row[1]] === 'cc.JsonAsset');
  if (entries.length !== 1 || !/^\d+$/.test(entries[0][0])) throw new Error('resources 清单缺少唯一的 appConfig');
  const id = Number(entries[0][0]), uuid = decodeUuid(index.uuids?.[id]);
  const versions = index.versions?.import;
  if (!Array.isArray(versions) || versions.length % 2) throw new Error('appConfig 缺少有效导入版本');
  let key = uuid, hash;
  for (let i = 0; i < versions.length; i += 2) {
    if (versions[i] === id || versions[i] === uuid) { hash = versions[i + 1]; break; }
  }
  if (hash === undefined) {
    const packs = Object.entries(index.packs ?? {}).filter(([, ids]) => Array.isArray(ids) && ids.includes(id));
    if (packs.length !== 1) throw new Error('appConfig 缺少导入文件版本');
    key = packs[0][0];
    for (let i = 0; i < versions.length; i += 2) if (versions[i] === key) { hash = versions[i + 1]; break; }
  }
  if (!token(key) || !token(hash)) throw new Error('appConfig 导入路径无效');
  return WECHAT_RESOURCE_SERVER + 'remote/resources/import/' + key.slice(0, 2) + '/' + key + '.' + hash + '.json';
}

export function parseResourceAppVersion(raw) {
  const found = [];
  const walk = value => {
    if (!Array.isArray(value)) return;
    if (value[1] === 'appConfig' && value[2] && typeof value[2] === 'object') found.push(value[2]);
    for (const item of value) walk(item);
  };
  walk(raw);
  if (found.length !== 1 || !/^\d+\.\d+\.\d+$/.test(found[0].config?.version ?? '')
    || found[0].bundle?.server !== WECHAT_RESOURCE_SERVER) throw new Error('appConfig 中的客户端版本或资源服务器无效');
  return found[0].config.version;
}

function readCached(bootstrap, url) {
  const cacheFile = path.join(bootstrap.cacheDirectory, 'cacheList.json');
  if (!fs.existsSync(cacheFile)) return null;
  const uri = readJson(cacheFile).files?.[url]?.url;
  if (typeof uri !== 'string' || !uri.startsWith('wxfile://usr/gamecaches/')) return null;
  const relative = uri.slice('wxfile://usr/gamecaches/'.length);
  if (!relative || relative.split(/[\\/]/).some(part => part === '..' || part === '.') || /[:\0]/.test(relative))
    throw new Error('微信资源缓存路径无效');
  const file = path.resolve(bootstrap.cacheDirectory, relative);
  if (!fs.existsSync(file)) return null;
  const root = fs.realpathSync(bootstrap.cacheDirectory), resolved = fs.realpathSync(file);
  const within = path.relative(root, resolved);
  if (within.startsWith('..' + path.sep) || within === '..' || path.isAbsolute(within)) throw new Error('微信资源缓存路径越界');
  return readJson(file);
}

function cachedVersion(bootstrap) {
  const index = readCached(bootstrap, bootstrap.indexUrl);
  if (!index) return null;
  const raw = readCached(bootstrap, resourceAppConfigUrl(index));
  if (!raw) return null;
  return { appVersion: parseResourceAppVersion(raw), source: 'wechat-cache',
    packageVersion: bootstrap.packageVersion, resourcesVersion: bootstrap.resourcesVersion };
}

export function discoverResourceVersion(options) {
  const bootstrap = readWechatResourceBootstrap(options);
  return bootstrap ? cachedVersion(bootstrap) : null;
}

export async function resolveResourceVersion({ fetchJson, ...options } = {}) {
  const bootstrap = readWechatResourceBootstrap(options);
  if (!bootstrap) return null;
  let cached, cacheError;
  try { cached = cachedVersion(bootstrap); }
  catch (error) { cacheError = error; }
  if (cached) return cached;
  // Only cache failures may recover remotely. The verified latest package above
  // still controls both URLs; a corrupt newest package never selects an old one.
  if (typeof fetchJson !== 'function') throw cacheError ?? new Error('最新微信游戏包的版本资源尚未缓存，需要下载 resources/appConfig');
  const index = await fetchJson(bootstrap.indexUrl);
  const raw = await fetchJson(resourceAppConfigUrl(index));
  return { appVersion: parseResourceAppVersion(raw), source: 'wechat-package-cdn',
    packageVersion: bootstrap.packageVersion, resourcesVersion: bootstrap.resourcesVersion };
}
