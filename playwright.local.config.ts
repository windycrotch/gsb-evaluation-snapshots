import { defineConfig, devices } from "@playwright/test";

// Local sandbox variant of playwright.config.ts: uses the bundled Chromium
// instead of the system Chrome channel. Not used by CI/normal setups.
const PORT = 5190;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "*.e2e.ts",
  timeout: 60_000,
  fullyParallel: true,
  workers: 4,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: true,
  },
});
