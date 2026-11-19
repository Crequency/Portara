/**
 * 账户活动：最近会话缩略 + 用量消耗详情。
 *
 * 数据来源：`request_logs`（按 account_id 过滤）与 `channel_accounts`（健康状态）。
 * 用途：渠道详情页点某个账户 → 看它最近被路由到了哪些请求、这段时间消耗了多少。
 *
 * 两条纪律：
 *   ① **不回 client_ip** —— 账户详情是给运维看「这个号在干什么」，不是看谁在用；
 *      `apiKeyName` 保留（排查「哪个 key 把这个号打满了」必须要有）。
 *   ② **日粒度按请求方时区分桶** —— 与统计页同一口径，否则同一个账户在两页的
 *      「今日」会对不上。
 */
import { one, query } from '../db.js'

export interface AccountRecentRow {
  id: string
  ts: string
  model: string
  statusCode: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  latencyMs: number
  sessionHash: string
  apiKeyName: string
  error: string
}

export interface AccountTotals {
  requests: number
  errors: number
  tokens: number
}

export interface AccountDailyPoint {
  /** 当地日期 YYYY-MM-DD */
  date: string
  requests: number
  errors: number
  tokens: number
}

export interface AccountActivity {
  recent: AccountRecentRow[]
  h24: AccountTotals
  d7: AccountTotals
  daily: AccountDailyPoint[]
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function totalsOf(row: Record<string, string> | undefined): AccountTotals {
  return {
    requests: num(row?.requests),
    errors: num(row?.errors),
    tokens: num(row?.tokens)
  }
}

/**
 * 读一个账户的活动。
 *
 * @param accountId 账户 id（调用方已校验它属于目标渠道）
 * @param tz 请求方时区（IANA），用于日粒度分桶
 * @param limit 最近会话条数（1..50）
 */
export async function loadAccountActivity(
  accountId: string,
  tz: string,
  limit = 10
): Promise<AccountActivity> {
  const bounded = Math.min(50, Math.max(1, Math.floor(limit)))

  const recentRows = await query<Record<string, string>>(
    `select id::text, to_char(ts, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ts,
            model, status_code::text as status_code,
            coalesce(prompt_tokens, 0)::text as prompt_tokens,
            coalesce(completion_tokens, 0)::text as completion_tokens,
            coalesce(total_tokens, 0)::text as total_tokens,
            coalesce(latency_ms, 0)::text as latency_ms,
            coalesce(session_hash, '') as session_hash,
            coalesce(api_key_name, '') as api_key_name,
            -- 上游失败时 error 是整段响应体（可能是几百字节的 JSON），
            -- 弹窗里只用作「为什么失败」的线索，截断到 200 字符足够，也避免把
            -- 上游的完整报文一路带到浏览器。
            left(coalesce(error, ''), 200) as error
       from request_logs
      where account_id = $1
      order by ts desc
      limit $2`,
    [accountId, bounded]
  )

  /*
   * 24h / 7d 汇总一次扫出来：两个窗口只差 where 条件，分开查等于把同一段索引扫两遍。
   * 用 filter 聚合而不是两次往返。
   */
  const totalsRows = await query<Record<string, string>>(
    `select
       count(*) filter (where ts > now() - interval '24 hours')::text as h24_requests,
       count(*) filter (where ts > now() - interval '24 hours' and status_code >= 400)::text as h24_errors,
       coalesce(sum(total_tokens) filter (where ts > now() - interval '24 hours'), 0)::text as h24_tokens,
       count(*) filter (where ts > now() - interval '7 days')::text as d7_requests,
       count(*) filter (where ts > now() - interval '7 days' and status_code >= 400)::text as d7_errors,
       coalesce(sum(total_tokens) filter (where ts > now() - interval '7 days'), 0)::text as d7_tokens
       from request_logs
      where account_id = $1 and ts > now() - interval '7 days'`,
    [accountId]
  )
  const t = totalsRows[0] ?? {}

  /*
   * 近 7 天（含今天）按**当地日期**分桶。
   * generate_series 保证没有请求的日子也出现在结果里 —— 前端画图不用补洞。
   */
  const dailyRows = await query<Record<string, string>>(
    `with days as (
       select generate_series(
         (date_trunc('day', now() at time zone $2) - interval '6 days'),
         date_trunc('day', now() at time zone $2),
         interval '1 day'
       ) as d
     )
     select to_char(days.d, 'YYYY-MM-DD') as date,
            count(r.id)::text as requests,
            count(r.id) filter (where r.status_code >= 400)::text as errors,
            coalesce(sum(r.total_tokens), 0)::text as tokens
       from days
       left join request_logs r
         on r.account_id = $1
        and date_trunc('day', r.ts at time zone $2) = days.d
      group by days.d
      order by days.d`,
    [accountId, tz]
  )

  return {
    recent: recentRows.map((r) => ({
      id: r.id!,
      ts: r.ts!,
      model: r.model ?? '',
      statusCode: num(r.status_code),
      promptTokens: num(r.prompt_tokens),
      completionTokens: num(r.completion_tokens),
      totalTokens: num(r.total_tokens),
      latencyMs: num(r.latency_ms),
      sessionHash: r.session_hash ?? '',
      apiKeyName: r.api_key_name ?? '',
      error: r.error ?? ''
    })),
    h24: totalsOf({
      requests: t.h24_requests!,
      errors: t.h24_errors!,
      tokens: t.h24_tokens!
    }),
    d7: totalsOf({
      requests: t.d7_requests!,
      errors: t.d7_errors!,
      tokens: t.d7_tokens!
    }),
    daily: dailyRows.map((r) => ({
      date: r.date!,
      requests: num(r.requests),
      errors: num(r.errors),
      tokens: num(r.tokens)
    }))
  }
}

/** 账户是否属于该渠道（路由层用它守住跨渠道越权读取） */
export async function accountBelongsToChannel(
  accountId: string,
  channelId: string
): Promise<boolean> {
  const row = await one<{ id: string }>(
    'select id from channel_accounts where id = $1 and channel_id = $2',
    [accountId, channelId]
  )
  return row !== null
}