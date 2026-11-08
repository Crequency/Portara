/**
 * 渠道级并发槽位。
 *
 * 语义：**同一渠道（= 同一上游账号池）同时在途的请求数不超过 `maxConcurrency`**。
 *
 * 为什么是渠道而不是账户：并发上限来自上游"会员档位"（例如
 * `membership concurrency limit exceeded: 11/10`），一个档位下的多个账号共享同一个上限，
 * 所以计数必须落在渠道这一层；按账户计会低估总量、照样撞线。
 *
 * 两种模式：
 *   - `limit <= 0`（默认）：**完全不碰 Redis**，零开销，行为与没有这个功能一致；
 *   - `limit > 0`：Redis Lua 原子 INCR + 上限判定，超限立刻 DECR 回退。
 *
 * 槽位带 5 分钟 TTL 兜底：进程崩溃/被 kill 时计数不会永久泄漏（最坏情况是 5 分钟内
 * 略微低估可用并发，之后自动归零）。
 */
import { redis } from '../redis.js'

export interface SlotResult {
  ok: boolean
  /** 申请后（或失败时）的当前在途数 */
  inFlight: number
}

const KEY_TTL_MS = 5 * 60 * 1000

function keyOf(channelId: string): string {
  return `portara:conc:${channelId}`
}

/**
 * 原子申请：INCR 后超过上限就回退。
 *
 * 用 Lua 而不是 INCR + GET + 条件 DECR：三步之间的竞态会让并发数短暂超限，
 * 而这里要挡的正是"超限"本身。
 */
const ACQUIRE_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local n = redis.call('INCR', key)
if n > limit then
  redis.call('DECR', key)
  return {0, n - 1}
end
redis.call('PEXPIRE', key, ttl)
return {1, n}
`

/** 申请一个槽位；limit<=0 时永远成功且不访问 Redis */
export async function acquireChannelSlot(channelId: string, limit: number): Promise<SlotResult> {
  // 与 isSlotAvailable 同一判定口径（0 = 不限），保持一致避免两处走偏
  if (!(limit > 0)) return { ok: true, inFlight: 0 }
  try {
    const raw = (await redis.eval(
      ACQUIRE_LUA,
      1,
      keyOf(channelId),
      String(limit),
      String(KEY_TTL_MS)
    )) as [number | string, number | string]
    const ok = Number(raw?.[0] ?? 0) === 1
    return { ok, inFlight: Number(raw?.[1] ?? 0) }
  } catch {
    /*
     * Redis 不可用：放行。理由与计费预留一致 —— 限流是"锦上添花"的护栏，
     * 不该在缓存故障时把整个网关变成 503。
     */
    return { ok: true, inFlight: 0 }
  }
}

/** 归还槽位（幂等；重复归还不至于把计数带成负数） */
export async function releaseChannelSlot(channelId: string, limit: number): Promise<void> {
  if (!(limit > 0)) return
  try {
    const n = await redis.decr(keyOf(channelId))
    if (n < 0) {
      // 计数被重复释放带负：纠回 0，避免后续请求被"凭空挡住"
      await redis.set(keyOf(channelId), '0', 'PX', 1000)
    }
  } catch {
    /* Redis 挂掉时释放失败：TTL 会在 5 分钟内兜底归零 */
  }
}

/** 当前在途数（面板展示用）；读不到就是 0 */
export async function channelInFlight(channelId: string): Promise<number> {
  try {
    const raw = await redis.get(keyOf(channelId))
    const n = Number(raw ?? 0)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  } catch {
    return 0
  }
}

/**
 * 排队等待上限（毫秒）：所有候选渠道都满时最多等这么久。
 *
 * 数值由调用方从**路由设置**传入 —— 服务层不读 env、也不查库，
 * 这样热路径上不会多一次 I/O，这个模块也能脱离配置独立测试。
 * 传 0（或非法值）= 不排队：满载立刻换路/失败。
 */
export function queueTimeoutMs(configuredMs: number): number {
  return Number.isFinite(configuredMs) && configuredMs > 0 ? Math.floor(configuredMs) : 0
}

/*
 * 纯判定规则放在 concurrencyRules.ts（不引用 Redis），本文件再导出一次，
 * 调用方只认一个入口；单测则直接测那个无 I/O 的模块。
 */
export { QUEUE_POLL_MS, isSlotAvailable, queueBudgetExhausted } from './concurrencyRules.js'
