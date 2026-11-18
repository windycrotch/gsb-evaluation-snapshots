import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from './json-store.mjs';
import { compareResourceVersions, discoverResourceVersion, WECHAT_RESOURCE_SERVER } from './resource-version.mjs';

export const RESOURCE_SERVER = WECHAT_RESOURCE_SERVER;
export const DEFAULT_RESOURCE_APP_VERSION = '1.14.5';
export const DEFAULT_RESOURCE_MAX_AGE_MINUTES = 1440;
export const resourceDirectory = (env = process.env) => path.resolve(env.CW_RESOURCE_DIR || path.join(import.meta.dirname, '../work/cdn/resources'));

// active.json 只指向已完整验证的不可变目录。持有旧快照的任务可以继续读旧地图。
export function activeResources({ root = resourceDirectory(), honorOverride = true } = {}) {
  if (honorOverride && process.env.CW_CONFIG_PACK) return null;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, 'active.json'), 'utf8'));
    if (!/^[a-f0-9]{16}-[a-f0-9-]{36}$/.test(data.generation) || !Array.isArray(data.scenarios) || !data.scenarios.length
      || data.scenarios.some(id => !Number.isSafeInteger(id) || id < 1 || id > 100)) return null;
    const directory = path.join(root, data.generation);
    const configFile = path.join(directory, 'config.json');
    const mapFiles = Object.fromEntries(data.scenarios.map(id => [id, path.join(directory, 'world_map' + id + '.json')]));
    if (![configFile, ...Object.values(mapFiles)].every(file => fs.statSync(file).isFile())) return null;
    return Object.freeze({ ...data, directory, configFile, mapFiles: Object.freeze(mapFiles) });
  } catch { return null; }
}

export function selectResourceTarget(discovered, saved) {
  if (discovered && !/^\d+\.\d+\.\d+$/.test(discovered.appVersion ?? '')) throw new Error('发现的客户端资源版本无效');
  const known = !saved?.invalid && /^\d+\.\d+\.\d+$/.test(saved?.appVersion ?? '') ? saved.appVersion : null;
  const compared = known && discovered ? compareResourceVersions(discovered.appVersion, known) : null;
  if (discovered && (!known || compared !== null && compared >= 0)) return discovered;
  return known ? { appVersion: known, source: 'last-known', packageVersion: saved.sourcePackageVersion ?? null } : null;
}

export function resourceUpdatePolicy(env = process.env, { root = resourceDirectory(env) } = {}) {
  const intervalMinutes = Number(env.CW_RESOURCE_UPDATE_MINUTES ?? 30);
  const maxAgeMinutes = Number(env.CW_RESOURCE_MAX_AGE_MINUTES ?? DEFAULT_RESOURCE_MAX_AGE_MINUTES);
  const enabled = env.CW_RESOURCE_AUTO_UPDATE !== '0' && !env.CW_CONFIG_PACK;
  let discovered = null, discoveryError = '';
  if (!env.CW_RESOURCE_APP_VERSION && enabled) {
    try { discovered = discoverResourceVersion({ env }); }
    catch (error) { discoveryError = error.message; } // The updater can repair a corrupt local cache from the official CDN.
  }
  const saved = readResourceCheck(root);
  const target = selectResourceTarget(discovered, saved);
  const appVersion = env.CW_RESOURCE_APP_VERSION || target?.appVersion || DEFAULT_RESOURCE_APP_VERSION;
  const versionSource = env.CW_RESOURCE_APP_VERSION ? 'explicit' : target?.source || 'fallback';
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440)
    throw new Error('CW_RESOURCE_UPDATE_MINUTES 必须为 1–1440 的整数（分钟）');
  if (!/^\d+\.\d+\.\d+$/.test(appVersion)) throw new Error('CW_RESOURCE_APP_VERSION 必须为客户端版本号，例如 1.14.5');
  if (!Number.isInteger(maxAgeMinutes) || maxAgeMinutes < 1 || maxAgeMinutes > 10080)
    throw new Error('CW_RESOURCE_MAX_AGE_MINUTES 必须为 1–10080 的整数（分钟）');
  return { intervalMinutes, maxAgeMinutes, appVersion, versionSource, discoveryError,
    sourcePackageVersion: target?.packageVersion ?? null, enabled,
    disabledReason: env.CW_CONFIG_PACK ? '已显式指定 CW_CONFIG_PACK' : env.CW_RESOURCE_AUTO_UPDATE === '0' ? '已关闭自动更新' : '' };
}

// 与 active.json 分开保存：下载失败、重启或下一次清单读取失败，都不能遗忘
// 已经发现的新配置版本。只读界面仍可展示最后一个完整快照。
export function readResourceCheck(root = resourceDirectory()) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, 'check.json'), 'utf8'));
    return data?.version === 1 && typeof data.appVersion === 'string' ? data : { invalid: true };
  } catch (error) {
    return error.code === 'ENOENT' ? null : { invalid: true };
  }
}

export function writeResourceCheck(root, data) {
  atomicJson(path.join(root, 'check.json'), { ...data, version: 1 });
}

export function resourceReadiness({ root = resourceDirectory(), policy, now = Date.now(), resources } = {}) {
  policy ??= resourceUpdatePolicy(process.env, { root });
  const current = activeResources({ root, honorOverride: false });
  const checked = readResourceCheck(root);
  const result = { ready: true, blocked: false, reason: '', requiredVersion: checked?.required?.version ?? null,
    lastVerifiedAt: checked?.verifiedAt ?? null, maxAgeMinutes: policy.maxAgeMinutes ?? DEFAULT_RESOURCE_MAX_AGE_MINUTES };
  if (!policy.enabled) return result;
  const blocked = reason => ({ ...result, ready: false, blocked: true, reason });
  if (resources && current?.generation !== resources.generation)
    return blocked('游戏资源已切换，原任务需要使用新配置重新规划');
  if (current && current.appVersion !== policy.appVersion)
    return blocked('游戏客户端版本已变化，等待匹配的配置和地图更新');
  // 未启用更新器的本地读取仍兼容；一旦接管，必须有成功验证的资源。
  if (!checked) return result;
  if (checked.invalid) return blocked('资源版本检查记录损坏，请重新检查资源更新');
  if (checked.appVersion !== policy.appVersion) return blocked('客户端资源尚未验证，请检查资源更新');
  const required = checked.required;
  if (required && (!current || current.appVersion !== required.appVersion
    || current.configVersion !== required.configVersion || current.mapVersion !== required.mapVersion))
    return blocked('已发现游戏资源 ' + required.version + '，等待配置和地图完整更新');
  if (checked.blockedReason) return blocked(checked.blockedReason);
  if (!current || !checked.verifiedAt || checked.verifiedGeneration !== current.generation)
    return blocked('游戏资源尚未成功验证，等待资源更新');
  const verifiedAt = Date.parse(checked.verifiedAt);
  if (!Number.isFinite(verifiedAt) || now - verifiedAt >= result.maxAgeMinutes * 60000 || verifiedAt > now + 60000)
    return blocked('游戏资源超过 ' + result.maxAgeMinutes + ' 分钟未验证，等待检查最新版本');
  return result;
}

export class ResourceStaleError extends Error {
  constructor(readiness) {
    super(readiness.reason + '；已暂停使用旧资源执行新操作');
    this.name = 'ResourceStaleError';
    this.code = 'RESOURCE_STALE';
  }
}

export function assertResourcesReady(options) {
  const readiness = resourceReadiness(options);
  if (!readiness.ready) throw new ResourceStaleError(readiness);
  return readiness;
}
