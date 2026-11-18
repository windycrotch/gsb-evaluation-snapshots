import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-recovery-http-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { createConsole } = await import('../src/server.mjs');
const events = [];
let pending = true, recoveries = 0, fail = false;
const inspect = () => ({ pending, recoverable: pending, message: pending ? '检测到上次采集残留' : '' });
const captureController = {
  captureState: () => ({ running: false, phase: 'idle', recovery: inspect() }),
  inspectCaptureRecovery: inspect,
  recoverCapture: async () => {
    if (fail) throw new Error('模拟恢复失败，保留记录');
    recoveries++;
    pending = false;
  },
};
const app = createConsole({ port: 0, protocol: {}, captureController, onLog: entry => events.push(entry) });
try {
  const root = await app.listen();
  assert(events.some(entry => entry.level === 'warn' && /上次采集残留/.test(entry.message)));
  const state = await (await fetch(root + '/api/capture')).json();
  assert.equal(state.recovery.pending, true);
  const page = await (await fetch(root)).text();
  assert.match(page, /id="cap-recover"/);
  const recover = body => fetch(root + '/api/capture/recover', { method: 'POST', body: JSON.stringify(body) });
  const unconfirmed = await recover({});
  assert.equal(unconfirmed.status, 400);
  assert.equal(recoveries, 0);
  fail = true;
  const rejected = await recover({ confirm: true });
  assert.equal(rejected.status, 400);
  assert.equal(pending, true);
  fail = false;
  const restored = await recover({ confirm: true });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).recovery.pending, false);
  assert.equal(recoveries, 1);
  assert(events.some(entry => /残留已核对并恢复/.test(entry.message)));
  console.log('抓包恢复 HTTP 自检通过，覆盖启动提示、页面入口、失败重试和恢复结果');
} finally {
  await app.close();
  assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: true });
}
