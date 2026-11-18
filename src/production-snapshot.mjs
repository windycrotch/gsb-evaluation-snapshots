import { createHash } from 'node:crypto';
import { RESOURCE } from './config.mjs';
import { toNumber } from './client.mjs';
import { exactAutomationId, resourceReserve, worldPreferenceEnabled } from './automation-policy.mjs';
import { makeTypeResolver, upgradeRow, factoryRecipeAvailability } from './world.mjs';
import { readWeekOrder, weekSchedule } from './activities.mjs';
import { baseDemands } from './base-automation.mjs';
import { readGuildShips, guildShipApplicationDeadline } from './guild-ships.mjs';
import { watchHeroRaidPushes } from './hero-raid-automation.mjs';
import { activityProductionEnabled } from './activity-automation.mjs';

const rows = (config, table) => config?.tables?.[table]?.data ?? [];
const list = value => Array.isArray(value) ? value : [];
const amount = value => {
  if (value == null) return null;
  const number = toNumber(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};
const timestamp = value => amount(value) > 0 ? amount(value) : null;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const actor = player => [player?.playerId ?? player?.id, player?.worldId, player?.guildId]
  .map(value => exactAutomationId(value) ?? String(value ?? '')).join(':');
const parameter = (config, name) => {
  const row = ['GameParamCfg', 'BuildingProduceParamCfg'].flatMap(table => rows(config, table))
    .find(entry => entry.paramName === name);
  return amount(row?.paramValue);
};

function requirements(value) {
  if (!Array.isArray(value)) return null;
  const result = new Map();
  for (const entry of value) {
    const id = Array.isArray(entry) ? entry[0] : entry?.id ?? entry?.itemId;
    const num = amount(Array.isArray(entry) ? entry[1] : entry?.num ?? entry?.need);
    if (typeof id !== 'string' || !id || num === null) return null;
    const total = (result.get(id) ?? 0) + num;
    if (!Number.isSafeInteger(total)) return null;
    if (total > 0) result.set(id, total);
  }
  return [...result].map(([id, num]) => ({ id, num }));
}

/** Build a JSON-safe, fixed set of currently observed production demands. No I/O. */
export function buildProductionSnapshot(raw, config, settings = {}) {
  const merchantEnabled = activityProductionEnabled(settings, 'merchant');
  const reads = (raw.reads ?? []).filter(entry => merchantEnabled || !['WeekInfoRequest', 'WeekOrderInfoRequest', 'weekOrder'].includes(entry.request))
    .map(entry => ({ ...entry }));
  const issues = [];
  const incomplete = (request, reason) => issues.push({ request, status: 'missing', reason });
  const serverNow = timestamp(raw.serverNow);
  if (!serverNow) incomplete('serverNow', '服务器时间未确认');
  const inventory = requirements(Array.isArray(raw.items?.items) ? raw.items.items.map(entry => ({ id: entry?.itemId ?? entry?.id, num: entry?.num ?? entry?.count })) : null);
  if (!inventory) incomplete('AllItemRequest', '完整道具库存未返回或数量无效');
  const resourceInventory = requirements(Array.isArray(raw.resources?.list) ? raw.resources.list.map(entry => ({ id: entry?.res == null ? null : RESOURCE[entry.res] ?? String(entry.res), num: entry?.amount })) : null);
  if (!resourceInventory) incomplete('AllResourceRequest', '完整资源库存未返回或数量无效');
  const stock = requirements([...(inventory ?? []), ...(resourceInventory ?? [])]) ?? [];
  const stockMap = new Map(stock.map(entry => [entry.id, entry.num]));
  const resolveType = makeTypeResolver(config);
  const factoryTypes = new Set(rows(config, 'BuildingProduceCfg').map(recipe => recipe.buildType));
  const cropRecipes = new Map(rows(config, 'FarmlandPlantCfg').map(row => [row.id, row]));
  const capacity = parameter(config, '制造位上限');
  if (!(capacity > 0)) incomplete('BuildingProduceParamCfg', '制造位上限未确认');
  if (!Array.isArray(raw.water?.building)) incomplete('OnWaterRequest', '建筑清单未完整返回');
  const buildings = list(raw.water?.building).map(building => ({
    id: building?.buildingId, buildingId: building?.buildingId, type: typeof building?.buildingId === 'string' ? resolveType(building.buildingId) : null,
    level: amount(building?.level), upgradingUntil: timestamp(building?.buildFinishTime),
    buildStartTime: amount(building?.buildStartTime) ?? 0, buildFinishTime: amount(building?.buildFinishTime) ?? 0,
    farm: building?.farm ?? null, factory: building?.factory ?? null,
    petBreed: building?.petBreed ?? null, petServe: building?.petServe ?? null,
  }));
  const factories = [], farms = [];
  for (const building of buildings) {
    if (!building.id || !building.type || building.level === null) incomplete('OnWaterRequest', '建筑标识、类型或等级未确认');
    if (factoryTypes.has(building.type) && building.level > 0) {
      const factory = building.factory;
      if (!factory) { incomplete('OnWaterRequest', building.id + '工厂状态未返回'); continue; }
      if (!Array.isArray(factory.factoryQ) || !Array.isArray(factory.finishedProducts)) incomplete('OnWaterRequest', building.id + '生产队列或待收成品未完整返回');
      const queueIndices = new Set();
      const queue = list(factory.factoryQ).map((job, index) => {
        const finishTime = timestamp(job?.finishTime);
        const queueIndex = amount(job?.idx ?? 0);
        if (!job?.productId || queueIndex === null || queueIndices.has(queueIndex)) incomplete('OnWaterRequest', building.id + '在产项目或队列序号未确认');
        queueIndices.add(queueIndex);
        return { id: building.id + ':' + (queueIndex ?? index), index: queueIndex, productId: job?.productId, num: 1,
          finishTime, timingSource: finishTime ? 'server' : 'unknown' };
      });
      const finished = requirements(factory.finishedProducts);
      if (!finished) incomplete('OnWaterRequest', building.id + '待收成品数量无效');
      factories.push({ id: building.id, type: building.type, level: building.level, capacity, queue,
        finished: finished ?? [], stockKnown: !!finished, upgradingUntil: building.upgradingUntil,
        nativeAutoProductId: factory.autoProductId || null,
        nativeAutoActive: !!factory.autoProductId && (raw.water.autoProduceForever === true || raw.water.autoProduceEndTime > serverNow),
        enabled: settings.factory?.enabled !== false && !(settings.factory?.disabledTypes ?? []).some(id => id === building.id || id === building.type) });
    }
    if (building.type === '农田' && building.level > 0) {
      const crop = cropRecipes.get(building.farm?.productId);
      const ripeTime = timestamp(building.farm?.ripeTime);
      if (building.farm?.productId && (!crop || !ripeTime)) incomplete('OnWaterRequest', building.id + '作物或成熟时刻未确认');
      farms.push({ id: building.id, level: building.level, capacity: 1, productId: building.farm?.productId || null,
        num: building.farm?.productId ? amount(crop?.produceNum) : 0, ripeTime,
        timingSource: building.farm?.productId ? (ripeTime ? 'server' : 'unknown') : null,
        upgradingUntil: building.upgradingUntil, enabled: settings.farm?.enabled !== false });
    }
  }
  const sumEffect = (building, level, name) => (upgradeRow(config, building.type, level)?.effect ?? [])
    .filter(([id]) => id === name).reduce((total, [, num]) => total + Number(num), 0);
  const initialPopulation = parameter(config, '初始人口');
  const initialMax = parameter(config, '初始人口上限');
  const population = {
    current: initialPopulation === null ? null : initialPopulation + buildings.reduce((sum, b) => sum + sumEffect(b, b.level, '人口增加'), 0),
    future: initialPopulation === null ? null : initialPopulation + buildings.reduce((sum, b) => sum + sumEffect(b, b.level + (b.buildStartTime > 0 ? 1 : 0), '人口增加'), 0),
    max: initialMax === null ? null : initialMax + buildings.reduce((sum, b) => sum + sumEffect(b, b.level, '人口上限'), 0),
  };
  const vip = rows(config, 'VipLevelCfg').find(row => row.level === raw.player?.vip?.vipLevel);
  const baseCap = parameter(config, '产品存量初始上限');
  const stockCap = baseCap === null ? null : baseCap + Number(vip?.effects?.find(([id]) => id === '加工品存量上限')?.[1] ?? 0);
  const orders = [], orderIds = new Set();
  const addOrder = (source, key, items, deadline = null, metadata = {}, kind = 'order') => {
    const costs = requirements(items);
    if (!costs) { incomplete(source, '当前需求材料未完整返回'); return; }
    if (!costs.length) return;
    const id = source + ':' + key;
    if (orderIds.has(id)) { incomplete(source, '当前订单标识重复'); return; }
    orderIds.add(id);
    orders.push({ id, source, kind, requirements: costs,
      deadline: timestamp(deadline), metadata });
  };
  if (!Array.isArray(raw.water?.workerOrder)) incomplete('OnWaterRequest', '居民订单列表未完整返回');
  for (const order of list(raw.water?.workerOrder)) {
    if (!order) { incomplete('OnWaterRequest', '居民订单条目无效'); continue; }
    if (amount(order.refreshTime ?? 0) === null) { incomplete('OnWaterRequest', '居民订单刷新状态无效'); continue; }
    if (amount(order.refreshTime) > 0) continue;
    addOrder('resident', String(order.index ?? 0) + ':' + digest([order.workerId, order.textId, order.requirements]), order.requirements,
      null, { index: order.index ?? 0, refreshTime: timestamp(order.refreshTime), enabled: settings.resident?.enabled !== false });
  }
  if (merchantEnabled && raw.weekOrder && !raw.weekOrder.finished) {
    const items = raw.weekOrder.needed instanceof Map ? [...raw.weekOrder.needed].map(([id, num]) => ({ id, num })) : raw.weekOrder.requirements;
    addOrder('merchant', raw.weekOrder.orderKey ?? digest(raw.weekOrder.evidence ?? items), items ?? [], raw.weekOrder.evidence?.endTime,
      { evidence: raw.weekOrder.evidence ?? null });
  }
  if (raw.cargo && !Array.isArray(raw.cargo.ship)) incomplete('CargoShipsRequest', '贸易港船只清单未完整返回');
  for (const ship of list(raw.cargo?.ship)) {
    if (!ship) { incomplete('CargoShipsRequest', '贸易港船只条目无效'); continue; }
    if (![0, 1, 2].includes(ship.status ?? 0)) { incomplete('CargoShipsRequest', '贸易港船只状态未确认'); continue; }
    if ((ship.status ?? 0) !== 0) continue;
    if (!Array.isArray(ship.orderItem)) { incomplete('CargoShipsRequest', '贸易港货单未完整返回'); continue; }
    addOrder('cargo', String(ship.index ?? 0) + ':' + digest(ship.orderItem), ship.orderItem.filter(slot => !slot?.filled).map(slot => slot?.asset),
      null, { shipIndex: ship.index ?? 0, enabled: settings.cargo?.enabled !== false });
  }
  if (raw.guildOrder?.order) addOrder('guildRecruit', digest(raw.guildOrder.order), raw.guildOrder.order.requirements,
    null, { refreshAt: timestamp(raw.guildOrder.order.nextRefreshTime),
      enabled: settings.alliance?.enabled === true && settings.alliance.recruit === true });
  else if (raw.guildOrder != null) incomplete('GuildOrderRequest', '联盟订单未完整返回');
  // A confirmed cabin.player is the existing guild-ship module's receipt for
  // GuildShipOrderRequest. Its materials have already been submitted.
  const shipCandidate = raw.guildShipView?.candidates?.find(row => row.kind === 'crew' && row.type === 3);
  const shipDeadline = guildShipApplicationDeadline(raw.guildShipView?.activityEndTime);
  if (settings.guildShip?.enabled && settings.guildShip.produceMissing && shipCandidate
    && (shipDeadline === null || serverNow < shipDeadline)) {
    addOrder('guildShip', [raw.guildShipView.period, shipCandidate.shipId, shipCandidate.crewId].join(':'), shipCandidate.costs,
      Math.min(timestamp(shipCandidate.preparedEndTime) ?? Infinity, shipDeadline ?? Infinity),
      { shipId: shipCandidate.shipId, crewId: shipCandidate.crewId, candidate: true }, 'consumption');
  }
  if (activityProductionEnabled(settings, 'heroRaid')) {
    if (!raw.heroRaids?.observed || raw.heroRaids.invalid) incomplete('SCAllActivity', '超凡英雄活动推送尚未完整观察');
    for (const raid of raw.heroRaids?.raids ?? []) {
      if (!(raid.startTime <= serverNow && raid.finishTime > serverNow)) continue;
      if (!raid.order) continue;
      if (['orderId', 'gotOrderId', 'gotTimes'].some(key => amount(raid.order[key]) === null)) {
        incomplete('SCAllActivity', '超凡英雄当前订单进度未完整返回'); continue;
      }
      const available = rows(config, 'HeroRaidOrderCfg').filter(row => row.raidId === raid.raidId);
      if (available.length && Math.max(...available.map(row => row.orderId)) <= raid.order.gotOrderId) continue;
      if (raid.order.orderId <= raid.order.gotOrderId) {
        incomplete('SCAllActivity', '超凡英雄当前订单已提交，后续订单尚待同步'); continue;
      }
      const matched = available.filter(row => row.orderId === raid.order.orderId);
      if (matched.length !== 1) { incomplete('HeroRaidOrderCfg', '超凡英雄当前订单配置未唯一确认'); continue; }
      const day = Math.floor((serverNow + 28800) / 86400) - Math.floor((raid.startTime + 28800) / 86400) + 1;
      if (!(matched[0].unlockDay > 0)) { incomplete('HeroRaidOrderCfg', '超凡英雄订单开放日期未确认'); continue; }
      if (day < matched[0].unlockDay) continue;
      addOrder('heroRaid', [raid.raidId, raid.startTime, raid.order.orderId].join(':'), matched[0].orderList, raid.finishTime,
        { raidId: raid.raidId, orderId: raid.order.orderId, enabled: settings.heroRaid?.enabled === true && settings.heroRaid.orders === true });
    }
  }
  const priority = new Set(settings.factory?.demandPriority ?? []);
  if (raw.radar) {
    if (!Array.isArray(raw.radar.radarInfo?.events)) incomplete('RadarInfoRequest', '难民订单事件列表未完整返回');
    const events = [...list(raw.radar.radarInfo?.events)];
    if (raw.radar.radarInfo?.fixedEvent?.eventId > 0) events.push(raw.radar.radarInfo.fixedEvent);
    for (const event of events) {
      if (!event?.refugee) continue;
      if (![1, 2, 3, 4].includes(event.state)) { incomplete('RadarInfoRequest', '难民订单事件状态未确认'); continue; }
      if (event.state !== 1 || event.startTime > 0) continue;
      const id = exactAutomationId(event.uid) ?? (event === raw.radar.radarInfo.fixedEvent ? 'fixed:' + event.eventId + ':' + event.createTime : null);
      if (!id) { incomplete('RadarInfoRequest', '难民订单事件标识未完整返回'); continue; }
      addOrder('refugee', id, event.refugee.requirements, null, { eventId: event.eventId, uid: exactAutomationId(event.uid), enabled: false });
    }
  }
  if (settings.museum && settings.pet && settings.factory) {
    const world = { buildings, factories: buildings.filter(b => b.factory), stockCap, have: id => stockMap.get(id) ?? 0 };
    const extra = baseDemands({ now: serverNow, player: raw.player, world, museum: raw.museum, radar: raw.radar,
      guildRecruitDemand: [], guildShipDemand: [], heroRaidDemand: [] }, config, settings);
    for (const [index, demand] of extra.entries()) {
      if (!priority.has(demand.source) || ['guildRecruit', 'guildShip', 'heroRaid', 'refugee'].includes(demand.source)) continue;
      if (demand.source !== 'factory' && !settings.loop?.world) continue;
      if (demand.source === 'petAdvance' && (!settings.pet.enabled || !settings.pet.advance)) continue;
      if (demand.source === 'petFeed' && (!settings.pet.enabled || !settings.pet.feed)) continue;
      addOrder(demand.source, digest([index, demand.requirements]), demand.requirements, null, {}, demand.source === 'factory' ? 'stockTarget' : 'consumption');
    }
  }
  if (priority.has('building') && settings.loop && settings.building && settings.factory
    && worldPreferenceEnabled(settings, 'buildSupply')) {
    const buildingStateKnown = amount(raw.player?.level) !== null
      && [population.current, population.future, population.max].every(Number.isSafeInteger);
    if (!buildingStateKnown) incomplete('building', '建筑备料所需角色等级、人口或人口上限未完整确认');
    const unlocks = new Map(rows(config, 'BuildingUnlockCfg').map(row => [row.buildingId, row]));
    const levels = new Map(buildings.map(building => [building.id, building.level]));
    const typeLevels = new Map();
    for (const building of buildings) typeLevels.set(building.type, Math.max(typeLevels.get(building.type) ?? 0, building.level));
    const craftable = new Set(rows(config, 'BuildingProduceCfg').filter(recipe =>
      factoryRecipeAvailability(recipe, raw.festivals, serverNow).allowed
      && factories.some(factory => factory.type === recipe.buildType && factory.level >= recipe.unlockLevel)).map(recipe => recipe.itemId));
    const free = id => (stockMap.get(id) ?? 0) - (resourceReserve(settings, id) || 0);
    for (const building of buildingStateKnown ? buildings : []) {
      if (!building.type || building.level === null || building.buildStartTime || building.buildFinishTime
        || settings.building.disabledTypes?.some(id => id === building.id || id === building.type)
        || (building.level === 0 ? !settings.building.build : !settings.building.upgrade)) continue;
      const next = building.level === 0 ? unlocks.get(building.id) : upgradeRow(config, building.type, building.level + 1);
      if (!next || next.playerLevel > raw.player?.level || next.curPeople > population.current) continue;
      const prerequisites = building.level === 0 ? levels : typeLevels;
      if ((next.condition ?? []).some(([id, level]) => (prerequisites.get(id) ?? 0) < level)) continue;
      const gain = Math.max(0, sumEffect(building, building.level + 1, '人口增加')
        - sumEffect(building, building.level, '人口增加'));
      if (gain && population.future + gain > population.max) continue;
      const costs = requirements(next.consume);
      if (!costs) { incomplete('building', '建筑材料需求未完整确认'); continue; }
      const missing = costs.filter(item => free(item.id) < item.num);
      if (missing.some(item => !craftable.has(item.id))) continue;
      // Fully prepared construction materials remain an exclusive target too,
      // so lower-priority demands cannot borrow them while planning new work.
      const targetLevel = building.level + 1;
      addOrder('building', building.id + ':' + targetLevel, costs, null,
        { buildingId: building.id, level: targetLevel, action: building.level === 0 ? 'build' : 'upgrade', ready: missing.length === 0 }, 'consumption');
    }
  }
  const recipes = rows(config, 'BuildingProduceCfg').map(recipe => {
    const gate = factoryRecipeAvailability(recipe, raw.festivals, serverNow);
    const available = factories.some(factory => factory.type === recipe.buildType && factory.level >= recipe.unlockLevel && factory.enabled) && gate.allowed;
    return { id: recipe.itemId, productId: recipe.itemId, facilityType: recipe.buildType,
      costs: requirements(recipe.costItem), output: 1, durationSeconds: amount(recipe.produceTime), unlockLevel: recipe.unlockLevel,
      available, reason: available ? null : gate.reason || '所需工厂等级未达到或已禁用', timingSource: 'estimated' };
  });
  for (const crop of cropRecipes.values()) recipes.push({ id: crop.id, productId: crop.id, facilityType: '农田',
    costs: requirements([crop.material]), output: amount(crop.produceNum), durationSeconds: amount(crop.time), unlockLevel: 1,
    available: farms.some(farm => farm.enabled), reason: farms.some(farm => farm.enabled) ? null : '没有可用农田', timingSource: 'estimated' });
  if (recipes.some(recipe => !recipe.costs || !(recipe.output > 0) || !(recipe.durationSeconds > 0))) incomplete('productionRecipes', '部分配方成本、产量或配置耗时无效');
  if (!Array.isArray(raw.effects?.effects)) incomplete('GameEffectRequest', '生产效果未完整返回');
  const missingReads = [...reads.filter(entry => entry.required !== false && ['missing', 'failed'].includes(entry.status)), ...issues]
    .filter((entry, index, list) => list.findIndex(row => row.request === entry.request && row.reason === entry.reason) === index);
  const snapshot = { schemaVersion: 1, capturedAt: raw.capturedAt ?? null, serverNow,
    player: { id: exactAutomationId(raw.player?.playerId ?? raw.player?.id), worldId: exactAutomationId(raw.player?.worldId),
      guildId: exactAutomationId(raw.player?.guildId), level: amount(raw.player?.level) },
    config: { version: config?.resources?.version ?? null, configVersion: config?.resources?.configVersion ?? null },
    inventory: stock, inventoryKnown: !!inventory && !!resourceInventory, orders, buildings, factories, farms, recipes, population, stockCap,
    autoFarming: raw.water?.autoFarming === true,
    timing: { effects: raw.effects ?? null, heroes: raw.heroes?.heroes ?? null, monthCards: raw.monthCards ?? null,
      observedDurations: raw.observedDurations ?? [], recipeDurations: 'estimated', reason: '配置耗时尚未确认为完整服务端生产公式' },
    reads, missingReads, complete: missingReads.length === 0 };
  // Full replies remain available to internal callers without being serialized by HTTP responses.
  Object.defineProperty(snapshot, 'raw', { value: raw });
  return snapshot;
}

/** Only reads protocol state. Connection or role changes invalidate the entire snapshot. */
export async function readProductionSnapshot(client, protocol, config, player, settings = {}, options = {}) {
  if (!exactAutomationId(player?.playerId ?? player?.id) || !exactAutomationId(player?.worldId)) throw new Error('无法确认生产快照的角色或区服身份');
  const initialActor = actor(player), initialSocket = client.socket, initialEpoch = client.connectionEpoch;
  let changedDuringRead = null;
  const check = () => {
    if (changedDuringRead) throw Object.assign(new Error('读取生产快照期间游戏状态已变化（' + changedDuringRead + '），请重新读取'), { code: 'PRODUCTION_SNAPSHOT_CHANGED' });
    if (client.connected === false || client.socket !== initialSocket || client.connectionEpoch !== initialEpoch
      || actor(player) !== initialActor || options.enabled?.() === false) {
      throw Object.assign(new Error('读取生产快照期间账号或连接已变化'), { code: 'PRODUCTION_SNAPSHOT_CHANGED' });
    }
  };
  check();
  const reads = [], cache = new Map(), raw = { player, reads };
  const allowed = new Set(['OnWaterRequest', 'AllItemRequest', 'AllResourceRequest', 'GameEffectRequest', 'WeekInfoRequest',
    'WeekOrderInfoRequest', 'CargoShipsRequest', 'GuildOrderRequest', 'GuildShipRequest', 'GuildInfoRequest', 'AllHeroRequest',
    'RadarInfoRequest', 'MuseumInfoRequest', 'MonthCardRequest']);
  const optional = new Set(['MonthCardRequest', 'AllHeroRequest', 'MuseumInfoRequest', 'GuildInfoRequest', 'GuildShipRequest']);
  const request = async (name, body = {}, response = name.replace(/Request$/, 'Response')) => {
    check();
    if (!allowed.has(name)) throw new Error('生产快照不允许此请求 ' + name);
    if (cache.has(name)) return cache.get(name);
    if (!protocol?.[name] || !protocol?.[response]) {
      reads.push({ request: name, status: 'missing', required: !optional.has(name), reason: '当前协议缺少请求或响应' });
      throw new Error(name + '协议不可用');
    }
    try {
      const result = await client.request(name, body, response, options.timeout ?? 8000);
      check();
      if (result == null) throw new Error('响应为空');
      cache.set(name, result);
      reads.push({ request: name, status: 'ok', required: !optional.has(name) });
      return result;
    } catch (error) {
      check();
      reads.push({ request: name, status: 'failed', required: !optional.has(name), reason: error.message });
      throw error;
    }
  };
  const get = async (key, name) => {
    try { raw[key] = await request(name); }
    catch (error) { if (error.code === 'PRODUCTION_SNAPSHOT_CHANGED') throw error; raw[key] = null; }
  };
  const heroState = activityProductionEnabled(settings, 'heroRaid') ? watchHeroRaidPushes(client) : null;
  const transport = new Set(['PingRequest', 'Ack', 'Nack']);
  const changingPushes = new Set(['SCUpdateItem', 'SCUpdateResource', 'SCUpdateWaterBuilding', 'SCWorkerOrder', 'SCGuildOrder',
    'SCAllActivity', 'SCGameEffectUpdate', 'SCUpdateHero', 'SCVipUpdate', 'SCPlayerExpUpdate', 'SCPlayerLevelGrade',
    'SCJoinGuild', 'SCLeaveGuild', 'SCGuildChanged', 'SCRadarEventState', 'SCRadarUpdate']);
  const observeFrame = ({ dir, name } = {}) => {
    if (dir === 'out' && !allowed.has(name) && !transport.has(name)) changedDuringRead ??= name || '其他请求';
  };
  const observeMessage = ({ name } = {}) => {
    if (changingPushes.has(name) || /^SC(?:HeroRaid|GuildShip)/.test(name ?? '')) changedDuringRead ??= name;
  };
  client.on?.('frame', observeFrame);
  client.on?.('message', observeMessage);
  try {
    for (const [key, name] of [['water', 'OnWaterRequest'], ['items', 'AllItemRequest'], ['resources', 'AllResourceRequest'], ['effects', 'GameEffectRequest']]) await get(key, name);
    await get('monthCards', 'MonthCardRequest');
    await get('heroes', 'AllHeroRequest');
    const readonly = new Proxy(client, { get(target, key) {
      if (key === 'request') return request;
      if (key === 'send' || key === 'sendWatch') return () => { throw new Error('生产快照禁止发送写入'); };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const now = () => Math.floor(((options.now?.() ?? Date.now()) + (client.serverClockOffsetMs || 0)) / 1000);
    if (activityProductionEnabled(settings, 'merchant')) {
      try {
        raw.weekSchedule = await weekSchedule(readonly);
        if (!Array.isArray(cache.get('WeekInfoRequest')?.activityTime)) throw new Error('周活动列表未完整返回');
        if (raw.weekSchedule.some(row => ['type', 'startTime', 'endTime', 'period'].some(key => amount(row[key]) === null)
          || row.endTime <= row.startTime)) throw new Error('周活动期次或开放时间未完整返回');
        const current = raw.weekSchedule.filter(row => row.startTime <= now() && row.endTime > now());
        raw.weekOrder = await readWeekOrder(readonly, current, config);
      } catch (error) {
        if (error.code === 'PRODUCTION_SNAPSHOT_CHANGED') throw error;
        reads.push({ request: 'weekOrder', status: 'missing', reason: error.message });
      }
    }
    const cargoLevels = rows(config, 'CargoUnlockCfg').map(row => amount(row.playerLevel)).filter(level => level !== null);
    const cargoLevel = cargoLevels.length ? Math.min(...cargoLevels) : null;
    if (amount(cargoLevel) !== null && amount(player?.level) !== null && player.level < cargoLevel) reads.push({ request: 'CargoShipsRequest', status: 'notApplicable', reason: '贸易港尚未开放' });
    else await get('cargo', 'CargoShipsRequest');
    if (exactAutomationId(player?.guildId)) {
      await get('guildOrder', 'GuildOrderRequest');
      const radarLevel = amount(rows(config, 'ModuleOpenCfg').find(row => row.moduleId === '联盟情报')?.playerLevel);
      if (radarLevel === null || amount(player?.level) === null) reads.push({ request: 'RadarInfoRequest', status: 'missing', reason: '联盟情报开放条件未确认' });
      else if (player.level < radarLevel) reads.push({ request: 'RadarInfoRequest', status: 'notApplicable', reason: '联盟情报尚未开放' });
      else await get('radar', 'RadarInfoRequest');
      if (settings.guildShip?.enabled && settings.guildShip.produceMissing) {
        try {
          const gate = amount(rows(config, 'ModuleOpenCfg').find(row => row.moduleId === '联盟商船')?.playerLevel);
          if (gate === null || amount(player?.level) === null) throw new Error('商船开放条件未确认');
          if (player.level < gate) {
            reads.push({ request: 'GuildShipRequest', status: 'notApplicable', required: false, reason: '联盟商船尚未开放' });
          } else {
            await get('guildShips', 'GuildShipRequest');
            if (amount(raw.guildShips?.period) === null) throw new Error('商船活动期数未确认');
            if (raw.guildShips.period === 0) reads.push({ request: 'GuildShipRequest', status: 'notApplicable', required: false, reason: '联盟商船活动未开放' });
            else raw.guildShipView = await readGuildShips(readonly, protocol, config, { player, getSettings: () => settings, enabled: () => { check(); return true; }, inventory: false, activityClient: client });
          }
          if (raw.guildShipView && raw.guildShipView.state !== 'ready') reads.push({ request: 'guildShipView', required: false,
            status: /在角色 \d+ 级开放|活动未开放|活动结束/.test(raw.guildShipView.reason) ? 'notApplicable' : 'missing', reason: raw.guildShipView.reason });
        } catch (error) {
          if (error.code === 'PRODUCTION_SNAPSHOT_CHANGED') throw error;
          reads.push({ request: 'guildShipView', status: 'missing', required: false, reason: error.message });
        }
      }
    } else if (amount(player?.guildId) === 0) {
      for (const request of ['GuildOrderRequest', 'RadarInfoRequest', 'GuildShipRequest']) reads.push({ request, status: 'notApplicable', reason: '当前未加入联盟' });
    }
    else reads.push({ request: 'GuildOrderRequest', status: 'missing', reason: '当前联盟身份未完整确认' });
    const sources = new Set(settings.factory?.demandPriority ?? []);
    if (sources.has('museum') && settings.museum?.runEnabled !== false && (settings.museum?.enabled || settings.museum?.upgrade)) await get('museum', 'MuseumInfoRequest');
    if (heroState) raw.heroRaids = { observed: heroState.observed, invalid: heroState.invalid, raids: [...heroState.raids.values()].map(raid => ({ ...raid, order: raid.order && { ...raid.order } })) };
    raw.festivals = Array.isArray(client.festivals) ? client.festivals : null;
    raw.serverNow = now();
    raw.observedDurations = options.observedDurations ?? [];
    raw.capturedAt = new Date(options.now?.() ?? Date.now()).toISOString();
    check();
    return buildProductionSnapshot(raw, config, settings);
  } finally {
    client.off?.('frame', observeFrame);
    client.off?.('message', observeMessage);
  }
}
