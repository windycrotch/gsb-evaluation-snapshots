import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeclaredProtocol } from './fixtures/declared-protocol.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-hero-growth-'));
process.env.CW_DATA_DIR = directory;
const { readHeroGrowthPlan, runHeroPlan } = await import('../src/heroes.mjs');
const { defaultSettings, SETTINGS_FORMAT, loadAutomationSettings, importAutomationSettings,
  saveAutomationSettings, settingsFromNative, nativeTaskValues, createUsageLedger } = await import('../src/automation-settings.mjs');
const { createActionGuard } = await import('../src/automation-policy.mjs');
const { pendingOrderMaterialSpends } = await import('../src/order-reservations.mjs');
const { uidText } = await import('../src/hero-equipment.mjs');

const newActions = ['skillAdvance', 'exclusiveLevel', 'exclusiveStar', 'equipment', 'badge', 'showSkillReward'];
const protocol = createDeclaredProtocol(['HeroLevelUpRequest', 'HeroStarUpRequest', 'HeroSkillLevelUpRequest',
  'HeroSkillUpgradeRequest', 'HeroExclusiveLevelUpRequest', 'HeroExclusiveStarUpRequest',
  'EnhanceEquipRequest', 'EnhanceBadgeRequest', 'GotHeroShowSkillRequest']);
const now = Math.floor(Date.now() / 1000);
const player = { playerId: 17701234, level: 30, worldId: 2000001, worldOpenTime: now - 20 * 86400 };
const tables = {
  HeroCfg: ['甲', '乙'].map(id => ({ id, quality: 'RED', universalItemId: '万能碎片' })),
  HeroUpgradeCfg: [{ level: 1, reqPlayerLv: 1, exp: 0 }, { level: 2, reqPlayerLv: 2, exp: 2 }],
  HeroStarCfg: [{ star: 24, maxSkillLevel: [5, 1] }, { star: 25, consumeRed: 10, maxSkillLevel: [5, 2] }],
  HeroSkillUpCfg: [{ quality: 'RED', level: 2, costArr: [[], ['技能书', 1]] }],
  ModuleOpenCfg: ['英雄专武', '英雄装备', '英雄徽章'].map(moduleId => ({ moduleId, playerLevel: 30 })),
  GameplayOpenCfg: [{ gameplay: '英雄专武', openDays: [15, 1] }],
  ExclusiveWeaponCfg: [{ heroId: '甲', skillLv: 1 }],
  ExclusiveStarCfg: [{ star: 0, unlockLv: 2 }, { star: 1, unlockLv: 4, heroStar: 24, piece: 60, cost: [['橙升星石', 3], ['红升星石', 4]] }],
  ExclusiveUpgradeCfg: [{ level: 2, heroStar: 24, cost: [['橙武材料', 2], ['红武材料', 3]] }],
  HeroSkillAdvanceCfg: [{ heroId: '甲', skillLv: 1, season: 2 }],
  HeroSkillAdvanceCostCfg: [{ level: 1, advanceCosts: [['进阶石', 1]] }],
  EquipCfg: [{ id: '刀', type: '武器' }], EquipAttrCfg: [{ id: '刀', star: '0', maxLv: 3 }],
  EquipUpDecomposeCfg: [{ level: 2, upgradeCost: 10 }],
  HeroBadgeAttrCfg: [{ id: '徽', star: 0, maxLevel: 5 }], HeroBadgeLevelCfg: [{ level: 2, exp: 5, goldExpRadio: 2 }],
  HeroAbilityShowCfg: ['甲', '乙', '未拥有'].map(id => ({ id, reward: ['RUBY', 1] })),
};
const config = { tables: Object.fromEntries(Object.entries(tables).map(([key, data]) => [key, { data }])) };

function fixture() {
  const settings = defaultSettings();
  Object.assign(settings.heroes, { enabled: true, level: true, star: true, skill: true });
  settings.heroes.heroIds = ['甲'];
  for (const key of newActions) settings.heroes[key] = true;
  const hero = { heroId: '甲', level: 1, star: 24, skillLevels: [5, 1], exclusive: { level: 1, star: 0 },
    equips: [{ uid: 71, equipId: '刀' }], badges: [{ uid: 72, badgeId: '徽' }] };
  const bench = { heroId: '乙', level: 1, star: 24, skillLevels: [5, 1] };
  const claimed = [], writes = [], reads = [];
  const bag = { 英雄经验: 2, 甲碎片: 70, 乙碎片: 100, 红升星石: 4, 红武材料: 3, 技能书: 1, 进阶石: 1, 精铁: 10, 徽章经验: 5 };
  const equip = { uid: 71, equipId: '刀', star: 0, level: 1 }, badge = { uid: 72, badgeId: '徽', star: 0, level: 1, exp: 0 };
  let gold = 10;
  const client = {
    async request(name, body) {
      switch (name) {
        case 'HeroStarUpRequest':
          assert.equal(body.heroId, hero.heroId); assert.equal(body.universal, false);
          writes.push(name); bag.甲碎片 -= 10; return { nextStar: ++hero.star };
        case 'GotHeroShowSkillRequest':
          assert(['甲', '乙'].includes(body.heroId), '只领取已拥有且配置有奖励的英雄');
          assert(!claimed.includes(body.heroId), '已领展示奖励不能重复领取');
          writes.push(name); claimed.push(body.heroId); return {};
        case 'EnhanceBadgeRequest':
          assert.equal(uidText(body.uid), '72'); assert.deepEqual(body.decomposeUid, []);
          assert.equal(body.expItemNum, 5); writes.push(name); badge.level++; gold -= 10; bag.徽章经验 -= 5; return {};
      }
      reads.push(name);
      switch (name) {
        case 'AllHeroRequest': return structuredClone({ heroes: [hero, bench, { heroId: '无奖励' }], showSkillHeroes: claimed });
        case 'AllItemRequest': return { items: Object.entries(bag).map(([itemId, num]) => ({ itemId, num })) };
        case 'AllResourceRequest': return { list: [{ res: 3, amount: gold }] };
        case 'EquipsRequest': return structuredClone({ equip: [equip] });
        case 'BadgesRequest': return structuredClone({ badge: [badge] });
        default: throw new Error('意外的请求 ' + name);
      }
    },
    async sendWatch(name, body) {
      writes.push(name);
      if (name === 'EnhanceEquipRequest') {
        assert.equal(uidText(body.uid), '71'); equip.level++; bag.精铁 -= 10; return;
      }
      assert.equal(body.heroId, '甲');
      switch (name) {
        case 'HeroLevelUpRequest': hero.level++; bag.英雄经验 -= 2; break;
        case 'HeroSkillLevelUpRequest': hero.skillLevels[body.skillIdx - 1]++; bag.技能书--; break;
        case 'HeroSkillUpgradeRequest': hero.skillUpgrades = [1]; bag.进阶石--; break;
        case 'HeroExclusiveLevelUpRequest': hero.exclusive.level++; bag.红武材料 -= 3; break;
        case 'HeroExclusiveStarUpRequest':
          assert.equal(body.universal, false); hero.exclusive.star++; bag.甲碎片 -= 60; bag.红升星石 -= 4; break;
        default: throw new Error('意外的发送 ' + name);
      }
    },
  };
  const plan = async () => (await readHeroGrowthPlan(client, config, player, settings)).plan;
  const run = (plan, options = {}) => runHeroPlan(client, protocol, plan, { allowMutate: true, config, player, getSettings: () => settings, ...options });
  return { settings, plan, run, bag, writes, reads, client, claimed };
}

async function testExclusiveMaterialRecovery() {
  const f = fixture();
  f.bag.红武材料 = 6;
  const plan = await f.plan();
  const step = plan.steps.find(action => action.kind === 'exclusiveLevel');
  assert(step);
  const ledger = createUsageLedger('offline-hero', { file: path.join(directory, 'usage.json') });
  const guard = client => createActionGuard(client, () => f.settings, ledger, { player });
  const first = guard(f.client);
  const send = f.client.sendWatch, request = f.client.request;
  f.client.sendWatch = async (...args) => {
    await send(...args);
    throw new Error('专武已升级，等待回包超时');
  };
  f.client.request = async (name, ...args) => {
    if (name === 'AllHeroRequest' && f.writes.length) {
      throw Object.assign(new Error('英雄回读暂时失败'), { notSent: true });
    }
    return request(name, ...args);
  };
  const [result] = await f.run({ ...plan, steps: [step] }, {
    beforeAction: first.before, afterAction: first.after, cancelAction: first.cancel,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /英雄回读暂时失败/);
  assert.equal(f.bag.红武材料, 3);
  const pending = pendingOrderMaterialSpends(player);
  assert.equal(pending.length, 1, '已发送的专武请求应保留材料，回读本身未发送不影响写入状态');

  // The next connection first sees the new bag with a stale roster, then the
  // target level with an unavailable bag, and finally both current snapshots.
  let staleRoster = true, bagAvailable = true;
  const nextClient = { ...f.client, async request(name, ...args) {
    if (name === 'AllItemRequest' && !bagAvailable) throw new Error('无法读取完整库存');
    const reply = await request(name, ...args);
    if (name === 'AllHeroRequest' && staleRoster) {
      for (const hero of reply.heroes) hero.exclusive = { level: hero.heroId === step.heroId ? step.from : step.to, star: 0 };
    }
    return reply;
  } };
  const nextGuard = guard(nextClient);
  const otherSpend = { request: 'OtherRequest', costs: [{ id: '红武材料', num: 1 }] };
  await assert.rejects(() => nextGuard.before(otherSpend), /待确认|尚未确认/);
  assert.deepEqual(pendingOrderMaterialSpends(player), pending, '库存扣减及其他英雄达到目标均不能解除材料预留');
  staleRoster = false;
  bagAvailable = false;
  await assert.rejects(() => nextGuard.before(otherSpend), /无法读取完整库存/);
  assert.deepEqual(pendingOrderMaterialSpends(player), pending, '已确认专武升级，仍应等待完整库存');
  bagAvailable = true;
  const ticket = await nextGuard.before(otherSpend);
  assert(!pendingOrderMaterialSpends(player).includes(pending[0]), '恢复读取后应解除旧预留并可使用余额');
  await nextGuard.cancel(otherSpend, ticket, { notSent: true });
  assert.deepEqual(pendingOrderMaterialSpends(player), []);
  assert.deepEqual(f.writes, ['HeroExclusiveLevelUpRequest'], '对账不应重复发送升级或新的消费');
}

try {
  assert(newActions.every(key => defaultSettings().heroes[key] === false));
  const unselected = fixture();
  unselected.settings.heroes.heroIds = [];
  const empty = await unselected.plan();
  assert.deepEqual(empty.steps.map(step => [step.kind, step.heroId]), [['showSkillReward', '甲'], ['showSkillReward', '乙']]);
  assert.match(empty.notes.join(''), /选择/);
  await unselected.run(empty);
  assert.deepEqual(unselected.writes, ['GotHeroShowSkillRequest', 'GotHeroShowSkillRequest'], '空名单仅领取全部英雄奖励，不执行消费养成');
  assert.deepEqual(unselected.claimed, ['甲', '乙']);
  assert(!unselected.reads.some(name => ['AllItemRequest', 'EquipsRequest', 'BadgesRequest'].includes(name)));
  assert.deepEqual((await unselected.plan()).steps, [], '空名单领奖也以已领记录去重');

  const f = fixture();
  f.bag.甲碎片 = 69;
  const tight = await f.plan();
  assert(tight.steps.some(step => step.kind === 'star'));
  assert(!tight.steps.some(step => step.kind === 'exclusiveStar'), '先给英雄升星的本体碎片不能再次用于专武升星');
  f.bag.甲碎片 = 70;
  const all = await f.plan();
  assert.deepEqual(new Set(all.steps.map(step => step.kind)), new Set(['level', 'star', 'skill', ...newActions]));
  assert(all.steps.filter(step => step.kind !== 'showSkillReward').every(step => step.heroId === '甲'));
  assert.deepEqual(all.steps.filter(step => step.kind === 'showSkillReward').map(step => step.heroId), ['甲', '乙']);
  const reserved = [], committed = [];
  const result = await f.run(all, {
    beforeAction: step => { const ticket = { step }; reserved.push(ticket); return ticket; },
    afterAction: (step, ticket) => { assert.equal(ticket.step, step); committed.push(ticket); },
  });
  assert(result.every(entry => entry.ok), JSON.stringify(result));
  assert.equal(f.writes.length, 10);
  assert.deepEqual(committed, reserved);
  assert.equal(reserved.length, 10);
  assert.deepEqual(f.claimed, ['甲', '乙']);
  assert.equal(f.bag.甲碎片, 0);
  assert(!((await f.plan()).steps.some(step => step.kind === 'showSkillReward')), '已领展示奖励不会重复列入');

  for (const heroIds of [[], ['乙']]) {
    const interrupted = fixture(), canceled = [];
    await interrupted.run(await interrupted.plan(), {
      beforeAction: step => { interrupted.settings.heroes.heroIds = heroIds; return step; },
      cancelAction: (step, ticket, why) => { assert.equal(step, ticket); canceled.push(why); },
    });
    assert.deepEqual(interrupted.writes, ['GotHeroShowSkillRequest', 'GotHeroShowSkillRequest'], '更改培养名单不影响所有英雄领奖');
    assert.deepEqual(interrupted.claimed, ['甲', '乙']);
    assert.deepEqual(canceled, [{ notSent: true }], '已预留但尚未发送时更改目标须释放该次预留');
  }
  const partial = fixture();
  await partial.run(await partial.plan(), { onStep: () => { partial.settings.heroes.heroIds = ['乙']; } });
  assert.deepEqual(partial.writes, ['HeroLevelUpRequest', 'GotHeroShowSkillRequest', 'GotHeroShowSkillRequest'], '执行中换目标会停止旧培养计划，但继续领取全部奖励');
  for (const key of ['enabled', 'showSkillReward']) {
    const disabled = fixture();
    disabled.settings.heroes.heroIds = [];
    const planned = await disabled.plan();
    disabled.settings.heroes[key] = false;
    assert.deepEqual((await disabled.plan()).steps, [], key + ' 关闭后不再计划领奖');
    await disabled.run(planned);
    assert.deepEqual(disabled.writes, [], key + ' 关闭后旧计划也不再领奖');

    const interrupted = fixture(), canceled = [];
    interrupted.settings.heroes.heroIds = [];
    await interrupted.run(await interrupted.plan(), {
      beforeAction: step => { interrupted.settings.heroes[key] = false; return step; },
      cancelAction: (step, ticket, why) => { assert.equal(step, ticket); canceled.push(why); },
    });
    assert.deepEqual(interrupted.writes, [], key + ' 在发送前关闭时须停止领奖');
    assert.deepEqual(canceled, [{ notSent: true }]);
  }
  await testExclusiveMaterialRecovery();

  const file = path.join(directory, 'legacy-settings.json');
  for (const ids of [['甲'], []]) {
    const old = defaultSettings();
    old.heroes.heroIds = ids; old.heroes.targetLevel = 15; old.heroes.universal = false;
    delete old.heroes.needsSelection;
    for (const key of newActions) delete old.heroes[key];
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { captain: { revision: 7, settings: old } } }));
    const loaded = loadAutomationSettings('captain', { file });
    const imported = importAutomationSettings({ format: SETTINGS_FORMAT, version: 1, settings: old });
    for (const migrated of [loaded.settings, imported]) {
      assert.deepEqual(migrated.heroes.heroIds, ids);
      assert.equal(migrated.heroes.needsSelection, ids.length === 0);
      assert.equal(migrated.heroes.targetLevel, 15); assert.equal(migrated.heroes.universal, false);
      assert(newActions.every(key => migrated.heroes[key] === false));
      if (!ids.length) {
        const pending = fixture(); pending.settings.heroes = migrated.heroes;
        assert.deepEqual((await pending.plan()).steps, []);
      }
    }
    if (!ids.length) imported.heroes.heroIds = ['乙'];
    const saved = saveAutomationSettings('captain', imported, { file, revision: 7 });
    assert.equal(saved.revision, 8);
    assert.equal(saved.settings.heroes.needsSelection, false);
    assert.deepEqual(loadAutomationSettings('captain', { file }).settings.heroes, saved.settings.heroes);
  }
  const native = settingsFromNative({ heroGrowth: true });
  assert.deepEqual(native.heroes.heroIds, []);
  assert.equal(native.heroes.needsSelection, true);
  assert.equal(nativeTaskValues(native, { heroGrowth: true }).heroGrowth, false);
  console.log('英雄养成集成通过：九项计划与执行、空名单全英雄领奖、领奖开关与去重、共享消耗、变更培养目标、专武材料超时对账、旧存档和导入迁移');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
