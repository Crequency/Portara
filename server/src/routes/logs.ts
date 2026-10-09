import { Hono } from 'hono'
import { z } from 'zod'
import { query } from '../db.js'
import { parseQuery } from '../lib/http.js'
import { requireAuth } from '../middleware/auth.js'
import type { RequestLogRow } from '../types.js'

export const logRoutes = new Hono()

logRoutes.use('*', requireAuth)

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  apiKeyId: z.string().optional(),
  channelId: z.string().optional(),
  model: z.string().optional(),
  status: z.enum(['all', 'ok', 'error']).default('all')
})

const uuidLike =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

logRoutes.get('/logs', async (c) => {
  const q = parseQuery(c, listQuery)

  const where: string[] = []
  const params: unknown[] = []

  if (q.apiKeyId && uuidLike.test(q.apiKeyId)) {
    params.push(q.apiKeyId)
    where.push(`api_key_id = $${params.length}`)
  }
  if (q.channelId && uuidLike.test(q.channelId)) {
    params.push(q.channelId)
    where.push(`channel_id = $${params.length}`)
  }
  if (q.model) {
    params.push(`%${q.model}%`)
    where.push(`model ilike $${params.length}`)
  }
  if (q.status === 'ok') where.push('status_code < 400')
  if (q.status === 'error') where.push('status_code >= 400')

  const clause = where.length > 0 ? `where ${where.join(' and ')}` : ''

  const countRows = await query<{ count: string }>(
    `select count(*)::text as count from request_logs ${clause}`,
    params
  )

  params.push(q.limit, q.offset)
  const rows = await query<RequestLogRow>(
    `select * from request_logs ${clause}
      order by ts desc
      limit $${params.length - 1} offset $${params.length}`,
    params
  )

  return c.json({
    total: Number(countRows[0]?.count ?? '0'),
    logs: rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      apiKeyName: r.api_key_name,
      channelName: r.channel_name,
      model: r.model,
      path: r.path,
      statusCode: r.status_code,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      totalTokens: r.total_tokens,
      estimated: r.estimated,
      latencyMs: r.latency_ms,
      ttftMs: r.ttft_ms,
      clientIp: r.client_ip,
      error: r.error
    }))
  })
})

logRoutes.get('/stats/overview', async (c) => {
  const row = await query<{
    users: string
    channels: string
    active_channels: string
    keys: string
    today_requests: string
    today_tokens: string
    today_errors: string
    total_requests: string
  }>(`
    select
      (select count(*) from users)::text as users,
      (select count(*) from channels)::text as channels,
      (select count(*) from channels where status = 'active')::text as active_channels,
      (select count(*) from api_keys where status = 'active')::text as keys,
      (select count(*) from request_logs where ts >= date_trunc('day', now()))::text as today_requests,
      (select coalesce(sum(total_tokens),0) from request_logs where ts >= date_trunc('day', now()))::text as today_tokens,
      (select count(*) from request_logs where ts >= date_trunc('day', now()) and status_code >= 400)::text as today_errors,
      (select count(*) from request_logs)::text as total_requests
  `)

  const r = row[0]
  return c.json({
    users: Number(r?.users ?? 0),
    channels: Number(r?.channels ?? 0),
    activeChannels: Number(r?.active_channels ?? 0),
    keys: Number(r?.keys ?? 0),
    todayRequests: Number(r?.today_requests ?? 0),
    todayTokens: Number(r?.today_tokens ?? 0),
    todayErrors: Number(r?.today_errors ?? 0),
    totalRequests: Number(r?.total_requests ?? 0)
  })
})

const seriesQuery = z.object({
  days: z.coerce.number().int().min(1).max(30).default(7)
})

logRoutes.get('/stats/series', async (c) => {
  const { days } = parseQuery(c, seriesQuery)

  const rows = await query<{ day: string; requests: number; tokens: string; errors: number }>(
    `
    select to_char(d, 'MM-DD') as day,
           coalesce(count(l.id), 0)::int as requests,
           coalesce(sum(l.total_tokens), 0)::text as tokens,
           coalesce(sum(case when l.status_code >= 400 then 1 else 0 end), 0)::int as errors
      from generate_series(
             date_trunc('day', now()) - ($1::int - 1) * interval '1 day',
             date_trunc('day', now()),
             interval '1 day'
           ) as d
      left join request_logs l
             on l.ts >= d and l.ts < d + interval '1 day'
     group by d
     order by d asc
    `,
    [days]
  )

  return c.json({
    series: rows.map((r) => ({
      day: r.day,
      requests: Number(r.requests),
      tokens: Number(r.tokens),
      errors: Number(r.errors)
    }))
  })
})
