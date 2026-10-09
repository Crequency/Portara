import type { Context } from 'hono'
import { Hono } from 'hono'
import { query } from '../db.js'
import { env } from '../env.js'
import { decryptSecret } from '../lib/crypto.js'
import { openaiError } from '../lib/http.js'
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
import { getChannelById, resolveChannel, type ChannelCandidate } from '../services/router.js'
import type { ApiKeyRow, ChannelRow } from '../types.js'

export const v1Routes = new Hono()

v1Routes.use('*', apiKeyAuth)

function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for')
  if (xff) return xff.split(',')[0]!.trim()
  return c.req.header('x-real-ip') ?? 'unknown'
}

/** 全局轮转计数：多实例下同一优先级组内的权重轮转保持一致 */
async function nextRotation(): Promise<number> {
  try {
    return await redis.incr('portara:route:rotation')
  } catch {
    return Date.now() % 1000
  }
}

type ChannelPick =
  | { ok: true; channel: ChannelCandidate }
  | { ok: false; message: string; code: string }

async function selectChannel(key: ApiKeyRow, model: string): Promise<ChannelPick> {
  // 绑定了渠道：只走它，不做任何回退 —— 不越过租户的明确意图
  if (key.channel_id) {
    const bound = await getChannelById(key.channel_id)
    if (!bound) {
      return { ok: false, message: '该 Key 绑定的渠道已被删除', code: 'channel_missing' }
    }
    if (bound.status !== 'active') {
      return { ok: false, message: `该 Key 绑定的渠道「${bound.name}」已停用`, code: 'channel_disabled' }
    }
    return { ok: true, channel: bound as unknown as ChannelCandidate }
  }

  const picked = await resolveChannel(model, nextRotation)
  if (!picked) {
    return {
      ok: false,
      message: model
        ? `没有可用于模型「${model}」的启用渠道`
        : '没有启用中的上游渠道，请先在管理面板配置',
      code: 'no_channel'
    }
  }
  return { ok: true, channel: picked }
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
    path: restPath,
    clientIp: ip
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
  const pick = await selectChannel(key, model)
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
  const channel = pick.channel
  const logCtx = { ...baseLog, channelId: channel.id, channelName: channel.name }

  // ⑤ 上游密钥
  let upstreamKey = ''
  if (channel.api_key_cipher) {
    try {
      upstreamKey = decryptSecret(channel.api_key_cipher, env.masterKey)
    } catch {
      return openaiError(c, 500, '上游渠道密钥无法解密，请在管理面板重新填写', 'api_error', 'channel_key_error')
    }
  }

  // ⑥ 转发。流式且未指定 stream_options 时补 include_usage，否则拿不到 usage
  let bodyText = raw || undefined
  if (opts.scanUsage && streamFlag && payload) {
    const patched = withStreamUsage(payload)
    if (patched.injected) bodyText = JSON.stringify(patched.payload)
  }

  const url = buildUpstreamUrl(channel.base_url, restPath)
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
        c.req.header('content-type') ?? 'application/json'
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

  // ⑦ 非流式：整体读回，解析 usage
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

  // ⑧ 流式：tee 出两条支路 —— 一条原样下传，一条旁路扫描 usage
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

/** 聚合各启用渠道声明的模型；仅返回该 Key 允许的模型 */
v1Routes.get('/models', async (c) => {
  const key = c.get('apiKey') as ApiKeyRow
  const channels = await query<ChannelRow>(
    `select * from channels where status = 'active' order by priority asc, name asc`
  )

  const seen = new Map<string, string>()
  for (const ch of channels) {
    for (const m of ch.models) {
      if (!seen.has(m)) seen.set(m, ch.name)
    }
  }

  const allowed = [...seen.entries()].filter(
    ([m]) => key.model_allow.length === 0 || key.model_allow.includes(m)
  )

  return c.json({
    object: 'list',
    data: allowed.map(([id, owner]) => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: `portara/${owner}`
    }))
  })
})

/** 其余 /v1/* 端点：通用透传（同样带鉴权、限流、计量） */
v1Routes.all('/*', (c) => {
  const rest = c.req.path.replace(/^\/v1/, '') || '/'
  return handleProxy(c, rest, { scanUsage: true })
})
