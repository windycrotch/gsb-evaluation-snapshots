import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProtocol } from '../src/proto.mjs';

// This codec check belongs to test:core. Offline behavior tests use explicit
// fixtures and do not need the locally cached game bundle.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lineup-protocol-'));
process.env.CW_DATA_DIR = directory;
const { normalizeFormation, formationSignature, readLineupEditor, validateEditorFormation, validateLineupSettings } = await import('../src/saved-lineups.mjs');
const { withTemporaryLineup, recoverLineup, readLineupRuntime } = await import('../src/lineup-runtime.mjs');

function wireUid(value) {
  const uid = BigInt(value);
  return { low: Number(BigInt.asIntN(32, uid)), high: Number(uid >> 32n), unsigned: false };
}

const original = { presetId: 1, heroPositions: [{ heroId: 'a', pos: { x: 4, y: 0 } }], petUid: '0' };
const target = { presetId: 7, heroPositions: [{ heroId: 'b', pos: { x: 5, y: 1 } }], petUid: '9007199254740993' };
const config = { tables: {
  HeroCfg: { data: [{ id: 'a', name: '英雄甲', career: '坦克', faction: '阵营A', quality: 'BLUE' },
    { id: 'b', name: '英雄乙', career: '射手', faction: '阵营B', quality: 'ORANGE' }] },
  FormationHeroNumCfg: { data: [{ mainlineStage: 0, heroNum: 5 }] },
  FormationTypePositionCfg: { data: [{ id: 1, position: [4, 0] }, { id: 7, position: [5, 1] }] },
  FormationTypeUnlockCfg: { data: [{ id: 7, name: '攻速增强' }] },
  PetBreedCfg: { data: [{ petId: 'pet-a', spId: 1, quality: 'BLUE' }] },
  PetSpeciesCfg: { data: [{ spId: 1, name: '声波海豚' }] },
} };

try {
  const protocol = loadProtocol();
  const decode = (name, body) => {
    assert(protocol[name], '真实协议缺少 ' + name);
    return protocol[name].decode(protocol[name].encode(body).finish());
  };
  const actualFormation = decode('Formation', { ...target, petUid: wireUid(target.petUid) });
  assert.notEqual(Object.getPrototypeOf(actualFormation), Object.prototype);
  assert.notEqual(Object.getPrototypeOf(actualFormation.heroPositions[0]), Object.prototype);
  assert.notEqual(Object.getPrototypeOf(actualFormation.heroPositions[0].pos), Object.prototype);
  assert.deepEqual(normalizeFormation(actualFormation), target);
  assert.equal(formationSignature(actualFormation), formationSignature(target));
  const defaults = decode('Formation', { presetId: 1, heroPositions: [{ heroId: 'a', pos: { x: 4 } }] });
  assert.equal(Object.hasOwn(defaults, 'petUid'), false);
  assert.equal(Object.hasOwn(defaults.heroPositions[0].pos, 'y'), false);
  assert.deepEqual(normalizeFormation(defaults), original, '读取protobuf原型上的默认坐标与零海兽');
  assert.throws(() => protocol.Formation.decode(new Uint8Array()), /missing required 'presetId'/);
  assert.equal(decode('GetFormationResponse', {}).formation, null);
  assert.throws(() => normalizeFormation(decode('Formation', { presetId: 0 }), { allowEmpty: true }), /阵容数据无效/);
  assert.throws(() => validateLineupSettings({ presets: [{ id: 'p', name: '测试', formation: actualFormation }] }), /JSON 对象/);
  assert.throws(() => validateLineupSettings({ presets: [{ id: 'p', name: '测试', formation: { ...target, unknown: true } }] }), /未知字段/);

  const client = {
    connected: true, current: defaults, writes: [],
    async request(name, body, response) {
      if (!this.connected) throw new Error('协议测试断线');
      const request = decode(name, body);
      if (name === 'SaveFormationRequest') {
        assert.equal(request.module, protocol.FormationModule.MAINLINE);
        this.current = request.formation;
        this.writes.push(normalizeFormation(request.formation, { allowEmpty: true }));
      }
      const replies = {
        GetFormationRequest: () => ({ formation: this.current }),
        SaveFormationRequest: () => ({ formation: this.current }),
        AllHeroRequest: () => ({ heroes: [{ heroId: 'a', level: 10, power: wireUid('123') }, { heroId: 'b', level: 5, power: wireUid('77') }] }),
        MyFormationPresetRequest: () => ({ ids: [7] }),
        AllPetRequest: () => ({ pets: [{ uid: wireUid(target.petUid), petId: 'pet-a', level: 12, star: 3 }] }),
      };
      assert(replies[name], '未声明的测试请求 ' + name);
      assert.equal(response, name.replace('Request', 'Response'));
      return decode(response, replies[name]());
    },
  };
  const editor = await readLineupEditor(client, config, { level: 30, mainlineStage: 10 });
  assert.deepEqual(editor.formation, original);
  assert.equal(editor.heroes[0].power, 123);
  assert.equal(editor.pets[0].uid, target.petUid);
  assert.deepEqual(validateEditorFormation(target, editor), target);
  assert.equal(client.writes.length, 0);

  const options = { accountId: 'protocol-role', role: { playerId: '9007199254740999', worldId: '31' }, formation: target };
  await withTemporaryLineup(client, options, async () => assert.deepEqual(normalizeFormation(client.current), target));
  assert.deepEqual(client.writes, [target, original]);
  assert.deepEqual(normalizeFormation(client.current), original);
  assert.equal(readLineupRuntime(options.accountId).pending, false);

  await assert.rejects(withTemporaryLineup(client, options, async () => { client.connected = false; }), error => error.lineupRestorePending);
  client.connected = true;
  await recoverLineup(client, options);
  assert.deepEqual(normalizeFormation(client.current), original);
  assert.equal(readLineupRuntime(options.accountId).pending, false);
  console.log('lineup protocol ok: real protobuf instances, default fields, int64 IDs, editor and runtime recovery');
} finally {
  assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(directory, { recursive: true, force: true });
}
