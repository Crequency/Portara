import { Hono } from 'hono'
import { z } from 'zod'
import { query } from '../db.js'
import { badRequest, parseQuery } from '../lib/http.js'
import { getSetting, isValidTimeZone } from '../services/settings.js'
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
  to: z.string().optional(),
  /** 可选：只看某个渠道的流量（渠道详情页用） */
  channelId: z.string().optional(),
  /** Top 榜单的排序依据：调用次数 / 已用 token */
  sortBy: z.enum(['requests', 'tokens']).default('requests'),
  /**
   * 可选：请求方时区（IANA 名）。
   * 前端会带上**浏览器时区**，于是面板里的「今日」就是用户眼里的今日；
   * 不传则回落到系统设置里的网关时区。
   */
  tz: z.string().max(64).optional()
})

/**
 * 决定本次查询用哪个时区做「按天」的口径。
 * 请求方指定且合法 → 用它；否则用网关时区设置。
 */
async function resolveQueryTimeZone(requested?: string): Promise<string> {
  if (requested && isValidTimeZone(requested)) return requested
  return getSetting('timezone')
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Bounds {
  from: string
  to: string
}

/**
 * 算出一个范围的起止（UTC 瞬时）。
 *
 * 关键：`from` 必须是**指定时区**的当地 00:00，再转回 UTC 瞬时。
 * 此前直接用 `date_trunc('day', now())`（库会话时区 = UTC），
 * 导致 UTC+8 的用户选「今日」时会丢掉本地 00:00–08:00 的数据。
 */
async function resolveBounds(
  range: 'today' | '7d' | '30d' | 'custom',
  tz: string,
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

  // 交给数据库算边界：先把 now() 换算到目标时区的当地墙钟，取当地日界，
  // 再转回 timestamptz。这样「今日」在不同时区都从各自当地 00:00 起算。
  const rows = await query<{ from_ts: string; to_ts: string }>(
    `select
       case $1
         when 'today' then (date_trunc('day', now() at time zone $2)) at time zone $2
         when '7d'    then (date_trunc('day', now() at time zone $2) - interval '6 days') at time zone $2
         when '30d'   then (date_trunc('day', now() at time zone $2) - interval '29 days') at time zone $2
       end as from_ts,
       now() as to_ts`,
    [range, tz]
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
  const tz = await resolveQueryTimeZone(q.tz)
  const { from, to } = await resolveBounds(q.range, tz, q.from, q.to)
  const channelFilter = q.channelId && UUID_RE.test(q.channelId) ? q.channelId : null
  const params = [from, to, channelFilter]

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
     where ts >= $1 and ts <= $2
       and ($3::uuid is null or channel_id = $3)`,
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

  /**
   * Top 榜单：三种 kind 各取前 5。
   *
   * 用窗口函数按 kind 分别排名，而不是先全局 limit ——
   * 原来的 `limit 15` 是全局限额，某个 kind 占满 15 条时另外两个就取不满 5 条。
   * 同时把「按次数」与「按 token」两套排名一次算出来（只多扫一遍，省一次查询）。
   */
  const topRows = await query<{
    kind: string
    name: string
    requests: string
    tokens: string
  }>(
    `with agg as (
       select kind, name, count(*) as requests, coalesce(sum(total_tokens), 0) as tokens
         from (
           select 'model'   as kind, model          as name, total_tokens from request_logs
            where ts >= $1 and ts <= $2 and model <> '' and ($3::uuid is null or channel_id = $3)
           union all
           select 'channel' as kind, channel_name   as name, total_tokens from request_logs
            where ts >= $1 and ts <= $2 and channel_name <> '' and ($3::uuid is null or channel_id = $3)
           union all
           select 'key'     as kind, api_key_name   as name, total_tokens from request_logs
            where ts >= $1 and ts <= $2 and api_key_name <> '' and ($3::uuid is null or channel_id = $3)
         ) x
        group by kind, name
     ),
     ranked as (
       select *,
              row_number() over (partition by kind order by requests desc, name asc) as rn_req,
              row_number() over (partition by kind order by tokens   desc, name asc) as rn_tok
         from agg
     )
     select kind, name, requests::text as requests, tokens::text as tokens
       from ranked
      where rn_req <= 5 or rn_tok <= 5`,
    params
  )

  const sortBy = q.sortBy
  const top = (kind: string) =>
    topRows
      .filter((row) => row.kind === kind)
      .sort((a, b) =>
        sortBy === 'tokens'
          ? num(b.tokens) - num(a.tokens) || a.name.localeCompare(b.name)
          : num(b.requests) - num(a.requests) || a.name.localeCompare(b.name)
      )
      // 返回候选集（每类最多 10 条 = 两种排序各自的前 5），
      // 调用方可自行再排序；面板据此实现「零延迟切换排序依据」
      .map((row) => ({
        name: row.name,
        requests: num(row.requests),
        tokens: num(row.tokens)
      }))

  return c.json({
    range: { preset: q.range, from, to },
    timezone: tz,
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
    sortBy,
    topModels: top('model'),
    topChannels: top('channel'),
    topKeys: top('key')
  })
})

logRoutes.get('/stats/series', async (c) => {
  const q = parseQuery(c, rangeQuery)
  const tz = await resolveQueryTimeZone(q.tz)
  const { from, to } = await resolveBounds(q.range, tz, q.from, q.to)
  const channelFilter = q.channelId && UUID_RE.test(q.channelId) ? q.channelId : null

  // 跨度 ≤ 48 小时按小时分桶，否则按天 —— 否则今日范围只会有一个点
  const spanHours = (new Date(to).getTime() - new Date(from).getTime()) / 3_600_000
  const hourly = spanHours <= 48
  const interval = hourly ? '1 hour' : '1 day'
  const gran = hourly ? 'hour' : 'day'
  const labelFormat = hourly ? 'MM-DD HH24:00' : 'MM-DD'

  // 分桶要在**目标时区**里生成：先把起止换算成当地墙钟、取当地整点/日界，
  // 再逐个转回 timestamptz。桶的结束取下一个桶的开始（而不是 +24h），
  // 这样夏令时切换那天（23/25 小时）也切得准。
  const rows = await query<{ label: string; requests: number; tokens: string; errors: number }>(
    `
    with bucket_starts as (
      select (b at time zone $6) as bucket_start
        from generate_series(
          date_trunc($4, ($1::timestamptz at time zone $6)),
          date_trunc($4, ($2::timestamptz at time zone $6)),
          $3::interval
        ) as b
    ),
    spans as (
      select bucket_start,
             coalesce(
               lead(bucket_start) over (order by bucket_start),
               bucket_start + $3::interval
             ) as bucket_end
        from bucket_starts
    )
    select to_char(s.bucket_start at time zone $6, $5) as label,
           coalesce(count(l.id), 0)::int as requests,
           coalesce(sum(l.total_tokens), 0)::text as tokens,
           coalesce(count(l.id) filter (where l.status_code >= 400), 0)::int as errors
      from spans s
      left join request_logs l
             on l.ts >= s.bucket_start and l.ts < s.bucket_end
            and ($7::uuid is null or l.channel_id = $7)
     group by s.bucket_start
     order by s.bucket_start asc
    `,
    [from, to, interval, gran, labelFormat, tz, channelFilter]
  )

  return c.json({
    granularity: hourly ? 'hour' : 'day',
    timezone: tz,
    range: { preset: q.range, from, to },
    series: rows.map((row) => ({
      day: row.label,
      requests: num(row.requests),
      tokens: num(row.tokens),
      errors: num(row.errors)
    }))
  })
})
