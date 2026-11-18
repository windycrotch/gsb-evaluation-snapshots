import { newStateFunction } from './fixtures/console-state.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createConsoleRuntime } from '../src/ui/console-store.mjs';
import { defaultSettings, settingsUiRules } from '../src/automation-settings.mjs';
import { activityAutomationFields, activityAutomationSettingFields } from '../src/activity-automation.mjs';

const script = fs.readFileSync(new URL('../src/ui/activities.js', import.meta.url), 'utf8');
const configScript = fs.readFileSync(new URL('../src/settings-ui.js', import.meta.url), 'utf8');
const { merchantActivityFields, guildShipActivityFields } = newStateFunction(configScript.slice(0, configScript.indexOf('function configGet(')) + '\nreturn { merchantActivityFields, guildShipActivityFields };')();
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

function fixture() {
  const nodes = new Map();
  const state = { calls: [], errors: [], confirmations: [], flushes: 0, respond: null, now: Date.now(), timers: new Map() };
  class Element {
    constructor(tagName = 'div', className = '', text = '') {
      this.tagName = tagName.toUpperCase();
      this.className = className ?? '';
      this.text = String(text ?? '');
      this.children = [];
      this.parentElement = null;
      this.dataset = {};
      this.attributes = new Map();
      this.hidden = false;
      this.value = '';
      this.disabled = false;
      this.classList = {
        contains: name => this.className.split(' ').includes(name),
        toggle: (name, force) => {
          const enabled = force ?? !this.classList.contains(name);
          const names = new Set(this.className.split(' ').filter(Boolean));
          if (enabled) names.add(name); else names.delete(name);
          this.className = [...names].join(' ');
          return enabled;
        },
      };
    }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) {
      this.text = String(value ?? '');
      for (const child of this.children) child.parentElement = null;
      this.children = [];
    }
    get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    append(...children) { for (const child of children) this.appendChild(child); }
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    }
    matches(selector) {
      if (selector.startsWith('#')) return this.id === selector.slice(1);
      if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
      const attribute = selector.match(/^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
      if (attribute) {
        const name = attribute[1];
        const value = name.startsWith('data-')
          ? this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]
          : this.getAttribute(name);
        return attribute[2] === undefined ? value != null : String(value) === attribute[2];
      }
      return this.tagName === selector.toUpperCase();
    }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [
        ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
      ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.parentElement = null;
    }
    focus() {
      const previous = state.focused;
      state.focused = this;
      for (let node = previous; node; node = node.parentElement) node.onfocusout?.();
    }
    scrollIntoView() {}
  }
  const element = (tag, className, text) => new Element(tag, className, text);
  const node = id => {
    if (!nodes.has(id)) {
      const item = element('div');
      item.id = id;
      nodes.set(id, item);
    }
    return nodes.get(id);
  };
  const settings = (values = {}, revision = 1) => ({
    settings: { enabled: true, autoSubmit: false, allowDiamonds: false, autoFinal: true, ...values },
    revision, baseRevision: 'base-' + revision,
  });
  const saved = new Map([['merchant-a', settings()], ['merchant-b', settings({ autoFinal: false }, 3)]]);
  const heroSettings = (values = {}, revision = 1) => ({
    settings: { enabled: false, challenge: false, retryTimes: 10, orders: false, lottery: false, rewards: true, ...values },
    revision, baseRevision: 'base-' + revision,
  });
  const heroSaved = new Map([['merchant-a', heroSettings()], ['merchant-b', heroSettings({ rewards: false }, 3)]]);
  const seaSettings = (values = {}, schedule = {}, revision = 1) => ({
    settings: { merchant: { ...defaultSettings().merchant, ...values },
      schedule: { merchantTrade: false, merchantRewards: true, tradeTasks: true, ...schedule } },
    rules: { numbers: settingsUiRules().numbers }, revision, baseRevision: 'base-' + revision,
  });
  const seaSaved = new Map([['merchant-a', seaSettings()], ['merchant-b', seaSettings({ profitLimit: 100 }, { merchantRewards: false }, 3)]]);
  const shipSettings = (values = {}, revision = 1) => ({
    settings: { guildShip: { ...defaultSettings().guildShip, ...values } },
    catalog: { materials: [{ value: '木板', label: '木板' }, { value: '橡胶圈', label: '橡胶圈' }] },
    rules: { numbers: settingsUiRules().numbers }, revision, baseRevision: 'base-' + revision,
  });
  const shipSaved = new Map([['merchant-a', shipSettings()], ['merchant-b', shipSettings({ mode: 'small' }, 3)]]);
  const automationSettings = (values = {}, revision = 1) => ({
    settings: { ...Object.fromEntries(activityAutomationSettingFields.map(({ key }) =>
      [key, key.split('.').reduce((value, part) => value[part], defaultSettings())])), ...values },
    controls: activityAutomationFields, revision, baseRevision: 'base-' + revision,
  });
  const automationSaved = new Map([['merchant-a', automationSettings()],
    ['merchant-b', automationSettings({ 'activityAutomation.weekLottery': false }, 3)]]);
  const now = Math.floor(state.now / 1000);
  const catalog = { activities: [], eventTasks: [], status: {}, serverNow: now, catalogOnly: true };
  const activities = {
    serverNow: now, vipLevel: 0, activities: [{ id: 'weekly:5:1001:1', name: '不差钱商人',
      kind: 'weekly', weekType: 5, startTime: now - 100, endTime: now + 3600, taskKeys: ['weekOrderSubmit', 'weekOrderFinal'] }],
    eventTasks: [{ key: 'weekOrderSubmit', label: '不差钱商人自动完成订单', enabled: false },
      { key: 'weekOrderFinal', label: '不差钱商人最终奖励', enabled: true }],
    status: {}, order: { orderKey: 'order-key', ready: true, materials: [
      { id: '木板', name: '木板', required: 3, owned: 3, missing: 0, price: 10 },
    ] },
  };
  const context = {
    ...createConsoleRuntime(),
    current: 'merchant-a', snapshot: { paused: false, connected: true }, disconnected: new Set(), savingTasks: new Set(),
    loopSettingsRevision: 1,
    merchantActivityFields, guildShipActivityFields,
    configButton: (text, onclick) => Object.assign(element('button', '', text), { onclick }),
    configPlacePanel() {},
    $: node, el: element,
    clear: item => { item.textContent = ''; return item; },
    component: name => element(name === 'ui-number' ? 'input' : 'button'),
    smallButton: text => element('button', '', text),
    makeHelpTip: (label, help) => element('span', 'help-tip', help),
    setTaskSwitch: (input, enabled) => input.setAttribute('aria-checked', enabled),
    table: (headers, rows) => {
      const table = element('table'); table.headers = headers; table.rows = rows; return table;
    },
    document: {
      get activeElement() { return state.focused; },
      querySelectorAll(selector) {
        return [...nodes.values()].flatMap(item => item.querySelectorAll(selector));
      },
    },
    Date: class extends Date { static now() { return state.now; } },
    setInterval() {}, clearTimeout(id) { state.timers.delete(id); },
    setTimeout(work, delay) { const id = state.timers.size + 1; state.timers.set(id, { work, delay }); return id; },
    refreshProgression() {}, refreshLoop() {},
    async configFlush() { state.flushes++; return true; },
    async configLoad() {},
    reportError: (error, label) => state.errors.push({ message: error.message, label }),
    openConfirm: (title, details, accept) => state.confirmations.push({ title, details, accept }),
    async toggleAutoTask() { throw Error('商人设置不应调用通用活动开关'); },
    async call(route, options = {}) {
      const url = new URL(route, 'http://fixture.invalid');
      const account = url.searchParams.get('account') ?? context.current;
      const request = { route: url.pathname, account, method: options.method ?? 'GET',
        body: options.body ? JSON.parse(options.body) : undefined };
      state.calls.push(request);
      if (state.respond) {
        const result = await state.respond(request);
        if (result !== undefined) return clone(result);
      }
      if (request.route === '/api/week-order/settings') {
        if (request.method === 'POST') {
          const previous = saved.get(account), payload = request.body;
          assert.equal(payload.revision, previous.revision);
          assert.equal(payload.baseRevision, previous.baseRevision);
          assert.equal(payload.confirm, true);
          const next = clone(previous);
          next.settings[payload.key] = payload.enabled;
          next.revision++;
          next.baseRevision = 'base-' + next.revision;
          saved.set(account, next);
        }
        return clone(saved.get(account));
      }
      if (request.route === '/api/hero-raid/settings') {
        if (request.method === 'POST') {
          const previous = heroSaved.get(account), payload = request.body;
          assert.equal(payload.revision, previous.revision);
          assert.equal(payload.baseRevision, previous.baseRevision);
          assert.equal(payload.confirm, true);
          assert(payload.key.startsWith('heroRaid.'));
          const next = clone(previous);
          next.settings[payload.key.slice('heroRaid.'.length)] = payload.value;
          next.revision++;
          next.baseRevision = 'base-' + next.revision;
          heroSaved.set(account, next);
        }
        return clone(heroSaved.get(account));
      }
      if (request.route === '/api/merchant/settings') {
        if (request.method === 'POST') {
          const previous = seaSaved.get(account), payload = request.body;
          assert.equal(payload.revision, previous.revision);
          assert.equal(payload.baseRevision, previous.baseRevision);
          assert.equal(payload.confirm, true);
          assert(merchantActivityFields.some(field => field.key === payload.key));
          const next = clone(previous);
          const [group, key] = payload.key.split('.');
          next.settings[group][key] = payload.value;
          next.revision++;
          next.baseRevision = 'base-' + next.revision;
          seaSaved.set(account, next);
        }
        return clone(seaSaved.get(account));
      }
      if (request.route === '/api/guild-ship/settings') {
        if (request.method === 'POST') {
          const previous = shipSaved.get(account), payload = request.body;
          assert.equal(payload.revision, previous.revision);
          assert.equal(payload.baseRevision, previous.baseRevision);
          assert.equal(payload.confirm, true);
          assert(guildShipActivityFields.some(field => field.key === payload.key));
          const next = clone(previous);
          next.settings.guildShip[payload.key.slice('guildShip.'.length)] = payload.value;
          next.revision++;
          next.baseRevision = 'base-' + next.revision;
          shipSaved.set(account, next);
        }
        return clone(shipSaved.get(account));
      }
      if (request.route === '/api/activities/settings') {
        if (request.method === 'POST') {
          const previous = automationSaved.get(account), payload = request.body;
          assert.equal(payload.revision, previous.revision);
          assert.equal(payload.baseRevision, previous.baseRevision);
          assert.equal(payload.confirm, true);
          assert(activityAutomationSettingFields.some(field => field.key === payload.key));
          assert.equal(typeof payload.value, 'boolean');
          const next = clone(previous);
          next.settings[payload.key] = payload.value;
          next.revision++;
          next.baseRevision = 'base-' + next.revision;
          automationSaved.set(account, next);
        }
        return clone(automationSaved.get(account));
      }
      if (request.route === '/api/activities') return clone(activities);
      if (request.route === '/api/activities/catalog') return clone(catalog);
      throw Error('未声明前端测试请求 ' + request.route);
    },
  };
  vm.createContext(context);
  const multiselect = configScript.slice(configScript.indexOf('function configMultiselect('), configScript.indexOf('function configPriorityEditor('));
  const api = vm.runInContext(multiselect + '\n' + script + `\n({
    refresh: refreshActivities, readSettings: refreshMerchantSettings, save: saveMerchantSetting,
    render: renderActivityTabs, rows: activityRows, select: selectActivity, lifecycle: activityLifecycle,
    get settings() { return merchantSettingsData; },
    get owner() { return merchantSettingsOwner; },
    selectMerchant() { selectActivity(activityRows().find(row => row.weekType === 5)?.id); },
    get heroSettings() { return heroRaidSettingsData; },
    get heroOwner() { return heroRaidSettingsOwner; },
    selectHero() { selectActivity(activityRows().find(isHeroRaidActivity)?.id); },
    readHeroSettings: refreshHeroRaidSettings, saveHero: saveHeroRaidSetting,
    get seaSettings() { return seaMerchantSettingsData; },
    get seaOwner() { return seaMerchantSettingsOwner; },
    selectSea() { selectActivity(activityRows().find(isSeaMerchantActivity)?.id); },
    readSeaSettings: refreshSeaMerchantSettings, saveSea: saveSeaMerchantSetting,
    get shipSettings() { return guildShipSettingsData; },
    get shipOwner() { return guildShipSettingsOwner; },
    selectShip() { selectActivity(activityRows().find(isGuildShipActivity)?.id); },
    readShipSettings: refreshGuildShipSettings, saveShip: saveGuildShipSetting,
    get automationSettings() { return activityAutomationData; },
    get automationOwner() { return activityAutomationOwner; },
    readAutomationSettings: refreshActivityAutomation, saveAutomation: saveActivityAutomation,
  })`, context);
  const controls = () => node('activities-list').querySelectorAll('[data-merchant-setting]');
  const heroControls = () => node('activities-list').querySelectorAll('[data-hero-raid-setting]');
  const seaControls = () => node('activities-list').querySelectorAll('[data-sea-merchant-setting]');
  const shipControls = () => node('activities-list').querySelectorAll('[data-guild-ship-setting]');
  const automationControls = () => node('activities-list').querySelectorAll('[data-activity-automation]');
  return { api, context, state, node, saved, settings, activities, catalog, controls, heroSaved, heroSettings, heroControls,
    shipSaved, shipSettings, shipControls,
    shipInput: key => shipControls().find(input => input.dataset.guildShipSetting === key),
    seaSaved, seaSettings, seaControls, automationSaved, automationSettings, automationControls,
    input: key => controls().find(input => input.dataset.merchantSetting === key),
    heroInput: key => heroControls().find(input => input.dataset.heroRaidSetting === key),
    async clickHero(key) { const input = this.heroInput(key); assert(input && !input.disabled, key + ' 开关应可编辑'); await input.onclick(); },
    async setHeroRetries(value) { const input = this.heroInput('retryTimes'); input.value = value; await input.onchange(); },
    seaInput: key => seaControls().find(input => input.dataset.seaMerchantSetting === key),
    async setSea(key, value) {
      const input = this.seaInput(key);
      assert(input && !input.disabled, key + ' 应可编辑');
      if (merchantActivityFields.find(field => field.key === key).kind === 'switch') await input.onclick();
      else { input.value = value; await input.onchange(); }
    },
    async click(key) { const input = this.input(key); assert(input && !input.disabled, key + ' 开关应可编辑'); await input.onclick(); },
    automationInput: key => automationControls().find(input => input.dataset.activityAutomation === key),
    async clickAutomation(key) { const input = this.automationInput(key); assert(input && !input.disabled, key + ' 开关应可编辑'); await input.onclick(); },
  };
}

let passed = 0;
async function test(name, work) {
  await work(); passed++; console.log('通过：' + name);
}

const flushAsync = () => new Promise(resolve => setImmediate(resolve));

await test('活动目录和所选配置先显示，不等待慢游戏请求或其他配置接口', async () => {
  const f = fixture(), live = deferred(), hero = deferred();
  f.catalog.activities = clone(f.activities.activities);
  f.catalog.eventTasks = clone(f.activities.eventTasks);
  f.catalog.activities.push({ id: 'loading-lottery', name: '已存周转盘', kind: 'weekly', weekType: 4,
    startTime: f.activities.serverNow - 10, endTime: f.activities.serverNow + 3600, taskKeys: ['weekGift'] });
  f.catalog.eventTasks.push({ key: 'weekGift', label: '免费礼包', enabled: true });
  f.activities.activities[0].name = '实时商人';
  f.state.respond = request => {
    if (request.route === '/api/activities') return live.promise;
    if (request.route === '/api/hero-raid/settings') return hero.promise;
  };
  const pending = f.api.refresh();
  assert(f.state.calls.some(call => call.route === '/api/activities'), '游戏请求与配置读取同时启动');
  assert(f.node('activity-tabs').children.length, '目录未返回前也有静态配置入口');
  await flushAsync();
  assert(f.node('activity-tabs').textContent.includes('已存周转盘'));
  f.api.select('loading-lottery');
  assert.equal(f.node('activities-list').querySelector('[data-activity-run=weekGift]').disabled, true);
  f.api.selectMerchant();
  assert.equal(f.controls().length, 4, '商人配置不等超凡英雄配置完成');
  assert.match(f.node('activities-status').textContent, /正在同步/);
  live.resolve(f.activities);
  await flushAsync();
  assert.equal(f.node('activity-title').textContent, '实时商人', '实时数据到达即更新，不等慢配置');
  assert(!f.node('activities-status').textContent.includes('正在同步'));
  hero.resolve(undefined);
  await pending;
});

await test('完整活动先返回时迟到目录不能降级实时状态', async () => {
  const f = fixture(), catalog = deferred();
  f.state.respond = request => request.route === '/api/activities/catalog' ? catalog.promise : undefined;
  await f.api.refresh();
  assert.equal(f.node('activity-tabs').querySelector('[aria-selected=true]').dataset.activity, f.activities.activities[0].id,
    '首次载入应选第一项当前活动，不沿用静态入口临时选中的海盗');
  const title = f.node('activity-title').textContent;
  catalog.resolve({ ...f.catalog, activities: [{ ...f.activities.activities[0], name: '迟到旧目录' }] });
  await flushAsync();
  assert.equal(f.node('activity-title').textContent, title);
  assert(f.node('activities-order').children.length, '实时商人订单仍可见');
});

await test('不完整目录不覆盖记忆选择，加载中主动改选仍以用户选择为准', async () => {
  for (const changeSelection of [false, true]) {
    const f = fixture();
    await f.api.refresh(); f.api.selectMerchant();
    const preferred = f.node('activity-tabs').querySelector('[aria-selected=true]').dataset.activity;
    f.context.current = 'merchant-b'; await f.api.refresh();
    f.context.current = 'merchant-a';
    const live = deferred();
    f.state.respond = request => request.route === '/api/activities' ? live.promise : undefined;
    const pending = f.api.refresh();
    await flushAsync();
    assert.equal(f.node('activity-tabs').querySelector('[aria-selected=true]').dataset.activity, 'pirates');
    if (changeSelection) f.api.selectHero();
    live.resolve(f.activities); await pending;
    assert.equal(f.node('activity-tabs').querySelector('[aria-selected=true]').dataset.activity,
      changeSelection ? 'hero-raid' : preferred);
  }
});

await test('刷新保留可见活动但临时关闭执行入口，失败后仍只展示目录', async () => {
  const f = fixture();
  f.activities.activities.push({ id: 'live-lottery', name: '周转盘', kind: 'weekly', weekType: 4,
    startTime: f.activities.serverNow - 10, endTime: f.activities.serverNow + 3600, taskKeys: ['weekGift'] });
  f.activities.eventTasks.push({ key: 'weekGift', label: '免费礼包', enabled: true });
  await f.api.refresh(); f.api.select('live-lottery');
  assert(!f.node('activities-list').querySelector('[data-activity-run=weekGift]').disabled);
  const live = deferred();
  f.state.respond = request => {
    if (request.route === '/api/activities') return live.promise;
    if (request.route === '/api/activities/catalog') throw Error('目录暂不可用');
  };
  const pending = f.api.refresh();
  assert.equal(f.node('activity-title').textContent, '周转盘');
  assert.equal(f.node('activities-list').querySelector('[data-activity-run=weekGift]').disabled, true);
  live.reject(Error('游戏读取失败')); await pending;
  assert.equal(f.node('activities-list').querySelector('[data-activity-run=weekGift]').disabled, true);
  assert.match(f.node('activities-status').textContent, /同步失败/);
});

await test('切号后迟到的活动及目录均不能修改当前账号面板', async () => {
  const f = fixture(), live = deferred(), catalog = deferred();
  f.state.respond = request => {
    if (request.account !== 'merchant-a') return;
    if (request.route === '/api/activities') return live.promise;
    if (request.route === '/api/activities/catalog') return catalog.promise;
  };
  const pending = f.api.refresh();
  f.context.current = 'merchant-b'; await f.api.refresh(); f.api.selectMerchant();
  const title = f.node('activity-title').textContent;
  catalog.resolve({ ...f.catalog, activities: [{ ...f.activities.activities[0], name: '旧账号目录' }] });
  live.resolve({ ...f.activities, activities: [{ ...f.activities.activities[0], name: '旧账号活动' }] });
  await pending; await flushAsync();
  assert.equal(f.api.owner, 'merchant-b');
  assert.equal(f.node('activity-title').textContent, title);
  assert.equal(f.input('autoFinal').getAttribute('aria-checked'), 'false');
});

await test('游戏活动请求期间断开后，迟到响应保持目录模式且不可执行', async () => {
  const f = fixture(), live = deferred();
  f.activities.activities.push({ id: 'live-lottery', name: '周转盘', kind: 'weekly', weekType: 4,
    startTime: f.activities.serverNow - 10, endTime: f.activities.serverNow + 3600, taskKeys: ['weekGift'] });
  f.activities.eventTasks.push({ key: 'weekGift', label: '免费礼包', enabled: true });
  f.state.respond = request => request.route === '/api/activities' ? live.promise : undefined;
  const pending = f.api.refresh();
  f.context.snapshot.connected = false;
  live.resolve(f.activities); await pending; f.api.select('live-lottery');
  assert.equal(f.node('activities-list').querySelector('[data-activity-run=weekGift]').disabled, true);
  assert.match(f.node('activities-status').textContent, /未连接/);
});

await test('完整活动返回不打断数值编辑，占位入口切换真实期次仍保留原输入和焦点', async () => {
  const f = fixture(), live = deferred(), now = f.activities.serverNow;
  f.activities.activities.push({ id: 'hero-raid:12', name: '超凡英雄活动', kind: 'weekly',
    startTime: now - 10, endTime: now + 3600, taskKeys: ['weekGift'] });
  f.activities.eventTasks.push({ key: 'weekGift', label: '免费礼包', enabled: true });
  f.state.respond = request => request.route === '/api/activities' ? live.promise : undefined;
  const pending = f.api.refresh(); await flushAsync(); f.api.selectHero();
  const input = f.heroInput('retryTimes'); input.focus(); input.value = '23';
  live.resolve(f.activities); await pending;
  assert.equal(f.node('activity-tabs').querySelector('[aria-selected=true]').dataset.activity, 'hero-raid:12');
  assert.equal(f.heroInput('retryTimes'), input, '原输入节点留在 DOM 中，不用重建后模拟恢复焦点');
  assert.equal(f.context.document.activeElement, input);
  assert.equal(input.value, '23');
  assert.equal(input.parentElement.parentElement.parentElement, f.node('activities-list'));
  assert(!f.state.calls.some(call => call.method === 'POST'), '后台回填不提交未完成输入');
  const refresh = deferred();
  f.state.respond = request => request.route === '/api/activities' ? refresh.promise : undefined;
  const refreshing = f.api.refresh();
  assert.equal(f.heroInput('retryTimes'), input);
  assert.equal(f.node('activities-list').querySelector('[data-activity-run=weekGift]').disabled, true,
    '保留配置编辑不能阻止旧执行按钮失效');
  refresh.resolve(f.activities); await refreshing;
  f.state.respond = null; await input.onchange();
  assert.equal(f.heroSaved.get('merchant-a').settings.retryTimes, 23, '失焦后的原生 change 仍可保存草稿');
});

await test('迟到配置回填不覆盖海商时间输入，离开表单后更新到服务端最新配置', async () => {
  const f = fixture();
  f.seaSaved.set('merchant-a', f.seaSettings({ firstDepartureMode: 'time' }));
  await f.api.refresh(); f.api.selectSea();
  const late = deferred();
  f.state.respond = request => request.route === '/api/merchant/settings' ? late.promise : undefined;
  const pending = f.api.refresh();
  const input = f.seaInput('merchant.firstDepartureTime'); input.focus(); input.value = '09:45';
  late.resolve(f.seaSettings({ firstDepartureMode: 'time', firstDepartureTime: '10:30' }, {}, 2));
  await pending;
  assert.equal(f.seaInput('merchant.firstDepartureTime'), input);
  assert.equal(input.value, '09:45');
  assert.equal(f.context.document.activeElement, input);
  assert(!f.state.calls.some(call => call.method === 'POST'));
  f.node('outside-panel').focus(); await flushAsync();
  assert.equal(f.seaInput('merchant.firstDepartureTime').value, '10:30', '离开表单后补绘迟到配置');
});

await test('后台活动更新保留商船多选的展开、搜索、筛选结果和焦点', async () => {
  const f = fixture(), live = deferred();
  f.state.respond = request => request.route === '/api/activities' ? live.promise : undefined;
  const pending = f.api.refresh(); await flushAsync(); f.api.selectShip();
  const picker = f.shipInput('guildShip.disabledMaterials');
  picker.open = true; picker.ontoggle();
  const search = picker.querySelector('.config-input'); search.value = '木板'; search.oninput();
  const filtered = picker.querySelector('.config-option-list').textContent;
  live.resolve(f.activities); await pending;
  assert.equal(f.shipInput('guildShip.disabledMaterials'), picker);
  assert.equal(picker.open, true);
  assert.equal(search.value, '木板');
  assert.equal(picker.querySelector('.config-option-list').textContent, filtered);
  assert.equal(f.context.document.activeElement, search);
});

await test('活动详情仅呈现一套商人设置，回读原账号保存值', async () => {
  const f = fixture();
  await f.api.refresh(); f.api.selectMerchant();
  assert.deepEqual(f.controls().map(input => input.dataset.merchantSetting), ['enabled', 'autoSubmit', 'allowDiamonds', 'autoFinal']);
  assert.equal(f.input('enabled').getAttribute('aria-label'), '开启自动挂机');
  assert.equal(f.input('autoSubmit').getAttribute('aria-checked'), 'false');
  assert.equal(f.input('allowDiamonds').getAttribute('aria-checked'), 'false');
  assert.equal(f.input('allowDiamonds').disabled, true);
  assert.equal(f.input('autoFinal').getAttribute('aria-checked'), 'true');
  assert.equal(f.node('activities-list').querySelectorAll('[data-auto-task]').length, 0);
  assert(!f.node('activities-list').textContent.includes('游戏配置'));
});

await test('三个开关直接保存单字段并回读，关闭自动完成仍保留补料选择', async () => {
  const f = fixture();
  await f.api.refresh(); f.api.selectMerchant();
  await f.click('autoSubmit');
  assert.equal(f.input('autoSubmit').getAttribute('aria-checked'), 'true');
  assert.equal(f.input('allowDiamonds').disabled, false);
  await f.click('allowDiamonds');
  await f.click('autoFinal');
  assert.deepEqual(f.saved.get('merchant-a').settings, { enabled: true, autoSubmit: true, allowDiamonds: true, autoFinal: false });
  await f.click('autoSubmit');
  assert.equal(f.input('autoSubmit').getAttribute('aria-checked'), 'false');
  assert.equal(f.input('allowDiamonds').getAttribute('aria-checked'), 'true');
  assert.equal(f.input('allowDiamonds').disabled, true);
  assert.deepEqual(f.state.calls.filter(call => call.method === 'POST').map(call => call.body.key),
    ['autoSubmit', 'allowDiamonds', 'autoFinal', 'autoSubmit']);
  assert.equal(f.state.flushes, 4);
  assert.equal(f.state.errors.length, 0);
});

await test('暂停、断开及首次未连接时可配置商人，游戏读取和消费入口保持关闭', async () => {
  for (const state of ['paused', 'disconnected', 'notConnected']) {
    const f = fixture();
    if (state === 'paused') f.context.snapshot.paused = true;
    else if (state === 'disconnected') f.context.disconnected.add('merchant-a');
    else f.context.snapshot.connected = false;
    await f.api.refresh(); f.api.selectMerchant();
    const merchant = f.api.rows().find(row => row.weekType === 5);
    assert.equal(merchant.settingsOnly, true);
    assert.equal(f.controls().length, 4);
    assert(!f.state.calls.some(call => call.route === '/api/activities'));
    assert.equal(f.node('activities-list').querySelectorAll('[data-activity-run]').length, 0);
    assert.equal(f.node('activities-order').querySelectorAll('button').length, 0);
    await f.click('autoSubmit');
    assert.equal(f.saved.get('merchant-a').settings.autoSubmit, true);
    assert(f.state.calls.every(call => ['/api/week-order/settings', '/api/hero-raid/settings', '/api/merchant/settings', '/api/guild-ship/settings', '/api/activities/settings', '/api/activities/catalog'].includes(call.route)));
  }
});

await test('读取商人配置期间暂停或断开后，不继续读取游戏活动', async () => {
  for (const change of [
    f => { f.context.snapshot.paused = true; },
    f => { f.context.disconnected.add('merchant-a'); },
    f => { f.context.snapshot.connected = false; },
  ]) {
    const f = fixture();
    f.state.respond = request => {
      if (request.route === '/api/week-order/settings') change(f);
    };
    await f.api.refresh(); f.api.selectMerchant();
    assert(!f.state.calls.some(call => call.route === '/api/activities'));
    assert.equal(f.controls().length, 4);
    assert.equal(f.api.rows().find(row => row.weekType === 5).settingsOnly, true);
  }
});

await test('活动未开放时仍有唯一配置入口，开放后使用当前活动实例', async () => {
  const f = fixture();
  const active = clone(f.activities.activities);
  f.activities.activities = [];
  await f.api.refresh(); f.api.selectMerchant();
  let merchants = f.api.rows().filter(row => row.weekType === 5);
  assert.equal(merchants.length, 1);
  assert.equal(merchants[0].settingsOnly, true);
  await f.click('autoSubmit');
  f.activities.activities = active;
  await f.api.refresh(); f.api.selectMerchant();
  merchants = f.api.rows().filter(row => row.weekType === 5);
  assert.equal(merchants.length, 1);
  assert.equal(merchants[0].id, active[0].id);
  assert(!merchants[0].settingsOnly);
  assert.equal(f.input('autoSubmit').getAttribute('aria-checked'), 'true');
});

await test('保存前刷新版本，仅修改所点开关并保留其他页面的最新值', async () => {
  const f = fixture();
  await f.api.refresh(); f.api.selectMerchant();
  f.saved.set('merchant-a', f.settings({ autoSubmit: true, allowDiamonds: true, autoFinal: true }, 8));
  await f.click('autoFinal');
  const write = f.state.calls.find(call => call.method === 'POST');
  assert.equal(write.body.revision, 8);
  assert.deepEqual(f.saved.get('merchant-a').settings, { enabled: true, autoSubmit: true, allowDiamonds: true, autoFinal: false });
  assert.deepEqual(clone(f.api.settings.settings), f.saved.get('merchant-a').settings);
});

await test('保存失败后回读服务器值，开关恢复并能继续编辑', async () => {
  const f = fixture();
  await f.api.refresh(); f.api.selectMerchant();
  f.state.respond = request => {
    if (request.method === 'POST') throw Error('配置保存失败');
  };
  await f.click('autoSubmit');
  assert.equal(f.input('autoSubmit').getAttribute('aria-checked'), 'false');
  assert.equal(f.input('autoSubmit').disabled, false);
  assert.equal(f.saved.get('merchant-a').settings.autoSubmit, false);
  assert(f.state.errors.some(error => /配置保存失败/.test(error.message)));
  f.state.respond = null;
  await f.click('autoSubmit');
  assert.equal(f.input('autoSubmit').getAttribute('aria-checked'), 'true');
});

await test('已保存后的旧读取回包不会覆盖新开关或版本', async () => {
  const f = fixture();
  await f.api.refresh(); f.api.selectMerchant();
  const readEntered = deferred(), oldRead = deferred();
  let delayed = false;
  f.state.respond = request => {
    if (!delayed && request.route === '/api/week-order/settings' && request.method === 'GET') {
      delayed = true; readEntered.resolve(); return oldRead.promise;
    }
  };
  const pendingRead = f.api.readSettings('merchant-a');
  await readEntered.promise;
  const previous = clone(f.saved.get('merchant-a'));
  await f.click('autoSubmit');
  assert.equal(f.api.settings.settings.autoSubmit, true);
  const revision = f.api.settings.revision;
  oldRead.resolve(previous); await pendingRead;
  assert.equal(f.api.settings.settings.autoSubmit, true);
  assert.equal(f.api.settings.revision, revision);
});

await test('账号切换期间迟到的保存回复不能修改新账号面板', async () => {
  const f = fixture();
  await f.api.refresh(); f.api.selectMerchant();
  const writeEntered = deferred(), releaseWrite = deferred();
  f.state.respond = request => {
    if (request.method === 'POST' && request.account === 'merchant-a') {
      writeEntered.resolve();
      return releaseWrite.promise;
    }
  };
  const pendingSave = f.click('autoSubmit');
  await writeEntered.promise;
  f.context.current = 'merchant-b';
  await f.api.refresh(); f.api.selectMerchant();
  assert.equal(f.api.owner, 'merchant-b');
  assert.equal(f.input('autoFinal').getAttribute('aria-checked'), 'false');
  releaseWrite.resolve(f.settings({ autoSubmit: true }, 2));
  await pendingSave;
  assert.equal(f.api.owner, 'merchant-b');
  assert.deepEqual(clone(f.api.settings), f.saved.get('merchant-b'));
  assert.equal(f.input('autoSubmit').getAttribute('aria-checked'), 'false');
  assert.equal(f.input('autoFinal').getAttribute('aria-checked'), 'false');
});

await test('游戏配置草稿保存失败时停止本次开关请求并恢复可编辑状态', async () => {
  const f = fixture();
  await f.api.refresh(); f.api.selectMerchant();
  f.context.configFlush = async () => false;
  await f.click('autoSubmit');
  assert(!f.state.calls.some(call => call.method === 'POST'));
  assert.equal(f.input('autoSubmit').getAttribute('aria-checked'), 'false');
  assert.equal(f.input('autoSubmit').disabled, false);
});

await test('保存期间整组禁用，活动刷新和重复点击不会并发写入', async () => {
  const f = fixture();
  await f.api.refresh(); f.api.selectMerchant();
  const entered = deferred(), release = deferred();
  f.state.respond = request => {
    if (request.method === 'POST') { entered.resolve(); return release.promise; }
  };
  const pending = f.click('autoSubmit');
  await entered.promise;
  assert(f.controls().every(input => input.disabled));
  await f.api.refresh(); f.api.selectMerchant();
  assert(f.controls().every(input => input.disabled));
  await f.api.save('autoFinal', false);
  assert.equal(f.state.calls.filter(call => call.method === 'POST').length, 1);
  const saved = f.settings({ autoSubmit: true }, 2);
  f.saved.set('merchant-a', saved); release.resolve(saved);
  await pending;
  assert.equal(f.input('autoSubmit').getAttribute('aria-checked'), 'true');
  assert(f.controls().every(input => !input.disabled));
});

await test('保存回复丢失时用回读值确认已保存状态，不误恢复旧开关', async () => {
  const f = fixture();
  await f.api.refresh(); f.api.selectMerchant();
  f.state.respond = request => {
    if (request.method === 'POST') {
      f.saved.set('merchant-a', f.settings({ autoSubmit: true }, 2));
      throw Error('保存回复暂时不可读');
    }
  };
  await f.click('autoSubmit');
  assert.equal(f.input('autoSubmit').getAttribute('aria-checked'), 'true');
  assert.equal(f.api.settings.revision, 2);
  assert.equal(f.input('autoSubmit').disabled, false);
});

await test('待开放与已结束活动默认收起，展开后显示完整起止时间', async () => {
  const f = fixture(), now = f.activities.serverNow;
  f.activities.activities.push(
    { id: 'future', name: '未来活动', kind: 'limited', startTime: now + 60, endTime: now + 120, taskKeys: [] },
    { id: 'past', name: '酆都诡事', kind: 'limited', startTime: now - 120, endTime: now - 60, taskKeys: [] },
  );
  await f.api.refresh();
  const tabs = f.node('activity-tabs');
  for (const state of ['upcoming', 'ended']) {
    assert.equal(tabs.querySelector('[data-activity-group=' + state + ']').getAttribute('aria-expanded'), 'false');
    assert.equal(tabs.querySelector('#activity-group-' + state).hidden, true);
  }
  tabs.querySelector('[data-activity-group=ended]').onclick();
  tabs.querySelector('[data-activity=past]').onclick();
  assert.equal(f.node('activity-title').textContent, '酆都诡事');
  assert.match(f.node('activity-end').textContent, /开始 .* · 结束 .*北京时间/);
  assert.match(f.node('activities-list').textContent, /本期活动已结束/);
  tabs.querySelector('[data-activity-group=ended]').onclick();
  assert.equal(tabs.querySelector('#activity-group-ended').hidden, true);
  assert.notEqual(tabs.querySelector('[aria-selected=true]').dataset.activity, 'past');
});

await test('未来及结束期次保留自动偏好，单次执行按钮禁用', async () => {
  const f = fixture(), now = f.activities.serverNow;
  f.activities.eventTasks.push({ key: 'edict', label: '酆都法旨', enabled: true });
  for (const [id, startTime, endTime] of [['future', now + 30, now + 90], ['past', now - 90, now - 30]]) {
    f.activities.activities.push({ id, name: '酆都法旨', kind: 'limited', startTime, endTime, taskKeys: ['edict'] });
  }
  await f.api.refresh();
  for (const id of ['future', 'past']) {
    f.api.select(id);
    const button = f.node('activities-list').querySelector('[data-activity-run=edict]');
    assert.equal(button.disabled, true);
    assert.equal(f.node('activities-list').querySelector('[data-auto-task=edict]').getAttribute('aria-checked'), 'true');
    await button.onclick();
  }
  assert(!f.state.calls.some(call => call.route === '/api/activities/run'));
});

await test('开放与结束边界自动重新分组，开始边界也安排刷新', async () => {
  const f = fixture(), now = f.activities.serverNow;
  f.activities.activities.push({ id: 'timed', name: '定时活动', kind: 'limited', startTime: now + 30,
    endTime: now + 60, taskKeys: [] });
  await f.api.refresh();
  assert.equal(f.api.lifecycle(f.api.rows().find(row => row.id === 'timed')), 'upcoming');
  assert([...f.state.timers.values()].some(timer => timer.delay > 0 && timer.delay <= 30000));
  f.state.now += 30000;
  f.api.render();
  assert.equal(f.api.lifecycle(f.api.rows().find(row => row.id === 'timed')), 'active');
  f.api.select('timed');
  f.state.now += 30000;
  f.api.render();
  assert.equal(f.api.lifecycle(f.api.rows().find(row => row.id === 'timed')), 'ended');
  assert.equal(f.node('activity-tabs').querySelector('#activity-group-ended').hidden, true);
  assert.notEqual(f.node('activity-tabs').querySelector('[aria-selected=true]').dataset.activity, 'timed');
});

await test('离线读取账号活动留档，过期条目收起且不调用游戏接口', async () => {
  const f = fixture(), now = f.activities.serverNow;
  f.context.snapshot.connected = false;
  f.catalog.activities = [{ id: 'archive:merchant', name: '不差钱商人', kind: 'weekly', weekType: 5,
    startTime: now - 100, endTime: now - 1, observed: false, taskKeys: ['weekOrderSubmit', 'weekOrderFinal'] }];
  await f.api.refresh();
  assert.equal(f.node('activity-tabs').querySelector('#activity-group-ended').hidden, true);
  f.api.select('archive:merchant');
  assert.equal(f.controls().length, 4);
  await f.click('autoSubmit');
  assert.equal(f.saved.get('merchant-a').settings.autoSubmit, true);
  assert(!f.state.calls.some(call => call.route === '/api/activities'));
  assert.equal(f.node('activities-order').querySelectorAll('button').length, 0);
});

await test('旧目录缺少本期实时确认时展示待同步并禁用单次执行', async () => {
  const f = fixture(), now = f.activities.serverNow;
  f.activities.activities.push({ id: 'unconfirmed', name: '酆都法旨', kind: 'limited', observed: false,
    startTime: now - 100, endTime: now + 100, taskKeys: ['edict'] });
  f.activities.eventTasks.push({ key: 'edict', label: '酆都法旨', enabled: true });
  await f.api.refresh();
  assert.equal(f.node('activity-tabs').querySelector('#activity-group-unknown').hidden, true);
  f.api.select('unconfirmed');
  assert.match(f.node('activities-list').textContent, /活动开放状态待同步/);
  assert.equal(f.node('activities-list').querySelector('[data-activity-run=edict]').disabled, true);
});

await test('键盘导航跳过收起条目，账号间独立保存展开状态', async () => {
  const f = fixture(), now = f.activities.serverNow;
  f.activities.activities.push({ id: 'future', name: '未来活动', kind: 'limited', startTime: now + 30, endTime: now + 60, taskKeys: [] });
  await f.api.refresh();
  const tabs = f.node('activity-tabs');
  tabs.querySelector('[aria-selected=true]').onkeydown({ key: 'End', preventDefault() {} });
  assert.notEqual(tabs.querySelector('[aria-selected=true]').dataset.activity, 'future');
  tabs.querySelector('[data-activity-group=upcoming]').onclick();
  f.context.current = 'merchant-b';
  await f.api.refresh();
  assert.equal(tabs.querySelector('#activity-group-upcoming').hidden, true);
  f.context.current = 'merchant-a';
  await f.api.refresh();
  assert.equal(tabs.querySelector('#activity-group-upcoming').hidden, false);
});

await test('超凡英雄提供截图五项设置及达标奖励，默认重试十次且保存单字段', async () => {
  const f = fixture();
  await f.api.refresh(); f.api.selectHero();
  assert.deepEqual(f.heroControls().map(input => input.dataset.heroRaidSetting),
    ['enabled', 'challenge', 'retryTimes', 'orders', 'lottery', 'rewards']);
  assert.equal(f.heroInput('retryTimes').valueAsNumber, 10);
  assert.equal(f.heroInput('retryTimes').min, 0);
  assert.equal(f.heroInput('retryTimes').max, 100);
  assert.equal(f.heroInput('lottery').getAttribute('aria-checked'), 'false');
  assert.match(f.node('activities-list').textContent, /英雄副本抽卡券/);
  await f.clickHero('challenge');
  await f.clickHero('orders');
  await f.clickHero('lottery');
  await f.setHeroRetries(0);
  await f.clickHero('enabled');
  await f.clickHero('enabled');
  assert.deepEqual(f.heroSaved.get('merchant-a').settings,
    { enabled: false, challenge: true, retryTimes: 0, orders: true, lottery: true, rewards: true });
  assert(f.state.calls.filter(call => call.method === 'POST').every(call => call.route === '/api/hero-raid/settings'));
  assert.equal(f.state.flushes, 6);
  assert.equal(f.state.errors.length, 0);
});

await test('超凡英雄未连接、暂停及未开放时均可预先配置，已有真实期次替换占位入口', async () => {
  for (const state of ['connected', 'paused', 'notConnected']) {
    const f = fixture();
    if (state === 'paused') f.context.snapshot.paused = true;
    if (state === 'notConnected') f.context.snapshot.connected = false;
    await f.api.refresh(); f.api.selectHero();
    assert.equal(f.api.rows().find(row => row.id === 'hero-raid').kind, 'weekly');
    assert.equal(f.node('activity-kind').textContent, '周期');
    assert.equal(f.heroControls().length, 6);
    assert(f.heroControls().every(input => !input.disabled));
    await f.clickHero('orders');
    assert.equal(f.heroSaved.get('merchant-a').settings.orders, true);
    assert(!f.state.calls.some(call => call.route === '/api/activities/run'));
  }
  const f = fixture(), now = f.activities.serverNow;
  f.activities.activities.push({ id: 'hero-raid:1001', name: '超凡英雄活动', kind: 'weekly',
    startTime: now - 100, endTime: now + 100, taskKeys: [] });
  await f.api.refresh(); f.api.selectHero();
  assert.equal(f.api.rows().filter(row => row.id.startsWith('hero-raid')).length, 1);
  assert.equal(f.heroControls().length, 6);
  assert.equal(f.node('activity-kind').textContent, '周期');
  assert(!f.node('activities-list').textContent.includes('暂未接入'));
});

await test('未开放配置入口默认收起，展开后可编辑且按账号保存', async () => {
  for (const state of ['connected', 'paused', 'notConnected', 'readFailed']) {
    const f = fixture();
    f.activities.activities = [];
    if (state === 'paused') f.context.snapshot.paused = true;
    if (state === 'notConnected') f.context.snapshot.connected = false;
    if (state === 'readFailed') f.state.respond = request => {
      if (request.route === '/api/activities') throw Error('活动暂时不可读');
    };
    await f.api.refresh();
    const tabs = f.node('activity-tabs');
    const group = tabs.querySelector('#activity-group-upcoming');
    assert(group, '未开放配置入口应归入收起的活动分组');
    assert.equal(group.hidden, true);
    const toggle = tabs.querySelector('[data-activity-group=upcoming]');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.match(toggle.textContent, /未开放活动/);
    for (const id of ['hero-raid', 'rich-merchant']) {
      assert(group.querySelector('[data-activity=' + id + ']'));
      assert(!tabs.querySelector('.activity-current-tabs').querySelector('[data-activity=' + id + ']'));
    }
    tabs.querySelector('[aria-selected=true]').onkeydown({ key: 'Home', preventDefault() {} });
    assert.notEqual(tabs.querySelector('[aria-selected=true]').dataset.activity, 'hero-raid');
    toggle.onclick();
    tabs.querySelector('[data-activity=hero-raid]').onclick();
    assert.equal(f.heroControls().length, 6);
    await f.clickHero('enabled');
    assert.equal(f.heroSaved.get('merchant-a').settings.enabled, true);
    tabs.querySelector('[data-activity-group=upcoming]').onclick();
    assert.equal(tabs.querySelector('#activity-group-upcoming').hidden, true);
    assert.notEqual(tabs.querySelector('[aria-selected=true]').dataset.activity, 'hero-raid');
    assert(!f.state.calls.some(call => call.route === '/api/activities/run'));
  }
});

await test('超凡英雄读取到开放期次后自动移上，结束后收起并沿用设置复开', async () => {
  const f = fixture(), now = f.activities.serverNow;
  f.heroSaved.set('merchant-a', f.heroSettings({ enabled: true, orders: true }));
  await f.api.refresh();
  const tabs = f.node('activity-tabs');
  assert(tabs.querySelector('#activity-group-upcoming')?.querySelector('[data-activity=hero-raid]'));
  const raid = { id: 'hero-raid:1001', name: '超凡英雄活动', kind: 'weekly', observed: true,
    startTime: now - 100, endTime: now + 100, taskKeys: [] };
  f.activities.activities.push(raid);
  await f.api.refresh();
  assert(!tabs.querySelector('[data-activity=hero-raid]'));
  assert(tabs.querySelector('.activity-current-tabs').querySelector('[data-activity="hero-raid:1001"]'));
  tabs.querySelector('[data-activity="hero-raid:1001"]').onclick();
  assert.equal(f.heroInput('enabled').getAttribute('aria-checked'), 'true');
  assert.equal(f.heroInput('orders').getAttribute('aria-checked'), 'true');
  f.state.now += 100000;
  f.api.render();
  const ended = tabs.querySelector('#activity-group-ended');
  assert.equal(ended.hidden, true);
  assert(ended.querySelector('[data-activity="hero-raid:1001"]'));
  assert.notEqual(tabs.querySelector('[aria-selected=true]').dataset.activity, raid.id);
  f.activities.serverNow = now + 100;
  f.activities.activities.push({ ...raid, id: 'hero-raid:1002', startTime: now + 100, endTime: now + 200 });
  await f.api.refresh();
  assert(tabs.querySelector('.activity-current-tabs').querySelector('[data-activity="hero-raid:1002"]'));
  tabs.querySelector('[data-activity="hero-raid:1002"]').onclick();
  assert.equal(f.heroInput('enabled').getAttribute('aria-checked'), 'true');
  assert.equal(f.heroInput('orders').getAttribute('aria-checked'), 'true');
  assert(!f.state.calls.some(call => call.method === 'POST'));
});

await test('历史超凡英雄期次从sourceId识别，离线展开后仍可编辑', async () => {
  const f = fixture(), now = f.activities.serverNow;
  f.context.snapshot.connected = false;
  f.catalog.activities.push({ id: 'archive:hero-1001', sourceId: 'hero-raid:1001', name: '超凡英雄活动', kind: 'weekly',
    startTime: now - 100, endTime: now - 1, observed: false, taskKeys: [] });
  await f.api.refresh(); f.api.selectHero();
  assert.equal(f.heroControls().length, 6);
  assert.equal(f.node('activity-kind').textContent, '周期');
  assert(!f.api.rows().some(row => row.id === 'hero-raid'));
  await f.clickHero('rewards');
  assert.equal(f.heroSaved.get('merchant-a').settings.rewards, false);
  assert(!f.state.calls.some(call => call.route === '/api/activities'));
});

await test('重试次数拒绝空值、小数与越界值，失败后保留已保存值', async () => {
  const f = fixture();
  await f.api.refresh(); f.api.selectHero();
  for (const value of ['', -1, 1.5, 101, 'abc']) {
    await f.setHeroRetries(value);
    assert.equal(f.heroInput('retryTimes').valueAsNumber, 10);
  }
  assert.equal(f.state.calls.filter(call => call.method === 'POST').length, 0);
  assert.equal(f.state.errors.length, 5);
  await f.setHeroRetries(100);
  assert.equal(f.heroSaved.get('merchant-a').settings.retryTimes, 100);
});

await test('超凡英雄保存失败回读原值，刷新版本后继续保存并保留其他项', async () => {
  const f = fixture();
  await f.api.refresh(); f.api.selectHero();
  f.state.respond = request => { if (request.method === 'POST') throw Error('配置版本已变化'); };
  await f.clickHero('enabled');
  assert.equal(f.heroInput('enabled').getAttribute('aria-checked'), 'false');
  assert(f.heroControls().every(input => !input.disabled));
  f.state.respond = null;
  f.heroSaved.set('merchant-a', f.heroSettings({ lottery: true, retryTimes: 23 }, 9));
  await f.clickHero('enabled');
  assert.deepEqual(f.heroSaved.get('merchant-a').settings,
    { enabled: true, challenge: false, retryTimes: 23, orders: false, lottery: true, rewards: true });
  assert.equal(f.state.calls.filter(call => call.method === 'POST').at(-1).body.revision, 9);
});

await test('超凡英雄保存期间锁定控件，重复保存被合并且迟到回包不影响新账号', async () => {
  const f = fixture();
  await f.api.refresh(); f.api.selectHero();
  const entered = deferred(), release = deferred();
  f.state.respond = request => {
    if (request.route === '/api/hero-raid/settings' && request.method === 'POST') {
      entered.resolve(); return release.promise;
    }
  };
  const pending = f.clickHero('enabled');
  await entered.promise;
  assert(f.heroControls().every(input => input.disabled));
  await f.api.saveHero('orders', true);
  assert.equal(f.state.calls.filter(call => call.method === 'POST').length, 1);
  f.context.current = 'merchant-b';
  await f.api.refresh(); f.api.selectHero();
  release.resolve(f.heroSettings({ enabled: true }, 2));
  await pending;
  assert.equal(f.api.heroOwner, 'merchant-b');
  assert.deepEqual(clone(f.api.heroSettings), f.heroSaved.get('merchant-b'));
  assert.equal(f.heroInput('enabled').getAttribute('aria-checked'), 'false');
  assert.equal(f.heroInput('rewards').getAttribute('aria-checked'), 'false');
});

await test('超凡英雄旧读取与配置草稿失败均不能覆盖新值', async () => {
  const f = fixture();
  await f.api.refresh(); f.api.selectHero();
  const entered = deferred(), release = deferred();
  let delayed = false;
  f.state.respond = request => {
    if (!delayed && request.route === '/api/hero-raid/settings' && request.method === 'GET') {
      delayed = true; entered.resolve(); return release.promise;
    }
  };
  const reading = f.api.readHeroSettings('merchant-a');
  await entered.promise;
  const previous = clone(f.heroSaved.get('merchant-a'));
  await f.clickHero('enabled');
  release.resolve(previous); await reading;
  assert.equal(f.api.heroSettings.settings.enabled, true);
  f.context.configFlush = async () => false;
  await f.clickHero('orders');
  assert.equal(f.heroInput('orders').getAttribute('aria-checked'), 'false');
  assert.equal(f.state.calls.filter(call => call.method === 'POST').length, 1);
});

await test('海商王未开放默认收起，未连接与暂停仍能编辑已有配置', async () => {
  for (const state of ['connected', 'paused', 'notConnected', 'disconnected', 'readFailed']) {
    const f = fixture();
    if (state === 'paused') f.context.snapshot.paused = true;
    if (state === 'notConnected') f.context.snapshot.connected = false;
    if (state === 'disconnected') f.context.disconnected.add('merchant-a');
    if (state === 'readFailed') f.state.respond = request => {
      if (request.route === '/api/activities') throw Error('活动读取失败');
    };
    await f.api.refresh();
    const tabs = f.node('activity-tabs'), group = tabs.querySelector('#activity-group-upcoming');
    assert.equal(group.hidden, true);
    assert(group.querySelector('[data-activity=merchant]'));
    assert(!tabs.querySelector('.activity-current-tabs').querySelector('[data-activity=merchant]'));
    assert.equal(f.api.rows().find(row => row.id === 'merchant').kind, 'weekly');
    tabs.querySelector('[data-activity-group=upcoming]').onclick();
    tabs.querySelector('[data-activity=merchant]').onclick();
    assert.equal(f.node('activity-title').textContent, '海商王');
    assert.equal(f.seaInput('schedule.merchantTrade').getAttribute('aria-checked'), 'false');
    await f.setSea('schedule.merchantTrade');
    assert.equal(f.seaSaved.get('merchant-a').settings.schedule.merchantTrade, true);
    assert(!f.node('activities-list').textContent.includes('暂未接入'));
    assert.equal(f.node('activities-list').querySelectorAll('[data-auto-task]').length, 0);
    assert(!f.state.calls.some(call => call.route === '/api/activities/run'));
  }
});

await test('海商王全部参数沿用类型和约束，父项关闭隐藏后代并保留选择', async () => {
  const f = fixture();
  f.seaSaved.set('merchant-a', f.seaSettings({ autoSpeedUp: true, autoBuyPointers: true, autoUpgrade: true,
    speedUpMode: 'refresh', firstDepartureMode: 'time', pointerDailyDiamondLimit: 300 }));
  await f.api.refresh(); f.api.selectSea();
  const fields = merchantActivityFields.filter(field => field.key !== 'merchant.firstDepartureWaitMinutes');
  assert.deepEqual(f.seaControls().map(control => control.dataset.seaMerchantSetting), fields.map(field => field.key));
  for (const field of fields) {
    const input = f.seaInput(field.key);
    const [group, key] = field.key.split('.');
    const value = f.seaSaved.get('merchant-a').settings[group][key];
    if (field.kind === 'switch') assert.equal(input.getAttribute('aria-checked'), String(value));
    else assert.equal(input.value, value);
    if (field.kind === 'number') {
      assert.equal(input.type, 'number');
      assert.equal(input.min, settingsUiRules().numbers[field.key].min);
      assert.equal(input.max, settingsUiRules().numbers[field.key].max);
    }
    if (field.kind === 'choice') assert.equal(input.tagName, 'SELECT');
    if (field.kind === 'time') assert.equal(input.type, 'time');
  }
  await f.setSea('merchant.autoSpeedUp');
  assert(!f.seaInput('merchant.autoBuyPointers'));
  assert(!f.seaInput('merchant.pointerDailyDiamondLimit'));
  assert.equal(f.seaSaved.get('merchant-a').settings.merchant.autoBuyPointers, true);
  assert.equal(f.seaSaved.get('merchant-a').settings.merchant.pointerDailyDiamondLimit, 300);
  await f.setSea('merchant.autoSpeedUp');
  assert.equal(f.seaInput('merchant.pointerDailyDiamondLimit').valueAsNumber, 300);
  await f.setSea('merchant.firstDepartureMode', 'smart');
  assert(f.seaInput('merchant.firstDepartureWaitMinutes'));
  assert(!f.seaInput('merchant.firstDepartureTime'));
});

await test('海商王开关、整数、选择与时间逐项保存，非法输入回退且不提交', async () => {
  const f = fixture();
  await f.api.refresh(); f.api.selectSea();
  await f.setSea('merchant.profitLimit', 123456);
  await f.setSea('merchant.speedUpMode', 'arrival');
  await f.setSea('merchant.firstDepartureMode', 'time');
  await f.setSea('merchant.firstDepartureTime', '09:15');
  await f.setSea('schedule.merchantRewards');
  await f.setSea('schedule.tradeTasks');
  const expected = f.seaSettings({ profitLimit: 123456, speedUpMode: 'arrival', firstDepartureMode: 'time', firstDepartureTime: '09:15' },
    { merchantRewards: false, tradeTasks: false }).settings;
  assert.deepEqual(f.seaSaved.get('merchant-a').settings, expected);
  const count = f.state.calls.filter(call => call.method === 'POST').length;
  for (const invalid of ['', -1, 0.5, 1000000001, 'oops']) await f.setSea('merchant.profitLimit', invalid);
  for (const invalid of ['', '24:00', '9:15', '12:60']) await f.setSea('merchant.firstDepartureTime', invalid);
  await f.setSea('merchant.speedUpMode', 'unknown');
  assert.equal(f.state.calls.filter(call => call.method === 'POST').length, count);
  assert.equal(f.seaInput('merchant.profitLimit').valueAsNumber, 123456);
  assert.equal(f.seaInput('merchant.firstDepartureTime').value, '09:15');
  assert.equal(f.seaInput('merchant.speedUpMode').value, 'arrival');
  assert.deepEqual(f.seaSaved.get('merchant-b'), f.seaSettings({ profitLimit: 100 }, { merchantRewards: false }, 3));
});

await test('海商王读取到真实开放期次自动移上，结束收起并支持历史离线编辑', async () => {
  const f = fixture(), now = f.activities.serverNow;
  f.seaSaved.set('merchant-a', f.seaSettings({}, { merchantTrade: true }));
  await f.api.refresh();
  const tabs = f.node('activity-tabs');
  f.activities.activities.push({ id: 'merchant', name: '海商王', kind: 'weekly', observed: true,
    startTime: now - 60, endTime: now + 60, taskKeys: ['merchantTrade', 'merchantRewards', 'tradeTasks'] });
  f.activities.eventTasks.push(...['merchantTrade', 'merchantRewards', 'tradeTasks'].map(key => ({ key, enabled: true, label: key })));
  await f.api.refresh();
  assert.equal(f.api.rows().filter(row => row.id === 'merchant').length, 1);
  assert(tabs.querySelector('.activity-current-tabs').querySelector('[data-activity=merchant]'));
  f.api.selectSea();
  assert.match(f.node('activity-end').textContent, /开始 .*结束 .*北京时间/);
  assert.equal(f.seaInput('schedule.merchantTrade').getAttribute('aria-checked'), 'true');
  assert.equal(f.node('activities-list').querySelectorAll('[data-auto-task]').length, 0);
  f.state.now += 60000; f.api.render();
  assert.equal(tabs.querySelector('#activity-group-ended').hidden, true);
  assert(tabs.querySelector('#activity-group-ended').querySelector('[data-activity=merchant]'));
  f.context.snapshot.connected = false;
  f.catalog.activities = [{ ...f.activities.activities.at(-1), id: 'archive:merchant', sourceId: 'merchant', observed: false }];
  await f.api.refresh(); f.api.selectSea();
  assert(!f.api.rows().some(row => row.id === 'merchant'));
  assert.equal(f.seaInput('schedule.merchantTrade').getAttribute('aria-checked'), 'true');
  await f.setSea('merchant.profitLimit', 6789);
  assert.equal(f.seaSaved.get('merchant-a').settings.merchant.profitLimit, 6789);
});

await test('海商王保存失败回读原值，保存前读取最新版本且配置草稿失败阻止提交', async () => {
  const f = fixture();
  await f.api.refresh(); f.api.selectSea();
  f.state.respond = request => { if (request.method === 'POST') throw Error('保存失败'); };
  await f.setSea('merchant.profitLimit', 100);
  assert.equal(f.seaInput('merchant.profitLimit').valueAsNumber, 0);
  assert(f.seaControls().every(control => !control.disabled));
  f.state.respond = null;
  f.seaSaved.set('merchant-a', f.seaSettings({ autoShareIntel: false }, { merchantRewards: false }, 9));
  await f.setSea('merchant.profitLimit', 200);
  assert.equal(f.state.calls.filter(call => call.method === 'POST').at(-1).body.revision, 9);
  assert.deepEqual(f.seaSaved.get('merchant-a').settings, f.seaSettings({ profitLimit: 200, autoShareIntel: false }, { merchantRewards: false }).settings);
  f.context.configFlush = async () => false;
  const count = f.state.calls.filter(call => call.method === 'POST').length;
  await f.setSea('merchant.profitLimit', 300);
  assert.equal(f.state.calls.filter(call => call.method === 'POST').length, count);
  assert.equal(f.seaInput('merchant.profitLimit').valueAsNumber, 200);
});

await test('海商王保存期间禁用控件并合并重复操作，切号隔离迟到回包', async () => {
  const f = fixture();
  await f.api.refresh(); f.api.selectSea();
  const entered = deferred(), release = deferred();
  f.state.respond = request => {
    if (request.route === '/api/merchant/settings' && request.method === 'POST') {
      entered.resolve(); return release.promise;
    }
  };
  const pending = f.setSea('schedule.merchantTrade');
  await entered.promise;
  assert(f.seaControls().every(control => control.disabled));
  await f.api.saveSea('merchant.profitLimit', 500);
  assert.equal(f.state.calls.filter(call => call.method === 'POST').length, 1);
  f.context.current = 'merchant-b';
  await f.api.refresh(); f.api.selectSea();
  release.resolve(f.seaSettings({}, { merchantTrade: true }, 2));
  await pending;
  assert.equal(f.api.seaOwner, 'merchant-b');
  assert.deepEqual(clone(f.api.seaSettings), f.seaSaved.get('merchant-b'));
  assert.equal(f.seaInput('merchant.profitLimit').valueAsNumber, 100);
  assert.equal(f.seaInput('schedule.merchantTrade').getAttribute('aria-checked'), 'false');
});

await test('海商王迟到读取不会覆盖新保存，保存回复丢失后回读确认结果', async () => {
  const f = fixture();
  await f.api.refresh(); f.api.selectSea();
  const entered = deferred(), release = deferred();
  let delayed = false;
  f.state.respond = request => {
    if (!delayed && request.route === '/api/merchant/settings' && request.method === 'GET') {
      delayed = true; entered.resolve(); return release.promise;
    }
  };
  const previous = clone(f.seaSaved.get('merchant-a'));
  const reading = f.api.readSeaSettings('merchant-a');
  await entered.promise;
  await f.setSea('schedule.merchantTrade');
  release.resolve(previous); await reading;
  assert.equal(f.api.seaSettings.settings.schedule.merchantTrade, true);
  f.state.respond = request => {
    if (request.route === '/api/merchant/settings' && request.method === 'POST') {
      const saved = clone(f.seaSaved.get('merchant-a'));
      saved.settings.merchant.profitLimit = request.body.value;
      saved.revision++;
      saved.baseRevision = 'base-' + saved.revision;
      f.seaSaved.set('merchant-a', saved);
      throw Error('保存回复暂时不可读');
    }
  };
  await f.setSea('merchant.profitLimit', 800);
  assert.equal(f.seaInput('merchant.profitLimit').valueAsNumber, 800);
  assert(f.seaControls().every(control => !control.disabled));
});

await test('不差钱和海商王的自动挂机总开关独立保存，关闭后保留执行细项', async () => {
  const f = fixture();
  f.saved.set('merchant-a', f.settings({ autoSubmit: true, allowDiamonds: true, autoFinal: false }));
  f.seaSaved.set('merchant-a', f.seaSettings({ enabled: true, autoShareIntel: false, profitLimit: 300 },
    { merchantTrade: true, merchantRewards: false, tradeTasks: true }));
  await f.api.refresh(); f.api.selectMerchant();
  const merchantBefore = clone(f.saved.get('merchant-a').settings);
  await f.click('enabled');
  assert.deepEqual(f.saved.get('merchant-a').settings, { ...merchantBefore, enabled: false });
  assert.equal(f.input('enabled').getAttribute('aria-checked'), 'false');
  assert.equal(f.input('autoSubmit').disabled, false, '暂停活动后仍可预选执行细项');
  await f.click('enabled');
  assert.deepEqual(f.saved.get('merchant-a').settings, merchantBefore);
  f.api.selectSea();
  const seaBefore = clone(f.seaSaved.get('merchant-a').settings);
  assert.equal(f.seaInput('merchant.enabled').getAttribute('aria-label'), '开启自动挂机');
  await f.setSea('merchant.enabled');
  assert.deepEqual(f.seaSaved.get('merchant-a').settings,
    { ...seaBefore, merchant: { ...seaBefore.merchant, enabled: false } });
  assert.equal(f.seaInput('schedule.merchantTrade').disabled, false);
  await f.setSea('merchant.enabled');
  assert.deepEqual(f.seaSaved.get('merchant-a').settings, seaBefore);
  assert(f.state.calls.filter(call => call.method === 'POST').every(call =>
    call.body.key === 'enabled' || call.body.key === 'merchant.enabled'));
});

function lotteryFixture() {
  const f = fixture(), now = Math.floor(f.state.now / 1000);
  f.automationSaved.set('merchant-a', f.automationSettings({ 'activityAutomation.weekLottery': true }));
  f.activities.activities = [{ id: 'weekly:4:1001:1', name: '幸运转盘', kind: 'weekly', weekType: 4,
    startTime: now - 100, endTime: now + 3600,
    taskKeys: ['weekGift', 'weekTimes', 'weekLotterySpin'],
    automation: { key: 'activityAutomation.weekLottery', enabled: true } }];
  f.activities.eventTasks = [
    { key: 'weekGift', label: '免费礼包', enabled: true },
    { key: 'weekTimes', label: '次数奖励', enabled: true },
    { key: 'weekLotterySpin', label: '使用周转盘币', enabled: false },
  ];
  f.selectLottery = () => f.api.select('weekly:4:1001:1');
  return f;
}

await test('普通活动每期复用一个总开关，保存只修改所选活动且保留细项', async () => {
  const f = lotteryFixture();
  await f.api.refresh(); f.selectLottery();
  assert.equal(f.automationControls().length, 1);
  const key = 'activityAutomation.weekLottery';
  assert.equal(f.automationInput(key).getAttribute('aria-label'), '开启自动挂机');
  const tasks = clone(f.activities.eventTasks), before = clone(f.automationSaved.get('merchant-a').settings);
  f.automationSaved.set('merchant-a', f.automationSettings({ 'activityAutomation.weekLottery': true, 'activityAutomation.beauty': false }, 9));
  await f.clickAutomation(key);
  assert.equal(f.automationInput(key).getAttribute('aria-checked'), 'false');
  assert.deepEqual(f.automationSaved.get('merchant-a').settings,
    { ...before, [key]: false, 'activityAutomation.beauty': false });
  assert.deepEqual(f.activities.eventTasks, tasks);
  const post = f.state.calls.find(call => call.method === 'POST');
  assert.equal(post.route, '/api/activities/settings');
  assert.deepEqual(post.body, { key, value: false, revision: 9, baseRevision: 'base-9', confirm: true });
  await f.clickAutomation(key);
  assert.equal(f.automationInput(key).getAttribute('aria-checked'), 'true');
  assert.deepEqual(f.activities.eventTasks, tasks);
  assert(!f.state.calls.some(call => call.route === '/api/loop/start' || call.route === '/api/activities/run'));
});

await test('普通活动在未开放、结束、暂停或离线时均可保存自动挂机开关', async () => {
  for (const state of ['upcoming', 'ended', 'paused', 'disconnected']) {
    const f = lotteryFixture(), now = Math.floor(f.state.now / 1000);
    if (state === 'upcoming') Object.assign(f.activities.activities[0], { startTime: now + 60, endTime: now + 3600 });
    if (state === 'ended') Object.assign(f.activities.activities[0], { startTime: now - 3600, endTime: now - 1 });
    if (state === 'paused') f.context.snapshot.paused = true;
    if (state === 'disconnected') f.context.snapshot.connected = false;
    f.catalog.activities = clone(f.activities.activities);
    f.catalog.eventTasks = clone(f.activities.eventTasks);
    await f.api.refresh(); f.selectLottery();
    const input = f.automationInput('activityAutomation.weekLottery');
    assert(input && !input.disabled, state + ' 可以编辑总开关');
    assert(f.node('activities-list').querySelectorAll('[data-activity-run]').every(button => button.disabled));
    await f.clickAutomation('activityAutomation.weekLottery');
    assert.equal(f.automationSaved.get('merchant-a').settings['activityAutomation.weekLottery'], false);
    if (state === 'paused' || state === 'disconnected') assert(!f.state.calls.some(call => call.route === '/api/activities'));
  }
});

await test('普通活动配置保存期间锁定总开关，账号切换后迟到回复不串号', async () => {
  const f = lotteryFixture();
  await f.api.refresh(); f.selectLottery();
  const entered = deferred(), release = deferred();
  f.state.respond = request => {
    if (request.route === '/api/activities/settings' && request.method === 'POST') {
      entered.resolve(); return release.promise;
    }
  };
  const saving = f.clickAutomation('activityAutomation.weekLottery');
  await entered.promise;
  assert(f.automationControls().every(control => control.disabled));
  await f.api.saveAutomation('activityAutomation.weekLottery', true);
  await f.api.refresh(); f.selectLottery();
  assert(f.automationControls().every(control => control.disabled));
  assert.equal(f.state.calls.filter(call => call.method === 'POST').length, 1);
  f.context.current = 'merchant-b';
  await f.api.refresh(); f.selectLottery();
  assert.equal(f.api.automationOwner, 'merchant-b');
  release.resolve(f.automationSettings({ 'activityAutomation.weekLottery': false }, 2));
  await saving;
  assert.deepEqual(clone(f.api.automationSettings), f.automationSaved.get('merchant-b'));
  assert.equal(f.automationInput('activityAutomation.weekLottery').getAttribute('aria-checked'), 'false');
  assert.equal(f.automationInput('activityAutomation.weekLottery').disabled, false);
});

await test('普通活动总开关保存失败后回读恢复，草稿保存失败阻止写入', async () => {
  const f = lotteryFixture();
  await f.api.refresh(); f.selectLottery();
  f.state.respond = request => {
    if (request.route === '/api/activities/settings' && request.method === 'POST') throw Error('总开关保存失败');
  };
  await f.clickAutomation('activityAutomation.weekLottery');
  assert.equal(f.automationInput('activityAutomation.weekLottery').getAttribute('aria-checked'), 'true');
  assert.equal(f.automationInput('activityAutomation.weekLottery').disabled, false);
  assert(f.state.errors.some(error => error.message === '总开关保存失败'));
  const writes = f.state.calls.filter(call => call.method === 'POST').length;
  f.state.respond = null;
  f.context.configFlush = async () => false;
  await f.clickAutomation('activityAutomation.weekLottery');
  assert.equal(f.state.calls.filter(call => call.method === 'POST').length, writes);
  assert.equal(f.automationInput('activityAutomation.weekLottery').disabled, false);
});

await test('普通活动旧读取不覆盖新总开关，保存回包丢失由回读确认', async () => {
  const f = lotteryFixture();
  await f.api.refresh(); f.selectLottery();
  const entered = deferred(), release = deferred();
  let delayed = false;
  f.state.respond = request => {
    if (!delayed && request.route === '/api/activities/settings' && request.method === 'GET') {
      delayed = true; entered.resolve(); return release.promise;
    }
  };
  const before = clone(f.automationSaved.get('merchant-a'));
  const reading = f.api.readAutomationSettings('merchant-a');
  await entered.promise;
  await f.clickAutomation('activityAutomation.weekLottery');
  const revision = f.api.automationSettings.revision;
  release.resolve(before); await reading;
  assert.equal(f.api.automationSettings.settings['activityAutomation.weekLottery'], false);
  assert.equal(f.api.automationSettings.revision, revision);
  f.state.respond = request => {
    if (request.route === '/api/activities/settings' && request.method === 'POST') {
      const next = clone(f.automationSaved.get('merchant-a'));
      next.settings[request.body.key] = request.body.value;
      next.revision++;
      next.baseRevision = 'base-' + next.revision;
      f.automationSaved.set('merchant-a', next);
      throw Error('保存回复丢失');
    }
  };
  await f.clickAutomation('activityAutomation.weekLottery');
  assert.equal(f.automationInput('activityAutomation.weekLottery').getAttribute('aria-checked'), 'true');
  assert.equal(f.automationInput('activityAutomation.weekLottery').disabled, false);
});

await test('活动元数据可定位无任务列表的已接入开关，纯展示活动不生成开关', async () => {
  const f = lotteryFixture(), now = Math.floor(f.state.now / 1000);
  f.activities.activities.push(
    { id: 'beauty', name: '海上风采大赛', kind: 'limited', startTime: now - 100, endTime: now + 1000,
      taskKeys: [], automation: { key: 'activityAutomation.beauty', enabled: true } },
    { id: 'magicOcean', name: '神奇海洋', kind: 'limited', startTime: now - 100, endTime: now + 1000, taskKeys: [] },
  );
  await f.api.refresh(); f.api.select('beauty');
  assert.equal(f.automationControls().length, 3);
  assert(f.automationInput('activityAutomation.beauty'));
  f.api.select('magicOcean');
  assert.equal(f.automationControls().length, 0);
  f.activities.status.pirates = { rankOpen: true };
  await f.api.refresh(); f.api.select('pirates');
  assert.deepEqual(f.automationControls().map(control => control.dataset.activityAutomation),
    ['activityAutomation.pirates', 'activityAutomation.openRank']);
  assert(f.automationInput('activityAutomation.pirates').getAttribute('aria-label').includes('海盗战报奖励'));
  assert(f.automationInput('activityAutomation.openRank').getAttribute('aria-label').includes('开服冲榜'));
});

await test('风采大赛随期次展示三个开关，历史与离线可改细项且不触发投票', async () => {
  for (const state of ['active', 'upcoming', 'ended', 'offline']) {
    const f = fixture(), now = Math.floor(f.state.now / 1000);
    const archived = state === 'ended' || state === 'offline';
    const row = { id: archived ? 'archive:beauty-old' : 'beauty', ...(archived ? { sourceId: 'beauty', observed: false } : {}),
      name: '海上风采大赛', kind: 'limited', taskKeys: [],
      startTime: state === 'upcoming' ? now + 60 : now - 3600,
      endTime: archived ? now - 1 : now + 3600,
      automation: { key: 'activityAutomation.beauty', enabled: false } };
    f.activities.activities = [row];
    f.catalog.activities = clone([row]);
    if (state === 'offline') f.context.snapshot.connected = false;
    f.automationSaved.set('merchant-a', f.automationSettings({
      'activityAutomation.beauty': false, 'schedule.beautyVotes': true, 'schedule.beautyGift': false,
    }));
    const other = clone(f.automationSaved.get('merchant-b'));
    await f.api.refresh(); f.api.select(row.id);
    assert.equal(f.automationControls().length, 3, state);
    assert.equal(f.automationInput('schedule.beautyVotes').getAttribute('aria-checked'), 'true');
    assert.equal(f.automationInput('schedule.beautyGift').getAttribute('aria-label'), '领取每日投票礼包');
    assert.match(f.node('activities-list').textContent, /每天投够\s*3\s*票/);
    await f.clickAutomation('schedule.beautyGift');
    await f.clickAutomation('schedule.beautyVotes');
    assert.equal(f.automationSaved.get('merchant-a').settings['activityAutomation.beauty'], false);
    assert.equal(f.automationSaved.get('merchant-a').settings['schedule.beautyGift'], true);
    await f.api.refresh(); f.api.select(row.id);
    assert.equal(f.automationInput('schedule.beautyVotes').getAttribute('aria-checked'), 'false');
    assert.equal(f.automationInput('schedule.beautyGift').getAttribute('aria-checked'), 'true');
    assert.deepEqual(f.automationSaved.get('merchant-b'), other);
    assert(!f.state.calls.some(call => ['/api/activities/run', '/api/loop/start'].includes(call.route)));
    assert.equal(f.node('activities-list').querySelectorAll('[data-activity-run]').length, 0);
  }
  const empty = fixture();
  await empty.api.refresh();
  assert(!empty.api.rows().some(row => row.id === 'beauty' || row.sourceId === 'beauty'), '没有期次时不补固定占位');
});

await test('联盟商船在活动页独立配置，离线及暂停可编辑且不出现挂机开关跳转', async () => {
  for (const state of ['connected', 'paused', 'offline']) {
    const f = fixture();
    if (state === 'paused') f.context.snapshot.paused = true;
    if (state === 'offline') f.context.snapshot.connected = false;
    await f.api.refresh(); f.api.selectShip();
    const row = f.api.rows().find(row => row.id === 'guildShip');
    assert.equal(row.kind, 'limited');
    assert.equal(f.api.lifecycle(row), 'upcoming');
    assert.equal(f.node('activity-kind').textContent, '限时');
    assert.doesNotMatch(f.node('activities-list').textContent, /联盟自动化总开关|前往开启联盟自动化/);
    assert.doesNotMatch(f.node('activities-list').textContent, /当前活动暂未接入/);
    assert.match(f.node('activities-list').textContent, /红船缺料备料需开启工厂生产/);
    await f.shipInput('guildShip.crew').onclick();
    await f.api.saveShip('guildShip.enabled', true);
    await f.api.saveShip('guildShip.enabled', false);
    assert.equal(f.shipSaved.get('merchant-a').settings.guildShip.crew, true);
    assert.equal(f.shipSaved.get('merchant-b').settings.guildShip.crew, false);
    assert(f.shipControls().every(control => !control.disabled));
    assert(!f.state.calls.some(call => call.route === '/api/activities/run'));
  }
});

await test('商船策略、条件参数和材料多选沿用原字段，未知旧材料仍可查看清除', async () => {
  const f = fixture();
  f.shipSaved.get('merchant-a').settings.guildShip.disabledMaterials = ['旧物料'];
  await f.api.refresh(); f.api.selectShip();
  const mode = f.shipInput('guildShip.mode');
  mode.value = 'full'; await mode.onchange();
  await f.shipInput('guildShip.rewardFilter').onclick();
  await f.shipInput('guildShip.redStartEnabled').onclick();
  assert(f.shipInput('guildShip.rewardItems'));
  const time = f.shipInput('guildShip.redStartTime');
  time.value = '23:25'; await time.onchange();
  await f.shipInput('guildShip.coinFilter').onclick();
  const coins = f.shipInput('guildShip.minCoinsSmall');
  coins.value = '-1'; await coins.onchange();
  assert(f.state.errors.some(error => error.message.includes('整数')));
  const materials = f.shipInput('guildShip.disabledMaterials');
  assert.match(materials.textContent, /旧物料/);
  materials.open = true; materials.ontoggle();
  const option = materials.querySelectorAll('.config-option').find(row => row.textContent === '木板');
  const pending = deferred();
  f.state.respond = request => {
    if (request.route === '/api/guild-ship/settings' && request.method === 'POST') return pending.promise;
  };
  const checkbox = option.querySelector('input'); checkbox.checked = true; checkbox.onchange();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.state.calls.filter(call => call.method === 'POST').at(-1).body.value, ['旧物料', '木板']);
  assert(f.shipControls().every(control => control.disabled));
  const locked = f.shipInput('guildShip.disabledMaterials'); locked.open = true; locked.ontoggle();
  assert(locked.querySelectorAll('input').filter(input => input.type === 'checkbox').every(input => input.disabled));
  pending.resolve(undefined); f.state.respond = null;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.shipSaved.get('merchant-a').settings.guildShip.disabledMaterials, ['旧物料', '木板']);
  const saved = f.shipSaved.get('merchant-a').settings.guildShip;
  assert.equal(saved.mode, 'full'); assert.equal(saved.redStartTime, '23:25');
  assert.equal(saved.minCoinsSmall, defaultSettings().guildShip.minCoinsSmall);
});

await test('商船当前期次替换预配置入口，结束及历史期次继续可编辑且保持限时分类', async () => {
  const f = fixture(), now = f.activities.serverNow;
  f.activities.activities.push({ id: 'guildShip', name: '联盟商船', kind: 'limited',
    startTime: now - 30, endTime: now + 30, taskKeys: [] });
  await f.api.refresh(); f.api.selectShip();
  assert.equal(f.api.rows().filter(row => row.id === 'guildShip').length, 1);
  assert.equal(f.api.lifecycle(f.api.rows().find(row => row.id === 'guildShip')), 'active');
  assert(f.shipInput('guildShip.enabled'));
  f.state.now += 30000; f.api.render(); f.api.selectShip();
  assert.equal(f.api.lifecycle(f.api.rows().find(row => row.id === 'guildShip')), 'ended');
  assert.match(f.node('activities-list').textContent, /本期活动已结束/);
  f.context.snapshot.connected = false;
  f.catalog.activities = [{ ...f.activities.activities.at(-1), sourceId: 'guildShip', id: 'archive:ship', observed: false }];
  await f.api.refresh(); f.api.selectShip();
  assert.equal(f.node('activity-kind').textContent, '限时');
  await f.shipInput('guildShip.captain').onclick();
  assert.equal(f.shipSaved.get('merchant-a').settings.guildShip.captain, true);
});

await test('联盟商船配置读取晚到或保存前切号，不覆盖或误写另一账号', async () => {
  const f = fixture(); await f.api.refresh(); f.api.selectShip();
  const late = deferred();
  f.state.respond = request => request.route === '/api/guild-ship/settings' && request.account === 'merchant-a' ? late.promise : undefined;
  const read = f.api.readShipSettings('merchant-a');
  f.context.current = 'merchant-b'; await f.api.refresh(); f.api.selectShip();
  late.resolve(f.shipSettings({ mode: 'full' })); await read;
  assert.equal(f.api.shipOwner, 'merchant-b');
  assert.equal(f.api.shipSettings.settings.guildShip.mode, 'small');
  f.state.respond = null;
  const flush = deferred(); f.context.configFlush = () => flush.promise;
  const save = f.api.saveShip('guildShip.captain', true);
  f.context.current = 'merchant-a'; await f.api.refresh();
  flush.resolve(true); await save;
  assert(!f.state.calls.some(call => call.method === 'POST'));
});

console.log('活动分组与集中配置专项 ' + passed + '/' + passed + ' 通过');
