/**
 * 余额 / 用量的管理面接口（控制面，仅管理员）。
 *
 * 与数据面 `/v1/usage` 的区别：这里用管理会话鉴权、可看全部渠道、
 * 且刷新**不受** `usage_refresh` 限制（管理员在面板点刷新就该立刻刷）。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { parseJson } from '../lib/http.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import {
  getUsageSnapshot,
  getUsageSnapshots,
  invalidateUsageCache,
  listUsageChannelIds,
  listUsageChannels
} from '../services/usageFetch.js'
import { USAGE_ADAPTERS } from '../services/usage.js'

export const usageAdminRoutes = new Hono()

usageAdminRoutes.use('*', requireAuth)
// 余额 / 用量管理面（自助余额走 /api/billing/me 与 /v1/usage）
// 注意：本路由挂在 /api 下，不能用 use('*', requireAdmin) —— 那会拦到同前缀的其它路由


/** 适配器清单（供渠道弹窗的下拉使用；含提示文案） */
usageAdminRoutes.get('/usage/adapters', requireAdmin, async (c) => {
  return c.json({
    adapters: USAGE_ADAPTERS.map((a) => ({
      id: a.id,
      label: a.label,
      note: a.note ?? '',
      endpoints: a.endpoints.map((e) => e.path),
      // 会话型适配器不用渠道密钥，端点也是完整 URL —— 两者都要给前端
      kind: a.kind ?? 'http',
      auth: a.auth,
      sessionEndpoints: (a.sessionEndpoints ?? []).map((e) => e.url)
    }))
  })
})

/**
 * 渠道清单（余额页的逐项骨架用）。
 *
 * 只读本地表，不碰上游 —— 面板先拿它把卡片壳子画出来，
 * 再并行去取每个渠道的数据，谁先回来谁先显示。
 */
usageAdminRoutes.get('/usage/channels', requireAdmin, async (c) => {
  return c.json({ channels: await listUsageChannels() })
})

/** 全部已配置适配器的渠道快照（余额页用） */
usageAdminRoutes.get('/usage', requireAdmin, async (c) => {
  const ids = await listUsageChannelIds()
  const force = c.req.query('refresh') === '1'
  return c.json({
    generatedAt: new Date().toISOString(),
    providers: await getUsageSnapshots(ids, { force })
  })
})

const refreshSchema = z.object({ channelId: z.string().uuid() })

/** 强制刷新单个渠道（管理员用；绕过缓存） */
usageAdminRoutes.post('/usage/refresh', requireAdmin, async (c) => {
  const body = await parseJson(c, refreshSchema)
  const snapshot = await getUsageSnapshot(body.channelId, { force: true })
  return c.json(snapshot)
})

const invalidateSchema = z.object({ channelId: z.string().uuid() })

/** 仅清缓存（改配置后调用，避免返回旧口径的数据） */
usageAdminRoutes.post('/usage/invalidate', requireAdmin, async (c) => {
  const body = await parseJson(c, invalidateSchema)
  await invalidateUsageCache(body.channelId)
  return c.json({ ok: true })
})

/** 清掉全部余额缓存 */
usageAdminRoutes.post('/usage/invalidate-all', requireAdmin, async (c) => {
  const ids = await listUsageChannelIds()
  for (const id of ids) await invalidateUsageCache(id)
  return c.json({ ok: true, cleared: ids.length })
})

