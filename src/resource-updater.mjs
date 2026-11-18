import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { extractTables } from './config.mjs';
import { validateGameplayConfig } from './config-contracts.mjs';
import { decodeUuid } from '../tools/sync-art.mjs';
import { activeResources, resourceDirectory, resourceUpdatePolicy, selectResourceTarget, RESOURCE_SERVER,
  readResourceCheck, writeResourceCheck, resourceReadiness } from './resource-store.mjs';
import { compareResourceVersions, resolveResourceVersion } from './resource-version.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
const token = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const rows = (tables, name) => Array.isArray(tables[name]?.data) ? tables[name].data : [];

function importUrl(bundle, index, id) {
  const uuid = typeof id === 'number' ? decodeUuid(index.uuids?.[id]) : id;
  if (!token(uuid)) throw new Error(bundle + ' 资源编号无效');
  const versions = index.versions?.import;
  if (!Array.isArray(versions)) throw new Error(bundle + ' 缺少资源版本');
  for (let i = 0; i + 1 < versions.length; i += 2) {
    const key = versions[i], resolved = typeof key === 'number' ? decodeUuid(index.uuids?.[key]) : key;
    if ((key === id || resolved === uuid) && token(versions[i + 1]))
      return RESOURCE_SERVER + 'remote/' + bundle + '/import/' + uuid.slice(0, 2) + '/' + uuid + '.' + versions[i + 1] + '.json';
  }
  throw new Error(bundle + ' 缺少资源 ' + uuid + ' 的版本');
}

function validateConfig(tables) {
  if (Object.keys(tables).length < 100) throw new Error('远程配置包不完整：少于 100 张表');
  validateGameplayConfig(tables);
  for (const key of ['ResourceCfg', 'ItemCfg', 'ModuleOpenCfg', 'WorldParamCfg', 'WorldScenarioCfg']) {
    if (!rows(tables, key).length) throw new Error('远程配置缺少 ' + key);
  }
  const scenarios = rows(tables, 'WorldScenarioCfg').map(row => row.id);
  if (scenarios.length > 16 || new Set(scenarios).size !== scenarios.length
    || scenarios.some(id => !Number.isSafeInteger(id) || id < 1 || id > 100)) throw new Error('远程场景列表无效');
  for (const id of scenarios) {
    const cities = rows(tables, id + '_CityCfg'), costs = rows(tables, id + '_AttackCityConsumeCfg');
    if (!cities.length || !cities.some(city => city.guildIndex > 0)
      || cities.some(city => !Number.isSafeInteger(city.id) || city.id < 1)) throw new Error('远程配置缺少场景 ' + id + ' 的有效城市或主城');
    if (!costs.length || costs.some(row => !Number.isFinite(row.dist) || row.dist < 0 || !Number.isFinite(row.cost) || row.cost <= 0))
      throw new Error('远程配置缺少场景 ' + id + ' 的有效行军费用');
  }
  return scenarios;
}

function validateMap(raw, tables, id) {
  const data = raw?.[5]?.[0]?.[2], info = data?.mapInfo;
  if (!Number.isSafeInteger(info?.width) || info.width < 1 || !Number.isSafeInteger(info.height) || info.height < 1
    || !Number.isFinite(info.tileWidth) || info.tileWidth <= 0 || !Number.isFinite(info.tileHeight) || info.tileHeight <= 0
    || !Array.isArray(data.mapData) || data.mapData.length !== info.width * info.height)
    throw new Error('场景 ' + id + ' 地图数据不完整');
  for (const city of rows(tables, id + '_CityCfg')) {
    const grid = data.cityInfo?.[city.id]?.gridIdx;
    if (!Number.isSafeInteger(grid) || grid < 0 || grid >= data.mapData.length)
      throw new Error('场景 ' + id + ' 地图与城市配置不匹配：' + city.id);
  }
}

export function createResourceUpdater({ root = resourceDirectory(), policy, fetchImpl = fetch,
  resolveVersion = resolveResourceVersion,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, onEvent = () => {} } = {}) {
  const automaticPolicy = !policy;
  policy ??= resourceUpdatePolicy(process.env, { root });
  let inFlight = null, timer = null, started = false, stopped = false;
  const controller = new AbortController();
  const state = { enabled: policy.enabled, intervalMinutes: policy.intervalMinutes, appVersion: policy.appVersion,
    versionSource: policy.versionSource ?? 'provided', sourcePackageVersion: policy.sourcePackageVersion ?? null,
    updates: ['config_cn', 'world_map'], protocolDownload: false,
    lastCheckedAt: null, nextCheckAt: null, status: 'idle', error: '', version: activeResources({ root })?.version ?? null };
  const notify = (level, message) => { try { Promise.resolve(onEvent({ level, message })).catch(() => {}); } catch {} };
  const ensureActive = () => { if (stopped || controller.signal.aborted) throw new Error('资源更新已停止'); };
  async function getJson(url, maxBytes = 2 * 1024 * 1024) {
    ensureActive();
    const response = await fetchImpl(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
      redirect: 'error', cache: 'no-store' });
    if (!response.ok) throw new Error('资源下载 HTTP ' + response.status);
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('远程资源超过大小限制');
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > maxBytes) throw new Error('远程资源超过大小限制');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    ensureActive();
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async function update() {
    if (automaticPolicy) {
      policy = resourceUpdatePolicy(process.env, { root });
      if (!process.env.CW_RESOURCE_APP_VERSION) {
        try {
          const discovered = await resolveVersion({ fetchJson: getJson });
          if (discovered) {
            const target = selectResourceTarget(discovered, policy);
            policy = { ...policy, appVersion: target.appVersion, versionSource: target.source,
              sourcePackageVersion: target.packageVersion };
          }
        } catch (error) {
          writeResourceCheck(root, { ...readResourceCheck(root), appVersion: policy.appVersion,
            blockedReason: '无法确认最新客户端的资源版本：' + error.message });
          throw error;
        }
      }
      Object.assign(state, { appVersion: policy.appVersion, versionSource: policy.versionSource,
        sourcePackageVersion: policy.sourcePackageVersion });
    }
    const source = { versionSource: policy.versionSource ?? 'provided', sourcePackageVersion: policy.sourcePackageVersion ?? null };
    const previousCheck = readResourceCheck(root);
    if (!previousCheck || previousCheck.appVersion !== policy.appVersion) {
      // Remember a newly discovered client branch even if its manifest is offline.
      writeResourceCheck(root, { ...source, appVersion: policy.appVersion, verifiedAt: null, required: null,
        blockedReason: '客户端资源版本已变化，等待匹配的发布清单和资源完成验证' });
    }
    const manifestUrl = RESOURCE_SERVER + policy.appVersion + '/version.manifest';
    const manifest = await getJson(manifestUrl);
    const configVersion = manifest.bundleVers?.config_cn, mapVersion = manifest.bundleVers?.world_map;
    if (!token(configVersion) || !token(mapVersion) || typeof manifest.version !== 'string'
      || !manifest.version.startsWith(policy.appVersion + '.')) throw new Error('远程版本清单与客户端版本不匹配或缺少配置/地图版本');
    const current = activeResources({ root, honorOverride: false });
    const pending = readResourceCheck(root)?.required;
    for (const known of [current, pending]) {
      if (known?.appVersion === policy.appVersion && compareResourceVersions(manifest.version, known.version) < 0)
        throw new Error('远程清单版本 ' + manifest.version + ' 低于已知版本 ' + known.version + '，已拒绝自动降级，稍后重试');
    }
    const required = { appVersion: policy.appVersion, version: manifest.version, configVersion, mapVersion };
    // Persist the discovered target before the first bundle request. A failed
    // download (or process restart) must not make the old snapshot look current.
    const record = { ...readResourceCheck(root), ...source, appVersion: policy.appVersion, required };
    delete record.invalid;
    writeResourceCheck(root, record);
    const verified = generation => writeResourceCheck(root, { ...source, appVersion: policy.appVersion, required,
      verifiedAt: new Date(now()).toISOString(), verifiedGeneration: generation, blockedReason: '' });
    const intact = () => {
      const files = ['config.json', ...current.scenarios.map(id => 'world_map' + id + '.json')];
      try { return current.checksums && Object.keys(current.checksums).length === files.length
        && files.every(file => digest(fs.readFileSync(path.join(current.directory, file))) === current.checksums[file]); }
      catch { return false; }
    };
    if (current?.appVersion === policy.appVersion && current.configVersion === configVersion && current.mapVersion === mapVersion && intact()) {
      if (current.version !== manifest.version || JSON.stringify(current.bundleVersions) !== JSON.stringify(manifest.bundleVers)) {
        const { directory, configFile, mapFiles, ...metadata } = current;
        const pointer = path.join(root, 'active.' + randomUUID() + '.tmp');
        try {
          fs.writeFileSync(pointer, JSON.stringify({ ...metadata, version: manifest.version, bundleVersions: manifest.bundleVers }));
          ensureActive(); fs.renameSync(pointer, path.join(root, 'active.json'));
        } finally { fs.rmSync(pointer, { force: true }); }
      }
      state.version = manifest.version;
      verified(current.generation);
      return { status: 'current', version: manifest.version };
    }
    writeResourceCheck(root, { ...record, blockedReason: '游戏配置和地图尚未通过完整性验证，等待资源更新' });
    const configIndex = await getJson(RESOURCE_SERVER + 'remote/config_cn/config.' + configVersion + '.json');
    const packIds = Object.keys(configIndex.packs ?? {});
    if (!packIds.length || packIds.length > 16) throw new Error('配置资源索引缺少有效数据包');
    const packs = [];
    for (const id of packIds) packs.push(await getJson(importUrl('config_cn', configIndex, id), 64 * 1024 * 1024));
    const raw = packs.length === 1 ? packs[0] : packs, tables = extractTables(raw), scenarios = validateConfig(tables);
    const mapIndex = await getJson(RESOURCE_SERVER + 'remote/world_map/config.' + mapVersion + '.json');
    const files = { 'config.json': JSON.stringify(raw) };
    for (const id of scenarios) {
      const entry = Object.entries(mapIndex.paths ?? {}).find(([, row]) => row[0] === 'world_map' + id && mapIndex.types?.[row[1]] === 'cc.JsonAsset');
      if (!entry) throw new Error('远程地图索引缺少场景 ' + id);
      const map = await getJson(importUrl('world_map', mapIndex, Number(entry[0])), 64 * 1024 * 1024);
      validateMap(map, tables, id);
      files['world_map' + id + '.json'] = JSON.stringify(map);
    }
    ensureActive();
    const generation = digest(JSON.stringify([policy.appVersion, configVersion, mapVersion])).slice(0, 16) + '-' + randomUUID();
    const stage = path.join(root, generation + '.tmp'), directory = path.join(root, generation);
    const pointer = path.join(root, 'active.' + randomUUID() + '.tmp');
    fs.mkdirSync(stage, { recursive: true });
    try {
      for (const [file, contents] of Object.entries(files)) fs.writeFileSync(path.join(stage, file), contents);
      const metadata = { generation, appVersion: policy.appVersion, version: manifest.version, configVersion, mapVersion, scenarios,
        bundleVersions: manifest.bundleVers, activatedAt: new Date(now()).toISOString(),
        checksums: Object.fromEntries(Object.entries(files).map(([file, contents]) => [file, digest(contents)])) };
      fs.writeFileSync(pointer, JSON.stringify(metadata));
      ensureActive();
      fs.renameSync(stage, directory);
      fs.renameSync(pointer, path.join(root, 'active.json'));
      state.version = manifest.version;
      verified(generation);
      notify('info', '资源更新完成：' + manifest.version + '，' + Object.keys(tables).length + ' 张配置表、' + scenarios.length + ' 张地图；后续任务使用新版本');
      return { status: 'updated', version: manifest.version, tables: Object.keys(tables).length, maps: scenarios.length };
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
      fs.rmSync(pointer, { force: true });
    }
  }
  function check() {
    if (inFlight) return inFlight;
    if (stopped || !policy.enabled) return Promise.resolve({ status: 'disabled', reason: policy.disabledReason || '资源更新已停止' });
    state.status = 'checking'; state.error = '';
    inFlight = update().then(result => { state.status = result.status; return result; }).catch(error => {
      state.status = stopped ? 'stopped' : 'error'; state.error = error.message;
      if (!stopped) {
        const readiness = resourceReadiness({ root, policy, now: now() });
        notify('warn', '资源更新失败：' + error.message + '；' + (readiness.ready
          ? '暂用最近验证的资源，超过有效期将暂停新操作' : readiness.reason + '，已暂停新操作'));
      }
      return { status: state.status, error: error.message };
    }).finally(() => { state.lastCheckedAt = new Date(now()).toISOString(); inFlight = null; });
    return inFlight;
  }
  function schedule() {
    if (stopped || !policy.enabled) return;
    const ms = policy.intervalMinutes * 60000;
    state.nextCheckAt = new Date(now() + ms).toISOString();
    timer = setTimer(async () => { timer = null; state.nextCheckAt = null; await check(); schedule(); }, ms);
    timer?.unref?.();
  }
  return {
    check,
    view: () => ({ ...state, ...resourceReadiness({ root, policy, now: now() }), updating: !!inFlight, disabledReason: policy.disabledReason || '' }),
    async start() {
      if (started || stopped) return; started = true;
      if (!policy.enabled) { state.status = 'disabled'; notify('info', '资源自动更新未启动：' + policy.disabledReason); return; }
      notify('info', '配置表和地图自动更新：启动时检查，之后每 ' + policy.intervalMinutes + ' 分钟检查；'
        + (automaticPolicy && !process.env.CW_RESOURCE_APP_VERSION ? '自动识别本机微信客户端版本' : '指定客户端 ' + policy.appVersion)
        + '。协议从本机游戏包读取，不在远程资源下载范围内');
      await check(); schedule();
    },
    async stop() {
      stopped = true; controller.abort(); if (timer !== null) clearTimer(timer);
      timer = null; state.nextCheckAt = null; await inFlight; state.status = 'stopped';
    },
  };
}
