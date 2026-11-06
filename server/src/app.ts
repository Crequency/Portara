import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { query } from './db.js'
import { env } from './env.js'
import { getSettings } from './services/settings.js'
import { ApiError, errorResponse, openaiError } from './lib/http.js'
import { redis } from './redis.js'
import { auditRoutes } from './routes/audit.js'
import { authRoutes } from './routes/auth.js'
import { channelAccountRoutes } from './routes/channelAccounts.js'
import { channelRoutes } from './routes/channels.js'
import { keyRoutes } from './routes/keys.js'
import { logRoutes } from './routes/logs.js'
import { modelRouteRoutes } from './routes/modelRoutes.js'
import { profileRoutes } from './routes/profile.js'
import { proxyRoutes } from './routes/proxies.js'
import { registrationRoutes } from './routes/registrations.js'
import { settingsRoutes } from './routes/settings.js'
import { usageRoutes } from './routes/usage.js'
import { usageAdminRoutes } from './routes/usageAdmin.js'
import { userRoutes } from './routes/users.js'
import { v1Routes } from './routes/v1.js'
import { serveWebDist } from './static.js'

// 版本常量独立成模块：测试要读它时不该顺带把数据库/Redis 连接也建起来。
// 这里 import 是为了本文件自己用（健康检查与 /api/meta），再 re-export 给 index.ts。
import { VERSION } from './version.js'
export { VERSION }

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

  /**
   * 公开的品牌信息 —— **登录页也要显示网关名称**，那时还没有会话。
   * 只暴露非敏感内容，绝不放设置项全量（其中可能含安全开关）。
   */
  app.get('/api/meta', async (c) => {
    const { settings } = await getSettings()
    return c.json({
      gatewayName: settings.gatewayName,
      productName: 'Portara',
      version: VERSION
    })
  })

  // ---- 前端产物（单端口部署；未构建时自动跳过）----
  app.use('*', serveWebDist(env.webDist))

  // ---- 控制面 ----
  app.route('/api/auth', authRoutes)
  // 公开注册申请（POST /api/register 无需登录）与管理员审批（路由内部挂 requireAuth/requireAdmin）
  app.route('/api', registrationRoutes)
  app.route('/api/users', userRoutes)
  app.route('/api/channels', channelRoutes)
  // 嵌套资源：账户挂在渠道下（放在 channels 之后，靠其 unmatched 落空自然回落）
  app.route('/api/channels', channelAccountRoutes)
  app.route('/api/keys', keyRoutes)
  // 个人资料与用户范围统计：路由内部挂 requireAuth（任何登录用户都能看自己的）
  app.route('/api/profile', profileRoutes)
  app.route('/api/audit', auditRoutes)
  app.route('/api/model-routes', modelRouteRoutes)
  app.route('/api/settings', settingsRoutes)
  app.route('/api', usageAdminRoutes) // /api/usage、/api/usage/adapters
  app.route('/api/proxies', proxyRoutes)
  app.route('/api', logRoutes) // /api/logs、/api/stats/*

  // ---- 数据面 ----
  // 注意顺序：`/v1/usage` 必须在 `/v1` **之前**挂载。
  // v1Routes 有兜底捕获（未知 /v1/* 路径一律 404），挂在它后面会被吞掉。
  app.route('/v1/usage', usageRoutes)
  // OpenAI 兼容（对话、模型列表等）
  app.route('/v1', v1Routes)

  return app
}
