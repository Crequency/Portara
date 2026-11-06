import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/*
 * 开发态放行仓库根：AboutPage 直接 import ../../../docs/assets/banner.svg?url，
 * 该文件在 Vite root（web/）之外，不放行会被 /@fs/ 的 fs 检查拦下。
 * 构建态由 Rollup 直接处理，不需要这条。
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

// 开发模式下 /api 与 /v1 代理到 Hono（默认 52740）
const target = process.env.PORTARA_API_TARGET ?? 'http://127.0.0.1:52740'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: 52741,
    // 端口被占用时直接失败，不静默漂移（DevHub 约定）
    strictPort: true,
    fs: {
      allow: [repoRoot]
    },
    proxy: {
      '/api': { target, changeOrigin: false },
      '/v1': { target, changeOrigin: false },
      '/healthz': { target, changeOrigin: false },
      '/readyz': { target, changeOrigin: false }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false
  }
})
