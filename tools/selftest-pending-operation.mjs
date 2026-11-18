import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPendingOperation } from '../src/pending-operation.mjs';
import { createDeclaredProtocol } from './fixtures/declared-protocol.mjs';
import { guildMutualFixture } from './fixtures/guild-mutual.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-pending-operation-'));
const previousDataDir = process.env.CW_DATA_DIR;
process.env.CW_DATA_DIR = directory;
const { createUsageLedger } = await import('../src/automation-settings.mjs');
const { runGuildMutual } = await import('../src/guild-mutual.mjs');
const protocol = createDeclaredProtocol([
  'GuildInfoRequest', 'GuildInfoResponse', 'GuildMemberRequest', 'GuildMemberResponse',
  'GuildAidListRequest', 'GuildAidListResponse', 'AllItemRequest', 'AllItemResponse',
  'MyGuildAidRequest', 'MyGuildAidResponse', 'CounterInfoRequest', 'CounterInfoResponse',
  'GuildAidHelpRequest', 'GotRewardResponse', 'GuildAidAskRequest', 'GotMyGuildAidRequest',
]);
let passed = 0, serial = 0;
const fixture = shared => guildMutualFixture(shared, { protocol });
const ledger = (file = path.join(directory, 'ledger-' + ++serial + '.json')) => createUsageLedger('offline', { file });
const run = (f, usage, options, extra = {}) => runGuildMutual({
  ...f, ledger: usage, enabled: () => f.client.connected, schedule: work => work(),
}, options, { wait: async () => {}, ...extra });
async function test(name, work) {
  await work();
  passed++;
  console.log('通过：' + name);
}
const readyClaim = f => {
  f.state.own = [{ reqId: '9007199254799901', reqItemId: '木材',
    endTime: Math.floor(Date.now() / 1000) + 100, helper: { playerId: f.friend, nickname: '测试盟友' } }];
};

try {
  await test('同一操作仅发送一次，重复确认与迟到错误不重复结算', async () => {
    const usage = ledger(), client = new EventEmitter(), events = [];
    client.on('diagnostic', event => events.push(event));
    const operation = createPendingOperation(usage, { client, module: 'fixture', request: 'WriteRequest' });
    const ticket = operation.reserve({ gifts: 1 }, { gifts: 1 }, {}, { uniqueKey: 'write:1' });
    let writes = 0;
    await operation.send(async () => { writes++; client.emit('sent', { dir: 'out', name: 'WriteRequest', seq: 1 }); });
    operation.confirm();
    operation.confirm();
    assert.deepEqual(operation.fail(new Error('迟到的重复回包错误')), { rejected: false, pending: false });
    await assert.rejects(operation.send(async () => writes++), /不能重复发送/);
    assert.equal(writes, 1);
    assert.equal(usage.snapshot().counters.gifts, 1);
    assert.equal(usage.snapshot().uncertain, 0);
    assert.equal(usage.keyRecords()['write:1'].confirmed, true);
    assert.deepEqual(events.map(event => event.phase), ['reserved', 'sent', 'confirmed']);
    assert(events.every(event => event.operationId === ticket.id && event.dedupeKey === 'write:1'));
    assert.equal(client.listenerCount('sent'), 0);
  });

  await test('发送前断线释放预留，发送后回读未发送保留预留', async () => {
    for (const sent of [false, true]) {
      const usage = ledger();
      const operation = createPendingOperation(usage, { request: 'WriteRequest' });
      operation.reserve({ gifts: 1 }, {}, {}, { uniqueKey: 'write:1' });
      const error = Object.assign(new Error('断线'), { notSent: true });
      if (sent) await operation.send(async () => {});
      else await assert.rejects(operation.send(async () => { throw error; }));
      assert.equal(operation.fail(error).pending, sent);
      assert.equal(usage.snapshot().counters.gifts, sent ? 1 : 0);
      assert.equal(usage.hasKey('write:1'), sent);
    }
  });

  await test('只有对应写请求的明确拒绝释放占用', async () => {
    for (const request of ['WriteRequest', 'ReadRequest']) {
      const usage = ledger();
      const operation = createPendingOperation(usage, { request: 'WriteRequest' });
      operation.reserve({ gifts: 1 }, {}, {}, { uniqueKey: 'write:1' });
      const result = operation.fail(Object.assign(new Error('服务端拒绝'), { prompt: { prompt: 1 }, request }));
      assert.equal(result.pending, request === 'ReadRequest');
      assert.equal(usage.snapshot().uncertain, request === 'ReadRequest' ? 1 : 0);
    }
  });

  await test('赠送丢回包跨客户端与账本重建保持未知且不重发', async () => {
    const file = path.join(directory, 'gift-unknown.json');
    const f = fixture();
    f.state.failure = 'giftUnknown';
    assert.equal((await run(f, ledger(file), { target: 2 })).pending, true);
    f.state.failure = '';
    const recovered = fixture(f.state), usage = ledger(file);
    assert.equal((await run(recovered, usage, { target: 2 })).pending, true);
    assert.equal(f.state.writes.filter(row => row.name === 'GuildAidHelpRequest').length, 1);
    assert.equal(usage.snapshot().counters.guildAidGifts, 1);
    assert.equal(usage.snapshot().uncertain, 1);
    assert.equal(f.client.listenerCount('sent'), 0);
  });

  await test('赠送已回执后回读断线，恢复凭原证据结算且不重复赠送', async () => {
    const file = path.join(directory, 'gift-read.json'), f = fixture();
    f.state.onRead = name => {
      if (name === 'AllItemRequest' && f.state.writes.length) {
        throw Object.assign(new Error('回读未发送'), { notSent: true, request: name });
      }
    };
    assert.equal((await run(f, ledger(file), { target: 1 })).pending, true);
    assert.equal(ledger(file).snapshot().uncertain, 1);
    f.state.onRead = null;
    const usage = ledger(file);
    assert.equal((await run(fixture(f.state), usage, { target: 1 })).pending, undefined);
    assert.equal(usage.snapshot().uncertain, 0);
    assert.equal(f.state.writes.filter(row => row.name === 'GuildAidHelpRequest').length, 1);
  });

  await test('发布求助丢回包后凭计数和新请求核销', async () => {
    const f = fixture(), usage = ledger();
    const options = { target: 0, askEnabled: true, askItemId: '橡胶圈', askTarget: 1 };
    f.state.failure = 'askAcceptedUnknown';
    assert.equal((await run(f, usage, options)).pending, true);
    f.state.failure = '';
    await run(fixture(f.state), usage, options);
    assert.equal(usage.snapshot().uncertain, 0);
    assert.equal(f.state.writes.filter(row => row.name === 'GuildAidAskRequest').length, 1);
  });

  await test('发布请求明确未发送释放防重，回读未发送继续保留防重', async () => {
    for (const stage of ['write', 'read']) {
      const f = fixture(), usage = ledger(), original = f.client.sendWatch;
      let blocked = true;
      f.client.sendWatch = async (name, ...args) => {
        if (stage === 'write' && blocked) throw Object.assign(new Error('未发送发布'), { notSent: true });
        return original(name, ...args);
      };
      f.state.onRead = name => {
        if (stage === 'read' && blocked && f.state.writes.length) throw Object.assign(new Error('未发送回读'), { notSent: true, request: name });
      };
      const options = { target: 0, askEnabled: true, askItemId: '橡胶圈', askTarget: 1 };
      assert.equal((await run(f, usage, options)).pending, stage === 'read');
      assert.equal(usage.snapshot().uncertain, stage === 'read' ? 1 : 0);
      blocked = false;
      await run(f, usage, options);
      assert.equal(usage.snapshot().uncertain, 0);
      assert.equal(f.state.writes.filter(row => row.name === 'GuildAidAskRequest').length, 1);
    }
  });

  await test('领取明确未发送可重试，领取后的回读失败保留记录', async () => {
    for (const stage of ['write', 'read']) {
      const f = fixture(), usage = ledger(), original = f.client.sendWatch;
      readyClaim(f);
      let blocked = true;
      f.client.sendWatch = async (name, ...args) => {
        if (stage === 'write' && blocked) throw Object.assign(new Error('未发送领取'), { notSent: true });
        return original(name, ...args);
      };
      f.state.onRead = name => {
        if (stage === 'read' && blocked && name === 'MyGuildAidRequest' && f.state.writes.length) {
          throw Object.assign(new Error('未发送回读'), { notSent: true, request: name });
        }
      };
      assert.equal((await run(f, usage, { target: 0 })).pending, stage === 'read');
      assert.equal(usage.snapshot().uncertain, stage === 'read' ? 1 : 0);
      blocked = false;
      await run(f, usage, { target: 0 });
      assert.equal(usage.snapshot().uncertain, 0);
      assert.equal(f.state.writes.filter(row => row.name === 'GotMyGuildAidRequest').length, 1);
    }
  });

  await test('领取丢回包时停止后续赠送，重建客户端仍保持防重', async () => {
    const f = fixture(), usage = ledger();
    readyClaim(f);
    f.state.failure = 'claimUnknown';
    assert.equal((await run(f, usage, { target: 1 })).pending, true);
    assert.equal((await run(fixture(f.state), usage, { target: 1 })).pending, true);
    assert.deepEqual(f.state.writes.map(row => row.name), ['GotMyGuildAidRequest']);
    assert.equal(usage.snapshot().uncertain, 1);
  });

  await test('重复奖励回包和重复启动不增加赠送次数', async () => {
    const f = fixture(), usage = ledger(), request = f.client.request;
    f.client.request = async (name, ...args) => {
      const reply = await request(name, ...args);
      if (name === 'GuildAidHelpRequest') {
        for (let i = 0; i < 2; i++) f.client.emit('message', { name: 'GotRewardResponse', seq: 42, body: reply });
      }
      return reply;
    };
    assert.equal((await run(f, usage, { target: 1 })).sent, 1);
    assert.equal((await run(f, usage, { target: 1 })).sent, 0);
    assert.equal(f.state.writes.filter(row => row.name === 'GuildAidHelpRequest').length, 1);
    assert.equal(usage.snapshot().counters.guildAidGifts, 1);
    assert.equal(usage.snapshot().uncertain, 0);
  });

  await test('预留后暂停取消尚未发出的赠送', async () => {
    const f = fixture(), usage = ledger(), reserve = usage.reserve;
    usage.reserve = (...args) => {
      const ticket = reserve(...args);
      f.client.connected = false;
      return ticket;
    };
    const result = await run(f, usage, { target: 1 });
    assert.equal(result.sent, 0);
    assert.equal(f.state.writes.length, 0);
    assert.equal(usage.snapshot().uncertain, 0);
    assert.equal(usage.snapshot().counters.guildAidGifts, 0);
  });
  console.log('待确认操作离线专项 ' + passed + '/' + passed + ' 通过');
} finally {
  if (previousDataDir === undefined) delete process.env.CW_DATA_DIR;
  else process.env.CW_DATA_DIR = previousDataDir;
  fs.rmSync(directory, { recursive: true, force: true });
}
