/**
 * 余额 / 用量适配器 —— 纯函数，不碰 I/O，便于单测。
 *
 * 背景：**每个厂商的余额接口都没有标准协议**，返回结构、字段命名、
 * 甚至"这个字段到底是已用还是剩余"都各不相同。所以这里为每个厂商
 * 单独写一个解析器，统一归一化成一个快照对象（见 UsageSnapshot）。
 *
 * 所有解析器遵循两条纪律：
 *   ① 解析失败**抛错**，绝不静默给 0 —— 把"拿不到"显示成"余额 0"是最坏的结果
 *   ② 保留 `raw`，因为上游字段语义常有坑，留证据比猜有用
 */

export interface UsageBalance {
  /** 币种；credits 类厂商用 'credits' 并在 unit 里标明 */
  currency: string
  unit: 'currency' | 'credits'
  remaining: number
  total?: number
  granted?: number
  toppedUp?: number
}

export interface UsageWindow {
  key: string
  used: number
  total: number
  remaining: number
  /** 窗口重置时刻（ISO） */
  resetAt?: string
  exceeded?: boolean
  /** 该窗口的上限是**推算**出来的（上游没有这个窗口对象） */
  inferred?: boolean
}

export interface UsagePeriod {
  start?: string
  end?: string
  requests?: number
  /** 0-100 */
  successRate?: number
  tokensIn?: number
  tokensOut?: number
  cost?: number
  costCurrency?: string
}

export interface UsagePlan {
  id?: string
  name?: string
  status?: string
  renewAt?: string
  /** 套餐信息来自社区逆向的映射表，非官方文档 */
  inferred?: boolean
}

/** 单个上游账户的快照（渠道级快照由它们聚合而来） */
export interface UsageAccountSnapshot {
  accountId: string
  accountName: string
  adapter: string
  ok: boolean
  error?: string
  warnings: string[]
  balances: UsageBalance[]
  windows: UsageWindow[]
  period?: UsagePeriod
  plan?: UsagePlan
  raw?: unknown
}

export interface UsageSnapshot {
  channelId: string
  channelName: string
  adapter: string
  ok: boolean
  /** 失败原因（上游原文，便于排查） */
  error?: string
  fetchedAt: string
  /** 本次是命中缓存还是实时拉取 */
  cached: boolean
  /** 刷新失败、返回的是旧缓存 */
  stale?: boolean
  /** 成功但有需要提醒的情况（例如账户无订阅套餐） */
  warnings: string[]
  balances: UsageBalance[]
  windows: UsageWindow[]
  period?: UsagePeriod
  plan?: UsagePlan
  /** 逐账户明细；顶层的 balances/windows 是它们的**聚合值**（向后兼容） */
  accounts: UsageAccountSnapshot[]
  raw?: unknown
  rawTruncated?: boolean
}

/**
 * 把多个账户的快照聚合成渠道级视图。
 *
 * 顶层字段保持原语义（金额余额、额度窗口、账期），只是数值变成"所有账户之和" ——
 * 这样 `/v1/usage` 与概览卡的消费方不必改动。
 *
 * 聚合规则：
 *   - 金额按**币种**求和（不同币种不能相加）
 *   - 窗口按 **key** 求和（used/total 相加，resetAt 取最早，exceeded/inferred 取"任一"）
 *   - 账期：可数项求和；成功率按请求数加权（简单的算术平均会被小账户拖偏）
 *   - 套餐：取第一个非空的（多账户套餐不同时，顶层意义有限，明细里有各自的）
 */
export function aggregateAccountSnapshots(accounts: UsageAccountSnapshot[]): {
  balances: UsageBalance[]
  windows: UsageWindow[]
  period?: UsagePeriod
  plan?: UsagePlan
} {
  const balances = new Map<string, UsageBalance>()
  for (const a of accounts) {
    for (const b of a.balances) {
      const key = `${b.unit}:${b.currency}`
      const cur = balances.get(key)
      if (!cur) {
        balances.set(key, { ...b })
        continue
      }
      cur.remaining += b.remaining
      if (b.total !== undefined) cur.total = (cur.total ?? 0) + b.total
      if (b.granted !== undefined) cur.granted = (cur.granted ?? 0) + b.granted
      if (b.toppedUp !== undefined) cur.toppedUp = (cur.toppedUp ?? 0) + b.toppedUp
    }
  }

  const windows = new Map<string, UsageWindow>()
  for (const a of accounts) {
    for (const w of a.windows) {
      const cur = windows.get(w.key)
      if (!cur) {
        windows.set(w.key, { ...w })
        continue
      }
      cur.used += w.used
      cur.total += w.total
      cur.remaining += w.remaining
      if (w.exceeded) cur.exceeded = true
      if (w.inferred) cur.inferred = true
      if (w.resetAt && (!cur.resetAt || w.resetAt < cur.resetAt)) cur.resetAt = w.resetAt
    }
  }

  const withPeriod = accounts.filter((a) => a.period)
  let period: UsagePeriod | undefined
  if (withPeriod.length > 0) {
    const sum = (pick: (p: UsagePeriod) => number | undefined): number | undefined => {
      const values = withPeriod.map((a) => pick(a.period!)).filter((v): v is number => v !== undefined)
      return values.length > 0 ? values.reduce((x, y) => x + y, 0) : undefined
    }
    const requests = sum((p) => p.requests)
    const rates = withPeriod
      .filter((a) => a.period!.successRate !== undefined)
      .map((a) => ({ rate: a.period!.successRate!, weight: a.period!.requests ?? 1 }))
    const weightSum = rates.reduce((s2, r) => s2 + r.weight, 0)
    period = {
      start: withPeriod.map((a) => a.period!.start).filter(Boolean).sort()[0],
      end: withPeriod.map((a) => a.period!.end).filter(Boolean).sort().at(-1),
      requests,
      successRate:
        rates.length > 0 && weightSum > 0
          ? rates.reduce((s2, r) => s2 + r.rate * r.weight, 0) / weightSum
          : undefined,
      tokensIn: sum((p) => p.tokensIn),
      tokensOut: sum((p) => p.tokensOut),
      cost: sum((p) => p.cost),
      costCurrency: withPeriod[0]!.period!.costCurrency
    }
  }

  return {
    balances: [...balances.values()],
    windows: [...windows.values()],
    period,
    plan: accounts.find((a) => a.plan)?.plan
  }
}

/** 耗尽判定的依据（渠道级配置） */
export type LimitPriority = 'balance' | 'quota'

/**
 * 该账户是否已经"用不了"。
 *
 * 同时有余额与用量窗口的厂商（CommandCode / OpenCode 这类），两套口径并不总是同步：
 * 窗口打满但充值额度还有，或者反之。谁先算"用不了"取决于使用者的策略，所以由渠道配置决定：
 *
 *   `balance`（默认）—— 钱见底才算耗尽。适合"额度窗口只是限速、充值额度才是真钱"的用法
 *   `quota`          —— 窗口打满就换号，即使还有余额。适合"窗口就是套餐额度"的用法
 *
 * 两种口径都**在自己那一维没有数据时退回另一维**，避免"配了 quota 但该厂商没有窗口"
 * 导致永远判定为可用。
 *
 * 判据一律保守：宁可漏标（最多多一次上游往返，随后靠 402/429 进冷却），
 * 也不要误标 —— 误标会让一个还有额度的账户被直接跳过。
 */
export function isAccountExhausted(
  s: UsageAccountSnapshot,
  basis: LimitPriority = 'balance'
): boolean {
  const byBalance = s.balances.length > 0 ? s.balances.every((b) => b.remaining <= 0) : null
  const byQuota =
    s.windows.length > 0
      ? s.windows.some((w) => w.exceeded === true || (w.total > 0 && w.used / w.total >= 0.95))
      : null

  if (basis === 'quota') return byQuota ?? byBalance ?? false
  return byBalance ?? byQuota ?? false
}

export interface UsageEndpoint {
  key: string
  path: string
  /** 必需端点失败 → 整个快照失败；可选端点失败只记 warning */
  required?: boolean
}

export interface UsageAdapter {
  id: string
  label: string
  endpoints: UsageEndpoint[]
  auth: 'bearer' | 'x-api-key' | 'none'
  /** 选择该适配器时界面上的提示 */
  note?: string
  parse(responses: Record<string, unknown>): Partial<UsageSnapshot>
}

// ---------------------------------------------------------------- 工具

/** 字符串或数字 → number（DeepSeek 返回字符串、Moonshot 返回数字） */
export function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * 时间戳 → ISO 字符串。
 * 兼容 epoch 毫秒 / epoch 秒 / ISO 字符串（各厂商写法不一），
 * 0 与空值视为"没有重置点"。
 */
export function toIso(v: unknown): string | null {
  if (v === null || v === undefined || v === '' || v === 0) return null
  if (typeof v === 'number' && Number.isFinite(v)) {
    // 10 位当秒、13 位当毫秒
    const ms = v < 1e11 ? v * 1000 : v
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (typeof v === 'string') {
    const n = Number(v)
    if (v.trim() !== '' && Number.isFinite(n)) return toIso(n)
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  return null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ---------------------------------------------------------------- DeepSeek

/**
 * GET {origin}/user/balance
 * {"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"100.00",
 *  "granted_balance":"0.00","topped_up_balance":"100.00"}]}
 *
 * 注意：金额是**字符串**；balance_infos 是**数组**（可多币种）。
 */
const deepseek: UsageAdapter = {
  id: 'deepseek',
  label: 'DeepSeek',
  endpoints: [{ key: 'balance', path: '/user/balance', required: true }],
  auth: 'bearer',
  note: '官方接口，返回账户余额（可能多币种）',
  parse(responses) {
    const d = responses.balance
    const infos = isRecord(d) && Array.isArray(d.balance_infos) ? d.balance_infos : []
    if (infos.length === 0) throw new Error('响应里没有 balance_infos')

    const balances: UsageBalance[] = []
    for (const raw of infos) {
      if (!isRecord(raw)) continue
      const remaining = toNum(raw.total_balance)
      if (remaining === null) continue
      balances.push({
        currency: typeof raw.currency === 'string' ? raw.currency : 'CNY',
        unit: 'currency',
        remaining,
        granted: toNum(raw.granted_balance) ?? undefined,
        toppedUp: toNum(raw.topped_up_balance) ?? undefined
      })
    }
    if (balances.length === 0) throw new Error('balance_infos 里没有可解析的余额')

    const warnings: string[] = []
    if (isRecord(d) && d.is_available === false) {
      warnings.push('上游标记账户当前不可用（is_available=false）')
    }
    return { balances, warnings }
  }
}

// ---------------------------------------------------------------- Moonshot / Kimi 开放平台

/**
 * GET {origin}/v1/users/me/balance
 * {"code":0,"data":{"available_balance":10.00,"voucher_balance":10.00,"cash_balance":0},
 *  "scode":"0x0","status":true}
 *
 * 注意：数值是 number；cash_balance 可为负（欠费）。
 */
const moonshot: UsageAdapter = {
  id: 'moonshot',
  label: 'Kimi / Moonshot 开放平台',
  endpoints: [{ key: 'balance', path: '/v1/users/me/balance', required: true }],
  auth: 'bearer',
  note: '仅适用于开放平台（api.moonshot.cn / platform.kimi.com）；与订阅制「Kimi Coding」不是一套',
  parse(responses) {
    const d = responses.balance
    if (!isRecord(d)) throw new Error('响应不是对象')
    if (toNum(d.code) !== 0) {
      throw new Error(`上游返回 code=${String(d.code)} ${String(d.scode ?? '')}`.trim())
    }
    const data = isRecord(d.data) ? d.data : {}
    const available = toNum(data.available_balance)
    if (available === null) throw new Error('响应里没有 available_balance')

    const warnings: string[] = []
    const cash = toNum(data.cash_balance)
    if (cash !== null && cash < 0) {
      warnings.push('现金余额为负（欠费），可用余额等于代金券余额')
    }
    if (available <= 0) {
      warnings.push('可用余额小于等于 0，推理 API 会被上游拒绝')
    }

    return {
      balances: [
        {
          currency: 'CNY',
          unit: 'currency',
          remaining: available,
          granted: toNum(data.voucher_balance) ?? undefined,
          toppedUp: cash ?? undefined
        }
      ],
      warnings
    }
  }
}

// ---------------------------------------------------------------- CommandCode

/**
 * 官方**没有**余额 API，以下为社区逆向（来源：
 * https://github.com/MAXeaglet/commandcode-usage/blob/main/README.zh-CN.md）。
 *
 * 四个端点都在 `/alpha/*` 下 —— 注意**不在**渠道 base 的 `/provider/v1` 里，
 * 所以路径要基于 origin 而不是完整 base。
 */
const COMMANDCODE_PLAN_CREDITS: Record<string, number> = {
  'individual-go': 10,
  'individual-goat': 70,
  'individual-pro': 30,
  'individual-pro-v1': 80,
  'individual-provider': 15,
  'individual-max': 150,
  'individual-ultra': 300,
  'teams-pro': 40
}

const commandcode: UsageAdapter = {
  id: 'commandcode',
  label: 'CommandCode',
  endpoints: [
    { key: 'credits', path: '/alpha/billing/credits', required: true },
    { key: 'subscriptions', path: '/alpha/billing/subscriptions' },
    { key: 'summary', path: '/alpha/usage/summary' }
  ],
  auth: 'bearer',
  note: '社区逆向接口，非官方文档；月度额度按套餐推算',
  parse(responses) {
    const credits = responses.credits
    if (!isRecord(credits)) throw new Error('响应不是对象')
    const c = isRecord(credits.credits) ? credits.credits : {}
    const wl = isRecord(credits.windowLimits) ? credits.windowLimits : {}
    const subs = isRecord(responses.subscriptions) && isRecord(responses.subscriptions.data)
      ? responses.subscriptions.data
      : {}
    const summary = isRecord(responses.summary) ? responses.summary : null

    const warnings: string[] = []

    // 剩余额度：月度 + 充值 + 免费（单位是 credits，不是货币）
    const monthlyRemaining = toNum(c.monthlyCredits) ?? 0
    const purchasedRemaining = toNum(c.purchasedCredits) ?? 0
    const freeRemaining = toNum(c.freeCredits) ?? 0
    const balances: UsageBalance[] = [
      {
        currency: 'credits',
        unit: 'credits',
        remaining: monthlyRemaining + purchasedRemaining + freeRemaining,
        granted: freeRemaining,
        toppedUp: purchasedRemaining
      }
    ]

    // 5 小时 / 周窗口：这里的 used **确实是已用**（与 MiniMax 命名相反）
    const windows: UsageWindow[] = []
    for (const [key, raw] of [
      ['fiveHour', wl.fiveHour],
      ['weekly', wl.weekly]
    ] as const) {
      if (!isRecord(raw)) continue
      const total = toNum(raw.cap) ?? 0
      const used = toNum(raw.used) ?? 0
      windows.push({
        key,
        used,
        total,
        remaining: Math.max(0, total - used),
        resetAt: toIso(raw.resetAt) ?? undefined,
        exceeded: raw.exceeded === true
      })
    }

    // 月度窗口：上游**没有**这个对象，上限由套餐映射推算
    const planId = typeof subs.planId === 'string' ? subs.planId : ''
    const cap = planId ? COMMANDCODE_PLAN_CREDITS[planId] : undefined
    if (cap !== undefined) {
      windows.push({
        key: 'monthly',
        used: Math.max(0, cap - monthlyRemaining),
        total: cap,
        remaining: monthlyRemaining,
        resetAt: toIso(subs.currentPeriodEnd) ?? undefined,
        inferred: true
      })
    } else if (planId) {
      warnings.push(`套餐「${planId}」不在已知映射表中，月度上限无法推算`)
    }
    if (wl.limited === true && wl.exceeded !== true) {
      // README 明确：limited 是静态属性，不代表此刻被拦
      warnings.push('账户受窗口限额约束（limited=true），但当前未超限')
    }

    const period: UsagePeriod | undefined = summary
      ? {
          start: toIso(subs.currentPeriodStart) ?? undefined,
          end: toIso(subs.currentPeriodEnd) ?? undefined,
          requests: toNum(summary.totalCount) ?? undefined,
          successRate: toNum(summary.successRate) ?? undefined,
          tokensIn: toNum(summary.totalTokensIn) ?? undefined,
          tokensOut: toNum(summary.totalTokensOut) ?? undefined,
          cost: toNum(summary.totalCost) ?? undefined,
          costCurrency: 'credits'
        }
      : undefined

    const plan: UsagePlan | undefined = planId
      ? {
          id: planId,
          status: typeof subs.status === 'string' ? subs.status : undefined,
          renewAt: toIso(subs.currentPeriodEnd) ?? undefined,
          inferred: true
        }
      : undefined

    return { balances, windows, period, plan, warnings }
  }
}

// ---------------------------------------------------------------- MiniMax

/**
 * GET {origin}/v1/api/openplatform/coding_plan/remains
 * {"model_remains":[{"current_interval_total_count":1500,
 *   "current_interval_usage_count":1500, ...}],
 *  "base_resp":{"status_code":0,"status_msg":"success"}}
 *
 * ⚠️ 字段命名陷阱：`current_*_usage_count` **实际表示「剩余」而不是「已用」**
 * （来源：opencode-bar README），必须按 used = total − remaining 换算。
 *
 * ⚠️ 只对**订阅套餐**账号有数据：按量付费账号返回 status_code 2062
 * "no active token plan subscription"，且按量付费的余额**没有 API**
 * （MiniMax 是 web-only，只能靠 dashboard cookie）。
 */
const minimax: UsageAdapter = {
  id: 'minimax',
  label: 'MiniMax 订阅套餐',
  endpoints: [{ key: 'remains', path: '/v1/api/openplatform/coding_plan/remains', required: true }],
  auth: 'bearer',
  note: '仅「订阅套餐」账号有数据；按量付费账号上游没有余额接口',
  parse(responses) {
    const d = responses.remains
    if (!isRecord(d)) throw new Error('响应不是对象')

    const base = isRecord(d.base_resp) ? d.base_resp : {}
    const code = toNum(base.status_code)
    if (code !== null && code !== 0) {
      const msg = typeof base.status_msg === 'string' ? base.status_msg : ''
      // 2062 是"没有订阅套餐"，属于可预期的业务状态，给出人话
      if (code === 2062) throw new Error('该账号没有生效中的订阅套餐（按量付费账号上游无余额接口）')
      throw new Error(msg || `上游返回 status_code=${code}`)
    }

    const remains = Array.isArray(d.model_remains) ? d.model_remains : []
    if (remains.length === 0) throw new Error('上游没有返回额度数据')

    const windows: UsageWindow[] = []
    for (const m of remains) {
      if (!isRecord(m)) continue
      const name = typeof m.model_name === 'string' ? m.model_name : ''

      const it = toNum(m.current_interval_total_count)
      const ir = toNum(m.current_interval_usage_count)
      if (it !== null && ir !== null) {
        windows.push({
          key: name ? `${name}:interval` : 'interval',
          used: Math.max(0, it - ir),
          total: it,
          remaining: ir,
          resetAt: toIso(m.end_time) ?? undefined
        })
      }

      const wt = toNum(m.current_weekly_total_count)
      const wr = toNum(m.current_weekly_usage_count)
      if (wt !== null && wr !== null) {
        windows.push({
          key: name ? `${name}:weekly` : 'weekly',
          used: Math.max(0, wt - wr),
          total: wt,
          remaining: wr,
          resetAt: toIso(m.weekly_end_time) ?? undefined
        })
      }
    }
    if (windows.length === 0) throw new Error('上游返回的额度字段无法解析')

    return { windows, warnings: [] }
  }
}

// ---------------------------------------------------------------- 注册表

export const USAGE_ADAPTERS: UsageAdapter[] = [deepseek, moonshot, commandcode, minimax]

export const USAGE_ADAPTER_IDS = USAGE_ADAPTERS.map((a) => a.id)

export function getUsageAdapter(id: string): UsageAdapter | null {
  return USAGE_ADAPTERS.find((a) => a.id === id) ?? null
}

/**
 * 由渠道的 base URL 取 origin（scheme + host）。
 *
 * 为什么用 origin 而不是完整 base：Kimi 的 base 是 `.../v1` 而余额端点是
 * `/v1/users/me/balance`，用 base 会拼成 `/v1/v1/...`；
 * CommandCode 的 base 是 `/provider/v1` 而 alpha 端点在根下。用 origin 才都对。
 */
export function originOf(baseUrl: string): string {
  try {
    const u = new URL(baseUrl)
    return u.origin
  } catch {
    return baseUrl.replace(/\/+$/, '')
  }
}

/** 组装某个端点的完整 URL（`usage_url` 覆盖时按覆盖值 + 端点路径） */
export function endpointUrl(
  baseUrl: string,
  path: string,
  override?: string
): string {
  const base = override && override.trim() !== '' ? override.trim() : originOf(baseUrl)
  return base.replace(/\/+$/, '') + path
}
