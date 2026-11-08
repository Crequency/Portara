/**
 * 渠道并发闸门的**纯判定规则** —— 不碰 Redis、不碰数据库。
 *
 * 单独成模块的原因很实际：`concurrency.ts` 会在模块加载时建立 Redis 连接，
 * 把它整体引入单测会让测试进程挂住不退出；而这几条判定（0 = 不限、
 * 到点即超时）恰恰是"写反就把整站请求挂死"的地方，必须能脱离 I/O 反复测。
 */

/** 排队轮询间隔（毫秒）：太大会让用户干等，太小会自旋打 Redis */
export const QUEUE_POLL_MS = 50

/**
 * 是否还有名额。
 *
 * `limit <= 0` 表示不限 —— 这条规则必须与 acquireChannelSlot 的内联判断一致，
 * 否则「配置成 0 却没放行」只在线上暴露。
 */
export function isSlotAvailable(limit: number, inFlight: number): boolean {
  if (!(limit > 0)) return true
  return inFlight < limit
}

/** 排队是否已经超时 */
export function queueBudgetExhausted(
  startedAt: number,
  now: number,
  timeoutMs: number
): boolean {
  return now - startedAt >= timeoutMs
}
