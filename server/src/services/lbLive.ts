/**
 * 「负载均衡实况」的纯计算部分 —— 不碰数据库/Redis。
 *
 * 单独成模块的理由与 accountState 相同：账户状态映射、份额、汇总口径
 * 一旦写反，页面会显示「没有冷却中的账户」却把请求路由到冷却账户。
 * 这些规则必须能脱离 I/O 反复单测。
 */
import {
  classifyAccountState,
  type AccountState,
  type ClassifiableAccount
} from './accountState.js'

/** 实况页面需要的账户字段（来自 channel_accounts + 渠道名） */
export interface LiveAccount extends ClassifiableAccount {
  id: string
  channel_id: string
  name: string
  priority: number
  weight: number
  quota_cooldown_level: number
  quota_cooldown_until: Date | string | null
  cooldown_until: Date | string | null
  quota_exhausted: boolean
  window_exhausted: boolean
}

export interface LiveAccountState {
  state: AccountState
  /**
   * 当前冷却的结束时刻（ISO）；只有 quotaCooling / genericCooling 有值。
   *
   * usageLimited 不填：余额耗尽没有「何时恢复」的答案，窗口打满的重置
   * 由 quota_cooldown_until 表达（若同时处于冷冻则状态会归 quotaCooling 之前
   * 的 usageLimited，此处保持 null 以免把两种口径混成一个时间）。
   */
  coolingUntil: string | null
}

function isoOrNull(value: Date | string | null): string | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** 账户的实况状态 + 当前冷却截止时间 */
export function accountLiveState(
  account: LiveAccount,
  now: number,
  skipWindows: boolean
): LiveAccountState {
  const state = classifyAccountState(account, now, skipWindows)
  const coolingUntil =
    state === 'quotaCooling'
      ? isoOrNull(account.quota_cooldown_until)
      : state === 'genericCooling'
        ? isoOrNull(account.cooldown_until)
        : null
  return { state, coolingUntil }
}

/**
 * 某账户在该别名窗口内的请求占比。
 *
 * 保留 4 位小数：前端展示百分比够用，也避免 0.30000000000000004
 * 这类浮点噪声让「份额总和 ≈ 1」的断言/展示失真。
 */
export function shareOf(requests: number, total: number): number {
  if (!Number.isFinite(requests) || !Number.isFinite(total)) return 0
  if (requests <= 0 || total <= 0) return 0
  return Math.round((requests / total) * 10_000) / 10_000
}

export interface AccountStateCounts {
  /** 处于 quotaCooling / genericCooling 的去重账户数 */
  coolingAccounts: number
  /** 处于 ok 的去重账户数 */
  activeAccounts: number
}

/**
 * 汇总账户状态。
 *
 * **按账户 id 去重**：同一条 alias 的多个目标可能指向同一个渠道，
 * 同一个账户也会出现在多个别名里，页面上的「冷却账户数」应当是
 * 独立的账户数而不是条目数。
 */
export function summarizeAccountStates(
  accounts: ReadonlyArray<{ id: string; state: AccountState }>
): AccountStateCounts {
  const cooling = new Set<string>()
  const active = new Set<string>()
  for (const account of accounts) {
    if (account.state === 'quotaCooling' || account.state === 'genericCooling') {
      cooling.add(account.id)
    } else if (account.state === 'ok') {
      active.add(account.id)
    }
  }
  return { coolingAccounts: cooling.size, activeAccounts: active.size }
}
