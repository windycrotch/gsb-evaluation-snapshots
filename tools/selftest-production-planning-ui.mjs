import { newStateFunction } from './fixtures/console-state.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const script = fs.readFileSync(new URL('../src/production-planning-ui.js', import.meta.url), 'utf8');
let passed = 0;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

function fixture() {
  const nodes = new Map();
  const env = { calls: [], errors: [], tables: [], current: 'account-a', snapshot: { connected: true, paused: false }, disconnected: new Set() };
  function element(tag = 'div', className = '', value = '') {
    let text = String(value ?? '');
    return {
      tagName: tag, className, disabled: false, children: [],
      get textContent() { return text + this.children.map(child => child.textContent).join(''); },
      set textContent(value) { text = String(value ?? ''); this.children = []; },
      appendChild(child) { this.children.push(child); return child; },
    };
  }
  env.node = id => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  env.element = element;
  env.clear = node => { node.textContent = ''; return node; };
  env.table = (headers, rows) => {
    env.tables.push({ headers, rows });
    return element('table', '', [headers, ...rows].flat().join(' '));
  };
  env.respond = async () => ({ statusLabel: '固定快照模型内最优', snapshotTime: 1767225600,
    completionAt: 1767225661, upperBound: 61, lowerBound: 60, scope: 'all-orders',
    orders: [{ id: 'resident:1', label: '居民订单', requirements: [{ id: 'bread', name: '面包', num: 2 }], completionAt: 1767225661, statusLabel: '联合方案已齐套' }],
    timeline: [{ machineId: 'factory:1', machineName: '食品厂', itemId: 'bread', productName: '面包', quantity: 2,
      startAt: 1767225600, finishAt: 1767225661, timingLabel: '会话实测' }],
    notes: ['共同材料只分配一次'], missingReads: [], assumptions: ['共同材料只分配一次'],
  });
  env.call = async route => { env.calls.push(route); return env.respond(route); };
  newStateFunction('env', `
    'use strict';
    const $ = env.node, el = env.element, clear = env.clear, table = env.table;
    const call = env.call, reportError = error => env.errors.push(error), disconnected = env.disconnected;
    let current = env.current, snapshot = env.snapshot;
    ${script}
    env.reset = resetProductionPlan;
    env.time = productionPlanTime;
    env.duration = productionPlanDuration;
    env.render = renderProductionPlan;
    env.changeAccount = account => {
      current = account;
      resetProductionPlan();
      $('production-plan-refresh').disabled = !snapshot.connected || snapshot.paused || disconnected.has(current);
    };
    env.setCurrent = account => { current = account; };
  `)(env);
  env.click = () => env.node('production-plan-refresh').disabled ? undefined : env.node('production-plan-refresh').onclick();
  return env;
}

async function test(name, work) {
  await work();
  passed++;
  console.log('通过：' + name);
}

await test('按钮触发真实读取脚本，展示北京时间、逐单完成与生产顺序', async () => {
  const env = fixture();
  await env.click();
  assert.deepEqual(env.calls, ['/api/world/production-plan']);
  assert.equal(env.node('production-plan-refresh').disabled, false);
  assert.equal(env.node('production-plan-status').textContent, '本次计算完成');
  const text = env.node('production-plan-result').textContent;
  assert.match(text, /全部订单预计齐套/);
  assert.match(text, /01\/01.*08:01:01/);
  assert.match(text, /北京时间/);
  assert.match(text, /用时 1分1秒/);
  assert.match(text, /工期下界 1分0秒/);
  assert.match(text, /面包 ×2/);
  assert.match(text, /会话实测/);
  assert.equal(text.split('共同材料只分配一次').length - 1, 1);
  assert.equal(env.tables.length, 2);
  assert.equal(env.errors.length, 0);
});

await test('断开、暂停、无账号和主动断开状态均不发送读取', async () => {
  for (const mode of ['disconnected', 'paused', 'no-account', 'explicit-disconnect']) {
    const env = fixture();
    if (mode === 'disconnected') env.snapshot.connected = false;
    if (mode === 'paused') env.snapshot.paused = true;
    if (mode === 'no-account') env.setCurrent(null);
    if (mode === 'explicit-disconnect') env.disconnected.add('account-a');
    await env.click();
    assert.deepEqual(env.calls, []);
  }
});

await test('等待期间按钮禁用，失败后恢复点击并显示错误状态', async () => {
  const env = fixture(), pending = deferred();
  env.respond = () => pending.promise;
  const running = env.click();
  assert.equal(env.node('production-plan-refresh').disabled, true);
  assert.match(env.node('production-plan-status').textContent, /计算中/);
  env.click();
  assert.equal(env.calls.length, 1);
  const error = new Error('测试读取失败');
  pending.reject(error);
  await running;
  assert.equal(env.node('production-plan-refresh').disabled, false);
  assert.equal(env.node('production-plan-status').textContent, '计算失败，可重新读取');
  assert.deepEqual(env.errors, [error]);
});

await test('省略可选字段时保留待确认状态，有限订单方案明确范围', () => {
  const env = fixture();
  env.render({ statusLabel: '数据尚不完整' });
  assert.match(env.node('production-plan-result').textContent, /数据尚不完整/);
  assert.match(env.node('production-plan-result').textContent, /状态快照 待确认/);
  assert.equal(env.time(null), '待确认');
  assert.equal(env.duration(undefined), '待确认');
  assert.equal(env.duration(3661), '1小时1分1秒');
  env.render({ statusLabel: '部分订单可行', scope: 'feasible-orders', snapshotTime: 1767225600,
    completionAt: 1767225661, upperBound: 61 });
  assert.match(env.node('production-plan-result').textContent, /可行订单预计齐套/);
});

await test('配置需求展示分层目标、优先级及上游继承，保留独立任务的并行时刻', () => {
  const env = fixture();
  const now = 1767225600;
  env.render({ statusLabel: '优先级模型内最优', objective: 'priority-makespan', scope: 'configured-demands',
    priorityPolicy: '按配置先保障建筑备料，再优化居民订单，独立设施可并行生产。',
    snapshotTime: now, completionAt: now + 20, lowerBound: 10, upperBound: 20,
    priorityBounds: [
      { priority: 0, label: '第1级 · 建筑备料', lowerBound: 5, upperBound: 5 },
      { priority: 1, label: '第2级 · 居民订单', lowerBound: 10, upperBound: 20 },
    ],
    orders: [{ id: 'building:1', label: '材料厂升级备料', priorityLabel: '第1级',
      requirements: [{ id: '板材', num: 1 }], completionAt: now + 5, statusLabel: '已齐套' }],
    timeline: [
      { machineId: '1材料厂', itemId: '木板', quantity: 1, priorityLabel: '第1级 · 建筑备料', inheritedPriority: true,
        inputs: [{ itemId: '木头', quantity: 2 }], startAt: now, finishAt: now + 5, timingLabel: '会话实测' },
      { machineId: '1食品厂', itemId: '面包', quantity: 1, priorityLabel: '第2级 · 居民订单', inheritedPriority: false,
        inputs: [{ itemId: '小麦', quantity: 1 }], startAt: now, finishAt: now + 20, timingLabel: '配置耗时估算' },
    ],
  });
  const text = env.node('production-plan-result').textContent;
  assert.match(text, /全部需求预计齐套/);
  assert.match(text, /按配置先保障建筑备料，再优化居民订单/);
  assert.match(text, /总工期下界 10秒/);
  assert.match(text, /后续级别的最优时间以更高级别已达到最优为条件/);
  assert.equal(env.tables.length, 3);
  assert.deepEqual(env.tables[0], { headers: ['优先级', '优先级约束下界', '方案用时'], rows: [
    ['第1级 · 建筑备料', '5秒', '5秒'], ['第2级 · 居民订单', '10秒', '20秒'],
  ] });
  assert.equal(env.tables[1].rows[0][1], '第1级');
  assert.equal(env.tables[2].rows[0][2], '第1级 · 建筑备料 · 上游继承');
  assert.equal(env.tables[2].rows[1][2], '第2级 · 居民订单');
  assert.equal(env.tables[2].rows[0][4], env.tables[2].rows[1][4]);
  assert.match(env.tables[2].rows[0][3], /木头 ×2/);
});

await test('跳过的需求展示原因，齐套范围只包含参与排产的需求', () => {
  const env = fixture();
  const now = 1767225600;
  env.render({ statusLabel: '模型内最优', scope: 'feasible-demands', snapshotTime: now,
    completionAt: now + 60, upperBound: 60,
    orders: [
      { id: 'merchant:1', label: '不差钱商人', skipped: true, completionAt: null,
        requirements: [{ id: '电路板', num: 1 }], statusLabel: '已跳过排产', reason: '已跳过排产，电路板 · 工厂等级不足' },
      { id: 'building:1', label: '建筑备料', skipped: false, completionAt: now + 60,
        requirements: [{ id: '面包', num: 1 }], statusLabel: '联合方案已齐套' },
    ],
  });
  const text = env.node('production-plan-result').textContent;
  assert.match(text, /参与排产的需求预计齐套/);
  assert.match(text, /需求齐套时间/);
  assert.equal(env.tables[0].rows[0][3], '已跳过排产');
  assert.match(env.tables[0].rows[0][4], /电路板.*工厂等级不足/);
  assert.doesNotMatch(text, /全部需求预计齐套/);
});

await test('分层未验证状态保留未知上下界，并识别已排队和腾仓辅助任务', () => {
  const env = fixture();
  env.render({ statusLabel: '最优性尚待证明', objective: 'priority-makespan', snapshotTime: 1767225600,
    priorityBounds: [{ priority: 0, lowerBound: 0, upperBound: null }],
    timeline: [
      { kind: 'existing', machineId: '工厂', itemId: '木板', quantity: 1 },
      { machineId: '工厂', itemId: '箱子', quantity: 1, priorityLabel: '腾仓辅助' },
    ],
  });
  const text = env.node('production-plan-result').textContent;
  assert.match(text, /先优化最高优先级需求的齐套时间，再依次优化后续优先级/);
  assert.deepEqual(env.tables[0].rows[0], ['第1级', '0秒', '待确认']);
  assert.equal(env.tables[1].rows[0][2], '已排队');
  assert.equal(env.tables[1].rows[0][3], '已投料');
  assert.equal(env.tables[1].rows[1][2], '腾仓辅助');
  assert.doesNotMatch(text, /全部订单预计齐套/);
});

await test('切换账号清理结果，旧请求成功或失败均不会覆盖新账号', async () => {
  for (const outcome of ['success', 'error']) {
    const env = fixture(), pending = deferred();
    env.respond = () => pending.promise;
    env.node('production-plan-result').textContent = '旧账号方案';
    const running = env.click();
    env.changeAccount('account-b');
    assert.equal(env.node('production-plan-result').textContent, '');
    if (outcome === 'success') pending.resolve({ statusLabel: '过期方案' });
    else pending.reject(new Error('旧账号错误'));
    await running;
    assert.equal(env.node('production-plan-result').textContent, '');
    assert.equal(env.node('production-plan-status').textContent, '连接后可计算');
    assert.equal(env.node('production-plan-refresh').disabled, false);
    assert.deepEqual(env.errors, []);
  }
});

await test('读取期间暂停、网络或主动断开后丢弃旧结果', async () => {
  for (const mode of ['paused', 'explicit-disconnect', 'network-disconnect']) {
    const env = fixture(), pending = deferred();
    env.respond = () => pending.promise;
    const running = env.click();
    if (mode === 'paused') env.snapshot.paused = true;
    else if (mode === 'explicit-disconnect') env.disconnected.add('account-a');
    else env.snapshot.connected = false;
    pending.resolve({ statusLabel: '旧连接方案' });
    await running;
    assert.equal(env.node('production-plan-result').textContent, '');
    assert.equal(env.node('production-plan-refresh').disabled, true);
  }
});

console.log('排产界面测试通过 ' + passed + ' 项');
