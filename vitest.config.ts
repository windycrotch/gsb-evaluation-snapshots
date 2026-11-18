import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

/**
 * 演示页的测试配置。
 *
 * 仓库根目录下的子模块（src/leafer、src/ui）在评测快照中并不存在，
 * 因此这里不复用 vite.config.ts 的源码别名，而是统一解析到已安装的 leafer-ui 包，
 * 使测试在只有 npm 依赖的环境下也能运行。
 */
export default defineConfig({
    resolve: {
        alias: [
            {
                find: /^leafer-ui$/,
                replacement: resolve(__dirname, 'node_modules/leafer-ui/dist/web.esm.js')
            }
        ]
    },
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: ['./src/test/setup.ts'],
        include: ['src/test/**/*.{test,spec}.ts']
    }
})
