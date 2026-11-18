import { toNumber } from './client.mjs';
import { gameplayOpenDay, seasonOf, worldOpenDays } from './extra-rewards.mjs';
import { farmInventory } from './farm-planting.mjs';
import { normalize } from './worlds.mjs';

const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const whole = value => Number.isSafeInteger(value) && value >= 0;
const clock = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);

export function readAdvancedHeroContext(client) {
  return { now: clock(client) };
}

function advanceSkill({ config, player }, hero) {
  if (!Number.isSafeInteger(hero.skillLevels?.[0]) || hero.skillLevels[0] < 5) return;
  const from = hero.skillUpgrades?.[0] ?? 0, to = from + 1;
  if (!whole(from)) return;
  const rule = rows(config, 'HeroSkillAdvanceCfg').find(row => row.heroId === hero.heroId && row.skillLv === to);
  if (!rule || !whole(rule.season) || rule.season < 1 || seasonOf(player) < rule.season) return;
  // HeroSkillUpPanel advances the first skill and charges the first advanceCosts entry.
  const cost = rows(config, 'HeroSkillAdvanceCostCfg').find(row => row.level === to)?.advanceCosts?.[0];
  return { kind: 'skillAdvance', label: `主技能进阶至 ${to + 1} 阶`, request: 'HeroSkillUpgradeRequest', from, to, slot: 0, prices: [cost] };
}

function exclusiveSteps(ctx, hero, switches) {
  const { config, player, now } = ctx;
  const level = rows(config, 'ModuleOpenCfg').find(row => row.moduleId === '英雄专武')?.playerLevel;
  const opens = gameplayOpenDay(config, player, '英雄专武');
  const openTime = toNumber(player?.worldOpenTime);
  if (!whole(level) || !whole(player?.level) || player.level < level || !seasonOf(player)
    || !whole(now) || !whole(openTime) || openTime <= 0 || openTime > now || !whole(opens) || opens < 1
    || worldOpenDays(player, now) < opens || !whole(hero.star)) return [];
  if (!rows(config, 'ExclusiveWeaponCfg').some(row => row.heroId === hero.heroId && row.skillLv === 1)) return [];
  const quality = rows(config, 'HeroCfg').find(row => row.id === hero.heroId)?.quality;
  if (!['ORANGE', 'RED'].includes(quality)) return [];
  // Entries in these cost arrays are alternatives for orange/red weapons.
  const color = quality === 'RED' ? 1 : 0;
  const weaponLevel = hero.exclusive?.level ?? 0, star = hero.exclusive?.star ?? 0;
  if (!whole(weaponLevel) || !whole(star) || (!weaponLevel && star)) return [];
  const stars = rows(config, 'ExclusiveStarCfg');
  const steps = [];
  if (switches.exclusiveLevel) {
    const cap = stars.find(row => row.star === star)?.unlockLv;
    const to = weaponLevel + 1, upgrade = rows(config, 'ExclusiveUpgradeCfg').find(row => row.level === to);
    if (whole(cap) && to <= cap && whole(upgrade?.heroStar) && hero.star >= upgrade.heroStar) {
      steps.push({ kind: 'exclusiveLevel', label: weaponLevel ? `专武升级至 ${to} 级` : '铸造 1 级专武', request: 'HeroExclusiveLevelUpRequest',
        from: weaponLevel, to, prices: [upgrade.cost?.[color]] });
    }
  }
  if (switches.exclusiveStar && weaponLevel > 0) {
    const to = star + 1, upgrade = stars.find(row => row.star === to);
    if (whole(upgrade?.heroStar) && hero.star >= upgrade.heroStar) {
      steps.push({ kind: 'exclusiveStar', label: `专武升至 ${to} 星`, request: 'HeroExclusiveStarUpRequest',
        from: star, to, prices: [[hero.heroId + '碎片', upgrade.piece], upgrade.cost?.[color]] });
    }
  }
  return steps;
}

export function planAdvancedHeroGrowth(ctx, hero) {
  const switches = ctx.settings?.heroes;
  if (!switches || !hero?.heroId) return [];
  const candidates = [];
  if (switches.skillAdvance) candidates.push(advanceSkill(ctx, hero));
  if (switches.exclusiveLevel || switches.exclusiveStar) candidates.push(...exclusiveSteps(ctx, hero, switches));
  const steps = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const { prices, ...step } = candidate;
    if (!prices.every(price => Array.isArray(price) && typeof price[0] === 'string' && price[0]
      && whole(price[1]) && price[1] > 0)) continue;
    const costs = prices.map(([id, num]) => ({ id, num }));
    if (!costs.every(({ id, num }) => {
      const have = ctx.itemNum(id);
      return whole(have) && have >= num;
    })) continue;
    const body = { heroId: hero.heroId };
    if (step.kind === 'exclusiveStar') body.universal = false;
    const name = hero.showName || rows(ctx.config, 'HeroCfg').find(row => row.id === hero.heroId)?.name || hero.heroId;
    steps.push({ ...step, heroId: hero.heroId, label: name + ' · ' + step.label, body, costs });
  }
  return steps;
}

async function readHero(client, heroId) {
  const roster = await client.request('AllHeroRequest', {}, 'AllHeroResponse');
  const matches = roster?.heroes?.filter(hero => hero.heroId === heroId);
  if (matches?.length !== 1) throw new Error('未能确认所选英雄');
  return matches[0];
}

export async function verifyAdvancedHeroStep(client, step) {
  const hero = await readHero(client, step.heroId);
  const actual = step.kind === 'skillAdvance' ? hero.skillUpgrades?.[0]
    : step.kind === 'exclusiveLevel' ? hero.exclusive?.level
    : step.kind === 'exclusiveStar' ? hero.exclusive?.star : null;
  return whole(actual) && whole(step.to) && step.to > 0 && actual >= step.to;
}

export async function runAdvancedHeroStep(client, step, { config, player, enabled = () => true }) {
  let next;
  try {
    if (!enabled()) throw new Error('本次英雄养成已关闭');
    const hero = await readHero(client, step.heroId);
    const counts = farmInventory(normalize(await client.request('AllItemRequest', {}, 'AllItemResponse')));
    [next] = planAdvancedHeroGrowth({ config, player, settings: { heroes: { [step.kind]: true } },
      now: clock(client), itemNum: id => counts.get(id) ?? 0 }, hero);
    if (!next || next.from !== step.from || next.to !== step.to
      || !Array.isArray(step.costs) || next.costs.length !== step.costs.length
      || !next.costs.every((cost, i) => cost.id === step.costs[i].id && cost.num === step.costs[i].num)) {
      throw new Error('英雄状态、开放条件或养成材料已变化，请重新计算计划');
    }
    if (!enabled()) throw new Error('本次英雄养成已关闭');
  } catch (error) {
    throw Object.assign(new Error(error.message, { cause: error }), { notSent: true });
  }
  let sendError;
  try {
    await client.sendWatch(next.request, next.body);
  } catch (error) {
    if (error.notSent === true || (error.prompt && error.request === next.request)) throw error;
    sendError = error;
  }
  // A lost acknowledgement can still be confirmed by the hero's new state.
  try {
    if (await verifyAdvancedHeroStep(client, next)) {
      return { response: 'AllHeroResponse', body: { heroId: next.heroId, kind: next.kind, to: next.to } };
    }
  } catch (error) {
    throw new Error('未能确认' + next.label + '结果：' + error.message, { cause: error });
  }
  throw new Error('未能确认' + next.label + '结果：' + (sendError?.message || '尚未读到目标等级或星级'), { cause: sendError });
}
