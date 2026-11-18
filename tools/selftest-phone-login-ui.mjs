import { newStateFunction } from './fixtures/console-state.mjs';
// 执行真实登录界面脚本，使用可控时钟和模拟请求覆盖交互及失败恢复。
import assert from 'node:assert/strict';
import fs from 'node:fs';

const script = fs.readFileSync(new URL('../src/phone-login-ui.js', import.meta.url), 'utf8');
const prefix = '/api/accounts/phone-login';
const fixedNow = 1_794_830_400_000;
let passed = 0;

async function test(name, run) {
  await run();
  passed++;
  console.log('通过：' + name);
}

const settle = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture({ detailOwner = 'previous-account', savedChannel = null, storageBlocked = false, wizard = false } = {}) {
  let now = fixedNow;
  let nextTimer = 0;
  const timers = new Map();
  const nodes = new Map();
  const env = {
    calls: [], selections: [], loadCalls: [], renderCount: 0, allowed: true, focus: null,
    confirmation: null, mayChangeCalls: [], accounts: [{ id: 'previous-account', title: '当前账号' }],
    disconnected: new Set(), disconnectedAtSelection: [], detailOwner, detailsAtSelection: [],
    preferences: new Map(), storageCalls: [], wizard, wizardEvents: [],
  };
  if (savedChannel !== null) env.preferences.set('phone-login-channel', savedChannel);
  env.storage = {
    getItem(key) {
      env.storageCalls.push({ method: 'getItem', key });
      if (storageBlocked) throw new Error('模拟浏览器存储不可用');
      return env.preferences.get(key) ?? null;
    },
    setItem(key, value) {
      env.storageCalls.push({ method: 'setItem', key });
      if (storageBlocked) throw new Error('模拟浏览器存储不可用');
      env.preferences.set(key, value);
    },
  };
  function makeNode(id = '') {
    const attributes = new Map();
    let text = '';
    const node = {
      id, value: '', hidden: false, disabled: false, className: '', type: '', open: false,
      tabIndex: 0, files: [], children: [],
      get textContent() { return text + this.children.map(child => child.textContent).join(''); },
      set textContent(value) { text = String(value ?? ''); this.children = []; },
      setAttribute(key, value) { attributes.set(key, String(value)); },
      getAttribute(key) { return attributes.get(key) ?? null; },
      removeAttribute(key) { attributes.delete(key); },
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); return child; },
      focus() { env.focus = id; },
    };
    return node;
  }
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, makeNode(id));
    return nodes.get(id);
  }
  node('phone-password').type = 'password';
  node('phone-password-tab').setAttribute('aria-selected', 'true');
  node('phone-sms-tab').setAttribute('aria-selected', 'false');
  node('phone-sms-tab').tabIndex = -1;
  for (const id of ['phone-sms-panel', 'phone-preview', 'phone-success']) node(id).hidden = true;
  node('phone-save').disabled = true;
  node('phone-login').textContent = '登录并读取角色';
  node('phone-sms-login').textContent = '验证并读取角色';
  const preview = {
    id: 'preview-1', phone: '138****8000', expiresAt: fixedNow + 600_000, linkedAccountCount: 1,
    choices: [{
      id: 'choice-1', accountId: 'saved-account', userName: 'APP测试账号', nickname: '海上测试船长',
      level: 35, power: 123456, worldId: 3000000123, worldName: '海港123服',
      roleWorldId: 3000000123, roleWorldName: '海港123服', matched: false, existingTitle: null,
    }],
    failures: [], emptyAccounts: [],
  };
  const device = {
    deviceReady: true, devicePath: 'C:\\fixture\\ewan-device.json', deviceModel: 'Test Phone',
    deviceSource: 'imported', deviceError: null,
  };
  env.respond = async (route, payload) => {
    if (route === prefix || route === prefix + '/roles') return { ...preview };
    if (route === prefix + '/save') {
      const choice = preview.choices.find(item => item.id === payload.choiceId);
      assert.ok(choice, '保存必须提交本次可选角色的 choiceId');
      return { account: { id: choice.accountId, title: '保存的APP账号' } };
    }
    if (route === prefix + '/send-code') return { cooldown: 60 };
    if (route === prefix + '/device' || route === prefix + '/status') return { ...device };
    if (route === prefix + '/cancel') return { ok: true };
    assert.fail('未预期的请求 ' + route);
  };
  env.call = async (route, options) => {
    const payload = options?.body ? JSON.parse(options.body) : null;
    env.calls.push({ route, payload });
    return env.respond(route, payload);
  };
  env.node = node;
  env.element = (tag, className, text) => {
    const element = makeNode();
    element.tagName = tag;
    element.className = className || '';
    element.textContent = text;
    return element;
  };
  env.clear = element => { element.textContent = ''; return element; };
  env.setTimer = (callback, delay, interval = false) => {
    const id = ++nextTimer;
    timers.set(id, { callback, at: now + delay, interval: interval ? delay : 0 });
    return id;
  };
  env.clearTimer = id => timers.delete(id);
  env.now = () => now;
  env.confirm = (title, body, callback) => { env.confirmation = { title, body, callback }; };
  env.mayChange = async next => { env.mayChangeCalls.push(next); return env.allowed; };
  env.loadAccounts = async reload => {
    env.loadCalls.push(reload);
    await env.onLoad?.();
  };
  env.select = next => {
    env.selections.push(next);
    env.disconnectedAtSelection.push(env.disconnected.has(next));
  };
  env.render = () => env.renderCount++;
  newStateFunction('env', `
    'use strict';
    const $ = env.node, el = env.element, clear = env.clear, call = env.call;
    const localStorage = env.storage;
    const Date = { now: env.now };
    const setTimeout = (callback, delay) => env.setTimer(callback, delay);
    const setInterval = (callback, delay) => env.setTimer(callback, delay, true);
    const clearTimeout = env.clearTimer, clearInterval = env.clearTimer;
    const openConfirm = env.confirm, configMayChangeAccount = env.mayChange;
    const loadAccounts = env.loadAccounts, renderAccounts = env.render;
    let accounts = env.accounts;
    stateActions.replaceAccounts(accounts, accounts[0]?.id);
    consoleStore.subscribe(state => {
      accounts = env.accounts = CWConsoleState.selectAccounts(state);
      env.disconnected = state.disconnected;
    });
    const accountAddChanged = env.wizard ? (...args) => env.wizardEvents.push(args) : undefined;
    let snapshot = {};
    let accountDetailsOwner = env.detailOwner;
    function selectLoadedAccount(next) {
      env.detailsAtSelection.push(accountDetailsOwner);
      accountDetailsOwner = next;
      env.select(next);
      snapshot = accounts.find(account => account.id === next)?.status ?? {};
    }
    ${script}
    env.reset = resetPhoneLogin;
  `)(env);

  function descendants(element) {
    return element.children.flatMap(child => [child, ...descendants(child)]);
  }
  return {
    env, node, preview,
    calls(suffix = '') { return env.calls.filter(entry => entry.route === prefix + suffix); },
    input(id, value) { node(id).value = value; node(id).oninput?.(); },
    click(id) { return node(id).onclick(); },
    roles() { return descendants(node('phone-result')).filter(element => element.type === 'radio'); },
    chooseRole(index = 0) {
      const choices = this.roles();
      assert.ok(choices[index], '角色选项必须存在');
      for (const choice of choices) choice.checked = false;
      choices[index].checked = true;
      choices[index].onchange();
    },
    submit(mode = 'password') {
      let prevented = false;
      const result = node('phone-' + mode + '-panel').onsubmit({ preventDefault() { prevented = true; } });
      assert.equal(prevented, true, '表单提交必须阻止浏览器导航');
      return result;
    },
    key(id, key) {
      let prevented = false;
      node(id).onkeydown({ key, preventDefault() { prevented = true; } });
      return prevented;
    },
    async login() {
      node('phone-account').value = 'app-user';
      node('phone-password').value = 'fixture-password';
      await this.submit();
    },
    async sendCode() {
      this.click('phone-send-code');
      assert.ok(env.confirmation, '发送前应显示确认');
      const confirmation = env.confirmation;
      env.confirmation = null;
      await confirmation.callback();
    },
    async tick(milliseconds) {
      const end = now + milliseconds;
      let executions = 0;
      await settle();
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        assert(++executions < 1000, '定时器不能无限执行');
        const [id, timer] = next;
        now = timer.at;
        if (timer.interval) timer.at += timer.interval;
        else timers.delete(id);
        timer.callback();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

function addMultipleRoles(fixture) {
  const first = fixture.preview.choices[0];
  fixture.preview.linkedAccountCount = 2;
  fixture.preview.choices.push(
    { ...first, id: 'choice-2', nickname: '远航船长', level: 56, power: 345678,
      worldId: 3000000456, worldName: '海港456服', roleWorldId: 3000000456, roleWorldName: '海港456服',
      matched: true, existingTitle: '已有APP记录' },
    { ...first, id: 'choice-3', accountId: 'second-app-account', userName: '另一个APP账号', nickname: '灯塔船长',
      worldId: 4000000789, worldName: '海灯789服', roleWorldId: 4000000789, roleWorldName: '海灯789服' },
  );
}

await test('空表单定位缺失字段，输入后清除校验状态', async () => {
  const f = fixture();
  await f.submit();
  assert.equal(f.env.focus, 'phone-account');
  assert.equal(f.node('phone-account').getAttribute('aria-invalid'), 'true');
  assert.equal(f.calls().length, 0);
  f.input('phone-account', 'app-user');
  assert.equal(f.node('phone-account').getAttribute('aria-invalid'), null);
  await f.submit();
  assert.equal(f.env.focus, 'phone-password');
  f.click('phone-sms-tab');
  f.input('phone-number', 'abc');
  await f.submit('sms');
  assert.equal(f.env.focus, 'phone-number');
  f.input('phone-number', '13800138000');
  await f.submit('sms');
  assert.equal(f.env.focus, 'phone-code');
  assert.equal(f.calls().length, 0);
});

await test('密码表单支持提交且不会混入短信验证码', async () => {
  const f = fixture();
  f.input('phone-account', ' app-user ');
  f.input('phone-password', ' password with spaces ');
  f.input('phone-code', '654321');
  f.click('phone-password-toggle');
  assert.equal(f.node('phone-password').type, 'text');
  await f.submit();
  assert.deepEqual(f.calls()[0].payload, { confirm: true, phone: 'app-user', password: ' password with spaces ' });
  assert.equal(f.node('phone-password').value, '');
  assert.equal(f.node('phone-code').value, '');
  assert.equal(f.node('phone-password').type, 'password');
  assert.equal(f.node('phone-entry').hidden, true);
  assert.equal(f.node('phone-preview').hidden, false);
  assert.equal(f.node('phone-save').disabled, true, '单角色也应由用户主动选择后保存');
  assert.equal(f.roles().length, 1);
  assert.equal(f.roles()[0].checked, false);
  await f.click('phone-save');
  assert.equal(f.calls('/save').length, 0);
  assert.match(f.node('phone-hint').textContent, /先选择/);
  f.chooseRole();
  assert.equal(f.node('phone-save').disabled, false);
  assert.match(f.node('phone-selection').textContent, /海上测试船长.*海港123服/);
});

await test('登录方式切换保留手机号并支持键盘，短信请求只发送验证码', async () => {
  const f = fixture();
  f.input('phone-account', '13800138000');
  f.input('phone-password', 'old-password');
  assert.equal(f.key('phone-password-tab', 'ArrowRight'), true);
  assert.equal(f.env.focus, 'phone-sms-tab');
  assert.equal(f.node('phone-number').value, '13800138000');
  assert.equal(f.node('phone-password-panel').hidden, true);
  assert.equal(f.node('phone-sms-panel').hidden, false);
  assert.equal(f.node('phone-sms-tab').getAttribute('aria-selected'), 'true');
  assert.equal(f.node('phone-password-tab').tabIndex, -1);
  assert.equal(f.key('phone-sms-tab', 'Home'), true);
  assert.equal(f.env.focus, 'phone-password-tab');
  f.key('phone-password-tab', 'End');
  f.input('phone-code', ' 123456 ');
  await f.submit('sms');
  assert.deepEqual(f.calls()[0].payload, { confirm: true, phone: '13800138000', code: '123456' });
});

await test('账号页移除渠道选择及帮助，保留两种登录方式', async () => {
  const { accountPage } = await import('../src/ui/dist/console.mjs');
  const markup = accountPage();
  assert.doesNotMatch(markup, /phone-channel|MuMu 当前安装包|小米版/);
  assert.match(markup, /id="phone-password-panel"/);
  assert.match(markup, /id="phone-sms-panel"/);
  assert.doesNotMatch(script, /phoneChannel|phone-channel|phone-login-channel/);
});

await test('历史小米渠道缓存不参与密码登录请求', async () => {
  const f = fixture({ savedChannel: 'xiaomi' });
  await f.login();
  assert.deepEqual(f.calls()[0].payload, {
    confirm: true, phone: 'app-user', password: 'fixture-password',
  });
  assert.deepEqual(f.env.storageCalls, []);
  assert.equal(f.env.preferences.get('phone-login-channel'), 'xiaomi');
});

await test('历史小米渠道缓存不参与短信发送和验证码登录请求', async () => {
  const f = fixture({ savedChannel: 'xiaomi' });
  f.click('phone-sms-tab');
  f.input('phone-number', '13800138000');
  await f.sendCode();
  assert.deepEqual(f.calls('/send-code')[0].payload, {
    confirm: true, phone: '13800138000',
  });
  f.input('phone-code', '123456');
  await f.submit('sms');
  assert.deepEqual(f.calls()[0].payload, {
    confirm: true, phone: '13800138000', code: '123456',
  });
  assert.deepEqual(f.env.storageCalls, []);
  assert.equal(f.env.preferences.get('phone-login-channel'), 'xiaomi');
});

await test('浏览器禁用存储时登录继续使用统一配置', async () => {
  const blocked = fixture({ savedChannel: 'xiaomi', storageBlocked: true });
  await blocked.login();
  assert.deepEqual(blocked.calls()[0].payload, {
    confirm: true, phone: 'app-user', password: 'fixture-password',
  });
  assert.deepEqual(blocked.env.storageCalls, []);
});

await test('登录在途时锁定两种提交与短信入口，重复提交仅请求一次', async () => {
  const f = fixture();
  const pending = deferred();
  f.env.respond = () => pending.promise;
  f.input('phone-account', 'app-user');
  f.input('phone-password', 'password');
  const login = f.submit();
  for (const id of ['phone-login', 'phone-sms-login', 'phone-send-code', 'phone-account', 'phone-sms-tab', 'phone-device-file']) {
    assert.equal(f.node(id).disabled, true, id);
  }
  await f.submit();
  await f.submit('sms');
  f.click('phone-send-code');
  f.click('phone-sms-tab');
  assert.equal(f.node('phone-password-panel').hidden, false);
  assert.equal(f.calls().length, 1);
  pending.reject(new Error('模拟登录服务不可用'));
  await login;
  assert.match(f.node('phone-hint').textContent, /服务不可用/);
  assert.equal(f.node('phone-entry').hidden, false);
  assert.equal(f.node('phone-login').disabled, false);
  assert.equal(f.node('phone-sms-login').disabled, false);
});

await test('验证码发送失败可重试，发送在途阻止重复操作', async () => {
  const f = fixture();
  f.click('phone-sms-tab');
  f.input('phone-number', '13800138000');
  const pending = deferred();
  f.env.respond = () => pending.promise;
  f.click('phone-send-code');
  assert.equal(f.calls('/send-code').length, 0);
  const send = f.env.confirmation.callback();
  assert.equal(f.node('phone-send-code').disabled, true);
  assert.equal(f.node('phone-sms-login').disabled, true);
  f.click('phone-send-code');
  await f.env.confirmation.callback();
  assert.equal(f.calls('/send-code').length, 1);
  pending.reject(new Error('模拟发送失败'));
  await send;
  assert.equal(f.node('phone-send-code').disabled, false);
  assert.match(f.node('phone-hint').textContent, /发送失败/);
  f.env.respond = async () => ({ cooldown: 60 });
  await f.sendCode();
  assert.equal(f.calls('/send-code').length, 2);
  assert.equal(f.node('phone-send-code').disabled, true);
  assert.equal(f.env.focus, 'phone-code');
});

await test('验证码冷却绑定手机号，改手机号清空旧验证码', async () => {
  const f = fixture();
  f.click('phone-sms-tab');
  f.input('phone-number', '13800138000');
  await f.sendCode();
  assert.match(f.node('phone-send-code').textContent, /60 秒/);
  f.input('phone-code', '123456');
  f.input('phone-number', '13900139000');
  assert.equal(f.node('phone-code').value, '');
  assert.equal(f.node('phone-send-code').disabled, false);
  f.input('phone-number', '13800138000');
  assert.equal(f.node('phone-send-code').disabled, true);
  await f.tick(59_000);
  assert.match(f.node('phone-send-code').textContent, /1 秒/);
  await f.tick(1000);
  assert.equal(f.node('phone-send-code').disabled, false);
});

await test('登录预览到期后阻止保存，返回后清理服务端预览', async () => {
  const f = fixture();
  addMultipleRoles(f);
  await f.login();
  f.chooseRole();
  const selection = f.node('phone-selection').textContent;
  await f.tick(600_000);
  assert.equal(f.node('phone-save').disabled, true);
  assert.equal(f.node('phone-roles-retry').disabled, true);
  assert.ok(f.roles().every(input => input.disabled));
  f.chooseRole(1);
  assert.equal(f.node('phone-selection').textContent, selection, '过期后即使程序触发change也不能改选');
  assert.match(f.node('phone-expiry').textContent, /过期/);
  await f.click('phone-save');
  await f.click('phone-roles-retry');
  assert.equal(f.calls('/save').length, 0);
  assert.equal(f.calls('/roles').length, 0);
  await f.click('phone-back');
  assert.deepEqual(f.calls('/cancel')[0].payload, { id: 'preview-1' });
  assert.equal(f.node('phone-entry').hidden, false);
  assert.equal(f.node('phone-preview').hidden, true);
  assert.equal(f.node('phone-result').textContent, '');
  await f.click('phone-save');
  assert.equal(f.calls('/save').length, 0);
});

for (const index of [1, 2]) {
  await test('多APP账号的全部角色可见，选择第' + (index + 1) + '个后保存对应区服', async () => {
    const f = fixture();
    addMultipleRoles(f);
    f.click('phone-sms-tab');
    f.input('phone-number', '13800138000');
    f.input('phone-code', '123456');
    await f.submit('sms');
    assert.equal(f.roles().length, 3);
    assert.ok(f.roles().every(input => !input.checked));
    assert.equal(f.node('phone-save').disabled, true);
    const text = f.node('phone-result').textContent;
    for (const value of ['2 个 APP 账号', '3 个角色', 'APP测试账号', '另一个APP账号',
      '海上测试船长', '远航船长', '灯塔船长', '海港123服', '海港456服', '海灯789服',
      '等级 56', '战力 345,678', '已有APP记录']) {
      assert.ok(text.includes(value), '应显示 ' + value);
    }
    assert.equal(text.includes('openId'), false);
    assert.equal(text.includes('saved-account'), false);
    const choice = f.preview.choices[index];
    f.chooseRole(index);
    assert.equal(f.node('phone-save').disabled, false);
    assert.equal(f.node('phone-selection').textContent, '已选择 ' + choice.nickname + ' · ' + choice.worldName);
    await f.click('phone-save');
    assert.deepEqual(f.env.mayChangeCalls, [choice.accountId]);
    assert.deepEqual(f.calls('/save')[0].payload, { confirm: true, id: 'preview-1', choiceId: choice.id });
    assert.deepEqual(f.env.selections, [choice.accountId]);
    assert.equal(f.node('phone-saved-account').textContent, choice.nickname + ' · ' + choice.worldName);
  });
}

await test('无已有角色时展示账号说明并阻止保存', async () => {
  const f = fixture();
  f.preview.choices = [];
  f.preview.emptyAccounts = [{ userName: '尚未创建角色的账号' }];
  await f.login();
  assert.equal(f.roles().length, 0);
  assert.equal(f.node('phone-save').disabled, true);
  assert.equal(f.node('phone-roles-retry').hidden, true);
  assert.match(f.node('phone-result').textContent, /尚未创建角色的账号.*暂无已有角色/);
  assert.match(f.node('phone-selection').textContent, /没有可选择的角色/);
  await f.click('phone-save');
  assert.equal(f.calls('/save').length, 0);
  assert.equal(f.env.mayChangeCalls.length, 0);
});

await test('部分账号读取失败可重试，刷新失败及角色标识变化仍保留选择', async () => {
  const f = fixture();
  addMultipleRoles(f);
  f.preview.failures = [
    { userName: '待读取账号', error: '临时连接超时', retryable: true },
    { userName: '认证失败账号', error: '登录凭证过期', retryable: false },
  ];
  await f.login();
  f.chooseRole(1);
  assert.equal(f.node('phone-roles-retry').hidden, false);
  assert.match(f.node('phone-result').textContent, /待读取账号.*读取失败.*连接超时/);
  assert.match(f.node('phone-result').textContent, /认证失败的账号需要返回重新登录/);
  const selection = f.node('phone-selection').textContent;
  const respond = f.env.respond;
  f.env.respond = async (route, payload) => {
    if (route === prefix + '/roles') throw new Error('模拟角色列表重试失败');
    return respond(route, payload);
  };
  await f.click('phone-roles-retry');
  assert.match(f.node('phone-hint').textContent, /重试失败/);
  assert.equal(f.node('phone-selection').textContent, selection);
  assert.equal(f.node('phone-save').disabled, false);
  const pending = deferred();
  f.env.respond = (route, payload) => route === prefix + '/roles' ? pending.promise : respond(route, payload);
  const refresh = f.click('phone-roles-retry');
  assert.equal(f.node('phone-save').disabled, true);
  assert.equal(f.node('phone-roles-retry').disabled, true);
  assert.ok(f.roles().every(input => input.disabled));
  f.chooseRole(2);
  assert.equal(f.node('phone-selection').textContent, selection, '读取在途时不能改变所选角色');
  f.preview.choices = f.preview.choices.map(choice => ({ ...choice, id: 'refreshed-' + choice.id }));
  f.preview.choices.push({ ...f.preview.choices[0], id: 'recovered-role', accountId: 'recovered-app',
    userName: '待读取账号', nickname: '重新读到的角色', worldId: 3000000999, worldName: '海港999服',
    roleWorldId: 3000000999, roleWorldName: '海港999服' });
  f.preview.failures = [];
  pending.resolve({ ...f.preview });
  await refresh;
  assert.deepEqual(f.calls('/roles').map(call => call.payload), [
    { confirm: true, id: 'preview-1' }, { confirm: true, id: 'preview-1' },
  ]);
  assert.equal(f.roles().length, 4);
  assert.equal(f.roles().find(input => input.checked)?.value, 'refreshed-choice-2');
  assert.equal(f.node('phone-selection').textContent, selection);
  assert.match(f.node('phone-result').textContent, /重新读到的角色/);
  assert.equal(f.node('phone-roles-retry').hidden, true);
  await f.click('phone-save');
  assert.equal(f.calls('/save')[0].payload.choiceId, 'refreshed-choice-2');
});

await test('合服角色展示原区服及现区服，保存结果使用现区服名称', async () => {
  const f = fixture();
  f.preview.choices[0].roleWorldId = 3000000500;
  f.preview.choices[0].roleWorldName = '海港500服';
  await f.login();
  assert.match(f.node('phone-result').textContent, /原区服 海港123服，合服后位于 海港500服/);
  f.chooseRole();
  assert.equal(f.node('phone-selection').textContent, '已选择 海上测试船长 · 海港500服');
  await f.click('phone-save');
  assert.equal(f.node('phone-saved-account').textContent, '海上测试船长 · 海港500服');
});

await test('保存所选角色期间锁定全部选项，程序改选与重复保存不会改变请求', async () => {
  const f = fixture();
  addMultipleRoles(f);
  await f.login();
  f.chooseRole(1);
  const selection = f.node('phone-selection').textContent;
  const pending = deferred();
  const respond = f.env.respond;
  f.env.respond = (route, payload) => route === prefix + '/save' ? pending.promise : respond(route, payload);
  const saving = f.click('phone-save');
  await settle();
  assert.ok(f.roles().every(input => input.disabled));
  assert.equal(f.node('phone-save').disabled, true);
  f.chooseRole(2);
  await f.click('phone-save');
  assert.equal(f.calls('/save').length, 1);
  assert.equal(f.calls('/save')[0].payload.choiceId, 'choice-2');
  assert.equal(f.node('phone-selection').textContent, selection);
  pending.resolve({ account: { id: 'saved-account', title: '所选APP账号' } });
  await saving;
  assert.equal(f.node('phone-saved-account').textContent, '远航船长 · 海港456服');
});

await test('保存前检查当前配置，拒绝切换时保留预览', async () => {
  const f = fixture();
  await f.login();
  f.chooseRole();
  f.env.allowed = false;
  await f.click('phone-save');
  assert.deepEqual(f.env.mayChangeCalls, ['saved-account']);
  assert.equal(f.calls('/save').length, 0);
  assert.equal(f.node('phone-preview').hidden, false);
  assert.equal(f.node('phone-save').disabled, false);
  assert.match(f.node('phone-hint').textContent, /配置/);
});

await test('保存失败保留可重试预览，重试成功切换到返回账号', async () => {
  const f = fixture();
  await f.login();
  f.chooseRole();
  const respond = f.env.respond;
  f.env.respond = async (route, payload) => {
    if (route === prefix + '/save') throw new Error('模拟保存失败');
    return respond(route, payload);
  };
  await f.click('phone-save');
  assert.equal(f.node('phone-preview').hidden, false);
  assert.equal(f.node('phone-save').disabled, false);
  assert.deepEqual(f.env.selections, []);
  f.env.respond = respond;
  await f.click('phone-save');
  assert.deepEqual(f.calls('/save').map(entry => entry.payload), [
    { confirm: true, id: 'preview-1', choiceId: 'choice-1' }, { confirm: true, id: 'preview-1', choiceId: 'choice-1' },
  ]);
  assert.deepEqual(f.env.selections, ['saved-account']);
  assert.deepEqual(f.env.disconnectedAtSelection, [true], '保存未连接账号应先阻止页面读取自动连接');
  assert.match(f.node('phone-success-next').textContent, /尚未开始挂机.*「开始挂机」/);
  assert.equal(f.node('phone-success').hidden, false);
  assert.equal(f.node('phone-preview').hidden, true);
  assert.equal(f.node('phone-save').disabled, true);
  assert.equal(f.node('phone-saved-account').textContent, '海上测试船长 · 海港123服');
  assert.equal(f.env.focus, 'phone-success-title');
  await f.click('phone-add-another');
  assert.equal(f.node('phone-entry').hidden, false);
  assert.equal(f.calls('/cancel').length, 0);
});

await test('保存成功后列表刷新失败仍保持成功和当前账号，已有连接状态继续保留', async () => {
  const f = fixture();
  const status = { connected: true, paused: false };
  f.env.accounts.push({ id: 'saved-account', title: '旧标题', status });
  await f.login();
  f.chooseRole();
  f.env.onLoad = async () => { throw new Error('模拟列表刷新失败'); };
  await f.click('phone-save');
  assert.equal(f.calls('/save').length, 1);
  assert.deepEqual(f.env.selections, ['saved-account']);
  assert.deepEqual(f.env.disconnectedAtSelection, [false], '保存已连接账号保持已有连接');
  assert.equal(f.env.accounts.length, 2);
  assert.equal(f.env.accounts[1].title, '保存的APP账号');
  assert.deepEqual(f.env.accounts[1].status, status);
  assert.equal(f.node('phone-success').hidden, false);
  assert.match(f.node('phone-success-next').textContent, /所选角色已连接/);
  assert.equal(f.node('phone-preview').hidden, true);
  assert.match(f.node('phone-hint').textContent, /已保存.*刷新失败/);
  assert.equal(f.node('phone-save').disabled, true);
  await f.click('phone-save');
  assert.equal(f.calls('/save').length, 1);
  await f.click('phone-add-another');
  assert.equal(f.node('phone-entry').hidden, false);
});

await test('保存暂停或异地登录阻止的账号优先提示恢复托管', async () => {
  for (const status of [
    { paused: true, connected: false },
    { paused: true, connected: true, looping: true },
    { loginBlocked: true, connected: true, looping: true },
  ]) {
    const f = fixture();
    f.env.accounts.push({ id: 'saved-account', title: '已暂停账号', status });
    await f.login();
    f.chooseRole();
    await f.click('phone-save');
    assert.deepEqual(f.env.accounts[1].status, status);
    assert.deepEqual(f.env.disconnectedAtSelection, [!status.connected]);
    assert.match(f.node('phone-success-next').textContent, /恢复托管/);
    assert.match(f.node('phone-step').textContent, /恢复托管/);
  }
});

await test('保存后自动挂机已启动或正在连接时显示任务配置入口', async () => {
  for (const connected of [false, true]) {
    const f = fixture();
    await f.login();
    f.chooseRole();
    const respond = f.env.respond;
    f.env.respond = async (route, payload) => {
      const data = await respond(route, payload);
      if (route === prefix + '/save') data.account.status = { connected, looping: true };
      return data;
    };
    await f.click('phone-save');
    assert.match(f.node('phone-success-next').textContent, /按保存配置启动自动挂机.*「挂机配置」调整任务/);
    assert.equal(f.node('phone-step').textContent, '所选角色已保存 → 自动挂机');
    assert.equal(f.node('phone-success').hidden, false);
    assert.deepEqual(f.env.accounts[1].status, { connected, looping: true });
  }
});

await test('同一APP切换角色采用保存后的断开状态并清除旧角色详情归属', async () => {
  const f = fixture({ detailOwner: 'saved-account' });
  const previousStatus = { connected: true, paused: false };
  f.env.accounts.push({ id: 'saved-account', title: '旧角色账号', status: previousStatus });
  addMultipleRoles(f);
  await f.login();
  f.chooseRole(1);
  const savedStatus = { connected: false, paused: false };
  const respond = f.env.respond;
  f.env.respond = async (route, payload) => {
    if (route === prefix + '/save') {
      return { account: { id: 'saved-account', title: '已选择远航船长', status: savedStatus } };
    }
    return respond(route, payload);
  };
  await f.click('phone-save');
  assert.deepEqual(f.calls('/save')[0].payload, { confirm: true, id: 'preview-1', choiceId: 'choice-2' });
  assert.deepEqual(f.env.accounts[1].status, savedStatus);
  assert.equal(f.env.accounts[1].status.connected, false);
  assert.equal(previousStatus.connected, true);
  assert.deepEqual(f.env.selections, ['saved-account']);
  assert.deepEqual(f.env.detailsAtSelection, [null], '切换同一账号角色前必须失效详情归属');
  assert.deepEqual(f.env.disconnectedAtSelection, [true]);
  assert.equal(f.env.disconnected.has('saved-account'), true);
  assert.equal(f.node('phone-success').hidden, false);
  assert.equal(f.node('phone-saved-account').textContent, '远航船长 · 海港456服');
  assert.match(f.node('phone-success-next').textContent, /尚未开始挂机.*「开始挂机」/);
  assert.equal(Object.hasOwn(globalThis, 'accountDetailsOwner'), false, '界面脚本状态应留在测试闭包中');
});

await test('缺少档案时提示首次自动生成并保持高级选项收起', async () => {
  const f = fixture();
  f.env.respond = async () => ({
    deviceReady: false, devicePath: 'C:\\fixture\\ewan-device.json', deviceSource: null, deviceError: null,
  });
  await f.click('phone-device-refresh');
  assert.match(f.node('phone-device-status').textContent, /首次登录或获取验证码.*自动生成并保存/);
  assert.equal(f.node('phone-device-status').className, 'dim');
  assert.equal(f.node('phone-device-details').open, false);
  assert.match(f.node('phone-device-path').textContent, /ewan-device.json/);
  assert.equal(f.node('phone-login').disabled, false);
  assert.equal(f.calls('/status').length, 1);
  assert.equal(f.calls('/device').length, 0);
});

await test('设备状态展示生成来源并兼容无来源字段的旧档案', async () => {
  for (const source of ['generated', 'imported', undefined]) {
    const f = fixture();
    f.env.respond = async () => ({ deviceReady: true, deviceSource: source, deviceModel: 'Test Phone', deviceError: null });
    f.node('phone-device-details').open = true;
    await f.click('phone-device-refresh');
    assert.match(f.node('phone-device-status').textContent, source === 'generated' ? /自动生成并保存/ : /导入的设备档案/);
    assert.match(f.node('phone-device-status').textContent, /Test Phone/);
    assert.equal(f.node('phone-device-status').className, 'ok');
    assert.equal(f.node('phone-device-details').open, false);
  }
});

await test('损坏档案显示具体错误并展开导入入口', async () => {
  const f = fixture();
  f.env.respond = async () => ({ deviceReady: false, deviceSource: null, deviceError: 'deviceCode 格式不正确' });
  await f.click('phone-device-refresh');
  assert.match(f.node('phone-device-status').textContent, /读取失败.*deviceCode 格式不正确/);
  assert.equal(f.node('phone-device-status').className, 'bad');
  assert.equal(f.node('phone-device-details').open, true);
});

await test('状态请求失败时显示重新检查入口', async () => {
  const f = fixture();
  f.env.respond = async () => { throw new Error('模拟断网'); };
  await f.click('phone-device-refresh');
  assert.match(f.node('phone-device-status').textContent, /重新检查/);
  assert.equal(f.node('phone-device-details').open, true);
});

await test('首次发送短信后刷新已生成档案状态', async () => {
  const f = fixture();
  const respond = f.env.respond;
  let generated = false;
  f.env.respond = async (route, payload) => {
    if (route === prefix + '/send-code') generated = true;
    if (route === prefix + '/status') {
      return { deviceReady: generated, deviceSource: generated ? 'generated' : null, deviceError: null };
    }
    return respond(route, payload);
  };
  await f.click('phone-device-refresh');
  assert.match(f.node('phone-device-status').textContent, /首次登录/);
  f.input('phone-number', '13800138000');
  await f.sendCode();
  assert.match(f.node('phone-device-status').textContent, /自动生成并保存/);
  assert.equal(f.calls('/status').length, 2);
  assert.equal(f.node('phone-device-details').open, false);
});

await test('认证失败后仍刷新已保存的自动生成档案', async () => {
  const f = fixture();
  const respond = f.env.respond;
  f.env.respond = async (route, payload) => {
    if (route === prefix) throw new Error('模拟认证失败');
    if (route === prefix + '/status') return { deviceReady: true, deviceSource: 'generated', deviceError: null };
    return respond(route, payload);
  };
  await f.login();
  assert.match(f.node('phone-hint').textContent, /模拟认证失败/);
  await settle();
  assert.match(f.node('phone-device-status').textContent, /自动生成并保存/);
  assert.equal(f.node('phone-login').disabled, false);
});

await test('设备状态刷新等待响应时仍恢复登录和角色选择操作', async () => {
  const f = fixture();
  const respond = f.env.respond;
  const status = deferred();
  f.env.respond = async (route, payload) => route === prefix + '/status' ? status.promise : respond(route, payload);
  await f.login();
  assert.equal(f.node('phone-login').disabled, false);
  assert.equal(f.node('phone-preview').hidden, false);
  f.chooseRole();
  assert.equal(f.node('phone-save').disabled, false);
  status.resolve({ deviceReady: true, deviceSource: 'generated', deviceError: null });
  await settle();
  assert.match(f.node('phone-device-status').textContent, /自动生成并保存/);
});

await test('设备导入校验JSON并处理失败，成功后恢复登录操作', async () => {
  const f = fixture();
  const file = f.node('phone-device-file');
  file.files = [{ text: async () => '{invalid' }];
  await file.onchange();
  assert.match(f.node('phone-device-hint').textContent, /JSON/);
  assert.equal(f.calls('/device').length, 0);
  assert.equal(file.disabled, false);
  const profile = { di: '07'.repeat(32), oi: '07'.repeat(16), deviceCode: '07'.repeat(8) };
  file.files = [{ text: async () => JSON.stringify(profile) }];
  const respond = f.env.respond;
  f.env.respond = async () => { throw new Error('deviceCode 格式不正确'); };
  await file.onchange();
  assert.match(f.node('phone-device-hint').textContent, /deviceCode/);
  assert.equal(f.node('phone-login').disabled, false);
  f.env.respond = respond;
  await file.onchange();
  assert.deepEqual(f.calls('/device').at(-1).payload, { confirm: true, profile });
  assert.equal(file.value, '');
  assert.match(f.node('phone-device-hint').textContent, /已导入/);
  assert.match(f.node('phone-device-status').textContent, /Test Phone/);
  assert.equal(f.node('phone-device-details').open, false);
  assert.equal(f.node('phone-login').disabled, false);
});

await test('APP弹窗结束清理临时结果、敏感输入和密码可见状态', async () => {
  const f = fixture({ wizard: true });
  await f.login();
  f.input('phone-number', '13800138000');
  f.input('phone-password', 'leftover-password');
  f.input('phone-code', '123456');
  f.click('phone-password-toggle');
  assert.equal(f.env.wizardEvents.at(-1)[1], 'selecting');
  assert.equal(await f.env.reset(), true);
  assert.deepEqual(f.calls('/cancel').at(-1).payload, { id: f.preview.id });
  for (const id of ['phone-account', 'phone-password', 'phone-number', 'phone-code']) assert.equal(f.node(id).value, '');
  assert.equal(f.node('phone-password').type, 'password');
  assert.equal(f.node('phone-preview').hidden, true);
  assert.equal(f.node('phone-result').textContent, '');
  assert.equal(f.env.wizardEvents.at(-1)[1], 'entry');
  assert.equal(f.env.wizardEvents.at(-1)[2].busy, false);
});

await test('APP清理失败保留待清理结果，返回修改失败也可重试', async () => {
  for (const action of ['reset', 'back']) {
    const f = fixture();
    await f.login();
    const respond = f.env.respond;
    f.env.respond = (route, payload) => {
      if (route.endsWith('/cancel')) throw new Error('模拟清理失败');
      return respond(route, payload);
    };
    if (action === 'reset') await assert.rejects(f.env.reset(), /临时登录结果尚未清理/);
    else assert.equal(await f.click('phone-back'), false);
    assert.equal(f.node('phone-preview').hidden, false);
    f.env.respond = respond;
    assert.equal(await f.env.reset(), true);
    assert.equal(f.calls('/cancel').length, 2);
  }
});

await test('APP验证在途锁定结束操作，保存完成后发布完成步骤', async () => {
  const f = fixture({ wizard: true });
  const respond = f.env.respond;
  const login = deferred();
  f.env.respond = (route, payload) => route === prefix ? login.promise : respond(route, payload);
  const pending = f.login();
  assert.equal(await f.env.reset(), false);
  assert.equal(f.env.wizardEvents.at(-1)[2].busy, true);
  login.resolve(f.preview);
  await pending;
  f.chooseRole();
  await f.click('phone-save');
  const state = f.env.wizardEvents.at(-1);
  assert.equal(state[1], 'saved');
  assert.equal(state[2].busy, false);
  assert.equal(state[2].account.id, 'saved-account');
});

await test('关闭后的短信确认回调失效，角色账号中的手机号被打码', async () => {
  const f = fixture();
  f.click('phone-sms-tab');
  f.input('phone-number', '13800138000');
  f.click('phone-send-code');
  const confirm = f.env.confirmation.callback;
  await f.env.reset();
  await confirm();
  assert.equal(f.calls('/send-code').length, 0);
  f.preview.choices[0].userName = '13800138000';
  await f.login();
  assert.match(f.node('phone-result').textContent, /138\*\*\*\*8000/);
  assert.doesNotMatch(f.node('phone-result').textContent, /13800138000/);
});

console.log(`selftest-phone-login-ui: ${passed} cases ok`);
