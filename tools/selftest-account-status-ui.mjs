import { newStateFunction } from './fixtures/console-state.mjs';
import assert from 'node:assert/strict';
import { PAGE } from '../src/page.mjs';

const pageScript = [...PAGE.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(script => script.includes('function connectionStatus('));
assert.ok(pageScript, '控制台应包含实际账号状态脚本');
const start = pageScript.indexOf('let snapshot =');
const end = pageScript.indexOf('// ---- 总览', start);
const pollingStart = pageScript.indexOf('setInterval(refreshOverview, 20000);');
assert.ok(start >= 0 && end > start && pollingStart > end);
const accountScript = pageScript.slice(start, end);
const pollingScript = pageScript.slice(pollingStart);
const overviewStart = pageScript.indexOf('let overviewPending =');
const overviewEnd = pageScript.indexOf('// ---- 挂机', overviewStart);
assert.ok(overviewStart > end && overviewEnd > overviewStart);
const overviewScript = pageScript.slice(overviewStart, overviewEnd);
const fixedNow = 1_794_830_400_000;
let passed = 0;

async function test(name, run) {
  await run();
  passed++;
  console.log('通过：' + name);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function settle() {
  for (let index = 0; index < 30; index++) await Promise.resolve();
}

function makeNode() {
  const listeners = new Map();
  const classes = new Set();
  let text = '';
  return {
    options: [], value: '', title: '', disabled: false, dataset: {}, writes: 0, replacements: 0, open: false,
    classList: {
      contains: name => classes.has(name),
      add: name => classes.add(name),
      remove: name => classes.delete(name),
    },
    showModal() { this.open = true; },
    close() { this.open = false; },
    get textContent() { return text; },
    set textContent(value) { text = String(value ?? ''); this.writes++; },
    replaceChildren(...children) { this.options = children; this.replacements++; },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    fire(type, event = {}) { return (listeners.get(type) || []).map(listener => listener(event)); },
  };
}

function fixture(rows = [
  { id: 'account-a', title: '甲角色 · 海港1服', status: { connected: false } },
  { id: 'account-b', title: '乙角色 · 海港2服', status: { connected: false } },
], selected = rows[0]?.id ?? null, { overview = false } = {}) {
  const nodes = new Map();
  const document = makeNode();
  document.hidden = false;
  const env = { now: fixedNow, calls: [], effects: [], errors: [], intervals: [], overviews: [], document, allowed: true };
  env.node = id => {
    if (!nodes.has(id)) nodes.set(id, makeNode());
    return nodes.get(id);
  };
  env.node('tab-account').classList.add('hidden');
  env.serverAccounts = structuredClone(rows);
  env.respond = async route => {
    if (route === '/api/accounts') return { accounts: structuredClone(env.serverAccounts), activeId: selected };
    return { ok: true };
  };
  env.call = async (route, options) => {
    const record = { route, owner: env.api.current(), payload: options?.body ? JSON.parse(options.body) : null };
    env.calls.push(record);
    return env.respond(route, record);
  };
  env.Option = function Option(text, value) {
    this.text = text;
    this.value = value;
  };
  newStateFunction('env', `
    'use strict';
    const $ = env.node, document = env.document, call = env.call, Option = env.Option;
    const Date = { now: () => env.now };
    const clear = node => { node.textContent = ''; return node; };
    const setInterval = (callback, delay) => { env.intervals.push({ callback, delay }); };
    const reportError = error => env.errors.push(error);
    const configMayChangeAccount = async () => env.allowed;
    const configFlush = async () => env.onFlush ? env.onFlush() : true;
    const saveLoopInterval = async () => env.onIntervalSave ? env.onIntervalSave() : true;
    const refreshProgression = () => env.effects.push('progression');
    const refreshSavedLineups = async () => {};
    const refreshManualWorld = () => env.effects.push('world');
    const refreshActivities = () => env.effects.push('activities');
    const refreshStages = () => env.effects.push('stages');
    const refreshLoop = () => { loopAccount = current; renderHostingControl(); env.effects.push('loop'); };
    const renderOverview = data => env.overviews.push(structuredClone(data));
    const maybeRefreshWorldMap = () => env.effects.push('world-map');
    ${overview ? overviewScript : "const refreshOverview = () => env.effects.push('overview');"}
    const subscribe = () => env.effects.push('subscribe');
    const configAccountChanged = () => env.effects.push('config');
    const giftAccountChanged = () => env.effects.push('gift');
    const loginSettingsAccountChanged = () => env.effects.push('login-settings');
    const appointmentsAccountChanged = () => {};
    const siliconAccountChanged = () => {}, maybeRefreshSilicon = () => {};
    const renderAccounts = () => env.effects.push('account-cards');
    const resetWorldMap = () => env.effects.push('clear-map');
    const resetProductionPlan = () => env.effects.push('clear-production');
    let accounts = [], current = null, dailyAccount = null, dailyVersion = 0;
    let worldMapOwner = null, productionPlanOwner = null;
    let productionPlanBusy = false, loopReads = 0, loopAccount = null, loopVersion = 0;
    ${accountScript}
    ${pollingScript}
    env.api = {
      connectionStatus, renderAccountOptions, paintConnection, setBusy,
      setAccountStatus, refreshAccountStatuses, loadAccounts, selectLoadedAccount, refreshOverview, renderHostingControl,
      current: () => current, rows: () => accounts, snapshot: () => snapshot,
      disconnected: { has: id => disconnected.has(id), add: id => stateActions.setFlag('disconnected', id, true), delete: id => stateActions.setFlag('disconnected', id, false) },
      connectingAccounts: { get size() { return connectingAccounts.size; }, has: id => connectingAccounts.has(id), add: id => stateActions.setFlag('connecting', id, true), delete: id => stateActions.setFlag('connecting', id, false) },
      loopReady(ready) { loopAccount = ready ? current : null; renderHostingControl(); },
      initialize(rows, selected) {
        stateActions.replaceAccounts(structuredClone(rows), selected, { select: true });
        loopAccount = selected;
        accountDetailsOwner = current;
        dailyAccount = current;
        renderAccountSelect();
      },
    };
  `)(env);
  env.api.initialize(rows, selected);
  env.effects.length = 0;
  env.row = id => env.api.rows().find(row => row.id === id);
  env.option = id => env.node('account').options.find(option => option.value === id);
  env.select = id => {
    env.api.selectLoadedAccount(id);
    env.effects.length = 0;
  };
  return env;
}

await test('连接状态优先级、重连倒计时及旧数据缺省值', async () => {
  const env = fixture();
  const status = env.api.connectionStatus;
  assert.equal(status({ syncingProduction: true, paused: true, connected: true }), '正在同步生产状态');
  assert.equal(status({ paused: true, reconnecting: true, connected: true }), '已暂停 · 可自行上号');
  assert.equal(status({ reconnecting: true, loginRecovery: { status: 'connecting' }, connected: true }), '异地登录 · 正在自动重连');
  assert.equal(status({ reconnecting: true, loginRecovery: { nextAttemptAt: fixedNow + 2500 } }), '异地登录 · 3 秒后重试');
  assert.equal(status({ reconnecting: true, loginRecovery: { nextAttemptAt: fixedNow - 1000 } }), '异地登录 · 0 秒后重试');
  assert.equal(status({ reconnecting: true }), '异地登录 · 等待重连');
  assert.equal(status({ reconnecting: true, loginRecovery: { nextAttemptAt: NaN } }), '异地登录 · 等待重连');
  assert.equal(status({ loginBlocked: true, connected: true }), '异地登录 · 等待恢复托管');
  assert.equal(status({ connected: true, state: 'CONNECTING' }), '已连接 · 未挂机');
  assert.equal(status({ connected: true, looping: false }), '已连接 · 未挂机');
  assert.equal(status({ connected: true, looping: true }), '挂机中');
  assert.equal(status({ connected: true, looping: true, loopStopping: true }), '暂停中…');
  assert.equal(status({ looping: true, state: 'CONNECTING' }), '连接中…');
  assert.equal(status({ looping: true, connected: false }), '挂机中 · 等待连接');
  assert.equal(status({ state: 'CONNECTING' }), '连接中…');
  for (const missing of [undefined, null, {}]) assert.equal(status(missing), '未连接');
});

await test('每项显示自己的状态，空列表和旧账号都可渲染', async () => {
  const env = fixture([
    { id: 'account-a', title: '甲角色 · 海港1服', status: { connected: true } },
    { id: 'account-b', title: '乙角色 · 海港2服', status: { paused: true } },
    { id: 'legacy', title: '旧账号' },
    { id: 'null-status', title: '<角色名称>', status: null },
  ]);
  assert.equal(env.option('account-a').text, '[已连接 · 未挂机] 甲角色 · 海港1服');
  assert.equal(env.option('account-b').text, '[已暂停 · 可自行上号] 乙角色 · 海港2服');
  assert.equal(env.option('legacy').text, '[未连接] 旧账号');
  assert.equal(env.option('null-status').text, '[未连接] <角色名称>');
  assert.equal(env.node('busy').textContent, '已连接 · 未挂机');
  assert.equal(env.node('account').title, env.option('account-a').text);
  const empty = fixture([]);
  assert.equal(empty.node('account').options.length, 1);
  assert.equal(empty.node('account').options[0].text, '没有账号');
  assert.equal(empty.node('account').disabled, true);
  assert.equal(empty.node('busy').textContent, '没有账号');
  await empty.api.refreshAccountStatuses();
  assert.equal(empty.calls.length, 0);
  assert.match(PAGE, /id="busy"[^>]*class="sr-only"[^>]*role="status"/);
  assert.doesNotMatch(PAGE, /id="disconnect"/, '页面移除独立断开按钮');
  assert.doesNotMatch(pageScript, /\$\('disconnect'\)/, '页面逻辑没有引用已移除的按钮');
  assert.match(PAGE, /id="account-pause"/, '页面保留暂停托管入口');
  assert.match(PAGE, /id="loop-toggle"/, '页面提供独立的挂机启停入口');
  assert.match(PAGE, /id="logs-open"/, '页面保留日志入口');
});

await test('状态变化原位更新选项，当前选择和同值播报保持稳定', async () => {
  const env = fixture();
  env.select('account-b');
  const options = [...env.node('account').options];
  const replacements = env.node('account').replacements;
  env.api.setAccountStatus('account-a', { connected: true });
  env.api.setAccountStatus('account-b', { paused: true });
  assert.equal(env.api.current(), 'account-b');
  assert.equal(env.node('account').value, 'account-b');
  assert.equal(env.node('account').replacements, replacements);
  for (const [index, option] of options.entries()) assert.equal(env.node('account').options[index], option);
  const writes = env.node('busy').writes;
  env.api.paintConnection();
  env.api.paintConnection();
  assert.equal(env.node('busy').writes, writes, '同状态不重复触发读屏播报');
});

await test('全账号刷新只合并已有状态，保留账号选择和名称且不读取游戏', async () => {
  const env = fixture();
  env.serverAccounts = [
    { id: 'account-a', title: '旧快照名称', status: { connected: true } },
    { id: 'account-b', title: '旧快照名称', status: { paused: true } },
    { id: 'other-account', title: '其他页面刚添加', status: { connected: true } },
  ];
  env.respond = async () => ({ accounts: env.serverAccounts, activeId: 'other-account' });
  await env.api.refreshAccountStatuses();
  assert.equal(env.api.current(), 'account-a');
  assert.equal(env.api.rows().length, 2);
  assert.equal(env.row('account-a').title, '甲角色 · 海港1服');
  assert.equal(env.api.snapshot().connected, true);
  assert.match(env.option('account-b').text, /已暂停/);
  assert.deepEqual(env.calls.map(call => call.route), ['/api/accounts']);
  assert.deepEqual(env.effects, [], '纯状态读取不切换账号或重载详情');
});

await test('直接刷新与定时刷新共享在途请求，完成后可以重新读取', async () => {
  const env = fixture();
  const gate = deferred();
  env.respond = () => gate.promise;
  const first = env.api.refreshAccountStatuses();
  const second = env.api.refreshAccountStatuses();
  assert.equal(first, second);
  for (const timer of env.intervals.filter(timer => timer.delay === 3000)) timer.callback();
  assert.equal(env.calls.length, 1);
  gate.resolve({ accounts: env.serverAccounts });
  await first;
  env.respond = async () => ({ accounts: env.serverAccounts });
  await env.api.refreshAccountStatuses();
  assert.equal(env.calls.length, 2);
  for (const timer of env.intervals.filter(timer => timer.delay === 3000)) timer.callback();
  await settle();
  assert.equal(env.calls.length, 3);
});

await test('隐藏页面暂停状态轮询，恢复可见自动刷新后台账号', async () => {
  const env = fixture();
  env.document.hidden = true;
  for (const timer of env.intervals.filter(timer => timer.delay === 3000)) timer.callback();
  env.document.fire('visibilitychange');
  assert.equal(env.calls.length, 0);
  env.serverAccounts[1].status = { connected: true };
  env.document.hidden = false;
  env.document.fire('visibilitychange');
  await settle();
  assert.deepEqual(env.calls.map(call => call.route), ['/api/accounts']);
  assert.match(env.option('account-b').text, /已连接/);
});

await test('后台账号重连倒计时逐秒刷新，当前账号状态保持', async () => {
  const env = fixture([
    { id: 'account-a', title: '甲', status: { connected: true } },
    { id: 'account-b', title: '乙', status: { reconnecting: true, loginRecovery: { nextAttemptAt: fixedNow + 5000 } } },
  ]);
  const timer = env.intervals.find(timer => timer.delay === 1000);
  assert.match(env.option('account-b').text, /5 秒后重试/);
  env.now += 1000;
  timer.callback();
  assert.match(env.option('account-b').text, /4 秒后重试/);
  assert.equal(env.node('busy').textContent, '已连接 · 未挂机');
  assert.equal(env.calls.length, 0);
  env.document.hidden = true;
  env.now += 1000;
  timer.callback();
  assert.match(env.option('account-b').text, /4 秒后重试/);
});

await test('旧状态响应不覆盖手动更新，请求失败后继续刷新', async () => {
  const env = fixture();
  const gate = deferred();
  env.respond = () => gate.promise;
  const refreshing = env.api.refreshAccountStatuses();
  env.api.setAccountStatus('account-a', { connected: true });
  env.api.setAccountStatus('account-b', { paused: true });
  gate.resolve({ accounts: env.serverAccounts });
  await refreshing;
  assert.equal(env.row('account-a').status.connected, true);
  assert.equal(env.row('account-b').status.paused, true);
  env.respond = async () => { throw new Error('模拟暂时离线'); };
  await env.api.refreshAccountStatuses();
  assert.equal(env.row('account-a').status.connected, true);
  env.respond = async () => ({ accounts: [
    { id: 'account-a', status: { paused: true } }, { id: 'account-b' },
  ] });
  await env.api.refreshAccountStatuses();
  assert.equal(env.row('account-a').status.paused, true);
  assert.equal(env.option('account-b').text, '[未连接] 乙角色 · 海港2服');
});

await test('旧总览响应保留较新的异地登录状态，同时继续展示角色与资源', async () => {
  const env = fixture([
    { id: 'account-a', title: '甲角色', status: { connected: true } },
  ], 'account-a', { overview: true });
  const gate = deferred();
  env.respond = route => route === '/api/overview' ? gate.promise
    : Promise.resolve({ accounts: env.serverAccounts, activeId: 'account-a' });
  const overview = env.api.refreshOverview();
  assert.equal(env.calls[0].route, '/api/overview');
  env.serverAccounts[0].status = {
    connected: false, loginBlocked: true, reconnecting: true,
    loginRecovery: { status: 'waiting', nextAttemptAt: fixedNow + 5000 },
  };
  await env.api.refreshAccountStatuses();
  assert.match(env.option('account-a').text, /异地登录.*5 秒后重试/);
  gate.resolve({
    status: { connected: true, loginBlocked: false, reconnecting: false },
    player: { nickname: '服务器最新角色名', level: 50 },
    resources: [{ name: '金币', amount: 321 }],
  });
  await overview;
  assert.equal(env.api.snapshot().connected, false);
  assert.equal(env.api.snapshot().loginBlocked, true);
  assert.equal(env.row('account-a').status.reconnecting, true);
  assert.match(env.option('account-a').text, /异地登录.*5 秒后重试/);
  assert.equal(env.overviews.length, 1, '较新的轮询不会丢弃总览资源结果');
  assert.deepEqual(env.overviews[0].status, env.api.snapshot(), '角色概况使用较新的连接状态');
  assert.equal(env.overviews[0].player.nickname, '服务器最新角色名');
  assert.equal(env.overviews[0].resources[0].amount, 321);
});

await test('未连接的账号详情保持缓存，定时总览仅刷新已连接详情', async () => {
  const env = fixture([{ id: 'account-a', title: '缓存角色', status: { connected: false } }],
    'account-a', { overview: true });
  env.node('tab-overview').classList.add('hidden');
  env.node('tab-heroes').classList.add('hidden');
  env.node('tab-account').classList.remove('hidden');
  env.node('account-info-dialog').open = true;
  await env.api.refreshOverview();
  assert.equal(env.calls.length, 0, '打开未连接详情不会由定时刷新自动登录游戏');
  env.api.setAccountStatus('account-a', { connected: true });
  env.respond = async () => ({ status: { connected: true }, player: { nickname: '已连接角色' } });
  await env.api.refreshOverview();
  assert.deepEqual(env.calls.map(call => call.route), ['/api/overview']);
  assert.equal(env.overviews[0].player.nickname, '已连接角色');
});

await test('账号列表重叠读取只采用最新响应并阻止同时状态轮询', async () => {
  const env = fixture();
  const older = deferred();
  const newer = deferred();
  let requests = 0;
  env.respond = () => (++requests === 1 ? older.promise : newer.promise);
  const first = env.api.loadAccounts(false);
  const second = env.api.loadAccounts(false);
  env.api.refreshAccountStatuses();
  assert.equal(env.calls.length, 2);
  newer.resolve({ accounts: [{ id: 'account-a', title: '最新角色', status: { connected: true } }], activeId: 'account-a' });
  await second;
  older.resolve({ accounts: [{ id: 'obsolete', title: '过期列表', status: {} }], activeId: 'obsolete' });
  await first;
  assert.equal(env.api.current(), 'account-a');
  assert.equal(env.api.rows().length, 1);
  assert.equal(env.row('account-a').title, '最新角色');
  assert.match(env.option('account-a').text, /已连接/);
});

await test('延迟账号列表采用新名称并保留读取期间更新的状态', async () => {
  const env = fixture();
  const gate = deferred();
  env.respond = () => gate.promise;
  const loading = env.api.loadAccounts(false);
  env.api.setAccountStatus('account-b', { paused: true });
  gate.resolve({ accounts: [
    { id: 'account-a', title: '甲的新备注', status: {} },
    { id: 'account-b', title: '乙的新备注', status: { paused: false } },
  ], activeId: 'account-a' });
  await loading;
  assert.equal(env.row('account-b').status.paused, true);
  assert.equal(env.row('account-b').title, '乙的新备注');
  assert.equal(env.api.current(), 'account-a');
});

await test('连接期间切号，进行中及完成状态仅更新请求所属账号', async () => {
  const env = fixture();
  const connecting = deferred();
  env.respond = route => route === '/api/connect' ? connecting.promise : Promise.resolve({ accounts: env.serverAccounts });
  const request = env.node('connect').onclick();
  assert.match(env.option('account-a').text, /连接中/);
  assert.equal(env.node('connect').disabled, true);
  await env.node('connect').onclick();
  assert.equal(env.calls.filter(call => call.route === '/api/connect').length, 1);
  env.select('account-b');
  assert.match(env.option('account-a').text, /连接中/);
  assert.match(env.option('account-b').text, /未连接/);
  env.serverAccounts[0].status = { connected: true };
  connecting.resolve({ ok: true });
  await request;
  await settle();
  assert.equal(env.calls.find(call => call.route === '/api/connect').owner, 'account-a');
  assert.equal(env.api.current(), 'account-b');
  assert.equal(env.row('account-a').status.connected, true);
  assert.equal(env.row('account-b').status.connected, false);
  assert.equal(env.api.snapshot().connected, false);
  assert.equal(env.api.connectingAccounts.size, 0);
  assert.deepEqual(env.effects, [], '后台连接完成不重载当前账号详情');
});

await test('连接失败清除进行中状态并允许下一次连接', async () => {
  const env = fixture();
  env.respond = async route => {
    if (route === '/api/connect') throw new Error('模拟连接失败');
    return { accounts: env.serverAccounts };
  };
  await env.node('connect').onclick();
  await settle();
  assert.equal(env.api.connectingAccounts.size, 0);
  assert.equal(env.node('connect').disabled, false);
  assert.match(env.option('account-a').text, /未连接/);
  assert.equal(env.errors.length, 1);
  await env.node('connect').onclick();
  assert.equal(env.calls.filter(call => call.route === '/api/connect').length, 2);
});

await test('暂停和恢复在切号后仍更新原账号，不影响新账号状态', async () => {
  for (const paused of [true, false]) {
    const env = fixture([
      { id: 'account-a', title: '甲', status: { connected: paused, looping: paused, paused: !paused } },
      { id: 'account-b', title: '乙', status: { connected: true } },
    ]);
    const gate = deferred();
    env.respond = () => gate.promise;
    const request = env.node('account-pause').onclick();
    await settle();
    env.select('account-b');
    gate.resolve({ paused, connected: false });
    await request;
    assert.equal(env.calls[0].route, '/api/accounts/pause');
    assert.deepEqual(env.calls[0].payload, paused ? { paused: true } : { paused: false, start: true, confirm: true });
    assert.equal(env.calls[0].owner, 'account-a');
    assert.equal(env.row('account-a').status.connected, false);
    assert.equal(env.row('account-a').status.paused, paused);
    assert.equal(env.row('account-b').status.connected, true);
    assert.equal(env.api.snapshot().connected, true);
    assert.equal(env.api.current(), 'account-b');
    assert.deepEqual(env.effects, []);
    assert.match(env.option('account-a').text, paused ? /已暂停/ : /未连接/);
  }
});

await test('挂机和托管按钮分别覆盖空闲、运行、暂停、顶号和恢复状态', async () => {
  for (const [status, hostingLabel, loopLabel] of [
    [{ connected: false }, '开始托管', '开始挂机'],
    [{ connected: true, looping: false }, '暂停托管', '开始挂机'],
    [{ connected: true, looping: true }, '暂停托管', '暂停挂机'],
    [{ paused: true, looping: true }, '恢复托管', '暂停挂机'],
    [{ loginBlocked: true }, '恢复托管', '开始挂机'],
    [{ loginBlocked: true, reconnecting: true }, '暂停托管', '暂停挂机'],
    [{ state: 'CONNECTING' }, '暂停托管', '开始挂机'],
  ]) {
    const env = fixture([{ id: 'a', title: '甲', status }]);
    assert.equal(env.node('account-pause').textContent, hostingLabel);
    assert.equal(env.node('account-pause').disabled, false);
    assert.equal(env.node('loop-toggle').textContent, loopLabel);
    assert.equal(env.node('loop-toggle').disabled, !!status.paused);
  }
  assert.equal(fixture([]).node('account-pause').disabled, true);
  assert.equal(fixture([]).node('loop-toggle').disabled, true);
  const stopping = fixture([{ id: 'a', title: '甲', status: { looping: true, loopStopping: true } }]);
  assert.equal(stopping.node('account-pause').disabled, false, '挂机退出中仍可断开托管');
  assert.equal(stopping.node('loop-toggle').disabled, true);
  assert.equal(stopping.node('loop-toggle').textContent, '暂停中…');
  await stopping.node('loop-toggle').onclick();
  assert.equal(stopping.calls.length, 0);
});

await test('开始托管先保存草稿和间隔，重复点击与轮询保持单个请求', async () => {
  const env = fixture(), gate = deferred(), order = [];
  env.onFlush = async () => { order.push('draft'); await gate.promise; return true; };
  env.onIntervalSave = async () => { order.push('interval'); return true; };
  env.respond = async (route, record) => {
    if (route === '/api/accounts/pause') {
      order.push('start');
      assert.deepEqual(record.payload, { paused: false, start: true, confirm: true });
      env.serverAccounts[0].status = { connected: true, looping: true };
      return env.serverAccounts[0].status;
    }
    return { accounts: env.serverAccounts };
  };
  const request = env.node('account-pause').onclick();
  await env.node('account-pause').onclick();
  await env.node('loop-toggle').onclick();
  env.api.renderHostingControl();
  assert.equal(env.node('account-pause').disabled, true);
  assert.equal(env.node('loop-toggle').disabled, true);
  assert.equal(env.calls.length, 0);
  gate.resolve();
  await request; await settle();
  assert.deepEqual(order, ['draft', 'interval', 'start']);
  assert.equal(env.calls.filter(call => call.route === '/api/accounts/pause').length, 1);
  assert.equal(env.node('account-pause').textContent, '暂停托管');
  assert.equal(env.node('account-pause').disabled, false);
});

await test('间隔加载前等待开始和恢复，已连接或运行时仍可暂停托管', async () => {
  for (const status of [{}, { paused: true }, { looping: true }, { connected: true }]) {
    const env = fixture([{ id: 'a', title: '甲', status }]);
    env.api.loopReady(false);
    assert.equal(env.node('account-pause').disabled, !(status.looping || status.connected));
    assert.equal(env.node('loop-toggle').disabled, !status.looping);
    env.api.loopReady(true);
    assert.equal(env.node('account-pause').disabled, false);
    assert.equal(env.node('loop-toggle').disabled, !!status.paused);
  }
});

await test('暂停立即提交且允许处理未保存或无效的配置', async () => {
  const env = fixture([{ id: 'a', title: '甲', status: { connected: true, looping: true } }]);
  env.onFlush = env.onIntervalSave = async () => { throw new Error('暂停不应等待设置'); };
  env.respond = async (route, record) => {
    if (route === '/api/accounts/pause') {
      assert.deepEqual(record.payload, { paused: true });
      env.serverAccounts[0].status = { paused: true, connected: false, looping: false };
      return env.serverAccounts[0].status;
    }
    return { accounts: env.serverAccounts };
  };
  await env.node('account-pause').onclick(); await settle();
  assert.equal(env.errors.length, 0);
  assert.equal(env.node('account-pause').textContent, '恢复托管');
  assert.equal(env.node('account-pause').disabled, false);
});

await test('开始前保存失败或切号均取消启动，错误后可以重试', async () => {
  for (const failure of ['draft', 'interval', 'request']) {
    const env = fixture();
    env.onFlush = async () => failure !== 'draft';
    env.onIntervalSave = async () => failure !== 'interval';
    env.respond = async route => {
      if (route === '/api/accounts/pause') throw new Error('启动失败');
      return { accounts: env.serverAccounts };
    };
    await env.node('account-pause').onclick(); await settle();
    assert.equal(env.calls.filter(call => call.route === '/api/accounts/pause').length, failure === 'request' ? 1 : 0);
    assert.equal(env.node('account-pause').disabled, false);
    assert.equal(env.node('account-pause').textContent, '开始托管');
  }
  for (const phase of ['draft', 'interval']) {
    const env = fixture(), gate = deferred();
    if (phase === 'draft') env.onFlush = () => gate.promise;
    else env.onIntervalSave = () => gate.promise;
    const request = env.node('account-pause').onclick();
    await settle();
    env.select('account-b');
    gate.resolve(true);
    await request;
    assert.equal(env.calls.filter(call => call.route === '/api/accounts/pause').length, 0);
    assert.equal(env.api.current(), 'account-b');
    assert.equal(env.node('account-pause').disabled, false);
  }
});

await test('暂停挂机立即提交，连接和手动操作入口保持可用', async () => {
  const env = fixture([{ id: 'a', title: '甲', status: { connected: true, looping: true, paused: false } }]);
  env.onFlush = env.onIntervalSave = async () => { throw new Error('暂停挂机不应等待设置'); };
  env.respond = async (route, record) => {
    if (route === '/api/loop/stop') {
      assert.deepEqual(record.payload, { confirm: true });
      env.serverAccounts[0].status = { connected: true, looping: false, loopStopping: false, paused: false };
      return { ok: true, running: false, status: env.serverAccounts[0].status };
    }
    return { accounts: env.serverAccounts };
  };
  await env.node('loop-toggle').onclick(); await settle();
  assert.equal(env.errors.length, 0);
  assert.deepEqual(env.calls.filter(call => call.payload).map(call => call.route), ['/api/loop/stop']);
  assert.equal(env.api.snapshot().connected, true);
  assert.equal(env.api.snapshot().paused, false);
  assert.equal(env.node('loop-toggle').textContent, '开始挂机');
  assert.equal(env.node('loop-toggle').disabled, false);
  assert.equal(env.node('account-pause').textContent, '暂停托管');
  assert.equal(env.node('account-info-refresh').disabled, false);
  assert.equal(env.node('production-plan-refresh').disabled, false);
  assert.equal(env.api.disconnected.has('a'), false);
});

await test('暂停挂机后空闲连接仍可暂停托管，退出中也可断开', async () => {
  for (const loopStopping of [false, true]) {
    const env = fixture([{ id: 'a', title: '甲', status: { connected: true, looping: loopStopping, loopStopping, paused: false } }]);
    env.onFlush = env.onIntervalSave = async () => { throw new Error('暂停托管不应等待设置'); };
    env.respond = async (route, record) => {
      if (route === '/api/accounts/pause') {
        assert.deepEqual(record.payload, { paused: true });
        env.serverAccounts[0].status = { connected: false, looping: false, paused: true };
        return env.serverAccounts[0].status;
      }
      return { accounts: env.serverAccounts };
    };
    await env.node('account-pause').onclick(); await settle();
    assert.equal(env.errors.length, 0);
    assert.equal(env.api.snapshot().connected, false);
    assert.equal(env.node('account-pause').textContent, '恢复托管');
    assert.equal(env.node('loop-toggle').disabled, true);
    assert.equal(env.node('account-info-refresh').disabled, true);
  }
});

await test('挂机停止中的状态禁止重启，轮询完成后恢复按钮', async () => {
  const env = fixture([{ id: 'a', title: '甲', status: { connected: true, looping: true, paused: false } }]);
  env.respond = async route => {
    if (route === '/api/loop/stop') {
      env.serverAccounts[0].status = { connected: true, looping: true, loopStopping: true, paused: false };
      return { ok: true, running: true, status: env.serverAccounts[0].status };
    }
    return { accounts: env.serverAccounts };
  };
  await env.node('loop-toggle').onclick(); await settle();
  assert.equal(env.node('loop-toggle').textContent, '暂停中…');
  assert.equal(env.node('loop-toggle').disabled, true);
  assert.equal(env.node('account-pause').disabled, false);
  await env.node('loop-toggle').onclick();
  assert.equal(env.calls.filter(call => call.payload).length, 1);
  env.serverAccounts[0].status = { connected: true, looping: false, loopStopping: false, paused: false };
  await env.api.refreshAccountStatuses();
  assert.equal(env.node('loop-toggle').textContent, '开始挂机');
  assert.equal(env.node('loop-toggle').disabled, false);
});

await test('开始挂机先保存草稿和间隔，并阻止两种控制重复提交', async () => {
  const env = fixture([{ id: 'a', title: '甲', status: { connected: true, looping: false, paused: false } }]);
  const gate = deferred(), order = [];
  env.onFlush = async () => { order.push('draft'); await gate.promise; return true; };
  env.onIntervalSave = async () => { order.push('interval'); return true; };
  env.respond = async (route, record) => {
    if (route === '/api/loop/start') {
      order.push('start');
      assert.deepEqual(record.payload, { confirm: true });
      env.serverAccounts[0].status = { connected: true, looping: true, paused: false };
      return { running: true, status: env.serverAccounts[0].status };
    }
    return { accounts: env.serverAccounts };
  };
  const request = env.node('loop-toggle').onclick();
  await env.node('loop-toggle').onclick();
  await env.node('account-pause').onclick();
  env.api.renderHostingControl();
  assert.equal(env.node('loop-toggle').disabled, true);
  assert.equal(env.node('account-pause').disabled, true);
  assert.equal(env.calls.length, 0);
  gate.resolve();
  await request; await settle();
  assert.deepEqual(order, ['draft', 'interval', 'start']);
  assert.deepEqual(env.calls.filter(call => call.payload).map(call => call.route), ['/api/loop/start']);
  assert.equal(env.node('loop-toggle').textContent, '暂停挂机');
  assert.equal(env.node('loop-toggle').disabled, false);
  assert.equal(env.node('account-pause').disabled, false);
});

await test('挂机启停响应在切号后归属原账号', async () => {
  for (const running of [false, true]) {
    const env = fixture([
      { id: 'account-a', title: '甲', status: { connected: true, looping: running, paused: false } },
      { id: 'account-b', title: '乙', status: { connected: false, paused: true } },
    ]);
    const gate = deferred();
    env.respond = () => gate.promise;
    const request = env.node('loop-toggle').onclick();
    await settle();
    env.select('account-b');
    gate.resolve({ running: !running, status: { connected: true, looping: !running, paused: false } });
    await request;
    assert.equal(env.calls[0].route, '/api/loop/' + (running ? 'stop' : 'start'));
    assert.equal(env.calls[0].owner, 'account-a');
    assert.equal(env.row('account-a').status.looping, !running);
    assert.equal(env.row('account-a').status.connected, true);
    assert.equal(env.api.current(), 'account-b');
    assert.equal(env.api.snapshot().paused, true);
    assert.equal(env.node('loop-toggle').disabled, true);
    assert.deepEqual(env.effects, []);
  }
});

await test('挂机启动保存失败或切号取消请求，错误后可重新操作', async () => {
  for (const failure of ['draft', 'interval', 'request']) {
    const env = fixture();
    env.onFlush = async () => failure !== 'draft';
    env.onIntervalSave = async () => failure !== 'interval';
    env.respond = async route => {
      if (route === '/api/loop/start') throw new Error('启动挂机失败');
      return { accounts: env.serverAccounts };
    };
    await env.node('loop-toggle').onclick(); await settle();
    assert.equal(env.calls.filter(call => call.route === '/api/loop/start').length, failure === 'request' ? 1 : 0);
    assert.equal(env.node('loop-toggle').disabled, false);
    assert.equal(env.node('account-pause').disabled, false);
    assert.equal(env.node('loop-toggle').textContent, '开始挂机');
  }
  for (const phase of ['draft', 'interval']) {
    const env = fixture(), gate = deferred();
    if (phase === 'draft') env.onFlush = () => gate.promise;
    else env.onIntervalSave = () => gate.promise;
    const request = env.node('loop-toggle').onclick();
    await settle();
    env.select('account-b');
    gate.resolve(true);
    await request;
    assert.equal(env.calls.filter(call => call.route === '/api/loop/start').length, 0);
    assert.equal(env.node('loop-toggle').disabled, false);
    assert.equal(env.api.current(), 'account-b');
  }
});

await test('暂停挂机请求失败后保留运行状态并允许重试', async () => {
  const env = fixture([{ id: 'a', title: '甲', status: { connected: true, looping: true, paused: false } }]);
  env.respond = async route => {
    if (route === '/api/loop/stop') throw new Error('暂时无法暂停');
    return { accounts: env.serverAccounts };
  };
  await env.node('loop-toggle').onclick(); await settle();
  assert.equal(env.errors.length, 1);
  assert.equal(env.node('loop-toggle').textContent, '暂停挂机');
  assert.equal(env.node('loop-toggle').disabled, false);
  assert.equal(env.node('account-pause').disabled, false);
  await env.node('loop-toggle').onclick();
  assert.equal(env.calls.filter(call => call.route === '/api/loop/stop').length, 2);
});

console.log(`账号下拉状态自检通过 ${passed} 项`);
