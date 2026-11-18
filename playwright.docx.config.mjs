import { defineConfig } from '@playwright/test'

// Behavioural tests for the DOCX comparison view (scrolling, change navigation
// and the changes-only view). Kept separate from the security suite so each
// suite can own its test directory; both use the same local-only dev server.
export default defineConfig({
  testDir: './tests/docx',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4179',
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4179 --strictPort',
    url: 'http://127.0.0.1:4179/tests/fixtures/blank.html',
    reuseExistingServer: false,
  },
})
