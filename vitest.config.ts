import path from 'node:path';
import { defineConfig } from 'vitest/config';

const src = (p: string) => path.resolve(import.meta.dirname, 'src', p);

export default defineConfig({
  resolve: {
    alias: [
      { find: 'audio', replacement: src('audio.ts') },
      { find: 'helpers/notifier.js', replacement: src('helpers/notifier.ts') },
      { find: 'adapters', replacement: src('adapters') },
      { find: 'constants', replacement: src('constants') },
      { find: 'events', replacement: src('events') },
      { find: 'helpers', replacement: src('helpers') },
      { find: 'mediasession', replacement: src('mediasession') },
      { find: 'states', replacement: src('states') },
      { find: 'types', replacement: src('types') },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
    setupFiles: ['src/tests/mocks.ts'],
  },
});
