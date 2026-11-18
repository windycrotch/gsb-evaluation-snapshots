import assert from 'node:assert/strict';
import { appointments } from '../src/appointments.mjs';
import { APPOINTMENT_PRIORITIES, DEFAULT_APPOINTMENT_PRIORITIES, normalizeAppointmentPriorities } from '../src/appointment-priorities.mjs';

const gameEffects = ['生产时间', '建造速度', '贸易时间', '训练产量', '锻造时间', '种田时间', '宠物培育速度'];
const config = { tables: { AppointPosCfg: { data: gameEffects.flatMap((effectId, index) => [
  { posId: index * 3 + 1, effectId, playerLevel: 4 + index * 2 },
  { posId: index * 3 + 2, effectId, playerLevel: 8 + index * 2 },
  { posId: index * 3 + 3, effectId, playerLevel: 15 + index * 2 },
]) } } };

function fixture({ failure, onRead } = {}) {
  const calls = [];
  let reads = 0;
  let heroes = [{ posId: 1, heroId: '船员' }];
  return {
    calls,
    async request(name, body, response) {
      assert.equal(response, 'AppointInfoResponse');
      calls.push({ name, body: structuredClone(body) });
      if (name === 'AutoAppointRequest') {
        if (failure === 'assign') throw new Error('服务端拒绝委任');
        heroes = [{ posId: body.posId[0], heroId: '船长' }];
      } else {
        assert.equal(name, 'AppointInfoRequest');
        reads++;
        if (failure === 'readback' && reads === 2) throw new Error('委任状态读取超时');
        onRead?.();
      }
      return { heroes: structuredClone(heroes), priorPosIds: [4, 5, 6, 13, 14, 15] };
    },
  };
}

assert.deepEqual(APPOINTMENT_PRIORITIES.map(item => item.label), [
  '生产时间减少', '训练营产量提高', '贸易时间减少', '建造速度提高', '种田时间减少', '海兽培育速度提高', '锻造时间减少',
]);
for (const value of [undefined, null, {}, '生产时间', []]) {
  assert.deepEqual(normalizeAppointmentPriorities(value), DEFAULT_APPOINTMENT_PRIORITIES);
}
const older = ['锻造时间', '生产时间', '锻造时间', '未知效果'];
const normalized = normalizeAppointmentPriorities(older);
assert.deepEqual(normalized, ['锻造时间', '生产时间', '训练产量', '贸易时间', '建造速度', '种田时间', '宠物培育速度']);
assert.deepEqual(older, ['锻造时间', '生产时间', '锻造时间', '未知效果']);
normalized.reverse();
assert.equal(DEFAULT_APPOINTMENT_PRIORITIES[0], '生产时间');

{
  const client = fixture();
  const result = await appointments(client, config, 40, { assign: true, priorities: DEFAULT_APPOINTMENT_PRIORITIES });
  assert.deepEqual(client.calls.map(call => call.name), ['AppointInfoRequest', 'AutoAppointRequest', 'AppointInfoRequest']);
  assert.deepEqual(client.calls[1].body.posId, [1, 2, 3, 10, 11, 12, 7, 8, 9, 4, 5, 6, 16, 17, 18, 19, 20, 21, 13, 14, 15]);
  assert.equal(result.slots.length, 21);
  assert.equal(result.occupied, 1);
  assert.equal(result.changed, 1);
  assert.equal(result.slots[0].hero, '船长');
}

{
  const client = fixture();
  const result = await appointments(client, config, 40, { assign: true });
  assert.deepEqual(client.calls[1].body.posId.slice(0, 6), [4, 5, 6, 13, 14, 15]);
  assert.equal(result.changed, 2);
  assert.equal(result.slots[0].effect, '建造速度');
}

{
  const client = fixture();
  const priorities = ['锻造时间', '生产时间'];
  const result = await appointments(client, config, 4, { assign: true, priorities });
  assert.deepEqual(result.slots.map(slot => slot.id), [1]);
  assert.deepEqual(client.calls[1].body.posId.slice(0, 6), [13, 14, 15, 1, 2, 3]);
  assert.equal(client.calls[1].body.posId.length, 21, '游戏一键委任提交全部职位，由服务器核对开放等级');
  assert.deepEqual(priorities, ['锻造时间', '生产时间']);
}

{
  const client = fixture();
  const nextConfig = structuredClone(config);
  nextConfig.tables.AppointPosCfg.data.push({ posId: 22, effectId: '新增效果', playerLevel: 2 });
  await appointments(client, nextConfig, 40, { assign: true, priorities: ['贸易时间'] });
  assert.deepEqual(client.calls[1].body.posId.slice(0, 3), [7, 8, 9]);
  assert.equal(client.calls[1].body.posId.at(-1), 22);
}

{
  const client = fixture();
  const result = await appointments(client, config, 1, { assign: true, priorities: [] });
  assert.equal(result.slots.length, 0);
  assert.deepEqual(client.calls.map(call => call.name), ['AppointInfoRequest']);
}

{
  const client = fixture();
  const result = await appointments(client, config, 40, { priorities: ['贸易时间'] });
  assert.equal(result.slots[0].effect, '贸易时间');
  assert.equal(result.occupied, 1);
  assert.equal(result.changed, 0);
  assert.equal(client.calls.length, 1);
}

{
  let enabled = true;
  const client = fixture({ onRead: () => { enabled = false; } });
  const result = await appointments(client, config, 40, { assign: true, enabled: () => enabled });
  assert.equal(result.skipped, true);
  assert.equal(result.changed, 0);
  assert.equal(result.occupied, 1);
  assert.equal(client.calls.length, 1, '读状态期间关闭开关后不发送委任');
}

for (const failure of ['assign', 'readback']) {
  const client = fixture({ failure });
  await assert.rejects(appointments(client, config, 40, { assign: true }), /拒绝委任|读取超时/);
  assert.equal(client.calls.filter(call => call.name === 'AutoAppointRequest').length, 1);
}

{
  const client = fixture();
  await assert.rejects(appointments(client, config, 0, { assign: true }), /缺少角色等级/);
  assert.equal(client.calls.length, 0);
  await assert.rejects(appointments(client, {}, 40, { assign: true }), /缺少 AppointPosCfg/);
  assert.equal(client.calls.length, 1);
}

console.log('英雄委任优先级、旧配置补全、游戏分组顺序及发送门控验证通过');
