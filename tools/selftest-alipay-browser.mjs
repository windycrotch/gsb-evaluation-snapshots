import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureHeadlessBrowser, findHeadlessBrowser } from '../src/platform/browser.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-alipay-browser-'));
try {
  const configured = path.join(root, 'custom-chromium');
  fs.writeFileSync(configured, '');
  assert.equal(findHeadlessBrowser({ CW_BROWSER_EXECUTABLE: configured, PATH: '' }, 'linux'), configured,
    '服务器可通过 CW_BROWSER_EXECUTABLE 指定浏览器');
  assert.equal(await ensureHeadlessBrowser({ CW_BROWSER_EXECUTABLE: configured, PATH: '' }, 'linux'), configured,
    '找到已有浏览器时不触发下载');

  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const chromium = path.join(bin, 'chromium');
  fs.writeFileSync(chromium, '');
  assert.equal(findHeadlessBrowser({ PATH: bin }, 'linux'), chromium,
    '从服务器 PATH 中发现 Chromium');

  const edgeRoot = path.join(root, 'Program Files');
  const edge = path.join(edgeRoot, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  fs.mkdirSync(path.dirname(edge), { recursive: true });
  fs.writeFileSync(edge, '');
  assert.equal(findHeadlessBrowser({ ProgramFiles: edgeRoot }, 'win32'), edge,
    '兼容 Windows Edge 安装路径');
  console.log('selftest-alipay-browser: ok');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
