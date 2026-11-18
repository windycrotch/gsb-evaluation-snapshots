import assert from 'node:assert/strict';
import { PAGE } from '../src/page.mjs';

const script = [...PAGE.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(value => value.includes('function resetAccountAddCapture('));
assert.ok(script, '页面包含实际采集弹窗生命周期');
const start = script.indexOf('let capturePoll =');
const end = script.indexOf('// ---- APP 账号登录', start);
assert.ok(start >= 0 && end > start);
const captureScript = script.slice(start, end);
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

function node(tag = 'div', className = '', text = '') {
  let content = text;
  return {
    tag, className, dataset: {}, children: [], hidden: false, disabled: false, open: false,
    get textContent() { return content + this.children.map(child => child.textContent).join(''); },
    set textContent(value) { content = String(value ?? ''); this.children = []; },
    appendChild(child) { this.children.push(child); return child; },
    querySelector(selector) {
      for (const child of this.children) {
        if (child.tag === selector) return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
      return null;
    },
  };
}

function idle() {
  return { running: false, phase: 'idle', platform: 'wechat', startedAt: null, accountId: null,
    recovery: { pending: false, recoverable: false }, qr: { kind: 'none' } };
}

function fixture(channel = 'wechat') {
  const nodes = new Map();
  const env = { channel, calls: [], changes: [], errors: [], loads: [], renders: 0,
    confirmation: null, timers: new Map(), sequence: 0, state: idle() };
  env.node = id => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  };
  env.respond = async (route, payload) => {
    if (route === '/api/capture/start') env.state = { ...idle(), running: true, phase: 'waiting',
      platform: payload.platform, startedAt: 'fixture-run-' + ++env.sequence };
    if (route === '/api/capture/stop' || route === '/api/capture/recover') {
      env.state = { ...env.state, running: false, phase: 'idle', error: null, recovery: { pending: false } };
    }
    return structuredClone(env.state);
  };
  env.call = async (route, options) => {
    const payload = options?.body ? JSON.parse(options.body) : null;
    env.calls.push({ route, payload });
    return env.respond(route, payload);
  };
  env.makeNode = node;
  new Function('env', `
    const $ = env.node, call = env.call, el = env.makeNode;
    const clear = element => {element.textContent='';return element;};
    const setInterval = (callback,delay) => {const id=++env.sequence;env.timers.set(id,{callback,delay});return id;};
    const clearInterval = id => env.timers.delete(id);
    const loadAccounts = async reload => env.loads.push(reload);
    const renderAccounts = () => env.renders++;
    const reportError = error => env.errors.push(error);
    const accountAddChannel = () => env.channel;
    const accountAddChanged = (channel,phase,options) => env.changes.push({channel,phase,...options});
    const openConfirm = (title,body,callback) => {env.confirmation={title,body,callback};$('modal').open=true;};
    const closeModal = () => {$('modal').open=false;env.confirmation=null;};
    ${captureScript}
    env.api={beginCapture,pollCapture,renderCapture,resetAccountAddCapture,stopAccountCapture,
      owner:()=>captureOwner,busy:()=>captureActionBusy,view:()=>captureView};
  `)(env);
  env.confirm = async () => {
    const confirmation = env.confirmation;
    assert.ok(confirmation, '开始前应出现明确确认');
    env.confirmation = null;
    env.node('modal').open = false;
    return confirmation.callback();
  };
  env.start = async () => { await env.api.beginCapture(env.channel); await env.confirm(); };
  env.count = route => env.calls.filter(call => call.route === '/api/capture' + route).length;
  return env;
}

await test('仅当前渠道可以开始，确认前不会修改代理且旧确认失效', async () => {
  const env = fixture();
  await env.api.beginCapture('douyin');
  assert.equal(env.calls.length, 0);
  await env.api.beginCapture('wechat');
  assert.equal(env.count('/start'), 0);
  const oldConfirmation = env.confirmation.callback;
  assert.match(env.confirmation.body.map(element => element.textContent).join(''), /系统代理|本机代理/);
  assert.equal(await env.api.resetAccountAddCapture(), true);
  assert.equal(env.node('modal').open, false);
  env.channel = 'douyin';
  await oldConfirmation();
  assert.equal(env.count('/start'), 0);
  assert.equal(env.count('/stop'), 0);
});

await test('状态读取与启动请求在途时拒绝关闭，完成后可以清理', async () => {
  const env = fixture();
  const readGate = deferred();
  env.respond = () => readGate.promise;
  const preparing = env.api.beginCapture('wechat');
  assert.equal(await env.api.resetAccountAddCapture(), false);
  readGate.resolve(idle());
  await preparing;
  const startGate = deferred();
  env.respond = route => route.endsWith('/start') ? startGate.promise : Promise.resolve(structuredClone(env.state));
  const starting = env.confirm();
  assert.equal(env.api.busy(), true);
  assert.equal(await env.api.resetAccountAddCapture(), false);
  env.state = { ...idle(), running: true, phase: 'waiting', startedAt: 'fixture-busy-run' };
  startGate.resolve(structuredClone(env.state));
  await starting;
  assert.equal(env.api.busy(), false);
  assert.equal(env.timers.size, 1);
  env.respond = async route => {
    if (route.endsWith('/stop')) env.state = { ...env.state, running: false, phase: 'idle' };
    return structuredClone(env.state);
  };
  assert.equal(await env.api.resetAccountAddCapture(), true);
  assert.equal(env.count('/stop'), 1);
  assert.equal(env.timers.size, 0);
});

await test('停止本弹窗启动的采集，并隐藏原始代理地址和采集日志', async () => {
  const env = fixture('douyin');
  await env.start();
  assert.deepEqual(env.calls.find(call => call.route.endsWith('/start')).payload, {confirm:true,platform:'douyin'});
  env.api.renderCapture({ ...env.state, proxy: { ProxyServer: 'fixture-private-proxy' },
    originalProxy: { ProxyServer: 'fixture-original-proxy' }, log: ['fixture-private-log'] });
  assert.match(env.node('cap-box').textContent, /电脑版抖音/);
  assert.doesNotMatch(env.node('cap-box').textContent, /fixture-private|fixture-original/);
  assert.equal(await env.api.resetAccountAddCapture(), true);
  assert.equal(env.count('/stop'), 1);
  assert.deepEqual(env.calls.find(call => call.route.endsWith('/stop')).payload, {confirm:true});
  assert.equal(env.state.running, false);
  assert.equal(env.api.owner(), null);
  assert.equal(env.node('cap-box').querySelector('img'), null);
  assert.equal(env.node('cap-box').querySelector('ol').children.length, 3);
  assert.match(env.node('cap-box').textContent, /先登录电脑版抖音/);
});

await test('关闭清理读取在途时不能再启动采集', async () => {
  const env = fixture();
  await env.start();
  env.state = { ...env.state, running: false, phase: 'idle', accountId: 'fixture-saved' };
  env.api.renderCapture(env.state);
  const gate = deferred();
  env.respond = () => gate.promise;
  const closing = env.api.resetAccountAddCapture();
  const callsBefore = env.calls.length;
  assert.equal(env.api.busy(), true);
  await env.api.beginCapture('wechat');
  assert.equal(env.calls.length, callsBefore);
  assert.equal(env.confirmation, null);
  gate.resolve(structuredClone(env.state));
  assert.equal(await closing, true);
  assert.equal(env.api.busy(), false);
  assert.equal(env.api.owner(), null);
});

await test('启动回复丢失后按渠道及起始时间识别并补偿停止', async () => {
  const env = fixture();
  const respond = env.respond;
  env.respond = async (route, payload) => {
    const state = await respond(route, payload);
    if (route.endsWith('/start')) throw new Error('模拟启动回复丢失');
    return state;
  };
  await env.api.beginCapture('wechat');
  await assert.rejects(env.confirm(), /启动回复丢失/);
  assert.equal(env.state.running, true);
  assert.equal(env.api.owner().startedAt, null);
  assert.equal(await env.api.resetAccountAddCapture(), true);
  assert.equal(env.count('/stop'), 1);
  assert.equal(env.state.running, false);
});

await test('已有外部采集与后来替换的采集不会被弹窗关闭停止', async () => {
  const existing = fixture();
  existing.state = { ...idle(), running:true, phase:'waiting', startedAt:'fixture-external' };
  await existing.api.beginCapture('wechat');
  assert.equal(existing.confirmation, null);
  assert.equal(await existing.api.resetAccountAddCapture(), true);
  assert.equal(existing.count('/stop'), 0);
  assert.equal(existing.state.running, true);
  const replaced = fixture();
  await replaced.start();
  replaced.state = { ...replaced.state, startedAt:'fixture-other-window' };
  assert.equal(await replaced.api.resetAccountAddCapture(), true);
  assert.equal(replaced.count('/stop'), 0);
  assert.equal(replaced.state.running, true);
});

await test('重新打开正在采集的渠道后持续更新，关闭只停止本页轮询', async () => {
  const env = fixture();
  env.state = { ...idle(), running: true, phase: 'waiting', startedAt: 'fixture-existing' };
  await env.api.pollCapture();
  assert.equal(env.timers.size, 1);
  await env.api.pollCapture();
  assert.equal(env.timers.size, 1, '重复刷新保持单个轮询');
  env.state = { ...env.state, running: false, phase: 'idle', accountId: 'fixture-saved' };
  await env.timers.values().next().value.callback();
  assert.equal(env.timers.size, 0);
  assert.deepEqual(env.loads, [false]);
  env.state = { ...env.state, running: true, phase: 'waiting', accountId: null };
  await env.api.pollCapture();
  assert.equal(env.timers.size, 1);
  await env.api.resetAccountAddCapture();
  assert.equal(env.timers.size, 0);
  assert.equal(env.count('/stop'), 0);
});

await test('清理失败保留归属并允许再次停止，残留恢复使用独立接口', async () => {
  const env = fixture();
  await env.start();
  const owner = env.api.owner();
  const respond = env.respond;
  let fail = true;
  env.respond = async (route, payload) => {
    if (route.endsWith('/stop') && fail) {
      env.state = { ...env.state, running:false, phase:'error', error:'模拟代理恢复失败' };
      return structuredClone(env.state);
    }
    return respond(route, payload);
  };
  await assert.rejects(env.api.resetAccountAddCapture(), /模拟代理恢复失败/);
  assert.equal(env.api.owner(), owner);
  assert.equal(env.api.busy(), false);
  fail = false;
  assert.equal(await env.api.resetAccountAddCapture(), true);
  assert.equal(env.count('/stop'), 2);
  env.state = { ...idle(), recovery:{pending:true,recoverable:true,message:'需要恢复上次采集'} };
  env.api.renderCapture(env.state);
  assert.equal(env.node('cap-recover').hidden, false);
  assert.equal(env.node('cap-recover').disabled, false);
  await env.node('cap-recover').onclick();
  assert.equal(env.count('/recover'), 1);
  assert.equal(env.node('cap-recover').hidden, true);
});

await test('读取失败但清理已完成时允许重新开始并显示对应提示', async () => {
  const env = fixture();
  env.state = { ...idle(), error: 'fixture-private-error-path' };
  env.api.renderCapture(env.state);
  assert.match(env.node('cap-hint').textContent, /读取失败.*重新开始/);
  assert.doesNotMatch(env.node('cap-hint').textContent, /清理未完成|fixture-private/);
  assert.equal(env.node('cap-start').disabled, false);
  assert.equal(env.node('cap-stop').hidden, true);
  assert.equal(env.node('cap-recover').hidden, true);
  assert.equal(env.node('account-add-notice').hidden, true);
  await env.api.beginCapture('wechat');
  assert.ok(env.confirmation);
  assert.equal(env.count('/stop'), 0);
});

await test('关闭后的迟到轮询不会恢复内容、轮询或影响新页面', async () => {
  for (const failure of [false, true]) {
    const env = fixture();
    const gate = deferred();
    env.respond = () => gate.promise;
    const polling = env.api.pollCapture();
    await env.api.resetAccountAddCapture();
    env.node('cap-hint').textContent = '新页面提示';
    if (failure) gate.reject(new Error('模拟旧轮询失败'));
    else gate.resolve({ ...idle(), running:true, phase:'waiting' });
    await polling;
    assert.equal(env.node('cap-hint').textContent, '新页面提示');
    assert.equal(env.node('cap-box').textContent, '');
    assert.equal(env.timers.size, 0);
    assert.equal(env.errors.length, 0);
  }
});

await test('本人采集成功显示完成状态，外部结果不会误报添加成功', async () => {
  const env = fixture();
  await env.start();
  env.state = { ...env.state, running:false, phase:'idle', accountId:'fixture-captured-account' };
  await env.api.pollCapture();
  assert.equal(env.changes.at(-1).phase, 'saved');
  assert.match(env.node('cap-hint').textContent, /账号已添加/);
  assert.equal(env.timers.size, 0);
  assert.deepEqual(env.loads, [false]);
  const external = fixture();
  external.api.renderCapture({ ...idle(), startedAt:'fixture-external', accountId:'fixture-external-account' });
  assert.equal(external.changes.at(-1).phase, 'entry');
});

console.log(`账号采集弹窗自检通过 ${passed} 项`);
