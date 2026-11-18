import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-saved-lineups-'));
process.env.CW_DATA_DIR = directory;
const { getLineupCatalog, normalizeFormation, formationSignature, validateLineupSettings, readLineupEditor, validateEditorFormation } = await import('../src/saved-lineups.mjs');

const formation = { presetId: 1, heroPositions: [{ heroId: 'a', pos: { x: 4, y: 4 } }], petUid: '9007199254740993' };
const config = { tables: {
  HeroCfg: { data: [{ id: 'a', name: '英雄甲', career: '坦克', faction: '阵营A', quality: 'BLUE' },
    { id: 'b', name: '英雄乙', career: '射手', faction: '阵营B', quality: 'ORANGE' },
    { id: 'c', name: '英雄丙', career: '法师', faction: '阵营C', quality: 'PURPLE' }] },
  FormationHeroNumCfg: { data: [{ mainlineStage: 0, heroNum: 1 }, { mainlineStage: 5, heroNum: 2 }] },
  FormationTypePositionCfg: { data: [{ id: 1, position: [4, 4] }, { id: 1, position: [1, 3] },
    { id: 7, position: [5, 5] }, { id: 7, position: [5, 1] }, { id: 7, position: [1, 3] }] },
  FormationTypeUnlockCfg: { data: [{ id: 7, name: '攻速增强', activeDesc: '攻速+{0}', activeDescParams: ['15%'],
    unlockDesc: '所有英雄{0}+{1}', unlockDescParams: ['生命', '3%'] }] },
  PetBreedCfg: { data: [{ petId: 'pet-a', spId: 1, quality: 'BLUE' }, { petId: 'pet-b', spId: 1, quality: 'ORANGE' }] },
  PetSpeciesCfg: { data: [{ spId: 1, name: '声波海豚' }] },
} };

function fixture({ pets = [{ uid: { low: 1, high: 2097152, unsigned: false }, petId: 'pet-a', star: 2, level: 10 }], failPet = false } = {}) {
  const calls = [];
  return {
    calls,
    async request(name, body, response) {
      calls.push(name);
      assert.equal(response, name.replace('Request', 'Response'));
      if (name === 'AllPetRequest' && failPet) throw new Error('海兽读取失败');
      const replies = {
        GetFormationRequest: { formation }, AllHeroRequest: { heroes: [{ heroId: 'a', level: 10, power: 123 }, { heroId: 'b', level: 5, power: 77 }] },
        MyFormationPresetRequest: { ids: [7] }, AllPetRequest: { pets },
      };
      assert(Object.hasOwn(replies, name), '编辑器只能读取已确认的协议');
      return structuredClone(replies[name]);
    },
  };
}

try {
  assert.deepEqual(normalizeFormation(formation), formation);
  assert.equal(normalizeFormation({ ...formation, petUid: { low: 1, high: 2097152 } }).petUid, '9007199254740993');
  for (const value of [undefined, 0, '0', { low: 0, high: 0 }]) assert.equal(normalizeFormation({ ...formation, petUid: value }).petUid, '0');
  for (const value of [-1, Number.MAX_SAFE_INTEGER + 1, '9223372036854775808', 'bad']) {
    assert.throws(() => normalizeFormation({ ...formation, petUid: value }), /海兽编号/);
  }
  assert.throws(() => normalizeFormation({ ...formation, heroPositions: [] }), /至少/);
  assert.deepEqual(normalizeFormation({ ...formation, heroPositions: [] }, { allowEmpty: true }).heroPositions, []);
  assert.throws(() => normalizeFormation({ ...formation, heroPositions: [...formation.heroPositions, ...formation.heroPositions] }), /重复英雄/);
  assert.throws(() => normalizeFormation({ ...formation, heroPositions: [...formation.heroPositions, { heroId: 'b', pos: { x: 4, y: 4 } }] }), /同一站位/);
  assert.throws(() => normalizeFormation({ ...formation, heroPositions: [{ heroId: 'a', pos: { x: 4.2, y: 4 } }] }), /站位无效/);
  assert.throws(() => normalizeFormation({ ...formation, heroPositions: Array.from({ length: 101 }, (_, i) => ({ heroId: 'h' + i, pos: { x: i, y: 0 } })) }), /不能超过 100/);
  assert.throws(() => normalizeFormation({ ...formation, heroPositions: [{ heroId: 'h'.repeat(121), pos: { x: 1, y: 1 } }] }), /最多 120/);
  class ProtocolFormation { constructor() { Object.assign(this, formation); } }
  assert.deepEqual(normalizeFormation(new ProtocolFormation()), formation, '允许真实协议解码后的类实例');
  const two = { ...formation, heroPositions: [...formation.heroPositions, { heroId: 'b', pos: { x: 1, y: 3 } }] };
  assert.equal(formationSignature(two), formationSignature({ ...two, heroPositions: [...two.heroPositions].reverse() }));
  assert.notEqual(formationSignature(two), formationSignature({ ...two, petUid: '0' }));

  assert.deepEqual(validateLineupSettings(), { presets: [], mainlinePresetId: '', trialPresets: [] });
  const settings = { presets: [{ id: 'p1', name: ' 推关 ', formation }], mainlinePresetId: 'p1', trialPresets: [{ raidId: '1', presetId: 'p1' }] };
  assert.equal(validateLineupSettings(settings).presets[0].name, '推关');
  assert.throws(() => validateLineupSettings({ ...settings, presets: [...settings.presets, ...settings.presets] }), /编号重复/);
  assert.throws(() => validateLineupSettings({ ...settings, mainlinePresetId: 'missing' }), /已不存在/);
  assert.throws(() => validateLineupSettings({ ...settings, trialPresets: [{ raidId: '1', presetId: 'missing' }] }), /已不存在/);
  assert.throws(() => validateLineupSettings({ ...settings, trialPresets: [...settings.trialPresets, ...settings.trialPresets] }), /重复/);
  assert.throws(() => validateLineupSettings({ ...settings, trialPresets: [{ raidId: '-1', presetId: 'p1' }] }), /副本编号/);
  for (const invalid of [[], null, new Date(), Object.create(null)]) assert.throws(() => validateLineupSettings(invalid), /JSON 对象/);
  assert.throws(() => validateLineupSettings({ ...settings, surprise: true }), /未知字段/);
  assert.throws(() => validateLineupSettings({ ...settings, presets: null }), /列表/);
  assert.throws(() => validateLineupSettings({ ...settings, trialPresets: null }), /列表/);
  assert.throws(() => validateLineupSettings({ ...settings, mainlinePresetId: null }), /已不存在/);
  for (const preset of [new Date(), { ...settings.presets[0], extra: true }, { ...settings.presets[0], name: 'a'.repeat(61) },
    { ...settings.presets[0], id: 'a'.repeat(121) }, { ...settings.presets[0], formation: new ProtocolFormation() },
    { ...settings.presets[0], formation: { ...formation, extra: true } },
    { ...settings.presets[0], formation: { ...formation, heroPositions: [{ ...formation.heroPositions[0], extra: true }] } },
    { ...settings.presets[0], formation: { ...formation, heroPositions: [{ heroId: 'a', pos: { x: 4, y: 4, extra: true } }] } }]) {
    assert.throws(() => validateLineupSettings({ ...settings, presets: [preset] }), /JSON 对象|未知字段|最多/);
  }
  for (const binding of [new Date(), { raidId: '1', presetId: 'p1', extra: true }, { raidId: '1', presetId: 'a'.repeat(121) }]) {
    assert.throws(() => validateLineupSettings({ ...settings, trialPresets: [binding] }), /JSON 对象|未知字段|最多/);
  }
  assert.equal(validateLineupSettings({ presets: [{ id: 'i'.repeat(120), name: 'n'.repeat(60), formation }] }).presets[0].name.length, 60);

  assert.deepEqual(getLineupCatalog(null), { heroes: [], formations: [] });
  assert.deepEqual(getLineupCatalog({ tables: {} }), { heroes: [], formations: [] });
  const catalog = getLineupCatalog(config);
  assert.deepEqual(catalog.heroes.map(hero => hero.heroId), ['a', 'b', 'c'], '离线目录包括所有配置英雄');
  assert.equal(catalog.heroes[2].name, '英雄丙');
  assert.equal(catalog.formations[1].effect, '攻速+15%');
  assert.equal(catalog.formations[1].unlockEffect, '所有英雄生命+3%');
  assert.equal(Object.hasOwn(catalog.formations[1], 'unlocked'), false, '静态目录不推测账号拥有状态');
  assert.equal(Object.hasOwn(catalog.heroes[0], 'level'), false);
  catalog.formations[0].positions[0].x = 99;
  assert.equal(getLineupCatalog(config).formations[0].positions[0].x, 4, '目录返回值不修改配置快照');

  const client = fixture();
  const editor = await readLineupEditor(client, config, { mainlineStage: 6 });
  assert.deepEqual(client.calls, ['GetFormationRequest', 'AllHeroRequest', 'MyFormationPresetRequest', 'AllPetRequest']);
  assert.equal(editor.capacity, 2);
  assert.equal(editor.formations[0].unlocked, true);
  assert.equal(editor.formations[1].positions.length, 3, '阵型可选格数与上阵人数分别处理');
  assert.equal(editor.formations[1].effect, '攻速+15%');
  assert.equal(editor.formations[1].unlockEffect, '所有英雄生命+3%');
  assert.equal(editor.pets[0].uid, '9007199254740993');
  assert.equal(editor.pets[0].name, '声波海豚（蓝色 · 2星 · 10级）');
  assert.deepEqual([editor.pets[0].petId, editor.pets[0].quality, editor.pets[0].star, editor.pets[0].level], ['pet-a', 'BLUE', 2, 10]);
  assert.equal(editor.heroes[0].name, '英雄甲');
  assert.deepEqual(editor.heroes.map(hero => hero.heroId), ['a', 'b'], '联网编辑器保留实际拥有英雄过滤');
  const staticHero = getLineupCatalog(config).heroes[0];
  const { level, power, ...editorHero } = editor.heroes[0];
  assert.deepEqual(editorHero, staticHero, '联网与离线展示复用同一静态元数据');
  assert.deepEqual(validateEditorFormation(two, editor), two);
  assert.throws(() => validateEditorFormation(two, { ...editor, capacity: 1 }), /人数上限/);
  assert.throws(() => validateEditorFormation({ ...formation, presetId: 7 }, editor), /站位不属于/);
  assert.throws(() => validateEditorFormation(formation, { ...editor, pets: [] }), /海兽已不存在/);
  assert.throws(() => validateEditorFormation(formation, { ...editor, heroes: [] }), /尚未拥有/);
  assert.throws(() => validateEditorFormation(formation, { ...editor, formations: [{ ...editor.formations[0], unlocked: false }] }), /尚未解锁/);
  assert.equal((await readLineupEditor(fixture(), config, { mainlineStage: 5 })).capacity, 1, '严格使用已通过关卡解锁人数');
  const lowLevel = fixture({ pets: [] });
  const lowEditor = await readLineupEditor(lowLevel, config, { level: 6, mainlineStage: 1 });
  assert.deepEqual(lowEditor.pets, []);
  assert(lowLevel.calls.includes('AllPetRequest'), '与游戏登录一致，低等级也读取海兽仓库');
  assert.equal(validateEditorFormation({ ...formation, petUid: '0' }, lowEditor).petUid, '0');
  await assert.rejects(readLineupEditor(fixture({ failPet: true }), config, { level: 6, mainlineStage: 1 }), /海兽读取失败/);
  await assert.rejects(readLineupEditor(fixture({ pets: null }), config, { level: 6, mainlineStage: 1 }), /无法读取海兽列表/);
  const sameSpecies = await readLineupEditor(fixture({ pets: [
    { uid: '1', petId: 'pet-a', star: 2, level: 10 }, { uid: '2', petId: 'pet-b', star: 3, level: 20 },
  ] }), config, { mainlineStage: 6 });
  assert.notEqual(sameSpecies.pets[0].name, sameSpecies.pets[1].name, '同品种不同品质星级可以区分');
  console.log('saved lineups ok: editor reads, exact UIDs, settings references, formation validation');
} finally {
  assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(directory, { recursive: true, force: true });
}
