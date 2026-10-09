/**
 * 纯函数限流/配额判定 —— 不依赖 Redis，便于单测。
 * 真正的原子计数在 ratelimit.ts 里用 Redis 完成。
 */

export interface RateLimitResult {
  ok: boolean
  limit: number
  remaining: number
  retryAfterSec: number
  resetAt: number
}

/** 固定窗口：把时间戳切成分钟序号 */
export function currentWindow(now = Date.now()): number {
  return Math.floor(now / 60_000)
}

export function rateLimitKey(keyId: string, window: number): string {
  return `portara:rl:${keyId}:${window}`
}

/** 窗口结束时刻（毫秒） */
export function windowResetAt(window: number): number {
  return (window + 1) * 60_000
}

/** 距离窗口重置还有几秒（至少 1 秒，避免返回 0 让客户端立刻重试） */
export function retryAfterSeconds(now: number, resetAt: number): number {
  return Math.max(1, Math.ceil((resetAt - now) / 1000))
}

/**
 * 配额预检：只读判断，不预扣。
 * 真正的扣减在请求完成后按实际 usage 进行。
 * quotaTokens = 0 表示不限；**用满即视为超限**（不会再多放一次）。
 */
export function quotaExceeded(
  usedTokens: number,
  quotaTokens: number,
  reserveTokens = 0
): boolean {
  if (quotaTokens <= 0) return false
  return usedTokens + reserveTokens >= quotaTokens
}
