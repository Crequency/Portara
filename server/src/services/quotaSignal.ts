/**
 * 「上游明确返回额度用尽」的识别与冷冻阶梯 —— 纯逻辑，不碰数据库/网络。
 *
 * 为什么单独成模块：这段判断直接决定「这个账户要不要被冷冻多久」，
 * 一旦误判就会把还能用的账户踢出选路。判据必须能脱离数据库反复单测，
 * 而且必须**保守** —— 宁可漏判（走普通失败冷却），也不要误判。
 *
 * 判据（两条同时成立）：
 *   ① 状态码是 402 或 429。
 *      403 不收：它更常见于「Key 无权限 / 被风控」，与额度无关；
 *      把它算进来会误伤一类可以继续用的账户。
 *   ② 响应体里出现下面关键词之一（大小写不敏感、子串匹配）。
 *      只收各家**明确表达额度/余额不足**的文案，不收泛化的 "rate limit" ——
 *      限流是瞬时的，该走普通冷却而不是阶梯冷冻。
 */

/** 只有这两个状态码可能表示「钱/额度用完了」 */
const QUOTA_STATUSES = new Set([402, 429])

/**
 * 额度用尽关键词表。
 *
 * 覆盖 OpenAI 系（insufficient_quota / exceeded your current quota）、
 * Anthropic/OpenRouter 系（credit balance is too low）、通用 quota_exceeded、
 * 以及国内厂商常见的中文文案。`billing` 单独留一条：很多网关会把它放在
 * error.code / error.type 里，配合 402/429 才有意义。
 */
export const QUOTA_EXHAUSTED_KEYWORDS: readonly string[] = [
  // OpenAI / Azure OpenAI
  'insufficient_quota',
  'exceeded your current quota',
  'exceeded your quota',
  // 通用英文
  'quota_exceeded',
  'quota exhausted',
  'quota_exhausted',
  'out of credits',
  'insufficient credits',
  'insufficient credit',
  'credit balance is too low',
  'billing',
  // 中文厂商
  '余额不足',
  '额度已用尽',
  '额度不足',
  '额度用完',
  '配额已用完',
  '配额不足',
  '当前请求的额度'
]

/** 最多扫描多少字符：错误体通常很小，截断避免异常大响应拖慢热路径 */
const MAX_SCAN_CHARS = 8192

/**
 * 是否是「上游明确返回额度用尽」。
 *
 * @param status  上游 HTTP 状态码
 * @param bodyText 上游响应体原文（任意长度，内部截断）
 */
export function isQuotaExhaustionResponse(status: number, bodyText: string): boolean {
  if (!QUOTA_STATUSES.has(status)) return false
  const text = String(bodyText ?? '').slice(0, MAX_SCAN_CHARS).toLowerCase()
  if (!text) return false
  return QUOTA_EXHAUSTED_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()))
}

/**
 * 冷冻时长阶梯（秒），第 N 次触发取第 N 项：
 * 1→5m、2→15m、3→45m、4→2h、5→12h、6→24h、7→3d、8 及以后→3d（封顶）。
 *
 * 第 8 次起沿用最后一项，而不是继续指数增长 —— 3 天已经足够
 * 让运营/上游账单周期介入，再长只会让账户“永久失联”。
 */
export const QUOTA_COOLDOWN_LADDER_SEC: readonly number[] = [
  5 * 60,
  15 * 60,
  45 * 60,
  2 * 60 * 60,
  12 * 60 * 60,
  24 * 60 * 60,
  3 * 24 * 60 * 60
]

/** 阶梯封顶对应的触发次数（第 8 次起都是 3d） */
export const QUOTA_COOLDOWN_MAX_LEVEL = QUOTA_COOLDOWN_LADDER_SEC.length + 1

/** 第 N 次触发对应的冷冻秒数；level < 1 按 1 算 */
export function quotaCooldownSecForLevel(level: number): number {
  const n = Math.max(1, Math.floor(Number.isFinite(level) ? level : 1))
  const index = Math.min(n, QUOTA_COOLDOWN_LADDER_SEC.length) - 1
  return QUOTA_COOLDOWN_LADDER_SEC[index]!
}

export interface QuotaCooldownDecision {
  /** true = 本次应递增并重新计时；false = 仍在冷冻期内，保持原样（幂等） */
  applies: boolean
  /** 决策后的等级（applies=false 时就是原等级） */
  level: number
  /** 冷冻剩余（applies=false）或本次新冷冻时长（applies=true），单位秒 */
  secs: number
}

/**
 * 幂等递增判定：冷冻期内重复命中 → 不递增、不延长；
 * 冷冻已过期（或从未冷冻）→ level + 1 并按阶梯重新计时。
 *
 * @param currentLevel 已触发次数（0 = 从未）
 * @param currentUntil 本次冷冻到期时间（null = 从未冷冻）
 * @param now         当前毫秒时间戳
 */
export function decideQuotaCooldown(
  currentLevel: number,
  currentUntil: Date | string | null,
  now: number
): QuotaCooldownDecision {
  const level = Math.max(0, Math.floor(Number.isFinite(currentLevel) ? currentLevel : 0))
  const untilMs = currentUntil ? new Date(currentUntil).getTime() : Number.NaN
  const active = Number.isFinite(untilMs) && untilMs > now
  if (active) {
    return { applies: false, level, secs: Math.max(1, Math.ceil((untilMs - now) / 1000)) }
  }
  const next = level + 1
  return { applies: true, level: next, secs: quotaCooldownSecForLevel(next) }
}

/** 日志用的短时长：5m / 15m / 2h / 3d；不足 1 分钟按秒 */
export function formatQuotaCooldown(secs: number): string {
  const s = Math.max(0, Math.round(secs))
  if (s < 60) return s + 's'
  if (s < 3600) return Math.round(s / 60) + 'm'
  if (s < 86400) {
    const h = Math.floor(s / 3600)
    const m = Math.round((s % 3600) / 60)
    return m > 0 ? h + 'h' + m + 'm' : h + 'h'
  }
  const d = Math.floor(s / 86400)
  const h = Math.round((s % 86400) / 3600)
  return h > 0 ? d + 'd' + h + 'h' : d + 'd'
}
