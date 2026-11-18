import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const script = fs.readFileSync(new URL('../src/lineup-editor.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/lineup-editor.css', import.meta.url), 'utf8');
const markup = fs.readFileSync(new URL('../src/ui/pages.tsx', import.meta.url), 'utf8');
const progression = fs.readFileSync(new URL('../src/ui/progression.js', import.meta.url), 'utf8');
const pageSource = fs.readFileSync(new URL('../src/page.mjs', import.meta.url), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

class Element {
  constructor(tag = 'div', className = '', text = '') {
    this.tagName = tag.toUpperCase(); this.className = className; this.text = text;
    this.children = []; this.dataset = {}; this.attributes = new Map(); this.style = {};
    this.disabled = false; this.isConnected = true; this.value = '';
    this.listeners = new Map();
    this.classList = {
      contains: value => this.className.split(' ').includes(value),
      add: value => { this.className = [...new Set([...this.className.split(' '), value])].join(' '); },
      remove: value => { this.className = this.className.split(' ').filter(item => item !== value).join(' '); },
    };
  }
  get firstElementChild() { return this.children[0]; }
  get lastElementChild() { return this.children.at(-1); }
  get textContent() { return this.text + this.children.map(item => item.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
  appendChild(item) { this.append(item); return item; }
  add(item) { this.append(item); }
  replaceChildren(...items) { this.children = []; this.text = ''; this.append(...items); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key); }
  removeAttribute(key) { this.attributes.delete(key); }
  contains(node) { return this === node || this.children.some(item => item.contains?.(node)); }
  querySelectorAll(selector) {
    const matches = node => {
      if (selector === '[aria-label]') return node.attributes.has('aria-label');
      if (selector === '[data-lineup-position]') return Boolean(node.dataset.lineupPosition);
      if (selector === '[data-lineup-preset]') return Boolean(node.dataset.lineupPreset);
      if (selector === '[data-lineup-choice-status]') return Boolean(node.dataset.lineupChoiceStatus);
      if (selector === 'button[aria-label^="编辑阵容"]') return node.tagName === 'BUTTON' && node.getAttribute('aria-label')?.startsWith('编辑阵容');
      if (selector === 'button[aria-label^="查看阵容"]') return node.tagName === 'BUTTON' && node.getAttribute('aria-label')?.startsWith('查看阵容');
      return node.tagName.toLowerCase() === selector;
    };
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
  dispatch(type) { const result = this['on' + type]?.(); for (const listener of this.listeners.get(type) || []) listener(); return result; }
  focus() { this.focused = true; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.isConnected = false; }
  replaceWith(element) { const index = this.parent.children.indexOf(this); this.parent.children[index] = element; element.parent = this.parent; this.isConnected = false; }
  showModal() { this.open = true; }
  close() { this.open = false; this.onclose?.(); }
  scrollIntoView() {}
  setPointerCapture(id) { this.pointerId = id; }
  hasPointerCapture(id) { return this.pointerId === id; }
  releasePointerCapture() { this.pointerId = null; }
}

const formation = (items = [['a', 1, 1], ['b', 4, 4]]) => ({ presetId: 1, petUid: '0',
  heroPositions: items.map(([heroId, x, y]) => ({ heroId, pos: { x, y } })) });
const editorData = () => ({
  formation: formation(), capacity: 2,
  heroes: ['a', 'b', 'c'].map(heroId => ({ heroId, name: '英雄' + heroId, quality: 'ORANGE' })),
  formations: [
    { presetId: 1, name: '基础阵型', unlocked: true, positions: [{ x: 1, y: 1 }, { x: 4, y: 4 }, { x: 1, y: 3 }] },
    { presetId: 2, name: '新阵型', unlocked: true, positions: [{ x: 2, y: 0 }, { x: 5, y: 3 }, { x: 2, y: 6 }] },
    { presetId: 3, name: '未解锁阵型', unlocked: false, positions: [{ x: 1, y: 1 }] },
  ],
  pets: [{ uid: '9223372036854775806', name: '海兽' }],
});
const savedData = (name = '阵容A', revision = 1) => ({
  presets: [{ id: 'p1', name, formation: formation() }], mainlinePresetId: '', trialPresets: [], revision,
  recovery: null, trialRaids: [{ value: '1', label: '试炼一' }],
});

function fixture({ server = new Map([['account-a', savedData()]]) } = {}) {
  const host = new Element(), body = new Element('body'), selectors = [], calls = [], renders = [], errors = [];
  body.append(host);
  const runtime = { response: null, drop: null, server };
  const respond = request => {
    const data = server.get(request.account) || savedData();
    if (request.url.startsWith('/api/lineup-presets/bind?')) {
      if (request.body.revision !== data.revision) throw Object.assign(new Error('配置版本冲突'), { fields: { revision: '已变化' } });
      const updated = { ...data, mainlinePresetId: request.body.mainlinePresetId,
        trialPresets: clone(request.body.trialPresets), revision: data.revision + 1 };
      server.set(request.account, updated);
      return clone(updated);
    }
    return clone(data);
  };
  const context = vm.createContext({
    current: 'account-a', structuredClone, Date, console,
    localStorage: {
      getItem() { assert.fail('挑战阵容应从服务器配置读取'); },
      setItem() { assert.fail('挑战阵容应写入服务器配置'); },
    },
    reportError: (error, action, account) => errors.push({ message: error.message, action, account }),
    $: id => id === 'saved-lineup-view' ? host : null,
    el: (tag, className, text) => new Element(tag, className, text),
    Option: class extends Element { constructor(text, value) { super('option', '', text); this.value = value; } },
    document: { body, activeElement: null, querySelectorAll: selector => selector === 'select[data-lineup-mode]' ? selectors : body.querySelectorAll(selector), elementFromPoint: () => runtime.drop },
    call: async (url, options) => {
      const request = { url, account: new URL(url, 'http://localhost').searchParams.get('account'),
        body: options?.body && JSON.parse(options.body) };
      calls.push(request);
      return runtime.response ? runtime.response(request) : respond(request);
    },
    clear: element => { element.textContent = ''; return element; },
    smallButton: label => new Element('button', '', label),
    iconEl: (icon, size, name) => new Element('span', '', name),
  });
  vm.runInContext(script, context);
  const realRender = context.renderSavedLineups, realRedraw = context.redrawLineupEditor;
  context.renderSavedLineups = account => renders.push(account);
  context.redrawLineupEditor = (state, account) => renders.push(account);
  const state = context.savedLineupState('account-a');
  context.adoptSavedLineups(state, clone(server.get('account-a') || savedData())); state.editor = editorData(); state.activeDraft = 'p1';
  state.drafts.set('p1', { id: 'p1', name: '阵容A', formation: formation(), dirty: false });
  return { context, state, runtime, calls, renders, host, body, selectors, server, respond, errors, realRender, realRedraw,
    draft: () => context.currentLineupDraft(state) };
}

let passed = 0;
async function test(name, run) { await run(); passed++; console.log('通过：' + name); }

await test('点选站位交换、替换、移动与人数上限共用同一逻辑', () => {
  const f = fixture(), { context, state } = f;
  assert.equal(context.placeLineupHero(state, 'a', { x: 4, y: 4 }), true);
  assert.deepEqual(clone(f.draft().formation.heroPositions), [{ heroId: 'b', pos: { x: 1, y: 1 } }, { heroId: 'a', pos: { x: 4, y: 4 } }]);
  assert.equal(context.placeLineupHero(state, 'c', { x: 1, y: 3 }), false);
  assert.match(state.editorMessage, /上限/);
  assert.equal(context.placeLineupHero(state, 'c', { x: 4, y: 4 }), true);
  assert.deepEqual(f.draft().formation.heroPositions.map(item => item.heroId), ['b', 'c']);
  assert.equal(context.placeLineupHero(state, 'b', { x: 1, y: 3 }), true);
  assert.equal(context.placeLineupHero(state, 'a', { x: 9, y: 9 }), false);
  assert.equal(context.placeLineupHero(state, 'unknown', { x: 1, y: 1 }), false);
  assert.equal(context.removeLineupHero(state, 'b'), true);
  assert.equal(f.draft().formation.heroPositions.length, 1);
});

await test('换阵型优先安排前排并保留英雄，锁定阵型不可切换', () => {
  const f = fixture();
  f.context.changeLineupFormation(f.state, 2);
  assert.equal(f.draft().formation.presetId, 2);
  assert.deepEqual(clone(f.draft().formation.heroPositions), [{ heroId: 'a', pos: { x: 5, y: 3 } }, { heroId: 'b', pos: { x: 2, y: 0 } }]);
  f.context.changeLineupFormation(f.state, 3);
  assert.equal(f.draft().formation.presetId, 2);
});

await test('Pointer拖拽交换与下阵，取消拖拽保留草稿', () => {
  const f = fixture(), source = new Element('button'), target = new Element('button');
  f.state.ui = { root: { contains: () => true } };
  target.dataset.lineupPosition = '4,4'; target.closest = () => target; f.runtime.drop = target;
  f.context.bindLineupPointer(source, f.state, 'account-a', 'a');
  source.onpointerdown({ button: 0, pointerId: 7, isPrimary: true, clientX: 10, clientY: 10 });
  source.onpointermove({ pointerId: 7, clientX: 100, clientY: 100, preventDefault() {} });
  assert.equal(target.dataset.lineupDrop, 'true');
  source.onpointerup({ pointerId: 7 });
  assert.equal(f.draft().formation.heroPositions.find(item => item.heroId === 'a').pos.x, 4);
  assert.equal(target.dataset.lineupDrop, undefined);
  const before = clone(f.draft().formation);
  source.onpointerdown({ button: 0, pointerId: 8, clientX: 10, clientY: 10 });
  source.onpointermove({ pointerId: 8, clientX: 100, clientY: 100, preventDefault() {} });
  source.onpointercancel();
  assert.deepEqual(clone(f.draft().formation), before);
  delete target.dataset.lineupPosition; target.dataset.lineupRemove = 'true';
  source.onpointerdown({ button: 0, pointerId: 9, clientX: 10, clientY: 10 });
  source.onpointermove({ pointerId: 9, clientX: 100, clientY: 100, preventDefault() {} });
  source.onpointerup({ pointerId: 9 });
  assert.equal(f.draft().formation.heroPositions.some(item => item.heroId === 'a'), false);
});

const chooseLineup = (f, mode, raidId, value, account = f.context.current) => {
  const select = f.context.createLineupSelect(account, mode, raidId);
  f.selectors.push(select);
  select.value = value;
  return { select, saving: select.onchange() };
};
const boundData = () => ({ ...savedData(),
  presets: [...savedData().presets, { id: 'p2', name: '阵容B', formation: formation() }],
  mainlinePresetId: 'p1', trialPresets: [{ raidId: '1', presetId: 'p2' }, { raidId: '2', presetId: 'p1' }],
});

await test('挑战阵容读取账号配置并按主线和各试炼隔离，删除选择明确显示', () => {
  const f = fixture({ server: new Map([['account-a', boundData()], ['account-b', { ...boundData(), mainlinePresetId: 'p2', trialPresets: [] }]]) });
  assert.equal(f.context.createLineupSelect('account-a', 'mainline').value, 'p1');
  const trial = f.context.createLineupSelect('account-a', 'trial', 1);
  assert.equal(trial.value, 'p2');
  assert.equal(f.context.selectedLineupId('trial', 2), 'p1');
  assert.equal(f.context.selectedLineupId('trial', 3), '');
  f.context.adoptSavedLineups(f.context.savedLineupState('account-b'), clone(f.server.get('account-b')));
  f.context.current = 'account-b';
  assert.equal(f.context.selectedLineupId('mainline'), 'p2');
  assert.equal(f.context.selectedLineupId('trial', 1), '');
  trial.value = ''; trial.onchange();
  assert.equal(f.calls.length, 0, '旧账号控件不能修改新账号配置');
  f.context.current = 'account-a'; f.selectors.push(trial); f.state.saved.presets = [];
  f.context.updateManualLineupSelects('account-a');
  assert.equal(trial.value, 'p2'); assert.match(trial.children.at(-1).textContent, /已删除/);
});

await test('选择挑战阵容立即写入账号配置，新页面直接恢复且只修改对应绑定', async () => {
  const server = new Map([['account-a', boundData()], ['account-b', savedData()]]), f = fixture({ server });
  const original = clone(server.get('account-a'));
  await chooseLineup(f, 'mainline', undefined, 'p2').saving;
  assert.equal(server.get('account-a').mainlinePresetId, 'p2');
  assert.deepEqual(server.get('account-a').trialPresets, original.trialPresets);
  await chooseLineup(f, 'trial', 1, 'p1').saving;
  assert.deepEqual(server.get('account-a').trialPresets, [{ raidId: '1', presetId: 'p1' }, { raidId: '2', presetId: 'p1' }]);
  assert.deepEqual(server.get('account-a').presets, original.presets);
  const reloaded = fixture({ server });
  assert.equal(reloaded.context.selectedLineupId('mainline'), 'p2');
  assert.equal(reloaded.context.createLineupSelect('account-a', 'trial', 1).value, 'p1');
  assert.equal(reloaded.context.createLineupSelect('account-a', 'trial', 2).value, 'p1');
  assert.equal(f.state.bindingError, '');
  assert(f.calls.every(request => new URL(request.url, 'http://localhost').pathname === '/api/lineup-presets' || request.url.startsWith('/api/lineup-presets/bind?')));
  assert(f.calls.filter(request => request.body).every(request => request.body.confirm === true));
  assert.equal(server.get('account-b').mainlinePresetId, '');
});

await test('改回游戏当前阵容清空相应配置，不影响其他试炼或账号', async () => {
  const server = new Map([['account-a', boundData()], ['account-b', boundData()]]), f = fixture({ server });
  await chooseLineup(f, 'mainline', undefined, '').saving;
  await chooseLineup(f, 'trial', 1, '').saving;
  const reloaded = fixture({ server });
  assert.equal(reloaded.context.selectedLineupId('mainline'), '');
  assert.equal(reloaded.context.selectedLineupId('trial', 1), '');
  assert.equal(reloaded.context.selectedLineupId('trial', 2), 'p1');
  assert.deepEqual(server.get('account-a').trialPresets, [{ raidId: '2', presetId: 'p1' }]);
  assert.deepEqual(server.get('account-b'), boundData());
});

await test('连续更改阵容按账号串行保存，较早响应不能覆盖最后选择', async () => {
  const f = fixture({ server: new Map([['account-a', boundData()]]) }), entered = deferred(), release = deferred();
  let writes = 0, concurrent = 0, peak = 0;
  f.runtime.response = async request => {
    if (!request.body) return f.respond(request);
    writes++; concurrent++; peak = Math.max(peak, concurrent);
    if (writes === 1) { entered.resolve(); await release.promise; }
    try { return f.respond(request); } finally { concurrent--; }
  };
  const first = chooseLineup(f, 'mainline', undefined, 'p2');
  await entered.promise;
  const latest = chooseLineup(f, 'mainline', undefined, '');
  const trial = chooseLineup(f, 'trial', 1, 'p1');
  assert.equal(f.context.selectedLineupId('mainline'), '', '保存中的新选择优先于旧响应');
  assert.equal(f.context.selectedLineupId('trial', 1), 'p1');
  release.resolve();
  await Promise.all([first.saving, latest.saving, trial.saving]);
  assert.equal(peak, 1); assert(writes >= 2);
  assert.equal(f.server.get('account-a').mainlinePresetId, '');
  assert.equal(f.server.get('account-a').trialPresets.find(item => item.raidId === '1').presetId, 'p1');
  assert.equal(f.context.selectedLineupId('mainline'), '');
  assert.equal(first.select.value, ''); assert.equal(latest.select.value, '');
});

await test('版本冲突后读取最新配置重试，保留其他入口新增的试炼绑定', async () => {
  const f = fixture({ server: new Map([['account-a', boundData()]]) });
  let writes = 0;
  f.runtime.response = request => {
    if (request.body && ++writes === 1) {
      const current = f.server.get('account-a');
      f.server.set('account-a', { ...current, revision: current.revision + 1,
        trialPresets: [...current.trialPresets, { raidId: '3', presetId: 'p2' }] });
    }
    return f.respond(request);
  };
  await chooseLineup(f, 'mainline', undefined, 'p2').saving;
  assert.equal(writes, 2);
  assert.equal(f.server.get('account-a').mainlinePresetId, 'p2');
  assert.deepEqual(f.server.get('account-a').trialPresets.at(-1), { raidId: '3', presetId: 'p2' });
  assert.equal(f.state.bindingError, '');
});

await test('配置保存失败恢复服务器选择并显示错误，之后仍可重新保存', async () => {
  const f = fixture({ server: new Map([['account-a', boundData()]]) });
  f.runtime.response = request => { if (request.body) throw new Error('配置写入失败'); return f.respond(request); };
  const status = f.context.createLineupChoiceStatus('account-a'); f.body.append(status);
  const failed = chooseLineup(f, 'mainline', undefined, 'p2');
  await failed.saving;
  assert.equal(f.context.selectedLineupId('mainline'), 'p1');
  assert.equal(failed.select.value, 'p1');
  assert.equal(f.server.get('account-a').mainlinePresetId, 'p1');
  assert.match(f.state.bindingError, /配置写入失败/);
  assert.match(status.textContent, /配置写入失败/);
  f.runtime.response = null;
  await chooseLineup(f, 'mainline', undefined, 'p2').saving;
  assert.equal(f.server.get('account-a').mainlinePresetId, 'p2');
  assert.equal(f.state.bindingError, '');
  assert.equal(status.textContent, '');
});

await test('保存回包丢失后回读服务器配置，不把已写入选择误还原', async () => {
  const f = fixture({ server: new Map([['account-a', boundData()]]) });
  f.runtime.response = request => {
    const result = f.respond(request);
    if (request.body) throw new Error('保存响应丢失');
    return result;
  };
  const { select, saving } = chooseLineup(f, 'mainline', undefined, 'p2');
  await saving;
  assert.equal(f.server.get('account-a').mainlinePresetId, 'p2');
  assert.equal(f.context.selectedLineupId('mainline'), 'p2');
  assert.equal(select.value, 'p2');
});

await test('阵容绑定保存中切号只更新原账号，其他账号选择保持独立', async () => {
  const server = new Map([['account-a', boundData()], ['account-b', { ...boundData(), mainlinePresetId: '' }]]);
  const f = fixture({ server }), entered = deferred(), release = deferred();
  f.runtime.response = async request => {
    if (request.account === 'account-a' && request.body) { entered.resolve(); await release.promise; }
    return f.respond(request);
  };
  const savingA = chooseLineup(f, 'mainline', undefined, 'p2').saving;
  await entered.promise;
  f.context.current = 'account-b';
  f.context.adoptSavedLineups(f.context.savedLineupState('account-b'), clone(server.get('account-b')));
  const savingB = chooseLineup(f, 'mainline', undefined, 'p1').saving;
  await savingB;
  assert.equal(f.context.selectedLineupId('mainline'), 'p1');
  f.renders.length = 0; release.resolve(); await savingA;
  assert.equal(server.get('account-a').mainlinePresetId, 'p2');
  assert.equal(server.get('account-b').mainlinePresetId, 'p1');
  assert.equal(f.context.selectedLineupId('mainline'), 'p1');
  assert(!f.renders.includes('account-b'), '旧账号保存响应不应重绘当前账号');
});

await test('服务器绑定变化时同步挑战选择，即使阵容列表本身没有变化', async () => {
  const f = fixture({ server: new Map([['account-a', boundData()]]) });
  const select = f.context.createLineupSelect('account-a', 'mainline'); f.selectors.push(select);
  const previous = f.server.get('account-a');
  f.server.set('account-a', { ...previous, mainlinePresetId: 'p2', revision: previous.revision + 1 });
  await f.context.refreshSavedLineups();
  assert.equal(select.value, 'p2'); assert.equal(f.context.selectedLineupId('mainline'), 'p2');
});

await test('读取结果过期与切号不会覆盖其他账号或编辑草稿', async () => {
  const f = fixture(), first = deferred(), second = deferred();
  let count = 0; f.runtime.response = () => ++count === 1 ? first.promise : second.promise;
  f.draft().name = '正在编辑';
  const oldRead = f.context.refreshSavedLineups(), newRead = f.context.refreshSavedLineups();
  second.resolve(savedData('最新预设', 3)); await newRead;
  f.context.current = 'account-b'; first.resolve(savedData('旧预设', 2)); await oldRead;
  assert.equal(f.state.saved.presets[0].name, '最新预设');
  assert.equal(f.draft().name, '正在编辑');
  assert(f.renders.every(account => account === 'account-a'));
  assert(f.calls.every(request => request.account === 'account-a'));
});

await test('编辑器并发读取保留最后一次结果和已有站位', async () => {
  const f = fixture(), first = deferred(), second = deferred();
  let count = 0; f.runtime.response = () => ++count === 1 ? first.promise : second.promise;
  const original = clone(f.draft().formation);
  const oldRead = f.context.loadLineupEditorData('account-a'), newRead = f.context.loadLineupEditorData('account-a');
  second.resolve({ ...editorData(), capacity: 6 }); await newRead;
  first.resolve({ ...editorData(), capacity: 3 }); await oldRead;
  assert.equal(f.state.editor.capacity, 6);
  assert.deepEqual(clone(f.draft().formation), original);
});

await test('保存失败保留名称、站位和海兽精度，成功后更新预设身份', async () => {
  const f = fixture();
  f.state.activeDraft = 'new';
  f.state.drafts.set('new', { name: '我的新阵容', formation: formation(), dirty: true });
  f.draft().formation.petUid = '9223372036854775806';
  f.runtime.response = () => { throw new Error('保存版本已变化'); };
  await f.context.saveLineupDraft('account-a', f.state);
  assert.equal(f.draft().name, '我的新阵容'); assert.equal(f.state.error, true);
  assert.equal(f.calls[0].body.formation.petUid, '9223372036854775806');
  assert.equal(f.calls[0].body.confirm, true);
  f.runtime.response = request => ({ ...savedData('阵容A', 2), savedId: 'p2',
    presets: [...savedData().presets, { id: 'p2', name: request.body.name, formation: request.body.formation }] });
  await f.context.saveLineupDraft('account-a', f.state);
  assert.equal(f.state.activeDraft, 'p2'); assert.equal(f.draft().id, 'p2'); assert.equal(f.draft().dirty, false);
  assert(f.calls.every(request => request.url.startsWith('/api/lineup-presets/save?account=account-a')));
});

await test('保存中切号，完成响应只更新原账号且不重绘当前账号', async () => {
  const f = fixture(), pending = deferred(); f.runtime.response = () => pending.promise;
  const saving = f.context.saveLineupDraft('account-a', f.state);
  f.context.current = 'account-b'; f.renders.length = 0;
  pending.resolve(savedData('已保存A', 2)); await saving;
  assert.equal(f.state.saved.revision, 2); assert.deepEqual(f.renders, []);
  assert.equal(f.context.savedLineupState('account-b').saved, null);
});

await test('HTML与挑战接线包含编辑入口、单次和连续选择及手机触控样式', () => {
  assert(markup.includes('id="saved-lineup-view"'));
  assert(progression.includes("selectedLineupId('trial', payload.raidId)"));
  assert(progression.includes("selectedLineupId('trial', row.raidId)"));
  assert(progression.includes("typeof createLineupSelect === 'function'"));
  assert(script.includes("'/api/lineup-presets/recover'"));
  assert(script.includes('expectedTransactionId'));
  assert(css.includes('min-height:44px'));
  assert(css.includes('touch-action:none'));
  assert(css.includes('dialog.lineup-dialog[open],dialog.lineup-dialog[open]::backdrop { animation:none }'));
  assert(css.includes('height:100dvh; max-height:100dvh'));
  assert(css.includes("/api/lineups/art/bg_formation.png"));
  assert(!script.includes('innerHTML'));
});

await test('编辑弹窗使用阵型下拉框并渲染英雄和海兽，管理列表提供查看且移除绑定', async () => {
  const f = fixture();
  f.draft().formation.petUid = '9223372036854775806';
  f.realRender('account-a');
  assert.match(f.host.textContent, /查看/);
  assert(!f.host.textContent.includes('自动挑战使用的阵容'));
  assert(!f.host.textContent.includes('选择英雄'));
  await f.context.openSavedLineupEditor('account-a', f.state.saved.presets[0]);
  const descendants = node => [node, ...node.children.flatMap(descendants)];
  const nodes = descendants(f.body.querySelector('dialog'));
  assert.equal(nodes.filter(node => node.dataset.lineupPosition).length, 3);
  assert.equal(nodes.filter(node => node.dataset.lineupHero).length, 3);
  const formationSelect = nodes.find(node => node.getAttribute('aria-label') === '阵型');
  assert.equal(formationSelect.tagName, 'SELECT');
  assert.equal(String(formationSelect.value), '1');
  assert.equal(formationSelect.children.length, 3);
  assert.equal(formationSelect.children[2].disabled, true);
  assert.match(formationSelect.children[2].textContent, /未解锁/);
  assert.equal(nodes.filter(node => node.className === 'lineup-formation-choice').length, 0);
  assert.equal(nodes.find(node => node.getAttribute('aria-label') === '出战海兽').value, '9223372036854775806');
  assert.equal(f.body.querySelector('dialog').open, true);
  assert(nodes.some(node => node.getAttribute('role') === 'status'));
});

await test('阵型下拉切换保留英雄，锁定选项不可改变草稿', async () => {
  const f = fixture();
  await f.context.openSavedLineupEditor('account-a', f.state.saved.presets[0]);
  const select = f.body.querySelectorAll('select').find(node => node.getAttribute('aria-label') === '阵型');
  const heroes = f.draft().formation.heroPositions.map(item => item.heroId).sort();
  select.value = '2'; select.onchange();
  assert.equal(f.draft().formation.presetId, 2);
  assert.deepEqual(f.draft().formation.heroPositions.map(item => item.heroId).sort(), heroes);
  assert.deepEqual(clone(f.draft().formation.heroPositions), [{ heroId: 'a', pos: { x: 5, y: 3 } }, { heroId: 'b', pos: { x: 2, y: 0 } }]);
  const before = clone(f.draft().formation);
  select.value = '3'; select.onchange();
  assert.deepEqual(clone(f.draft().formation), before);
});

await test('右键下阵只修改当前账号可编辑草稿，保存中与切号时无效', async () => {
  const f = fixture();
  await f.context.openSavedLineupEditor('account-a', f.state.saved.presets[0]);
  const slot = f.state.ui.board.children.find(node => node.dataset.lineupPosition === '1,1');
  const before = clone(f.draft().formation);
  const event = { preventDefault() { this.prevented = true; }, stopPropagation() {} };
  assert.equal(typeof slot.oncontextmenu, 'function');
  f.state.saving = true; slot.oncontextmenu(event);
  assert.deepEqual(clone(f.draft().formation), before);
  f.state.saving = false; f.context.current = 'account-b'; slot.oncontextmenu(event);
  assert.deepEqual(clone(f.draft().formation), before);
  f.context.current = 'account-a'; f.state.selectedHeroId = 'a'; slot.oncontextmenu(event);
  assert.equal(event.prevented, true);
  assert.deepEqual(f.draft().formation.heroPositions.map(item => item.heroId), ['b']);
  assert.equal(f.state.selectedHeroId, null); assert.equal(f.draft().dirty, true);
  assert.equal(f.calls.length, 0, '右键下阵只更新草稿，不请求保存或写入游戏');
});

await test('英雄池Pointer拖入空站位，保留原有上阵英雄', async () => {
  const f = fixture(); f.state.editor.capacity = 3;
  await f.context.openSavedLineupEditor('account-a', f.state.saved.presets[0]);
  const source = f.state.ui.roster.children.find(node => node.dataset.lineupHero === 'c');
  const target = f.state.ui.board.children.find(node => node.dataset.lineupPosition === '1,3');
  target.closest = () => target; f.runtime.drop = target;
  source.onpointerdown({ button: 0, pointerId: 11, isPrimary: true, clientX: 10, clientY: 10 });
  source.onpointermove({ pointerId: 11, clientX: 100, clientY: 100, preventDefault() {} });
  source.onpointerup({ pointerId: 11 });
  assert.deepEqual(clone(f.draft().formation.heroPositions), [
    { heroId: 'a', pos: { x: 1, y: 1 } }, { heroId: 'b', pos: { x: 4, y: 4 } }, { heroId: 'c', pos: { x: 1, y: 3 } },
  ]);
});

await test('空闲恢复记录隐藏，冲突记录提供原目标摘要及三种处理入口', () => {
  const f = fixture(), host = new Element();
  f.state.saved.recovery = { phase: 'idle', pending: false, transactionId: null };
  f.context.renderLineupRecovery(host, f.state, 'account-a');
  assert.equal(host.children.length, 0);
  f.state.saved.recovery = { phase: 'conflict', pending: true, transactionId: 'txn-1',
    original: formation(), target: formation([['c', 4, 4]]), reason: '阵容已被其他操作修改' };
  f.context.renderLineupRecovery(host, f.state, 'account-a');
  assert.match(host.textContent, /原阵容/); assert.match(host.textContent, /挑战阵容/);
  assert.match(host.textContent, /重试恢复/); assert.match(host.textContent, /恢复原始阵容/);
  assert.match(host.textContent, /保留游戏当前阵容/);
});

await test('挑战恢复状态刷新仅更新提示，保留编辑器DOM、筛选与草稿', async () => {
  const f = fixture();
  f.draft().name = '仍在输入'; f.state.query = '英雄a';
  f.realRender('account-a');
  await f.context.openSavedLineupEditor('account-a', f.state.saved.presets[0]);
  const editor = f.state.ui.root;
  f.runtime.response = () => ({ ...savedData('阵容A', 2), recovery: {
    phase: 'battling', pending: true, transactionId: 'txn-2', original: formation(), target: formation(),
  } });
  await f.context.refreshSavedLineups();
  assert.deepEqual(f.renders, []);
  assert.equal(f.state.ui.root, editor);
  assert(f.body.querySelector('dialog').contains(editor));
  assert.match(f.state.recoveryHost.textContent, /使用所选阵容挑战中/);
  assert.equal(f.state.query, '英雄a');
  assert.equal(f.draft().name, '仍在输入');
  assert.equal(f.state.saved.revision, 2);
});

await test('阵容阶段通知只刷新当前账号状态，不占用运行日志', () => {
  const streams = [], refreshes = [], logs = [];
  const context = vm.createContext({
    current: 'account-a', stream: null, Date,
    updateLogSummary() {}, clearLogBefore() {},
    appendLog: entry => logs.push(clone(entry)),
    refreshSavedLineups: () => { refreshes.push(context.current); return Promise.resolve(); },
    EventSource: class {
      constructor(url) { this.url = url; this.listeners = new Map(); streams.push(this); }
      addEventListener(type, listener) { this.listeners.set(type, listener); }
      dispatch(type, data) {
        const event = { data: JSON.stringify(data) };
        if (type === 'message') this.onmessage(event);
        else {
          assert(this.listeners.has(type), '应订阅 ' + type + ' 事件');
          this.listeners.get(type)(event);
        }
      }
    },
  });
  const start = pageSource.indexOf('function subscribe()');
  const end = pageSource.indexOf('// ---- 账号', start);
  assert(start >= 0 && end > start);
  vm.runInContext(pageSource.slice(start, end), context);
  context.subscribe(); context.subscribe();
  assert.equal(streams.length, 1, '重复订阅不应创建额外事件流');
  const stream = streams[0];
  assert.equal(stream.url, '/api/events?scope=all');
  for (const phase of ['switching', 'battling', 'restoring', 'idle']) {
    stream.dispatch('lineup-changed', { account: 'account-a', phase });
  }
  assert.deepEqual(refreshes, ['account-a', 'account-a', 'account-a', 'account-a']);
  assert.deepEqual(logs, [], '正常阵容过程通知不进入运行日志');
  stream.dispatch('lineup-changed', { account: 'account-b', phase: 'conflict' });
  assert.equal(refreshes.length, 4, '其他账号的通知不刷新当前账号');
  context.current = 'account-b';
  stream.dispatch('lineup-changed', { account: 'account-a', phase: 'idle' });
  stream.dispatch('lineup-changed', { account: 'account-b', phase: 'pending' });
  assert.deepEqual(refreshes, ['account-a', 'account-a', 'account-a', 'account-a', 'account-b']);
  assert.deepEqual(logs, []);
  const warning = { account: 'account-b', t: Date.now(), level: 'warn', message: '登录后阵容仍待恢复', extra: { lineupChanged: true } };
  stream.dispatch('message', warning);
  assert.equal(refreshes.at(-1), 'account-b'); assert.equal(refreshes.length, 6);
  assert.deepEqual(logs, [warning], '已有异常日志仍显示并触发状态刷新');
});

await test('暂时没有账号后重新选择原账号会恢复已缓存的阵容界面', async () => {
  const f = fixture(); f.realRender('account-a');
  f.context.current = null; await f.context.refreshSavedLineups();
  assert.equal(f.host.textContent, '请先选择账号');
  assert.equal(f.host.dataset.owner, undefined);
  f.context.current = 'account-a'; await f.context.refreshSavedLineups();
  assert.deepEqual(f.renders, ['account-a']);
  assert.equal(f.draft().name, '阵容A');
});

await test('列表读取重试成功清除读取错误并保留其他保存错误', async () => {
  const f = fixture(); f.realRender('account-a');
  f.runtime.response = () => { throw new Error('读取连接中断'); };
  await f.context.refreshSavedLineups();
  assert.equal(f.state.error, true);
  f.runtime.response = () => savedData(); await f.context.refreshSavedLineups();
  assert.equal(f.state.error, false); assert.equal(f.state.message, '');
  f.state.message = '保存版本已变化'; f.state.error = true;
  await f.context.refreshSavedLineups();
  assert.equal(f.state.message, '保存版本已变化'); assert.equal(f.state.error, true);
});

await test('主线切号立即替换阵容选项，新账号读取失败仍保持隔离且禁用', async () => {
  const f = fixture(), control = new Element(), pending = deferred(), errors = [];
  const oldSelect = f.context.createLineupSelect('account-a', 'mainline');
  oldSelect.remove = () => { control.children = control.children.filter(child => child !== oldSelect); };
  control.querySelector = () => control.children.find(child => child.tagName === 'SELECT');
  control.append(oldSelect);
  const newState = f.context.savedLineupState('account-b');
  f.context.adoptSavedLineups(newState, { ...savedData(), presets: [{ id: 'p2', name: '账号B阵容', formation: formation() }] });
  const elements = new Map([
    ['stage-lineup-control', control], ['tab-stages', { classList: { contains: () => false } }],
    ...['stage-failures', 'stage-start', 'stage-stop', 'stage-view'].map(id => [id, new Element()]),
  ]);
  Object.assign(f.context, {
    current: 'account-b', stageAccount: 'account-a', stageVersion: 0,
    $: id => elements.get(id), localStorage: { getItem: () => null },
    call: () => pending.promise, reportError: error => errors.push(error.message),
    renderStages: () => assert.fail('读取失败不应渲染成功状态'),
  });
  const start = pageSource.indexOf('async function refreshStages()');
  const end = pageSource.indexOf('async function stageCommand(', start);
  assert(start >= 0 && end > start);
  vm.runInContext(pageSource.slice(start, end), f.context);
  const refreshing = f.context.refreshStages();
  const newSelect = control.querySelector('select');
  assert.notEqual(newSelect, oldSelect);
  assert.equal(newSelect.dataset.lineupAccount, 'account-b');
  assert.equal(newSelect.disabled, true);
  assert.match(newSelect.textContent, /账号B阵容/);
  assert(!newSelect.textContent.includes('阵容A'));
  pending.reject(new Error('新账号状态读取失败')); await refreshing;
  assert.equal(control.querySelector('select'), newSelect);
  assert.equal(newSelect.disabled, true);
  assert.deepEqual(errors, ['新账号状态读取失败']);
});

await test('查看弹窗仅请求离线目录，站位只读，缺海兽信息显示精确UID', async () => {
  const f = fixture(); f.state.editor = null;
  const data = savedData(); data.catalog = editorData();
  data.presets[0].formation.petUid = '9223372036854775806';
  f.runtime.response = () => data;
  const before = clone(data.presets[0].formation);
  await f.context.openSavedLineupViewer('account-a', 'p1');
  const dialog = f.body.querySelector('dialog');
  assert.equal(dialog.dataset.lineupMode, 'viewer'); assert.equal(dialog.open, true);
  assert.match(dialog.textContent, /基础阵型/); assert.match(dialog.textContent, /英雄a/);
  assert.match(dialog.textContent, /海兽 UID 9223372036854775806/);
  assert.equal(dialog.querySelectorAll('input').length, 0);
  assert.equal(dialog.querySelectorAll('select').length, 0);
  for (const slot of dialog.querySelectorAll('[data-lineup-position]')) {
    assert.equal(slot.tagName, 'DIV'); assert.equal(slot.onclick, undefined); assert.equal(slot.onpointerdown, undefined);
    assert.equal(slot.oncontextmenu, undefined);
  }
  assert(dialog.querySelectorAll('button').every(button => button.textContent === '关闭'));
  assert(f.calls.every(request => request.url.startsWith('/api/lineup-presets?') && !request.body));
  assert.deepEqual(clone(data.presets[0].formation), before);
  assert.equal(f.state.editor, null);
});

await test('关闭与Esc返回触发按钮，草稿保留，切号关闭弹窗', async () => {
  const f = fixture(), trigger = new Element('button'); f.body.append(trigger); f.context.document.activeElement = trigger;
  await f.context.openSavedLineupEditor('account-a', f.state.saved.presets[0]);
  f.draft().name = '未提交草稿';
  const dialog = f.body.querySelector('dialog'); let cancelled = false;
  dialog.oncancel({ preventDefault: () => { cancelled = true; } });
  assert.equal(cancelled, true); assert.equal(dialog.open, false); assert.equal(trigger.focused, true);
  assert.equal(f.state.activeDraft, null); assert.equal(f.state.drafts.get('p1').name, '未提交草稿');
  await f.context.openSavedLineupEditor('account-a', f.state.saved.presets[0]);
  assert.equal(f.draft().name, '未提交草稿');
  f.context.current = 'account-b'; f.context.lineupAccountChanged();
  assert.equal(f.body.querySelector('dialog'), null);
  assert.equal(f.state.drafts.get('p1').name, '未提交草稿');
});

await test('查看刷新管理列表后关闭仍返回对应查看按钮', async () => {
  const f = fixture(); f.context.renderSavedLineups = f.realRender; f.realRender('account-a');
  const trigger = f.host.querySelector('button[aria-label^="查看阵容"]');
  f.context.document.activeElement = trigger;
  f.runtime.response = () => ({ ...savedData(), catalog: editorData() });
  await f.context.openSavedLineupViewer('account-a', 'p1');
  trigger.isConnected = false;
  const replacement = f.host.querySelector('button[aria-label^="查看阵容"]');
  assert.notEqual(replacement, trigger);
  f.context.closeLineupDialog();
  assert.equal(replacement.focused, true);
  assert.equal(f.host.querySelector('button[aria-label^="编辑阵容"]').focused, undefined);
});

await test('关闭或切号后的编辑与查看异步响应不会重新打开弹窗', async () => {
  const f = fixture(), pendingEditor = deferred(); f.state.editor = null;
  f.runtime.response = () => pendingEditor.promise;
  const opening = f.context.openSavedLineupEditor('account-a', f.state.saved.presets[0]);
  f.context.closeLineupDialog(); pendingEditor.resolve(editorData()); await opening;
  assert.equal(f.body.querySelector('dialog'), null);
  const pendingViewer = deferred(); f.runtime.response = () => pendingViewer.promise;
  const viewing = f.context.openSavedLineupViewer('account-a', 'p1');
  f.context.current = 'account-b'; f.context.lineupAccountChanged();
  pendingViewer.resolve({ ...savedData(), catalog: editorData() }); await viewing;
  assert.equal(f.body.querySelector('dialog'), null);
  assert.equal(f.context.savedLineupState('account-b').saved, null);
});

await test('保存失败保留编辑弹窗，保存成功更新列表且不显示成功提示', async () => {
  const f = fixture(); f.context.redrawLineupEditor = f.realRedraw; f.context.renderSavedLineups = f.realRender;
  await f.context.openSavedLineupEditor('account-a', f.state.saved.presets[0]);
  f.draft().name = '弹窗保存测试';
  f.runtime.response = () => { throw new Error('版本冲突'); };
  await f.context.saveLineupDraft('account-a', f.state);
  assert.equal(f.body.querySelector('dialog').open, true); assert.equal(f.draft().name, '弹窗保存测试');
  assert.match(f.body.querySelector('dialog').textContent, /版本冲突/);
  f.runtime.response = () => savedData('弹窗保存测试', 2);
  await f.context.saveLineupDraft('account-a', f.state);
  assert.equal(f.body.querySelector('dialog'), null); assert.equal(f.state.activeDraft, null);
  assert.equal(f.state.drafts.get('p1').dirty, false);
  assert.equal(f.state.message, ''); assert.equal(f.state.editorMessage, '');
  assert.match(f.host.textContent, /弹窗保存测试/);
  assert(!f.host.textContent.includes('已保存'));
});

await test('查看按钮保留select原事件，并随选项与删除状态同步', async () => {
  const f = fixture(), select = f.context.createLineupSelect('account-a', 'mainline');
  const original = select.onchange, button = f.context.createLineupPreviewButton('account-a', select);
  assert.equal(select.onchange, original); assert.equal(button.disabled, true);
  select.value = 'p1'; await select.dispatch('change');
  assert.equal(button.disabled, false); assert.equal(f.context.selectedLineupId('mainline'), 'p1');
  f.state.saved.presets = []; f.selectors.push(select); f.context.updateManualLineupSelects('account-a');
  assert.equal(button.disabled, true); assert.match(button.title, /已删除/);
  assert.match(select.textContent, /已删除的阵容/);
});

console.log(`阵容编辑界面 ${passed}/${passed} 通过`);
