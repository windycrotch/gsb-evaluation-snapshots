// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================
import { defineConfig } from 'vitest/config';
import glsl from 'vite-plugin-glsl';

export default defineConfig({
    plugins: [glsl({ include: ['**/*.glsl'] })],
    test: {
        environment: 'node',
        include: ['test/**/*.test.ts'],
        globals: false,
    },
});
