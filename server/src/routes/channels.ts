import { Hono } from 'hono'
import { z } from 'zod'
import { one, query } from '../db.js'
import { env } from '../env.js'
import { decryptSecret, encryptSecret, maskSecret } from '../lib/crypto.js'
import { ApiError, badRequest, notFound, parseJson } from '../lib/http.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import {
  buildUpstreamHeaders,
  buildUpstreamUrl,
  parseJsonSafe,
  isVendorPreset,
  sanitizeExtraHeaders,
  withStreamUsage
} from '../services/proxy.js'
import { toChannelDto, type ChannelRow } from '../types.js'

export const channelRoutes = new Hono()

channelRoutes.use('*', requireAuth)

const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '非法 ID')

const httpUrl = z
  .string()
  .min(1, 'Base URL 不能为空')
  .refine((v) => /^https?:\/\//i.test(v), 'Base URL 必须以 http:// 或 https:// 开头')

const createSchema = z.object({
  name: z.string().min(1, '名称不能为空').max(64),
  baseUrl: httpUrl,
  protocol: z.enum(['openai']).default('openai'),
  vendor: z.string().default('generic'),
  extraHeaders: z.record(z.string(), z.string()).default({}),
  apiKey: z.string().default(''),
  models: z.array(z.string().min(1)).default([]),
  priority: z.coerce.number().int().min(1).max(9999).default(100),
  weight: z.coerce.number().int().min(1).max(1000).default(1),
  timeoutMs: z.coerce.number().int().min(1000).max(600000).default(120000),
  status: z.enum(['active', 'disabled']).default('active'),
  note: z.string().max(500).default('')
})

const updateSchema = createSchema.partial().extend({
  clearApiKey: z.boolean().optional()
})

/** 校验厂商标识与固定请求头；非法项直接 400，不静默丢弃 */
function validateChannelInput(input: { vendor?: string; extraHeaders?: Record<string, string> }) {
  if (input.vendor !== undefined && !isVendorPreset(input.vendor)) {
    throw badRequest(`不支持的厂商兼容选项：${input.vendor}`)
  }
  if (input.extraHeaders !== undefined) {
    const { errors } = sanitizeExtraHeaders(input.extraHeaders)
    if (errors.length > 0) throw badRequest('固定请求头有问题', { issues: errors })
  }
}

function maskOf(ch: ChannelRow): string {
  if (!ch.api_key_cipher) return ''
  try {
    return maskSecret(decryptSecret(ch.api_key_cipher, env.masterKey))
  } catch {
    return '（密文无法解密，请重新填写）'
  }
}

channelRoutes.get('/', async (c) => {
  const rows = await query<ChannelRow>(
    'select * from channels order by priority asc, name asc'
  )
  return c.json({ channels: rows.map((ch) => toChannelDto(ch, maskOf(ch))) })
})

channelRoutes.post('/', requireAdmin, async (c) => {
  const body = await parseJson(c, createSchema)
  validateChannelInput(body)

  const exists = await one('select id from channels where name = $1', [body.name])
  if (exists) throw badRequest('渠道名称已存在')

  const cipher = body.apiKey
    ? encryptSecret(body.apiKey, env.masterKey)
    : ''
  const { headers: extraHeaders } = sanitizeExtraHeaders(body.extraHeaders)

  const row = await one<ChannelRow>(
    `insert into channels
       (name, base_url, protocol, vendor, extra_headers, api_key_cipher, models, priority, weight, timeout_ms, status, note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [
      body.name,
      body.baseUrl,
      body.protocol,
      body.vendor,
      JSON.stringify(extraHeaders),
      cipher,
      body.models,
      body.priority,
      body.weight,
      body.timeoutMs,
      body.status,
      body.note
    ]
  )
  return c.json({ channel: toChannelDto(row!, maskOf(row!)) }, 201)
})

channelRoutes.patch('/:id', requireAdmin, async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const body = await parseJson(c, updateSchema)
  validateChannelInput(body)

  const current = await one<ChannelRow>('select * from channels where id = $1', [id])
  if (!current) throw notFound('渠道不存在')

  if (body.name && body.name !== current.name) {
    const dup = await one('select id from channels where name = $1 and id <> $2', [
      body.name,
      id
    ])
    if (dup) throw badRequest('渠道名称已存在')
  }

  let cipher = current.api_key_cipher
  if (body.clearApiKey) cipher = ''
  else if (body.apiKey) cipher = encryptSecret(body.apiKey, env.masterKey)

  const extraHeaders =
    body.extraHeaders === undefined
      ? current.extra_headers
      : sanitizeExtraHeaders(body.extraHeaders).headers

  const row = await one<ChannelRow>(
    `update channels set
       name           = coalesce($2, name),
       base_url       = coalesce($3, base_url),
       protocol       = coalesce($4, protocol),
       vendor         = coalesce($5, vendor),
       extra_headers  = $6,
       api_key_cipher = $7,
       models         = coalesce($8, models),
       priority       = coalesce($9, priority),
       weight         = coalesce($10, weight),
       timeout_ms     = coalesce($11, timeout_ms),
       status         = coalesce($12, status),
       note           = coalesce($13, note),
       updated_at     = now()
     where id = $1
     returning *`,
    [
      id,
      body.name ?? null,
      body.baseUrl ?? null,
      body.protocol ?? null,
      body.vendor ?? null,
      JSON.stringify(extraHeaders),
      cipher,
      body.models ?? null,
      body.priority ?? null,
      body.weight ?? null,
      body.timeoutMs ?? null,
      body.status ?? null,
      body.note ?? null
    ]
  )
  return c.json({ channel: toChannelDto(row!, maskOf(row!)) })
})

channelRoutes.delete('/:id', requireAdmin, async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const current = await one('select id from channels where id = $1', [id])
  if (!current) throw notFound('渠道不存在')
  await query('delete from channels where id = $1', [id])
  return c.json({ ok: true })
})

/** 连通性测试：GET {base}/models，并把最近一次结果（延迟/成败）落库供面板展示 */
channelRoutes.post('/:id/test', async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const ch = await one<ChannelRow>('select * from channels where id = $1', [id])
  if (!ch) throw notFound('渠道不存在')

  const record = async (latencyMs: number, ok: boolean) => {
    await query(
      `update channels set last_latency_ms = $2, last_test_at = now(), last_test_ok = $3
        where id = $1`,
      [id, Math.max(0, Math.round(latencyMs)), ok]
    )
  }

  let upstreamKey = ''
  if (ch.api_key_cipher) {
    try {
      upstreamKey = decryptSecret(ch.api_key_cipher, env.masterKey)
    } catch {
      await record(0, false)
      return c.json({ ok: false, status: 0, message: '密钥无法解密，请重新填写', models: [] })
    }
  }

  const url = buildUpstreamUrl(ch.base_url, '/models')
  const started = Date.now()

  try {
    const res = await fetch(url, {
      headers: buildUpstreamHeaders(upstreamKey, 'application/json', {
        extraHeaders: ch.extra_headers ?? {},
        vendor: ch.vendor
      }),
      signal: AbortSignal.timeout(Math.min(ch.timeout_ms, 15_000))
    })
    const latencyMs = Date.now() - started
    const text = await res.text()

    let models: string[] = []
    try {
      const parsed = JSON.parse(text) as { data?: { id?: unknown }[] }
      if (Array.isArray(parsed.data)) {
        models = parsed.data
          .map((m) => (typeof m?.id === 'string' ? m.id : ''))
          .filter(Boolean)
          .slice(0, 100)
      }
    } catch {
      /* 非 JSON 响应也算连通，只是拿不到模型列表 */
    }

    await record(latencyMs, res.ok)

    return c.json({
      ok: res.ok,
      status: res.status,
      latencyMs,
      testedAt: new Date().toISOString(),
      models,
      message: res.ok ? '连通正常' : `上游返回 ${res.status}：${text.slice(0, 200)}`
    })
  } catch (err) {
    const latencyMs = Date.now() - started
    await record(latencyMs, false)
    return c.json({
      ok: false,
      status: 0,
      latencyMs,
      testedAt: new Date().toISOString(),
      models: [],
      message: `连接失败：${err instanceof Error ? err.message : String(err)}`
    })
  }
})

/**
 * 直连上游的对话测试。
 *
 * 与 /v1 的区别（这正是它的用途）：
 *   - **绕过网关治理**：不走限流、配额、模型白名单、密钥计量
 *   - 直接用**该渠道自己的 Key 与固定请求头**打上游
 * 于是可以把「渠道本身通不通」与「网关整条链路通不通」分开判断。
 *
 * 仅管理员可用：它会消耗渠道的上游额度。诊断用途，不写 request_logs。
 */
channelRoutes.post('/:id/chat', requireAdmin, async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const ch = await one<ChannelRow>('select * from channels where id = $1', [id])
  if (!ch) throw notFound('渠道不存在')

  const raw = await c.req.text()
  const payload = parseJsonSafe(raw) as Record<string, unknown> | null
  if (!payload || typeof payload !== 'object') {
    throw badRequest('请求体不是合法 JSON')
  }

  let bodyText = raw
  if (payload.stream === true) {
    const patched = withStreamUsage(payload)
    if (patched.injected) bodyText = JSON.stringify(patched.payload)
  }

  let upstreamKey = ''
  if (ch.api_key_cipher) {
    try {
      upstreamKey = decryptSecret(ch.api_key_cipher, env.masterKey)
    } catch {
      throw badRequest('该渠道的密钥无法解密，请重新填写')
    }
  }

  const url = buildUpstreamUrl(ch.base_url, '/chat/completions')
  const signal = AbortSignal.any([
    c.req.raw.signal,
    AbortSignal.timeout(ch.timeout_ms)
  ])

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: buildUpstreamHeaders(upstreamKey, 'application/json', {
        extraHeaders: ch.extra_headers ?? {},
        vendor: ch.vendor
      }),
      body: bodyText,
      signal
    })
  } catch (err) {
    const message = signal.aborted
      ? `上游响应超时（${ch.timeout_ms}ms）`
      : `连接上游失败：${err instanceof Error ? err.message : String(err)}`
    throw new ApiError(502, 'upstream_unreachable', message)
  }

  const contentType = res.headers.get('content-type') ?? 'application/json'

  if (contentType.includes('text/event-stream') && res.body) {
    return new Response(res.body, {
      status: res.status,
      headers: {
        'content-type': contentType,
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
        'x-portara-direct': ch.name
      }
    })
  }

  const text = await res.text()
  return new Response(text, {
    status: res.status,
    headers: { 'content-type': contentType, 'x-portara-direct': ch.name }
  })
})
