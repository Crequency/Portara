import { Hono } from 'hono'
import { z } from 'zod'
import { query } from '../db.js'
import { badRequest, parseQuery } from '../lib/http.js'
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
      upstreamModel: r.upstream_model,
      path: r.path,
      statusCode: r.status_code,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      totalTokens: r.total_tokens,
      estimated: r.estimated,
      source: r.source,
      latencyMs: r.latency_ms,
      ttftMs: r.ttft_ms,
      clientIp: r.client_ip,
      error: r.error
    }))
  })
})

/** 时间范围解析：预设走 SQL 的 date_trunc，自定义用前端传入的边界 */
const rangeQuery = z.object({
  range: z.enum(['today', '7d', '30d', 'custom']).default('today'),
  from: z.string().optional(),
  to: z.string().optional()
})

interface Bounds {
  from: string
  to: string
}

async function resolveBounds(
  range: 'today' | '7d' | '30d' | 'custom',
  from?: string,
  to?: string
): Promise<Bounds> {
  if (range === 'custom') {
    const f = from ? new Date(from) : null
    const t = to ? new Date(to) : null
    if (!f || !t || Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) {
      throw badRequest('自定义范围需要合法的 from 与 to 时间')
    }
    if (f.getTime() >= t.getTime()) throw badRequest('from 必须早于 to')
    return { from: f.toISOString(), to: t.toISOString() }
  }

  // 交给数据库算边界，保证与 request_logs.ts 的 date_trunc 口径一致
  const rows = await query<{ from_ts: string; to_ts: string }>(
    `select
       case $1
         when 'today' then date_trunc('day', now())
         when '7d'    then date_trunc('day', now()) - interval '6 days'
         when '30d'   then date_trunc('day', now()) - interval '29 days'
       end as from_ts,
       now() as to_ts`,
    [range]
  )
  const row = rows[0]!
  return { from: row.from_ts, to: row.to_ts }
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

logRoutes.get('/stats/overview', async (c) => {
  const q = parseQuery(c, rangeQuery)
  const { from, to } = await resolveBounds(q.range, q.from, q.to)
  const params = [from, to]

  const totalsRows = await query<Record<string, string>>(
    `select
       count(*)::text                                                        as requests,
       coalesce(sum(prompt_tokens), 0)::text                                 as prompt_tokens,
       coalesce(sum(completion_tokens), 0)::text                             as completion_tokens,
       coalesce(sum(total_tokens), 0)::text                                  as tokens,
       count(*) filter (where status_code >= 400)::text                      as errors,
       count(*) filter (where estimated)::text                               as estimated,
       count(*) filter (where source <> 'gateway')::text                     as diagnostic,
       coalesce(avg(latency_ms), 0)::text                                    as avg_latency,
       coalesce(percentile_cont(0.95) within group (order by latency_ms), 0)::text as p95_latency
     from request_logs
     where ts >= $1 and ts <= $2`,
    params
  )
  const t = totalsRows[0] ?? {}
  const requests = num(t.requests)
  const errors = num(t.errors)

  const resourceRows = await query<Record<string, string>>(`
    select
      (select count(*) from users)::text                                   as users,
      (select count(*) from channels)::text                                as channels,
      (select count(*) from channels where status = 'active')::text         as active_channels,
      (select count(*) from api_keys where status = 'active')::text         as keys
  `)
  const r = resourceRows[0] ?? {}

  const topRows = await query<{
    kind: string
    name: string
    requests: string
    tokens: string
  }>(
    `select kind, name, count(*)::text as requests, coalesce(sum(total_tokens),0)::text as tokens
       from (
         select 'model'   as kind, model          as name, total_tokens from request_logs where ts >= $1 and ts <= $2 and model <> ''
         union all
         select 'channel' as kind, channel_name   as name, total_tokens from request_logs where ts >= $1 and ts <= $2 and channel_name <> ''
         union all
         select 'key'     as kind, api_key_name   as name, total_tokens from request_logs where ts >= $1 and ts <= $2 and api_key_name <> ''
       ) x
      group by kind, name
      order by count(*) desc
      limit 15`,
    params
  )

  const top = (kind: string) =>
    topRows
      .filter((row) => row.kind === kind)
      .slice(0, 5)
      .map((row) => ({
        name: row.name,
        requests: num(row.requests),
        tokens: num(row.tokens)
      }))

  return c.json({
    range: { preset: q.range, from, to },
    totals: {
      requests,
      errors,
      errorRate: requests > 0 ? errors / requests : 0,
      tokens: num(t.tokens),
      promptTokens: num(t.prompt_tokens),
      completionTokens: num(t.completion_tokens),
      estimated: num(t.estimated),
      // 直连测试（对话测试页的上游渠道测试）：计入总量，但单独标出以便区分
      diagnosticRequests: num(t.diagnostic),
      avgLatencyMs: Math.round(num(t.avg_latency)),
      p95LatencyMs: Math.round(num(t.p95_latency))
    },
    resources: {
      users: num(r.users),
      channels: num(r.channels),
      activeChannels: num(r.active_channels),
      keys: num(r.keys)
    },
    topModels: top('model'),
    topChannels: top('channel'),
    topKeys: top('key')
  })
})

logRoutes.get('/stats/series', async (c) => {
  const q = parseQuery(c, rangeQuery)
  const { from, to } = await resolveBounds(q.range, q.from, q.to)

  // 跨度 ≤ 48 小时按小时分桶，否则按天 —— 否则今日范围只会有一个点
  const spanHours = (new Date(to).getTime() - new Date(from).getTime()) / 3_600_000
  const hourly = spanHours <= 48
  const interval = hourly ? '1 hour' : '1 day'
  const labelFormat = hourly ? 'MM-DD HH24:00' : 'MM-DD'

  const rows = await query<{ label: string; requests: number; tokens: string; errors: number }>(
    `
    select to_char(bucket, $4) as label,
           coalesce(count(l.id), 0)::int as requests,
           coalesce(sum(l.total_tokens), 0)::text as tokens,
           coalesce(count(l.id) filter (where l.status_code >= 400), 0)::int as errors
      from generate_series($1::timestamptz, $2::timestamptz, $3::interval) as bucket
      left join request_logs l
             on l.ts >= bucket and l.ts < bucket + $3::interval
     group by bucket
     order by bucket asc
    `,
    [from, to, interval, labelFormat]
  )

  return c.json({
    granularity: hourly ? 'hour' : 'day',
    range: { preset: q.range, from, to },
    series: rows.map((row) => ({
      day: row.label,
      requests: num(row.requests),
      tokens: num(row.tokens),
      errors: num(row.errors)
    }))
  })
})
