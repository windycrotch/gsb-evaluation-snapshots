// Chrome's launch flags: --no-sandbox is added when, and only when, motlab
// runs as root, because Chrome refuses to start as root without it. And the
// Chromium that Playwright downloads is found when there is no system Chrome.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { SANDBOX_FLAGS, playwrightChrome } from '../src/chrome.js';

test('--no-sandbox is passed exactly when running as root', () => {
  const root = typeof process.getuid === 'function' && process.getuid() === 0;
  assert.deepEqual(SANDBOX_FLAGS, root ? ['--no-sandbox'] : []);
});

test("Playwright's newest Chromium is found, by revision number, and only where its executable is", () => {
  const dir = mkdtempSync(join(tmpdir(), 'motlab-pw-'));
  try {
    const exe = (folder, ...rest) => { const p = join(dir, folder, ...rest); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, ''); return p; };
    exe('chromium-999', 'chrome-linux64', 'chrome');
    const newest = exe('chromium-1248', 'chrome-linux64', 'chrome');
    mkdirSync(join(dir, 'chromium-1300'));                                    // an unfinished download: no executable
    exe('chromium_headless_shell-1400', 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    assert.equal(playwrightChrome(dir, 'linux-x64'), newest);                 // 1248 beats 999 as a number, not as text
    assert.equal(playwrightChrome(dir, 'win32-x64'), null);                   // the Linux build is not used on Windows
    const win = exe('chromium-1248', 'chrome-win64', 'chrome.exe');
    assert.equal(playwrightChrome(dir, 'win32-x64'), win);
    assert.equal(playwrightChrome(join(dir, 'missing'), 'linux-x64'), null);
    assert.equal(playwrightChrome(dir, 'freebsd-x64'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
