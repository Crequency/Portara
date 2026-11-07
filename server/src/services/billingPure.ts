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
  /** 内置无限套餐：不查余额 / 限额窗口，结算金额恒为 0 */
  unlimited?: boolean
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

/**
 * 是否是「全 0 费率」：输入 / 输出 / 每请求费都为 0。
 *
 * 迁移 022 会插入一条全 0 的全局默认费率，所以「查不到费率」在当前 schema 下
 * 通常表现为「解析到全 0」，而不是 resolveRate 返回 null。健康度与告警都以
 * 这个判定为准，避免只看 id 为 null 而漏报。
 */
export function isZeroRate(
  rate: Pick<RateLike, 'inputPerMtok' | 'outputPerMtok' | 'perRequest'>
): boolean {
  return !(rate.inputPerMtok > 0) && !(rate.outputPerMtok > 0) && !(rate.perRequest > 0)
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

/**
 * 是否为「内置无限套餐」。
 *
 * unlimited 套餐的语义是**完全跳过余额与限额判定**（precheckBilling 直接 ok），
 * 结算时只把成本 / 售价写进 request_logs 供核算，计费金额恒为 0。
 */
export function planIsUnlimited(
  plan: { unlimited?: boolean | null } | null | undefined
): boolean {
  return Boolean(plan?.unlimited)
}

/**
 * 结算应扣金额：unlimited 套餐恒为 0。
 *
 * 注意这里只决定「扣多少钱」，不影响成本 / 售价的计算与落库 ——
 * 调用方仍要按费率算出 costMoney / sellMoney 写进 request_logs。
 */
export function settlementBilledAmount(
  plan: Pick<BillingPlanLike, 'unit' | 'creditsPerCurrency' | 'unlimited'>,
  money: number,
  totalTokens: number
): number {
  if (plan.unlimited) return 0
  return toBilledAmount(money, plan, totalTokens)
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

// ------------------------------------------------------------ 预检预留（防并发透支）

/** 预检预估使用的输入 token 数：请求体通常不告诉网关输入有多长，取一个保守默认 */
export const ESTIMATE_INPUT_TOKENS = 1024

/** 请求体没给 max_tokens 时的默认输出 token 预估 */
export const ESTIMATE_DEFAULT_OUTPUT_TOKENS = 1024

/**
 * 预估本次请求的 token 数：输入固定 1024，输出取 max_tokens（缺失/非法时 1024）。
 *
 * 这是**预留**用的上界估算，不是最终计量 —— 真正的扣费仍以响应里的 usage 为准。
 * 宁可多留一点让并发排队，也不能少留导致穿透。
 */
export function estimateTokens(input: { maxTokens?: unknown }): {
  inputTokens: number
  outputTokens: number
} {
  const raw = Number(input.maxTokens)
  const outputTokens =
    Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : ESTIMATE_DEFAULT_OUTPUT_TOKENS
  return { inputTokens: ESTIMATE_INPUT_TOKENS, outputTokens }
}

/**
 * 预检预留金额：按请求命中的费率与套餐单位估算本次请求的最坏成本。
 *
 * 拿不到具体费率时由调用方传入全局默认（或全 0）费率 —— 纯函数不访问数据库，
 * 保证单测可覆盖；「拿不到费率」的回退在 services/billing.ts 里做。
 */
export function estimateBilledAmount(input: {
  maxTokens?: unknown
  rate: Pick<RateLike, 'inputPerMtok' | 'outputPerMtok' | 'perRequest'>
  plan: Pick<BillingPlanLike, 'unit' | 'creditsPerCurrency'>
}): number {
  const { inputTokens, outputTokens } = estimateTokens({ maxTokens: input.maxTokens })
  const money = computeMoneyCost({ inputTokens, outputTokens, requests: 1 }, input.rate)
  return toBilledAmount(money, input.plan, inputTokens + outputTokens)
}

export interface ReservationSnapshot {
  balance: number
  reserved: number
}

export interface ReservationDecision {
  ok: boolean
  /** balance - reserved，当前真正可用的额度 */
  available: number
  /** 已预留额度（判定前） */
  reserved: number
  /** 判定通过后的预留总额 */
  reservedAfter: number
  /** 判定通过后的可用额度 */
  availableAfter: number
  /** 差多少才够（失败时 > 0） */
  shortfall: number
}

/**
 * 预留判定（纯函数）。Redis 里的 Lua 脚本是它的**原子实现**，两处必须同口径。
 *
 * 规则：
 *   ① available = balance - reserved（预留是「已被别的在途请求占住」的钱）
 *   ② balance > 0 是硬门槛 —— 余额见底时连 0 成本请求也不放行，
 *      与改造前「余额 <= 0 → 402」的语义保持一致
 *   ③ available >= estimate 才允许预留
 *
 * 注意这不是账本扣费：余额只在结算时真正扣，预留只是把并发请求挡在门外。
 */
export function decideReservation(
  snapshot: ReservationSnapshot,
  estimate: number
): ReservationDecision {
  const balance = round6(Number(snapshot.balance) || 0)
  const reserved = Math.max(0, round6(Number(snapshot.reserved) || 0))
  const need = Math.max(0, round6(Number(estimate) || 0))
  const available = round6(balance - reserved)
  const ok = balance > 0 && available >= need
  return {
    ok,
    available,
    reserved,
    reservedAfter: ok ? round6(reserved + need) : reserved,
    availableAfter: ok ? round6(available - need) : available,
    shortfall: ok ? 0 : round6(Math.max(0, need - available))
  }
}

/** 套餐是否可用于计费：未绑定 / 已停用都算「没有套餐」→ no_plan */
export function planAllowsBilling(
  plan: { status?: string | null } | null | undefined
): boolean {
  return Boolean(plan && plan.status === 'active')
}

/** 任一窗口使用率 >= ratio 视为接近上限（默认 90%） */
export function isNearLimit(
  windows: { used: number; limit: number }[],
  ratio = 0.9
): boolean {
  return windows.some((w) => {
    const limit = Number(w.limit)
    const used = Number(w.used)
    return (
      Number.isFinite(limit) &&
      Number.isFinite(used) &&
      limit > 0 &&
      // 浮点除法在边界上会差一个 ulp（0.009/0.01 = 0.899999…），
      // 留 1e-9 的容差，避免「恰好 90%」被判成没到线
      used / limit >= ratio - 1e-9
    )
  })
}

/**
 * 余额告警阈值换算到套餐单位。
 *
 * 环境变量 PORTARA_BILLING_LOW_BALANCE_USD 的语义是「美元阈值」：
 *   money   —— 直接比金额（非 USD 币种也按同一数值，P0 不做汇率换算）
 *   credits —— 按 credits_per_currency 换成积分
 *   tokens  —— 没有金额→token 的换算口径，直接按原始数值比较（文档已注明）
 */
export function lowBalanceThreshold(
  thresholdMoney: number,
  plan: Pick<BillingPlanLike, 'unit' | 'creditsPerCurrency'> | null | undefined
): number {
  const threshold = Number(thresholdMoney)
  if (!Number.isFinite(threshold) || threshold < 0) return 0
  if (plan?.unit === 'credits') {
    return round6(threshold * (Number(plan.creditsPerCurrency) || 0))
  }
  return round6(threshold)
}

/** 余额是否低于告警阈值 */
export function balanceBelow(balance: number, threshold: number): boolean {
  const b = Number(balance)
  const t = Number(threshold)
  if (!Number.isFinite(b) || !Number.isFinite(t)) return false
  return b < t
}
