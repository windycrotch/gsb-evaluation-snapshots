import { newStateFunction } from './fixtures/console-state.mjs';
import assert from 'node:assert/strict';
import { PAGE } from '../src/page.mjs';

const script = [...PAGE.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(value => value.includes('async function saveLoopInterval('));
assert.ok(script);
function section(start, end) {
  const from = script.indexOf(start), to = script.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return script.slice(from, to);
}
const source = [
  section('function setTaskSwitch(', 'const pirateAdvanceErrors'),
  section('function renderHostingControl(', 'function renderAccountSelect('),
  section('function renderLoop(', 'async function toggleAutoTask('),
  section('async function saveLoopInterval(', 'let orderClockOffset=0;'),
].join('\n');
const settle = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture() {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) {
      const attributes = new Map(), thumb = { dataset: {} };
      let value = '';
      nodes.set(id, {
        get value() { return value; },
        set value(next) { value = String(next); },
        textContent: '', disabled: false, dataset: {},
        classList: { contains: () => true },
        setAttribute: (name, next) => attributes.set(name, String(next)),
        getAttribute: name => attributes.get(name),
        removeAttribute: name => attributes.delete(name),
        querySelector: () => thumb,
        reportValidity: () => value !== '' && Number.isFinite(Number(value)) && Number(value) >= 1 && Number(value) <= 86400 && Number.isInteger(Number(value)),
      });
    }
    return nodes.get(id);
  };
  const view = seconds => ({ running: false, rounds: 0, everyMs: seconds * 1000, completed: 0, controls: [], settingsRevision: 1 });
  const env = { node, calls: [], errors: [], states: { a: view(60), b: view(90) }, flushes: 0, statusRenders: [] };
  env.flush = async () => { env.flushes++; return env.onFlush ? env.onFlush() : true; };
  env.call = async (account, route, options) => {
    const payload = options?.body ? JSON.parse(options.body) : null;
    env.calls.push({ account, route, payload });
    if (!payload) {
      const data = structuredClone(env.states[account]);
      await env.onGet?.(account);
      return data;
    }
    assert.equal(route, '/api/loop/interval');
    await env.onPost?.(account, payload);
    env.states[account].everyMs = payload.everySeconds * 1000;
    env.states[account].settingsRevision++;
    return structuredClone(env.states[account]);
  };
  const api = newStateFunction('env', `
    let current = 'a', loopAccount = null, loopVersion = 0, loopFieldDefaults = null, loopSettingsRevision = null, accountStatusRevision = 0;
    let overviewLoopOwner = null, overviewLoopData = null, overviewRenderKey = '', snapshot = {};
    stateActions.replaceAccounts([{ id: 'a', status: {} }, { id: 'b', status: {} }], 'a');
    consoleStore.subscribe(state => { snapshot = CWConsoleState.selectCurrentStatus(state); });
    const savingTasks = new Set(), loopIntervalSaves = new Map(), taskInputs = [], pirateFailureOptions = new Map(), hostingActions = new Set(), connectingAccounts = new Set();
    const $ = env.node, document = { hidden: false }, configFlush = env.flush;
    const call = (route, options) => env.call(current, route, options);
    const reportError = error => env.errors.push(error);
    const renderAutomationOverview = data => { overviewLoopOwner = current; overviewLoopData = data; };
    const renderPirateAdvance = () => {}, filterIdleControls = () => {}, clear = () => {};
    const configIntervalSaved = () => {};
    const paintConnection = () => env.statusRenders.push(['picker', structuredClone(snapshot)]);
    const renderAccounts = () => env.statusRenders.push(['cards', structuredClone(snapshot)]);
    ${source}
    return {
      load: refreshLoop, render: renderLoop, save: saveLoopInterval,
      change(account) { current = account; stateActions.selectAccount(account); return refreshLoop(); },
      pending: () => loopIntervalSaves.size,
      revision: () => accountStatusRevision,
    };
  `)(env);
  return { ...api, env, node, posts: () => env.calls.filter(row => row.payload) };
}

let passed = 0;
async function test(name, run) { await run(); passed++; console.log('通过：' + name); }

await test('页头间隔输入与挂机、托管两个独立按钮依次排列', () => {
  const header = PAGE.match(/<header>[\s\S]*?<\/header>/)?.[0];
  assert.ok(header);
  for (const id of ['loop-every', 'loop-toggle', 'account-pause', 'loop-hint', 'loop-interval-status']) {
    assert.equal([...PAGE.matchAll(new RegExp('id="' + id + '"', 'g'))].length, 1, id);
    assert.ok(header.includes('id="' + id + '"'), id);
  }
  assert.ok(header.indexOf('id="loop-every"') < header.indexOf('id="loop-toggle"'));
  assert.ok(header.indexOf('id="loop-toggle"') < header.indexOf('id="account-pause"'));
  assert.match(header, /aria-label="挂机间隔（秒）"/);
  assert.match(header, /aria-describedby="loop-interval-status"/);
});

await test('重复定时卡片及旧节点绑定已移除，挂机与挑战仍可操作', () => {
  for (const removed of ['idle-schedule', 'loop-auto-start', 'loop-start', 'loop-stop', 'loop-rounds',
    'idle-notes', 'idle-more', 'challenge-run-state', 'single-task-status', 'single-go-pirate',
    'single-go-stages', 'single-go-mutual', 'idle-go-settings', 'idle-go-overview', 'runtime-version', 'tab-idle', 'idle-search']) {
    assert.equal(PAGE.includes(removed), false, removed + ' 应从页面和脚本中移除');
  }
  for (const id of ['config-form', 'stage-start', 'trial-refresh', 'pirate-advance-start']) {
    assert.equal([...PAGE.matchAll(new RegExp('id="' + id + '"', 'g'))].length, 1, id);
  }
});

await test('任意页签读取当前账号间隔，运行中修改先保存草稿再提交', async () => {
  const f = fixture();
  f.env.states.a.running = true;
  await f.load();
  assert.equal(f.node('loop-every').value, '60');
  assert.equal(f.node('loop-every').disabled, false);
  assert.equal(f.node('account-pause').textContent, '暂停托管');
  assert.equal(f.node('loop-toggle').textContent, '暂停挂机');
  f.node('loop-every').value = '120';
  assert.equal(await f.save(), true); await settle();
  assert.equal(f.env.flushes, 1);
  assert.deepEqual(f.posts()[0], { account: 'a', route: '/api/loop/interval', payload: { confirm: true, everySeconds: 120, revision: 1 } });
  assert.equal(f.node('loop-every').value, '120');
  assert.equal(f.env.states.a.running, true);
  assert.equal(f.node('loop-every').disabled, false);
  assert.equal(f.node('loop-interval-status').textContent, '间隔已保存，下一轮生效');
  await f.save();
  assert.equal(f.posts().length, 1, '同值无需重复保存');
  await f.change('b');
  assert.equal(f.node('loop-every').value, '90');
  await f.change('a');
  assert.equal(f.node('loop-every').value, '120');
});

await test('挂机轮询同步更新页头、账号卡片及状态版本，旧列表不能回滚启停', async () => {
  const f = fixture();
  f.node('tab-account').classList.contains = () => false;
  for (const [running, stopping, button] of [
    [true, false, '暂停挂机'], [true, true, '暂停中…'], [false, false, '开始挂机'],
  ]) {
    Object.assign(f.env.states.a, { running, stopping });
    const revision = f.revision();
    f.env.statusRenders.length = 0;
    await f.load();
    assert.equal(f.node('loop-toggle').textContent, button);
    assert.deepEqual(f.env.statusRenders, [
      ['picker', { looping: running, loopStopping: stopping }],
      ['cards', { looping: running, loopStopping: stopping }],
    ]);
    assert.ok(f.revision() > revision, '状态变化使旧账号列表响应失效');
    await f.load();
    assert.equal(f.revision(), revision + 1, '同值轮询不使账号列表读取失效');
  }
});

await test('轮询保留正在编辑的值，同步未编辑的服务端修改', async () => {
  const f = fixture();
  f.env.states.a.running = true;
  await f.load();
  f.node('loop-every').value = '125';
  await f.load();
  assert.equal(f.node('loop-every').value, '125');
  f.node('loop-every').value = '60';
  f.env.states.a.everyMs = 180000;
  await f.load();
  assert.equal(f.node('loop-every').value, '180');
});

await test('保存中的重复提交和旧轮询不会覆盖待保存的间隔', async () => {
  const f = fixture(), gate = deferred();
  await f.load();
  f.node('loop-every').value = '120';
  f.env.onPost = () => gate.promise;
  const saving = f.save(); await settle();
  const duplicate = f.save();
  f.render(structuredClone(f.env.states.a));
  assert.equal(f.posts().length, 1);
  assert.equal(f.node('loop-every').value, '120');
  assert.equal(f.node('loop-every').disabled, true);
  gate.resolve();
  assert.equal(await saving, true);
  assert.equal(await duplicate, true); await settle();
  assert.equal(f.pending(), 0);
  assert.equal(f.node('loop-every').disabled, false);
});

await test('空值、越界和小数均不提交，边界整数可保存', async () => {
  const f = fixture();
  await f.load();
  for (const value of ['', '0', '-1', '86401', '1.5', 'NaN']) {
    f.node('loop-every').value = value;
    assert.equal(await f.save(), false, value);
    assert.equal(f.node('loop-every').getAttribute('aria-invalid'), 'true');
  }
  assert.equal(f.posts().length, 0);
  for (const value of ['1', '86400']) {
    f.node('loop-every').value = value;
    assert.equal(await f.save(), true); await settle();
    assert.equal(f.node('loop-every').getAttribute('aria-invalid'), undefined);
  }
});

await test('保存前发出的旧读取晚到时不能回滚新间隔', async () => {
  const f = fixture(), gate = deferred();
  await f.load();
  f.env.onGet = () => gate.promise;
  const oldRead = f.load();
  f.env.onGet = undefined;
  f.node('loop-every').value = '120';
  assert.equal(await f.save(), true); await settle();
  gate.resolve(); await oldRead;
  assert.equal(f.node('loop-every').value, '120');
  f.node('loop-every').value = '180';
  assert.equal(await f.save(), true);
  assert.equal(f.posts()[1].payload.revision, 2);
});

await test('草稿保存期间切换账号会取消尚未提交的间隔请求', async () => {
  const f = fixture(), gate = deferred();
  await f.load();
  f.node('loop-every').value = '120';
  f.env.onFlush = () => gate.promise;
  const saving = f.save();
  await f.change('b');
  gate.resolve(true);
  assert.equal(await saving, false);
  assert.equal(f.posts().length, 0);
  assert.equal(f.node('loop-every').value, '90');
  assert.equal(f.pending(), 0);
});

await test('旧账号的成功或失败响应均不会改写当前账号间隔', async () => {
  for (const fails of [false, true]) {
    const f = fixture(), gate = deferred();
    await f.load();
    f.node('loop-every').value = '120';
    f.env.onPost = () => gate.promise;
    const saving = f.save(); await settle();
    await f.change('b');
    if (fails) gate.reject(new Error('旧账号保存失败'));
    else gate.resolve();
    await saving; await settle();
    assert.equal(f.node('loop-every').value, '90');
    assert.equal(f.node('loop-every').disabled, false);
    assert.equal(f.env.states.b.everyMs, 90000);
    assert.equal(f.env.errors.length, 0);
    assert.equal(f.pending(), 0);
  }
});

await test('保存失败且回读失败时保留输入并允许重试', async () => {
  const f = fixture();
  await f.load();
  f.node('loop-every').value = '120';
  f.env.onPost = async () => { throw new Error('保存失败'); };
  f.env.onGet = async () => { throw new Error('回读失败'); };
  assert.equal(await f.save(), false); await settle();
  assert.equal(f.node('loop-every').value, '120');
  assert.equal(f.node('loop-every').disabled, false);
  assert.equal(f.node('loop-every').getAttribute('aria-invalid'), 'true');
  assert.equal(f.env.errors[0]?.message, '保存失败');
  assert.equal(f.pending(), 0);
  f.env.onPost = f.env.onGet = undefined;
  assert.equal(await f.save(), true); await settle();
  assert.equal(f.node('loop-every').value, '120');
  assert.equal(f.node('loop-every').getAttribute('aria-invalid'), undefined);
});

await test('草稿校验失败时不提交间隔并恢复可操作状态', async () => {
  const f = fixture();
  await f.load();
  f.node('loop-every').value = '120';
  f.env.onFlush = async () => false;
  assert.equal(await f.save(), false); await settle();
  assert.equal(f.posts().length, 0);
  assert.equal(f.node('loop-every').disabled, false);
  assert.equal(f.pending(), 0);
  assert.match(f.env.errors[0]?.message, /配置尚未保存/);
});

console.log('页头托管与间隔 UI 专项 ' + passed + '/' + passed + ' 通过');
