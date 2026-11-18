import { toNumber } from './client.mjs';
import { equipmentUpgrade, uidText, wireUid } from './hero-equipment.mjs';
import { farmInventory } from './farm-planting.mjs';
import { normalize } from './worlds.mjs';

const gearTypes = {
  equipment: { module: '英雄装备', name: '装备', inventory: 'Equips', list: 'equip', slots: 'equips', itemId: 'equipId' },
  badge: { module: '英雄徽章', name: '徽章', inventory: 'Badges', list: 'badge', slots: 'badges', itemId: 'badgeId' },
};
const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;

async function readInventory(client, kind) {
  const type = gearTypes[kind];
  const reply = await client.request(type.inventory + 'Request', {}, type.inventory + 'Response');
  const items = reply?.[type.list];
  if (!Array.isArray(items)) throw new Error('无法读取' + type.name + '仓库');
  const inventory = new Map();
  for (const item of items) {
    const uid = uidText(item?.uid);
    if (!uid || inventory.has(uid)) throw new Error('无法确认' + type.name + '编号');
    inventory.set(uid, item);
  }
  return inventory;
}

export async function readHeroGearContext(client, config, playerLevel, pref) {
  const gear = {};
  for (const [kind, type] of Object.entries(gearTypes)) {
    if (!pref?.[kind]) continue;
    const required = rows(config, 'ModuleOpenCfg').find(row => row.moduleId === type.module)?.playerLevel;
    if (!Number.isSafeInteger(required) || required < 1 || !Number.isSafeInteger(playerLevel) || playerLevel < required) continue;
    gear[kind] = await readInventory(client, kind);
  }
  if (gear.badge?.size) {
    const resources = (await client.request('AllResourceRequest', {}, 'AllResourceResponse'))?.list;
    if (!Array.isArray(resources)) throw new Error('无法核对徽章强化的金币余额');
    const gold = resources.filter(row => row.res === 3);
    gear.gold = gold.length ? toNumber(gold[0].amount) : 0;
    if (gold.length > 1 || !nonnegative(gear.gold)) throw new Error('无法确认金币余额');
  }
  return gear;
}

function upgradeDetails(config, kind, item, from, to) {
  const uid = wireUid(uidText(item.uid));
  if (kind === 'equipment') {
    const { nextCost } = equipmentUpgrade(config, item);
    if (nextCost === null) return null;
    return { costs: [{ id: '精铁', num: nextCost }], request: 'EnhanceEquipRequest', body: { uid } };
  }
  // Badge experience is progress within the current level. One experience item gives one point.
  const max = rows(config, 'HeroBadgeAttrCfg').find(row => row.id === item.badgeId && row.star === (item.star ?? 0))?.maxLevel;
  const level = rows(config, 'HeroBadgeLevelCfg').find(row => row.level === to);
  const priorExp = item.exp ?? 0;
  if (!from || !Number.isSafeInteger(max) || to > max || !nonnegative(priorExp) ||
    !Number.isSafeInteger(level?.exp) || !nonnegative(level.goldExpRadio)) return null;
  const exp = level.exp - priorExp, gold = exp * level.goldExpRadio;
  if (exp <= 0 || exp > 2147483647 || !nonnegative(gold)) return null;
  return {
    costs: [{ id: '徽章经验', num: exp }, { id: 'GOLD', num: gold }],
    request: 'EnhanceBadgeRequest', body: { uid, decomposeUid: [], expItemNum: exp },
  };
}

// planHeroes allocates the shared stock across these candidate upgrades and all other growth actions.
export function planHeroGearSteps({ config, gear, heroes, settings, itemNum }, hero) {
  const result = [];
  if (!gear || !hero?.heroId) return result;
  for (const [kind, type] of Object.entries(gearTypes)) {
    if (!settings?.heroes?.[kind] || !gear[kind]) continue;
    const slots = hero[type.slots] ?? [];
    if (!Array.isArray(slots) || !slots.length) continue;
    const owners = new Map();
    for (const owner of heroes) {
      for (const slot of owner[type.slots] ?? []) {
        const key = uidText(slot?.uid);
        if (key) owners.set(key, owners.has(key) ? null : owner.heroId);
      }
    }
    for (const slot of slots) {
      const uid = uidText(slot?.uid), item = gear[kind].get(uid);
      if (!item || owners.get(uid) !== hero.heroId) continue;
      const itemId = item[type.itemId], from = item.level ?? 0, to = from + 1;
      if (!nonnegative(from) || !itemId || (slot[type.itemId] && slot[type.itemId] !== itemId)) continue;
      const details = upgradeDetails(config, kind, item, from, to);
      if (!details || !details.costs.every(cost => {
        const stock = cost.id === 'GOLD' ? gear.gold : itemNum(cost.id);
        return nonnegative(stock) && stock >= cost.num;
      })) continue;
      result.push({ kind, heroId: hero.heroId, uid, itemId, from, to, ...details,
        label: `${hero.showName || hero.heroId} · ${type.name}强化至 ${to} 级` });
    }
  }
  return result;
}

// An item can change hands after the spend. Its exact UID identifies the operation across reconnects.
export async function verifyHeroGearStep(client, step) {
  const item = (await readInventory(client, step.kind)).get(step.uid);
  return !!item && item[gearTypes[step.kind].itemId] === step.itemId && nonnegative(item.level) && item.level >= step.to;
}

export async function executeHeroGearStep(client, step, { config, playerLevel, enabled = () => true }) {
  const pref = { [step.kind]: true };
  let fresh;
  try {
    if (!enabled()) throw new Error('英雄养成已暂停');
    const gear = await readHeroGearContext(client, config, playerLevel, pref);
    const bag = farmInventory(normalize(await client.request('AllItemRequest', {}, 'AllItemResponse')));
    const heroes = (await client.request('AllHeroRequest', {}, 'AllHeroResponse'))?.heroes;
    if (!Array.isArray(heroes)) throw new Error('无法确认英雄穿戴归属');
    const hero = heroes.find(row => row.heroId === step.heroId);
    fresh = planHeroGearSteps({ config, gear, heroes, settings: { heroes: pref }, itemNum: id => bag.get(id) ?? 0 }, hero)
      .find(row => row.kind === step.kind && row.uid === step.uid);
    if (!fresh || fresh.itemId !== step.itemId || fresh.from !== step.from || fresh.to !== step.to ||
      !fresh.costs.every((cost, i) => step.costs[i]?.id === cost.id && step.costs[i]?.num === cost.num)) {
      throw new Error('穿戴归属、强化等级或可用材料已变化，请重新计算');
    }
    if (!enabled()) throw new Error('英雄养成已暂停');
  } catch (error) {
    throw Object.assign(new Error(error.message, { cause: error }), { notSent: true });
  }
  let sendError;
  try {
    if (fresh.kind === 'badge') await client.request(fresh.request, fresh.body, 'EnhanceBadgeResponse');
    else await client.sendWatch(fresh.request, fresh.body);
  } catch (error) {
    if (error.notSent || (error.prompt && error.request === fresh.request)) throw error;
    sendError = error;
  }
  try {
    if (await verifyHeroGearStep(client, fresh)) {
      return { response: gearTypes[fresh.kind].inventory + 'Response', body: { uid: fresh.uid, level: fresh.to } };
    }
  } catch (error) {
    throw new Error('强化已发送，回读失败：' + error.message, { cause: error });
  }
  throw new Error(sendError?.message || '服务端尚未确认强化等级');
}
