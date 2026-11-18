import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const script = fs.readFileSync(new URL('../src/appointments-ui.js', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../src/page.mjs', import.meta.url), 'utf8');
const markup = fs.readFileSync(new URL('../src/ui/pages.tsx', import.meta.url), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const state = { calls: [], respond: null, focused: null };
  class Element {
    constructor(tag = 'div', className = '', text = '') {
      this.tagName = tag;
      this.className = className;
      this.text = text;
      this.children = [];
      this.dataset = {};
      this.attributes = new Map();
      this.disabled = false;
      this.hidden = false;
      this.classList = {
        contains: name => this.className.split(' ').includes(name),
        add: name => { this.className += ' ' + name; },
      };
    }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.text = String(value); this.children = []; }
    append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key); }
    focus() { state.focused = this; }
    getBoundingClientRect() { return { top: 100 + this.parent.children.indexOf(this) * 52, height: 52 }; }
    setPointerCapture(id) { this.pointerId = id; }
    hasPointerCapture(id) { return this.pointerId === id; }
    releasePointerCapture() { this.pointerId = null; }
  }
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  const values = ['生产时间', '训练产量', '贸易时间', '建造速度', '种田时间', '宠物培育速度', '锻造时间'];
  const options = values.map(value => ({ value, label: value + '效果' }));
  const response = (enabled = false, priorities = values, revision = 1) => ({
    settings: { enabled, priorities: [...priorities] }, revision, baseRevision: 'base-' + revision, options,
  });
  const saved = new Map([['a', response()], ['b', response(true, [...values].reverse(), 4)]]);
  const windowEvents = new Map(), documentEvents = new Map();
  const context = vm.createContext({
    current: 'a', loopSettingsRevision: null, structuredClone, console,
    $: node, el: (tag, className, text) => new Element(tag, className, text),
    clear: target => { target.textContent = ''; return target; },
    setTaskSwitch: (button, enabled) => button.setAttribute('aria-checked', String(enabled)),
    window: { innerHeight: 800, scrollBy() {}, addEventListener: (name, handler) => windowEvents.set(name, handler) },
    document: { addEventListener: (name, handler) => documentEvents.set(name, handler) },
    call: async (url, init = {}) => {
      const owner = new URL(url, 'http://localhost').searchParams.get('account');
      const body = init.body ? JSON.parse(init.body) : null;
      const request = { owner, body, method: init.method || 'GET' };
      state.calls.push(request);
      if (state.respond) return state.respond(request);
      if (body) {
        assert.equal(body.revision, saved.get(owner).revision);
        assert.equal(body.baseRevision, saved.get(owner).baseRevision);
        saved.set(owner, { ...clone(saved.get(owner)), settings: body.settings, revision: body.revision + 1, baseRevision: 'base-' + (body.revision + 1) });
      }
      return clone(saved.get(owner));
    },
  });
  node('tab-heroes').className = 'hidden';
  vm.runInContext(script, context);
  return {
    state, node, context, saved, values, response, windowEvents, documentEvents,
    load: force => context.appointmentsLoad(force),
    switchAccount(owner) { context.current = owner; context.appointmentsAccountChanged(); },
    rows: () => node('appointments-priorities').children,
    order: () => node('appointments-priorities').children.map(row => row.dataset.priority),
    posts: () => state.calls.filter(call => call.method === 'POST'),
  };
}

let passed = 0;
async function test(name, run) { await run(); console.log('通过：' + name); passed++; }

await test('移除主力英雄展示与旧任命按钮，英雄页接入自动委任设置', () => {
  assert(!markup.includes('id="hero-strip"'));
  assert(!page.includes("$('hero-strip')"));
  assert(!markup.includes('id="appoint-run"'));
  assert(!page.includes("bindGameAction('appoint-run'"));
  assert(markup.includes('id="appointments-enabled"'));
  assert(page.includes("void appointmentsLoad(true)"));
});

await test('载入七项顺序，边界移动禁用，开关自动保存', async () => {
  const f = fixture();
  await f.load();
  assert.deepEqual(f.order(), f.values);
  assert.equal(f.rows()[0].children[3].children[0].disabled, true);
  assert.equal(f.rows().at(-1).children[3].children[1].disabled, true);
  f.node('appointments-enabled').onclick();
  await settle();
  assert.equal(f.saved.get('a').settings.enabled, true);
  assert.equal(f.node('appointments-state').textContent, '已保存');
});

await test('上下移动与键盘排序保存完整顺序并保留焦点', async () => {
  const f = fixture();
  await f.load();
  f.rows()[1].children[3].children[0].onclick();
  await settle();
  assert.equal(f.order()[0], f.values[1]);
  assert.equal(f.state.focused, f.rows()[0].children[0]);
  f.rows()[0].children[0].onkeydown({ key: 'ArrowDown', preventDefault() {} });
  await settle();
  assert.deepEqual(f.order(), f.values);
  assert.deepEqual(f.saved.get('a').settings.priorities, f.values);
});

await test('鼠标与触屏共用指针拖拽，落位提交一次，取消拖拽不保存', async () => {
  const f = fixture();
  await f.load();
  const handle = f.rows()[0].children[0];
  handle.onpointerdown({ button: 0, pointerId: 7, isPrimary: true, clientY: 120 });
  handle.onpointermove({ pointerId: 7, clientY: 480 });
  assert.equal(f.rows().at(-1).dataset.drop, 'after');
  handle.onpointerup({ pointerId: 7 });
  await settle();
  assert.deepEqual(f.order(), [...f.values.slice(1), f.values[0]]);
  assert.equal(f.posts().length, 1);
  const cancel = f.rows()[0].children[0];
  cancel.onpointerdown({ button: 0, pointerId: 8, isPrimary: true, clientY: 120 });
  cancel.onpointermove({ pointerId: 8, clientY: 480 });
  cancel.onpointercancel();
  assert.equal(f.posts().length, 1);
  assert(f.rows().every(row => !row.dataset.drop && !row.dataset.dragging));
});

await test('连续编辑串行提交，下一次请求使用前一次返回的版本', async () => {
  const f = fixture();
  await f.load();
  const first = deferred();
  f.state.respond = request => {
    if (f.posts().length === 1) return first.promise;
    return f.response(request.body.settings.enabled, request.body.settings.priorities, request.body.revision + 1);
  };
  f.node('appointments-enabled').onclick();
  f.rows()[1].children[3].children[0].onclick();
  assert.equal(f.posts().length, 1);
  first.resolve(f.response(true, f.values, 2));
  await settle();
  assert.equal(f.posts().length, 2);
  assert.equal(f.posts()[1].body.revision, 2);
  assert.equal(f.posts()[1].body.baseRevision, 'base-2');
  assert.equal(f.posts()[1].body.settings.priorities[0], f.values[1]);
});

await test('切换账号时在途与后续保存继续归属原账号，界面显示新账号', async () => {
  const f = fixture();
  await f.load();
  const pending = deferred();
  f.state.respond = request => request.owner === 'b' ? clone(f.saved.get('b'))
    : f.posts().length === 1 ? pending.promise : f.response(request.body.settings.enabled, request.body.settings.priorities, 3);
  f.node('appointments-enabled').onclick();
  f.rows()[1].children[3].children[0].onclick();
  f.switchAccount('b');
  await f.load();
  pending.resolve(f.response(true, f.values, 2));
  await settle();
  assert(f.posts().every(request => request.owner === 'a'));
  assert.deepEqual(f.order(), [...f.values].reverse());
  assert.equal(f.node('appointments-enabled').getAttribute('aria-checked'), 'true');
});

await test('旧账号迟到的读取不会覆盖当前账号', async () => {
  const f = fixture();
  const pending = deferred();
  f.state.respond = request => request.owner === 'a' ? pending.promise : clone(f.saved.get('b'));
  const oldLoad = f.load();
  f.switchAccount('b');
  await f.load();
  pending.resolve(f.response());
  await oldLoad;
  assert.deepEqual(f.order(), [...f.values].reverse());
});

await test('读取失败禁用编辑，保存网络失败保留草稿并支持重试', async () => {
  const f = fixture();
  f.state.respond = () => { throw new Error('读取失败'); };
  await f.load();
  assert.equal(f.node('appointments-enabled').disabled, true);
  assert.equal(f.node('appointments-reload').hidden, false);
  f.state.respond = null;
  await f.node('appointments-reload').onclick();
  await settle();
  f.state.respond = () => { throw new Error('保存网络失败'); };
  f.node('appointments-enabled').onclick();
  await settle();
  assert.equal(f.node('appointments-retry').hidden, false);
  assert.equal(f.node('appointments-enabled').getAttribute('aria-checked'), 'true');
  f.state.respond = null;
  f.node('appointments-retry').onclick();
  await settle();
  assert.equal(f.saved.get('a').settings.enabled, true);
});

await test('版本冲突停止后续保存，重新载入恢复服务器设置', async () => {
  const f = fixture();
  await f.load();
  f.state.respond = () => { throw Object.assign(new Error('配置已更新'), { fields: { revision: '过期版本' } }); };
  f.node('appointments-enabled').onclick();
  await settle();
  assert.equal(f.node('appointments-enabled').disabled, true);
  assert.equal(f.node('appointments-retry').hidden, true);
  assert(f.rows().every(row => row.children[0].disabled));
  f.state.respond = null;
  f.node('appointments-reload').onclick();
  await settle();
  assert.equal(f.node('appointments-enabled').getAttribute('aria-checked'), 'false');
  assert.equal(f.node('appointments-enabled').disabled, false);
});

console.log('英雄委任界面 ' + passed + ' 组通过');
