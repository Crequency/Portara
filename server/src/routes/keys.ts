import { Hono } from 'hono'
import { z } from 'zod'
import { one, query } from '../db.js'
import { generateApiKey } from '../lib/crypto.js'
import { badRequest, notFound, parseJson } from '../lib/http.js'
import { requireAuth } from '../middleware/auth.js'
import { toApiKeyDto, type ApiKeyRow } from '../types.js'

export const keyRoutes = new Hono()

keyRoutes.use('*', requireAuth)

const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '非法 ID')

const createSchema = z.object({
  name: z.string().min(1, '名称不能为空').max(64),
  userId: z.string().optional().nullable(),
  channelId: z.string().optional().nullable(),
  modelAllow: z.array(z.string().min(1)).default([]),
  rpmLimit: z.coerce.number().int().min(0).max(1_000_000).default(60),
  quotaTokens: z.coerce.number().int().min(0).default(0),
  expiresAt: z.string().optional().nullable()
})

const updateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  channelId: z.string().optional().nullable(),
  modelAllow: z.array(z.string().min(1)).optional(),
  rpmLimit: z.coerce.number().int().min(0).max(1_000_000).optional(),
  quotaTokens: z.coerce.number().int().min(0).optional(),
  expiresAt: z.string().optional().nullable()
})

async function assertRefs(userId?: string | null, channelId?: string | null) {
  if (userId) {
    const u = await one('select id from users where id = $1', [userId])
    if (!u) throw badRequest('指定的用户不存在')
  }
  if (channelId) {
    const ch = await one('select id from channels where id = $1', [channelId])
    if (!ch) throw badRequest('指定的渠道不存在')
  }
}

keyRoutes.get('/', async (c) => {
  const rows = await query<ApiKeyRow>('select * from api_keys order by created_at desc')
  return c.json({ keys: rows.map(toApiKeyDto) })
})

/** 创建密钥：明文只在本次响应中出现，之后无法再取回 */
keyRoutes.post('/', async (c) => {
  const body = await parseJson(c, createSchema)
  await assertRefs(body.userId, body.channelId)

  const { key, prefix, hash } = generateApiKey()

  const row = await one<ApiKeyRow>(
    `insert into api_keys
       (name, key_prefix, key_hash, user_id, channel_id, model_allow, rpm_limit, quota_tokens, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [
      body.name,
      prefix,
      hash,
      body.userId || null,
      body.channelId || null,
      body.modelAllow,
      body.rpmLimit,
      body.quotaTokens,
      body.expiresAt ? new Date(body.expiresAt) : null
    ]
  )

  return c.json({ apiKey: toApiKeyDto(row!), key }, 201)
})

keyRoutes.patch('/:id', async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const body = await parseJson(c, updateSchema)

  const current = await one<ApiKeyRow>('select * from api_keys where id = $1', [id])
  if (!current) throw notFound('密钥不存在')
  await assertRefs(null, body.channelId)

  const row = await one<ApiKeyRow>(
    `update api_keys set
       name         = coalesce($2, name),
       status       = coalesce($3, status),
       channel_id   = $4,
       model_allow  = coalesce($5, model_allow),
       rpm_limit    = coalesce($6, rpm_limit),
       quota_tokens = coalesce($7, quota_tokens),
       expires_at   = $8
     where id = $1
     returning *`,
    [
      id,
      body.name ?? null,
      body.status ?? null,
      body.channelId === undefined ? current.channel_id : body.channelId || null,
      body.modelAllow ?? null,
      body.rpmLimit ?? null,
      body.quotaTokens ?? null,
      body.expiresAt === undefined
        ? current.expires_at
        : body.expiresAt
          ? new Date(body.expiresAt)
          : null
    ]
  )
  return c.json({ apiKey: toApiKeyDto(row!) })
})

/** 轮换：生成新明文，旧 Key 立即失效（id 与配额用量保留） */
keyRoutes.post('/:id/rotate', async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const current = await one<ApiKeyRow>('select * from api_keys where id = $1', [id])
  if (!current) throw notFound('密钥不存在')

  const { key, prefix, hash } = generateApiKey()
  const row = await one<ApiKeyRow>(
    `update api_keys set key_prefix = $2, key_hash = $3 where id = $1 returning *`,
    [id, prefix, hash]
  )
  return c.json({ apiKey: toApiKeyDto(row!), key })
})

keyRoutes.delete('/:id', async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const current = await one('select id from api_keys where id = $1', [id])
  if (!current) throw notFound('密钥不存在')
  await query('delete from api_keys where id = $1', [id])
  return c.json({ ok: true })
})
