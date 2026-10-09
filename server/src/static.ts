import { stat, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { MiddlewareHandler } from 'hono'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
}

/**
 * 托管前端构建产物（单端口部署）。
 * - 命中文件则直接返回；
 * - 未命中且不是 API/数据面路径 → 回退 index.html（SPA 路由）；
 * - 产物不存在（未构建）→ 交给后续中间件，最终 404。
 */
export function serveWebDist(webDist: string): MiddlewareHandler {
  const root = path.resolve(webDist)

  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next()

    const urlPath = decodeURIComponent(new URL(c.req.url).pathname)
    if (urlPath.startsWith('/api/') || urlPath.startsWith('/v1')) return next()

    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
    let filePath = path.resolve(path.join(root, rel))

    // 目录穿越防护
    if (!filePath.startsWith(root + path.sep) && filePath !== root) return next()

    let info = await stat(filePath).catch(() => null)
    if (!info || info.isDirectory()) {
      filePath = path.join(root, 'index.html')
      info = await stat(filePath).catch(() => null)
      if (!info) return next()
    }

    const body = await readFile(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const isHashed = /-[A-Za-z0-9_]{8,}\./.test(path.basename(filePath))

    return new Response(new Uint8Array(body), {
      headers: {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        // 带哈希的产物可长缓存；index.html 必须每次校验
        'cache-control': isHashed ? 'public, max-age=31536000, immutable' : 'no-cache'
      }
    })
  }
}
