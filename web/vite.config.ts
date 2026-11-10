import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/*
 * 构建指纹：页脚会显示 "v0.6.5 · <短哈希>"，用来一眼判断浏览器是不是还在跑旧产物。
 *
 * 起因：改完前端后用户反馈"还是不行"，但服务器上的 dist 已经是新的 ——
 * 没有可见指纹时无法区分「代码没生效」和「浏览器缓存了旧 index.html」。
 * 取不到 git 时回落到构建时间戳，永远有值。
 */
function buildId(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
  }
}

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
  define: {
    __BUILD_ID__: JSON.stringify(buildId())
  },
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
