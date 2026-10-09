import { redis } from '../redis.js'
import {
  currentWindow,
  rateLimitKey,
  retryAfterSeconds,
  windowResetAt,
  type RateLimitResult
} from './limits.js'

export {
  currentWindow,
  quotaExceeded,
  rateLimitKey,
  retryAfterSeconds,
  windowResetAt
} from './limits.js'
export type { RateLimitResult } from './limits.js'

/**
 * 固定窗口限流（每分钟），计数原子性由 Redis INCR 保证。
 *
 * 选固定窗口而非滑动窗口：实现简单、单条 key、无额外内存增长。
 * 代价是窗口边界处最坏情况可放行 2x 配额 —— 原型阶段可接受，
 * 企业级精确限流应换 GCRA/令牌桶（见 roadmap M2）。
 */
export async function checkRateLimit(
  keyId: string,
  rpmLimit: number,
  now = Date.now()
): Promise<RateLimitResult> {
  const limit = Math.max(0, rpmLimit)
  const window = currentWindow(now)
  const resetAt = windowResetAt(window)

  // rpm_limit = 0 视为不限流
  if (limit === 0) {
    return { ok: true, limit: 0, remaining: -1, retryAfterSec: 0, resetAt }
  }

  const rk = rateLimitKey(keyId, window)
  const count = await redis.incr(rk)
  if (count === 1) {
    // 窗口长度 + 缓冲，确保跨窗口不残留
    await redis.expire(rk, 120)
  }

  if (count > limit) {
    return {
      ok: false,
      limit,
      remaining: 0,
      retryAfterSec: retryAfterSeconds(now, resetAt),
      resetAt
    }
  }

  return { ok: true, limit, remaining: limit - count, retryAfterSec: 0, resetAt }
}
