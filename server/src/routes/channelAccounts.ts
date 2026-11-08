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
import { getUsageSnapshot, invalidateUsageCache } from '../services/usageFetch.js'
import {
  clearWebSession,
  cookieNamesOf,
  getWebSessionStatus,
  loadWebSnapshot,
  parseWebSessionInput,
  saveWebSession,
  saveWebSnapshot,
  validateCookieText
} from '../services/webSession.js'
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

channelAccountRoutes.get('/:id/accounts', requireAdmin, async (c) => {
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

/** 该适配器是否使用网页会话（决定 Cookie 存进去到底会不会被用到） */
function isSessionAdapter(adapterId: string): boolean {
  return getUsageAdapter(adapterId)?.auth === 'session-cookie'
}

/**
 * 账户的网页会话状态（供渠道详情页展示）。
 *
 * 只回 Cookie 名与时间戳，**绝不回值或密文** —— 面板只需要知道「有没有 / 什么时候失效」。
 */
channelAccountRoutes.get('/:id/accounts/:aid/web-session', requireAdmin, async (c) => {
  const channelId = uuid.parse(c.req.param('id'))
  const accountId = uuid.parse(c.req.param('aid'))
  const ch = await channelOf(channelId)

  const account = await getAccount(channelId, accountId)
  if (!account) throw notFound('账户不存在')

  const status = await getWebSessionStatus(accountId)
  const snapshotInfo = await loadWebSnapshot(accountId)
  /*
   * 状态给两种形状：平铺字段（本契约）与 `status` 包装。
   * 两者内容完全相同 —— 面板两种写法都在用，多一个键比让人猜形状便宜。
   */
  return c.json({
    ...status,
    status,
    /** 手动快照（浏览器内调用接口的结果）：有它就能在会话失效时垫底 */
    hasSnapshot: snapshotInfo !== null,
    snapshotAt: snapshotInfo?.snapshotAt ?? null,
    usageAdapter: account.usage_adapter || ch.usage_adapter,
    sessionAdapter: isSessionAdapter(account.usage_adapter || ch.usage_adapter)
  })
})

const webSessionSchema = z.object({ cookie: z.string() })

/**
 * 粘贴 / 覆盖网页 Cookie。
 *
 * 存库后**立刻试跑一次**余额刷新并把结果回给前端 —— 光看「保存成功」没法判断
 * Cookie 是否真的有效，试跑才是唯一的证据。
 *
 * 安全：审计只记 Cookie 名，绝不记值。
 */
channelAccountRoutes.post('/:id/accounts/:aid/web-session', requireAdmin, async (c) => {
  const channelId = uuid.parse(c.req.param('id'))
  const accountId = uuid.parse(c.req.param('aid'))
  const ch = await channelOf(channelId)

  const body = await parseJson(c, webSessionSchema)
  /*
   * 四种粘贴形态都接受（见 parseWebSessionInput）：
   *   ① 控制台脚本输出的快照包（cookie + me 一起）
   *   ② 直接粘的 /api/v1/me 响应 JSON（只有快照）
   *   ③ 整条 cURL 命令（从里面提 Cookie）
   *   ④ 裸 Cookie / "Cookie: ..." 行
   *
   * 为什么要快照这条路：会话 Cookie 大概率是 HttpOnly，JS 读不到；
   * 即使拿到了，服务端重放还可能被 Cloudflare / 设备指纹判无效。
   * 让用户在自己的浏览器里调接口、把结果粘过来，这条路必然可行。
   */
  const bundle = parseWebSessionInput(body.cookie)
  const cookieText = bundle.cookie
  const hasCookie = cookieText.trim() !== ''
  const hasSnapshot = bundle.snapshot !== null
  if (!hasCookie && !hasSnapshot) throw badRequest('请粘贴 Cookie、cURL 命令，或控制台脚本输出的快照 JSON')

  if (hasCookie) {
    const problem = validateCookieText(cookieText)
    if (problem) throw badRequest(problem)
  }

  const account = await getAccount(channelId, accountId)
  if (!account) throw notFound('账户不存在')

  const effectiveAdapter = account.usage_adapter || ch.usage_adapter
  /*
   * 不拦非会话型适配器：允许「先把 Cookie 存好、再去改适配器」的顺序，
   * 但要在响应里明说它现在用不上 —— 静默存下去只会让人以为已经生效。
   */
  const sessionAdapter = isSessionAdapter(effectiveAdapter)

  const cookieNames = cookieNamesOf(cookieText)
  if (hasCookie) {
    await saveWebSession(accountId, cookieText)
  }
  if (hasSnapshot) {
    /*
     * 快照单独存：它和 Cookie 是两条独立的数据来源。
     * 用户只粘了一个 /api/v1/me JSON 时，也能立刻在面板上看到用量。
     */
    await saveWebSnapshot(accountId, bundle.snapshot, bundle.snapshotAt)
  }
  await invalidateUsageCache(channelId)

  // 立刻试跑：让调用方当场知道粘贴的 Cookie 到底能不能读
  const snapshot = await getUsageSnapshot(channelId, { force: true })
  const mine = snapshot.accounts.find((a) => a.accountId === accountId)
  const ok = mine ? mine.ok : false
  const error = mine ? (mine.error ?? '') : (snapshot.error ?? '')

  await recordAudit(c, 'channel_account.web_session.save', { type: 'channel', id: channelId }, {
    channel: ch.name,
    account: account.name,
    // 只记名，不记值 —— Cookie 等同于凭据
    cookieNames,
    /** 本次是否同时更新了快照（快照不含凭据，可以记） */
    snapshot: hasSnapshot,
    adapter: effectiveAdapter,
    ok
  })

  const status = await getWebSessionStatus(accountId)
  return c.json({
    ok,
    error,
    /** 该账户当前的适配器是否真的会用这份 Cookie */
    sessionAdapter,
    warning: sessionAdapter
      ? undefined
      : `该账户当前的余额适配器「${effectiveAdapter || '未配置'}」不使用网页会话，这份 Cookie 暂时用不上`,
    status,
    /** 与 status 同值（面板的另一种写法） */
    session: status,
    /** 试跑结果：前端按 snapshot 或 usage 取用都行 */
    snapshot,
    usage: snapshot
  })
})

/** 清除网页会话（Cookie 失效后的常规操作，同样留审计） */
channelAccountRoutes.delete('/:id/accounts/:aid/web-session', requireAdmin, async (c) => {
  const channelId = uuid.parse(c.req.param('id'))
  const accountId = uuid.parse(c.req.param('aid'))
  const ch = await channelOf(channelId)

  const account = await getAccount(channelId, accountId)
  if (!account) throw notFound('账户不存在')

  await clearWebSession(accountId)
  await invalidateUsageCache(channelId)

  await recordAudit(c, 'channel_account.web_session.clear', { type: 'channel', id: channelId }, {
    channel: ch.name,
    account: account.name
  })

  return c.json({ ok: true, status: await getWebSessionStatus(accountId) })
})

