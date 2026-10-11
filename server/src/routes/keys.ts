import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import { one, query } from '../db.js'
import { env } from '../env.js'
import { decryptSecret, encryptSecret, generateApiKey } from '../lib/crypto.js'
import { ApiError, badRequest, forbidden, notFound, parseJson } from '../lib/http.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import { recordAudit } from '../services/audit.js'
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
  /** 能否读取余额/用量；默认 false（余额反映资金状况，不默认开放） */
  usageAllow: z.boolean().default(false),
  /** 可见渠道范围；空数组 = 全部已配置余额适配器的渠道 */
  usageChannels: z.array(z.string().min(1)).default([]),
  /** 能否 ?refresh=1 强制刷新；默认 false（否则等于给了个打上游的开关） */
  usageRefresh: z.boolean().default(false),
  rpmLimit: z.coerce.number().int().min(0).max(1_000_000).default(60),
  quotaTokens: z.coerce.number().int().min(0).default(0),
  expiresAt: z.string().optional().nullable()
})

const updateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  channelId: z.string().optional().nullable(),
  modelAllow: z.array(z.string().min(1)).optional(),
  usageAllow: z.boolean().optional(),
  usageChannels: z.array(z.string().min(1)).optional(),
  usageRefresh: z.boolean().optional(),
  rpmLimit: z.coerce.number().int().min(0).max(1_000_000).optional(),
  quotaTokens: z.coerce.number().int().min(0).optional(),
  expiresAt: z.string().optional().nullable()
})

/**
 * 归属校验：管理员可管全部；非管理员只能操作**自己名下**的密钥。
 * 列表过滤只是体验，这里才是权限边界 —— 否则改个 id 就能动别人的 Key。
 */
function assertCanManage(c: Context, key: ApiKeyRow): void {
  const user = c.get('user')
  if (user.role === 'admin') return
  if (key.user_id && key.user_id === user.id) return
  throw forbidden('只能操作自己名下的密钥')
}

/** 写操作后重新读取（带所有者 join），保证响应形状与列表接口一致 */
async function loadKeyWithOwner(id: string): Promise<ApiKeyRow | null> {
  return one<ApiKeyRow>(
    `select k.*, u.username as owner_name
       from api_keys k left join users u on u.id = k.user_id
      where k.id = $1`,
    [id]
  )
}

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
  const user = c.get('user')
  const base = `select k.*, u.username as owner_name
                  from api_keys k left join users u on u.id = k.user_id`

  // 普通用户只看得到自己名下的密钥；管理员看全部并显示所有者
  const rows =
    user.role === 'admin'
      ? await query<ApiKeyRow>(`${base} order by k.created_at desc`)
      : await query<ApiKeyRow>(
          `${base} where k.user_id = $1 order by k.created_at desc`,
          [user.id]
        )

  return c.json({ keys: rows.map(toApiKeyDto) })
})

/** 创建密钥：明文只在本次响应中出现，之后无法再取回 */
keyRoutes.post('/', async (c) => {
  const body = await parseJson(c, createSchema)
  const actor = c.get('user')
  // 非管理员强制归属自己 —— 不允许替别人签发
  const ownerId = actor.role === 'admin' ? body.userId || actor.id : actor.id
  await assertRefs(ownerId, body.channelId)

  const { key, prefix, hash } = generateApiKey()

  const row = await one<ApiKeyRow>(
    `insert into api_keys
       (name, key_prefix, key_hash, key_cipher, user_id, channel_id, model_allow, rpm_limit,
        quota_tokens, expires_at, usage_allow, usage_channels, usage_refresh)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
    [
      body.name,
      prefix,
      hash,
      // 可解密副本，供管理员在面板上查看与复制（见 DECISIONS D-013）
      encryptSecret(key, env.masterKey),
      ownerId,
      body.channelId || null,
      body.modelAllow,
      body.rpmLimit,
      body.quotaTokens,
      body.expiresAt ? new Date(body.expiresAt) : null,
      body.usageAllow,
      body.usageChannels,
      body.usageRefresh
    ]
  )

  const created = await loadKeyWithOwner(row!.id)

  await recordAudit(c, 'key.create', { type: 'api_key', id: row!.id }, {
    name: row!.name,
    prefix: row!.key_prefix
  })

  return c.json({ apiKey: toApiKeyDto(created ?? row!), key }, 201)
})

keyRoutes.patch('/:id', async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const body = await parseJson(c, updateSchema)

  const current = await one<ApiKeyRow>('select * from api_keys where id = $1', [id])
  if (!current) throw notFound('密钥不存在')
  assertCanManage(c, current)
  await assertRefs(null, body.channelId)

  const row = await one<ApiKeyRow>(
    `update api_keys set
       name         = coalesce($2, name),
       status       = coalesce($3, status),
       channel_id   = $4,
       model_allow  = coalesce($5, model_allow),
       rpm_limit    = coalesce($6, rpm_limit),
       quota_tokens = coalesce($7, quota_tokens),
       expires_at   = $8,
       usage_allow    = coalesce($9,  usage_allow),
       usage_channels = coalesce($10, usage_channels),
       usage_refresh  = coalesce($11, usage_refresh)
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
          : null,
      body.usageAllow ?? null,
      body.usageChannels ?? null,
      body.usageRefresh ?? null
    ]
  )
  return c.json({ apiKey: toApiKeyDto((await loadKeyWithOwner(id)) ?? row!) })
})

/**
 * 查看明文密钥：管理员可看全部，普通用户可看**自己名下**的；必然留审计（见 D-013）。
 */
keyRoutes.get('/:id/reveal', async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const row = await one<ApiKeyRow>('select * from api_keys where id = $1', [id])
  if (!row) throw notFound('密钥不存在')
  assertCanManage(c, row)

  if (!row.key_cipher) {
    // 旧数据没有可解密副本 —— 诚实告知，而不是假装能恢复
    throw new ApiError(
      409,
      'key_not_revealable',
      '该密钥创建于启用「可查看」之前，服务端只保留哈希，无法找回。请使用轮换生成新密钥。'
    )
  }

  let key: string
  try {
    key = decryptSecret(row.key_cipher, env.masterKey)
  } catch {
    throw new ApiError(
      500,
      'key_decrypt_failed',
      '密钥解密失败：主密钥可能已变更（PORTARA_MASTER_KEY）'
    )
  }

  // 审计写入失败会让整个请求失败（fail-closed），不留无声的痕迹
  await recordAudit(c, 'key.reveal', { type: 'api_key', id }, {
    name: row.name,
    prefix: row.key_prefix
  })

  return c.json({ key, keyPrefix: row.key_prefix, name: row.name })
})

/** 轮换：生成新明文，旧 Key 立即失效（id 与配额用量保留） */
keyRoutes.post('/:id/rotate', async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const current = await one<ApiKeyRow>('select * from api_keys where id = $1', [id])
  if (!current) throw notFound('密钥不存在')
  assertCanManage(c, current)

  const { key, prefix, hash } = generateApiKey()
  const row = await one<ApiKeyRow>(
    `update api_keys
        set key_prefix = $2, key_hash = $3, key_cipher = $4
      where id = $1 returning *`,
    [id, prefix, hash, encryptSecret(key, env.masterKey)]
  )

  await recordAudit(c, 'key.rotate', { type: 'api_key', id }, {
    name: current.name,
    newPrefix: prefix
  })

  return c.json({ apiKey: toApiKeyDto((await loadKeyWithOwner(id)) ?? row!), key })
})

keyRoutes.delete('/:id', async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const current = await one<ApiKeyRow>('select * from api_keys where id = $1', [id])
  if (!current) throw notFound('密钥不存在')
  assertCanManage(c, current)
  await query('delete from api_keys where id = $1', [id])
  await recordAudit(c, 'key.delete', { type: 'api_key', id }, {
    name: current.name,
    prefix: current.key_prefix
  })
  return c.json({ ok: true })
})
