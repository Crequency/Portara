import type { Context } from 'hono'
import { Hono } from 'hono'
import { query } from '../db.js'
import { clientIp, openaiError } from '../lib/http.js'
import { apiKeyAuth } from '../middleware/auth.js'
import { redis } from '../redis.js'
import { fireAndForgetLog, loadKeyUsage } from '../services/logger.js'
import {
  COOLDOWN,
  MAX_ACCOUNT_ATTEMPTS,
  type AccountRow,
  cooldownFor,
  isRetriableStatus,
  markAccountFailure,
  markAccountSuccess,
  markQuotaExhaustedResponse,
  pickAccounts
} from '../services/accounts.js'
import {
  formatQuotaCooldown,
  isQuotaExhaustionResponse
} from '../services/quotaSignal.js'
import { tryDecryptKey } from '../services/channels.js'
import { upstreamFetch } from '../services/proxyAgent.js'
import {
  buildUpstreamHeaders,
  sessionEchoOf,
  extractUsage,
  parseJsonSafe,
  SseUsageScanner
} from '../services/proxy.js'
import { checkRateLimit, quotaExceeded } from '../services/ratelimit.js'
import {
  planUpstreamRequest,
  translateAnthropicJson,
  translateAnthropicStream
} from '../services/relay.js'
import {
  getChannelById,
  resolveBoundTargets,
  resolveTargets,
  type ResolvedTarget
} from '../services/router.js'
import {
  sessionKeyOf,
  shortSessionHash,
  type AffinityPin,
  type SessionKey
} from '../services/affinityPure.js'
import { clearAffinity, getAffinity, setAffinity } from '../services/affinity.js'
import { env } from '../env.js'
import { getRoutingSettings } from '../services/routingSettings.js'
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

/**
 * 账户轮转计数。
 * 与渠道轮转**分开** —— 共用一个计数器会让渠道的权重分布随账户数量变化而漂移。
 */
async function nextAccountRotation(): Promise<number> {
  try {
    return await redis.incr('portara:account:rotation')
  } catch {
    return Date.now() % 1000
  }
}

type TargetPick =
  | { ok: true; targets: ResolvedTarget[]; viaAlias: boolean; affinity: AffinityPin | null }
  | { ok: false; message: string; code: string }

/**
 * 选定「渠道 + 上游模型」的**候选序列**。
 *
 * 绑定了渠道的 Key 只在该渠道内解析（可在渠道内命中映射），
 * 未绑定则走全局映射优先、旧逻辑回退。
 *
 * 返回数组是为了会话粘性的失败回退：第一候选（亲和/哈希选出的渠道）失败时
 * 还能顺着候选往下试，而不是直接 502。
 */
async function selectTargets(
  key: ApiKeyRow,
  model: string,
  session: SessionKey
): Promise<TargetPick> {
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
    return {
      ok: true,
      targets: await resolveBoundTargets(bound, model),
      viaAlias: false,
      affinity: null
    }
  }

  // 有会话键才查亲和：没有键就不该「装作有记忆」
  const affinity = session.hash ? await getAffinity(model, session.hash) : null
  const targets = await resolveTargets(model, nextRotation, {
    sessionHash: session.hash,
    affinity
  })
  if (targets.length === 0) {
    return {
      ok: false,
      message: model
        ? `没有可用于模型「${model}」的启用渠道或映射`
        : '没有启用中的上游渠道，请先在管理面板配置',
      code: 'no_channel'
    }
  }
  return {
    ok: true,
    targets,
    viaAlias: targets.some((t) => t.viaMapping),
    affinity
  }
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

  /**
   * 会话键：决定「这个请求该落到哪个渠道/账户」。
   *
   * 来自请求体的 `prompt_cache_key`（OpenAI 官方缓存键，客户端会发），
   * 否则退回「system + 首条 user」的上下文指纹。两者都拿不到就**不做亲和** ——
   * 靠猜的亲和只会把并发堆到一个渠道上。
   */
  const session = sessionKeyOf(payload, { allowContext: env.affinityContext })
  const sessionHash = shortSessionHash(session.hash)

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
    source: 'gateway',
    sessionHash
  }

  /**
   * 早退：记一条零用量的日志，再返回 OpenAI 风格的错误。
   *
   * 被拒的请求同样要留痕 —— 否则「为什么这个 key 老是 403」只能靠猜。
   * 日志里的 error 比返回给调用方的 message 更简短：前者给运维看，后者给调用方看。
   */
  const rejectEarly = (opts: {
    status: Parameters<typeof openaiError>[1]
    logError: string
    message: string
    type: string
    code: string
  }): Response => {
    fireAndForgetLog({
      ...baseLog,
      statusCode: opts.status,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimated: false,
      latencyMs: Date.now() - startedAt,
      ttftMs: null,
      error: opts.logError
    })
    return openaiError(c, opts.status, opts.message, opts.type, opts.code)
  }

  // ① 模型白名单
  if (key.model_allow.length > 0 && model && !key.model_allow.includes(model)) {
    return rejectEarly({
      status: 403,
      logError: `模型 ${model} 不在允许列表`,
      message: `模型「${model}」不在该 API Key 的允许列表内`,
      type: 'invalid_request_error',
      code: 'model_not_allowed'
    })
  }

  // ② 速率限制
  const rl = await checkRateLimit(key.id, key.rpm_limit)
  if (!rl.ok) {
    c.header('retry-after', String(rl.retryAfterSec))
    c.header('x-ratelimit-limit-requests', String(rl.limit))
    c.header('x-ratelimit-remaining-requests', '0')
    return rejectEarly({
      status: 429,
      logError: `超出速率限制（${rl.limit}/分钟）`,
      message: `超出速率限制：${rl.limit} 次/分钟`,
      type: 'rate_limit_error',
      code: 'rate_limit_exceeded'
    })
  }
  c.header('x-ratelimit-limit-requests', String(rl.limit))
  c.header('x-ratelimit-remaining-requests', String(Math.max(0, rl.remaining)))

  // ③ 配额预检
  const usageInfo = await loadKeyUsage(key.id)
  if (usageInfo && quotaExceeded(usageInfo.usedTokens, usageInfo.quotaTokens)) {
    return rejectEarly({
      status: 402,
      logError: 'Token 配额已用尽',
      message: `Token 配额已用尽（${usageInfo.usedTokens}/${usageInfo.quotaTokens}）`,
      type: 'insufficient_quota',
      code: 'quota_exceeded'
    })
  }

  /*
   * 路由策略（可配）：失败冷却时长 + 是否跳过打满窗口的账户。
   *
   * 一次请求读一次（内部有 Redis 短缓存，5 秒），不逐次查库。
   */
  const routing = await getRoutingSettings()

  // ④ 选路（会话亲和在这里生效）
  const pick = await selectTargets(key, model, session)
  if (!pick.ok) {
    return rejectEarly({
      status: 503,
      logError: pick.message,
      message: pick.message,
      type: 'api_error',
      code: pick.code
    })
  }
  const firstTarget = pick.targets[0]!
  let channel = firstTarget.channel
  let upstreamModel = firstTarget.upstreamModel

  /*
   * ④.5 「只暴露映射模型」：未命中的映射一律不受理。
   *
   * 放在选路之后是因为这时才知道→哪个渠道：同一个模型名可能落在没开开关的
   * 渠道上（照旧可用），只有真正要落到开了开关的渠道时才拒绝。
   * 走映射（viaMapping）不受影响 —— 那正是被允许的入口。
   */
  if (model && channel.hide_unmapped_models && !firstTarget.viaMapping) {
    return rejectEarly({
      status: 404,
      logError: `模型 ${model} 未映射（渠道 ${channel.name} 仅暴露映射模型）`,
      message: `模型「${model}」在该渠道未配置映射，且该渠道只暴露映射模型`,
      type: 'invalid_request_error',
      code: 'model_not_found'
    })
  }
  /*
   * ⑤ 上游账户 + 故障转移（双层：先换号，再换渠道）。
   *
   * 外层 = 候选渠道（别名映射的多个目标，已按会话亲和/哈希排好序），
   * 内层 = 该渠道的账户（优先级梯队 + 权重轮转）。
   *
   * 三条约束照旧：
   *   ① 可重试才换 —— 400/404 换号换渠道都一样失败，直接透传上游原文；
   *   ② 客户端断开或整体超时就停 —— 再换只会拖长响应；
   *   ③ 有上限 —— 否则一个坏请求会打穿所有账户并把它们全打进冷却。
   *
   * 换渠道有额外代价：会话粘性断了，上游前缀缓存下一次要重建。
   * 所以渠道上限默认只有 2（`PORTARA_MAX_CHANNEL_ATTEMPTS`），
   * 且换成功之后要**把亲和改写到新渠道**，避免下一轮又打回坏渠道。
   */
  let account: AccountRow | null = null
  let upstreamHeaders: ReturnType<typeof buildUpstreamHeaders> | null = null
  let res: Response | null = null
  let lastUpstreamError: Response | null = null
  let lastFailure = ''
  let plan: ReturnType<typeof planUpstreamRequest> | null = null
  let url = ''
  let protocol: 'openai' | 'anthropic' = 'openai'
  let signal: AbortSignal = c.req.raw.signal
  /** 亲和命中的目标是否被换掉了 —— 换掉就要改写 Redis 里的记录 */
  let affinityDrifted = false

  const channelLimit = Math.min(env.maxChannelAttempts, pick.targets.length)

  for (const target of pick.targets.slice(0, channelLimit)) {
    channel = target.channel
    upstreamModel = target.upstreamModel

    // 每个渠道的协议/Base URL 都可能不同（混杂模式 + 逐模型覆盖），plan 必须逐渠道算
    let outPayload: Record<string, unknown> | null = payload
    if (payload && upstreamModel && upstreamModel !== model) {
      outPayload = { ...payload, model: upstreamModel }
    }
    plan = planUpstreamRequest({
      channel: channel as unknown as Parameters<typeof planUpstreamRequest>[0]['channel'],
      upstreamModel,
      restPath,
      payload: outPayload,
      rawBody: raw,
      injectStreamUsage: opts.scanUsage,
      payloadRewritten: upstreamModel !== model
    })
    if (plan.warnings.length > 0) {
      console.warn(
        `[portara] 协议翻译提示（${channel.name}）：${plan.warnings.join('；')}`
      )
    }
    url = plan.url
    protocol = plan.protocol
    // 整体预算：多次尝试共用，不因换号/换渠道而翻倍
    signal = AbortSignal.any([
      c.req.raw.signal,
      AbortSignal.timeout(channel.timeout_ms)
    ])

    // 会话亲和：同一会话优先回到它上次用的账户（缓存按账户计）
    const preferAccountId =
      session.hash && pick.affinity?.channelId === channel.id
        ? (pick.affinity?.accountId ?? '')
        : ''
    const candidates = await pickAccounts(channel.id, await nextAccountRotation(), {
      preferId: preferAccountId || undefined,
      skipExhaustedWindows: routing.skipExhaustedWindows
    })
    if (candidates.length === 0) {
      lastFailure = `渠道「${channel.name}」没有可用的上游账户`
      continue
    }

    const attemptLimit = Math.min(MAX_ACCOUNT_ATTEMPTS, candidates.length)
    for (const candidate of candidates.slice(0, attemptLimit)) {
      const upstreamKey = tryDecryptKey(candidate.key_cipher)
      if (upstreamKey === null) {
        lastFailure = `账户「${candidate.name}」的密钥无法解密`
        await markAccountFailure(
          candidate.id,
          lastFailure,
          Math.max(routing.accountFailureCooldownSec, COOLDOWN.auth)
        )
        continue
      }

      const headers = buildUpstreamHeaders(
        upstreamKey,
        c.req.header('content-type') ?? 'application/json',
        {
          // 渠道级请求头必须在网关路径同样生效，否则「能测通却转发失败」
          extraHeaders: channel.extra_headers ?? {},
          vendor: channel.vendor ?? 'generic',
          protocol: plan.protocol,
          channelId: channel.id,
          payload,
          contentEncoding: c.req.header('content-encoding')
        }
      )

      try {
        const attempt = await upstreamFetch(
          url,
          { method: c.req.method, headers: headers.headers, body: plan.bodyText, signal },
          target.proxy
        )
        account = candidate
        upstreamHeaders = headers

        if (attempt.ok) {
          await markAccountSuccess(candidate.id)
          res = attempt
          break
        }
        if (!isRetriableStatus(attempt.status)) {
          // 换号也没用：把上游原文原样交给后续处理
          res = attempt
          break
        }

        // 可重试：留下原文（全部失败时给客户端看这个，比网关自造的 502 有用）
        const text = await attempt.text()
        lastFailure = `上游 ${attempt.status}：${text.slice(0, 200)}`
        const retryAfter = Number(attempt.headers.get('retry-after'))
        /*
         * 冷却时长：**设置项说了算**，只有两处例外比它更长
         *   ① 401/403（凭据坏了）—— 至少要 COOLDOWN.auth
         *   ② 上游明确给了 Retry-After，且比设置值更大 —— 尊重上游
         * 这样"最近一次失败的上游默认 1 小时不路由"就是可预期的默认行为。
         */
        if (isQuotaExhaustionResponse(attempt.status, text)) {
          /*
           * 上游明确说「额度用尽」→ 阶梯冷冻，而**不是**通用失败冷却。
           *
           * 两套计时必须分开写：markQuotaExhaustedResponse 只动
           * quota_cooldown_*，不碰 cooldown_until；否则一次 5xx 的短冷却
           * 就能把这里 3 天的冷冻冲掉。
           *
           * 幂等：同一冷冻期内重复命中不会递增/延长（SQL 条件更新保证）。
           */
          const quota = await markQuotaExhaustedResponse(candidate.id, lastFailure)
          if (quota) {
            console.warn(
              `[portara] 账户「${candidate.name}」额度用尽，第 ${quota.level} 次冷冻 ` +
                `${formatQuotaCooldown(quota.secs)}${quota.applied ? '' : '（冷冻期内，保持原样）'}`
            )
          }
        } else {
          const base = cooldownFor(
            attempt.status,
            Number.isFinite(retryAfter) ? retryAfter : null
          )
          await markAccountFailure(
            candidate.id,
            lastFailure,
            Math.max(base, routing.accountFailureCooldownSec)
          )
        }
        lastUpstreamError = new Response(text, {
          status: attempt.status,
          headers: { 'content-type': attempt.headers.get('content-type') ?? 'application/json' }
        })
      } catch (err) {
        const clientGone = c.req.raw.signal.aborted
        const timedOut = !clientGone && signal.aborted
        lastFailure = clientGone
          ? '客户端已断开'
          : timedOut
            ? `上游响应超时（${channel.timeout_ms}ms）`
            : `上游连接失败：${err instanceof Error ? err.message : String(err)}`

        await markAccountFailure(
          candidate.id,
          lastFailure,
          Math.max(routing.accountFailureCooldownSec, COOLDOWN.upstream)
        )
        // 客户端没了 / 整体预算耗尽 —— 换号没有意义
        if (clientGone || timedOut) break
      }
    }

    if (res) break
    // 这个渠道整层失败 → 换下一个候选渠道（若有）
    if (pick.targets.indexOf(target) < channelLimit - 1) affinityDrifted = true
  }

  /*
   * 会话亲和的落账。
   *
   * 只在**真正拿到响应**且是走映射的多目标场景才写：
   *   - 响应失败（504/上游全挂）时写亲和没有意义，下一次自然会重选
   *   - 单渠道（无别名）不需要渠道亲和，但账户亲和仍有用，所以照写
   * `affinityDrifted` 时直接覆盖（旧记录指向已失败的渠道，留着会一直打回坏目标）。
   */
  if (session.hash && res && account) {
    const pin: AffinityPin = { channelId: channel.id, accountId: account.id }
    const changed =
      !pick.affinity ||
      pick.affinity.channelId !== pin.channelId ||
      pick.affinity.accountId !== pin.accountId
    if (changed || affinityDrifted) {
      await setAffinity(model, session.hash, pin, env.affinityTtlSeconds)
    }
  } else if (session.hash && !res) {
    // 这一轮彻底失败：清掉亲和，下一轮重新按哈希挑（避免一直粘在坏目标上）
    await clearAffinity(model, session.hash)
  }

  const logCtx = {
    ...baseLog,
    channelId: channel.id,
    channelName: channel.name,
    accountId: account?.id ?? null,
    accountName: account?.name ?? '',
    upstreamModel
  }

  // 全部尝试都没拿到 2xx/不可重试响应：优先把上游最后一次的拒绝交给客户端
  res ??= lastUpstreamError
  if (!res) {
    const clientGone = c.req.raw.signal.aborted
    fireAndForgetLog({
      ...logCtx,
      statusCode: clientGone ? 499 : 504,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimated: false,
      latencyMs: Date.now() - startedAt,
      ttftMs: null,
      error: lastFailure || '上游不可达'
    })
    if (clientGone) return new Response(null, { status: 499 })
    return openaiError(c, 504, lastFailure || '上游不可达', 'api_error', 'upstream_unreachable')
  }

  const sessionEcho = sessionEchoOf(upstreamHeaders?.session ?? null)

  const contentType = res.headers.get('content-type') ?? 'application/json'
  const isStream = contentType.includes('text/event-stream') || (streamFlag && res.ok)

  // ⑦ Anthropic 上游：响应要翻回 OpenAI 格式（流式与非流式都是）
  if (protocol === 'anthropic') {
    // 流式：逐事件翻译，原字节无法直通
    if (isStream && res.body) {
      const stream = translateAnthropicStream(
        res.body,
        model || upstreamModel,
        (usage, ttftMs) => {
          fireAndForgetLog({
            ...logCtx,
            statusCode: res.status,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            estimated: false,
            latencyMs: Date.now() - startedAt,
            ttftMs,
            error: ''
          })
        },
        startedAt
      )

      return new Response(stream, {
        status: res.status,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'x-accel-buffering': 'no',
          'x-portara-channel': channel.name,
          'x-portara-protocol': 'anthropic',
          ...sessionEcho
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
        headers: {
          'content-type': contentType,
          'x-portara-protocol': 'anthropic',
          ...sessionEcho
        }
      })
    }

    const translated = translateAnthropicJson(text, model || upstreamModel)

    fireAndForgetLog({
      ...logCtx,
      statusCode: res.status,
      promptTokens: translated.usage.promptTokens,
      completionTokens: translated.usage.completionTokens,
      totalTokens: translated.usage.totalTokens,
      estimated: false,
      latencyMs: Date.now() - startedAt,
      ttftMs: null,
      error: ''
    })

    return new Response(translated.body, {
      status: res.status,
      headers: {
        'content-type': 'application/json',
        'x-portara-channel': channel.name,
        'x-portara-protocol': 'anthropic',
        ...sessionEcho
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
        'x-portara-channel': channel.name,
        ...sessionEcho
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
      'x-portara-channel': channel.name,
      ...sessionEcho
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
    /*
     * 「只暴露映射模型」的渠道**不贡献原始模型名**。
     *
     * 不是「过滤掉没有映射的那几个」，而是整个不贡献：
     * 它要对外呈现的名字就是映射别名，而别名上面已经收进来了。
     * 若按「有没有映射」逐个判，就得在这里反查映射表，同一件事会有两处口径。
     */
    if (ch.hide_unmapped_models) continue
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
