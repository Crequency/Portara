import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { query } from './db.js'
import { env } from './env.js'
import { ApiError, errorResponse, openaiError } from './lib/http.js'
import { redis } from './redis.js'
import { authRoutes } from './routes/auth.js'
import { channelRoutes } from './routes/channels.js'
import { keyRoutes } from './routes/keys.js'
import { logRoutes } from './routes/logs.js'
import { userRoutes } from './routes/users.js'
import { v1Routes } from './routes/v1.js'
import { serveWebDist } from './static.js'

export const VERSION = '0.1.0'

export function createApp(): Hono {
  const app = new Hono()

  app.onError((err, c) => {
    const isV1 = c.req.path.startsWith('/v1')

    if (err instanceof ApiError) {
      return isV1
        ? openaiError(c, err.status, err.message, 'invalid_request_error', err.code)
        : errorResponse(c, err.status, err.code, err.message, err.extra)
    }

    if (err instanceof HTTPException) {
      const status = err.status
      return isV1
        ? openaiError(c, status, err.message || '请求失败', 'invalid_request_error', null)
        : errorResponse(c, status, 'http_error', err.message || '请求失败')
    }

    console.error('[portara][error]', err)
    return isV1
      ? openaiError(c, 500, '网关内部错误', 'api_error', 'internal_error')
      : errorResponse(c, 500, 'internal_error', '服务器内部错误')
  })

  app.notFound((c) => {
    if (c.req.path.startsWith('/v1')) {
      return openaiError(
        c,
        404,
        `未知端点：${c.req.path}`,
        'invalid_request_error',
        'unknown_endpoint'
      )
    }
    return errorResponse(c, 404, 'not_found', `路径不存在：${c.req.path}`)
  })

  // ---- 运维端点 ----
  app.get('/healthz', (c) =>
    c.json({ ok: true, service: 'portara', version: VERSION, uptime: process.uptime() })
  )

  app.get('/readyz', async (c) => {
    const checks: Record<string, string> = {}
    let ok = true

    try {
      await query('select 1')
      checks.database = 'ok'
    } catch (err) {
      checks.database = err instanceof Error ? err.message : 'error'
      ok = false
    }

    try {
      await redis.ping()
      checks.redis = 'ok'
    } catch (err) {
      checks.redis = err instanceof Error ? err.message : 'error'
      ok = false
    }

    return c.json({ ok, checks, version: VERSION }, ok ? 200 : 503)
  })

  // ---- 前端产物（单端口部署；未构建时自动跳过）----
  app.use('*', serveWebDist(env.webDist))

  // ---- 控制面 ----
  app.route('/api/auth', authRoutes)
  app.route('/api/users', userRoutes)
  app.route('/api/channels', channelRoutes)
  app.route('/api/keys', keyRoutes)
  app.route('/api', logRoutes) // /api/logs、/api/stats/*

  // ---- 数据面（OpenAI 兼容）----
  app.route('/v1', v1Routes)

  return app
}
