import { Hono } from 'hono'
import { z } from 'zod'
import { one, pool, query } from '../db.js'
import { env } from '../env.js'
import { ApiError, badRequest, notFound, parseJson, parseQuery } from '../lib/http.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import { recordAudit } from '../services/audit.js'
import {
  adjustBalance,
  aliasRateRowToDto,
  bumpRateCacheVersion,
  invalidatePrecheck,
  invalidateUsersByPlan,
  invalidateUsersByTemplate,
  ledgerToDto,
  loadBillingSummary,
  planLikeOf,
  planToDto,
  rateRowToDto,
  setUserPlan,
  type AliasRateRow,
  type ChannelRateRow,
  type LedgerRow,
  type PlanRow
} from '../services/billing.js'
import {
  balanceBelow,
  isNearLimit,
  LIMIT_WINDOWS,
  lowBalanceThreshold,
  type LimitWindow
} from '../services/billingPure.js'
import type { UserRow } from '../types.js'

/**
 * 计费管理面。
 *
 *  - /api/billing/me         登录用户自助（套餐 / 余额 / 各窗口 / 最近流水）
 *  - 其余端点                  requireAdmin
 *
 * DTO 一律 camelCase；金额统一为 number（最多 6 位小数，见 billingPure.round6）。
 * 数据库里是 numeric，读出时 ::text → Number()，避免浮点误差在比较阶段出现。
 */
export const billingRoutes = new Hono()

billingRoutes.use('*', requireAuth)

const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '非法 ID')

const planCreateSchema = z.object({
  name: z.string().trim().min(1, '套餐名不能为空').max(64),
  unit: z.enum(['money', 'credits', 'tokens']),
  currency: z.enum(['USD', 'CNY']).default('USD'),
  creditsPerCurrency: z.coerce.number().finite().positive().default(100),
  status: z.enum(['active', 'disabled']).default('active'),
  /** 内置无限套餐标记：跳过余额 / 限额 / 预留，结算金额为 0 */
  unlimited: z.boolean().default(false),
  note: z.string().max(500).default('')
})
/*
 * PATCH 的 schema **不能**直接 planCreateSchema.partial()：
 * Zod 的 .partial() 只把字段变可选，.default() 仍然生效 —— 于是
 * "只改 note" 会把 currency/credits/status 一起重置成默认值。
 * 更新 schema 必须独立声明，全部 optional 且不带 default。
 */
const planUpdateSchema = z.object({
  name: z.string().trim().min(1, '套餐名不能为空').max(64).optional(),
  unit: z.enum(['money', 'credits', 'tokens']).optional(),
  currency: z.enum(['USD', 'CNY']).optional(),
  creditsPerCurrency: z.coerce.number().finite().positive().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  unlimited: z.boolean().optional(),
  note: z.string().max(500).optional()
})

const rateBodySchema = z.object({
  channelId: uuidSchema.nullable().optional(),
  upstreamModel: z.string().trim().max(200).default(''),
  currency: z.enum(['USD', 'CNY']).default('USD'),
  inputPerMtok: z.coerce.number().finite().min(0).default(0),
  outputPerMtok: z.coerce.number().finite().min(0).default(0),
  perRequest: z.coerce.number().finite().min(0).default(0),
  status: z.enum(['active', 'disabled']).default('active'),
  note: z.string().max(500).default('')
})

const windowSchema = z.enum(LIMIT_WINDOWS as unknown as [LimitWindow, ...LimitWindow[]])
const ruleSchema = z.object({
  window: windowSchema,
  threshold: z.coerce.number().finite().min(0)
})
const templateCreateSchema = z.object({
  name: z.string().trim().min(1, '模板名不能为空').max(64),
  ownerUserId: uuidSchema.nullable().optional(),
  status: z.enum(['active', 'disabled']).default('active'),
  note: z.string().max(500).default(''),
  rules: z.array(ruleSchema).default([])
})
/** 同上：规则数组在 PATCH 里必须「不传就不动」，不能被默认 [] 清空 */
const templateUpdateSchema = z.object({
  name: z.string().trim().min(1, '模板名不能为空').max(64).optional(),
  ownerUserId: uuidSchema.nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  note: z.string().max(500).optional(),
  rules: z.array(ruleSchema).optional()
})

/*
 * 用户自助模板：与管理员 schema 的区别 ——
 *  owner / status 一律不接受（服务端强制 owner = 当前用户、status = active），
 *  threshold 必须是**大于 0**（管理员模板允许 0 表示不限，用户自建模板没有这个需求）。
 */
const myRuleSchema = z.object({
  window: windowSchema,
  threshold: z.coerce.number().finite().positive('阈值必须大于 0')
})
const myTemplateCreateSchema = z.object({
  name: z.string().trim().min(1, '模板名不能为空').max(64),
  note: z.string().max(500).default(''),
  rules: z.array(myRuleSchema).default([])
})
const myTemplateUpdateSchema = z.object({
  name: z.string().trim().min(1, '模板名不能为空').max(64).optional(),
  note: z.string().max(500).optional(),
  rules: z.array(myRuleSchema).optional()
})

interface TemplateRow {
  id: string
  name: string
  owner_user_id: string | null
  status: string
  note: string
  created_at: string
  updated_at: string
  owner_username?: string | null
}
interface RuleRow {
  template_id: string
  window: LimitWindow
  threshold: string
}

function uniqueRules(rules: { window: LimitWindow; threshold: number }[]) {
  const seen = new Map<LimitWindow, number>()
  for (const r of rules) seen.set(r.window, r.threshold)
  return [...seen.entries()].map(([window, threshold]) => ({ window, threshold }))
}

function templateToDto(t: TemplateRow, rules: RuleRow[]) {
  return {
    id: t.id,
    name: t.name,
    ownerUserId: t.owner_user_id,
    ownerUsername: t.owner_username ?? null,
    status: t.status,
    note: t.note ?? '',
    rules: rules
      .filter((r) => r.template_id === t.id)
      .map((r) => ({ window: r.window, threshold: Number(r.threshold) })),
    createdAt: t.created_at,
    updatedAt: t.updated_at
  }
}

async function loadTemplates(ids?: string[]): Promise<ReturnType<typeof templateToDto>[]> {
  const templates = ids
    ? await query<TemplateRow>(
        `select t.*, u.username as owner_username
           from limit_templates t
           left join users u on u.id = t.owner_user_id
          where t.id = any($1::uuid[])
          order by t.created_at desc`,
        [ids]
      )
    : await query<TemplateRow>(
        `select t.*, u.username as owner_username
           from limit_templates t
           left join users u on u.id = t.owner_user_id
          order by t.created_at desc`
      )
  if (templates.length === 0) return []
  const rules = await query<RuleRow>(
    `select template_id, "window", threshold::text as threshold
       from limit_rules
      where template_id = any($1::uuid[])`,
    [templates.map((t) => t.id)]
  )
  return templates.map((t) => templateToDto(t, rules))
}

// ------------------------------------------------------------ 套餐

billingRoutes.get('/plans', requireAdmin, async (c) => {
  const rows = await query<PlanRow>('select * from billing_plans order by created_at asc')
  return c.json({ plans: rows.map(planToDto) })
})

billingRoutes.post('/plans', requireAdmin, async (c) => {
  const body = await parseJson(c, planCreateSchema)
  const exists = await one('select id from billing_plans where name = $1', [body.name])
  if (exists) throw badRequest('套餐名已存在')

  const row = await one<PlanRow>(
    `insert into billing_plans
       (name, unit, currency, credits_per_currency, status, unlimited, note)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [
      body.name,
      body.unit,
      body.currency,
      String(body.creditsPerCurrency),
      body.status,
      body.unlimited,
      body.note
    ]
  )
  await recordAudit(c, 'billing.plan.create', { type: 'billing_plan', id: row!.id }, {
    name: row!.name,
    unit: row!.unit,
    currency: row!.currency,
    unlimited: row!.unlimited
  })
  return c.json({ plan: planToDto(row!) }, 201)
})

billingRoutes.patch('/plans/:id', requireAdmin, async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const body = await parseJson(c, planUpdateSchema)
  const target = await one<PlanRow>('select * from billing_plans where id = $1', [id])
  if (!target) throw notFound('套餐不存在')

  if (body.name && body.name !== target.name) {
    const dup = await one('select id from billing_plans where name = $1 and id <> $2', [
      body.name,
      id
    ])
    if (dup) throw badRequest('套餐名已存在')
  }

  const row = await one<PlanRow>(
    `update billing_plans set
       name = coalesce($2, name),
       unit = coalesce($3, unit),
       currency = coalesce($4, currency),
       credits_per_currency = coalesce($5::numeric, credits_per_currency),
       status = coalesce($6, status),
       unlimited = coalesce($7::boolean, unlimited),
       note = coalesce($8, note),
       updated_at = now()
     where id = $1
     returning *`,
    [
      id,
      body.name ?? null,
      body.unit ?? null,
      body.currency ?? null,
      body.creditsPerCurrency === undefined ? null : String(body.creditsPerCurrency),
      body.status ?? null,
      body.unlimited ?? null,
      body.note ?? null
    ]
  )
  await invalidateUsersByPlan(id)
  await recordAudit(c, 'billing.plan.update', { type: 'billing_plan', id }, body)
  return c.json({ plan: planToDto(row!) })
})

billingRoutes.delete('/plans/:id', requireAdmin, async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const target = await one<PlanRow>('select * from billing_plans where id = $1', [id])
  if (!target) throw notFound('套餐不存在')
  // 内置套餐由系统维护（Infinity / Free / Standard），删除会让语义与绑定关系失去锚点。
  if (target.built_in) {
    throw new ApiError(409, 'built_in_plan', '内置套餐不允许删除')
  }
  // 先失效缓存再删：删除后 user_billing.plan_id 被置空，查不到绑定关系
  await invalidateUsersByPlan(id)
  await query('delete from billing_plans where id = $1', [id])
  await recordAudit(c, 'billing.plan.delete', { type: 'billing_plan', id }, {
    name: target.name
  })
  return c.json({ ok: true })
})

// ------------------------------------------------------------ 费率

billingRoutes.get('/rates', requireAdmin, async (c) => {
  const q = parseQuery(c, z.object({ channelId: uuidSchema.optional() }))
  const rows = await query<ChannelRateRow>(
    `select r.*, c.name as channel_name
       from channel_rates r
       left join channels c on c.id = r.channel_id
      where ($1::uuid is null or r.channel_id = $1 or r.channel_id is null)
      order by r.channel_id nulls last, r.upstream_model asc`,
    [q.channelId ?? null]
  )
  return c.json({ rates: rows.map(rateRowToDto) })
})

billingRoutes.put('/rates', requireAdmin, async (c) => {
  const body = await parseJson(c, rateBodySchema)
  const channelId = body.channelId ?? null
  const upstreamModel = channelId ? body.upstreamModel : ''

  if (channelId) {
    const channel = await one('select id from channels where id = $1', [channelId])
    if (!channel) throw badRequest('指定的渠道不存在')
  }

  /*
   * 真正的 upsert。
   *
   * 对渠道费率用 (channel_id, upstream_model) 唯一约束做 ON CONFLICT；
   * 全局默认（channel_id is null）不能依赖该约束 —— PostgreSQL 里 NULL 彼此不等，
   * 需要靠部分唯一索引 uq_channel_rates_global + 先查后写。
   */
  let row: ChannelRateRow | null
  if (channelId === null) {
    const existing = await one<ChannelRateRow>(
      `select * from channel_rates where channel_id is null and upstream_model = ''`
    )
    row = existing
      ? await one<ChannelRateRow>(
          `update channel_rates set
             currency = $2, input_per_mtok = $3::numeric,
             output_per_mtok = $4::numeric, per_request = $5::numeric,
             status = $6, note = $7, updated_at = now()
           where id = $1
           returning *`,
          [
            existing.id,
            body.currency,
            String(body.inputPerMtok),
            String(body.outputPerMtok),
            String(body.perRequest),
            body.status,
            body.note
          ]
        )
      : await one<ChannelRateRow>(
          `insert into channel_rates
             (channel_id, upstream_model, currency, input_per_mtok, output_per_mtok,
              per_request, status, note)
           values (null, '', $1,$2::numeric,$3::numeric,$4::numeric,$5,$6)
           returning *`,
          [
            body.currency,
            String(body.inputPerMtok),
            String(body.outputPerMtok),
            String(body.perRequest),
            body.status,
            body.note
          ]
        )
  } else {
    row = await one<ChannelRateRow>(
      `insert into channel_rates
         (channel_id, upstream_model, currency, input_per_mtok, output_per_mtok,
          per_request, status, note)
       values ($1,$2,$3,$4::numeric,$5::numeric,$6::numeric,$7,$8)
       on conflict (channel_id, upstream_model) do update set
         currency = excluded.currency,
         input_per_mtok = excluded.input_per_mtok,
         output_per_mtok = excluded.output_per_mtok,
         per_request = excluded.per_request,
         status = excluded.status,
         note = excluded.note,
         updated_at = now()
       returning *`,
      [
        channelId,
        upstreamModel,
        body.currency,
        String(body.inputPerMtok),
        String(body.outputPerMtok),
        String(body.perRequest),
        body.status,
        body.note
      ]
    )
  }

  await bumpRateCacheVersion()
  await recordAudit(c, 'billing.rate.upsert', { type: 'channel_rate', id: row!.id }, {
    channelId,
    upstreamModel,
    currency: body.currency,
    inputPerMtok: body.inputPerMtok,
    outputPerMtok: body.outputPerMtok,
    perRequest: body.perRequest
  })

  const withName = await one<ChannelRateRow>(
    `select r.*, c.name as channel_name
       from channel_rates r left join channels c on c.id = r.channel_id
      where r.id = $1`,
    [row!.id]
  )
  return c.json({ rate: rateRowToDto(withName!) })
})

// ------------------------------------------------------------ 别名售价（复杂均衡规则定义的模型名）

/*
 * 别名售价 vs 渠道成本：
 *   - alias_rates 决定「用户被扣多少」（request_logs.sell_money）
 *   - channel_rates 决定「上游成本多少」（request_logs.cost_money）
 * 两者并存才能算毛利；别名没配价时回退成本价，老数据行为不变。
 */
const aliasRateBodySchema = z.object({
  alias: z.string().trim().min(1, '别名不能为空').max(128),
  currency: z.enum(['USD', 'CNY']).default('USD'),
  inputPerMtok: z.coerce.number().finite().min(0).default(0),
  outputPerMtok: z.coerce.number().finite().min(0).default(0),
  perRequest: z.coerce.number().finite().min(0).default(0),
  status: z.enum(['active', 'disabled']).default('active'),
  note: z.string().max(500).default('')
})

billingRoutes.get('/alias-rates', requireAdmin, async (c) => {
  const q = parseQuery(c, z.object({ q: z.string().max(128).optional() }))
  const rows = await query<AliasRateRow>(
    `select * from alias_rates
      where ($1::text is null or alias ilike '%' || $1 || '%')
      order by alias asc`,
    [q.q ?? null]
  )
  return c.json({ rates: rows.map(aliasRateRowToDto) })
})

billingRoutes.put('/alias-rates', requireAdmin, async (c) => {
  const body = await parseJson(c, aliasRateBodySchema)
  const exists = await one('select 1 from model_routes where alias = $1 limit 1', [body.alias])
  if (!exists) throw badRequest('该别名在复杂均衡规则里不存在')

  const row = await one<AliasRateRow>(
    `insert into alias_rates (alias, currency, input_per_mtok, output_per_mtok, per_request, status, note)
     values ($1,$2,$3::numeric,$4::numeric,$5::numeric,$6,$7)
     on conflict (alias) do update set
       currency = excluded.currency,
       input_per_mtok = excluded.input_per_mtok,
       output_per_mtok = excluded.output_per_mtok,
       per_request = excluded.per_request,
       status = excluded.status,
       note = excluded.note,
       updated_at = now()
     returning *`,
    [
      body.alias,
      body.currency,
      String(body.inputPerMtok),
      String(body.outputPerMtok),
      String(body.perRequest),
      body.status,
      body.note
    ]
  )
  await bumpRateCacheVersion()
  await recordAudit(c, 'billing.alias_rate.upsert', { type: 'alias_rate', id: row!.id }, {
    alias: body.alias,
    currency: body.currency,
    inputPerMtok: body.inputPerMtok,
    outputPerMtok: body.outputPerMtok,
    perRequest: body.perRequest
  })
  return c.json({ rate: aliasRateRowToDto(row!) })
})

billingRoutes.delete('/alias-rates/:id', requireAdmin, async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const target = await one<AliasRateRow>('select * from alias_rates where id = $1', [id])
  if (!target) throw notFound('别名费率不存在')
  await query('delete from alias_rates where id = $1', [id])
  await bumpRateCacheVersion()
  await recordAudit(c, 'billing.alias_rate.delete', { type: 'alias_rate', id }, {
    alias: target.alias
  })
  return c.json({ ok: true })
})

// ------------------------------------------------------------ 限额模板

billingRoutes.get('/templates', requireAdmin, async (c) => {
  return c.json({ templates: await loadTemplates() })
})

billingRoutes.post('/templates', requireAdmin, async (c) => {
  const body = await parseJson(c, templateCreateSchema)
  if (body.ownerUserId) {
    const owner = await one('select id from users where id = $1', [body.ownerUserId])
    if (!owner) throw badRequest('指定模板归属的用户不存在')
  }
  const rules = uniqueRules(body.rules)

  const client = await pool.connect()
  try {
    await client.query('begin')
    const t = await client.query<TemplateRow>(
      `insert into limit_templates (name, owner_user_id, status, note)
       values ($1,$2,$3,$4) returning *`,
      [body.name, body.ownerUserId ?? null, body.status, body.note]
    )
    for (const r of rules) {
      await client.query(
        'insert into limit_rules (template_id, "window", threshold) values ($1,$2,$3::numeric)',
        [t.rows[0]!.id, r.window, String(r.threshold)]
      )
    }
    await client.query('commit')
    await recordAudit(c, 'billing.template.create', {
      type: 'limit_template',
      id: t.rows[0]!.id
    }, { name: body.name, rules })
    const [dto] = await loadTemplates([t.rows[0]!.id])
    return c.json({ template: dto }, 201)
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
})

billingRoutes.patch('/templates/:id', requireAdmin, async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const body = await parseJson(c, templateUpdateSchema)
  const target = await one<TemplateRow>('select * from limit_templates where id = $1', [id])
  if (!target) throw notFound('模板不存在')
  if (body.ownerUserId) {
    const owner = await one('select id from users where id = $1', [body.ownerUserId])
    if (!owner) throw badRequest('指定模板归属的用户不存在')
  }

  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query(
      `update limit_templates set
         name = coalesce($2, name),
         owner_user_id = case when $3::boolean then $4::uuid else owner_user_id end,
         status = coalesce($5, status),
         note = coalesce($6, note),
         updated_at = now()
       where id = $1`,
      [
        id,
        body.name ?? null,
        body.ownerUserId !== undefined,
        body.ownerUserId ?? null,
        body.status ?? null,
        body.note ?? null
      ]
    )
    if (body.rules !== undefined) {
      await client.query('delete from limit_rules where template_id = $1', [id])
      for (const r of uniqueRules(body.rules)) {
        await client.query(
          'insert into limit_rules (template_id, "window", threshold) values ($1,$2,$3::numeric)',
          [id, r.window, String(r.threshold)]
        )
      }
    }
    await client.query('commit')
    await invalidateUsersByTemplate(id)
    await recordAudit(c, 'billing.template.update', { type: 'limit_template', id }, body)
    const [dto] = await loadTemplates([id])
    return c.json({ template: dto })
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
})

billingRoutes.delete('/templates/:id', requireAdmin, async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const target = await one<TemplateRow>('select * from limit_templates where id = $1', [id])
  if (!target) throw notFound('模板不存在')
  // 先失效缓存再删：cascade 会把 user_limit_templates 一起清掉
  await invalidateUsersByTemplate(id)
  await query('delete from limit_templates where id = $1', [id])
  await recordAudit(c, 'billing.template.delete', { type: 'limit_template', id }, {
    name: target.name
  })
  return c.json({ ok: true })
})

// ------------------------------------------------------------ 用户自助限额

/**
 * 当前用户「已套用」的模板集合 + 可申请套用的全局模板。
 *
 * lockedTemplateIds = 已套用且 owner_user_id is null 的模板。全局模板由管理员
 * 创建与维护，用户自助 PUT 只能**增加**、不能移除它们 —— 这样管理员下发的
 * 全局限额不会被用户自助操作悄悄放宽（多模板合并本来就按窗口取最严）。
 */
async function loadMyLimits(userId: string) {
  const applied = await query<{ template_id: string; owner_user_id: string | null }>(
    `select ut.template_id, t.owner_user_id
       from user_limit_templates ut
       join limit_templates t on t.id = ut.template_id
      where ut.user_id = $1
      order by t.created_at desc`,
    [userId]
  )
  const templateIds = applied.map((r) => r.template_id)
  const lockedTemplateIds = applied
    .filter((r) => r.owner_user_id === null)
    .map((r) => r.template_id)

  const globals = await query<TemplateRow>(
    `select * from limit_templates
      where owner_user_id is null and status = 'active'
      order by created_at desc`
  )

  const appliedTemplates = templateIds.length > 0 ? await loadTemplates(templateIds) : []
  const globalTemplates = globals.length > 0 ? await loadTemplates(globals.map((g) => g.id)) : []

  return {
    templateIds,
    selfTemplateIds: templateIds.filter((id) => !lockedTemplateIds.includes(id)),
    lockedTemplateIds,
    templates: appliedTemplates,
    globalTemplates
  }
}

/** 只返回 owner_user_id = 当前用户的模板（含 rules） */
billingRoutes.get('/my/templates', async (c) => {
  const user = c.get('user')
  const own = await query<TemplateRow>(
    'select * from limit_templates where owner_user_id = $1 order by created_at desc',
    [user.id]
  )
  const templates = own.length > 0 ? await loadTemplates(own.map((t) => t.id)) : []
  return c.json({ templates })
})

billingRoutes.get('/my/limits', async (c) => {
  const user = c.get('user')
  return c.json(await loadMyLimits(user.id))
})

billingRoutes.post('/my/templates', async (c) => {
  const user = c.get('user')
  const body = await parseJson(c, myTemplateCreateSchema)

  const dup = await one(
    'select id from limit_templates where owner_user_id = $1 and name = $2',
    [user.id, body.name]
  )
  if (dup) throw new ApiError(409, 'conflict', '模板名已存在')

  const rules = uniqueRules(body.rules)
  const client = await pool.connect()
  try {
    await client.query('begin')
    const t = await client.query<TemplateRow>(
      `insert into limit_templates (name, owner_user_id, status, note)
       values ($1,$2,'active',$3) returning *`,
      [body.name, user.id, body.note]
    )
    for (const r of rules) {
      await client.query(
        'insert into limit_rules (template_id, "window", threshold) values ($1,$2,$3::numeric)',
        [t.rows[0]!.id, r.window, String(r.threshold)]
      )
    }
    await client.query('commit')
    await recordAudit(
      c,
      'billing.my_template.create',
      { type: 'limit_template', id: t.rows[0]!.id },
      { name: body.name, rules }
    )
    const [dto] = await loadTemplates([t.rows[0]!.id])
    return c.json({ template: dto }, 201)
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
})

billingRoutes.patch('/my/templates/:id', async (c) => {
  const user = c.get('user')
  const id = uuidSchema.parse(c.req.param('id'))
  const body = await parseJson(c, myTemplateUpdateSchema)

  const target = await one<TemplateRow>('select * from limit_templates where id = $1', [id])
  // 越权一律 404（不区分「不存在」与「别人的」），避免探测他人模板 id
  if (!target || target.owner_user_id !== user.id) throw notFound('模板不存在')

  if (body.name && body.name !== target.name) {
    const dup = await one(
      'select id from limit_templates where owner_user_id = $1 and name = $2 and id <> $3',
      [user.id, body.name, id]
    )
    if (dup) throw new ApiError(409, 'conflict', '模板名已存在')
  }

  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query(
      `update limit_templates set
         name = coalesce($2, name),
         note = coalesce($3, note),
         updated_at = now()
       where id = $1`,
      [id, body.name ?? null, body.note ?? null]
    )
    if (body.rules !== undefined) {
      await client.query('delete from limit_rules where template_id = $1', [id])
      for (const r of uniqueRules(body.rules)) {
        await client.query(
          'insert into limit_rules (template_id, "window", threshold) values ($1,$2,$3::numeric)',
          [id, r.window, String(r.threshold)]
        )
      }
    }
    await client.query('commit')
    await invalidateUsersByTemplate(id)
    await recordAudit(c, 'billing.my_template.update', { type: 'limit_template', id }, body)
    const [dto] = await loadTemplates([id])
    return c.json({ template: dto })
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
})

billingRoutes.delete('/my/templates/:id', async (c) => {
  const user = c.get('user')
  const id = uuidSchema.parse(c.req.param('id'))
  const target = await one<TemplateRow>('select * from limit_templates where id = $1', [id])
  if (!target || target.owner_user_id !== user.id) throw notFound('模板不存在')

  // 先失效缓存再删：cascade 会把 user_limit_templates 一起清掉
  await invalidateUsersByTemplate(id)
  await query('delete from limit_templates where id = $1', [id])
  await recordAudit(c, 'billing.my_template.delete', { type: 'limit_template', id }, {
    name: target.name
  })
  return c.json({ ok: true })
})

/**
 * 自助套用：只能选「自己的模板」或「全局模板」，越权 id 返回 400。
 *
 * 语义：替换当前用户的自助绑定集合；已套用的全局模板是**粘滞**的
 * （lockedTemplateIds），会保留在最终集合里 —— 用户无法借此放宽管理员限额。
 */
billingRoutes.put('/my/limits', async (c) => {
  const user = c.get('user')
  const body = await parseJson(
    c,
    z.object({ templateIds: z.array(uuidSchema).default([]) })
  )
  const ids = [...new Set(body.templateIds)]

  if (ids.length > 0) {
    const found = await query<{ id: string; owner_user_id: string | null }>(
      'select id, owner_user_id from limit_templates where id = any($1::uuid[])',
      [ids]
    )
    if (found.length !== ids.length) throw badRequest('存在无效的模板 id')
    if (found.some((t) => t.owner_user_id !== null && t.owner_user_id !== user.id)) {
      throw badRequest('只能套用自己的模板或全局模板')
    }
  }

  // 已套用的全局模板保持不动：管理员模板优先，用户自助只能叠加
  const current = await query<{ template_id: string }>(
    `select ut.template_id
       from user_limit_templates ut
       join limit_templates t on t.id = ut.template_id
      where ut.user_id = $1 and t.owner_user_id is null`,
    [user.id]
  )
  const effective = [...new Set([...ids, ...current.map((r) => r.template_id)])]

  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query('delete from user_limit_templates where user_id = $1', [user.id])
    for (const id of effective) {
      await client.query(
        'insert into user_limit_templates (user_id, template_id) values ($1,$2)',
        [user.id, id]
      )
    }
    await client.query('commit')
    await invalidatePrecheck(user.id)
    await recordAudit(c, 'billing.my_limits.set', { type: 'user', id: user.id }, {
      requestedTemplateIds: ids,
      templateIds: effective
    })
    return c.json(await loadMyLimits(user.id))
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
})

/** 覆盖套用：模板集合整体替换（不是追加） */
billingRoutes.post('/users/:id/templates', requireAdmin, async (c) => {
  const userId = uuidSchema.parse(c.req.param('id'))
  const body = await parseJson(
    c,
    z.object({ templateIds: z.array(uuidSchema).default([]) })
  )
  const user = await one('select id from users where id = $1', [userId])
  if (!user) throw notFound('用户不存在')

  const ids = [...new Set(body.templateIds)]
  if (ids.length > 0) {
    const found = await query<{ id: string }>(
      'select id from limit_templates where id = any($1::uuid[])',
      [ids]
    )
    if (found.length !== ids.length) throw badRequest('存在无效的模板 id')
  }

  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query('delete from user_limit_templates where user_id = $1', [userId])
    for (const id of ids) {
      await client.query(
        'insert into user_limit_templates (user_id, template_id) values ($1,$2)',
        [userId, id]
      )
    }
    await client.query('commit')
    await invalidatePrecheck(userId)
    await recordAudit(c, 'billing.user.templates', { type: 'user', id: userId }, {
      templateIds: ids
    })
    return c.json({ userId, templateIds: ids })
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
})

/**
 * 一键给「所有未绑套餐用户」绑定内置 Free 套餐。
 *
 * 为什么需要它：P0 起未绑套餐 = 402，所以上线后必须有一个可执行的补绑入口，
 * 否则所有普通用户会突然全部不可用。不放在迁移里自动绑定，是因为那会制造
 * 无法追溯的隐藏状态（用户会「莫名其妙有套餐」）—— 绑定必须是管理员显式动作，
 * 且留审计。
 *
 * 「未绑套餐」的口径包含：没有 user_billing 行、plan_id 为空、套餐已被删除、
 * 或套餐已停用。绑定只改 plan_id，不动余额。
 */
billingRoutes.post('/users/bind-default', requireAdmin, async (c) => {
  const plan = await one<PlanRow>(
    `select * from billing_plans where name = 'Free' and status = 'active'`
  )
  if (!plan) {
    throw badRequest('内置 Free 套餐不存在或已停用，请先执行迁移 024')
  }

  const targets = await query<{ id: string }>(
    `select u.id
       from users u
       left join user_billing ub on ub.user_id = u.id
       left join billing_plans p on p.id = ub.plan_id
      where ub.plan_id is null or p.id is null or p.status <> 'active'
      order by u.created_at asc`
  )

  if (targets.length > 0) {
    const client = await pool.connect()
    try {
      await client.query('begin')
      for (const row of targets) {
        await client.query(
          `insert into user_billing (user_id, plan_id, balance)
           values ($1, $2, 0)
           on conflict (user_id) do update
             set plan_id = excluded.plan_id, updated_at = now()`,
          [row.id, plan.id]
        )
      }
      await client.query('commit')
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
    await Promise.all(targets.map((row) => invalidatePrecheck(row.id)))
  }

  await recordAudit(
    c,
    'billing.users.bind_default',
    { type: 'billing_plan', id: plan.id },
    { planId: plan.id, planName: plan.name, userIds: targets.map((row) => row.id) }
  )

  return c.json({
    planId: plan.id,
    planName: plan.name,
    bound: targets.map((row) => row.id)
  })
})

// ------------------------------------------------------------ 用户列表 / 调整

billingRoutes.get('/users', requireAdmin, async (c) => {
  const q = parseQuery(c, z.object({ q: z.string().max(64).default('') }))
  const like = `%${q.q}%`
  const rows = await query<{
    id: string
    username: string
    display_name: string
    role: string
    status: string
    balance: string | null
    plan_id: string | null
    plan_name: string | null
    unit: string | null
    currency: string | null
  }>(
    `select u.id, u.username, u.display_name, u.role, u.status,
            ub.balance::text as balance,
            p.id as plan_id, p.name as plan_name, p.unit, p.currency
       from users u
       left join user_billing ub on ub.user_id = u.id
       left join billing_plans p on p.id = ub.plan_id
      where ($1 = '' or u.username ilike $2 or u.display_name ilike $2)
      order by u.created_at asc
      limit 200`,
    [q.q, like]
  )

  const users = []
  for (const row of rows) {
    const summary = await loadBillingSummary(row.id)
    users.push({
      userId: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      status: row.status,
      planId: row.plan_id,
      planName: row.plan_name,
      unit: row.unit,
      currency: row.currency,
      balance: Number(row.balance ?? summary.balance),
      windows: summary.windows,
      plan: summary.planDto
    })
  }
  return c.json({ users })
})

billingRoutes.patch('/users/:id', requireAdmin, async (c) => {
  const userId = uuidSchema.parse(c.req.param('id'))
  const body = await parseJson(
    c,
    z.object({
      planId: uuidSchema.nullable().optional(),
      adjust: z
        .object({
          delta: z.coerce.number().finite().refine((v) => v !== 0, '调整金额不能为 0'),
          reason: z.string().trim().min(1, '必须填写调整原因').max(200),
          note: z.string().max(500).optional()
        })
        .optional()
    })
  )
  if (body.planId === undefined && !body.adjust) {
    throw badRequest('至少提供 planId 或 adjust')
  }

  const user = await one<UserRow>('select * from users where id = $1', [userId])
  if (!user) throw notFound('用户不存在')

  if (body.planId !== undefined) {
    if (body.planId) {
      const plan = await one('select id from billing_plans where id = $1', [body.planId])
      if (!plan) throw badRequest('指定的套餐不存在')
    }
    await setUserPlan(userId, body.planId)
    await recordAudit(c, 'billing.user.plan', { type: 'user', id: userId }, {
      planId: body.planId
    })
  }

  if (body.adjust) {
    await adjustBalance({
      userId,
      delta: body.adjust.delta,
      reason: body.adjust.reason,
      note: body.adjust.note
    })
    await recordAudit(c, 'billing.user.adjust', { type: 'user', id: userId }, body.adjust)
  }

  const summary = await loadBillingSummary(userId)
  return c.json({
    user: {
      userId,
      username: user.username,
      displayName: user.display_name,
      planId: summary.plan?.id ?? null,
      planName: summary.plan?.name ?? null,
      unit: summary.plan?.unit ?? null,
      currency: summary.plan?.currency ?? null,
      balance: summary.balance,
      windows: summary.windows,
      plan: summary.planDto
    }
  })
})

// ------------------------------------------------------------ 健康度

/**
 * 计费健康度（管理员）：把「会导致静默免费 / 无法计费」的状态一次列出来。
 *
 * 口径说明：
 *   - unboundUsers：没有 user_billing 行、plan_id 为空、套餐已删除或已停用 ——
 *     与 bind-default 完全同口径，保证「这里能看到」等于「一键补绑能解决」。
 *   - orphanKeys：api_keys.user_id 为空，或属主已删除 / 已禁用。这些 Key 在
 *     apiKeyAuth 里都会被拒（403/401），列表用于提示管理员清理或重新签发。
 *   - channelsWithoutRate：没有任何**渠道级**生效费率的渠道（不含全局默认）。
 *     它们会回退到全局默认；如果全局默认也是 0，就会按 0 计费。
 *   - missingRateRequests24h：近 24h 结算后 billed_amount = 0、且命中费率行不存在
 *     或三项全 0 的成功请求数 —— 即「没解析到任何真实费率、最终计费为 0」的口径。
 *     真正命中全 0 费率时也会命中服务端告警（见 services/billing.ts 的 warnZeroRateOnce）。
 */
billingRoutes.get('/health', requireAdmin, async (c) => {
  const unbound = await query<{
    id: string
    username: string
    display_name: string
    role: string
  }>(
    `select u.id, u.username, u.display_name, u.role
       from users u
       left join user_billing ub on ub.user_id = u.id
       left join billing_plans p on p.id = ub.plan_id
      where ub.plan_id is null or p.id is null or p.status <> 'active'
      order by u.created_at asc
      limit 500`
  )

  const orphan = await one<{ count: string }>(
    `select count(*)::text as count
       from api_keys k
       left join users u on u.id = k.user_id
      where k.user_id is null or u.id is null or u.status <> 'active'`
  )

  const channelsWithoutRate = await query<{ id: string; name: string }>(
    `select ch.id, ch.name
       from channels ch
      where ch.status = 'active'
        and not exists (
          select 1 from channel_rates r
           where r.channel_id = ch.id and r.status = 'active'
        )
      order by ch.name asc`
  )

  const disabledPlans = await one<{ count: string }>(
    `select count(*)::text as count from billing_plans where status <> 'active'`
  )

  /*
   * 零费率请求：结算后 billed_amount = 0，且命中的费率行不存在或三项全 0。
   *
   * 不能只判 rate_id is null：迁移 022 预置了一条全 0 的全局默认费率，
   * 没配费率的渠道命中的正是这一行（rate_id 非空但金额全 0）。因此要 join
   * channel_rates 看实际费率值；行已被删除（r.id is null）时也计入 —— 那同样
   * 说明这笔请求没有可追溯的费率。
   */
  const missingRate = await one<{ count: string }>(
    `select count(*)::text as count
       from request_logs l
       left join channel_rates r on r.id = l.rate_id
      where l.billing_charged_at >= now() - interval '24 hours'
        and l.billed_amount = 0
        and l.total_tokens > 0
        and (
          l.rate_id is null
          or r.id is null
          or (r.input_per_mtok = 0 and r.output_per_mtok = 0 and r.per_request = 0)
        )`
  )

  return c.json({
    unboundUsers: unbound.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      role: u.role
    })),
    orphanKeys: Number(orphan?.count ?? 0),
    channelsWithoutRate,
    disabledPlans: Number(disabledPlans?.count ?? 0),
    missingRateRequests24h: Number(missingRate?.count ?? 0)
  })
})

// ------------------------------------------------------------ 自助 / 流水

billingRoutes.get('/me', async (c) => {
  const user = c.get('user')
  const summary = await loadBillingSummary(user.id)
  const ledger = await query<LedgerRow>(
    `select * from balance_ledger where user_id = $1
      order by created_at desc limit 20`,
    [user.id]
  )

  /*
   * 余额告警：不再等到被 402 才发现。
   *   lowBalance —— 余额低于阈值（PORTARA_BILLING_LOW_BALANCE_USD，默认 1；
   *                 credits 套餐按兑换率换算，tokens 套餐按原始数值比较）
   *   nearLimit  —— 任一限额窗口 used/limit >= 0.9
   */
  const threshold = lowBalanceThreshold(
    env.billingLowBalanceUsd,
    summary.plan ? planLikeOf(summary.plan) : null
  )

  return c.json({
    plan: summary.planDto,
    balance: summary.balance,
    unit: summary.plan?.unit ?? '',
    currency: summary.plan?.currency ?? '',
    windows: summary.windows,
    lowBalance: balanceBelow(summary.balance, threshold),
    nearLimit: isNearLimit(summary.windows),
    ledger: ledger.map(ledgerToDto)
  })
})

billingRoutes.get('/ledger', requireAdmin, async (c) => {
  const q = parseQuery(
    c,
    z.object({
      userId: uuidSchema.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50)
    })
  )
  const rows = await query<LedgerRow>(
    `select * from balance_ledger
      where ($1::uuid is null or user_id = $1)
      order by created_at desc
      limit $2`,
    [q.userId ?? null, q.limit]
  )
  return c.json({ ledger: rows.map(ledgerToDto) })
})
