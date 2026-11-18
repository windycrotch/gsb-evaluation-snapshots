import assert from 'node:assert/strict';
import { createConsoleStore, createConsoleRuntime, selectAccounts, selectCurrentStatus } from '../src/ui/console-store.mjs';

let passed = 0;
function test(name, run) { run(); passed++; console.log('通过：' + name); }
function fixture() {
  const store = createConsoleStore(), actions = store.getState().actions;
  actions.replaceAccounts([
    { id: 'a', title: '主号', status: { connected: true, looping: false } },
    { id: 'b', title: '副号', status: { connected: true, looping: true } },
  ], 'a');
  return { store, actions };
}

test('每个页面独立初始化，运行状态不从本地持久化恢复', () => {
  const first = fixture(), second = createConsoleStore();
  assert.equal(second.getState().currentAccountId, null);
  assert.deepEqual(selectAccounts(second.getState()), []);
  assert.equal(selectCurrentStatus(second.getState()).connected, false);
  assert.equal(first.store.getState().currentAccountId, 'a');
  assert.equal(Object.hasOwn(first.store.getState(), 'snapshot'), false, '当前快照只由账号表派生');
});
test('账号表和当前快照共用一份状态，修改后台账号不串号', () => {
  const { store, actions } = fixture(), before = store.getState();
  actions.patchStatus('b', { looping: false });
  assert.equal(selectCurrentStatus(store.getState()), store.getState().accountsById.a.status);
  assert.equal(store.getState().accountsById.a, before.accountsById.a);
  assert.equal(before.accountsById.b.status.looping, true, '旧快照不可变');
  assert.equal(store.getState().accountsById.b.status.looping, false);
  assert.equal(actions.selectAccount('missing'), false);
  assert.equal(actions.selectAccount('b'), true);
  assert.equal(selectCurrentStatus(store.getState()), store.getState().accountsById.b.status);
});
test('状态订阅立即通知，取消订阅后不再更新消费者', () => {
  const { store, actions } = fixture(), seen = [];
  const unsubscribe = store.subscribe(state => seen.push(selectCurrentStatus(state).looping));
  actions.patchStatus('a', { looping: true });
  actions.patchStatus('a', { looping: false });
  unsubscribe();
  actions.patchStatus('a', { looping: true });
  assert.deepEqual(seen, [true, false]);
});
test('连接和操作锁使用新Set，重复写入不引发额外刷新', () => {
  const { store, actions } = fixture(), before = store.getState().connecting;
  actions.setFlag('connecting', 'b', true);
  assert.equal(before.has('b'), false);
  const after = store.getState();
  actions.setFlag('connecting', 'b', true);
  assert.equal(store.getState(), after);
  actions.setFlag('connecting', 'b', false);
  assert.equal(store.getState().connecting.has('b'), false);
  actions.setFlag('hosting', 'missing', true);
  assert.equal(store.getState().hosting.size, 0);
});
test('延迟账号列表更新资料时保留已确认的新运行状态', () => {
  const { store, actions } = fixture();
  actions.patchStatus('a', { looping: true });
  actions.replaceAccounts([{ id: 'a', title: '新备注', status: { looping: false } }], 'a', { preserveStatus: true });
  assert.equal(store.getState().accountsById.a.title, '新备注');
  assert.equal(selectCurrentStatus(store.getState()).looping, true);
});
test('纯状态刷新保留账号顺序、当前选择和名称', () => {
  const { store, actions } = fixture();
  actions.selectAccount('b');
  actions.mergeStatuses([{ id: 'a', title: '忽略名称', status: { paused: true }, lastSeen: { level: 20 } }, { id: 'new', status: {} }]);
  assert.deepEqual(store.getState().accountIds, ['a','b']);
  assert.equal(store.getState().currentAccountId, 'b');
  assert.equal(store.getState().accountsById.a.title, '主号');
  assert.equal(store.getState().accountsById.a.lastSeen.level, 20);
});
test('角色和挂机快照按账号隔离，切号不改变其他账号的数据', () => {
  const { store, actions } = fixture();
  actions.setGameData('a', 'world', { stock: 10 });
  actions.setGameData('b', 'world', { stock: 20 });
  actions.selectAccount('b');
  assert.equal(store.getState().gameByAccount.a.world.stock, 10);
  assert.equal(store.getState().gameByAccount.b.world.stock, 20);
});
test('移除账号清理快照、操作锁和表单，迟到回复不能重新创建账号', () => {
  const { store, actions } = fixture();
  actions.setGameData('b', 'loop', { running: true });
  actions.setFlag('hosting', 'b', true);
  actions.patchSlice('loginSettings:b', { data: { revision: 2 } });
  actions.selectAccount('b');
  actions.replaceAccounts([{ id: 'a', status: {} }], 'a');
  actions.setStatus('b', { connected: true });
  actions.setGameData('b', 'loop', { running: true });
  actions.patchSlice('loginSettings:b', { data: { revision: 3 } });
  assert.equal(store.getState().currentAccountId, 'a');
  assert.equal(store.getState().accountsById.b, undefined);
  assert.equal(store.getState().gameByAccount.b, undefined);
  assert.equal(store.getState().slices['loginSettings:b'], undefined);
  assert.equal(store.getState().hosting.size, 0);
});
test('日志筛选独立于操作账号和页签，重复设置不触发订阅', () => {
  const { store, actions } = fixture();
  actions.setView({ logAccount: 'a', logGroup: '世界与联盟', onlyIssues: true });
  actions.selectAccount('b');
  actions.setView({ page: 'login-settings' });
  const before = store.getState();
  actions.setView({ page: 'login-settings' });
  assert.equal(store.getState(), before);
  assert.equal(store.getState().view.logAccount, 'a');
  assert.equal(store.getState().view.onlyIssues, true);
});
test('原生页面切片与store双向连接，嵌套变更保持旧快照不变', () => {
  const runtime = createConsoleRuntime();
  let projected;
  runtime.bindConsoleSlice('map', { view: { x: 1, zoom: 2 } }, value => { projected = value; });
  const before = runtime.consoleStore.getState().slices.map;
  runtime.mutateConsoleValue('map', 'view', value => { value.zoom = 4; });
  assert.equal(before.view.zoom, 2);
  assert.equal(projected.view.zoom, 4);
  runtime.stateActions.patchSlice('map', { view: { x: 10, zoom: 3 } });
  assert.equal(projected.view.x, 10);
});
test('配置草稿由store持有，DOM控件及请求句柄不进入状态', () => {
  const runtime = createConsoleRuntime(), widget = {}, editor = { draft: { enabled: false }, widgets: new Map([['x',widget]]) };
  runtime.bindConsoleObject('config', editor, ['draft']);
  const before = runtime.consoleStore.getState().slices.config;
  editor.draft = { enabled: true };
  assert.equal(before.draft.enabled, false);
  assert.equal(runtime.consoleStore.getState().slices.config.draft, editor.draft);
  assert.equal(runtime.consoleStore.getState().slices.config.widgets, undefined);
  assert.equal(editor.widgets.get('x'), widget);
});
console.log('Zustand 共享状态测试 ' + passed + '/' + passed + ' 通过');
