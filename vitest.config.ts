/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // 测试环境不加载 Taro 运行时，storage 服务退化为 localStorage 实现
      {
        find: '@tarojs/taro',
        replacement: fileURLToPath(
          new URL('./test/stubs/taro.ts', import.meta.url)
        )
      },
      // 组件库依赖 antd-mobile / less，测试中用轻量桩替代
      {
        find: '@/components',
        replacement: fileURLToPath(
          new URL('./test/stubs/components.tsx', import.meta.url)
        )
      },
      {
        find: '@',
        replacement: fileURLToPath(new URL('./src', import.meta.url))
      }
    ]
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    clearMocks: true
  }
});
