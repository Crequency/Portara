import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import { one, pool, query } from '../db.js'
import { ApiError, badRequest, notFound, parseJson } from '../lib/http.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import { recordAudit } from '../services/audit.js'
import {
  flattenJsonMapping,
  resolveChannelRefs,
  type ChannelRef,
  type IncomingRoute
} from '../services/mapping.js'
import { toModelRouteDto, type ModelRouteRow } from '../types.js'

export const modelRouteRoutes = new Hono()

modelRouteRoutes.use('*', requireAuth)

const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '非法 ID')

/**
 * 模型 id 允许：字母数字与 . _ : @ + - ，可含 `/` 分段（如 opencode-go/deepseek-flash）。
 * 不允许空白与控制字符 —— 它会被原样回显给调用方，也会进日志。
 */
const aliasSchema = z
  .string()
  .min(1, '模型 id 不能为空')
  .max(128, '模型 id 过长（上限 128）')
  .regex(
    /^[A-Za-z0-9._:@+-]+(?:\/[A-Za-z0-9._:@+-]+)*$/,
    '模型 id 只能包含字母、数字与 . _ : @ + - ，可用 / 分段'
  )

const upstreamModelSchema = z.string().min(1, '上游模型 id 不能为空').max(128)

const LIST_SQL = `
  select r.*, c.name as channel_name, c.status as channel_status
    from model_routes r
    left join channels c on c.id = r.channel_id
   order by r.alias asc, r.priority asc, r.id asc
`

async function loadRoute(id: string): Promise<ModelRouteRow | null> {
  return one<ModelRouteRow>('select * from model_routes where id = $1', [id])
}

async function assertChannel(channelId: string): Promise<void> {
  const ch = await one('select id from channels where id = $1', [channelId])
  if (!ch) throw badRequest('指定的渠道不存在')
}

// ---------------------------------------------------------------- 查询

modelRouteRoutes.get('/', async (c) => {
  const rows = await query<ModelRouteRow>(LIST_SQL)
  return c.json({ routes: rows.map(toModelRouteDto) })
})

// ---------------------------------------------------------------- 单条增删改

const targetSchema = z.object({
  channelId: z.string().min(1),
  upstreamModel: upstreamModelSchema,
  priority: z.coerce.number().int().min(1).max(9999).default(100),
  weight: z.coerce.number().int().min(1).max(1000).default(1)
})

const createSchema = z.object({
  alias: aliasSchema,
  targets: z.array(targetSchema).min(1, '至少需要一个目标'),
  note: z.string().max(200).default('')
})

/** 为一个网关模型 id 建立若干目标（同一 alias 可对应多个渠道的多个模型） */
modelRouteRoutes.post('/', requireAdmin, async (c) => {
  const body = await parseJson(c, createSchema)
  for (const t of body.targets) await assertChannel(t.channelId)

  for (const t of body.targets) {
    await query(
      `insert into model_routes (alias, channel_id, upstream_model, priority, weight, note)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (alias, channel_id, upstream_model)
       do update set priority = excluded.priority,
                     weight   = excluded.weight,
                     note     = excluded.note,
                     status   = 'active',
                     updated_at = now()`,
      [body.alias, t.channelId, t.upstreamModel, t.priority, t.weight, body.note]
    )
  }

  await recordAudit(c, 'model_route.create', { type: 'model_route', id: body.alias }, {
    alias: body.alias,
    targets: body.targets.length
  })

  // 带 join 重新读取，保证响应形状与列表接口一致（含渠道名）
  const created = await query<ModelRouteRow>(
    `select r.*, c.name as channel_name, c.status as channel_status
       from model_routes r left join channels c on c.id = r.channel_id
      where r.alias = $1
      order by r.priority asc, r.id asc`,
    [body.alias]
  )

  return c.json({ routes: created.map(toModelRouteDto) }, 201)
})

const updateSchema = z.object({
  upstreamModel: upstreamModelSchema.optional(),
  priority: z.coerce.number().int().min(1).max(9999).optional(),
  weight: z.coerce.number().int().min(1).max(1000).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  note: z.string().max(200).optional()
})

modelRouteRoutes.patch('/:id', requireAdmin, async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const body = await parseJson(c, updateSchema)

  const current = await loadRoute(id)
  if (!current) throw notFound('映射不存在')

  const row = await one<ModelRouteRow>(
    `update model_routes set
       upstream_model = coalesce($2, upstream_model),
       priority       = coalesce($3, priority),
       weight         = coalesce($4, weight),
       status         = coalesce($5, status),
       note           = coalesce($6, note),
       updated_at     = now()
     where id = $1
     returning *`,
    [
      id,
      body.upstreamModel ?? null,
      body.priority ?? null,
      body.weight ?? null,
      body.status ?? null,
      body.note ?? null
    ]
  )
  return c.json({ route: toModelRouteDto(row!) })
})

modelRouteRoutes.delete('/:id', requireAdmin, async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const current = await loadRoute(id)
  if (!current) throw notFound('映射不存在')

  await query('delete from model_routes where id = $1', [id])
  await recordAudit(c, 'model_route.delete', { type: 'model_route', id }, {
    alias: current.alias,
    upstreamModel: current.upstream_model
  })
  return c.json({ ok: true })
})

// ---------------------------------------------------------------- 批量与整组

const batchSchema = z.object({
  channelId: z.string().min(1),
  /** 厂商渠道前缀，如 opencode-go → 生成 opencode-go/deepseek-flash */
  prefix: z.string().max(64).default(''),
  /** 要映射的上游模型 id 列表 */
  models: z.array(upstreamModelSchema).min(1, '至少选择一个模型'),
  priority: z.coerce.number().int().min(1).max(9999).default(100),
  weight: z.coerce.number().int().min(1).max(1000).default(1),
  note: z.string().max(200).default('')
})

/**
 * 批量映射：把某渠道的一批模型挂到 `<prefix>/<model>` 这个网关模型 id 下。
 *
 * 用 upsert 语义：**同一 alias 已存在时追加/更新目标而不是报错** ——
 * 这样「先给渠道 A 批量加前缀，再给渠道 B 批量加同一前缀」就自然形成
 * 一个 alias 到多渠道多模型的负载均衡。
 */
modelRouteRoutes.post('/batch', requireAdmin, async (c) => {
  const body = await parseJson(c, batchSchema)
  await assertChannel(body.channelId)

  const rawPrefix = body.prefix.trim().replace(/^\/+|\/+$/g, '')
  if (rawPrefix) aliasSchema.parse(rawPrefix)

  const results: { alias: string; upstreamModel: string; created: boolean }[] = []

  for (const model of body.models) {
    const alias = rawPrefix ? `${rawPrefix}/${model}` : model
    aliasSchema.parse(alias)

    const row = await one<ModelRouteRow & { inserted: boolean }>(
      `insert into model_routes (alias, channel_id, upstream_model, priority, weight, note)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (alias, channel_id, upstream_model)
       do update set priority = excluded.priority,
                     weight   = excluded.weight,
                     note     = excluded.note,
                     status   = 'active',
                     updated_at = now()
       returning *, (xmax = 0) as inserted`,
      [alias, body.channelId, model, body.priority, body.weight, body.note]
    )
    if (row) results.push({ alias, upstreamModel: model, created: row.inserted })
  }

  await recordAudit(c, 'model_route.batch', { type: 'model_route', id: body.channelId }, {
    prefix: rawPrefix,
    models: body.models.length
  })

  return c.json(
    {
      created: results.filter((r) => r.created).length,
      merged: results.filter((r) => !r.created).length,
      aliases: [...new Set(results.map((r) => r.alias))]
    },
    201
  )
})

const purgeSchema = z.object({ alias: aliasSchema })

/** 删除某个网关模型 id 的全部目标（按 alias 整组删除，不是按 id 一条条删） */
modelRouteRoutes.post('/purge', requireAdmin, async (c) => {
  const { alias } = await parseJson(c, purgeSchema)

  const rows = await query<{ count: string }>(
    'select count(*)::text as count from model_routes where alias = $1',
    [alias]
  )
  const removed = Number(rows[0]?.count ?? '0')
  if (removed === 0) throw notFound('该模型 id 没有任何映射')

  await query('delete from model_routes where alias = $1', [alias])
  await recordAudit(c, 'model_route.purge', { type: 'model_route', id: alias }, { removed })

  return c.json({ ok: true, removed })
})

// ---------------------------------------------------------------- JSON 导入

const jsonTargetSchema = z.object({
  channel: z.string().min(1, '缺少 channel'),
  model: z.string().min(1, '缺少 model').max(128),
  priority: z.coerce.number().int().min(1).max(9999).optional(),
  weight: z.coerce.number().int().min(1).max(1000).optional()
})

const importSchema = z.object({
  /**
   * replace：JSON 即全量映射列表（未出现的会被删除）
   * merge：只新增/更新 JSON 里出现的
   */
  mode: z.enum(['replace', 'merge']).default('replace'),
  /** alias → 单目标或目标数组 */
  mapping: z.record(z.string(), z.union([jsonTargetSchema, z.array(jsonTargetSchema)])),
  /**
   * replace 模式下必须回填「当前条数」以示确认。
   * 防的是「手滑/脚本盲目替换」—— 删除前必须知道会删掉多少。
   */
  acknowledgeRemove: z.coerce.number().int().min(0).optional()
})

/** 快照上限：超过则截断并标记，避免审计记录无限膨胀 */
const SNAPSHOT_LIMIT = 500

/**
 * 把当前映射导出为**与导入格式一致**的 JSON。
 * 这样一旦发生误删，直接从审计日志里把 snapshot 贴回 JSON 编辑器即可恢复。
 */
async function snapshotMappings(): Promise<{ data: Record<string, unknown>; truncated: boolean }> {
  const rows = await query<{
    alias: string
    channel_name: string | null
    upstream_model: string
    priority: number
    weight: number
  }>(
    `select r.alias, c.name as channel_name, r.upstream_model, r.priority, r.weight
       from model_routes r left join channels c on c.id = r.channel_id
      order by r.alias asc, r.priority asc, r.id asc`
  )

  const truncated = rows.length > SNAPSHOT_LIMIT
  const data: Record<string, unknown> = {}

  for (const r of rows.slice(0, SNAPSHOT_LIMIT)) {
    const target: Record<string, unknown> = {
      channel: r.channel_name ?? '',
      model: r.upstream_model
    }
    if (r.priority !== 100) target.priority = r.priority
    if (r.weight !== 1) target.weight = r.weight

    const existing = data[r.alias]
    if (existing === undefined) data[r.alias] = target
    else if (Array.isArray(existing)) existing.push(target)
    else data[r.alias] = [existing, target]
  }

  return { data, truncated }
}

/**
 * 以 JSON 形式整体编辑映射列表。
 *
 * 渠道用**名称**引用（人读写友好），服务端解析为 id 后落库；
 * 因此渠道改名后，重新导出即可得到新名字 —— 映射本身不会失联，
 * 因为它存的是 channel_id 外键而不是名字。
 */
modelRouteRoutes.post('/import', requireAdmin, async (c) => {
  const body = await parseJson(c, importSchema)

  const flattened = flattenJsonMapping(body.mapping as never)
  if (flattened.errors.length > 0) {
    throw badRequest('JSON 结构有问题', { issues: flattened.errors })
  }
  if (flattened.routes.length === 0) {
    throw badRequest('JSON 里没有任何映射')
  }

  // 别名格式校验（键来自 JSON，必须逐个校验）
  for (const r of flattened.routes) {
    const parsed = aliasSchema.safeParse(r.alias)
    if (!parsed.success) {
      throw badRequest(`模型 ID 非法：${r.alias}`, {
        issues: [parsed.error.issues[0]?.message ?? '格式错误']
      })
    }
  }

  const channels = await query<ChannelRef>('select id, name from channels order by name asc')
  const { resolved, unknown, duplicates, available } = resolveChannelRefs(
    flattened.routes as IncomingRoute[],
    channels
  )

  if (unknown.length > 0) {
    throw badRequest('引用了不存在的渠道', { unknown, available })
  }
  if (duplicates.length > 0) {
    throw badRequest('存在重复的映射目标', { issues: duplicates })
  }

  let removed = 0
  let snapshot: Record<string, unknown> = {}
  let snapshotTruncated = false

  // ① 替换前先取快照 —— 破坏性操作必须留下能回滚的证据
  if (body.mode === 'replace') {
    const snap = await snapshotMappings()
    snapshot = snap.data
    snapshotTruncated = snap.truncated
  }

  // ② 删除前必须确认条数（防手滑、防脚本盲目替换）
  if (body.mode === 'replace') {
    const cur = await query<{ n: number }>('select count(*)::int as n from model_routes')
    const existing = cur[0]?.n ?? 0
    if (existing > 0 && body.acknowledgeRemove !== existing) {
      throw new ApiError(
        409,
        'replace_needs_acknowledge',
        `替换全部会删除现有 ${existing} 条映射。请在请求中带上 acknowledgeRemove=${existing} 确认。`,
        { existing }
      )
    }
  }

  const client = await pool.connect()
  try {
    await client.query('begin')

    if (body.mode === 'replace') {
      const before = await client.query('select count(*)::int as n from model_routes')
      removed = before.rows[0]?.n ?? 0
      await client.query('delete from model_routes')
    }

    for (const r of resolved) {
      await client.query(
        `insert into model_routes (alias, channel_id, upstream_model, priority, weight)
         values ($1,$2,$3,$4,$5)
         on conflict (alias, channel_id, upstream_model)
         do update set priority = excluded.priority,
                       weight   = excluded.weight,
                       status   = 'active',
                       updated_at = now()`,
        [r.alias, r.channelId, r.upstreamModel, r.priority, r.weight]
      )
    }

    await client.query('commit')
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }

  await recordAudit(c, 'model_route.import', { type: 'model_route', id: body.mode }, {
    mode: body.mode,
    applied: resolved.length,
    removed: body.mode === 'replace' ? removed : 0,
    // 误删时的恢复来源：把 snapshot 原样贴回 JSON 编辑器即可
    ...(body.mode === 'replace' ? { snapshot, snapshotTruncated } : {})
  })

  return c.json({
    mode: body.mode,
    applied: resolved.length,
    removed: body.mode === 'replace' ? removed : 0
  })
})
