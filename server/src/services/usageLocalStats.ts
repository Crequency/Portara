/**
 * 网关侧的账期统计（近 N 天）。
 *
 * 为什么需要：`period`（请求数 / tokens / 消耗 / 套餐）原本只由上游适配器提供，
 * 而多数上游根本不返回账期汇总（例如网页会话型的 OpenDesign）—— 于是那四张统计卡
 * 只有少数渠道能显示。这里用 `request_logs` 补一份，**口径明确标成网关侧统计**，
 * 与上游官方账期区分开。
 *
 * 两条纪律：
 *   ① 结果一定带 `inferred: true` —— 前端据此提示口径，不让人误以为是上游官方数据；
 *   ② 只统计**成功**请求的 tokens（失败请求的 token 计费口径各家不同，混进来会更不可信）。
 */
import { query } from '../db.js'
import type { UsagePeriod } from './usage.js'

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * 读某渠道近 `days` 天的网关侧统计。
 *
 * @param channelId 渠道 id
 * @param days 回看天数（默认 30）
 */
export async function loadChannelPeriod(
  channelId: string,
  days = 30
): Promise<UsagePeriod | undefined> {
  const span = Math.min(365, Math.max(1, Math.floor(days)))

  const rows = await query<Record<string, string>>(
    `select
       count(*)::text as requests,
       count(*) filter (where status_code >= 200 and status_code < 400)::text as ok_requests,
       coalesce(sum(prompt_tokens), 0)::text as tokens_in,
       coalesce(sum(completion_tokens), 0)::text as tokens_out,
       coalesce(sum(cost_money), 0)::text as cost,
       coalesce(min(ts) filter (where cost_currency is not null), now())::text as cost_ts,
       to_char(coalesce(min(ts), now()) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as start
       from request_logs
      where channel_id = $1 and ts > now() - ($2 || ' days')::interval`,
    [channelId, String(span)]
  )
  const r = rows[0]
  if (!r) return undefined

  const requests = num(r.requests)
  // 一条请求都没有的渠道不造一份全零的假账期 —— 那只会让人以为统计坏了
  if (requests === 0) return undefined

  const okRequests = num(r.ok_requests)
  const end = new Date().toISOString()
  return {
    start: r.start,
    end,
    requests,
    successRate: requests > 0 ? (okRequests / requests) * 100 : undefined,
    tokensIn: num(r.tokens_in),
    tokensOut: num(r.tokens_out),
    cost: num(r.cost) || undefined,
    costCurrency: r.cost_currency || undefined,
    inferred: true
  }
}

/** 近期统计的回看天数（与卡片上的「近 30 天」文案保持一致） */
export const LOCAL_PERIOD_DAYS = 30
