// 执行真实排序控件，验证取消、并发配置变化和切号不产生错误保存。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { defaultSettings, validateSettings } from '../src/automation-settings.mjs';

const script = fs.readFileSync(new URL('../src/settings-ui.js', import.meta.url), 'utf8');
const source = script.slice(script.indexOf('function configDispatchOrder('), script.indexOf('function configLineupPicker('));
const initial = defaultSettings().fleetDispatch.priority;
function fixture(order = initial) {
  const state = { values: [...order], saves: [], focused: null };
  const events = () => {
    const handlers = new Map();
    return {
      addEventListener(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
      removeEventListener(name, fn) { handlers.get(name)?.delete(fn); },
      fire(name, event = {}) { for (const handler of handlers.get(name) ?? []) handler(event); },
      size: () => [...handlers.values()].reduce((sum, entries) => sum + entries.size, 0),
    };
  };
  class Element {
    constructor(tag, className = '', text = '') {
      this.tagName = tag; this.className = className; this.text = text; this.children = []; this.dataset = {};
      this.attributes = new Map(); this.isConnected = true; this.visible = true;
      this.classList = { add: name => { this.className += ' ' + name; } };
    }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.text = String(value); this.children = []; }
    append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key); }
    focus() { state.focused = this; }
    getClientRects() { return this.visible ? [{}] : []; }
    getBoundingClientRect() { return { top: 100 + this.parent.children.indexOf(this) * 52, height: 52 }; }
    setPointerCapture(id) { this.pointerId = id; }
    hasPointerCapture(id) { return this.pointerId === id; }
    releasePointerCapture() { this.pointerId = null; this.onlostpointercapture?.(); }
  }
  const window = { ...events(), scrollBy() {}, innerHeight: 800 }, document = events();
  const context = vm.createContext({
    current: 'a', configEditor: { owner: 'a', busy: false, loading: false }, window, document,
    el: (tag, className, text) => new Element(tag, className, text),
    clear: node => { node.textContent = ''; return node; },
    configGet: () => state.values,
    configSet: (key, values) => {
      assert.equal(key, 'fleetDispatch.priority');
      const next = Array.from(values);
      const settings = defaultSettings(); settings.fleetDispatch.priority = next; validateSettings(settings);
      state.values = next; state.saves.push(next);
    },
    configButton: (label, onclick) => { const button = new Element('button', '', label); button.onclick = onclick; return button; },
  });
  vm.runInContext(source, context);
  const root = context.configDispatchOrder({ key: 'fleetDispatch.priority', label: '任务优先顺序' }, 'dispatch');
  const rows = () => root.children[1].children;
  const handle = index => rows()[index].children[0];
  const down = (index = 0, overrides = {}) => {
    const node = handle(index);
    node.onpointerdown({ button: 0, isPrimary: true, pointerId: 7, clientY: 120 + index * 52, ...overrides });
    return node;
  };
  return { state, root, context, window, document, rows, handle, down,
    order: () => rows().map(row => row.dataset.dispatch),
  };
}
let passed = 0;
function test(name, run) { run(); console.log('通过：' + name); passed++; }

test('七项调度名称完整，硅矿显示名称且未知历史值仍可辨识', () => {
  const f = fixture();
  assert.deepEqual(f.order(), initial);
  assert.equal(f.rows().at(-1).children[2].textContent, '硅矿采集');
  assert(f.rows().every(row => row.children[2].textContent.trim()));
  assert.equal(fixture(['future-task']).rows()[0].children[2].textContent, 'future-task');
});

test('上下按钮保留边界保护，键盘排序后保留焦点', () => {
  const f = fixture();
  assert.equal(f.rows()[0].children[3].children[0].disabled, true);
  assert.equal(f.rows().at(-1).children[3].children[1].disabled, true);
  f.rows()[1].children[3].children[0].onclick();
  assert.deepEqual(f.order(), [initial[1], initial[0], ...initial.slice(2)]);
  assert.equal(f.state.focused, f.handle(0));
  f.handle(0).onkeydown({ key: 'ArrowDown', preventDefault() {} });
  assert.deepEqual(f.order(), initial);
  assert.equal(f.state.focused, f.handle(1));
});

test('拖动时只预览，放手一次保存完整顺序，再次放手不重复保存', () => {
  const f = fixture(), node = f.down();
  node.onpointermove({ pointerId: 7, clientY: 480 });
  assert.equal(f.rows().at(-1).dataset.drop, 'after');
  assert.equal(f.state.saves.length, 0); assert.deepEqual(f.state.values, initial);
  node.onpointerup({ pointerId: 7 }); node.onpointerup({ pointerId: 7 });
  assert.deepEqual(f.order(), [...initial.slice(1), initial[0]]);
  assert.equal(f.state.saves.length, 1);
  assert.equal(f.window.size() + f.document.size(), 0);
});

test('从末尾拖到中间保持其余项目相对顺序', () => {
  const f = fixture(), node = f.down(6);
  node.onpointermove({ pointerId: 7, clientY: 210 }); node.onpointerup({ pointerId: 7 });
  assert.deepEqual(f.order(), [...initial.slice(0, 2), initial[6], ...initial.slice(2, 6)]);
});

test('轻触手柄或拖回原位不保存，其他指针不提交', () => {
  const f = fixture(), node = f.down();
  node.onpointermove({ pointerId: 7, clientY: 122 }); node.onpointerup({ pointerId: 7 });
  const second = f.down(); second.onpointermove({ pointerId: 7, clientY: 100 });
  second.onpointerup({ pointerId: 8 }); assert.equal(f.rows()[0].dataset.dragging, 'true');
  second.onpointerup({ pointerId: 7 });
  assert.equal(f.state.saves.length, 0);
});

for (const kind of ['pointercancel', 'lostpointercapture', 'Escape', 'blur']) {
  test(kind + ' 取消拖动不保存并清除落点', () => {
    const f = fixture(), node = f.down(); node.onpointermove({ pointerId: 7, clientY: 480 });
    if (kind === 'Escape') f.document.fire('keydown', { key: 'Escape', preventDefault() {} });
    else if (kind === 'blur') f.window.fire('blur');
    else node['on' + kind]();
    node.onpointerup({ pointerId: 7 });
    assert.equal(f.state.saves.length, 0);
    assert(f.rows().every(row => !row.dataset.dragging && !row.dataset.drop));
    assert.equal(f.window.size() + f.document.size(), 0);
  });
}

for (const kind of ['account', 'order', 'removed', 'hidden', 'busy']) {
  test('拖动期间 ' + kind + ' 变化不误存旧顺序', () => {
    const f = fixture(), node = f.down(); node.onpointermove({ pointerId: 7, clientY: 480 });
    if (kind === 'account') { f.context.current = 'b'; f.context.configEditor.owner = 'b'; }
    if (kind === 'order') f.state.values = [...initial].reverse();
    if (kind === 'removed') f.root.isConnected = false;
    if (kind === 'hidden') f.root.visible = false;
    if (kind === 'busy') f.context.configEditor.busy = true;
    node.onpointerup({ pointerId: 7 }); assert.equal(f.state.saves.length, 0);
  });
}

console.log('舰队调度排序界面 ' + passed + '/' + passed + ' 通过');
