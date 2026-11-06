/**
 * 计费的纯函数与类型 —— **不 import db/redis**。
 *
 * 单测直接 import 本模块；真正的查库/缓存逻辑在 services/billing.ts。
 * 这跟 services/limits.ts 的分工一致：纯判定可测，I/O 留到外层。
 */

export type BillingUnit = 'money' | 'credits' | 'tokens'
export type LimitWindow = '5h' | '1d' | '7d' | '30d' | '1w' | '1mo'

/** 窗口的规范顺序：判定与展示都按这个顺序，避免"先查到哪个算哪个" */
export const LIMIT_WINDOWS: readonly LimitWindow[] = [
  '5h',
  '1d',
  '7d',
  '30d',
  '1w',
  '1mo'
]

/** 费率解析结果（渠道 + 上游模型 粒度） */
export interface RateLike {
  id: string | null
  channelId: string | null
  upstreamModel: string
  currency: string
  inputPerMtok: number
  outputPerMtok: number
  perRequest: number
}

export interface BillingPlanLike {
  id: string
  name: string
  unit: BillingUnit
  currency: string
  creditsPerCurrency: number
}

/**
 * 费率优先级：精确（渠道+模型）> 渠道默认（渠道 + 空模型）> 全局默认（空渠道）。
 * 返回 0 表示这条记录与本次解析无关（别的渠道/别的模型）。
 */
export function rateSpecificity(
  rate: Pick<RateLike, 'channelId' | 'upstreamModel'>,
  channelId: string,
  upstreamModel: string
): number {
  if (rate.channelId === null) return 1
  if (rate.channelId !== channelId) return 0
  if (upstreamModel !== '' && rate.upstreamModel === upstreamModel) return 3
  return rate.upstreamModel === '' ? 2 : 0
}

/**
 * 从候选费率中挑最具体的一条。
 * 同分时保留先出现的那条 —— 查询已按 updated_at desc 排序，后改的优先。
 */
export function pickBestRate(
  rates: RateLike[],
  channelId: string,
  upstreamModel: string
): RateLike | null {
  let best: RateLike | null = null
  let bestScore = 0
  for (const rate of rates) {
    const score = rateSpecificity(rate, channelId, upstreamModel)
    if (score > bestScore) {
      best = rate
      bestScore = score
    }
  }
  return best
}

/** 保留 6 位（余额 / 扣费 / 限额单位） */
export function round6(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6
}

/** 保留 8 位（成本金额） */
export function round8(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round((n + Number.EPSILON) * 1e8) / 1e8
}

/**
 * 上游成本（渠道货币）：
 *   input / 1e6 * input_per_mtok + output / 1e6 * output_per_mtok + per_request * requests
 *
 * per_request 按请求数乘：批量场景下每个请求各收一次固定费。
 */
export function computeMoneyCost(
  usage: { inputTokens: number; outputTokens: number; requests?: number },
  rate: Pick<RateLike, 'inputPerMtok' | 'outputPerMtok' | 'perRequest'>
): number {
  const input = Math.max(0, Number(usage.inputTokens) || 0)
  const output = Math.max(0, Number(usage.outputTokens) || 0)
  const requests = Math.max(0, Number(usage.requests ?? 1) || 0)
  const cost =
    (input / 1_000_000) * rate.inputPerMtok +
    (output / 1_000_000) * rate.outputPerMtok +
    rate.perRequest * requests
  return round8(cost)
}

/**
 * 把上游成本换算成「用户套餐单位」的扣费额。
 *
 *   money   —— 直接扣金额
 *   credits —— money × credits_per_currency（1 货币单位换多少积分）
 *   tokens  —— 直接扣本次输入的 input+output total_tokens，与金额无关
 */
export function toBilledAmount(
  money: number,
  plan: Pick<BillingPlanLike, 'unit' | 'creditsPerCurrency'>,
  totalTokens: number
): number {
  switch (plan.unit) {
    case 'credits':
      return round6(Math.max(0, money) * (plan.creditsPerCurrency || 0))
    case 'tokens':
      return round6(Math.max(0, totalTokens))
    case 'money':
    default:
      return round6(Math.max(0, money))
  }
}

/** 本地时区的当天 00:00 */
function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

/**
 * 窗口起点（**服务器本地时区**）。
 *
 *  5h / 7d / 30d —— 滚动窗口（now - N）
 *  1d          —— 当地 00:00
 *  1w          —— 当地本周一 00:00
 *  1mo         —— 当地本月 1 日 00:00
 *
 * 注意 7d 与 1w 是两套口径：前者滚动 7×24h，后者是自然周 ——
 * 同时提供是为了让运营既能做"最近 7 天"又能做"本周"。
 */
export function windowStart(window: LimitWindow, now: Date = new Date()): Date {
  switch (window) {
    case '5h':
      return new Date(now.getTime() - 5 * 60 * 60 * 1000)
    case '7d':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    case '30d':
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    case '1d':
      return startOfLocalDay(now)
    case '1w': {
      const day = now.getDay() // 0 = 周日
      const sinceMonday = (day + 6) % 7
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() - sinceMonday)
    }
    case '1mo':
      return new Date(now.getFullYear(), now.getMonth(), 1)
  }
}

/** 窗口重置时刻（给 429 的 reset 提示用） */
export function windowResetAt(window: LimitWindow, now: Date = new Date()): Date {
  switch (window) {
    case '5h':
      return new Date(windowStart('5h', now).getTime() + 5 * 60 * 60 * 1000)
    case '7d':
      return new Date(windowStart('7d', now).getTime() + 7 * 24 * 60 * 60 * 1000)
    case '30d':
      return new Date(windowStart('30d', now).getTime() + 30 * 24 * 60 * 60 * 1000)
    case '1d': {
      const start = startOfLocalDay(now)
      return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1)
    }
    case '1w':
      return new Date(windowStart('1w', now).getTime() + 7 * 24 * 60 * 60 * 1000)
    case '1mo':
      return new Date(now.getFullYear(), now.getMonth() + 1, 1)
  }
}

/** request_logs 的结算幂等标记：非空 = 已结过账，绝不再扣 */
export interface SettleMarker {
  billingChargedAt: string | Date | null
}

/**
 * 结算的纯决策（供 chargeBilling 与单测共用）。
 *
 * 幂等语义：同一条 request_log 只允许结一次 —— 即使流式回调 / 重试把它
 * 送进来两次，第二次也只能拿到 duplicate。
 */
export function planSettlement(
  marker: SettleMarker,
  billedAmount: number,
  currentBalance: number
): { apply: boolean; duplicate: boolean; delta: number; balanceAfter: number } {
  if (marker.billingChargedAt) {
    return {
      apply: false,
      duplicate: true,
      delta: 0,
      balanceAfter: round6(currentBalance)
    }
  }
  const delta = -round6(Math.max(0, billedAmount))
  return {
    apply: true,
    duplicate: false,
    delta,
    balanceAfter: round6(currentBalance + delta)
  }
}

/** 模板规则合并：同一窗口取最小阈值（叠加、取最严） */
export function mergeRuleThresholds(
  rules: { window: LimitWindow; threshold: number }[]
): { window: LimitWindow; threshold: number; resetAt: Date }[] {
  const best = new Map<LimitWindow, number>()
  for (const rule of rules) {
    const threshold = Number(rule.threshold)
    if (!Number.isFinite(threshold) || threshold <= 0) continue
    const prev = best.get(rule.window)
    if (prev === undefined || threshold < prev) best.set(rule.window, threshold)
  }
  return LIMIT_WINDOWS.filter((w) => best.has(w)).map((w) => ({
    window: w,
    threshold: best.get(w)!,
    resetAt: windowResetAt(w)
  }))
}

/** 判定窗口是否超限：用满即视为超限（与 token 配额口径一致） */
export function windowExceeded(used: number, limit: number): boolean {
  return limit > 0 && Number(used) >= limit
}
