/**
 * 代理配置（仅管理员）。
 *
 * 密码与上游渠道密钥同规格：AES-256-GCM 加密存储、界面只显示掩码、
 * 管理员可显式查看（留审计）。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { one, query } from '../db.js'
import { env } from '../env.js'
import { decryptSecret, encryptSecret } from '../lib/crypto.js'
import { ApiError, badRequest, notFound, parseJson } from '../lib/http.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import { recordAudit } from '../services/audit.js'
import { buildUpstreamHeaders, buildUpstreamUrl, parseJsonSafe } from '../services/proxy.js'
import { upstreamFetch, type ProxyTarget } from '../services/proxyAgent.js'
import { getProxyTarget } from '../services/proxies.js'
import { toProxyDto, type ChannelRow, type ProxyRow } from '../types.js'

export const proxyRoutes = new Hono()

proxyRoutes.use('*', requireAuth)
proxyRoutes.use('*', requireAdmin)

const uuidSchema = z.string().uuid()

const baseFields = {
  name: z.string().trim().min(1, '名称不能为空').max(64),
  host: z
    .string()
    .trim()
    .min(1, '主机不能为空')
    .max(255)
    // 只接受主机名/IP，不接受带协议或路径的串 —— 避免把 http:// 和端口重复写进来
    .refine((v) => !/^[a-z]+:\/\//i.test(v), '主机只填主机名或 IP，不要带 http:// ')
    .refine((v) => !v.includes('/'), '主机不要带路径'),
  port: z.coerce.number().int().min(1, '端口需在 1-65535').max(65535, '端口需在 1-65535'),
  username: z.string().trim().max(128).default(''),
  status: z.enum(['active', 'disabled']).default('active'),
  note: z.string().max(500).default('')
}

const createSchema = z.object({
  ...baseFields,
  password: z.string().max(256).default('')
})

const updateSchema = z
  .object({ ...baseFields })
  .partial()
  .extend({
    name: baseFields.name.optional(),
    host: baseFields.host.optional(),
    port: baseFields.port.optional(),
    password: z.string().max(256).optional(),
    clearPassword: z.boolean().optional()
  })

proxyRoutes.get('/', async (c) => {
  const rows = await query<ProxyRow>('select * from proxies order by name asc')

  // 每个代理被多少渠道使用 —— 删除前要能看清影响面
  const usage = await query<{ proxy_id: string; n: string }>(
    `select proxy_id, count(*)::text as n from channels
      where proxy_id is not null group by proxy_id`
  )
  const usageMap = new Map(usage.map((u) => [u.proxy_id, Number(u.n)]))

  return c.json({
    proxies: rows.map((r) => ({ ...toProxyDto(r), channelCount: usageMap.get(r.id) ?? 0 }))
  })
})

proxyRoutes.post('/', async (c) => {
  const body = await parseJson(c, createSchema)

  const exists = await one<{ id: string }>('select id from proxies where name = $1', [body.name])
  if (exists) throw badRequest(`代理名称「${body.name}」已存在`)

  const row = await one<ProxyRow>(
    `insert into proxies (name, host, port, username, password_cipher, status, note)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [
      body.name,
      body.host,
      body.port,
      body.username,
      body.password ? encryptSecret(body.password, env.masterKey) : '',
      body.status,
      body.note
    ]
  )

  await recordAudit(c, 'proxy.create', { type: 'proxy', id: row!.id }, { name: row!.name })
  return c.json({ proxy: { ...toProxyDto(row!), channelCount: 0 } }, 201)
})

proxyRoutes.patch('/:id', async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const body = await parseJson(c, updateSchema)

  const current = await one<ProxyRow>('select * from proxies where id = $1', [id])
  if (!current) throw notFound('代理不存在')

  if (body.name && body.name !== current.name) {
    const dup = await one<{ id: string }>(
      'select id from proxies where name = $1 and id <> $2',
      [body.name, id]
    )
    if (dup) throw badRequest(`代理名称「${body.name}」已存在`)
  }

  // 密码：显式清除 > 提供了新值 > 保持不变
  let cipher = current.password_cipher
  if (body.clearPassword) cipher = ''
  else if (body.password) cipher = encryptSecret(body.password, env.masterKey)

  const row = await one<ProxyRow>(
    `update proxies set
       name            = coalesce($2, name),
       host            = coalesce($3, host),
       port            = coalesce($4, port),
       username        = coalesce($5, username),
       password_cipher = $6,
       status          = coalesce($7, status),
       note            = coalesce($8, note),
       updated_at      = now()
     where id = $1 returning *`,
    [
      id,
      body.name ?? null,
      body.host ?? null,
      body.port ?? null,
      body.username ?? null,
      cipher,
      body.status ?? null,
      body.note ?? null
    ]
  )

  await recordAudit(c, 'proxy.update', { type: 'proxy', id }, { name: row!.name })
  return c.json({ proxy: toProxyDto(row!) })
})

proxyRoutes.delete('/:id', async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const current = await one<ProxyRow>('select * from proxies where id = $1', [id])
  if (!current) throw notFound('代理不存在')

  // 引用它的渠道会因 on delete set null 自动回到直连 —— 审计里要记清影响面
  const affected = await query<{ name: string }>(
    'select name from channels where proxy_id = $1',
    [id]
  )
  await query('delete from proxies where id = $1', [id])

  await recordAudit(c, 'proxy.delete', { type: 'proxy', id }, {
    name: current.name,
    unboundChannels: affected.map((a) => a.name)
  })

  return c.json({ ok: true, unboundChannels: affected.map((a) => a.name) })
})

/** 查看代理密码明文（管理员，留审计 —— 与上游渠道密钥同规格） */
proxyRoutes.get('/:id/reveal', async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const row = await one<ProxyRow>('select * from proxies where id = $1', [id])
  if (!row) throw notFound('代理不存在')
  if (!row.password_cipher) {
    return c.json({ error: { message: '该代理没有设置密码' } }, 409)
  }

  await recordAudit(c, 'proxy.reveal', { type: 'proxy', id }, { name: row.name })
  return c.json({ password: decryptSecret(row.password_cipher, env.masterKey) })
})

// ---------------------------------------------------------------- 延迟对比

const latencySchema = z.object({
  channelId: uuidSchema,
  proxyId: uuidSchema
})

interface Probe {
  ok: boolean
  status: number
  latencyMs: number
  error?: string
}

/**
 * 对同一渠道分别用「直连」与「走代理」各探一次，给管理员一个可比的数据。
 *
 * 探测目标用渠道的**模型列表端点**（只读、不消耗 token），
 * 走的是与真实转发同一套请求头与地址解析。
 *
 * 串行执行而非并行：并发会互相抢带宽，测出来的差值是假的。
 */
proxyRoutes.post('/latency-test', async (c) => {
  const body = await parseJson(c, latencySchema)

  const ch = await one<ChannelRow>('select * from channels where id = $1', [body.channelId])
  if (!ch) throw notFound('渠道不存在')

  const proxy = await getProxyTarget(body.proxyId)
  if (!proxy) throw badRequest('代理不存在或已停用')

  let upstreamKey = ''
  if (ch.api_key_cipher) {
    try {
      upstreamKey = decryptSecret(ch.api_key_cipher, env.masterKey)
    } catch {
      throw badRequest('该渠道的密钥无法解密，请重新填写')
    }
  }

  const url = buildUpstreamUrl(ch.base_url, ch.models_path ?? '/models')
  const headers = buildUpstreamHeaders(upstreamKey, 'application/json', {
    extraHeaders: ch.extra_headers ?? {},
    vendor: ch.vendor,
    protocol: ch.protocol === 'anthropic' ? 'anthropic' : 'openai',
    channelId: ch.id
  }).headers

  const probe = async (target: ProxyTarget | null): Promise<Probe> => {
    const startedAt = Date.now()
    try {
      const res = await upstreamFetch(
        url,
        { headers, signal: AbortSignal.timeout(Math.min(ch.timeout_ms, 30_000)) },
        target
      )
      // 必须读掉 body，否则测的只是「连上了」而不是「拿到了」
      const text = await res.text()
      const parsed = parseJsonSafe(text)
      const latencyMs = Date.now() - startedAt

      if (!res.ok) {
        return { ok: false, status: res.status, latencyMs, error: text.slice(0, 200) }
      }
      // 能解析出模型列表才算真的通；有些代理会回 200 的错误页
      if (parsed === null) {
        return { ok: false, status: res.status, latencyMs, error: '响应不是合法 JSON' }
      }
      return { ok: true, status: res.status, latencyMs }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        status: 0,
        latencyMs: Date.now() - startedAt,
        error: /timeout|abort/i.test(message) ? '超时' : message
      }
    }
  }

  const direct = await probe(null)
  const viaProxy = await probe(proxy)

  // 记录代理自身的延迟与可用性（直连的归渠道自己的连通性测试管）
  await query(
    `update proxies set last_latency_ms = $2, last_test_at = now(), last_test_ok = $3
      where id = $1`,
    [proxy.id, viaProxy.latencyMs, viaProxy.ok]
  )

  const deltaMs = viaProxy.latencyMs - direct.latencyMs
  return c.json({
    channel: { id: ch.id, name: ch.name, url },
    proxy: { id: proxy.id, name: (await one<{ name: string }>('select name from proxies where id = $1', [proxy.id]))?.name },
    direct,
    proxied: viaProxy,
    deltaMs,
    // 只有两边都成功，差值才有意义
    comparable: direct.ok && viaProxy.ok
  })
})
