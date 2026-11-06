import { one, pool, query } from '../db.js'
import { redis } from '../redis.js'
import {
  computeMoneyCost,
  LIMIT_WINDOWS,
  mergeRuleThresholds,
  pickBestRate,
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
}
export interface PrecheckFail {
  ok: false
  code: 'insufficient_balance' | 'usage_limit_exceeded'
  balance?: number
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
    if (cached) return JSON.parse(cached) as RateLike
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

  try {
    await redis.set(cacheKey, JSON.stringify(rate), 'EX', RATE_TTL_SECONDS)
  } catch {
    /* 忽略 */
  }
  return rate
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

/**
 * 计费预检：
 *   1. 用户没有套餐 / 套餐停用 → 视为未启用计费，放行（迁移只给管理员建行，
 *      普通用户未绑套餐时不应被一刀切拦死）。
 *   2. 余额 <= 0 → insufficient_balance。
 *   3. 任一窗口 used >= threshold → usage_limit_exceeded（多模板按窗口取最严）。
 *
 * 只缓存 ok；失败实时计算，避免管理员充值后还要等缓存过期。
 */
export async function precheckBilling(userId: string): Promise<PrecheckResult> {
  const cacheKey = precheckCacheKey(userId)
  try {
    const cached = await redis.get(cacheKey)
    if (cached) return JSON.parse(cached) as PrecheckOk
  } catch {
    /* 忽略 */
  }

  const state = await loadUserBilling(userId)
  if (!state.plan || state.plan.status !== 'active') return { ok: true }

  if (state.balance <= 0) {
    return { ok: false, code: 'insufficient_balance', balance: state.balance }
  }

  const rules = await loadAppliedRules(userId)
  const windows = await loadWindowUsage(userId, state.plan.unit, rules)
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

// ------------------------------------------------------------ 扣费

export interface ChargeInput {
  billedAmount: number
  unit: string
  planId: string
  costMoney: number
  costCurrency: string
  rateId: string | null
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
        input.rateId
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

  const rate = await resolveRate(args.channelId, args.upstreamModel)
  const costMoney = computeMoneyCost(
    {
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      requests: args.requests ?? 1
    },
    rate
  )
  const totalTokens =
    args.totalTokens ?? Math.max(0, args.inputTokens) + Math.max(0, args.outputTokens)
  const plan = planLikeOf(state.plan)
  const billed = toBilledAmount(costMoney, plan, totalTokens)

  return chargeBilling(args.userId, {
    billedAmount: billed,
    unit: plan.unit,
    planId: plan.id,
    costMoney,
    costCurrency: rate.id ? rate.currency : '',
    rateId: rate.id,
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
