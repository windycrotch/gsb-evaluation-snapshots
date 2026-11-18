import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PAGE } from '../src/page.mjs';

const script = fs.readFileSync(new URL('../src/account-picker-ui.js', import.meta.url), 'utf8');
const pageScript = [...PAGE.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(value => value.includes('function connectionStatus('));
const statusStart = pageScript.indexOf('function connectionStatus(');
const statusEnd = pageScript.indexOf('function renderAccountOptions(', statusStart);
const changeStart = pageScript.indexOf("$('account').onchange = async () => {");
const changeEnd = pageScript.indexOf("$('account-pause').onclick", changeStart);
assert.ok(statusStart >= 0 && statusEnd > statusStart && changeStart >= 0 && changeEnd > changeStart);
const template = PAGE.match(/<template id="ui-account-option">([\s\S]*?)<\/template>/)?.[1];
assert.ok(template, '构建后的页面提供账号选项模板');
const fields = [...template.matchAll(/data-picker-field="([^"]+)"/g)].map(match => match[1]);
const now = 1_794_830_400_000;
let passed = 0;

async function test(name, run) {
  await run();
  passed++;
  console.log('通过：' + name);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(rows = [
  { id: 'a', title: '甲角色 · 海港1服', status: { connected: true } },
  { id: 'b', title: '乙角色 · 海港2服', status: { paused: true } },
  { id: 'c', title: '丙角色 · 海港3服', status: {} },
], selected = rows[0]?.id ?? null) {
  const nodes = new Map();
  const env = { rows: structuredClone(rows), selected, refreshes: 0, calls: [], guards: [], selections: [], errors: [], allowed: true };
  function makeNode(id = '') {
    const attributes = new Map();
    const classes = new Set();
    const listeners = new Map();
    let text = '';
    return {
      id, children: [], parentNode: null, dataset: {}, hidden: false, disabled: false, value: '', title: '', moves: 0,
      classList: {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        contains: name => classes.has(name),
      },
      get textContent() { return text + this.children.map(child => child.textContent).join(''); },
      set textContent(value) { this.replaceChildren(); text = String(value ?? ''); },
      set innerHTML(value) { throw new Error('账号标题不应写入 innerHTML'); },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name); },
      append(...children) { children.forEach(child => this.insertBefore(child, null)); },
      insertBefore(child, before) {
        child.remove();
        const index = before ? this.children.indexOf(before) : this.children.length;
        assert.ok(index >= 0);
        this.children.splice(index, 0, child);
        child.parentNode = this;
        this.moves++;
        return child;
      },
      remove() {
        if (!this.parentNode) return;
        if (this.contains(env.document.activeElement)) env.document.activeElement = env.document.body;
        const children = this.parentNode.children;
        children.splice(children.indexOf(this), 1);
        this.parentNode = null;
      },
      replaceChildren(...children) {
        for (const child of [...this.children]) child.remove();
        text = '';
        this.append(...children);
      },
      contains(node) { return node === this || this.children.some(child => child.contains(node)); },
      querySelector(selector) {
        const field = selector.match(/^\[data-picker-field="([^"]+)"\]$/)?.[1];
        assert.ok(field, '仅按模板字段查询');
        return this.children.find(child => child.dataset.pickerField === field) ?? null;
      },
      addEventListener(type, handler) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(handler);
      },
      fire(type, event = {}) { for (const handler of listeners.get(type) || []) handler(event); },
      focus() {
        if (this.disabled || env.document.activeElement === this) return;
        env.document.activeElement = this;
        this.fire('focus');
      },
      scrollIntoView(options) { this.scrolled = options; },
    };
  }
  env.document = makeNode('document');
  env.document.body = makeNode('body');
  env.document.activeElement = env.document.body;
  env.node = id => {
    if (!nodes.has(id)) nodes.set(id, makeNode(id));
    return nodes.get(id);
  };
  env.node('account-picker').append(env.node('account-picker-trigger'), env.node('account-picker-list'));
  env.node('account-picker-trigger').append(env.node('account-picker-title'), env.node('account-picker-status'));
  env.node('account-picker-list').hidden = true;
  env.node('account').value = selected || '';
  env.component = id => {
    assert.equal(id, 'ui-account-option');
    const option = makeNode();
    for (const field of fields) {
      const node = makeNode();
      node.dataset.pickerField = field;
      option.append(node);
    }
    return option;
  };
  env.guard = async () => env.allowed;
  env.respond = async () => ({ ok: true });
  new Function('env', `
    const $ = env.node, document = env.document, component = env.component;
    const Date = { now: () => ${now} };
    const clear = node => { node.replaceChildren(); return node; };
    const reportError = error => env.errors.push(error);
    const refreshAccountStatuses = async () => { env.refreshes++; };
    const configMayChangeAccount = async id => { env.guards.push(id); return env.guard(id); };
    const call = async (route, options) => {
      const record = { route, payload: JSON.parse(options.body) };
      env.calls.push(record);
      return env.respond(record);
    };
    let accounts = env.rows, current = env.selected, accountSelectionVersion = 0;
    let snapshot = accounts.find(account => account.id === current)?.status ?? {};
    const connectingAccounts = new Set();
    function selectLoadedAccount(id) {
      accountSelectionVersion++;
      current = id;
      snapshot = accounts.find(account => account.id === current)?.status ?? {};
      $('account').value = current || '';
      env.selections.push(id);
      renderAccountPicker();
    }
    ${pageScript.slice(statusStart, statusEnd)}
    ${pageScript.slice(changeStart, changeEnd)}
    // 页面首次setBusy可能发生在picker初始化前。
    renderAccountPicker();
    ${script}
    env.api = {
      render: renderAccountPicker, open: openAccountPicker, close: closeAccountPicker,
      choose: chooseAccountPicker, current: () => current, connectingAccounts,
      setRows(rows) { accounts = rows; },
      setSnapshot(status) { snapshot = status; },
    };
  `)(env);
  env.option = id => env.node('account-picker-list').children.find(option => option.accountId === id);
  env.field = (id, field) => env.option(id).querySelector('[data-picker-field="' + field + '"]');
  env.key = (id, key) => {
    const event = { key, prevented: false, preventDefault() { this.prevented = true; } };
    env.node(id).onkeydown(event);
    return event;
  };
  return env;
}

await test('页面使用可访问的按钮、列表框和隐藏select，选项模板具备标题状态和选中标记', async () => {
  assert.deepEqual(fields, ['title', 'status', 'check']);
  assert.match(PAGE, /<select\b[^>]*id="account"[^>]*hidden=""/);
  assert.match(PAGE, /id="account-picker-trigger"[^>]*aria-haspopup="listbox"/);
  assert.match(PAGE, /id="account-picker-list"[^>]*role="listbox"/);
  assert.match(template, /role="option"/);
  assert.match(template, /tabindex="-1"/);
  assert.ok(PAGE.includes(script));
});

await test('空账号显示没有账号并禁用打开，旧账号缺省状态可正常显示', async () => {
  const empty = fixture([]);
  assert.equal(empty.node('account-picker-title').textContent, '没有账号');
  assert.equal(empty.node('account-picker-trigger').disabled, true);
  assert.equal(empty.node('account-picker-status').hidden, true);
  empty.api.open();
  assert.equal(empty.node('account-picker-list').hidden, true);
  assert.equal(empty.refreshes, 0);
  const legacy = fixture([{ id: 'legacy', title: '旧账号' }]);
  legacy.api.open();
  assert.equal(legacy.field('legacy', 'status').textContent, '未连接');
  assert.equal(legacy.node('account-picker-status').textContent, '未连接');
});

await test('多账号各自显示状态和颜色，当前账号使用snapshot并保留完整重连倒计时', async () => {
  const env = fixture([
    { id: 'a', title: '在线', status: {} },
    { id: 'b', title: '暂停', status: { paused: true } },
    { id: 'c', title: '重连', status: { reconnecting: true, loginRecovery: { nextAttemptAt: now + 2500 } } },
    { id: 'd', title: '恢复', status: { loginBlocked: true } },
    { id: 'e', title: '同步', status: { syncingProduction: true } },
    { id: 'f', title: '离线', status: null },
    { id: 'g', title: '连接', status: {} },
  ]);
  env.api.setSnapshot({ connected: true });
  env.api.connectingAccounts.add('g');
  env.api.open();
  for (const [id, status, kind] of [
    ['a', '已连接 · 未挂机', 'done'], ['b', '已暂停 · 可自行上号', 'waiting'],
    ['c', '异地登录 · 3 秒后重试', 'waiting'], ['d', '异地登录 · 等待恢复托管', 'waiting'],
    ['e', '正在同步生产状态', 'waiting'], ['f', '未连接', 'blocked'], ['g', '连接中…', 'waiting'],
  ]) {
    assert.equal(env.field(id, 'status').textContent, status);
    assert.equal(env.field(id, 'status').classList.contains(kind), true);
    assert.equal(env.option(id).getAttribute('aria-selected'), String(id === 'a'));
    assert.equal(env.field(id, 'check').hidden, id !== 'a');
  }
  assert.equal(env.node('account-picker-status').textContent, '已连接 · 未挂机');
  env.api.render('连接中…');
  assert.equal(env.node('account-picker-status').textContent, '连接中');
  assert.equal(env.field('a', 'status').textContent, '连接中…');
  assert.equal(env.calls.length, 0, '渲染和状态刷新只读，不触发账号或游戏操作');
  assert.equal(env.api.current(), 'a');
});

await test('页头和下拉选项区分挂机、空闲连接与暂停中，并保留各账号状态', async () => {
  const env = fixture([
    { id: 'a', title: '主号', status: { connected: true, looping: true } },
    { id: 'b', title: '副号', status: { connected: true, looping: false } },
  ]);
  env.api.open();
  for (const [status, label, kind] of [
    [{ connected: true, looping: true }, '挂机中', 'done'],
    [{ connected: true, looping: true, loopStopping: true }, '暂停中…', 'waiting'],
    [{ connected: true, looping: false }, '已连接 · 未挂机', 'done'],
    [{ state: 'CONNECTING', looping: true }, '连接中…', 'waiting'],
    [{ connected: false, looping: true }, '挂机中 · 等待连接', 'waiting'],
  ]) {
    env.api.setSnapshot(status);
    env.api.render();
    assert.equal(env.node('account-picker-status').textContent, label === '连接中…' ? '连接中' : label);
    assert.equal(env.field('a', 'status').textContent, label);
    assert.equal(env.field('a', 'status').classList.contains(kind), true);
    assert.equal(env.field('b', 'status').textContent, '已连接 · 未挂机');
  }
});

await test('长账号标题按纯文本呈现，状态在独立字段中完整显示', async () => {
  const title = '<img src=x onerror=alert(1)>主号 · ' + '很长的角色名称'.repeat(30) + ' · 海港999服';
  const env = fixture([{ id: 'a', title, status: { paused: true } }]);
  env.api.open();
  assert.equal(env.node('account-picker-title').textContent, title);
  assert.equal(env.field('a', 'title').textContent, title);
  assert.equal(env.field('a', 'status').textContent, '已暂停 · 可自行上号');
  assert.equal(env.option('a').getAttribute('aria-label'), title + ' · 已暂停 · 可自行上号');
  assert.equal(env.field('a', 'title').children.length, 0);
});

await test('聚焦与打开刷新状态，打开定位当前账号且按钮可收起列表', async () => {
  const env = fixture(undefined, 'b');
  const trigger = env.node('account-picker-trigger');
  trigger.focus();
  assert.equal(env.refreshes, 1);
  trigger.onclick();
  assert.equal(env.refreshes, 2);
  assert.equal(env.document.activeElement, env.option('b'));
  assert.deepEqual(env.option('b').scrolled, { block: 'nearest' });
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  trigger.onclick();
  assert.equal(env.node('account-picker-list').hidden, true);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});

await test('方向键及Home和End导航，Escape回焦点，Tab允许浏览器继续跳出', async () => {
  const env = fixture();
  for (const [key, expected] of [['ArrowDown', 'a'], ['ArrowUp', 'c'], ['Home', 'a'], ['End', 'c']]) {
    assert.equal(env.key('account-picker-trigger', key).prevented, true);
    assert.equal(env.document.activeElement, env.option(expected));
    env.api.close();
  }
  env.api.open();
  for (const [key, expected] of [['ArrowDown', 'b'], ['ArrowDown', 'c'], ['ArrowDown', 'c'], ['ArrowUp', 'b'], ['Home', 'a'], ['ArrowUp', 'a'], ['End', 'c']]) {
    assert.equal(env.key('account-picker-list', key).prevented, true);
    assert.equal(env.document.activeElement, env.option(expected));
  }
  assert.equal(env.key('account-picker-list', 'Escape').prevented, true);
  assert.equal(env.document.activeElement, env.node('account-picker-trigger'));
  assert.equal(env.node('account-picker-list').hidden, true);
  env.api.open();
  assert.equal(env.key('account-picker-list', 'Tab').prevented, false);
  assert.equal(env.node('account-picker-list').hidden, true);
  assert.equal(env.document.activeElement, env.node('account-picker-trigger'));
});

await test('点击选项沿用真实select切号入口，关闭回焦点并更新当前状态', async () => {
  const env = fixture();
  env.api.open();
  await env.option('b').onclick();
  assert.deepEqual(env.guards, ['b']);
  assert.deepEqual(env.calls, [{ route: '/api/accounts/active', payload: { confirm: true, id: 'b' } }]);
  assert.deepEqual(env.selections, ['b']);
  assert.equal(env.api.current(), 'b');
  assert.equal(env.node('account').value, 'b');
  assert.equal(env.node('account-picker-title').textContent, '乙角色 · 海港2服');
  assert.equal(env.node('account-picker-status').textContent, '已暂停');
  assert.equal(env.document.activeElement, env.node('account-picker-trigger'));
  assert.equal(env.node('account-picker-list').hidden, true);
  await env.api.choose('b');
  await env.api.choose('forged');
  assert.equal(env.calls.length, 1);
  assert.equal(env.guards.length, 1);
});

await test('草稿拒绝和确认失败均恢复当前账号值，避免标题或选中标记串号', async () => {
  const env = fixture();
  env.allowed = false;
  await env.api.choose('b');
  assert.equal(env.api.current(), 'a');
  assert.equal(env.node('account').value, 'a');
  assert.equal(env.node('account-picker-title').textContent, '甲角色 · 海港1服');
  assert.equal(env.calls.length, 0);
  env.guard = async () => { throw new Error('配置确认失败'); };
  await env.api.choose('c');
  assert.equal(env.node('account').value, 'a');
  assert.equal(env.api.current(), 'a');
  assert.equal(env.errors[0].message, '配置确认失败');
  env.api.open();
  assert.equal(env.option('a').getAttribute('aria-selected'), 'true');
  assert.equal(env.option('c').getAttribute('aria-selected'), 'false');
});

await test('保存当前账号接口失败后报告错误，并遵循原入口已切换的当前账号', async () => {
  const env = fixture();
  env.respond = async () => { throw new Error('网络失败'); };
  await env.api.choose('b');
  assert.equal(env.errors[0].message, '网络失败');
  assert.equal(env.api.current(), 'b');
  assert.equal(env.node('account').value, 'b');
  assert.equal(env.node('account-picker-title').textContent, '乙角色 · 海港2服');
  assert.equal(env.node('account-picker-list').hidden, true);
  assert.equal(env.node('account-picker-trigger').disabled, false);
});

await test('轮询原位更新每项状态并保留聚焦，账号移除后聚焦仍在有效选项', async () => {
  const env = fixture();
  env.api.open();
  const original = new Map(env.node('account-picker-list').children.map(option => [option.accountId, option]));
  const moves = env.node('account-picker-list').moves;
  env.option('b').focus();
  env.rows[1].status = { connected: true };
  env.api.render();
  for (const [id, option] of original) assert.equal(env.option(id), option);
  assert.equal(env.node('account-picker-list').moves, moves);
  assert.equal(env.document.activeElement, original.get('b'));
  assert.equal(env.field('b', 'status').textContent, '已连接 · 未挂机');
  assert.equal(env.field('b', 'status').classList.contains('waiting'), false);
  assert.equal(env.field('b', 'status').classList.contains('done'), true);
  env.api.setRows(env.rows.filter(row => row.id !== 'b'));
  env.api.render();
  assert.equal(env.option('b'), undefined);
  assert.equal(env.document.activeElement, env.option('a'));
  env.api.setRows([]);
  env.api.render();
  assert.equal(env.node('account-picker-list').hidden, true);
  assert.equal(env.node('account-picker-list').children.length, 0);
  assert.equal(env.node('account-picker-trigger').disabled, true);
});

await test('外部点击关闭列表，内部点击保持展开且不强行改动外部焦点', async () => {
  const env = fixture();
  env.api.open();
  env.document.fire('pointerdown', { target: env.field('b', 'title') });
  assert.equal(env.node('account-picker-list').hidden, false);
  const outside = env.node('outside');
  outside.focus();
  env.document.fire('pointerdown', { target: outside });
  assert.equal(env.node('account-picker-list').hidden, true);
  assert.equal(env.document.activeElement, outside);
  assert.equal(env.calls.length, 0);
});

await test('快速重新选择账号时旧草稿确认不能覆盖较新的选择', async () => {
  const env = fixture();
  const oldGuard = deferred();
  env.guard = id => id === 'b' ? oldGuard.promise : true;
  const first = env.api.choose('b');
  await env.api.choose('c');
  oldGuard.resolve(true);
  await first;
  assert.equal(env.api.current(), 'c');
  assert.equal(env.node('account').value, 'c');
  assert.deepEqual(env.selections, ['c']);
  assert.deepEqual(env.calls.map(call => call.payload.id), ['c']);
  assert.equal(env.node('account-picker-title').textContent, '丙角色 · 海港3服');
});

await test('草稿确认在途时重选当前账号，使旧切号意图失效', async () => {
  const env = fixture();
  const oldGuard = deferred();
  env.guard = () => oldGuard.promise;
  const pending = env.api.choose('b');
  assert.equal(env.node('account').value, 'b');
  assert.equal(env.api.current(), 'a');
  env.api.open();
  await env.option('a').onclick();
  assert.equal(env.node('account').value, 'a');
  oldGuard.resolve(true);
  await pending;
  assert.equal(env.api.current(), 'a');
  assert.equal(env.node('account').value, 'a');
  assert.deepEqual(env.guards, ['b']);
  assert.deepEqual(env.selections, []);
  assert.deepEqual(env.calls, []);
  assert.equal(env.node('account-picker-title').textContent, '甲角色 · 海港1服');
});

console.log(`账号下拉框自检通过 ${passed} 项`);
