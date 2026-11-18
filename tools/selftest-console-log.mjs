import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatConsoleLog } from '../src/console-log.mjs';
import { createLogAccountLabels } from '../src/log-accounts.mjs';
import { describeLogError } from '../src/log-errors.mjs';
import { LOG_CATEGORIES } from '../src/log-categories.mjs';
import { formatLoopStep } from '../src/loop.mjs';

const time = new Date(2026, 10, 12, 13, 14, 15).getTime();
const clock = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(time);
const entry = { t: time, account: 'account-123456', category: 'idle', level: 'info', message: '自动挂机开始' };
const prefix = (account = 'account-', level = '信息', category = '挂机') => `[${clock}] [${account}] [${category}] [${level}] `;
let passed = 0;
function test(name, fn) {
  fn(); passed++; console.log('通过：' + name);
}

test('扩展挂机日志显示功能名称，配置键只保留为内部任务标识', () => {
  for (const [key, label, category] of [
    ['alliance.enabled', '联盟自动化', '联盟/城战'],
    ['guildShip.enabled', '联盟商船', '联盟/城战'],
    ['guildFort.enabled', '联盟工事捐赠', '联盟/城战'],
    ['heroRaid.enabled', '超凡英雄活动', '活动'],
  ]) {
    for (const [result, expected] of [
      [{ ok: true }, '检查任务'],
      [{ skipped: true, reason: '尚未开放' }, '检查任务已跳过：尚未开放'],
      [{ ok: false, error: '读取超时' }, '检查任务失败：读取超时'],
      [{ status: 'pending', reason: '等待回包' }, '检查任务等待确认：等待回包'],
    ]) {
      const step = Object.freeze({ phase: 'world', category: key, taskKey: key, ...result });
      const message = formatLoopStep(step);
      assert.equal(message, label + ' · ' + expected, '网页正文显示中文功能名');
      assert.equal(formatConsoleLog({ ...entry, category: undefined, message }), prefix('account-', '信息', category) + message);
      assert.equal(step.taskKey, key, '运行状态和去重继续使用内部任务键');
    }
  }
  assert.equal(formatLoopStep({ category: '硅矿', title: '检查矿位', ok: true }), '硅矿 · 检查矿位');
});

test('时间按本地时区显示，旧日志缺名称时回退到账号短标识', () => {
  assert.equal(formatConsoleLog(entry), prefix() + '自动挂机开始');
  assert.equal(formatConsoleLog({ ...entry, account: 'a' }), prefix('a') + '自动挂机开始');
});

test('终端显示完整账号名称、中文功能分类和等级', () => {
  for (const [category, name] of Object.entries(LOG_CATEGORIES)) {
    assert.equal(formatConsoleLog({ ...entry, accountName: '远航舰队的生产主账号', category }), prefix('远航舰队的生产主账号', '信息', name) + entry.message);
  }
  assert.equal(formatConsoleLog({ ...entry, accountName: '船长甲', category: 'unknown' }), prefix('船长甲') + entry.message);
  assert.equal(formatConsoleLog({ ...entry, accountName: '船长甲', category: undefined, message: '工厂完成木板生产' }), prefix('船长甲', '信息', '生产') + '工厂完成木板生产');
});

test('账号名称与正文都移除控制符并脱敏，多行记录保留全部标签', () => {
  const name = '\u001b[31m船长\r\n甲\u001b[0m token=private-value';
  const formatted = formatConsoleLog({ ...entry, accountName: name, message: '第一条\n第二条' });
  assert.equal(formatted, ['第一条', '第二条'].map(line => prefix('船长甲 token=[已脱敏]') + line).join('\n'));
  assert.doesNotMatch(formatted, /private-value|\u001b/);
});

test('网页和终端使用一致的人类可读名称，同名账号用序号区分', () => {
  const labels = createLogAccountLabels([
    { id: 'same-prefix-a', label: '船长' }, { id: 'same-prefix-b', label: '船长' },
    { id: 'nickname', lastSeen: { nickname: '角色名' } }, { id: 'no-name' },
  ]);
  assert.deepEqual([...labels.values()], ['船长（1）', '船长（2）', '角色名', '未命名账号']);
  assert.doesNotMatch([...labels.values()].join(' '), /same-prefix|nickname|no-name/);
});

test('系统日志和中文等级', () => {
  for (const [level, expected] of [['info', '信息'], ['warn', '警告'], ['error', '错误'], ['state', '状态']]) {
    assert.equal(formatConsoleLog({ ...entry, account: null, level }), prefix('系统', expected) + '自动挂机开始');
  }
  assert.equal(formatConsoleLog({ ...entry, account: '', level: 'unknown' }), prefix('系统') + '自动挂机开始');
});

test('多行正文每一行都带时间、账号和等级', () => {
  const message = '第一行\n第二行\r\n第三行\r第四行';
  assert.equal(formatConsoleLog({ ...entry, message }), ['第一行', '第二行', '第三行', '第四行'].map(line => prefix() + line).join('\n'));
});

test('ANSI 颜色、光标、标题命令和其他控制字符不进入终端', () => {
  const message = '\u001b[31m红字\u001b[0m\u001b[2J\u001b[H\u001b]0;伪造标题\u0007\u0000\u0008\t\u007f\u0085正文\n下一行';
  const result = formatConsoleLog({ ...entry, message });
  assert.equal(result, prefix() + '红字正文\n' + prefix() + '下一行');
  assert.doesNotMatch(result, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  assert.doesNotMatch(result, /伪造标题/);
});

test('账号中的控制符不能伪造额外日志行', () => {
  assert.equal(formatConsoleLog({ ...entry, account: '\u001b[31mac\r\ncount-123\u0007' }), prefix('account-') + '自动挂机开始');
});

test('不访问或输出 detail、extra 和其他原始字段', () => {
  const secret = { ...entry, login: { password: '不可输出的密码' } };
  Object.defineProperties(secret, {
    detail: { get() { throw new Error('不得读取原始详情'); } },
    extra: { get() { throw new Error('不得读取额外字段'); } },
  });
  assert.equal(formatConsoleLog(secret), prefix() + '自动挂机开始');
  const result = formatConsoleLog({ ...entry, detail: 'token=私密值', extra: { protocol: { password: '私密密码' } } });
  assert.equal(result, prefix() + '自动挂机开始');
  assert.doesNotMatch(result, /token|私密|password|protocol/);
});

test('未知协议消息名称保留在网页正文和终端，原始错误仍供诊断使用', () => {
  const original = '农田收获 小麦失败：服务器消息解码失败：Unknown message type: SCNewFarmUpdate';
  const translated = describeLogError(original);
  const expected = '农田收获 小麦失败：服务器消息解码失败：当前协议无法识别消息：SCNewFarmUpdate';
  assert.equal(translated.message, expected);
  assert.equal(translated.detail, original);
  const formatted = formatConsoleLog({ ...entry, category: 'production', level: 'error', ...translated });
  assert.ok(formatted.endsWith(expected), '终端正文应包含具体消息名，不能依赖不输出的 detail');
  assert.doesNotMatch(formatted, /Unknown message type/);
});

test('空正文和无效时间不会使日志输出抛错', () => {
  assert.equal(formatConsoleLog({ ...entry, message: null }), prefix());
  assert.equal(formatConsoleLog({ ...entry, t: 'invalid' }), '[--:--:--] [account-] [挂机] [信息] 自动挂机开始');
});

// Exercise the real CLI entrypoint with an empty, isolated account store. The
// only process terminated below is the child created by this test.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-console-log-cli-'));
const configFile = path.join(dir, 'config.json');
fs.writeFileSync(configFile, '[]');
// 空账号启动只需空协议命名空间，使用明确的测试包走真实加载入口。
const protocolFile = path.join(dir, 'empty-protocol.js');
fs.writeFileSync(protocolFile, `
define('src/chunks/bundle.test.js', function () {
  System.register([], function () {
    return { execute() {
      System.register('chunks:///_virtual/proto-bundle.js', ['helpers', 'protobuf'], function (publish) {
        return { setters: [() => {}, () => {}], execute() { publish('protocol', {}); } };
      });
    } };
  });
});
`);
fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ version: 1, activeId: null, accounts: [] }));
const repo = fileURLToPath(new URL('../', import.meta.url));
let child;
let closed;
try {
  child = spawn(process.execPath, ['src/app.mjs', 'console'], {
    cwd: repo,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CW_DATA_DIR: dir, CW_CONFIG_PACK: configFile,
      CW_PROTO_BUNDLE: protocolFile,
      CW_NO_BROWSER: '1', CW_QUIET_START: '1', CW_PORT: '0',
    },
  });
  closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '', stderr = '';
  child.stderr.on('data', text => { stderr += text; });
  const started = /\[\d{2}:\d{2}:\d{2}\] \[系统\] \[系统与连接\] \[信息\] 控制台已启动 (http:\/\/127\.0\.0\.1:([1-9]\d*))/;
  const guidance = '关闭网页后挂机会继续，运行日志显示在此窗口。请保持此窗口打开；Ctrl+C 或关闭此窗口会结束后台进程。';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('CLI 启动输出超时：' + stderr)), 10000);
    const finish = error => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('close', onClose);
      child.stdout.off('data', onData);
      if (error) reject(error); else resolve();
    };
    const onError = error => finish(error);
    const onClose = (code, signal) => finish(new Error(`CLI 提前退出：code=${code} signal=${signal}\n${stderr}`));
    const onData = text => {
      stdout += text;
      if (started.test(stdout) && stdout.includes(guidance)) finish();
    };
    child.once('error', onError);
    child.once('close', onClose);
    child.stdout.on('data', onData);
  });
  const match = stdout.match(started);
  assert.ok(match, '真实 CLI 必须将格式化业务日志输出到 stdout');
  assert.ok(Number(match[2]) <= 65535, '启动日志必须显示实际监听端口');
  assert.doesNotMatch(stdout, /控制台已启动 http:\/\/127\.0\.0\.1:0\b/);
  assert.ok(stdout.includes(guidance), '启动提示必须区分关闭网页与关闭启动窗口');
  assert.equal(child.exitCode, null, '没有浏览器连接时，后台进程仍保持运行');
  assert.equal(child.signalCode, null);
  const response = await fetch(match[1] + '/api/accounts', { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).accounts, [], '子进程只读取隔离目录的空账号库');
  passed++;
  console.log('通过：真实 CLI 在无浏览器和空账号下保持运行，输出实际地址及启动窗口保留提示');
} finally {
  if (child && closed) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let timer;
    try {
      await Promise.race([
        closed,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('测试子进程未及时退出')), 5000); }),
      ]);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('终端日志格式专项 ' + passed + '/' + passed + ' 通过');
