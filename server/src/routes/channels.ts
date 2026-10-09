import { Hono } from 'hono'
import { z } from 'zod'
import { one, query } from '../db.js'
import { env } from '../env.js'
import { decryptSecret, encryptSecret, maskSecret } from '../lib/crypto.js'
import { ApiError, badRequest, clientIp, notFound, parseJson } from '../lib/http.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import { recordAudit } from '../services/audit.js'
import { fireAndForgetLog } from '../services/logger.js'
import { extractUsage, SseUsageScanner } from '../services/proxy.js'
import { buildModelsUrl, parseModelsResponse, type ModelInfo } from '../services/models.js'
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

/**
 * 拉取某渠道的模型列表并解析元信息（上下文长度等）。
 * 渠道级配置（路径 / 固定请求头 / 厂商兼容 / 超时）都会生效。
 */
async function fetchModelsFor(opts: {
  baseUrl: string
  upstreamKey: string
  modelsPath: string
  timeoutMs: number
  extraHeaders: Record<string, string>
  vendor: string
}): Promise<{
  ok: boolean
  status: number
  latencyMs: number
  models: ModelInfo[]
  warnings: string[]
  message: string
}> {
  const url = buildModelsUrl(opts.baseUrl, opts.modelsPath)
  const started = Date.now()

  try {
    const res = await fetch(url, {
      headers: buildUpstreamHeaders(opts.upstreamKey, 'application/json', {
        extraHeaders: opts.extraHeaders,
        vendor: opts.vendor
      }),
      signal: AbortSignal.timeout(Math.min(opts.timeoutMs, 20_000))
    })
    const latencyMs = Date.now() - started
    const text = await res.text()

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        latencyMs,
        models: [],
        warnings: [],
        message: `上游返回 ${res.status}：${text.slice(0, 200)}`
      }
    }

    let parsed: unknown = null
    try {
      parsed = JSON.parse(text)
    } catch {
      return {
        ok: false,
        status: res.status,
        latencyMs,
        models: [],
        warnings: [],
        message: '上游返回的不是合法 JSON'
      }
    }

    const { models, warnings } = parseModelsResponse(parsed)
    return {
      ok: true,
      status: res.status,
      latencyMs,
      models,
      warnings,
      message: models.length > 0 ? `获取到 ${models.length} 个模型` : '上游没有返回任何模型'
    }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - started,
      models: [],
      warnings: [],
      message: `连接失败：${err instanceof Error ? err.message : String(err)}`
    }
  }
}

const fetchModelsSchema = z.object({
  baseUrl: httpUrl,
  apiKey: z.string().default(''),
  modelsPath: z.string().max(200).default('/models'),
  timeoutMs: z.coerce.number().int().min(1000).max(600000).default(20000),
  extraHeaders: z.record(z.string(), z.string()).default({}),
  vendor: z.string().default('generic')
})

/**
 * 新建渠道时先拉一次模型列表（此时渠道尚未保存，配置由前端临时提交）。
 * 仅管理员：会带着上游密钥发请求。
 */
channelRoutes.post('/fetch-models', requireAdmin, async (c) => {
  const body = await parseJson(c, fetchModelsSchema)
  validateChannelInput(body)
  const { headers } = sanitizeExtraHeaders(body.extraHeaders)

  const result = await fetchModelsFor({
    baseUrl: body.baseUrl,
    upstreamKey: body.apiKey,
    modelsPath: body.modelsPath,
    timeoutMs: body.timeoutMs,
    extraHeaders: headers,
    vendor: body.vendor
  })
  return c.json(result)
})

/** 已保存的渠道：用库里存的密钥拉取 */
channelRoutes.post('/:id/fetch-models', requireAdmin, async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const ch = await one<ChannelRow>('select * from channels where id = $1', [id])
  if (!ch) throw notFound('渠道不存在')

  let upstreamKey = ''
  if (ch.api_key_cipher) {
    try {
      upstreamKey = decryptSecret(ch.api_key_cipher, env.masterKey)
    } catch {
      throw badRequest('该渠道的密钥无法解密，请重新填写')
    }
  }

  const result = await fetchModelsFor({
    baseUrl: ch.base_url,
    upstreamKey,
    modelsPath: ch.models_path ?? '/models',
    timeoutMs: ch.timeout_ms,
    extraHeaders: ch.extra_headers ?? {},
    vendor: ch.vendor
  })
  return c.json(result)
})

const createSchema = z.object({
  name: z.string().min(1, '名称不能为空').max(64),
  baseUrl: httpUrl,
  protocol: z.enum(['openai']).default('openai'),
  vendor: z.string().default('generic'),
  extraHeaders: z.record(z.string(), z.string()).default({}),
  /** 模型列表 API 路径；默认 /models 即 OpenAI 协议约定 */
  modelsPath: z.string().max(200).default('/models'),
  /** 模型元信息（上下文长度等），键为模型 id */
  modelsMeta: z.record(z.string(), z.unknown()).default({}),
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

/** 单个渠道详情（供渠道详情子页面使用） */
channelRoutes.get('/:id', async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const ch = await one<ChannelRow>('select * from channels where id = $1', [id])
  if (!ch) throw notFound('渠道不存在')
  return c.json({ channel: toChannelDto(ch, maskOf(ch)) })
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
       (name, base_url, protocol, vendor, extra_headers, models_path, models_meta,
        api_key_cipher, models, priority, weight, timeout_ms, status, note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
    [
      body.name,
      body.baseUrl,
      body.protocol,
      body.vendor,
      JSON.stringify(extraHeaders),
      body.modelsPath,
      JSON.stringify(body.modelsMeta),
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
       models_path    = coalesce($7, models_path),
       models_meta    = coalesce($8, models_meta),
       api_key_cipher = $9,
       models         = coalesce($10, models),
       priority       = coalesce($11, priority),
       weight         = coalesce($12, weight),
       timeout_ms     = coalesce($13, timeout_ms),
       status         = coalesce($14, status),
       note           = coalesce($15, note),
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
      body.modelsPath ?? null,
      body.modelsMeta === undefined ? null : JSON.stringify(body.modelsMeta),
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

/**
 * 查看上游渠道的 API Key 明文：**仅管理员，且必然留审计**。
 * 与客户端 Key 的 reveal 同一套安全约束（见 DECISIONS D-013 / D-022）。
 */
channelRoutes.get('/:id/reveal', requireAdmin, async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const ch = await one<ChannelRow>('select * from channels where id = $1', [id])
  if (!ch) throw notFound('渠道不存在')

  if (!ch.api_key_cipher) {
    throw new ApiError(409, 'channel_key_empty', '该渠道没有配置上游密钥')
  }

  let key: string
  try {
    key = decryptSecret(ch.api_key_cipher, env.masterKey)
  } catch {
    throw new ApiError(
      500,
      'channel_key_decrypt_failed',
      '密钥解密失败：主密钥可能已变更（PORTARA_MASTER_KEY）'
    )
  }

  // 审计写入失败会让整个请求失败（fail-closed），不留无声的痕迹
  await recordAudit(c, 'channel.reveal', { type: 'channel', id }, {
    name: ch.name,
    baseUrl: ch.base_url
  })

  return c.json({ key, name: ch.name, baseUrl: ch.base_url })
})

/** 连通性测试：拉取模型列表，并把最近一次结果（延迟/成败）落库供面板展示 */
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
      return c.json({
        ok: false,
        status: 0,
        latencyMs: 0,
        models: [],
        message: '密钥无法解密，请重新填写'
      })
    }
  }

  const result = await fetchModelsFor({
    baseUrl: ch.base_url,
    upstreamKey,
    modelsPath: ch.models_path ?? '/models',
    timeoutMs: ch.timeout_ms,
    extraHeaders: ch.extra_headers ?? {},
    vendor: ch.vendor
  })

  await record(result.latencyMs, result.ok)

  return c.json({
    ok: result.ok,
    status: result.status,
    latencyMs: result.latencyMs,
    testedAt: new Date().toISOString(),
    // 兼容既有前端：仍给出 id 列表，同时附上元信息
    models: result.models.map((m) => m.id),
    modelInfo: result.models,
    message: result.ok ? '连通正常' : result.message
  })
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

  const model = typeof payload.model === 'string' ? payload.model : ''

  /**
   * 直连测试同样消耗上游额度、同样产生费用 —— **必须记账**。
   * 用 source='playground' 与真实网关流量区分开（见迁移 006）。
   * 连接失败也要记：否则「打了但没成功」这件事同样不可见。
   */
  const baseLog = {
    apiKeyId: null,
    apiKeyName: '',
    channelId: ch.id,
    channelName: ch.name,
    model,
    upstreamModel: model,
    path: '/chat/completions',
    clientIp: clientIp(c),
    source: 'playground'
  }

  const startedAt = Date.now()
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

    fireAndForgetLog({
      ...baseLog,
      statusCode: 502,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimated: false,
      latencyMs: Date.now() - startedAt,
      ttftMs: null,
      error: message
    })

    throw new ApiError(502, 'upstream_unreachable', message)
  }

  const contentType = res.headers.get('content-type') ?? 'application/json'

  if (contentType.includes('text/event-stream') && res.body) {
    // 流式：tee 出旁路扫描 usage，原字节照常下传
    const [clientStream, scanStream] = res.body.tee()
    const scanner = new SseUsageScanner()
    let ttftMs: number | null = null

    void (async () => {
      const reader = scanStream.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (ttftMs === null) ttftMs = Date.now() - startedAt
          scanner.push(value)
        }
      } catch {
        /* 中断交由 finally 记账 */
      } finally {
        scanner.finish()
        const exact = scanner.usage
        const usage = exact ?? scanner.estimateFromBytes()
        fireAndForgetLog({
          ...baseLog,
          statusCode: res.status,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          estimated: !exact,
          latencyMs: Date.now() - startedAt,
          ttftMs,
          error: exact ? '' : '上游未返回 usage，token 数为估算'
        })
      }
    })()

    return new Response(clientStream, {
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
  const usage = extractUsage(parseJsonSafe(text))

  fireAndForgetLog({
    ...baseLog,
    statusCode: res.status,
    promptTokens: usage?.promptTokens ?? 0,
    completionTokens: usage?.completionTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    estimated: false,
    latencyMs: Date.now() - startedAt,
    ttftMs: null,
    error: res.ok ? '' : text.slice(0, 300)
  })

  return new Response(text, {
    status: res.status,
    headers: { 'content-type': contentType, 'x-portara-direct': ch.name }
  })
})
