import assert from 'node:assert/strict';
import { planAdvancedHeroGrowth, readAdvancedHeroContext, runAdvancedHeroStep, verifyAdvancedHeroStep } from '../src/hero-advanced-growth.mjs';

const now = Math.floor(Date.now() / 1000);
const player = { level: 30, worldId: 2000001, worldOpenTime: now - 20 * 86400 };
const hero = { heroId: 'A', star: 25, skillLevels: [5, 0, 0, 0], skillUpgrades: [], exclusive: { level: 1, star: 0 } };
const config = { tables: Object.fromEntries(Object.entries({
  ModuleOpenCfg: [{ moduleId: '英雄专武', playerLevel: 30 }],
  GameplayOpenCfg: [{ gameplay: '英雄专武', openDays: [15, 2] }],
  HeroCfg: [{ id: 'A', quality: 'RED' }],
  ExclusiveWeaponCfg: [{ heroId: 'A', skillLv: 1 }],
  ExclusiveUpgradeCfg: [1, 2, 3].map(level => ({ level, heroStar: 15, cost: [['橙武材料', 10], ['红武材料', level === 1 ? 50 : 5]] })),
  ExclusiveStarCfg: [{ star: 0, unlockLv: 2 }, { star: 1, heroStar: 25, piece: 60, unlockLv: 4, cost: [['橙升星石', 5], ['红升星石', 6]] }],
  HeroSkillAdvanceCfg: [{ heroId: 'A', skillLv: 1, season: 2 }, { heroId: 'A', skillLv: 2, season: 3 }],
  HeroSkillAdvanceCostCfg: [{ level: 1, advanceCosts: [['进阶石', 1]] }, { level: 2, advanceCosts: [['进阶石', 2]] }],
}).map(([table, data]) => [table, { data }])) };
const stock = { 红武材料: 50, 红升星石: 6, A碎片: 60, 进阶石: 1 };
const switches = { exclusiveLevel: true, exclusiveStar: true, skillAdvance: true };
const ctx = { config, settings: { heroes: switches }, player, now, itemNum: id => stock[id] ?? 0 };
const plan = (changes, state = hero) => planAdvancedHeroGrowth({ ...ctx, ...changes }, state);
const steps = plan(), kinds = values => values.map(step => step.kind);
assert.deepEqual(kinds(steps), ['skillAdvance', 'exclusiveLevel', 'exclusiveStar']);
assert.equal(steps[0].label, 'A · 主技能进阶至 2 阶');
assert.equal(steps[1].label, 'A · 专武升级至 2 级');
assert.equal(steps[2].label, 'A · 专武升至 1 星');
// V76 HeroSkillUpPanel reads skillUpgrades[0] and sends just heroId when the first skill reaches level 5.
// skillIdx belongs to the separate HeroSkillLevelUpRequest (normal skill levels).
assert.deepEqual(steps[0].body, { heroId: 'A' });
assert.deepEqual(steps[1].costs, [{ id: '红武材料', num: 5 }]);
assert.deepEqual(steps[2].costs, [{ id: 'A碎片', num: 60 }, { id: '红升星石', num: 6 }]);
assert.equal(steps[2].body.universal, false);
assert.deepEqual(plan({ settings: { heroes: {} } }), []);

assert.deepEqual(kinds(plan({ player: { ...player, level: 29 } })), ['skillAdvance']);
assert.deepEqual(kinds(plan({ player: { ...player, worldOpenTime: now } })), ['skillAdvance']);
assert.deepEqual(kinds(plan({ player: { ...player, worldId: 1000001 } })), ['exclusiveLevel', 'exclusiveStar']);
assert.deepEqual(plan({ player: { ...player, worldId: undefined } }), []);
assert.deepEqual(kinds(plan({}, { ...hero, skillLevels: [4] })), ['exclusiveLevel', 'exclusiveStar']);
assert.deepEqual(kinds(plan({}, { ...hero, skillUpgrades: [1] })), ['exclusiveLevel', 'exclusiveStar']);
assert.deepEqual(kinds(plan({}, { ...hero, exclusive: { level: 2, star: 0 } })), ['skillAdvance', 'exclusiveStar']);
assert.deepEqual(kinds(plan({}, { ...hero, star: 14 })), ['skillAdvance']);
assert.deepEqual(kinds(plan({}, { ...hero, exclusive: null })), ['skillAdvance', 'exclusiveLevel']);
assert.deepEqual(plan({}, { ...hero, exclusive: null })[1].costs, [{ id: '红武材料', num: 50 }]);
assert.deepEqual(kinds(plan({ itemNum: id => id === 'A碎片' ? 59 : stock[id] ?? 0 })), ['skillAdvance', 'exclusiveLevel']);
assert.deepEqual(kinds(plan({ itemNum: id => ['橙武材料', '橙升星石', 'A碎片'].includes(id) ? 100 : 0 })), []);
const orangeConfig = structuredClone(config); orangeConfig.tables.HeroCfg.data[0].quality = 'ORANGE';
assert.deepEqual(kinds(plan({ config: orangeConfig, itemNum: () => 100 })), kinds(steps));
assert.equal(plan({ config: orangeConfig, itemNum: () => 100 })[1].costs[0].id, '橙武材料');
assert.deepEqual(plan({}, { ...hero, heroId: '无适用配置的英雄' }), []);

function fixture() {
  return {
    roster: [structuredClone(hero)], stock: { ...stock }, writes: [], reads: [],
    async request(request) {
      this.reads.push(request);
      if (this.writes.length && this.failReadback) throw Object.assign(new Error('断线'), { notSent: true });
      if (request === 'AllHeroRequest') return { heroes: this.roster };
      assert.equal(request, 'AllItemRequest');
      return { items: Object.entries(this.stock).map(([itemId, num]) => ({ itemId, num })) };
    },
    async sendWatch(request, body) {
      this.writes.push([request, body]);
      if (this.dropUpdate) return;
      const target = this.roster.find(row => row.heroId === body.heroId);
      if (request === 'HeroSkillUpgradeRequest') target.skillUpgrades = [(target.skillUpgrades?.[0] ?? 0) + 1];
      else if (request === 'HeroExclusiveLevelUpRequest') target.exclusive = { ...target.exclusive, level: (target.exclusive?.level ?? 0) + 1 };
      else if (request === 'HeroExclusiveStarUpRequest') target.exclusive.star++;
      else assert.fail('未知请求 ' + request);
      if (this.loseResponse) throw new Error('回包超时');
    },
  };
}
const options = { player, config, enabled: () => true };
for (const step of steps) {
  const client = fixture();
  const outcome = await runAdvancedHeroStep(client, step, options);
  assert.equal(outcome.response, 'AllHeroResponse');
  assert.deepEqual(client.writes, [[step.request, step.body]]);
  assert.equal(await verifyAdvancedHeroStep(client, step), true);
  await assert.rejects(() => runAdvancedHeroStep(client, step, options), { notSent: true });
  assert.equal(client.writes.length, 1);
}
for (const change of [
  client => { client.roster = []; },
  client => { client.stock.红升星石 = 0; },
  client => { client.stock.A碎片 = 59; },
  client => { client.roster[0].star--; },
  client => { client.roster[0].exclusive = null; },
]) {
  const client = fixture(); change(client);
  await assert.rejects(() => runAdvancedHeroStep(client, steps[2], options), { notSent: true });
  assert.equal(client.writes.length, 0);
}
const switchedOff = fixture();
await assert.rejects(() => runAdvancedHeroStep(switchedOff, steps[0], { ...options, enabled: () => false }), { notSent: true });
assert.equal(switchedOff.writes.length, 0);
const drift = fixture();
await assert.rejects(() => runAdvancedHeroStep(drift, { ...steps[2], costs: [{ id: 'A碎片', num: 1 }] }, options), { notSent: true });
assert.equal(drift.writes.length, 0);
for (const mode of ['dropUpdate', 'failReadback']) {
  const client = fixture(); client[mode] = true;
  await assert.rejects(() => runAdvancedHeroStep(client, steps[0], options), error => error.notSent !== true && error.message.includes('确认'));
  assert.equal(client.writes.length, 1);
}
const synced = readAdvancedHeroContext({ serverClockOffsetMs: 60000 });
assert(Math.abs(synced.now - (Date.now() / 1000 + 60)) < 2);
const lost = fixture(); lost.loseResponse = true;
assert.equal((await runAdvancedHeroStep(lost, steps[2], options)).response, 'AllHeroResponse');
assert.equal(lost.writes.length, 1);
for (const code of [{ notSent: true }, { prompt: { text: '材料不足' }, request: steps[0].request }]) {
  const rejected = fixture(), failure = Object.assign(new Error('未执行'), code);
  rejected.sendWatch = async () => { throw failure; };
  await assert.rejects(() => runAdvancedHeroStep(rejected, steps[0], options), err => err === failure);
  assert.deepEqual(rejected.reads, ['AllHeroRequest', 'AllItemRequest']);
}
if (process.argv.includes('--protocol')) {
  const { loadProtocol } = await import('../src/proto.mjs');
  const protocol = loadProtocol();
  assert(!('skillIdx' in protocol.HeroSkillUpgradeRequest.prototype));
  for (const step of steps) {
    const codec = protocol[step.request];
    assert.deepEqual({ ...codec.decode(codec.encode(step.body).finish()) }, step.body);
  }
}
console.log('英雄技能进阶与专武养成通过：赛季和开放日、品质材料、专属碎片、发送前复查与跨轮结果确认');
