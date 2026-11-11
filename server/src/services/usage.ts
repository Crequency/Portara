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
  /**
   * 窗口开始时刻（ISO）。
   *
   * 上游给的是「这个窗口从哪一刻起算」—— 与 resetAt 一起才能算出
   * "已经过去多少 / 还剩多少"，排查"5 小时窗口打满但重置还很远"时有决定性作用。
   * 多数适配器没有这个字段，故可选。
   */
  startAt?: string
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
      /*
       * 聚合两个时间的方向**相反**：
       *   resetAt 取最早 —— 最早的"额度恢复"决定这批账户什么时候才有余量；
       *   startAt 取最晚 —— 最晚开始的窗口才覆盖所有账户，用最早的会虚报已用时长。
       */
      if (w.resetAt && (!cur.resetAt || w.resetAt < cur.resetAt)) cur.resetAt = w.resetAt
      if (w.startAt && (!cur.startAt || w.startAt > cur.startAt)) cur.startAt = w.startAt
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

/**
 * 该账户是否有**任意窗口已经打满**。
 *
 * 判定与 `limit_priority` 无关 —— 打满的窗口就是硬上限。
 * 阈值与 `isAccountExhausted` 里的相同（>=95% 视为打满，给上游留出误差空间）。
 */
export function hasExhaustedWindow(s: UsageAccountSnapshot): boolean {
  return s.windows.some(
    (w) =>
      // 推算窗口（inferred）不参与：它是按社区逆向的套餐表算出来的，
      // 不是上游给的硬事实。拿它做「不路由」判据会误杀健康账户 ——
      // 实测踩过：CommandCode 的月窗被推算成 70/70，整条渠道的账户全被跳过。
      !w.inferred &&
      (w.exceeded === true || (w.total > 0 && w.used / w.total >= 0.95))
  )
}

export interface UsageEndpoint {
  key: string
  path: string
  /** 必需端点失败 → 整个快照失败；可选端点失败只记 warning */
  required?: boolean
}

/**
 * 会话型（session-http）适配器的端点。
 *
 * 与 UsageEndpoint 的区别：这里的 url 是**完整地址** —— 没有统一的 base，
 * 网页接口（如 amr-api.open-design.ai）与渠道的推理地址通常不是同一个域。
 */
export interface UsageSessionEndpoint {
  key: string
  url: string
  /** 必需端点失败 → 整个快照失败；可选端点失败只记 warning */
  required?: boolean
  /** 额外的请求头（有些站内接口要求带工作区 id 之类的头） */
  headers?: Record<string, string>
}

export interface UsageAdapter {
  id: string
  label: string
  endpoints: UsageEndpoint[]
  /**
   * 鉴权方式。
   *
   * 'session-cookie' 表示**不用渠道密钥**，而是用账户上单独粘贴的网页登录态
   * （见 services/webSession.ts）—— 有些厂商的余额只有网页会话才读得到。
   */
  auth: 'bearer' | 'x-api-key' | 'none' | 'session-cookie'
  /**
   * 适配器形态。缺省 = 'http'（既有行为，零改动）。
   *
   *   'http'         —— 用账户密钥打 endpoints（相对路径 + base/usage_url 拼接）
   *   'session-http' —— 用解密后的 Cookie 打 sessionEndpoints（完整 URL）
   */
  kind?: 'http' | 'session-http'
  /** 仅 kind='session-http'：完整 URL 的端点列表 */
  sessionEndpoints?: UsageSessionEndpoint[]
  /**
   * 第二轮请求：有些接口要先拿到 id 才能调（例如「工作区 id → 该工作区的用量」）。
   * 入参是第一轮结果；拿不到依赖就返回空数组。
   */
  followUps?: (responses: Record<string, unknown>) => UsageSessionEndpoint[]
  /**
   * endpoints 的相对基准。
   *
   * 缺省 'origin'（scheme + host）—— 既有适配器都是这个语义；
   * 'base' 表示相对**完整 base_url**（含路径）：OpenCode 的 zen go 端点
   * 是 /zen/go/v1/usage，只拼 origin 会打到一个不存在的 /usage。
   */
  baseMode?: 'origin' | 'base'
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

// ---------------------------------------------------------------- OpenCode

/**
 * GET {base}/usage（base = https://opencode.ai/zen/go/v1）
 * {"usage":{"rolling":{"status":"ok","percent":0,"resetsAt":"ISO"},
 *   "weekly":{...},
 *   "monthly":{"status":"rate-limited","percent":100,"resetsAt":"ISO"}}}
 *
 * 注意三点：
 *   ① 上游给的是**百分比**，不是 token 数 —— total 固定 100
 *   ② 端点挂在完整 base 之下（/zen/go/v1/usage），所以 baseMode='base'
 *   ③ status='rate-limited' 或 percent>=100 都算打满，两者不总是同时成立
 */
const OPENCODE_WINDOWS = ['rolling', 'weekly', 'monthly'] as const

const opencode: UsageAdapter = {
  id: 'opencode',
  label: 'OpenCode Zen',
  endpoints: [{ key: 'usage', path: '/usage', required: true }],
  auth: 'bearer',
  baseMode: 'base',
  note: '官方接口，返回滚动 / 周 / 月三个窗口的百分比用量；Base URL 需指向 .../zen/go/v1',
  parse(responses) {
    const d = responses.usage
    if (!isRecord(d)) throw new Error('响应不是对象')
    const usage = isRecord(d.usage) ? d.usage : null
    if (!usage) throw new Error('响应里没有 usage 字段')

    const windows: UsageWindow[] = []
    const warnings: string[] = []
    for (const key of OPENCODE_WINDOWS) {
      const raw = usage[key]
      if (!isRecord(raw)) continue
      const percent = toNum(raw.percent)
      if (percent === null) continue
      const status = typeof raw.status === 'string' ? raw.status : ''
      const exceeded = status === 'rate-limited' || percent >= 100
      windows.push({
        key,
        // 百分比制：used 是「已用百分比」，total 恒为 100
        used: percent,
        total: 100,
        remaining: 100 - percent,
        resetAt: toIso(raw.resetsAt) ?? undefined,
        exceeded
      })
      if (status && status !== 'ok' && !exceeded) {
        warnings.push(`窗口 ${key} 的上游状态为「${status}」（未判为超限）`)
      }
    }
    if (windows.length === 0) {
      throw new Error('响应里没有可解析的用量窗口（rolling / weekly / monthly）')
    }
    return { windows, warnings }
  }
}

// ---------------------------------------------------------------- OpenDesign

/**
 * GET https://amr-api.open-design.ai/api/v1/me —— **只认网页登录态**。
 *
 * API Key 打过去直接 401 unauthenticated（实测），所以用 auth='session-cookie'：
 * Cookie 由管理员在账户详情页粘贴，见 services/webSession.ts。
 *
 * 字段来自前端产物的逆向，没有官方文档：
 *   wallet.balanceUsd          钱包余额（美元）
 *   walletBreakdown[]          { kind, expiresAt } —— 钱包额度批次
 *   designPlanWindows[]        { kind, windowStart, resetsAt, remainingCredits, limitCredits }
 *   plan                       套餐
 *
 * 因此解析一律「缺字段就跳过」，但**一个可用的都没有时抛错**。
 */
const OPENDESIGN_API_ORIGIN = 'https://amr-api.open-design.ai'
const OPENDESIGN_ME_URL = `${OPENDESIGN_API_ORIGIN}/api/v1/me`

/**
 * 从 `/v1/workspaces/current` 的响应里取工作区 id。
 *
 * 该接口可能直接返回工作区对象，也可能包一层 `{workspace: {...}}`；
 * 用量接口的路径需要它，取不到就只能拿到账户信息、没有限额窗口。
 */
function pickWorkspaceId(responses: Record<string, unknown>): string | null {
  const raw = responses.workspaces
  /** 实测字段顺序：current 给 activeWorkspaceId，列表项给 id */
  const idOf = (o: Record<string, unknown>): string | null => {
    for (const k of ['activeWorkspaceId', 'workspaceId', 'id']) {
      const v = o[k]
      if (typeof v === 'string' && v.trim() !== '') return v.trim()
    }
    return null
  }
  if (isRecord(raw)) {
    const direct = idOf(raw)
    if (direct) return direct
    for (const k of ['workspace', 'data', 'current', 'activeWorkspace']) {
      const inner = raw[k]
      if (isRecord(inner)) {
        const hit = idOf(inner)
        if (hit) return hit
      }
    }
    for (const k of ['items', 'workspaces']) {
      const list = raw[k]
      if (Array.isArray(list)) {
        for (const item of list) {
          if (isRecord(item)) {
            const hit = idOf(item)
            if (hit) return hit
          }
        }
      }
    }
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (isRecord(item)) {
        const hit = idOf(item)
        if (hit) return hit
      }
    }
  }
  return null
}

/** 取第一个能转成数字的字段（上游字段名没有文档，多认几个候选） */
function firstNum(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const n = toNum(obj[key])
    if (n !== null) return n
  }
  return null
}

/** 「我」对象本体；有些包装层会塞进 data / user / result 里 */
function pickMeRoot(me: Record<string, unknown>): Record<string, unknown> {
  const looksLikeMe = (v: Record<string, unknown>): boolean =>
    'wallet' in v || 'designPlanWindows' in v || 'walletBreakdown' in v || 'plan' in v
  if (looksLikeMe(me)) return me
  for (const wrapper of ['data', 'user', 'result', 'me']) {
    const inner = me[wrapper]
    if (isRecord(inner) && looksLikeMe(inner)) return inner
  }
  return me
}

const opendesign: UsageAdapter = {
  id: 'opendesign',
  label: 'OpenDesign（网页会话）',
  endpoints: [],
  kind: 'session-http',
  auth: 'session-cookie',
  /*
   * 三个接口，缺一个都看不全：
   *   /v1/me                                → 账户与套餐（plan / balanceUsd）
   *   /v1/workspaces/current                → 工作区 id（用量接口要它）
   *   /v1/workspaces/{id}/billing/coding-plan-usage → 限额窗口（5h / 7d）
   * 注意：**Go 套餐没有月度窗口**，接口给几个窗口就展示几个，不要自己补。
   */
  sessionEndpoints: [
    { key: 'me', url: OPENDESIGN_ME_URL, required: true },
    { key: 'workspaces', url: `${OPENDESIGN_API_ORIGIN}/api/v1/workspaces/current` }
  ],
  followUps(responses) {
    const ws = pickWorkspaceId(responses)
    if (!ws) return []
    return [
      {
        key: 'codingPlanUsage',
        url: `${OPENDESIGN_API_ORIGIN}/api/v1/workspaces/${encodeURIComponent(ws)}/billing/coding-plan-usage`,
        required: true,
        // 官方前端对工作区级接口都要带这个头，否则会当成"没有权限的工作区"
        headers: { 'x-vela-workspace-id': ws }
      }
    ]
  },
  note: '非官方方式：用浏览器登录态读取控制台数据（含 5h / 7d 限额）。会话失效时可用控制台脚本输出的快照兜底。',
  parse(responses) {
    const warnings: string[] = []

    /*
     * 两种输入形状都要吃：
     *   ① 实时抓取：{ me, workspaces, codingPlanUsage }
     *   ② 控制台快照包：{ me: { me, codingPlanUsage, walletBalance } }
     * 统一收敛到 { me, usage, wallet }。
     */
    const wrap = responses.me
    if (!isRecord(wrap)) throw new Error('响应不是对象')
    const me = isRecord(wrap.me) ? wrap.me : pickMeRoot(wrap)
    const usageSrc = isRecord(wrap.codingPlanUsage)
      ? wrap.codingPlanUsage
      : isRecord(responses.codingPlanUsage)
        ? responses.codingPlanUsage
        : null
    const walletSrc = isRecord(wrap.walletBalance)
      ? wrap.walletBalance
      : isRecord(me.wallet)
        ? me.wallet
        : null

    // ---- 余额（USD）----
    // 真实接口给的是字符串，且**可能是负数**（欠费），不要当 0 丢掉
    const balances: UsageBalance[] = []
    const balanceUsd =
      toNum(me.balanceUsd) ??
      (isRecord(me.wallet) ? toNum(me.wallet.balanceUsd) : null) ??
      (walletSrc ? firstNum(walletSrc, ['balanceUsd', 'balance', 'availableUsd']) : null)
    if (balanceUsd !== null) {
      balances.push({ currency: 'USD', unit: 'currency', remaining: balanceUsd })
    }

    // ---- 限额窗口 ----
    // 新接口在 codingPlanUsage.windows；旧形状（社区逆向）在 me.designPlanWindows
    const windows: UsageWindow[] = []
    const rawWindows = usageSrc && Array.isArray(usageSrc.windows)
      ? usageSrc.windows
      : Array.isArray(me.designPlanWindows)
        ? me.designPlanWindows
        : []

    /**
     * 窗口 key 归一化。
     *
     * OpenDesign 的窗口对象**没有 kind 字段**，只有 `durationSeconds`：
     *   18000  → 5 小时窗口
     *   604800 → 7 天窗口（Go 套餐只有这两个，没有月度）
     * 不归一化的话面板只能显示 "window-1 / window-2"，看不出是哪个限额。
     */
    const windowKeyOf = (item: Record<string, unknown>, index: number): string => {
      const kind = typeof item.kind === 'string' && item.kind ? item.kind : ''
      if (kind) return kind
      const sec = toNum(item.durationSeconds)
      if (sec !== null && sec > 0) {
        if (sec === 5 * 3600) return 'fiveHour'
        if (sec === 7 * 86400) return 'weekly'
        if (sec === 86400) return '1d'
        if (sec === 30 * 86400) return '30d'
        if (sec % 86400 === 0) return `${sec / 86400}d`
        if (sec % 3600 === 0) return `${sec / 3600}h`
      }
      return `window-${index + 1}`
    }
    for (const item of rawWindows) {
      if (!isRecord(item)) continue
      const limit = toNum(item.limitCredits)
      const remaining = toNum(item.remainingCredits)
      if (limit === null || remaining === null) continue
      /*
       * used 优先用上游给的 usedCredits（比 limit-remaining 更准：
       * 有的套餐 limit 会随窗口滚动调整），缺了再回退到差值。
       */
      const usedFromUpstream = toNum(item.usedCredits)
      windows.push({
        key: windowKeyOf(item, windows.length),
        used: usedFromUpstream ?? Math.max(0, limit - remaining),
        total: limit,
        remaining,
        resetAt: toIso(item.resetsAt) ?? undefined,
        // 窗口起点：上游字段就叫 windowStart（实测 2026-11-11 的 coding-plan-usage）
        startAt: toIso(item.windowStart) ?? toIso(item.startsAt) ?? undefined,
        exceeded: remaining <= 0
      })
    }
    if (rawWindows.length > 0 && windows.length === 0) {
      warnings.push('coding-plan-usage.windows 里缺少 limitCredits / remainingCredits')
    }
    if (rawWindows.length === 0) {
      warnings.push('接口没有返回限额窗口（该套餐可能没有 coding plan）')
    }

    /*
     * 兜底：只有钱包批次（walletBreakdown）时，按到期时间推算窗口。
     *
     * 这不是实时限额 —— 上游没给窗口对象，只能从"这批额度什么时候过期"倒推。
     * 所以标 `inferred`：面板会显示，但不参与「打满就不路由」的判定。
     */
    const breakdown = Array.isArray(me.walletBreakdown) ? me.walletBreakdown : []
    if (windows.length === 0 && breakdown.length > 0) {
      const usedKeys = new Map<string, number>()
      for (const item of breakdown) {
        if (!isRecord(item)) continue
        const kind = typeof item.kind === 'string' && item.kind ? item.kind : 'wallet'
        const seen = (usedKeys.get(kind) ?? 0) + 1
        usedKeys.set(kind, seen)
        const value = firstNum(item, [
          'remainingUsd',
          'amountUsd',
          'amount',
          'credits',
          'remaining',
          'balanceUsd'
        ])
        windows.push({
          key: seen > 1 ? `wallet:${kind}#${seen}` : `wallet:${kind}`,
          used: 0,
          total: value ?? 0,
          remaining: value ?? 0,
          resetAt: toIso(item.expiresAt) ?? undefined,
          inferred: true
        })
      }
      if (windows.length > 0) {
        warnings.push('上游没有返回套餐窗口，已按钱包批次的到期时间推算（无额度上限）')
      }
    }

    // ---- 套餐 ----
    let plan: UsagePlan | undefined
    if (typeof me.plan === 'string' && me.plan.trim() !== '') {
      plan = { name: me.plan.trim() }
    } else if (isRecord(me.plan)) {
      const p = me.plan
      plan = {
        id: typeof p.id === 'string' ? p.id : undefined,
        name: typeof p.name === 'string' ? p.name : undefined,
        status: typeof p.status === 'string' ? p.status : undefined
      }
      if (!plan.id && !plan.name && !plan.status) plan = undefined
    }

    // 负余额是有意义的信息（欠费），单独提示一句
    if (balanceUsd !== null && balanceUsd < 0) {
      warnings.push(`钱包余额为负（${balanceUsd} USD），上游可能已限制新请求`)
    }

    if (balances.length === 0 && windows.length === 0 && !plan) {
      throw new Error('响应里既没有 balanceUsd，也没有限额窗口与套餐信息')
    }
    return { balances, windows, plan, warnings }
  }
}

// ---------------------------------------------------------------- 注册表

export const USAGE_ADAPTERS: UsageAdapter[] = [
  deepseek,
  moonshot,
  commandcode,
  minimax,
  opencode,
  opendesign
]

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

/**
 * 组装某个端点的完整 URL（`usage_url` 覆盖时按覆盖值 + 端点路径）。
 *
 * baseMode='base' 时用**完整 base**（含路径）而不是 origin —— OpenCode 的
 * 用量端点在 /zen/go/v1/usage 底下，只拼 origin 会打到一个不存在的 /usage。
 * 有 usage_url 覆盖时永远以覆盖值为准（它是显式配置，不该再被推断改写）。
 */
export function endpointUrl(
  baseUrl: string,
  path: string,
  override?: string,
  baseMode: 'origin' | 'base' = 'origin'
): string {
  const base =
    override && override.trim() !== ''
      ? override.trim()
      : baseMode === 'base'
        ? baseUrl.trim()
        : originOf(baseUrl)
  return base.replace(/\/+$/, '') + path
}
