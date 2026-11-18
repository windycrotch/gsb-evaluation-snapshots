import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // The package only declares a "module" entry (no "main"/"exports"),
      // which vite's SSR resolver does not pick up. Alias it explicitly.
      '@ain1084/audio-frame-buffer': fileURLToPath(
        new URL('./node_modules/@ain1084/audio-frame-buffer/dist/index.js', import.meta.url),
      ),
    },
  },
})
