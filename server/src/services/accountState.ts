/**
 * 账户可用状态分类 —— 纯逻辑，不碰数据库/Redis。
 *
 * 选路要先回答一个问题：「在眼下这一刻，这个账户该排在第几梯队？」
 * 分类顺序**就是优先级**，因为需求要求：
 *   用量限额（quota/window 硬事实） > 额度用尽软冷冻 > 通用失败冷却。
 *
 * 单独成模块的理由和 quotaSignal 一样：这段顺序一旦搞反，表现是
 * 「明明有健康账户，却先打了已经打满窗口的号」，只有脱离 I/O 才能钉住。
 */

export type AccountState = 'usageLimited' | 'quotaCooling' | 'genericCooling' | 'ok'

/** 分类只需要这几个健康字段，避免测试被迫构造整行 DB 记录 */
export interface ClassifiableAccount {
  quota_exhausted: boolean
  window_exhausted: boolean
  quota_cooldown_until: Date | string | null
  cooldown_until: Date | string | null
  /** 上一次「额度快照」判定 quota_exhausted 的时刻 */
  quota_checked_at?: Date | string | null
  /** 上一次「窗口快照」判定 window_exhausted 的时刻 */
  window_checked_at?: Date | string | null
}

/**
 * 用量标记（quota_exhausted / window_exhausted）的**有效期**。
 *
 * 这两个标记来自上一次余额快照，而 http 型渠道的余额快照只在有人打开面板、
 * 或定时自动刷新（默认 10 分钟，且只覆盖会话型渠道）时才会更新。
 * 一旦把它们当成**永久事实**，某次快照说了"打满"，该账户就再也不会被尝试：
 * 实测踩到 —— CommandCode 两个号带着两三天前的标记一直被判定"全池冻结"，
 * 而它们账上明明有余额，客户端于是持续收到 429「所有上游额度已用尽」。
 *
 * 1 小时：足够覆盖自动刷新周期，又能让过期标记自然失效，
 * 由**真实请求**重新裁决（成功了就清标记，失败了会重新冷冻）。
 */
export const USAGE_FLAG_TTL_MS = 60 * 60 * 1000

function future(value: Date | string | null, now: number): boolean {
  if (!value) return false
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) && ms > now
}

/** 标记是否仍然新鲜（在 TTL 内）。没有时间戳 = 不知道 → 视为过期。 */
function fresh(value: Date | string | null | undefined, now: number): boolean {
  if (!value) return false
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) && now - ms <= USAGE_FLAG_TTL_MS
}

/**
 * 「硬限额」事实是否仍然成立。
 *
 * 采信条件：有未到期的额度冷却，或快照是新鲜的（TTL 内）。
 * 其余情况**一律不再采信** —— 过期标记交给真实请求重新裁决。
 *
 * 为什么必须设有效期：quota_exhausted 要等下一次余额快照才会被清除，
 * 而 http 型渠道的快照可能几天不更新。不失效时，一次误判（或充值后）
 * 会把账户永久排除在负载均衡之外，表现就是「明明有上游却一直 429」。
 */
function hardLimited(account: ClassifiableAccount, now: number): boolean {
  if (!account.quota_exhausted) return false
  if (future(account.quota_cooldown_until, now)) return true
  return fresh(account.quota_checked_at, now)
}

/** 窗口打满同理：只有新鲜快照 + 明确的 window_exhausted 才算硬事实 */
function windowLimited(account: ClassifiableAccount, now: number): boolean {
  if (account.window_exhausted !== true) return false
  return fresh(account.window_checked_at, now)
}

/**
 * 给账户分类。**判断顺序即优先级**：
 *
 *   ① usageLimited   —— 硬事实：余额/额度已耗尽，或（开启跳过时）任意窗口打满
 *   ② quotaCooling   —— 上游明确返回额度用尽触发的软冷冻（quota 列）
 *   ③ genericCooling —— 通用失败冷却（cooldown 列）
 *   ④ ok
 *
 * 同一账户同时命中 ① 与 ② 时归入 usageLimited —— 这就是
 * 「用量限额优先于额度用尽返回值冷冻」的落地。
 *
 * @param skipWindows 设置项 skipExhaustedWindows：关闭时不看 window_exhausted
 */
export function classifyAccountState(
  account: ClassifiableAccount,
  now: number,
  skipWindows: boolean
): AccountState {
  if (hardLimited(account, now) || (skipWindows && windowLimited(account, now))) {
    return 'usageLimited'
  }
  if (future(account.quota_cooldown_until, now)) return 'quotaCooling'
  if (future(account.cooldown_until, now)) return 'genericCooling'
  return 'ok'
}

/** 一个账户池的「额度冻结」摘要 */
export interface QuotaFrozenPool {
  /**
   * true = 池子里**没有任何 ok 账户**，且全部处于 usageLimited / quotaCooling。
   *
   * 两种情况都必须成立才为 true：只要还有一个 ok 账户，或有一个
   * genericCooling（通用失败冷却，可能是 5xx 瞬时错误）账户，
   * 就维持既有「退化到池子里最差的账户也不自造 503」的语义。
   */
  allFrozen: boolean
  /** 这些冻结账户里**最早**的额度重置时间（毫秒）；取不到 = null */
  retryAtMs: number | null
}

/**
 * 汇总账户池的额度冻结情况（供 /v1 决定要不要快速 429）。
 *
 * 只认 `quota_cooldown_until` 这一个重置时间来源：
 * usageLimited 往往来自余额/窗口（没有"何时恢复"的答案），
 * 这时 retryAtMs 为 null，调用方就不会短路 —— 保持原有退化行为。
 */
export function summarizeQuotaFrozenPool(
  pool: Array<{ id: string; quota_cooldown_until: Date | string | null }>,
  states: Map<string, AccountState>,
  now: number
): QuotaFrozenPool {
  if (pool.length === 0) return { allFrozen: false, retryAtMs: null }
  let retryAtMs: number | null = null
  for (const account of pool) {
    const state = states.get(account.id) ?? 'ok'
    if (state !== 'usageLimited' && state !== 'quotaCooling') {
      return { allFrozen: false, retryAtMs: null }
    }
    const untilMs = account.quota_cooldown_until
      ? new Date(account.quota_cooldown_until).getTime()
      : Number.NaN
    if (Number.isFinite(untilMs) && untilMs > now) {
      if (retryAtMs === null || untilMs < retryAtMs) retryAtMs = untilMs
    }
  }
  return { allFrozen: true, retryAtMs }
}

/**
 * 退化阶梯：ok → quotaCooling → genericCooling → usageLimited → 全部。
 *
 * 语义：**宁可先用「软冷冻」的账户，也不先用「硬限额」的账户**。
 * 但阶梯最后必须能退化到「全部」—— 永远有账户可尝试是既有不变式，
 * 全部不可用时交给上游裁决，网关自己不造 503。
 *
 * 返回第一个非空的梯队；pool 只在所有梯队都为空时兜底
 * （正常分类下不会发生，保留它表达不动点）。
 */
export function orderByDegradation<T>(
  pool: T[],
  states: Map<string, AccountState>,
  idOf: (account: T) => string
): T[] {
  const buckets: Record<AccountState, T[]> = {
    ok: [],
    quotaCooling: [],
    genericCooling: [],
    usageLimited: []
  }
  for (const account of pool) {
    const state = states.get(idOf(account)) ?? 'ok'
    buckets[state].push(account)
  }
  const ladder: AccountState[] = ['ok', 'quotaCooling', 'genericCooling', 'usageLimited']
  for (const state of ladder) {
    if (buckets[state].length > 0) return buckets[state]
  }
  return pool
}
