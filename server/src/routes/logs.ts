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
      channelId: r.channel_id,
      channelName: r.channel_name,
      // 哪个上游账户服务的 —— 排查"是不是某个号额度打爆了"的关键字段
      accountId: r.account_id,
      accountName: r.account_name,
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
      // 会话键哈希（前 8 位）—— 用来核对「同一会话是否落在同一渠道」
      sessionHash: r.session_hash,
      error: r.error
    }))
  })
})

/** 时间范围解析：预设走 SQL 的 date_trunc，自定义用前端传入的边界 */
const rangeQuery = z.object({
  range: z.enum(['today', '7d', '30d', '90d', '365d', 'custom']).default('today'),
  from: z.string().optional(),
  to: z.string().optional(),
  /** 可选：只看某个渠道的流量（渠道详情页用） */
  channelId: z.string().optional(),
  /** Top 榜单的排序依据：调用次数 / 已用 token */
  sortBy: z.enum(['requests', 'tokens']).default('requests'),
  /**
   * 可选：只看**当前登录用户自己**名下的 Key 产生的请求（个人资料页用）。
   * '1' = 只算自己；不传 = 全局口径 —— 保持向后兼容，老调用方行为不变。
   */
  mine: z.enum(['0', '1']).optional(),
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
  range: 'today' | '7d' | '30d' | '90d' | '365d' | 'custom',
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
         when '90d'   then (date_trunc('day', now() at time zone $2) - interval '89 days') at time zone $2
         when '365d'  then (date_trunc('day', now() at time zone $2) - interval '364 days') at time zone $2
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

  /**
   * 区间内的「活跃天数」：当地时区下 sum(total_tokens) > 0 的日期个数。
   *
   * 前端要算「日均用量」，但 series 对 90d / 365d 是周 / 半月分桶，
   * 前端根本拿不到「天」。口径是**只统计有正用量的天**（无调用的日子不计入分母），
   * 所以这里按当地日期分组后再筛 having —— 不能用 count(distinct date)，
   * 那会把「有请求但没 token」的日子也算进去。
   */
  const activeDaysRows = await query<Record<string, string>>(
    `select count(*)::text as active_days
       from (
         select date_trunc('day', ts at time zone $4) as d
           from request_logs
          where ts >= $1 and ts <= $2
            and ($3::uuid is null or channel_id = $3)
          group by 1
         having coalesce(sum(total_tokens), 0) > 0
       ) s`,
    [from, to, channelFilter, tz]
  )
  const activeDays = num(activeDaysRows[0]?.active_days)

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
      // 当地时区下 sum(total_tokens) > 0 的天数（「日均用量」的分母）
      activeDays,
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

type SeriesGranularity = 'hour' | 'day' | 'week' | 'halfmonth'

/**
 * 序列分桶口径：
 * - today 按小时；7d/30d 按天；
 * - 90d 按当地周（周一起）；365d 按半月（每月 1 日、16 日起）；
 * - custom 保持原来的「跨度 ≤48h 按小时，否则按天」。
 */
function resolveSeriesPlan(
  range: 'today' | '7d' | '30d' | '90d' | '365d' | 'custom',
  spanHours: number
): { granularity: SeriesGranularity; interval: string; labelFormat: string } {
  switch (range) {
    case 'today':
      return { granularity: 'hour', interval: '1 hour', labelFormat: 'MM-DD HH24:00' }
    case '7d':
    case '30d':
      return { granularity: 'day', interval: '1 day', labelFormat: 'MM-DD' }
    case '90d':
      return { granularity: 'week', interval: '7 days', labelFormat: 'MM-DD' }
    case '365d':
      return { granularity: 'halfmonth', interval: '1 month', labelFormat: 'MM-DD' }
    case 'custom':
      return spanHours <= 48
        ? { granularity: 'hour', interval: '1 hour', labelFormat: 'MM-DD HH24:00' }
        : { granularity: 'day', interval: '1 day', labelFormat: 'MM-DD' }
  }
}

logRoutes.get('/stats/series', async (c) => {
  const q = parseQuery(c, rangeQuery)
  const tz = await resolveQueryTimeZone(q.tz)
  const { from, to } = await resolveBounds(q.range, tz, q.from, q.to)
  const channelFilter = q.channelId && UUID_RE.test(q.channelId) ? q.channelId : null

  /*
   * 「只看自己」：个人资料页的用量趋势只统计当前用户名下 API Key 的流量。
   *
   * 用户 id 来自 requireAuth 写入的 c.get('user') —— 本路由挂在
   * `logRoutes.use('*', requireAuth)` 之下，未登录在中间件层就 401 了，
   * 走到这里一定已登录。mine 不传（或 '0'）时为 null，SQL 退回全局口径。
   *
   * 过滤条件写成 `$n::uuid is null or ...`，这样参数个数与 SQL 形状
   * 不随 mine 变化 —— 两种口径走的是同一条查询，分桶逻辑零改动。
   */
  const mineUserId = q.mine === '1' ? c.get('user').id : null

  const spanHours = (new Date(to).getTime() - new Date(from).getTime()) / 3_600_000
  const plan = resolveSeriesPlan(q.range, spanHours)

  /*
   * 分桶仍然在**目标时区**的当地墙钟上生成：先把起止换算成当地墙钟、
   * 按当地周/月对齐，再逐个转回 timestamptz。桶的结束取下一个桶的开始
   * （而不是机械 +24h），这样夏令时切换那天（23/25 小时）也切得准。
   *
   * 所有 join 都裁剪到 [from, to]：周桶首桶可能早于 from，半月桶的
   * 首尾桶也可能越界，不裁剪会把范围外的请求算进来。
   */
  let rows: { label: string; requests: number; tokens: string; errors: number }[]

  if (plan.granularity === 'halfmonth') {
    // 每月 1 日与 16 日各起一桶：月起点序列 ∪ 月起点 + 15 天，再排序去重；
    // 只保留落在 [from, to] 内的边界（首尾不足半月的区间不单独成桶）。
    rows = await query(
      `
      with month_starts as (
        select generate_series(
          date_trunc('month', ($1::timestamptz at time zone $4)),
          date_trunc('month', ($2::timestamptz at time zone $4)),
          interval '1 month'
        ) as m
      ),
      candidates as (
        select m as b from month_starts
        union
        select m + interval '15 days' as b from month_starts
      ),
      bucket_starts as (
        select (b at time zone $4) as bucket_start
          from candidates
         where b >= ($1::timestamptz at time zone $4)
           and b <= ($2::timestamptz at time zone $4)
      ),
      spans as (
        select bucket_start,
               coalesce(
                 lead(bucket_start) over (order by bucket_start),
                 bucket_start + interval '1 month'
               ) as bucket_end
          from bucket_starts
      )
      select to_char(s.bucket_start at time zone $4, $3) as label,
             coalesce(count(l.id), 0)::int as requests,
             coalesce(sum(l.total_tokens), 0)::text as tokens,
             coalesce(count(l.id) filter (where l.status_code >= 400), 0)::int as errors
        from spans s
        left join request_logs l
               on l.ts >= greatest(s.bucket_start, $1::timestamptz)
              and l.ts <  least(s.bucket_end, $2::timestamptz)
              and ($5::uuid is null or l.channel_id = $5)
              and ($6::uuid is null or l.api_key_id in (
                    select k.id from api_keys k where k.user_id = $6
                  ))
       group by s.bucket_start
       order by s.bucket_start asc
      `,
      [from, to, plan.labelFormat, tz, channelFilter, mineUserId]
    )
  } else {
    rows = await query(
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
               on l.ts >= greatest(s.bucket_start, $1::timestamptz)
              and l.ts <  least(s.bucket_end, $2::timestamptz)
              and ($7::uuid is null or l.channel_id = $7)
              and ($8::uuid is null or l.api_key_id in (
                    select k.id from api_keys k where k.user_id = $8
                  ))
       group by s.bucket_start
       order by s.bucket_start asc
      `,
      [from, to, plan.interval, plan.granularity, plan.labelFormat, tz, channelFilter, mineUserId]
    )
  }

  return c.json({
    granularity: plan.granularity,
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

/* ------------------------------------------------------------------ */
/* 使用频率二维热力图                                                   */
/* ------------------------------------------------------------------ */

type HeatmapGridProfile = 'today' | '7d' | '30d' | '90d'

/**
 * 每个档位先把范围按「最小粒度」切成一维桶，再在 TS 里 fold 成二维矩阵。
 * - today：1 分钟 × 1440 → 96 列 × 15 行（列=刻钟，行=刻钟内第几分钟）
 * - 7d：10 分钟 × 1008 → 84 列 × 12 行（列=天×时辰，行=时辰内第几个十分钟）
 * - 30d：30 分钟 × 天数×48 → 天数×3 列 × 16 行（列=每天三个「午」）
 * - 90d：2 小时 × 天数×12 → 天数 列 × 12 行（列=天，行=时辰）
 * - 365d：1 天 → GitHub 贡献墙（列=周，行=周一..周日）
 */
interface HeatmapPlan {
  mode: 'grid' | 'calendar'
  profile: HeatmapGridProfile | 'calendar'
  bucketCount: number
  /** SQL interval：最小桶宽度 */
  interval: string
  /** SQL interval：相对当地 00:00 的起点偏移（30d 的「午」从 04:00 起算） */
  startOffset: string
  /** 覆盖的当地天数（网格档用于算列数 / 日期标签） */
  dayCount: number
}

interface HeatmapBucketRow {
  idx: number
  requests: number
  tokens: string
  errors: number
}

interface HeatmapCell {
  requests: number
  tokens: number
  errors: number
}

const HEATMAP_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
]
const HEATMAP_WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 某个 UTC 瞬时在目标时区的当地日期 */
function localDateParts(iso: string, timeZone: string): {
  year: number
  month: number
  day: number
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
    .formatToParts(new Date(iso))
    .map((p) => [p.type, p.value])
  const get = (type: string): number => Number(parts.find(([t]) => t === type)?.[1] ?? '0')
  return { year: get('year'), month: get('month'), day: get('day') }
}

/** 当地日历日的整数序号（以 UTC 日期做纯日历运算，不受时区影响） */
const dayNumber = (p: { year: number; month: number; day: number }): number =>
  Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86_400_000)

/** 序号 → 当地日期 */
function datePartsOfDay(day: number): { year: number; month: number; day: number } {
  const d = new Date(day * 86_400_000)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/** 周一=0 … 周日=6（ISO 周） */
const weekdayIndexMonday = (day: number): number =>
  (new Date(day * 86_400_000).getUTCDay() + 6) % 7

const monthDayLabel = (day: number): string => {
  const p = datePartsOfDay(day)
  return `${pad2(p.month)}-${pad2(p.day)}`
}

function resolveHeatmapPlan(
  range: 'today' | '7d' | '30d' | '90d' | '365d' | 'custom',
  spanHours: number,
  spanDays: number
): HeatmapPlan {
  const gridPlan = (profile: HeatmapGridProfile): HeatmapPlan => {
    if (profile === 'today') {
      // 今日档固定一整天：00:00–24:00，未来为 0
      return {
        mode: 'grid',
        profile,
        bucketCount: 1440,
        interval: '1 minute',
        startOffset: '0',
        dayCount: 1
      }
    }
    if (profile === '7d') {
      return {
        mode: 'grid',
        profile,
        bucketCount: spanDays * 144,
        interval: '10 minutes',
        startOffset: '0',
        dayCount: spanDays
      }
    }
    if (profile === '30d') {
      return {
        mode: 'grid',
        profile,
        // 每天 48 个半小时桶，但起点是当地 04:00（当天 00:00–04:00 归前一天）
        bucketCount: spanDays * 48,
        interval: '30 minutes',
        startOffset: '4 hours',
        dayCount: spanDays
      }
    }
    return {
      mode: 'grid',
      profile: '90d',
      bucketCount: spanDays * 12,
      interval: '2 hours',
      startOffset: '0',
      dayCount: spanDays
    }
  }

  if (range === 'custom') {
    if (spanHours <= 26) return gridPlan('today')
    if (spanHours <= 8 * 24) return gridPlan('7d')
    if (spanHours <= 31 * 24) return gridPlan('30d')
    if (spanHours <= 92 * 24) return gridPlan('90d')
    return {
      mode: 'calendar',
      profile: 'calendar',
      bucketCount: spanDays,
      interval: '1 day',
      startOffset: '0',
      dayCount: spanDays
    }
  }

  switch (range) {
    case 'today':
      return gridPlan('today')
    case '7d':
      return gridPlan('7d')
    case '30d':
      return gridPlan('30d')
    case '90d':
      return gridPlan('90d')
    case '365d':
      return {
        mode: 'calendar',
        profile: 'calendar',
        bucketCount: 365,
        interval: '1 day',
        startOffset: '0',
        dayCount: 365
      }
  }
}

/** 一维桶序号 → 二维单元格坐标 */
function foldHeatmapBucket(
  plan: HeatmapPlan,
  idx: number,
  fromDay: number
): { row: number; col: number } {
  switch (plan.profile) {
    case 'today': {
      // idx = 当天第几分钟；列 = 第几个刻钟，行 = 刻钟内第几分钟
      return { row: idx % 15, col: Math.floor(idx / 15) }
    }
    case '7d': {
      const day = Math.floor(idx / 144)
      const slot = idx % 144
      return { row: slot % 12, col: day * 12 + Math.floor(slot / 12) }
    }
    case '30d': {
      const day = Math.floor(idx / 48)
      const slot = idx % 48
      return { row: slot % 16, col: day * 3 + Math.floor(slot / 16) }
    }
    case '90d': {
      return { row: idx % 12, col: Math.floor(idx / 12) }
    }
    case 'calendar': {
      // 第一列第一行必须是周一：把范围起点前面空出的几天算进偏移
      const pos = idx + weekdayIndexMonday(fromDay)
      return { row: pos % 7, col: Math.floor(pos / 7) }
    }
  }
}

function buildHeatmapLabels(
  plan: HeatmapPlan,
  fromDay: number,
  cols: number
): { xLabels: string[]; yLabels: string[]; monthLabels?: { col: number; label: string }[]; weekdayLabels?: string[] } {
  if (plan.mode === 'calendar') {
    /*
     * 月份标签：范围里第一次出现某个月时，在它所在的列标一次；
     * 同一列只标一个。365d 恰好跨 13 个「月份出现」（如今年 11 月
     * 与去年 11 月都在范围内），因此标签数可能是 13 而不是 12。
     */
    const monthLabels: { col: number; label: string }[] = []
    let lastMonth = -1
    let lastCol = -1
    for (let idx = 0; idx < plan.bucketCount; idx++) {
      const month = datePartsOfDay(fromDay + idx).month
      if (month === lastMonth) continue
      lastMonth = month
      const { col } = foldHeatmapBucket(plan, idx, fromDay)
      if (col !== lastCol) {
        monthLabels.push({ col, label: HEATMAP_MONTHS[month - 1]! })
        lastCol = col
      }
    }
    return {
      xLabels: [],
      yLabels: [...HEATMAP_WEEKDAYS],
      monthLabels,
      weekdayLabels: [...HEATMAP_WEEKDAYS]
    }
  }

  const xLabels = Array.from({ length: cols }, () => '')
  const yLabels = Array.from({ length: plan.profile === 'today' ? 15 : plan.profile === '30d' ? 16 : 12 }, () => '')

  if (plan.profile === 'today') {
    // 96 列 = 每 15 分钟一列；每 24 列（6 小时）标一个整点
    for (let col = 0; col < cols; col += 24) {
      xLabels[col] = `${pad2(col / 4)}:00`
    }
    for (let row = 0; row < 15; row += 3) yLabels[row] = String(row + 1)
  } else if (plan.profile === '7d') {
    for (let col = 0; col < cols; col += 12) {
      xLabels[col] = monthDayLabel(fromDay + col / 12)
    }
    for (let row = 0; row < 12; row += 3) yLabels[row] = String(row * 10)
  } else if (plan.profile === '30d') {
    for (let col = 0; col < cols; col += 3) {
      xLabels[col] = monthDayLabel(fromDay + col / 3)
    }
    for (let row = 0; row < 16; row += 4) yLabels[row] = `${Math.floor(row / 2)}:00`
  } else {
    for (let col = 0; col < cols; col += 7) {
      xLabels[col] = monthDayLabel(fromDay + col)
    }
    for (let row = 0; row < 12; row += 3) yLabels[row] = pad2(row * 2)
  }

  return { xLabels, yLabels }
}

logRoutes.get('/stats/heatmap', async (c) => {
  const q = parseQuery(c, rangeQuery)
  const tz = await resolveQueryTimeZone(q.tz)
  const { from, to } = await resolveBounds(q.range, tz, q.from, q.to)
  const channelFilter = q.channelId && UUID_RE.test(q.channelId) ? q.channelId : null

  /** 「只看自己」——口径与 /stats/series 完全一致（见那里的注释） */
  const mineUserId = q.mine === '1' ? c.get('user').id : null

  const spanHours = (new Date(to).getTime() - new Date(from).getTime()) / 3_600_000
  const fromDay = dayNumber(localDateParts(from, tz))
  const toDay = dayNumber(localDateParts(to, tz))
  const spanDays = Math.max(1, toDay - fromDay + 1)
  const plan = resolveHeatmapPlan(q.range, spanHours, spanDays)

  /*
   * 一维最小桶：起点是目标时区的当地 00:00（30d 档为当地 04:00），
   * 桶数固定 / 按天数算，未来时间自然落进 0 值桶。
   * 桶结束取下一个桶开始，首尾 join 都裁剪到 [from, to]。
   * 用 ordinality 带出 idx：夏令时回拨造成两个墙钟时间落到同一瞬时，
   * 也不会因为 group by bucket_start 把两个桶并掉。
   */
  const rows = await query<HeatmapBucketRow>(
    `
    with bounds as (
      select date_trunc('day', ($1::timestamptz at time zone $2)) as day_start
    ),
    bucket_starts as (
      select g.ord as idx,
             (g.b at time zone $2) as bucket_start
        from bounds,
             generate_series(
               day_start + $3::interval,
               day_start + $3::interval + ($4::int - 1) * $5::interval,
               $5::interval
             ) with ordinality as g(b, ord)
    ),
    spans as (
      select idx,
             bucket_start,
             coalesce(
               lead(bucket_start) over (order by idx),
               bucket_start + $5::interval
             ) as bucket_end
        from bucket_starts
    )
    select s.idx as idx,
           coalesce(count(l.id), 0)::int as requests,
           coalesce(sum(l.total_tokens), 0)::text as tokens,
           coalesce(count(l.id) filter (where l.status_code >= 400), 0)::int as errors
      from spans s
      left join request_logs l
             on l.ts >= greatest(s.bucket_start, $1::timestamptz)
            and l.ts <  least(s.bucket_end, $6::timestamptz)
            and ($7::uuid is null or l.channel_id = $7)
            and ($8::uuid is null or l.api_key_id in (
                  select k.id from api_keys k where k.user_id = $8
                ))
     group by s.idx, s.bucket_start
     order by s.idx asc
    `,
    [from, tz, plan.startOffset, plan.bucketCount, plan.interval, to, channelFilter, mineUserId]
  )

  const cols =
    plan.mode === 'calendar'
      ? Math.ceil((plan.bucketCount + weekdayIndexMonday(fromDay)) / 7)
      : plan.profile === 'today'
        ? 96
        : plan.profile === '7d'
          ? plan.dayCount * 12
          : plan.profile === '30d'
            ? plan.dayCount * 3
            : plan.dayCount
  const rowCount = plan.mode === 'calendar' ? 7 : plan.profile === 'today' ? 15 : plan.profile === '30d' ? 16 : 12

  const cells: HeatmapCell[][] = Array.from({ length: rowCount }, () =>
    Array.from({ length: cols }, () => ({ requests: 0, tokens: 0, errors: 0 }))
  )

  for (const row of rows) {
    const idx = Number(row.idx) - 1
    if (idx < 0 || idx >= plan.bucketCount) continue
    const { row: y, col: x } = foldHeatmapBucket(plan, idx, fromDay)
    if (y < 0 || y >= rowCount || x < 0 || x >= cols) continue
    const cell = cells[y]![x]!
    cell.requests += num(row.requests)
    cell.tokens += num(row.tokens)
    cell.errors += num(row.errors)
  }

  const labels = buildHeatmapLabels(plan, fromDay, cols)

  return c.json({
    timezone: tz,
    range: { preset: q.range, from, to },
    mode: plan.mode,
    cols,
    rows: rowCount,
    xLabels: labels.xLabels,
    yLabels: labels.yLabels,
    cells,
    ...(plan.mode === 'calendar'
      ? {
          monthLabels: labels.monthLabels,
          weekdayLabels: labels.weekdayLabels
        }
      : {})
  })
})

