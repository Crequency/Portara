import { Hono } from 'hono'
import { one } from '../db.js'
import { requireAuth } from '../middleware/auth.js'
import { toUserDto } from '../types.js'

/**
 * 当前登录用户的资料与**用户范围**用量统计。
 *
 * 与 /api/stats/* 的区别：那边是全局口径，这里只算「自己名下的 API Key」
 * 产生的流量 —— 靠 api_keys.user_id 关联 request_logs.api_key_id 得到。
 * 因此挂在 requireAuth 下（不是 requireAdmin）：任何登录用户都能看自己的。
 */
export const profileRoutes = new Hono()

profileRoutes.use('*', requireAuth)

interface ProfileStatsRow {
  keys_total: string
  keys_active: string
  requests: string
  errors: string
  tokens: string
  last30d_requests: string
  last30d_errors: string
  last30d_tokens: string
  first_request_at: Date | string | null
  last_request_at: Date | string | null
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const iso = (v: Date | string | null): string | null =>
  v ? new Date(v).toISOString() : null

profileRoutes.get('/', async (c) => {
  const user = c.get('user')

  /*
   * 一次查询取回全部数字，避免「先查密钥数、再查请求数、再查 token」的 N+1。
   *
   * - user_keys：该用户名下的密钥（总数 / 启用数）
   * - scoped_logs：只保留能归因到这些密钥的请求日志
   *
   * 30 天窗口用 now() - interval '30 days'（滚动 30 天，不是自然日界），
   * 与页面文案「近 30 天」一致。
   */
  const row = await one<ProfileStatsRow>(
    `with user_keys as (
       select id, status from api_keys where user_id = $1
     ),
     scoped_logs as (
       select l.ts, l.status_code, l.total_tokens
         from request_logs l
         join api_keys k on k.id = l.api_key_id
        where k.user_id = $1
     )
     select
       (select count(*) from user_keys)::text                        as keys_total,
       (select count(*) from user_keys where status = 'active')::text as keys_active,
       count(*)::text                                                as requests,
       count(*) filter (where status_code >= 400)::text              as errors,
       coalesce(sum(total_tokens), 0)::text                          as tokens,
       count(*) filter (where ts >= now() - interval '30 days')::text as last30d_requests,
       count(*) filter (
         where ts >= now() - interval '30 days' and status_code >= 400
       )::text                                                       as last30d_errors,
       coalesce(
         sum(total_tokens) filter (where ts >= now() - interval '30 days'), 0
       )::text                                                       as last30d_tokens,
       min(ts)                                                       as first_request_at,
       max(ts)                                                       as last_request_at
       from scoped_logs`,
    [user.id]
  )

  const r = row ?? ({} as ProfileStatsRow)

  return c.json({
    user: toUserDto(user),
    stats: {
      keys: { total: num(r.keys_total), active: num(r.keys_active) },
      requests: num(r.requests),
      errors: num(r.errors),
      tokens: num(r.tokens),
      last30d: {
        requests: num(r.last30d_requests),
        errors: num(r.last30d_errors),
        tokens: num(r.last30d_tokens)
      },
      // 没有日志时 min/max 都是 null —— 原样返回 null，不伪造时间
      firstRequestAt: iso(r.first_request_at),
      lastRequestAt: iso(r.last_request_at)
    }
  })
})
