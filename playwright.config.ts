import { defineConfig } from '@playwright/test';

/** Smoke tests of the real editor in a real browser. Locally they use the Chrome that is installed; CI installs Chromium. */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5273',
    channel: process.env.CI ? undefined : 'chrome',
    viewport: { width: 1440, height: 900 },
  },
  webServer: { command: 'npm run dev', url: 'http://localhost:5273', reuseExistingServer: !process.env.CI, timeout: 60_000 },
});
