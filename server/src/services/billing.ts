import { one, pool, query } from '../db.js'
import { redis } from '../redis.js'
import {
  computeMoneyCost,
  estimateBilledAmount,
  isZeroRate,
  LIMIT_WINDOWS,
  mergeRuleThresholds,
  pickBestRate,
  planAllowsBilling,
  round6,
  round8,
  toBilledAmount,
  windowExceeded,
  windowResetAt,
  windowStart,
  type BillingPlanLike,
  type BillingUnit,
  type LimitWindow,
  type RateLike
} from './billingPure.js'

/**
 * 计费服务：费率解析 / 成本换算 / 预检 / 扣费 / 余额调整。
 *
 * 纯函数都在 billingPure.ts —— 这里只做 I/O，便于单测不碰 Redis/DB。
 *
 * 几个刻意的选择：
 *  1. **费率缓存用版本号而非 del**：key 里带 `portara:billing:rates:version`，
 *     管理员改费率时 incr 版本，旧 key 30 秒自然过期。不用 KEYS 扫库，
 *     也不用维护"某渠道下所有模型的 key 集合"。
 *  2. **预检只缓存成功结果**（15 秒）：失败必须实时，否则充值后还要等缓存过期。
 *     扣费/改套餐/调余额都会主动 del 该用户的预检 key。
 *  3. **扣费幂等靠 request_logs.billing_charged_at**：条件 UPDATE 是唯一的
 *     结算闸门，余额扣减与流水在同一事务内，重复进入只会拿到 duplicate。
 */

const RATE_VERSION_KEY = 'portara:billing:rates:version'
const RATE_TTL_SECONDS = 30
const PRECHECK_TTL_SECONDS = 15

/**
 * 预检预留：
 *   - 每个用户一个浮点聚合键（INCRBYFLOAT / DECRBYFLOAT），由 Lua 保证「判定 + 累加」原子；
 *   - TTL 300 秒兜底 —— 进程崩溃 / 结算回调丢失时，预留不会永久占住余额；
 *   - 结算方从 chargeBilling 拿实际金额，预留在 finally 里释放（只释放一次）。
 */
const RESERVED_KEY_PREFIX = 'portara:billing:reserved:'
const RESERVED_TTL_SECONDS = 300

/**
 * 「解析到全 0 费率」告警去重。
 *
 * 粒度：渠道 + 上游模型（全局默认单独用 'global'）。通常全 0 是「渠道没配费率」
 * 或「全局默认仍是迁移里的 0」，同一组合会反复命中；如果每条请求都打日志，
 * 一次流量高峰就能把日志刷满，所以按组合去重，默认 1 小时内只 warn 一次。
 *
 * 去重表放在进程内 Map：热路径上不额外往返 Redis（告警本身只是可观测性，
 * 多实例部署时每个实例各打一次可以接受），并且 Redis 挂掉时告警仍然有效。
 * 表有上限，超限先清过期项、仍超限则整体清空 —— 宁可多一条日志，也不无限增长。
 */
const ZERO_RATE_WARN_TTL_MS = 60 * 60 * 1000
const ZERO_RATE_WARN_MAP_LIMIT = 1000
const zeroRateWarnedAt = new Map<string, number>()

function warnZeroRateOnce(scope: string, payload: Record<string, unknown>): void {
  const now = Date.now()
  const last = zeroRateWarnedAt.get(scope)
  if (last !== undefined && now - last < ZERO_RATE_WARN_TTL_MS) return

  if (zeroRateWarnedAt.size >= ZERO_RATE_WARN_MAP_LIMIT) {
    for (const [key, at] of zeroRateWarnedAt) {
      if (now - at >= ZERO_RATE_WARN_TTL_MS) zeroRateWarnedAt.delete(key)
    }
    if (zeroRateWarnedAt.size >= ZERO_RATE_WARN_MAP_LIMIT) zeroRateWarnedAt.clear()
  }

  zeroRateWarnedAt.set(scope, now)
  console.warn(
    '[portara][billing] 解析到全 0 费率（本次按 0 计费）：' + JSON.stringify(payload)
  )
}

/**
 * 原子预留脚本。
 *
 * 入参：KEYS[1]=用户预留键；ARGV[1]=余额；ARGV[2]=预估成本；ARGV[3]=TTL 秒。
 * 返回：{ '1'|'0', 预留总额, 可用额度 } —— 数字用 tostring 返回，
 * 避免 Redis Lua 把浮点数截断成整数（tonumber 返回值会被截断）。
 *
 * 与 billingPure.decideReservation 同口径：balance>0 且 balance-reserved>=estimate。
 */
const RESERVE_SCRIPT = `
local reserved = tonumber(redis.call('GET', KEYS[1]) or '0')
local balance = tonumber(ARGV[1])
local estimate = tonumber(ARGV[2])
local available = balance - reserved
if balance <= 0 or available < estimate then
  return {'0', tostring(reserved), tostring(available)}
end
local after = tonumber(redis.call('INCRBYFLOAT', KEYS[1], ARGV[2]))
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return {'1', tostring(after), tostring(balance - after)}
`

/**
 * 原子释放脚本。
 *
 * 不刷新 TTL（释放不该延长别人的预留），键已过期则什么都不做；
 * 释放到 <= 0 直接 DEL，避免浮点残渣让键永远留着。
 */
const RELEASE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return '0' end
local left = tonumber(redis.call('INCRBYFLOAT', KEYS[1], ARGV[1]))
if left <= 0 then
  redis.call('DEL', KEYS[1])
  return '0'
end
return tostring(left)
`

export interface PlanRow {
  id: string
  name: string
  unit: BillingUnit
  currency: string
  credits_per_currency: string | number
  status: 'active' | 'disabled'
  note: string
  created_at: string
  updated_at: string
}

export interface ChannelRateRow {
  id: string
  channel_id: string | null
  upstream_model: string
  currency: string
  input_per_mtok: string | number
  output_per_mtok: string | number
  per_request: string | number
  status: 'active' | 'disabled'
  note: string
  created_at: string
  updated_at: string
  channel_name?: string | null
}

/** 复杂均衡别名（对外模型名）的售价行；结构上与渠道费率同形，按 alias 唯一。 */
export interface AliasRateRow {
  id: string
  alias: string
  currency: string
  input_per_mtok: string | number
  output_per_mtok: string | number
  per_request: string | number
  status: 'active' | 'disabled'
  note: string
  created_at: string
  updated_at: string
}

export interface LedgerRow {
  id: string
  user_id: string
  delta: string | number
  unit: string
  reason: string
  ref_type: string
  ref_id: string
  balance_after: string | number
  note: string
  created_at: string
}

export interface WindowUsage {
  window: LimitWindow
  limit: number
  used: number
  resetAt: string
}

export interface BillingState {
  plan: PlanRow | null
  balance: number
  /** user_billing 行是否存在（管理员在迁移里被预建，普通用户可能还没有） */
  hasRow: boolean
}

export interface PrecheckOk {
  ok: true
  /** 本次落进 Redis 的预估预留（0 = 未预留，例如 Redis 不可用时降级放行） */
  estimate: number
  /** 预留后的总额度 */
  reserved: number
  /** 预留后的可用额度 */
  available: number
  /** Redis 不可用导致降级放行（没有并发保护，但请求仍会被记账） */
  degraded?: boolean
}
export interface PrecheckFail {
  ok: false
  code: 'insufficient_balance' | 'usage_limit_exceeded' | 'no_plan'
  balance?: number
  /** 余额 - 已预留额度（insufficient_balance 时给出） */
  available?: number
  /** 当前已被在途请求占住的额度 */
  reserved?: number
  window?: LimitWindow
  limit?: number
  used?: number
  resetAt?: string
}
export type PrecheckResult = PrecheckOk | PrecheckFail

export function planToDto(p: PlanRow) {
  return {
    id: p.id,
    name: p.name,
    unit: p.unit,
    currency: p.currency,
    creditsPerCurrency: Number(p.credits_per_currency),
    status: p.status,
    note: p.note ?? '',
    createdAt: p.created_at,
    updatedAt: p.updated_at
  }
}

export function planLikeOf(p: PlanRow): BillingPlanLike {
  return {
    id: p.id,
    name: p.name,
    unit: p.unit,
    currency: p.currency,
    creditsPerCurrency: Number(p.credits_per_currency)
  }
}

export function rateToDto(r: RateLike & { status?: string; note?: string; createdAt?: string; updatedAt?: string; channelName?: string | null }) {
  return {
    id: r.id,
    channelId: r.channelId,
    channelName: r.channelName ?? null,
    upstreamModel: r.upstreamModel,
    currency: r.currency,
    inputPerMtok: r.inputPerMtok,
    outputPerMtok: r.outputPerMtok,
    perRequest: r.perRequest,
    status: r.status ?? 'active',
    note: r.note ?? '',
    createdAt: r.createdAt ?? null,
    updatedAt: r.updatedAt ?? null
  }
}

export function rateRowToRate(r: ChannelRateRow): RateLike {
  return {
    id: r.id,
    channelId: r.channel_id,
    upstreamModel: r.upstream_model,
    currency: r.currency,
    inputPerMtok: Number(r.input_per_mtok),
    outputPerMtok: Number(r.output_per_mtok),
    perRequest: Number(r.per_request)
  }
}

export function ledgerToDto(r: LedgerRow) {
  return {
    id: r.id,
    userId: r.user_id,
    delta: Number(r.delta),
    unit: r.unit,
    reason: r.reason,
    refType: r.ref_type,
    refId: r.ref_id,
    balanceAfter: Number(r.balance_after),
    note: r.note ?? '',
    createdAt: r.created_at
  }
}

/** 读用户套餐与余额（不缓存 —— 只有预检结果缓存） */
export async function loadUserBilling(userId: string): Promise<BillingState> {
  const ub = await one<{ plan_id: string | null; balance: string }>(
    'select plan_id, balance::text as balance from user_billing where user_id = $1',
    [userId]
  )
  if (!ub) return { plan: null, balance: 0, hasRow: false }

  const plan = ub.plan_id
    ? await one<PlanRow>('select * from billing_plans where id = $1', [ub.plan_id])
    : null
  return { plan, balance: Number(ub.balance), hasRow: true }
}

/** 用户套用的模板规则（只算启用中的模板） */
export async function loadAppliedRules(
  userId: string
): Promise<{ window: LimitWindow; threshold: number }[]> {
  const rows = await query<{ window: LimitWindow; threshold: string }>(
    `select r."window", r.threshold::text as threshold
       from user_limit_templates ut
       join limit_templates t on t.id = ut.template_id
       join limit_rules r on r.template_id = t.id
      where ut.user_id = $1 and t.status = 'active'`,
    [userId]
  )
  return rows.map((r) => ({ window: r.window, threshold: Number(r.threshold) }))
}

/**
 * 各窗口已用（按套餐单位）。
 *
 * 用量口径 = balance_ledger 中 reason='usage' 且 unit 与当前套餐一致的扣减。
 * 不直接读 request_logs：套餐单位可能换过，流水里的 unit 才是当时真实扣的单位。
 */
export async function loadWindowUsage(
  userId: string,
  unit: string,
  rules: { window: LimitWindow; threshold: number }[],
  now: Date = new Date()
): Promise<WindowUsage[]> {
  const merged = mergeRuleThresholds(rules.filter((r) => Number(r.threshold) > 0))
  if (merged.length === 0) return []

  const windows = merged.map((m) => m.window)
  const starts = windows.map((w) => windowStart(w, now).toISOString())

  const rows = await query<{ window: LimitWindow; used: string }>(
    `select w."window", coalesce(sum(-l.delta), 0)::text as used
       from unnest($2::text[], $3::timestamptz[]) as w("window", start_at)
       left join balance_ledger l
         on l.user_id = $1
        and l.reason = 'usage'
        and l.unit = $4
        and l.created_at >= w.start_at
      group by w."window"`,
    [userId, windows, starts, unit]
  )

  const usedByWindow = new Map(rows.map((r) => [r.window, Number(r.used)]))
  return windows.map((w) => ({
    window: w,
    limit: merged.find((m) => m.window === w)!.threshold,
    used: usedByWindow.get(w) ?? 0,
    resetAt: windowResetAt(w, now).toISOString()
  }))
}

/** 给管理端列表 / 自助页复用的「套餐 + 余额 + 各窗口」 */
export async function loadBillingSummary(userId: string): Promise<{
  plan: PlanRow | null
  balance: number
  windows: WindowUsage[]
  planDto: ReturnType<typeof planToDto> | null
}> {
  const state = await loadUserBilling(userId)
  if (!state.plan || state.plan.status !== 'active') {
    return {
      plan: state.plan,
      balance: state.balance,
      windows: [],
      planDto: state.plan ? planToDto(state.plan) : null
    }
  }
  const rules = await loadAppliedRules(userId)
  const windows = await loadWindowUsage(userId, state.plan.unit, rules)
  return {
    plan: state.plan,
    balance: state.balance,
    windows,
    planDto: planToDto(state.plan)
  }
}

// ------------------------------------------------------------ 费率

/**
 * 解析费率：精确 (channel, model) > 渠道默认 (channel, '') > 全局默认。
 * 都没有时返回全 0 的合成费率（id=null），保证调用方永远拿得到对象。
 */
export async function resolveRate(
  channelId: string,
  upstreamModel: string
): Promise<RateLike> {
  let version = '0'
  try {
    version = (await redis.get(RATE_VERSION_KEY)) ?? '0'
  } catch {
    /* Redis 挂了就直接读库 */
  }
  const cacheKey = `portara:billing:rate:${version}:${channelId}:${upstreamModel}`

  try {
    const cached = await redis.get(cacheKey)
    if (cached) {
      const rate = JSON.parse(cached) as RateLike
      if (isZeroRate(rate)) {
        warnZeroRateOnce(`rate:${channelId}:${upstreamModel}`, {
          channelId,
          upstreamModel,
          rateId: rate.id,
          source: 'cache'
        })
      }
      return rate
    }
  } catch {
    /* 缓存失败不阻塞计费 */
  }

  const rows = await query<ChannelRateRow>(
    `select * from channel_rates
      where status = 'active'
        and (channel_id is null or channel_id = $1)
        and (channel_id is null or upstream_model = $2 or upstream_model = '')
      order by updated_at desc`,
    [channelId, upstreamModel]
  )

  const best = pickBestRate(rows.map(rateRowToRate), channelId, upstreamModel)
  const rate: RateLike =
    best ??
    {
      id: null,
      channelId,
      upstreamModel,
      currency: 'USD',
      inputPerMtok: 0,
      outputPerMtok: 0,
      perRequest: 0
    }

  if (isZeroRate(rate)) {
    warnZeroRateOnce(`rate:${channelId}:${upstreamModel}`, {
      channelId,
      upstreamModel,
      rateId: rate.id,
      source: best ? 'db' : 'missing'
    })
  }

  try {
    await redis.set(cacheKey, JSON.stringify(rate), 'EX', RATE_TTL_SECONDS)
  } catch {
    /* 忽略 */
  }
  return rate
}

/**
 * 全局默认费率（channel_id is null + upstream_model = ''）。
 *
 * 只在「选路后仍然拿不到具体渠道费率」时兜底：正常路径由 /v1 在 selectTargets
 * 之后把命中的渠道与上游模型传进来，按精确费率估算预留；全局默认主要服务于
 * 历史调用方与测试。
 */
export async function resolveGlobalRate(): Promise<RateLike> {
  let version = '0'
  try {
    version = (await redis.get(RATE_VERSION_KEY)) ?? '0'
  } catch {
    /* Redis 挂了就直接读库 */
  }
  const cacheKey = `portara:billing:globalrate:${version}`

  try {
    const cached = await redis.get(cacheKey)
    if (cached) {
      const rate = JSON.parse(cached) as RateLike
      if (isZeroRate(rate)) {
        warnZeroRateOnce('global', {
          channelId: null,
          upstreamModel: '',
          rateId: rate.id,
          source: 'cache'
        })
      }
      return rate
    }
  } catch {
    /* 缓存失败不阻塞计费 */
  }

  const row = await one<ChannelRateRow>(
    `select * from channel_rates
      where channel_id is null and upstream_model = '' and status = 'active'
      limit 1`
  )

  const rate: RateLike = row
    ? rateRowToRate(row)
    : {
        id: null,
        channelId: null,
        upstreamModel: '',
        currency: 'USD',
        inputPerMtok: 0,
        outputPerMtok: 0,
        perRequest: 0
      }

  if (isZeroRate(rate)) {
    warnZeroRateOnce('global', {
      channelId: null,
      upstreamModel: '',
      rateId: rate.id,
      source: row ? 'db' : 'missing'
    })
  }

  try {
    await redis.set(cacheKey, JSON.stringify(rate), 'EX', RATE_TTL_SECONDS)
  } catch {
    /* 忽略 */
  }
  return rate
}

/**
 * 预检估算用的费率：别名售价 > 绑定渠道费率 > 全局默认。
 *
 * 为什么把别名放最前：结算时用户实际被扣的是 alias_rates（售价），
 * 预留当然要按售价估；没配别名售价时结算回退渠道成本价，这里也就用渠道费率。
 */
export async function resolveEstimateRate(input: {
  channelId: string | null
  /** 客户端请求的对外模型名（命中 alias_rates 时优先按售价估算） */
  model: string
  /** 选路后确定的上游模型；缺省回退到 model */
  upstreamModel?: string
}): Promise<RateLike> {
  if (input.model) {
    const alias = await resolveAliasRate(input.model)
    if (alias) return alias
  }
  if (input.channelId) {
    return resolveRate(input.channelId, input.upstreamModel || input.model)
  }
  return resolveGlobalRate()
}

/**
 * 解析「复杂均衡别名」的对外售价。
 *
 * 与 resolveRate 共用同一个缓存版本号：管理端改任何费率（渠道或别名）都会
 * incr 版本号，两类缓存一起失效，不存在「改了别名价但旧缓存还在」的窗口。
 * 返回 null 表示没有配别名售价 —— 调用方回退渠道成本价。
 */
export async function resolveAliasRate(alias: string): Promise<RateLike | null> {
  if (!alias) return null
  let version = '0'
  try {
    version = (await redis.get(RATE_VERSION_KEY)) ?? '0'
  } catch {
    /* Redis 挂了就直接读库 */
  }
  const cacheKey = `portara:billing:aliasrate:${version}:${alias}`

  try {
    const cached = await redis.get(cacheKey)
    if (cached) return JSON.parse(cached) as RateLike
  } catch {
    /* 缓存失败不阻塞计费 */
  }

  const row = await one<AliasRateRow>(
    `select * from alias_rates where alias = $1 and status = 'active'`,
    [alias]
  )
  if (!row) {
    // 负缓存：没配置是常态，避免每次请求都打库
    try {
      await redis.set(cacheKey, JSON.stringify(null), 'EX', RATE_TTL_SECONDS)
    } catch {
      /* 忽略 */
    }
    return null
  }

  const rate: RateLike = {
    id: row.id,
    channelId: null,
    upstreamModel: alias,
    currency: row.currency,
    inputPerMtok: Number(row.input_per_mtok),
    outputPerMtok: Number(row.output_per_mtok),
    perRequest: Number(row.per_request)
  }
  try {
    await redis.set(cacheKey, JSON.stringify(rate), 'EX', RATE_TTL_SECONDS)
  } catch {
    /* 忽略 */
  }
  return rate
}

export function aliasRateRowToDto(r: AliasRateRow) {
  return {
    id: r.id,
    alias: r.alias,
    currency: r.currency,
    inputPerMtok: Number(r.input_per_mtok),
    outputPerMtok: Number(r.output_per_mtok),
    perRequest: Number(r.per_request),
    status: r.status,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

/**
 * 主动失效：版本号 +1，所有带旧版本的缓存 key 立刻不再命中。
 * 选版本号而不是 del，是因为一次修改可能影响「该渠道下所有模型」的缓存，
 * 用 DEL 就得先知道所有 key（或 KEYS 扫描，生产禁用）。
 */
export async function bumpRateCacheVersion(): Promise<void> {
  try {
    await redis.incr(RATE_VERSION_KEY)
  } catch {
    /* Redis 不可用时旧缓存最多再活 30 秒，可接受 */
  }
}

/** 后台管理行 → 对外 DTO（带渠道名） */
export function rateRowToDto(r: ChannelRateRow) {
  return rateToDto({
    ...rateRowToRate(r),
    status: r.status,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    channelName: r.channel_name ?? null
  })
}

// ------------------------------------------------------------ 预检

function precheckCacheKey(userId: string): string {
  return `portara:billing:precheck:${userId}`
}

export async function invalidatePrecheck(userId: string): Promise<void> {
  try {
    await redis.del(precheckCacheKey(userId))
  } catch {
    /* 忽略 */
  }
}

/** 套餐被修改/删除后，所有绑定该套餐的用户都要重新预检 */
export async function invalidateUsersByPlan(planId: string): Promise<void> {
  const rows = await query<{ user_id: string }>(
    'select user_id from user_billing where plan_id = $1',
    [planId]
  )
  await Promise.all(rows.map((r) => invalidatePrecheck(r.user_id)))
}

/** 模板被修改/删除后，所有套用它的用户都要重新预检 */
export async function invalidateUsersByTemplate(templateId: string): Promise<void> {
  const rows = await query<{ user_id: string }>(
    'select user_id from user_limit_templates where template_id = $1',
    [templateId]
  )
  await Promise.all(rows.map((r) => invalidatePrecheck(r.user_id)))
}

// ------------------------------------------------------------ 预检与预留

interface EligibilityOk {
  ok: true
}
type Eligibility = EligibilityOk | PrecheckFail

/**
 * 计费资格预检（套餐 + 余额 + 限额窗口），成功结果缓存 15 秒。
 *
 * 只缓存「资格」不缓存「预留」：预留必须每次实时计算，否则缓存命中时
 * 多个并发请求会绕过额度判定。余额的精确可用额度（balance - reserved）
 * 由 reserveBilling 里的 Lua 原子完成。
 *
 * 失败实时计算，避免管理员充值后还要等缓存过期。
 */
async function checkBillingEligibility(userId: string): Promise<Eligibility> {
  const cacheKey = precheckCacheKey(userId)
  try {
    const cached = await redis.get(cacheKey)
    if (cached) return { ok: true }
  } catch {
    /* 忽略 */
  }

  const state = await loadUserBilling(userId)

  // 未绑套餐 / 套餐停用 → 402 no_plan（免费也必须绑一个套餐，见迁移 024）
  if (!planAllowsBilling(state.plan)) {
    return { ok: false, code: 'no_plan', balance: state.balance }
  }

  // 余额 <= 0：连 0 成本请求也不放行（保持改造前的语义）
  if (state.balance <= 0) {
    return {
      ok: false,
      code: 'insufficient_balance',
      balance: state.balance,
      reserved: 0,
      available: state.balance
    }
  }

  const rules = await loadAppliedRules(userId)
  const windows = await loadWindowUsage(userId, state.plan!.unit, rules)
  const hit = windows.find((w) => windowExceeded(w.used, w.limit))
  if (hit) {
    return {
      ok: false,
      code: 'usage_limit_exceeded',
      window: hit.window,
      limit: hit.limit,
      used: hit.used,
      resetAt: hit.resetAt,
      balance: state.balance
    }
  }

  try {
    await redis.set(cacheKey, JSON.stringify({ ok: true }), 'EX', PRECHECK_TTL_SECONDS)
  } catch {
    /* 忽略 */
  }
  return { ok: true }
}

export interface ReserveResult {
  ok: boolean
  /** 判定时的可用额度（balance - reserved） */
  available: number
  /** 判定时的预留总额 */
  reserved: number
  /** 判定通过后的预留总额；失败时保持原值 */
  reservedAfter: number
  /** 判定通过后的可用额度；失败时保持原值 */
  availableAfter: number
  /** Redis 不可用 → 降级放行（没有并发保护） */
  degraded: boolean
}

/**
 * 原子预留：把「读余额 / 读已预留 / 判定 / 累加 / 续 TTL」放进一个 Lua 脚本。
 *
 * 这是防并发透支的关键 —— 两个请求同时预检时，Redis 串行执行脚本，
 * 第二个一定看到第一个的预留，不会双双按同一份余额放行。
 *
 * Redis 不可用时**降级放行**：此时限流本身也已失效，为了不让网关整体 503，
 * 只打日志并依赖结算记账（可能短暂超额，但不会静默免费）。
 */
export async function reserveBilling(
  userId: string,
  balance: number,
  estimate: number
): Promise<ReserveResult> {
  const key = RESERVED_KEY_PREFIX + userId
  const need = Math.max(0, round6(Number(estimate) || 0))
  const snapshotBalance = round6(Number(balance) || 0)

  // 0 成本请求不占额度：避免 Redis 里堆积值为 0 的键
  if (need <= 0) {
    let reserved = 0
    try {
      reserved = Math.max(0, Number(await redis.get(key)) || 0)
    } catch {
      /* 忽略 */
    }
    const available = round6(snapshotBalance - reserved)
    return {
      ok: snapshotBalance > 0,
      available,
      reserved,
      reservedAfter: reserved,
      availableAfter: available,
      degraded: false
    }
  }

  try {
    const raw = (await redis.eval(
      RESERVE_SCRIPT,
      1,
      key,
      String(snapshotBalance),
      String(need),
      String(RESERVED_TTL_SECONDS)
    )) as unknown[]
    const ok = String(raw[0]) === '1'
    const reserved = round6(Number(raw[1]) || 0)
    const available = round6(Number(raw[2]) || 0)
    return {
      ok,
      available,
      reserved,
      reservedAfter: reserved,
      availableAfter: available,
      degraded: false
    }
  } catch (err) {
    console.error(
      '[portara][billing] 预留失败（Redis 不可用，降级放行）：',
      err instanceof Error ? err.message : String(err)
    )
    const available = snapshotBalance
    return {
      ok: true,
      available,
      reserved: 0,
      reservedAfter: 0,
      availableAfter: available,
      degraded: true
    }
  }
}

/**
 * 释放预留（结算 / 失败 / 超时后调用，调用方用 try/finally 保证只释放一次）。
 *
 * 不刷新 TTL；键已过期则什么都不做。金额 <= 0 时直接返回。
 */
export async function releaseBillingReservation(
  userId: string,
  estimate: number
): Promise<void> {
  const amount = round6(Number(estimate) || 0)
  if (!(amount > 0)) return
  try {
    await redis.eval(RELEASE_SCRIPT, 1, RESERVED_KEY_PREFIX + userId, String(-amount))
  } catch (err) {
    console.error(
      '[portara][billing] 释放预留失败：',
      err instanceof Error ? err.message : String(err)
    )
  }
}

export interface PrecheckInput {
  /** 请求体里的 max_tokens（缺失时按 1024 输出估算） */
  maxTokens?: unknown
  /** Key 绑定的渠道；null = 未绑定（用别名售价 / 全局默认估算） */
  channelId?: string | null
  /** 客户端请求的对外模型名（用于命中别名售价） */
  model?: string
  /** 选路后确定的上游模型（用于命中渠道费率） */
  upstreamModel?: string
}

/**
 * 计费预检：
 *   1. 没有套餐 / 套餐停用 → no_plan（402，免费套餐也必须显式绑定）。
 *   2. 余额 <= 0 → insufficient_balance。
 *   3. 任一窗口 used >= threshold → usage_limit_exceeded（多模板按窗口取最严）。
 *   4. 按预估成本预留额度：available = balance - reserved，不足 → insufficient_balance
 *      （带 available / reserved，便于调用方展示「还差多少」）。
 *
 * 资格结果缓存 15 秒；预留每次实时做。失败结果不缓存。
 */
export async function precheckBilling(
  userId: string,
  input: PrecheckInput = {}
): Promise<PrecheckResult> {
  const eligibility = await checkBillingEligibility(userId)
  if (!eligibility.ok) return eligibility

  // 资格命中缓存时仍要读一次余额：可用额度必须实时
  const state = await loadUserBilling(userId)
  if (!planAllowsBilling(state.plan)) {
    return { ok: false, code: 'no_plan', balance: state.balance }
  }
  if (state.balance <= 0) {
    return {
      ok: false,
      code: 'insufficient_balance',
      balance: state.balance,
      reserved: 0,
      available: state.balance
    }
  }

  const rate = await resolveEstimateRate({
    channelId: input.channelId ?? null,
    model: input.model ?? '',
    upstreamModel: input.upstreamModel
  })
  const estimate = estimateBilledAmount({
    maxTokens: input.maxTokens,
    rate,
    plan: planLikeOf(state.plan!)
  })

  const reservation = await reserveBilling(userId, state.balance, estimate)
  if (!reservation.ok) {
    return {
      ok: false,
      code: 'insufficient_balance',
      balance: state.balance,
      reserved: reservation.reserved,
      available: reservation.available
    }
  }

  return {
    ok: true,
    // 降级放行时没有预留，调用方按 0 释放（否则会把别人的预留减掉）
    estimate: reservation.degraded ? 0 : estimate,
    reserved: reservation.reservedAfter,
    available: reservation.availableAfter,
    degraded: reservation.degraded
  }
}

// ------------------------------------------------------------ 扣费

export interface ChargeInput {
  billedAmount: number
  unit: string
  planId: string
  /** 上游成本（渠道费率算出来），只用于核算毛利 */
  costMoney: number
  costCurrency: string
  rateId: string | null
  /** 对外售价（别名费率算出来）；未配置别名费率时等于 costMoney */
  sellMoney?: number
  aliasRateId?: string | null
  requestLogId: string
}

export interface ChargeResult {
  applied: boolean
  duplicate: boolean
  balanceAfter: number | null
  billedAmount: number
  unit: string
  requestLogId: string
  reason?: string
}

/**
 * 单事务扣费：
 *   ① 条件 UPDATE request_logs（billing_charged_at is null）作幂等闸门；
 *   ② 扣 user_billing.balance（允许为负 —— 这是"最后一笔"语义，后续请求被预检挡住）；
 *   ③ 写 balance_ledger（含 balance_after）；
 *   ④ 回写 request_logs 的计费列。
 *
 * 任何一步失败整体回滚：绝不会出现"扣了钱但日志没标记"。
 */
export async function chargeBilling(
  userId: string,
  input: ChargeInput
): Promise<ChargeResult> {
  const amount = round6(Math.max(0, input.billedAmount))
  const costMoney = round8(Math.max(0, input.costMoney))
  const client = await pool.connect()
  try {
    await client.query('begin')

    const marker = await client.query(
      `update request_logs
          set billing_plan_id = $2,
              cost_money = $3::numeric,
              cost_currency = $4,
              billed_amount = $5::numeric,
              billing_unit = $6,
              rate_id = $7,
              sell_money = $8::numeric,
              alias_rate_id = $9,
              billing_charged_at = now()
        where id = $1 and billing_charged_at is null
        returning id`,
      [
        input.requestLogId,
        input.planId,
        String(costMoney),
        input.costCurrency,
        String(amount),
        input.unit,
        input.rateId,
        String(round8(Math.max(0, input.sellMoney ?? input.costMoney))),
        input.aliasRateId ?? null
      ]
    )

    if (marker.rowCount === 0) {
      const exists = await client.query('select 1 from request_logs where id = $1', [
        input.requestLogId
      ])
      await client.query('rollback')
      return {
        applied: false,
        duplicate: (exists.rowCount ?? 0) > 0,
        balanceAfter: null,
        billedAmount: amount,
        unit: input.unit,
        requestLogId: input.requestLogId,
        reason: (exists.rowCount ?? 0) > 0 ? 'already_charged' : 'request_log_not_found'
      }
    }

    let balanceAfter: number | null = null
    if (amount > 0) {
      const updated = await client.query<{ balance: string }>(
        `insert into user_billing (user_id, plan_id, balance)
         values ($1::uuid, $2::uuid, (-1 * $3::numeric))
         on conflict (user_id) do update
           set balance = user_billing.balance - $3::numeric,
               plan_id = coalesce($2::uuid, user_billing.plan_id),
               updated_at = now()
         returning balance::text as balance`,
        [userId, input.planId, String(amount)]
      )
      balanceAfter = Number(updated.rows[0]!.balance)

      await client.query(
        `insert into balance_ledger
           (user_id, delta, unit, reason, ref_type, ref_id, balance_after, note)
         values ($1, $2::numeric, $3, 'usage', 'request_log', $4, $5::numeric, '')`,
        [userId, String(-amount), input.unit, input.requestLogId, String(balanceAfter)]
      )
    } else {
      // 0 费用也标记已结算（否则会被反复重算），但不写无意义的 0 流水。
      const cur = await client.query<{ balance: string }>(
        'select balance::text as balance from user_billing where user_id = $1::uuid',
        [userId]
      )
      balanceAfter = cur.rows[0] ? Number(cur.rows[0].balance) : null
    }

    await client.query('commit')
    await invalidatePrecheck(userId)
    return {
      applied: true,
      duplicate: false,
      balanceAfter,
      billedAmount: amount,
      unit: input.unit,
      requestLogId: input.requestLogId
    }
  } catch (err) {
    try {
      await client.query('rollback')
    } catch {
      /* 忽略回滚失败 */
    }
    throw err
  } finally {
    client.release()
  }
}

export interface SettleArgs {
  userId: string
  requestLogId: string
  channelId: string
  upstreamModel: string
  /** 客户端请求的对外模型名（复杂均衡别名）；命中 alias_rates 时按售价扣费 */
  alias?: string
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  requests?: number
}

/**
 * 请求成功后的结算入口：读套餐 → 解析费率 → 算上游成本 → 换算套餐单位 → 扣费。
 *
 * 由调用方保证「只对 2xx 且客户端未断开」的请求调用；本函数负责重复进入时
 * 由 chargeBilling 的幂等闸门兜住。
 */
export async function settleRequestBilling(args: SettleArgs): Promise<ChargeResult> {
  const state = await loadUserBilling(args.userId)
  if (!state.plan || state.plan.status !== 'active') {
    return {
      applied: false,
      duplicate: false,
      balanceAfter: null,
      billedAmount: 0,
      unit: '',
      requestLogId: args.requestLogId,
      reason: 'no_active_plan'
    }
  }

  const usage = {
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    requests: args.requests ?? 1
  }
  // 成本：渠道费率；售价：别名费率（未配置则回退成本价，保持旧行为）
  const costRate = await resolveRate(args.channelId, args.upstreamModel)
  const aliasRate = args.alias ? await resolveAliasRate(args.alias) : null
  const costMoney = computeMoneyCost(usage, costRate)
  const sellMoney = aliasRate ? computeMoneyCost(usage, aliasRate) : costMoney

  const totalTokens =
    args.totalTokens ?? Math.max(0, args.inputTokens) + Math.max(0, args.outputTokens)
  const plan = planLikeOf(state.plan)
  const billed = toBilledAmount(sellMoney, plan, totalTokens)

  return chargeBilling(args.userId, {
    billedAmount: billed,
    unit: plan.unit,
    planId: plan.id,
    costMoney,
    costCurrency: costRate.id ? costRate.currency : '',
    rateId: costRate.id,
    sellMoney,
    aliasRateId: aliasRate?.id ?? null,
    requestLogId: args.requestLogId
  })
}

// ------------------------------------------------------------ 管理员：套餐 / 余额

/** 改套餐（不动余额）。planId = null 表示解绑。 */
export async function setUserPlan(
  userId: string,
  planId: string | null
): Promise<void> {
  await query(
    `insert into user_billing (user_id, plan_id, balance)
     values ($1, $2, 0)
     on conflict (user_id) do update
       set plan_id = excluded.plan_id, updated_at = now()`,
    [userId, planId]
  )
  await invalidatePrecheck(userId)
}

/**
 * 管理员调整余额（充值 / 扣减），必须写流水。
 * delta 为 0 会被路由层拒绝。
 */
export async function adjustBalance(input: {
  userId: string
  delta: number
  reason: string
  note?: string
}): Promise<{ balanceAfter: number; ledgerId: string }> {
  const delta = round6(input.delta)
  const client = await pool.connect()
  try {
    await client.query('begin')

    // 先确保有行（普通用户可能尚未被迁移预建）
    await client.query(
      `insert into user_billing (user_id, plan_id, balance)
       values ($1, null, 0)
       on conflict (user_id) do nothing`,
      [input.userId]
    )

    const updated = await client.query<{ balance: string }>(
      `update user_billing
          set balance = balance + $2::numeric, updated_at = now()
        where user_id = $1
        returning balance::text as balance`,
      [input.userId, String(delta)]
    )
    const balanceAfter = Number(updated.rows[0]!.balance)

    const unitRow = await client.query<{ unit: string | null }>(
      `select p.unit
         from user_billing ub
         left join billing_plans p on p.id = ub.plan_id
        where ub.user_id = $1`,
      [input.userId]
    )
    const unit = unitRow.rows[0]?.unit ?? ''

    const ledger = await client.query<{ id: string }>(
      `insert into balance_ledger
         (user_id, delta, unit, reason, ref_type, ref_id, balance_after, note)
       values ($1, $2::numeric, $3, $4, 'manual', '', $5::numeric, $6)
       returning id::text as id`,
      [
        input.userId,
        String(delta),
        unit,
        input.reason,
        String(balanceAfter),
        input.note ?? ''
      ]
    )

    await client.query('commit')
    await invalidatePrecheck(input.userId)
    return { balanceAfter, ledgerId: ledger.rows[0]!.id }
  } catch (err) {
    try {
      await client.query('rollback')
    } catch {
      /* 忽略 */
    }
    throw err
  } finally {
    client.release()
  }
}

export { LIMIT_WINDOWS }
