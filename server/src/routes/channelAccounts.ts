/**
 * 渠道的上游账户（`/api/channels/:id/accounts`）。
 *
 * 单独一个文件而不是塞进 channels.ts：账户是**嵌套资源**，
 * 混进渠道 CRUD 会让那个文件继续膨胀，也让"改账户"与"改渠道"的权限、
 * 审计口径看起来像同一件事（其实不是）。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { env } from '../env.js'
import { encryptSecret, maskSecret } from '../lib/crypto.js'
import { ApiError, badRequest, notFound, parseJson } from '../lib/http.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import {
  countAccounts,
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  markAccountSuccess,
  mirrorChannelKey,
  updateAccount
} from '../services/accounts.js'
import { recordAudit } from '../services/audit.js'
import { tryDecryptKey } from '../services/channels.js'
import { getUsageAdapter } from '../services/usage.js'
import { one } from '../db.js'
import { toAccountDto, type ChannelAccountRow, type ChannelRow } from '../types.js'

export const channelAccountRoutes = new Hono()

channelAccountRoutes.use('*', requireAuth)

const uuid = z.string().uuid()

/** 每渠道账户上限：防误操作把账户刷成几百个 */
const MAX_ACCOUNTS = 20

const accountShape = {
  name: z.string().max(64),
  apiKey: z.string().max(500),
  status: z.enum(['active', 'disabled']),
  priority: z.coerce.number().int().min(0).max(10_000),
  weight: z.coerce.number().int().min(1).max(1000),
  note: z.string().max(500),
  usageAdapter: z.string().max(64),
  usageUrl: z.string().max(500)
}

const createSchema = z.object(accountShape).partial().extend({
  name: z.string().max(64).optional(),
  apiKey: z.string().max(500).optional()
})

const updateSchema = z.object(accountShape).partial().extend({
  clearApiKey: z.boolean().optional()
})

function accountDtoOf(a: ChannelAccountRow) {
  const key = tryDecryptKey(a.key_cipher)
  const masked = key === null ? '（密文无法解密，请重新填写）' : key ? maskSecret(key) : ''
  return toAccountDto(a, masked)
}

async function channelOf(channelId: string): Promise<ChannelRow> {
  const ch = await one<ChannelRow>('select * from channels where id = $1', [channelId])
  if (!ch) throw notFound('渠道不存在')
  return ch
}

/** 适配器必须存在（留空 = 继承渠道） */
function assertAdapter(adapter: string | undefined): void {
  if (adapter && !getUsageAdapter(adapter)) throw badRequest(`未知的余额适配器「${adapter}」`)
}

channelAccountRoutes.get('/:id/accounts', async (c) => {
  const channelId = uuid.parse(c.req.param('id'))
  await channelOf(channelId)
  const rows = await listAccounts(channelId)
  return c.json({ accounts: rows.map(accountDtoOf) })
})

channelAccountRoutes.post('/:id/accounts', requireAdmin, async (c) => {
  const channelId = uuid.parse(c.req.param('id'))
  const ch = await channelOf(channelId)
  const body = await parseJson(c, createSchema)
  assertAdapter(body.usageAdapter)

  if ((await countAccounts(channelId)) >= MAX_ACCOUNTS) {
    throw badRequest(`每个渠道最多 ${MAX_ACCOUNTS} 个账户`)
  }

  const row = await createAccount(channelId, {
    name: body.name?.trim() || '备用账户',
    keyCipher: body.apiKey ? encryptSecret(body.apiKey, env.masterKey) : '',
    status: body.status,
    priority: body.priority,
    weight: body.weight,
    note: body.note,
    usageAdapter: body.usageAdapter,
    usageUrl: body.usageUrl
  })
  await mirrorChannelKey(channelId)

  await recordAudit(c, 'channel_account.create', { type: 'channel', id: channelId }, {
    channel: ch.name,
    account: row.name,
    priority: row.priority,
    weight: row.weight
  })

  return c.json({ account: accountDtoOf(row) }, 201)
})

channelAccountRoutes.patch('/:id/accounts/:aid', requireAdmin, async (c) => {
  const channelId = uuid.parse(c.req.param('id'))
  const accountId = uuid.parse(c.req.param('aid'))
  const ch = await channelOf(channelId)
  const body = await parseJson(c, updateSchema)
  assertAdapter(body.usageAdapter)

  const current = await getAccount(channelId, accountId)
  if (!current) throw notFound('账户不存在')

  // 密钥：显式清除 > 提供了新值 > 保持不变
  let keyCipher: string | undefined
  if (body.clearApiKey) keyCipher = ''
  else if (body.apiKey) keyCipher = encryptSecret(body.apiKey, env.masterKey)

  const row = await updateAccount(channelId, accountId, {
    name: body.name?.trim() || undefined,
    keyCipher,
    status: body.status,
    priority: body.priority,
    weight: body.weight,
    note: body.note,
    usageAdapter: body.usageAdapter,
    usageUrl: body.usageUrl
  })
  if (!row) throw notFound('账户不存在')
  await mirrorChannelKey(channelId)

  await recordAudit(c, 'channel_account.update', { type: 'channel', id: channelId }, {
    channel: ch.name,
    account: row.name,
    changedFields: Object.keys(body)
  })

  return c.json({ account: accountDtoOf(row) })
})

channelAccountRoutes.delete('/:id/accounts/:aid', requireAdmin, async (c) => {
  const channelId = uuid.parse(c.req.param('id'))
  const accountId = uuid.parse(c.req.param('aid'))
  const ch = await channelOf(channelId)

  const target = await getAccount(channelId, accountId)
  if (!target) throw notFound('账户不存在')

  // 不变式：任何渠道至少一个账户 —— 否则请求路径会出现"没有可用账户"
  if ((await countAccounts(channelId)) <= 1) {
    throw new ApiError(
      409,
      'last_account',
      '这是该渠道唯一的账户，不能删除（可先新建一个再删这个）'
    )
  }

  await deleteAccount(channelId, accountId)
  await mirrorChannelKey(channelId)

  await recordAudit(c, 'channel_account.delete', { type: 'channel', id: channelId }, {
    channel: ch.name,
    account: target.name
  })

  return c.json({ ok: true })
})

/** 清除冷却与失败计数：账户被误判时手动恢复，不必干等 10 分钟 */
channelAccountRoutes.post('/:id/accounts/:aid/reset-health', requireAdmin, async (c) => {
  const channelId = uuid.parse(c.req.param('id'))
  const accountId = uuid.parse(c.req.param('aid'))
  await channelOf(channelId)

  const target = await getAccount(channelId, accountId)
  if (!target) throw notFound('账户不存在')
  await markAccountSuccess(accountId)

  const row = await getAccount(channelId, accountId)
  return c.json({ account: accountDtoOf(row!) })
})

/** 查看账户密钥明文：仅管理员，且必然留审计（与渠道 reveal 同一套约束） */
channelAccountRoutes.get('/:id/accounts/:aid/reveal', requireAdmin, async (c) => {
  const channelId = uuid.parse(c.req.param('id'))
  const accountId = uuid.parse(c.req.param('aid'))
  const ch = await channelOf(channelId)

  const account = await getAccount(channelId, accountId)
  if (!account) throw notFound('账户不存在')
  if (!account.key_cipher) {
    throw new ApiError(409, 'account_key_empty', '该账户没有配置密钥')
  }

  const key = tryDecryptKey(account.key_cipher)
  if (key === null) {
    throw new ApiError(
      500,
      'account_key_decrypt_failed',
      '密钥解密失败：主密钥可能已变更（PORTARA_MASTER_KEY）'
    )
  }

  await recordAudit(c, 'channel_account.reveal', { type: 'channel', id: channelId }, {
    channel: ch.name,
    account: account.name
  })

  return c.json({ key, account: account.name, channel: ch.name })
})
