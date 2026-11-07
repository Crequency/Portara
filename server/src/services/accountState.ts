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
}

function future(value: Date | string | null, now: number): boolean {
  if (!value) return false
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) && ms > now
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
  if (account.quota_exhausted || (skipWindows && account.window_exhausted === true)) {
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
