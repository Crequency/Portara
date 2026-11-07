import { redis } from '../redis.js'
import {
  bucketFullAt,
  bucketKey,
  type RateLimitResult,
  type TokenBucketState
} from './limits.js'

/**
 * 令牌桶限流（每分钟 rpm 个，等价于容量 rpm、每秒补充 rpm/60）。
 *
 * 为什么用 Lua：读取令牌 / 计算补充 / 取走 1 个令牌 / 写回必须是一个原子操作，
 * 否则同一毫秒的并发请求会各自读到「还有 1 个令牌」而全部放行。Redis 串行执行
 * 脚本，天然提供这种原子性；也避免 WATCH/MULTI 重试。
 *
 * 时间来自 Redis 的 TIME 而非客户端 Date.now()：多实例部署时客户端时钟可能漂移，
 * 用 Redis 自己的时钟才能保证所有实例对「经过了多少时间」有一致理解。
 *
 * 状态存 Hash（tokens / ts）而不是两个 string key：一次 HMGET 读全，写回也只动
 * 一个键；PEXPIRE 120 秒 —— 桶从空到满恒需 60 秒，空闲超过 120 秒时键过期、
 * 下次请求按满桶重建，结果与持续保存等价。
 */
const BUCKET_TTL_MS = 120_000

const TOKEN_BUCKET_SCRIPT = `
local capacity = tonumber(ARGV[1])
local ttlMs = tonumber(ARGV[2])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local ratePerMs = capacity / 60000

local vals = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(vals[1])
local last = tonumber(vals[2])
if tokens == nil or last == nil then
  tokens = capacity
  last = now
end

local elapsed = now - last
if elapsed < 0 then elapsed = 0 end

tokens = math.min(capacity, tokens + elapsed * ratePerMs)

local allowed = 0
local waitMs = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  waitMs = math.ceil((1 - tokens) / ratePerMs)
end

redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], ttlMs)

-- Lua 返回数组时数字会被截成整数，所以小数统一用 tostring 传回 Node
return { allowed, tostring(math.floor(tokens)), tostring(waitMs) }
`

/**
 * 消费 1 个令牌。
 *
 * @param keyId   限流主体（API Key id；注册限流用 `register:<ip>`）
 * @param rpmLimit 每分钟请求数；0 = 不限
 * @param now      仅用于不限流分支的 resetAt；桶的判定时间以 Redis TIME 为准
 */
export async function checkRateLimit(
  keyId: string,
  rpmLimit: number,
  now = Date.now()
): Promise<RateLimitResult> {
  const limit = Math.max(0, Math.floor(Number(rpmLimit) || 0))

  // rpm_limit = 0 视为不限流（沿用旧语义，不创建 Redis 键）
  if (limit === 0) {
    return { ok: true, limit: 0, remaining: -1, retryAfterSec: 0, resetAt: now }
  }

  const raw = (await redis.eval(
    TOKEN_BUCKET_SCRIPT,
    1,
    bucketKey(keyId),
    String(limit),
    String(BUCKET_TTL_MS)
  )) as unknown[]

  const ok = String(raw[0]) === '1'
  const remaining = ok ? Math.max(0, Number(raw[1]) || 0) : 0
  const waitMs = Math.max(0, Number(raw[2]) || 0)

  if (!ok) {
    const retryAfterSec = Math.max(1, Math.ceil(waitMs / 1000))
    return {
      ok: false,
      limit,
      remaining: 0,
      retryAfterSec,
      resetAt: now + retryAfterSec * 1000
    }
  }

  /*
   * resetAt 的语义随实现变化：不再是「窗口结束」，而是「桶重新装满」的时刻。
   * /v1 只用 limit / remaining / retryAfterSec，这个字段保留是为了不破坏类型契约。
   */
  const state: TokenBucketState = { tokens: remaining, updatedAt: now }
  return {
    ok: true,
    limit,
    remaining,
    retryAfterSec: 0,
    resetAt: bucketFullAt(state, limit, now)
  }
}

export { bucketFullAt, bucketKey, fullTokenBucket, quotaExceeded, refillTokenBucket, takeToken } from './limits.js'
export type { RateLimitResult, TokenBucketState, TokenTakeResult } from './limits.js'
