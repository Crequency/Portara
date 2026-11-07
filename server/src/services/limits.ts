/**
 * 纯函数限流/配额判定 —— 不依赖 Redis，便于单测。
 *
 * 限流已从「固定窗口」改成「令牌桶」：
 *   capacity = rpm（每分钟请求数），每秒补充 rpm / 60 个令牌，每个请求消费 1 个。
 * 相比固定窗口，窗口边界不会出现「最坏 2× 放行」；代价是状态要保存小数令牌，
 * 真正的原子消费在 ratelimit.ts 里用 Redis Lua 完成。这里的纯函数**必须**与
 * Lua 脚本同口径（同样的补充速率、同样的拒绝判定），单测直接覆盖它们。
 *
 * 桶状态用「上次更新时间 + 当前令牌数」表示 —— 这是惰性补充（lazy refill）：
 * 只有请求到来时才根据 elapsed 计算这期间补了多少，不需要后台定时器。
 */

export interface RateLimitResult {
  ok: boolean
  limit: number
  remaining: number
  retryAfterSec: number
  resetAt: number
}

/** 令牌桶状态：tokens 可以为小数；updatedAt 是上次补充/消费的毫秒时间戳 */
export interface TokenBucketState {
  tokens: number
  updatedAt: number
}

/** 补充窗口：capacity 个令牌用 60 秒补满，即 rpm / 60 每秒（与固定窗口的分钟口径一致） */
export const TOKEN_REFILL_WINDOW_MS = 60_000

/** Redis 键：同一把 Key 共用一个桶；rpm 不进 key，改限额后沿用同一个桶 */
export function bucketKey(keyId: string): string {
  return `portara:rl:${keyId}`
}

/** 新建一个满桶 */
export function fullTokenBucket(capacity: number, now = Date.now()): TokenBucketState {
  return { tokens: Math.max(0, capacity), updatedAt: now }
}

/**
 * 按经过时间惰性补充令牌，上限为容量。
 *
 * 时钟回拨（now < updatedAt）按「没有经过时间」处理，绝不倒扣令牌 ——
 * 多实例时钟漂移时宁可少补一点，也不能让桶凭空扣光。
 */
export function refillTokenBucket(
  state: TokenBucketState,
  capacity: number,
  now = Date.now()
): TokenBucketState {
  const cap = Math.max(0, Number(capacity) || 0)
  if (cap === 0) return { tokens: 0, updatedAt: now }
  const elapsed = Math.max(0, now - state.updatedAt)
  const tokens = Math.min(
    cap,
    Math.max(0, Number(state.tokens) || 0) + (elapsed * cap) / TOKEN_REFILL_WINDOW_MS
  )
  return { tokens, updatedAt: now }
}

export interface TokenTakeResult {
  ok: boolean
  /** 消费后桶里剩余的令牌数；不足时固定为 0 */
  remaining: number
  /** 被拒时：至少需要等几秒才够 1 个令牌（至少 1 秒，避免 0 让客户端立即重试） */
  retryAfterSec: number
  /** 更新后的桶状态；即使被拒也要保存（已经补充的令牌不能丢） */
  state: TokenBucketState
}

/**
 * 尝试取走 1 个令牌。
 *
 * capacity <= 0 表示不限流：一律放行、remaining = -1（与旧接口语义一致）。
 */
export function takeToken(
  state: TokenBucketState,
  capacity: number,
  now = Date.now()
): TokenTakeResult {
  const cap = Math.max(0, Number(capacity) || 0)
  if (cap === 0) {
    return { ok: true, remaining: -1, retryAfterSec: 0, state: { tokens: 0, updatedAt: now } }
  }

  const filled = refillTokenBucket(state, cap, now)
  if (filled.tokens < 1) {
    // 距离攒够 1 个令牌还差 (1 - tokens) 个，按补充速率换算成毫秒
    const waitMs = ((1 - filled.tokens) * TOKEN_REFILL_WINDOW_MS) / cap
    return {
      ok: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)),
      state: filled
    }
  }

  const tokens = filled.tokens - 1
  return {
    ok: true,
    // 加一个极小 epsilon 再 floor：避免 1.9999999999 被算成 1，展示上少一个令牌
    remaining: Math.max(0, Math.floor(tokens + 1e-9)),
    retryAfterSec: 0,
    state: { tokens, updatedAt: now }
  }
}

/** 桶重新装满的时刻（毫秒）；用于 RateLimitResult.resetAt（令牌桶没有固定窗口重置） */
export function bucketFullAt(state: TokenBucketState, capacity: number, now = Date.now()): number {
  const cap = Math.max(0, Number(capacity) || 0)
  if (cap === 0) return now
  const missing = Math.max(0, cap - (Number(state.tokens) || 0))
  if (missing === 0) return now
  return now + Math.ceil((missing * TOKEN_REFILL_WINDOW_MS) / cap)
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
