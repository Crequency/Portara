/**
 * 幂等重试的通用原语。
 *
 * 单独成文件的原因：`usageFetch.ts` 会 import db / redis（持有连接、不退出），
 * 直接引它做单测会让测试进程挂住。这里只放纯逻辑，测试可以放心 import。
 */

/** 让单测能注入"不真的睡"的等待函数（生产用真定时器） */
let sleepImpl: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** 仅供测试：替换/恢复等待实现，避免单测真的等 2 秒 */
export function __setSleepForTests(fn: ((ms: number) => Promise<void>) | null): void {
  sleepImpl = fn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
}

/**
 * 这些状态码值得再试一次。
 *
 * 只看"服务端 / 限流侧"的问题：网络层失败（status 0）另算。
 * **401/403/404 等客户端错误绝不重试** —— 重试只会放大鉴权失败风暴，
 * 有些上游还会因此把来源 IP 拉进风控名单。
 */
export function isRetriableUsageStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500
}

/** 指数退避 + 小抖动：300ms → 600ms → 1200ms…（封顶 3s） */
export function retryDelayMs(attempt: number): number {
  const base = Math.min(3000, 300 * 2 ** Math.max(0, attempt - 1))
  return base + Math.floor(Math.random() * 100)
}

/**
 * 通用幂等重试循环。
 *
 * 语义：
 *   - `retries` = **首次之外**还能重试几次；0 表示只打一次
 *   - 只有 `isFailure` 为真且 `isRetriable` 为真才重试；不可重试立刻返回
 *   - 退避走 `retryDelayMs`（300 → 600 → 1200ms，封顶 3s，带抖动）
 */
export async function runWithRetry<T>(opts: {
  retries: number
  attempt: (attemptNo: number) => Promise<T>
  isFailure: (r: T) => boolean
  isRetriable: (r: T) => boolean
}): Promise<{ result: T; attempts: number }> {
  const maxAttempts = 1 + Math.max(0, opts.retries)
  let attempt = 0
  for (;;) {
    attempt++
    const result = await opts.attempt(attempt)
    if (!opts.isFailure(result)) return { result, attempts: attempt }
    if (!opts.isRetriable(result) || attempt >= maxAttempts) {
      return { result, attempts: attempt }
    }
    await sleepImpl(retryDelayMs(attempt))
  }
}
