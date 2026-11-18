import path from 'node:path';
import { createHash } from 'node:crypto';
import { dataDirectory } from './usage-ledger.mjs';
import { atomicJson, readJson, withFileLock } from './json-store.mjs';
import { exactAutomationId } from './automation-policy.mjs';

export function activityTimestamp(value) {
  const number = Number(exactAutomationId(value));
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function activityLifecycle(row, now) {
  const start = activityTimestamp(row.startTime), end = activityTimestamp(row.endTime);
  if (start && end && end <= start) return 'unknown';
  if (end && now >= end) return 'ended';
  if (!start || !end || end <= start) return 'unknown';
  return now < start ? 'upcoming' : 'active';
}

export function catalogEntry(row, now) {
  const startTime = activityTimestamp(row.startTime), endTime = activityTimestamp(row.endTime);
  const instanceId = createHash('sha256').update(JSON.stringify([row.id, startTime, startTime ? null : endTime])).digest('hex').slice(0, 24);
  return { ...row, startTime, endTime, instanceId, lifecycle: activityLifecycle({ startTime, endTime }, now), observed: true };
}

const standalonePackSources = new Set(['limitTimePack', 'backLTPack', 'chainPack', 'tierActivity']);
const periodicSources = new Set(['merchant', 'hero-raid']);
function isCatalogActivity(row) {
  const id = row.sourceId ?? row.id;
  return !standalonePackSources.has(id.split(':')[0])
    && (id !== 'merchant' || activityTimestamp(row.startTime) || activityTimestamp(row.endTime));
}

const catalogPath = account => path.join(dataDirectory(), 'activity-catalog', createHash('sha256').update(account).digest('hex') + '.json');
const storedFields = ['id', 'instanceId', 'kind', 'name', 'group', 'weekType', 'taskKey', 'taskKeys', 'startTime', 'endTime', 'rewardEndTime'];
function savedEntries(account) {
  const saved = readJson(catalogPath(account), { version: 1, activities: [] });
  if (saved?.version !== 1 || !Array.isArray(saved.activities)) throw Error('活动目录记录格式无效');
  return saved.activities.filter(row => typeof row?.id === 'string' && typeof row.instanceId === 'string' && typeof row.name === 'string'
    && isCatalogActivity(row)).map(row => periodicSources.has(row.id.split(':')[0]) ? { ...row, kind: 'weekly' } : row);
}

function historicalEntry(row, now) {
  const lifecycle = activityLifecycle(row, now);
  return { ...row, sourceId: row.id, id: 'archive:' + row.instanceId, observed: false,
    lifecycle: lifecycle === 'active' ? 'unknown' : lifecycle };
}

export function readActivityCatalog(account, now) {
  return savedEntries(account).map(row => historicalEntry(row, now));
}

export function rememberActivityCatalog(account, activities, now) {
  activities = activities.filter(isCatalogActivity);
  const file = catalogPath(account);
  return withFileLock(file, () => {
    const saved = savedEntries(account);
    const merged = new Map(saved.map(row => [row.instanceId, row]));
    for (const row of activities) {
      merged.set(row.instanceId, Object.fromEntries(storedFields.filter(key => row[key] !== undefined).map(key => [key, row[key]])));
    }
    const next = [...merged.values()];
    if (JSON.stringify(saved) !== JSON.stringify(next)) atomicJson(file, { version: 1, activities: next });
    const observed = new Set(activities.map(row => row.instanceId));
    return [...activities, ...next.filter(row => !observed.has(row.instanceId)).map(row => historicalEntry(row, now))];
  });
}

// This display cache contains only server-published activity windows. It never
// supplies the live festival/weekly data used to authorize game operations.
export const activityCatalogPushNames = new Set(['SCAllActivity', 'SCHeroRaidOpen', 'SCGuildShipActivity', 'SCNewbieActivityUpdate',
  'WeekInfoResponse', 'SCMagicOceanActivity']);

export function rememberActivityPush(client, name, body) {
  if (name === 'SCAllActivity') {
    client.activityCatalogWindows = {
      guildShip: client.activityCatalogWindows?.guildShip,
      raid: body.raid ?? [],
      skinActive: body.skinActive, goldFish: body.goldFish, spring: body.spring, equinox: body.equinox,
      magicOcean: body.magicOcean, cleanSea: body.cleanSea,
    };
  }
  if (name === 'SCHeroRaidOpen' && body.raid) {
    const cache = client.activityCatalogWindows ??= {};
    cache.raid = [...(cache.raid ?? []).filter(row => row.raidId !== body.raid.raidId), body.raid];
  }
  if (name === 'SCGuildShipActivity') (client.activityCatalogWindows ??= {}).guildShip = body.period;
  if (name === 'SCMagicOceanActivity') (client.activityCatalogWindows ??= {}).magicOcean = body.activity;
}

export function pushedActivityEntries(client, now) {
  const cache = client.activityCatalogWindows ?? {}, result = [];
  const add = (id, name, row, start = 'startTime', end = 'endTime') => {
    if (!row || typeof row !== 'object') return;
    result.push(catalogEntry({ id, name, kind: periodicSources.has(id.split(':')[0]) ? 'weekly' : 'limited', taskKeys: [], startTime: row[start], endTime: row[end],
      ...(activityTimestamp(row.rwdEndTime) ? { rewardEndTime: activityTimestamp(row.rwdEndTime) } : {}) }, now));
  };
  if (activityTimestamp(client.tradeWindow?.period)
    && (activityTimestamp(client.tradeWindow.startTime) || activityTimestamp(client.tradeWindow.endTime))) {
    add('merchant', '海商王', client.tradeWindow);
  }
  add('beauty', '海上风采大赛', client.beautyWindow && { ...client.beautyWindow, rwdEndTime: client.beautyWindow.showEndTime });
  for (const row of cache.raid ?? []) add('hero-raid:' + row.raidId, '超凡英雄活动 ' + row.raidId, row, 'startTime', 'finishTime');
  for (const [key, label] of [['skinActive', '皮肤活动'], ['goldFish', '海捞大奖'], ['spring', '春节活动'], ['equinox', '春分活动'],
    ['cleanSea', '净海行动'], ['guildShip', '联盟商船']]) add(key, label, cache[key]);
  add('magicOcean', '神奇海洋', cache.magicOcean, 'openTime', 'closeTime');
  return result;
}
