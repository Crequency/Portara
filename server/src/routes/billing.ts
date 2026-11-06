import { Hono } from 'hono'
import { z } from 'zod'
import { one, pool, query } from '../db.js'
import { badRequest, notFound, parseJson, parseQuery } from '../lib/http.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import { recordAudit } from '../services/audit.js'
import {
  adjustBalance,
  bumpRateCacheVersion,
  invalidatePrecheck,
  invalidateUsersByPlan,
  invalidateUsersByTemplate,
  ledgerToDto,
  loadBillingSummary,
  planToDto,
  rateRowToDto,
  setUserPlan,
  type ChannelRateRow,
  type LedgerRow,
  type PlanRow
} from '../services/billing.js'
import { LIMIT_WINDOWS, type LimitWindow } from '../services/billingPure.js'
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
    `insert into billing_plans (name, unit, currency, credits_per_currency, status, note)
     values ($1,$2,$3,$4,$5,$6) returning *`,
    [
      body.name,
      body.unit,
      body.currency,
      String(body.creditsPerCurrency),
      body.status,
      body.note
    ]
  )
  await recordAudit(c, 'billing.plan.create', { type: 'billing_plan', id: row!.id }, {
    name: row!.name,
    unit: row!.unit,
    currency: row!.currency
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
       note = coalesce($7, note),
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

// ------------------------------------------------------------ 自助 / 流水

billingRoutes.get('/me', async (c) => {
  const user = c.get('user')
  const summary = await loadBillingSummary(user.id)
  const ledger = await query<LedgerRow>(
    `select * from balance_ledger where user_id = $1
      order by created_at desc limit 20`,
    [user.id]
  )
  return c.json({
    plan: summary.planDto,
    balance: summary.balance,
    unit: summary.plan?.unit ?? '',
    currency: summary.plan?.currency ?? '',
    windows: summary.windows,
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
