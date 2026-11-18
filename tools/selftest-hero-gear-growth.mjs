import assert from 'node:assert/strict';
import { executeHeroGearStep, planHeroGearSteps, readHeroGearContext, verifyHeroGearStep } from '../src/hero-gear-growth.mjs';
import { uidText } from '../src/hero-equipment.mjs';

const tables = {
  ModuleOpenCfg: [{ moduleId: '英雄装备', playerLevel: 16 }, { moduleId: '英雄徽章', playerLevel: 12 }],
  EquipCfg: [{ id: '刀', type: '武器' }], EquipAttrCfg: [{ id: '刀', star: '0', maxLv: 3 }],
  EquipUpDecomposeCfg: [{ level: 2, upgradeCost: 50 }],
  HeroBadgeAttrCfg: [{ id: '徽', star: 0, maxLevel: 5 }],
  HeroBadgeLevelCfg: [{ level: 2, exp: 5, goldExpRadio: 20 }],
};
const config = { tables: Object.fromEntries(Object.entries(tables).map(([key, data]) => [key, { data }])) };
const settings = { heroes: { equipment: true, badge: true } };
const options = { config, playerLevel: 16 };
const badgeUid = { high: 2147483646, low: -3, unsigned: false };
function fixture() {
  const hero = { heroId: '主力', equips: [{ uid: 1, equipId: '刀' }], badges: [{ uid: badgeUid, badgeId: '徽' }] };
  const roster = [hero, { heroId: '替补', equips: [{ uid: 2 }], badges: [{ uid: 3 }] }];
  const equips = [1, 2, 4].map(uid => ({ uid, level: 1, equipId: '刀' }));
  const badges = [badgeUid, 3, 5].map(uid => ({ uid, level: 1, exp: 2, badgeId: '徽' }));
  const stock = { '徽章经验': 3, '精铁': 50 };
  const writes = [], reads = [];
  const f = {
    hero, roster, equips, badges, reads, writes, stock, gold: 60,
    async request(name, body) {
      reads.push(name);
      if (name === 'EquipsRequest') return { equip: structuredClone(equips) };
      if (name === 'BadgesRequest') return { badge: structuredClone(badges) };
      if (name === 'AllHeroRequest') return { heroes: structuredClone(roster) };
      if (name === 'AllResourceRequest') return { list: [{ res: 3, amount: f.gold }] };
      if (name === 'AllItemRequest') return { items: Object.entries(stock).map(([itemId, num]) => ({ itemId, num })) };
      if (name === 'EnhanceBadgeRequest') {
        writes.push(name);
        assert.equal(uidText(body.uid), uidText(badgeUid));
        assert.deepEqual(body.decomposeUid, []);
        assert.equal(body.expItemNum, 3);
        badges[0].level++; badges[0].exp = 0;
        return { material: {} };
      }
      throw new Error('unexpected read ' + name);
    },
    async sendWatch(name, body) {
      assert.equal(name, 'EnhanceEquipRequest');
      assert.equal(uidText(body.uid), '1');
      writes.push(name); equips[0].level++;
    },
  };
  return f;
}

async function plan(f, { pref = settings.heroes, level = 16 } = {}) {
  const gear = await readHeroGearContext(f, config, level, pref);
  return planHeroGearSteps({ config, gear, heroes: f.roster, settings: { heroes: pref }, itemNum: id => f.stock[id] ?? 0 }, f.hero);
}

{
  const f = fixture();
  assert.deepEqual(await plan(f, { pref: {} }), []);
  assert.deepEqual(await plan(f, { level: 11 }), []);
  assert.deepEqual(f.reads, []);
  const steps = await plan(f);
  assert.deepEqual(steps.map(s => [s.kind, s.heroId, s.uid]), [['equipment', '主力', '1'], ['badge', '主力', uidText(badgeUid)]]);
  assert.deepEqual(steps[1].costs, [{ id: '徽章经验', num: 3 }, { id: 'GOLD', num: 60 }]);
  for (const step of steps) {
    assert.equal(await verifyHeroGearStep(f, step), false);
    assert((await executeHeroGearStep(f, step, options)).response);
    assert.equal(await verifyHeroGearStep(f, step), true);
  }
  assert.deepEqual(f.writes, ['EnhanceEquipRequest', 'EnhanceBadgeRequest']);
}

const changes = [
  ['badge', f => { f.stock['徽章经验'] = 2; }], ['badge', f => { f.gold = 59; }],
  ['badge', f => { f.hero.badges = []; }], ['badge', f => { f.badges[0].exp = 1; }],
  ['badge', f => { f.roster[1].badges.push({ uid: badgeUid }); }],
  ['badge', f => { f.badges[0].level = 5; }], ['equipment', f => { f.stock['精铁'] = 49; }],
  ['equipment', f => { f.equips[0].level = 2; }], ['equipment', f => { f.hero.equips = []; }],
];
for (const [kind, change] of changes) {
  const f = fixture(), step = (await plan(f)).find(row => row.kind === kind);
  change(f);
  await assert.rejects(executeHeroGearStep(f, step, options), error => error.notSent === true);
  assert.deepEqual(f.writes, []);
}
{
  const f = fixture(), [step] = await plan(f);
  let checks = 0;
  await assert.rejects(executeHeroGearStep(f, step, { ...options, enabled: () => ++checks === 1 }), { notSent: true });
  assert.deepEqual(f.writes, []);
}
{
  const f = fixture(), [step] = await plan(f);
  f.sendWatch = async () => {
    f.request = async () => { throw Object.assign(new Error('回读未发出'), { notSent: true }); };
  };
  await assert.rejects(executeHeroGearStep(f, step, options), error => !error.notSent && /回读失败/.test(error.message));
}
{
  const f = fixture(), [step] = await plan(f);
  f.sendWatch = async () => { throw Object.assign(new Error('服务端拒绝'), { prompt: true, request: step.request }); };
  await assert.rejects(executeHeroGearStep(f, step, options), { prompt: true, request: step.request });
  f.sendWatch = async () => {};
  await assert.rejects(executeHeroGearStep(f, step, options), /尚未确认/);
  f.sendWatch = async () => { f.equips[0].level++; throw new Error('回执丢失'); };
  assert((await executeHeroGearStep(f, step, options)).response);
}
console.log('英雄装备与徽章养成通过：穿戴归属、精确 UID、费用变化、仅消耗经验、暂停与结果回读');
