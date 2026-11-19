import { defineConfig } from '@playwright/test';

// Local verification on Windows: the shipped playwright.config.ts targets the
// machine's Chrome with a macOS-only ANGLE flag (--use-angle=metal), which
// Chrome on Windows rejects. This uses the bundled Chromium and a GL/D3D path
// instead; the tests themselves are unchanged.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    launchOptions: { args: ['--ignore-gpu-blocklist', '--enable-webgl'] },
  },
});
