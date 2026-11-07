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
 *
 * 另外提供两个纯函数：
 *   - parseQuotaResetAt：从响应体（details.reset_at / reset_at）或 Retry-After
 *     头解析上游明确给出的重置时刻；
 *   - quotaCooldownWithReset：把 reset_at 当成**下限**参与阶梯冷冻时长的 max，
 *     最多不超过 3d（与阶梯封顶一致）。
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
  'quota is exhausted',
  'out of credits',
  'insufficient credits',
  'insufficient credit',
  'credit balance is too low',
  'billing',
  /*
   * OpenAI 兼容网关常见的「钱包余额不足」—— 与 insufficient_quota 是
   * 两个不同的 code，只认前者会漏掉 402 + insufficient_balance 这一类。
   */
  'insufficient_balance',
  'wallet balance is insufficient',
  /*
   * 套餐/计划额度（OpenDesign 的 coding plan 就是如此）：
   * 文案里根本不出现 "quota exhausted"，而是 "Coding Plan quota is exhausted"。
   * 同时收下 coding_plan / coding plan / plan quota 三个变体（下划线与空格
   * 都有人用），仍然只在 402/429 上生效。
   */
  'coding_plan',
  'coding plan',
  'plan quota',
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

/**
 * reset_at 参与冷冻时的上限：**3 天**。
 *
 * 取阶梯最后一项而不是另写一个魔数：两者必须一致，否则
 * 「reset_at 给了一年」会把账户冻到天荒地老，运营连人工恢复都等不到。
 */
export const QUOTA_COOLDOWN_CAP_SEC = QUOTA_COOLDOWN_LADDER_SEC[QUOTA_COOLDOWN_LADDER_SEC.length - 1]!

/** 第 N 次触发对应的冷冻秒数；level < 1 按 1 算 */
export function quotaCooldownSecForLevel(level: number): number {
  const n = Math.max(1, Math.floor(Number.isFinite(level) ? level : 1))
  const index = Math.min(n, QUOTA_COOLDOWN_LADDER_SEC.length) - 1
  return QUOTA_COOLDOWN_LADDER_SEC[index]!
}

// ---------------------------------------------------------------- reset_at

/** 上游可能用的重置字段名（下划线/驼峰都有人用） */
const RESET_AT_KEYS = new Set(['reset_at', 'resetat'])

/** JSON 递归查找 reset_at 的最大深度：只做兜底，不做无限下钻 */
const MAX_RESET_JSON_DEPTH = 6

/** 把 reset_at 的值转成毫秒时间戳：ISO 字符串或秒/毫秒数字 */
function resetValueToMs(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null
    // 10 位是秒级时间戳，13 位是毫秒级 —— 两者在真实上游里都出现过
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

/** 在已解析的 JSON 里递归找 reset_at（不依赖它嵌在第几层 details 下） */
function findResetAt(node: unknown, depth: number): number | null {
  if (depth > MAX_RESET_JSON_DEPTH || node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findResetAt(item, depth + 1)
      if (found !== null) return found
    }
    return null
  }
  const record = node as Record<string, unknown>
  for (const [key, value] of Object.entries(record)) {
    if (!RESET_AT_KEYS.has(key.toLowerCase())) continue
    const ms = resetValueToMs(value)
    if (ms !== null) return ms
  }
  for (const value of Object.values(record)) {
    const found = findResetAt(value, depth + 1)
    if (found !== null) return found
  }
  return null
}

/**
 * 解析 Retry-After：秒数（相对）或 HTTP-date（绝对）。
 * 返回毫秒时间戳；解析失败返回 null。
 */
function retryAfterToMs(
  header: string | number | null | undefined,
  now: number
): number | null {
  if (header === null || header === undefined) return null
  if (typeof header === 'number') {
    return Number.isFinite(header) && header > 0 ? now + header * 1000 : null
  }
  const text = header.trim()
  if (!text) return null
  if (/^\d+$/.test(text)) {
    const secs = Number(text)
    return secs > 0 ? now + secs * 1000 : null
  }
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : null
}

/**
 * 上游明确给出的「额度何时恢复」。
 *
 * 优先响应体里的 `reset_at`（有的上游放在 `details.reset_at`，有的放在顶层），
 * 没有才退回 `Retry-After` 头。返回**绝对毫秒时间戳**，取不到 = null。
 *
 * 注意：这里只负责「解析」，不判断是否已过期 —— 过期由 quotaCooldownWithReset
 * 处理（按阶梯兜底），保留单一职责。
 */
export function parseQuotaResetAt(
  bodyText: string,
  retryAfterHeader?: string | number | null,
  now: number = Date.now()
): number | null {
  const text = String(bodyText ?? '').slice(0, MAX_SCAN_CHARS)
  if (text) {
    try {
      const found = findResetAt(JSON.parse(text), 0)
      if (found !== null) return found
    } catch {
      // 非 JSON（或被截断）：退回正则，至少把裸露的 reset_at 字段捞出来
      const match = /"reset_at"\s*:\s*"([^"]+)"/i.exec(text)
      if (match?.[1]) {
        const ms = Date.parse(match[1])
        if (Number.isFinite(ms)) return ms
      }
    }
  }
  return retryAfterToMs(retryAfterHeader, now)
}

/**
 * 本次额度冷冻的秒数：`max(阶梯值, min(reset_at - now, 3d))`。
 *
 * - 阶梯值仍是下限：上游说「1 分钟后就恢复」也不会比第 1 档 5m 更短，
 *   避免同一账户被反复打爆；
 * - reset_at 更远时以它为准（最长 3 天），因为上游已经明确告诉我们
 *   这段时间内都用不了；
 * - reset_at 已过期 / 解析失败 → 完全按阶梯值，不引入额外不确定性。
 */
export function quotaCooldownWithReset(
  level: number,
  resetAt: Date | string | number | null | undefined,
  now: number
): number {
  const ladder = quotaCooldownSecForLevel(level)
  const resetMs =
    resetAt instanceof Date
      ? resetAt.getTime()
      : typeof resetAt === 'number'
        ? resetAt
        : resetAt
          ? Date.parse(resetAt)
          : Number.NaN
  if (!Number.isFinite(resetMs) || resetMs <= now) return ladder
  const fromReset = Math.ceil((resetMs - now) / 1000)
  return Math.max(ladder, Math.min(fromReset, QUOTA_COOLDOWN_CAP_SEC))
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
 * @param resetAt     上游给出的重置时刻（可选；参与 quotaCooldownWithReset）
 */
export function decideQuotaCooldown(
  currentLevel: number,
  currentUntil: Date | string | null,
  now: number,
  resetAt?: Date | string | number | null
): QuotaCooldownDecision {
  const level = Math.max(0, Math.floor(Number.isFinite(currentLevel) ? currentLevel : 0))
  const untilMs = currentUntil ? new Date(currentUntil).getTime() : Number.NaN
  const active = Number.isFinite(untilMs) && untilMs > now
  if (active) {
    return { applies: false, level, secs: Math.max(1, Math.ceil((untilMs - now) / 1000)) }
  }
  const next = level + 1
  return { applies: true, level: next, secs: quotaCooldownWithReset(next, resetAt, now) }
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
