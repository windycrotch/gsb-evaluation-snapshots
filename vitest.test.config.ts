import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
    globals: false,
    restoreMocks: true,
    testTimeout: 15000,
  },
});
