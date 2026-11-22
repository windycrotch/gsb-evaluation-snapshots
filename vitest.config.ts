import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Mirror packages/vue/vite.config.ts so tests import core from source
      // and do not depend on a prebuilt packages/core/dist.
      '@vue-player/core': resolve(__dirname, 'packages/core/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
  },
})
