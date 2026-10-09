import type { Context } from 'hono'
import { Hono } from 'hono'
import { query } from '../db.js'
import { env } from '../env.js'
import { decryptSecret } from '../lib/crypto.js'
import { clientIp, openaiError } from '../lib/http.js'
import { apiKeyAuth } from '../middleware/auth.js'
import { redis } from '../redis.js'
import { fireAndForgetLog, loadKeyUsage } from '../services/logger.js'
import {
  buildUpstreamHeaders,
  buildUpstreamUrl,
  extractUsage,
  parseJsonSafe,
  SseUsageScanner,
  withStreamUsage
} from '../services/proxy.js'
import { checkRateLimit, quotaExceeded } from '../services/ratelimit.js'
import {
  AnthropicToOpenAiStream,
  anthropicToOpenai,
  openaiToAnthropic
} from '../services/anthropic.js'
import {
  getChannelById,
  resolveBoundTarget,
  resolveTarget,
  type ResolvedTarget
} from '../services/router.js'
import type { ApiKeyRow, ChannelRow } from '../types.js'

export const v1Routes = new Hono()

v1Routes.use('*', apiKeyAuth)

/** 全局轮转计数：多实例下同一优先级组内的权重轮转保持一致 */
async function nextRotation(): Promise<number> {
  try {
    return await redis.incr('portara:route:rotation')
  } catch {
    return Date.now() % 1000
  }
}

type TargetPick =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; message: string; code: string }

/**
 * 选定「渠道 + 上游模型」。
 *
 * 绑定了渠道的 Key 只在该渠道内解析（可在渠道内命中映射），
 * 未绑定则走全局映射优先、旧逻辑回退。
 */
async function selectTarget(key: ApiKeyRow, model: string): Promise<TargetPick> {
  if (key.channel_id) {
    const bound = await getChannelById(key.channel_id)
    if (!bound) {
      return { ok: false, message: '该 Key 绑定的渠道已被删除', code: 'channel_missing' }
    }
    if (bound.status !== 'active') {
      return {
        ok: false,
        message: `该 Key 绑定的渠道「${bound.name}」已停用`,
        code: 'channel_disabled'
      }
    }
    return { ok: true, target: await resolveBoundTarget(bound, model) }
  }

  const target = await resolveTarget(model, nextRotation)
  if (!target) {
    return {
      ok: false,
      message: model
        ? `没有可用于模型「${model}」的启用渠道或映射`
        : '没有启用中的上游渠道，请先在管理面板配置',
      code: 'no_channel'
    }
  }
  return { ok: true, target }
}

interface ProxyOptions {
  /** 是否解析 usage（JSON 响应与 SSE 流） */
  scanUsage: boolean
}

async function handleProxy(c: Context, restPath: string, opts: ProxyOptions) {
  const key = c.get('apiKey') as ApiKeyRow
  const ip = clientIp(c)
  const startedAt = Date.now()

  const raw = c.req.method === 'GET' || c.req.method === 'HEAD' ? '' : await c.req.text()
  const payload = raw ? (parseJsonSafe(raw) as Record<string, unknown> | null) : null
  const model = typeof payload?.model === 'string' ? payload.model : ''
  const streamFlag = payload?.stream === true

  const baseLog = {
    apiKeyId: key.id,
    apiKeyName: key.name,
    channelId: null as string | null,
    channelName: '',
    model,
    // 尚未选定渠道时上游模型未知；选定后由 logCtx 覆盖为真实值
    upstreamModel: '',
    path: restPath,
    clientIp: ip,
    source: 'gateway'
  }

  // ① 模型白名单
  if (key.model_allow.length > 0 && model && !key.model_allow.includes(model)) {
    fireAndForgetLog({
      ...baseLog,
      statusCode: 403,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimated: false,
      latencyMs: Date.now() - startedAt,
      ttftMs: null,
      error: `模型 ${model} 不在允许列表`
    })
    return openaiError(
      c,
      403,
      `模型「${model}」不在该 API Key 的允许列表内`,
      'invalid_request_error',
      'model_not_allowed'
    )
  }

  // ② 速率限制
  const rl = await checkRateLimit(key.id, key.rpm_limit)
  if (!rl.ok) {
    c.header('retry-after', String(rl.retryAfterSec))
    c.header('x-ratelimit-limit-requests', String(rl.limit))
    c.header('x-ratelimit-remaining-requests', '0')
    fireAndForgetLog({
      ...baseLog,
      statusCode: 429,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimated: false,
      latencyMs: Date.now() - startedAt,
      ttftMs: null,
      error: `超出速率限制（${rl.limit}/分钟）`
    })
    return openaiError(
      c,
      429,
      `超出速率限制：${rl.limit} 次/分钟`,
      'rate_limit_error',
      'rate_limit_exceeded'
    )
  }
  c.header('x-ratelimit-limit-requests', String(rl.limit))
  c.header('x-ratelimit-remaining-requests', String(Math.max(0, rl.remaining)))

  // ③ 配额预检
  const usageInfo = await loadKeyUsage(key.id)
  if (usageInfo && quotaExceeded(usageInfo.usedTokens, usageInfo.quotaTokens)) {
    fireAndForgetLog({
      ...baseLog,
      statusCode: 402,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimated: false,
      latencyMs: Date.now() - startedAt,
      ttftMs: null,
      error: 'Token 配额已用尽'
    })
    return openaiError(
      c,
      402,
      `Token 配额已用尽（${usageInfo.usedTokens}/${usageInfo.quotaTokens}）`,
      'insufficient_quota',
      'quota_exceeded'
    )
  }

  // ④ 选路
  const pick = await selectTarget(key, model)
  if (!pick.ok) {
    fireAndForgetLog({
      ...baseLog,
      statusCode: 503,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimated: false,
      latencyMs: Date.now() - startedAt,
      ttftMs: null,
      error: pick.message
    })
    return openaiError(c, 503, pick.message, 'api_error', pick.code)
  }
  const channel = pick.target.channel
  const upstreamModel = pick.target.upstreamModel
  // 协议与地址可能被逐模型覆盖（混杂模式）
  const protocol = pick.target.protocol
  const upstreamBaseUrl = pick.target.baseUrl
  const logCtx = {
    ...baseLog,
    channelId: channel.id,
    channelName: channel.name,
    upstreamModel
  }

  // ⑤ 上游密钥
  let upstreamKey = ''
  if (channel.api_key_cipher) {
    try {
      upstreamKey = decryptSecret(channel.api_key_cipher, env.masterKey)
    } catch {
      return openaiError(c, 500, '上游渠道密钥无法解密，请在管理面板重新填写', 'api_error', 'channel_key_error')
    }
  }

  // ⑥ 组装发往上游的请求体
  //
  // 两处可能改写 body：
  //   ① 命中模型映射 → 把网关受理的 model 换成上游真实 model
  //   ② 流式且客户端未指定 stream_options → 补 include_usage
  // 只有确实需要改写时才重新序列化，未命中映射的请求仍是原始字节直通。
  let outPayload: Record<string, unknown> | null = payload
  let needsReserialize = false

  if (payload && upstreamModel && upstreamModel !== model) {
    outPayload = { ...payload, model: upstreamModel }
    needsReserialize = true
  }

  // ③ 上游说 Anthropic 协议 → 把 OpenAI 请求翻成 /messages 格式
  let upstreamPath = restPath
  if (protocol === 'anthropic') {
    const translated = openaiToAnthropic(outPayload ?? {}, upstreamModel)
    outPayload = translated.body
    needsReserialize = true
    upstreamPath = '/messages'
    if (translated.warnings.length > 0) {
      console.warn(
        `[portara] OpenAI→Anthropic 翻译提示（${channel.name}）：${translated.warnings.join('；')}`
      )
    }
  } else if (opts.scanUsage && streamFlag && outPayload) {
    // 只有 OpenAI 协议才补 stream_options.include_usage
    const patched = withStreamUsage(outPayload)
    if (patched.injected) {
      outPayload = patched.payload
      needsReserialize = true
    }
  }

  const bodyText = needsReserialize && outPayload ? JSON.stringify(outPayload) : raw || undefined

  const url = buildUpstreamUrl(upstreamBaseUrl || channel.base_url, upstreamPath)
  // 客户端断开 或 上游超时 —— 任一触发都会取消上游请求（避免幽灵计费）
  const signal = AbortSignal.any([
    c.req.raw.signal,
    AbortSignal.timeout(channel.timeout_ms)
  ])

  let res: Response
  try {
    res = await fetch(url, {
      method: c.req.method,
      headers: buildUpstreamHeaders(
        upstreamKey,
        c.req.header('content-type') ?? 'application/json',
        {
          // 渠道级请求头必须在网关路径同样生效，否则「能测通却转发失败」
          extraHeaders: channel.extra_headers ?? {},
          vendor: channel.vendor ?? 'generic'
        }
      ),
      body: bodyText,
      signal
    })
  } catch (err) {
    const clientGone = c.req.raw.signal.aborted
    const timedOut = !clientGone && signal.aborted
    const message = clientGone
      ? '客户端已断开'
      : timedOut
        ? `上游响应超时（${channel.timeout_ms}ms）`
        : `上游连接失败：${err instanceof Error ? err.message : String(err)}`

    fireAndForgetLog({
      ...logCtx,
      statusCode: clientGone ? 499 : 504,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimated: false,
      latencyMs: Date.now() - startedAt,
      ttftMs: null,
      error: message
    })

    if (clientGone) return new Response(null, { status: 499 })
    return openaiError(c, 504, message, 'api_error', 'upstream_unreachable')
  }

  const contentType = res.headers.get('content-type') ?? 'application/json'
  const isStream = contentType.includes('text/event-stream') || (streamFlag && res.ok)

  // ⑦ Anthropic 上游：响应要翻回 OpenAI 格式（流式与非流式都是）
  if (protocol === 'anthropic') {
    // 流式：逐事件翻译，原字节无法直通
    if (isStream && res.body) {
      const translator = new AnthropicToOpenAiStream(model || upstreamModel)
      const decoder = new TextDecoder()
      let ttftMs: number | null = null

      const stream = new ReadableStream<Uint8Array>({
        start: async (controller) => {
          const reader = res.body!.getReader()
          const encoder = new TextEncoder()
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              if (ttftMs === null) ttftMs = Date.now() - startedAt
              const text = translator.push(value)
              if (text) controller.enqueue(encoder.encode(text))
            }
          } catch {
            /* 中断交由 finally 记账 */
          } finally {
            const tail = translator.finish()
            if (tail) controller.enqueue(new TextEncoder().encode(tail))
            controller.close()

            const usage = translator.usage
            fireAndForgetLog({
              ...logCtx,
              statusCode: res.status,
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.promptTokens + usage.completionTokens,
              estimated: false,
              latencyMs: Date.now() - startedAt,
              ttftMs,
              error: ''
            })
            void decoder
          }
        }
      })

      return new Response(stream, {
        status: res.status,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'x-accel-buffering': 'no',
          'x-portara-channel': channel.name,
          'x-portara-protocol': 'anthropic'
        }
      })
    }

    // 非流式：解析 Anthropic 响应 → 翻成 OpenAI 响应
    const text = await res.text()
    const parsed = parseJsonSafe(text)

    if (!res.ok || !parsed || typeof parsed !== 'object') {
      fireAndForgetLog({
        ...logCtx,
        statusCode: res.status,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        estimated: false,
        latencyMs: Date.now() - startedAt,
        ttftMs: null,
        error: text.slice(0, 300)
      })
      return new Response(text, {
        status: res.status,
        headers: { 'content-type': contentType, 'x-portara-protocol': 'anthropic' }
      })
    }

    const translated = anthropicToOpenai(
      parsed as Record<string, unknown>,
      model || upstreamModel
    )
    const usage = translated.usage as Record<string, number>

    fireAndForgetLog({
      ...logCtx,
      statusCode: res.status,
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0,
      estimated: false,
      latencyMs: Date.now() - startedAt,
      ttftMs: null,
      error: ''
    })

    return new Response(JSON.stringify(translated), {
      status: res.status,
      headers: {
        'content-type': 'application/json',
        'x-portara-channel': channel.name,
        'x-portara-protocol': 'anthropic'
      }
    })
  }

  // ⑧ 非流式：整体读回，解析 usage
  if (!isStream) {
    const text = await res.text()
    const parsed = opts.scanUsage ? parseJsonSafe(text) : null
    const usage = parsed ? extractUsage(parsed) : null

    fireAndForgetLog({
      ...logCtx,
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
      headers: {
        'content-type': contentType,
        'x-portara-channel': channel.name
      }
    })
  }

  // ⑨ 流式：tee 出两条支路 —— 一条原样下传，一条旁路扫描 usage
  const upstreamBody = res.body
  if (!upstreamBody) {
    return openaiError(c, 502, '上游返回了空的流式响应', 'api_error', 'empty_stream')
  }

  const [clientStream, scanStream] = upstreamBody.tee()
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
      /* 上游中断或客户端断开，交由 finally 记账 */
    } finally {
      scanner.finish()
      const exact = scanner.usage
      const usage = exact ?? scanner.estimateFromBytes()

      fireAndForgetLog({
        ...logCtx,
        statusCode: res.status,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        estimated: !exact,
        latencyMs: Date.now() - startedAt,
        ttftMs,
        error: exact ? '' : '上游未返回 usage，token 数为按字节量估算'
      })
    }
  })()

  return new Response(clientStream, {
    status: res.status,
    headers: {
      'content-type': contentType,
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
      'x-portara-channel': channel.name
    }
  })
}

// ------------------------------------------------------------ OpenAI 兼容端点

v1Routes.post('/chat/completions', (c) => handleProxy(c, '/chat/completions', { scanUsage: true }))
v1Routes.post('/completions', (c) => handleProxy(c, '/completions', { scanUsage: true }))
v1Routes.post('/embeddings', (c) => handleProxy(c, '/embeddings', { scanUsage: true }))
v1Routes.post('/responses', (c) => handleProxy(c, '/responses', { scanUsage: true }))

/**
 * 把模型元信息（上下文长度等）附加到 /v1/models 的条目上。
 *
 * OpenAI 规范里 /models 只有 id/object/created/owned_by，
 * 但很多实现会额外返回上下文长度、价格等；既然 Portara 抓到了这些信息，
 * 就应当透传出去 —— 否则调用方在网关后面反而看不到它们。
 */
function decorateModel(
  id: string,
  owner: string,
  meta: unknown
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id,
    object: 'model',
    created: 0,
    owned_by: owner
  }

  if (!meta || typeof meta !== 'object') return base
  const m = meta as Record<string, unknown>
  const extra: Record<string, unknown> = {}

  // 透传上游原始标量字段（跳过会与规范字段冲突的键）
  const raw = m.raw
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (['id', 'object', 'created', 'owned_by', 'name', 'model'].includes(k)) continue
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) extra[k] = v
    }
  }

  // 归一化后的字段以规范名输出（不同厂商叫法不一，这里统一成 context_length）
  if (typeof m.contextLength === 'number') extra.context_length = m.contextLength
  if (typeof m.maxOutputTokens === 'number') extra.max_output_tokens = m.maxOutputTokens

  // base 放后面：规范字段优先级最高，不被 raw 里的同名键覆盖
  return { ...extra, ...base }
}

/**
 * 聚合可用的模型 id：
 *   ① 模型映射的别名（网关受理的 id），元信息取该别名首个目标的渠道配置
 *   ② 各启用渠道声明的模型（未配映射时的直通 id）
 */
v1Routes.get('/models', async (c) => {
  const key = c.get('apiKey') as ApiKeyRow

  /**
   * filter 取值：
   *   all（默认）  映射别名 + 渠道声明的模型
   *   mirror-only  只看**映射后**的模型 id（网关对外受理的那套）
   *   origin-only  只看**渠道本身**声明的模型 id（上游原生那套）
   */
  const filterRaw = c.req.query('filter') ?? 'all'
  const filter =
    filterRaw === 'mirror-only' || filterRaw === 'origin-only' ? filterRaw : 'all'

  const channels = await query<ChannelRow>(
    `select * from channels where status = 'active' order by priority asc, name asc`
  )
  const metaByChannel = new Map<string, Record<string, unknown>>()
  for (const ch of channels) {
    metaByChannel.set(ch.id, (ch.models_meta ?? {}) as Record<string, unknown>)
  }

  // 别名 → 其首个目标的 (渠道, 上游模型)，据此取元信息
  const aliasRows = await query<{
    alias: string
    channel_id: string
    upstream_model: string
  }>(
    `select distinct on (r.alias) r.alias, r.channel_id, r.upstream_model
       from model_routes r
       join channels c on c.id = r.channel_id
      where r.status = 'active' and c.status = 'active'
      order by r.alias asc, r.priority asc, r.id asc`
  )

  // 同一个 id 可能既是别名又是渠道声明的模型 —— 用集合记下它同时属于哪几类
  const entries = new Map<
    string,
    { owner: string; meta: unknown; kinds: Set<'mirror' | 'origin'> }
  >()

  for (const row of aliasRows) {
    const existing = entries.get(row.alias)
    const meta = metaByChannel.get(row.channel_id)?.[row.upstream_model]
    if (existing) {
      existing.kinds.add('mirror')
      continue
    }
    entries.set(row.alias, {
      owner: 'portara/mapping',
      meta,
      kinds: new Set(['mirror'])
    })
  }

  for (const ch of channels) {
    for (const m of ch.models) {
      const existing = entries.get(m)
      if (existing) {
        existing.kinds.add('origin')
        continue
      }
      entries.set(m, {
        owner: `portara/${ch.name}`,
        meta: (ch.models_meta ?? {})[m],
        kinds: new Set(['origin'])
      })
    }
  }

  const allowed = [...entries.entries()].filter(([id, info]) => {
    if (key.model_allow.length > 0 && !key.model_allow.includes(id)) return false
    if (filter === 'mirror-only') return info.kinds.has('mirror')
    if (filter === 'origin-only') return info.kinds.has('origin')
    return true
  })

  return c.json({
    object: 'list',
    filter,
    data: allowed.map(([id, info]) => decorateModel(id, info.owner, info.meta))
  })
})

/** 其余 /v1/* 端点：通用透传（同样带鉴权、限流、计量） */
v1Routes.all('/*', (c) => {
  const rest = c.req.path.replace(/^\/v1/, '') || '/'
  return handleProxy(c, rest, { scanUsage: true })
})
