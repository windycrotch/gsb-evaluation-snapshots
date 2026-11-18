import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { runStages, createStageTask } from '../src/stages.mjs';
import { challengeTrial, runTrialStages, createTrialTask } from '../src/trials.mjs';
import { createChallengeRun, runChallengeRound } from '../src/challenge-automation.mjs';
import { runLoop } from '../src/loop.mjs';
import { serviceStageAuto } from '../src/progress-automation.mjs';
import { defaultSettings, createUsageLedger } from '../src/automation-settings.mjs';

let passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
const pending = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture() {
  const client = new EventEmitter();
  client.connected = true;
  const player = { playerId: 'lineup-test', level: 30, mainlineStage: 1, worldId: 1001001, scenarioId: 1 };
  const config = { tables: {
    StageCfg: { data: [1, 2, 3].map(stage => ({ stage, playerLevel: 1 })) },
    TrialRaidCfg: { data: [{ raidId: 1, title: '模拟试炼' }] },
    TrialRaidStageCfg: { data: [1, 2, 3].map(stageLevel => ({ raidId: 1, stageId: 100 + stageLevel, stageLevel, openLevel: 1 })) },
  } };
  const settings = defaultSettings();
  settings.loop.world = settings.loop.dailies = settings.loop.tasks = settings.loop.heroes = false;
  settings.dailies.enabled = false;
  settings.progression.enabled = settings.progression.mainline = settings.progression.trials = true;
  settings.progression.raidIds = ['1'];
  const f = {
    client, player, config, settings, events: [], contexts: [], confirmed: [], writes: [],
    queued: false, enabled: true, won: true, passedStage: 0, state: createChallengeRun(),
  };
  let tail = Promise.resolve();
  f.schedule = work => {
    const job = tail.then(async () => {
      assert.equal(f.queued, false, '同账号队列不能嵌套');
      f.queued = true;
      f.events.push('queue');
      try { return await work(); }
      finally { f.events.push('release'); f.queued = false; }
    });
    tail = job.catch(() => {});
    return job;
  };
  client.request = async (name, body) => {
    assert(f.queued, '协议必须在账号队列中执行');
    if (name === 'TrialRaidInfoRequest') {
      f.events.push('read');
      return { raid: { raidId: body.raidId, passedStage: f.passedStage } };
    }
    assert(['ChallengeStageRequest', 'TrialRaidChallengeRequest'].includes(name), name);
    const mode = name === 'ChallengeStageRequest' ? 'mainline' : 'trial';
    f.events.push('battle:' + mode);
    f.writes.push({ name, body });
    await f.beforeReply?.(mode);
    if (f.requestError) throw f.requestError;
    if (f.badReply) return {};
    if (mode === 'mainline') return { initialData: { mainlineStage: body.stage }, stats: { isLeftWin: f.won } };
    if (f.won) f.passedStage = body.stageId;
    return { raidId: body.raidId, stageId: body.stageId };
  };
  f.executeBattle = async (work, context) => {
    assert(f.queued, '切阵及还原必须在同一个账号队列中执行');
    f.contexts.push(context);
    f.events.push('apply:' + context.mode);
    context.onLineupPhase?.({ phase: 'switching' });
    try {
      await f.afterApply?.(context);
      context.onLineupPhase?.({ phase: 'battling' });
      return await work();
    } finally {
      f.events.push('restore:' + context.mode);
      context.onLineupPhase?.({ phase: 'restoring' });
      try { await f.restore?.(context); }
      catch (error) {
        context.onLineupPhase?.({ phase: 'pending' });
        throw error;
      }
      context.onLineupPhase?.({ phase: 'idle' });
    }
  };
  f.options = {
    executeBattle: f.executeBattle, schedule: f.schedule, wait: async () => {},
    enabled: () => f.enabled, beforeBattle: () => f.events.push('before'),
  };
  f.run = (mode, extra = {}) => {
    const options = { ...f.options, ...extra, onBattle: info => {
      f.events.push('confirmed');
      f.confirmed.push(info);
      extra.onBattle?.(info);
    } };
    if (mode === 'mainline') return runStages(client, player, config, { allowMutate: true, maxWins: 1, ...options });
    if (mode === 'trial') return runTrialStages(client, player, config, 1, { maxWins: 1, ...options });
    return challengeTrial(client, config, player.level, 1, 101, options);
  };
  f.round = (extra = {}) => f.schedule(() => runChallengeRound(client, config, {
    player, getSettings: () => settings, state: f.state, wait: async () => {},
    executeBattle: f.executeBattle, ...extra,
  }));
  return f;
}

async function finishTask(task) {
  for (let attempt = 0; attempt < 1000 && task.view().running; attempt++) await nextTurn();
  assert.equal(task.view().running, false, '任务应在收尾完成后退出');
}

function startTask(f, mode, onError) {
  const task = mode === 'mainline' ? createStageTask() : createTrialTask(1);
  task.start({ maxFailures: 1 }, async () => ({ client: f.client, player: f.player, config: f.config, ...f.options }), onError);
  return task;
}

await test('单次和连续主线/试炼在同一队列中依次切阵、确认战果、还原', async () => {
  for (const mode of ['mainline', 'trial', 'single']) {
    const f = fixture();
    await f.run(mode);
    const target = mode === 'mainline' ? 'mainline' : 'trial';
    assert.deepEqual(f.events.filter(event => event !== 'read'), [
      'queue', 'apply:' + target, 'before', 'battle:' + target, 'confirmed', 'restore:' + target, 'release',
    ]);
    assert.equal(f.contexts[0].mode, target);
    assert.equal(f.contexts[0].stage, mode === 'mainline' ? 1 : 101);
    assert.equal(f.contexts[0].raidId, mode === 'mainline' ? undefined : 1);
    assert.equal(f.contexts[0].enabled(), true);
    if (target === 'trial') assert(f.events.lastIndexOf('read') < f.events.indexOf('restore:trial'));
  }
});

await test('连续任务每场完成还原后释放队列，再排下一场', async () => {
  for (const mode of ['mainline', 'trial']) {
    const f = fixture();
    await f.run(mode, { maxWins: 2 });
    assert.equal(f.writes.length, 2);
    assert.equal(f.events.filter(event => event === 'restore:' + mode).length, 2);
    const firstRelease = f.events.indexOf('release');
    assert.equal(f.events[firstRelease + 1], 'queue');
    assert.equal(f.events.slice(0, firstRelease).filter(event => event.startsWith('battle:')).length, 1);
  }
});

await test('挑战条件不满足时直接结束，不创建临时阵容事务', async () => {
  const mainline = fixture();
  mainline.config.tables.StageCfg.data[0].playerLevel = 100;
  assert.match((await mainline.run('mainline')).reason, /等级/);
  assert.equal(mainline.contexts.length, 0);
  for (const mode of ['trial', 'single']) {
    const f = fixture();
    f.config.tables.TrialRaidStageCfg.data[0].openLevel = 100;
    if (mode === 'single') await assert.rejects(f.run(mode), /级/);
    else assert.match((await f.run(mode)).reason, /级/);
    assert.equal(f.contexts.length, 0);
  }
});

await test('战报不完整时在还原后抛错，保留未知结果且不计战败', async () => {
  for (const mode of ['mainline', 'trial', 'single']) {
    const f = fixture();
    f.badReply = true;
    await assert.rejects(f.run(mode), /战报|回包/);
    assert.equal(f.confirmed.length, 0);
    assert.equal(f.events.at(-2), 'restore:' + (mode === 'mainline' ? 'mainline' : 'trial'));
    assert.equal(f.events.at(-1), 'release');
  }
});

await test('切阵后停止或开关关闭，不发出挑战且仍执行还原', async () => {
  for (const mode of ['mainline', 'trial', 'single']) {
    for (const stopping of ['abort', 'disabled']) {
      const f = fixture(), controller = new AbortController();
      f.afterApply = () => {
        if (stopping === 'abort') controller.abort(new Error('手动停止'));
        else f.enabled = false;
      };
      await assert.rejects(f.run(mode, { signal: controller.signal }), error => error.notSent === true);
      assert.equal(f.writes.length, 0);
      assert(f.events.some(event => event.startsWith('restore:')));
    }
  }
});

await test('beforeBattle返回后再次检查停止状态，已暂停操作保持未发送标记', async () => {
  for (const mode of ['mainline', 'trial', 'single']) {
    const f = fixture();
    await assert.rejects(f.run(mode, { beforeBattle: () => { f.enabled = false; } }), error => error.notSent === true);
    assert.equal(f.writes.length, 0);
    assert.equal(f.confirmed.length, 0);
  }
});

await test('共享五秒限频从切阵后的真正挑战发送时计时', async () => {
  const f = fixture(), originalNow = Date.now;
  let now = 1000;
  const waits = [];
  Date.now = () => now;
  try {
    f.afterApply = () => { now += 7000; };
    await f.run('mainline');
    f.afterApply = null;
    await f.run('trial', { wait: async milliseconds => { waits.push(milliseconds); now += milliseconds; } });
    assert.deepEqual(waits, [5000]);
  } finally { Date.now = originalNow; }
});

await test('已确认战果在恢复失败时保留，主线与试炼不会再次发送', async () => {
  for (const mode of ['mainline', 'trial']) {
    const f = fixture();
    f.settings.progression.mainline = mode === 'mainline';
    f.settings.progression.trials = mode === 'trial';
    f.restore = () => { throw Object.assign(new Error('模拟恢复失败'), { lineupRestorePending: true }); };
    await f.round();
    const progress = mode === 'mainline' ? f.state.mainline : f.state.trials[1];
    assert.equal(progress.wins, 1);
    assert.equal(progress.failures, 0);
    assert.equal(progress.lineupRestorePending, true);
    assert.equal(progress.lineupPhase, 'pending');
    assert.equal(progress.halted, true);
    assert.doesNotMatch(progress.reason, /结果未确认/);
    if (mode === 'mainline') assert.equal(f.player.mainlineStage, 2);
    await f.round();
    assert.equal(f.writes.length, 1);
  }
});

await test('切阵失败不会记录战败或未知挑战，后续轮次可重查', async () => {
  const f = fixture();
  const executeBattle = async () => { throw new Error('预设英雄无效'); };
  await f.round({ executeBattle });
  for (const progress of [f.state.mainline, f.state.trials[1]]) {
    assert.equal(progress.failures ?? 0, 0);
    assert.equal(progress.halted ?? false, false);
    assert.doesNotMatch(progress.reason, /结果未确认/);
  }
  assert.equal(f.writes.length, 0);
  await f.round();
  assert.equal(f.writes.length, 2);
});

await test('手动停止保持运行状态到还原结束，已确认战败仍保留', async () => {
  for (const mode of ['mainline', 'trial']) {
    const f = fixture(), restoring = pending(), release = pending();
    f.won = false;
    f.restore = async () => { restoring.resolve(); await release.promise; };
    const task = startTask(f, mode);
    await restoring.promise;
    assert.equal(task.view().lineupPhase, 'restoring');
    assert.equal(task.view().failures, 1);
    task.stop('测试停止');
    assert.equal(task.view().running, true);
    assert.equal(task.view().stopping, true);
    release.resolve();
    await finishTask(task);
    assert.equal(task.view().lineupPhase, 'idle');
    assert.equal(task.view().lineupRestorePending, false);
    assert.equal(task.view().reason, '测试停止');
  }
});

await test('停止期间恢复失败保留恢复原因及待恢复标记', async () => {
  for (const mode of ['mainline', 'trial']) {
    const f = fixture(), restoring = pending(), release = pending();
    f.won = false;
    f.restore = async () => {
      restoring.resolve();
      await release.promise;
      throw Object.assign(new Error('需要恢复原阵容'), { lineupRestorePending: true });
    };
    const task = startTask(f, mode);
    await restoring.promise;
    task.stop('测试停止');
    release.resolve();
    await finishTask(task);
    assert.equal(task.view().reason, '需要恢复原阵容');
    assert.equal(task.view().lineupRestorePending, true);
    assert.equal(task.view().lineupPhase, 'pending');
    assert.equal(task.view().failures, 1);
  }
});

await test('停止错误同时携带恢复失败时，任务和挂机展示具体恢复原因', async () => {
  const restoreFailure = () => Object.assign(new Error('已手动停止'), {
    lineupRestorePending: true,
    lineupRecovery: { phase: 'pending', transactionId: 'simulated', reason: '恢复原阵容请求超时' },
  });
  for (const mode of ['mainline', 'trial']) {
    const f = fixture();
    f.options.executeBattle = async (_work, context) => {
      context.onLineupPhase?.({ phase: 'pending' });
      throw restoreFailure();
    };
    const task = startTask(f, mode);
    await finishTask(task);
    assert.equal(task.view().reason, '恢复原阵容请求超时');
    assert.equal(task.view().lineupRestorePending, true);
  }
  const f = fixture();
  await f.round({ executeBattle: async () => { throw restoreFailure(); } });
  for (const progress of [f.state.mainline, f.state.trials[1]]) {
    assert.match(progress.reason, /恢复原阵容请求超时/);
    assert.doesNotMatch(progress.reason, /已手动停止/);
  }
});

await test('战斗已发送时停止仍确认战果并恢复，随后结束任务', async () => {
  for (const mode of ['mainline', 'trial']) {
    const f = fixture(), sent = pending(), response = pending();
    f.beforeReply = async () => { sent.resolve(); await response.promise; };
    const task = startTask(f, mode);
    await sent.promise;
    task.stop();
    assert.equal(task.view().running, true);
    response.resolve();
    await finishTask(task);
    assert.equal(task.view().wins, 1);
    assert.equal(task.view().lineupPhase, 'idle');
    assert.equal(f.writes.length, 1);
    assert.equal(f.events.at(-2), 'restore:' + mode);
  }
});

await test('同账号其他挑战等待上场恢复结束后才进入队列', async () => {
  const f = fixture(), restoring = pending(), release = pending();
  f.restore = async context => {
    if (context.mode === 'mainline') { restoring.resolve(); await release.promise; }
  };
  const mainline = f.run('mainline');
  await restoring.promise;
  const trial = f.run('trial');
  await nextTurn();
  assert.equal(f.writes.length, 1);
  release.resolve();
  await Promise.all([mainline, trial]);
  assert.deepEqual(f.contexts.map(context => context.mode), ['mainline', 'trial']);
  assert(f.events.indexOf('release') < f.events.indexOf('apply:trial'));
});

await test('整轮挂机把执行器传给主线和试炼，复用已持有的账号队列', async () => {
  const f = fixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lineup-challenges-'));
  try {
    await runLoop(f.client, {}, {
      config: f.config, player: f.player, getSettings: () => f.settings,
      rounds: 1, everyMs: 0, sleep: async () => {}, allowMutate: true,
      isEnabled: () => false, challengeRun: f.state,
      schedule: f.schedule, executeBattle: f.executeBattle,
      usageLedger: createUsageLedger('simulated', { file: path.join(directory, 'usage.json') }),
    });
    assert.deepEqual(f.contexts.map(context => context.mode), ['mainline', 'trial']);
    assert.equal(f.events.filter(event => event === 'queue').length, 1);
    assert.equal(f.events.filter(event => event === 'release').length, 1);
    assert.equal(f.writes.length, 2);
  } finally {
    assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

await test('旧CLI主线自动推关入口与整轮旧配置同样使用阵容执行器', async () => {
  const direct = fixture();
  direct.won = false;
  await direct.schedule(() => serviceStageAuto(direct.client, direct.config, {
    player: direct.player, enabled: () => true, wait: async () => {}, executeBattle: direct.executeBattle,
  }));
  assert.equal(direct.contexts.length, 1);
  assert.equal(direct.contexts[0].mode, 'mainline');
  assert.equal(direct.events.at(-2), 'restore:mainline');

  const legacy = fixture();
  legacy.won = false;
  delete legacy.settings.progression;
  legacy.settings.schedule.stageAuto = true;
  await runLoop(legacy.client, {}, {
    config: legacy.config, player: legacy.player, getSettings: () => legacy.settings,
    rounds: 1, everyMs: 0, sleep: async () => {}, allowMutate: true,
    isEnabled: key => key === 'stageAuto', schedule: legacy.schedule, executeBattle: legacy.executeBattle,
  });
  assert.equal(legacy.contexts.length, 1);
  assert.equal(legacy.contexts[0].mode, 'mainline');
  assert.equal(legacy.events.filter(event => event === 'queue').length, 1);
  assert.equal(legacy.events.at(-2), 'restore:mainline');
});

await test('CLI读取保存阵容并先恢复遗留记录，预览只读且保留原任务开关语义', async () => {
  const source = fs.readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const loopSource = source.match(/async function loopCli\([\s\S]*?\n}\n/)[0];
  const stagesStart = source.indexOf("  if (mode === 'stages') {");
  const stagesEnd = source.indexOf("  if (mode === 'dailies') {", stagesStart);
  const stagesSource = source.slice(stagesStart, stagesEnd);
  for (const mode of ['loop', 'stages', 'dry', 'stop']) {
    const calls = [], handlers = new Map();
    const player = { playerId: '1', worldId: 1, mainlineStage: 1, level: 30 };
    const settings = { lineups: { mainlinePresetId: 'saved', presets: [] } };
    const processStub = {
      argv: ['node', 'app.mjs', 'stages'], env: {},
      on(signal, handler) { handlers.set(signal, handler); },
      off(signal) { handlers.delete(signal); },
    };
    const context = {
      process: processStub, console: { log() {} }, AbortController,
      SPEED_UP_ITEM: '加速道具', loadProtocol: () => ({}), getConfig: () => ({}), loadConfigSafe: () => ({}),
      loadCredentials: () => ({ url: 'ws://fixture', login: {}, account: { id: 'cli-account' } }),
      createUsageLedger: accountId => { assert.equal(accountId, 'cli-account'); return {}; },
      loadAutomationSettings: accountId => { assert.equal(accountId, 'cli-account'); return { settings }; },
      readLineupRuntime: () => ({ pending: true }),
      lineupRole: value => { assert.equal(value, player); return { playerId: '1', worldId: '1' }; },
      recoverLineup: async () => { calls.push('recover'); },
      createLineupExecutor: (_client, options) => {
        assert.equal(options.accountId, 'cli-account');
        assert.equal(options.getPlayer(), player);
        assert.equal(options.getSettings(), settings);
        return async work => { calls.push('execute'); return work(); };
      },
      GameClient: class {
        connected = true;
        on() {}
        async connect() { return { playerInfo: player }; }
        stop() { calls.push('stop'); }
      },
      createResourceUpdater: () => ({ start: async () => {}, stop: async () => {} }),
      describeRole: () => ({ nickname: '模拟角色', level: 30 }),
      formatLoopRound: () => '', formatLoopStep: () => '',
      parseArgs: () => ({ values: { yes: mode !== 'dry', dry: mode === 'dry' } }),
      stageFailureLimit: value => value ?? 3,
      shutdownSignals: () => ['SIGINT', 'SIGTERM'],
      runLoop: async (_client, _protocol, options) => {
        assert.equal(options.getSettings, undefined, '保存配置不得改变CLI其他任务开关');
        assert.equal(options.isEnabled, undefined);
        calls.push('run');
        await options.executeBattle(async () => {}, { mode: 'mainline' });
      },
      runStages: async (_client, _player, _config, options) => {
        calls.push('run');
        if (mode === 'stop') {
          handlers.get('SIGINT')();
          assert.equal(options.signal.aborted, true);
          throw options.signal.reason;
        }
        if (options.allowMutate) await options.executeBattle(async () => {}, { mode: 'mainline' });
        return { wins: 0, reason: '模拟完成' };
      },
    };
    if (mode === 'loop') {
      const run = vm.runInNewContext('(' + loopSource + ')', context);
      await run({ allowMutate: true, rounds: 1, everySeconds: 0 });
    } else {
      const run = vm.runInNewContext('(async function() { const mode = "stages";\n' + stagesSource + '\n})', context);
      await run();
    }
    if (mode === 'dry') assert.deepEqual(calls, ['run', 'stop']);
    else if (mode === 'stop') {
      assert.deepEqual(calls, ['recover', 'run', 'stop']);
      assert.equal(processStub.exitCode, 130);
    } else assert.deepEqual(calls, ['recover', 'run', 'execute', 'stop']);
    assert.equal(handlers.size, 0, 'CLI退出时必须清理停止信号处理器');
  }
});

console.log(`阵容挑战执行器 ${passed}/${passed} 通过`);
