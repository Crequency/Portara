/**
 * 自适应选路的**数据侧**：把请求日志与当前并发压力聚合成 AdaptiveStat。
 *
 * 与 adaptive.ts 分开的理由：那边是纯逻辑（好测），这边要连库与 Redis。
 * 结果在内存里缓存几秒 —— 每个请求都跑一次 GROUP BY 会把数据库打热，
 * 而 5 秒的滞后对"选路"完全够用（它本来就不是强一致决策）。
 */
import { query } from '../db.js'
import { channelInFlight } from './concurrency.js'
import type { AdaptiveStat } from './adaptive.js'

/** 缓存 TTL：5 秒。短到能反映抖动，长到不会把 PG 打爆。 */
const CACHE_TTL_MS = 5_000

interface Cached {
  at: number
  windowSec: number
  stats: Map<string, AdaptiveStat>
}

let cache: Cached | null = null

/** 仅供测试/运维：清掉缓存，下一次强制重新聚合 */
export function clearAdaptiveStatsCache(): void {
  cache = null
}

/**
 * 聚合最近 windowSec 秒的请求结果。
 *
 * 取的是 request_logs：channel_id、状态码、延迟都已落库，不需要额外埋点。
 * P95 用 percentile_cont 在库里算，避免把全量行拉回进程。
 */
export async function getAdaptiveStats(windowSec: number): Promise<Map<string, AdaptiveStat>> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS && cache.windowSec === windowSec) {
    return cache.stats
  }

  const sec = Math.max(30, Math.min(3600, Math.round(windowSec)))
  const rows = await query<{
    channel_id: string
    total: string
    errors: string
    p95_ms: string | null
    max_concurrency: number
  }>(
    `select l.channel_id,
            count(*)::text as total,
            sum(case when l.status_code >= 400 then 1 else 0 end)::text as errors,
            percentile_cont(0.95) within group (order by l.latency_ms)::text as p95_ms,
            coalesce(c.max_concurrency, 0) as max_concurrency
       from request_logs l
       join channels c on c.id = l.channel_id
      where l.ts > now() - make_interval(secs => $1)
        and l.channel_id is not null
      group by l.channel_id, c.max_concurrency`,
    [sec]
  )

  const stats = new Map<string, AdaptiveStat>()
  for (const r of rows) {
    stats.set(r.channel_id, {
      total: Number(r.total) || 0,
      errors: Number(r.errors) || 0,
      p95Ms: Number(r.p95_ms) || 0,
      limit: r.max_concurrency ?? 0
    })
  }

  // 补上"此刻在飞"的并发数：历史成功率高的渠道若已满载，也该让位
  await Promise.all(
    [...stats.entries()].map(async ([channelId, stat]) => {
      try {
        stat.inflight = await channelInFlight(channelId)
      } catch {
        // Redis 异常时不影响选路：当作未知
        stat.inflight = undefined
      }
    })
  )

  cache = { at: now, windowSec: sec, stats }
  return stats
}
