import { randomUUID } from 'node:crypto'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { query } from '../db.js'
import { clientIp, openaiError } from '../lib/http.js'
import { apiKeyAuth } from '../middleware/auth.js'
import { redis } from '../redis.js'
import { fireAndForgetLog, loadKeyUsage } from '../services/logger.js'
import { recordLbEvent } from '../services/lbEvents.js'
import {
  precheckBilling,
  releaseBillingReservation,
  settleRequestBilling
} from '../services/billing.js'
import {
  COOLDOWN,
  MAX_ACCOUNT_ATTEMPTS,
  type AccountRow,
  cooldownFor,
  isRetriableStatus,
  markAccountFailure,
  markAccountSuccess,
  markQuotaExhaustedResponse,
  networkFailureCooldownSec,
  pickAccounts
} from '../services/accounts.js'
import {
  formatQuotaCooldown,
  isQuotaExhaustionResponse,
  isTransientConcurrencyLimit,
  parseQuotaResetAt
} from '../services/quotaSignal.js'
import { tryDecryptKey } from '../services/channels.js'
import {
  QUEUE_POLL_MS,
  acquireChannelSlot,
  queueTimeoutMs,
  releaseChannelSlot
} from '../services/concurrency.js'
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
  nextAffinityPin,
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

/** 排队的睡眠：可被客户端断开 / 整体超时提前打断 */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 并发相关的响应头：排队耗时（0 表示没排队 / 未启用） */
function concurrencyHeadersOf(waitMs: number): Record<string, string> {
  return waitMs > 0 ? { 'x-portara-concurrency-wait-ms': String(Math.round(waitMs)) } : {}
}

/**
 * 把「释放并发槽位」挂到响应体的生命周期上。
 *
 * 流式响应在 return 之后才真正传输，所以不能用 try/finally 立即释放 ——
 * 那样并发计数会在请求还在跑的时候就掉下来，闸门等于没开。
 * flush（正常读完）与 cancel（客户端断开）各释放一次，靠调用方的幂等标记去重。
 */
function wrapStreamWithRelease(body: ReadableStream, release: () => void): ReadableStream {
  return body.pipeThrough(
    new TransformStream({
      flush() {
        release()
      },
      cancel() {
        release()
      }
    })
  )
}

/**
 * 打上游 + **原地重试**。
 *
 * 用户要的语义：一次网络抖动不该把整个会话打断。同一账户上重试一次，
 * 比立刻换号便宜得多 —— 不丢上游前缀缓存，也不会给别的号加压力。
 *
 * 只有在"换号也没用"的错误上才不重试（由调用方判断），这里只负责
 * 连接层的抖动：fetch 抛错 / 连接被重置 / 读响应头前断开。
 *
 * `signal` 同时代表客户端断开与整体超时；一旦 abort 立即停止重试。
 */
async function fetchWithRetries(args: {
  url: string
  init: RequestInit
  proxy: Parameters<typeof upstreamFetch>[2]
  signal: AbortSignal
  attempts: number
  onAttempt?: (attemptIndex: number) => void
}): Promise<Response> {
  const total = Math.max(1, args.attempts)
  let lastErr: unknown = null
  for (let i = 0; i < total; i++) {
    args.onAttempt?.(i)
    try {
      return await upstreamFetch(args.url, { ...args.init, signal: args.signal }, args.proxy)
    } catch (err) {
      lastErr = err
      if (args.signal.aborted) throw err
      if (i >= total - 1) throw err
      const backoff = 120 + Math.floor(Math.random() * 180)
      console.warn(
        `[portara] 上游连接失败（${err instanceof Error ? err.message : String(err)}），` +
          `${backoff}ms 后原地重试（第 ${i + 2}/${total} 次）`
      )
      await sleepUnlessAborted(backoff, args.signal)
    }
  }
  throw lastErr ?? new Error('上游请求失败')
}

async function handleProxy(c: Context, restPath: string, opts: ProxyOptions) {
  const key = c.get('apiKey') as ApiKeyRow
  const ip = clientIp(c)
  const startedAt = Date.now()
  /**
   * 请求级关联 id：只用于把同一次调用的多条故障转移事件串起来，
   * **不改动现有 request_logs 结构**。
   */
  const requestId = randomUUID()

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

  /**
   * 计费归属：以 Key 的 owner 为准。
   *
   * 无主 Key（user_id 为空）在 apiKeyAuth 里已被 403 拒绝，这里只是类型上
   * 仍可能为 null；真正的计费主体一定有值。
   */
  const billingUserId = key.user_id

  /** 本次请求在 Redis 里的预估预留（0 = 未占用 / 已释放） */
  let billingReservation = 0
  let billingReservationReleased = false

  /**
   * 释放预留：重复调用无副作用。
   *
   * 结算回调（含 finally）、预检后的各类早退、上游失败 / 空流都会走到这里；
   * 万一有遗漏，Redis 的 300 秒 TTL 是最后一道兜底。
   */
  async function releaseReservationOnce(): Promise<void> {
    if (billingReservationReleased || billingReservation <= 0 || !billingUserId) return
    billingReservationReleased = true
    await releaseBillingReservation(billingUserId, billingReservation)
  }

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
    extra?: Record<string, unknown>
  }): Response => {
    // 预检已经预留过额度时，早退必须归还，否则这个用户会被自己的失败请求占住额度
    void releaseReservationOnce()
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
    return openaiError(c, opts.status, opts.message, opts.type, opts.code, opts.extra)
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
   * ④.6 计费预检（套餐 / 余额 / 各限额窗口 / 并发预留）。
   *
   * 放在选路之后、真正打上游之前：预估成本需要知道「这次请求命中哪个渠道」。
   * 未绑定渠道的 Key 在选路前无从得知渠道费率；若只按全局默认估算，而全局
   * 默认又是 0，预留就永远是 0，防并发透支形同虚设。绑定 Key 同样受益——
   * 它的渠道是确定的，但上游模型可能来自映射，这里一并取选路结果。
   *
   * 拒绝仍发生在任何上游请求之前，只是多花一次（本地的）选路计算。
   * 资格结果在 precheckBilling 内部缓存 15 秒；扣费/改套餐/调余额会主动
   * 删除该缓存，失败结果**不缓存**（充值后立刻生效）。
   *
   * **未绑套餐不再放行**：没有套餐 → 402 no_plan。免费用户也要显式绑定
   * 内置 Free 套餐（迁移 024），否则「谁在用免费额度」没有可追溯的状态。
   *
   * 预检通过后会按预估成本在 Redis 里预留额度；拿到 billing.estimate 后，
   * 后续所有路径（早退 / 失败 / 结算）都必须释放它。
   */
  if (billingUserId) {
    const billing = await precheckBilling(billingUserId, {
      maxTokens: payload?.max_tokens,
      channelId: channel.id,
      model,
      upstreamModel
    })
    if (!billing.ok) {
      if (billing.code === 'no_plan') {
        return rejectEarly({
          status: 402,
          logError: '未绑定计费套餐',
          message: '未绑定计费套餐，请联系管理员绑定后再调用',
          type: 'insufficient_quota',
          code: 'no_plan'
        })
      }
      if (billing.code === 'insufficient_balance') {
        const available = billing.available ?? billing.balance ?? 0
        const reserved = billing.reserved ?? 0
        return rejectEarly({
          status: 402,
          logError:
            `计费余额不足（余额 ${billing.balance ?? 0}，已预留 ${reserved}，可用 ${available}）`,
          message:
            `计费余额不足，请充值后再试（当前余额 ${billing.balance ?? 0}，` +
            `已预留 ${reserved}，可用 ${available}）`,
          type: 'insufficient_quota',
          code: 'insufficient_balance',
          extra: {
            balance: billing.balance ?? 0,
            available,
            reserved
          }
        })
      }
      // 结构化提示：body.error 里带 window/limit/used/resetAt，header 里也放一份，
      // 便于 SDK 或网关日志直接读到「哪个窗口、何时重置」。
      c.header('x-portara-billing-window', billing.window ?? '')
      c.header('x-portara-billing-reset-at', billing.resetAt ?? '')
      c.header('retry-after', String(billing.resetAt ? Math.max(1, Math.ceil((Date.parse(billing.resetAt) - Date.now()) / 1000)) : 60))
      return rejectEarly({
        status: 429,
        logError: `用量限额超限（${billing.window}：${billing.used}/${billing.limit}）`,
        message: `用量限额已超限：${billing.window} 窗口已用 ${billing.used}/${billing.limit}，重置时间 ${billing.resetAt}`,
        type: 'rate_limit_error',
        code: 'usage_limit_exceeded',
        extra: {
          window: billing.window,
          limit: billing.limit,
          used: billing.used,
          resetAt: billing.resetAt
        }
      })
    }
    billingReservation = billing.estimate
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
  /**
   * 本轮已确认的旧 pin。被健康度判定丢弃后会置空 ——
   * 既阻止后续渠道候选再拿它做提前，也保证成功后会重新落 pin。
   */
  let affinity = pick.affinity

  /**
   * 故障转移事件的尝试序号：跨渠道累计，从 1 开始。
   * 与「第几个账户」不同 —— 换渠道后账户序号会重置，但一次请求的尝试总数不会。
   */
  let attemptNo = 0
  /**
   * 上一次失败的账户 —— 最终成功时用它写 failover_success 的 prev_*。
   * 只在真正打过上游且失败时赋值；首击成功保持 null，不产生任何事件。
   */
  let lastFailedAccount: { id: string; name: string } | null = null

  /**
   * 成功请求的结算回调（传给 fireAndForgetLog，拿到 request_log id 后执行）。
   *
   * 只在这三条同时成立时返回回调：
   *   ① Key 有 owner（有主体可扣）；
   *   ② 上游响应是 2xx（失败请求不扣费）；
   *   ③ 此刻客户端还没断开（**流式响应结束后才结算**，断开的那次不扣）。
   *
   * 幂等由 chargeBilling 里的 request_logs.billing_charged_at 条件更新兜底：
   * 同一条日志即使被回调两次，也只会扣一次。
   */
  const billingAfterFor = (usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }): ((logId: string) => Promise<void>) | undefined => {
    if (!billingUserId) return undefined
    if (!res?.ok || c.req.raw.signal.aborted) {
      // 失败 / 客户端断开：不会结算，立即归还预留
      void releaseReservationOnce()
      return undefined
    }
    const channelId = channel.id
    const servedModel = upstreamModel
    // 对外模型名：命中 alias_rates 时按售价扣费；cost_money 仍是渠道成本
    const servedAlias = model
    return async (logId: string) => {
      try {
        await settleRequestBilling({
          userId: billingUserId,
          requestLogId: logId,
          channelId,
          upstreamModel: servedModel,
          alias: servedAlias,
          inputTokens: usage.promptTokens,
          outputTokens: usage.completionTokens,
          totalTokens: usage.totalTokens
        })
      } finally {
        // 结算成功 / 幂等跳过 / 结算抛错都要释放，try/finally 保证不漏
        await releaseReservationOnce()
      }
    }
  }

  /*
   * 候选渠道上限：0 = **全部候选**（默认）。
   * 用户选负载均衡就是为了"不因为一个渠道抖动/限额就中断"，
   * 所以默认把映射里的每个目标都试一遍，用总时间预算而不是次数兜底。
   */
  const channelLimit =
    env.maxChannelAttempts > 0
      ? Math.min(env.maxChannelAttempts, pick.targets.length)
      : pick.targets.length
  /**
   * 已经确认「整池额度冻结」的候选渠道里最早的重置时间。
   *
   * 非最后一个候选渠道时**只记录并跳过**（不打上游，也不立刻 429）：
   * 别的渠道可能还有健康账户，直接返回 429 会破坏既有的跨渠道故障转移。
   * 只有走到最后一个候选渠道、且它同样整池冻结时才快速失败。
   */
  let frozenRetryAtMs: number | null = null

  /**
   * 当前持有的并发槽位（渠道 + 上限）。
   *
   * `release` 必须是幂等的：流式响应会在 flush 与 cancel 两条路径上各调一次，
   * 非流式则在 return 之前直接调用。用闭包内的一次性标记去重。
   */
  let slotHolder: { channelId: string; limit: number; release: () => void } | null = null
  const takeSlot = (channelId: string, limit: number): (() => void) => {
    let released = false
    return () => {
      if (released) return
      released = true
      void releaseChannelSlot(channelId, limit)
    }
  }
  /** 立即归还（非流式 / 出错返回前调用；重复调用无害） */
  const releaseSlotNow = (): void => {
    slotHolder?.release()
    slotHolder = null
  }
  /** 排队累计耗时（诊断 / 面板用） */
  let queueWaitMs = 0
  /** 当前请求的并发排队头（0 = 没排队） */
  const concurrencyHeaders = (): Record<string, string> => concurrencyHeadersOf(queueWaitMs)

  /**
   * 并发排队的**整体**截止时间。
   *
   * 一个请求跨多个候选渠道时，排队预算只算一次 ——
   * 若每个渠道各排一个 queueTimeoutMs，最坏会挂 N×30s，
   * 客户端早就超时了，而请求还占着连接不放。
   */
  const concDeadline = Date.now() + queueTimeoutMs()

  /**
   * 为某个渠道申请名额；已满则排队到整体截止时间。
   *
   * 返回 false 表示「这个渠道在剩余预算内始终满载」，调用方应换下一个候选渠道；
   * 换到最后一个仍失败就是整站并发满载（429 channel_concurrency_full）。
   */
  const acquireForChannel = async (channelId: string, limit: number): Promise<boolean> => {
    const waitedFrom = Date.now()
    for (;;) {
      const slot = await acquireChannelSlot(channelId, limit)
      if (slot.ok) {
        queueWaitMs += Date.now() - waitedFrom
        slotHolder = { channelId, limit, release: takeSlot(channelId, limit) }
        return true
      }
      if (c.req.raw.signal.aborted || Date.now() >= concDeadline) return false
      await sleepUnlessAborted(QUEUE_POLL_MS, c.req.raw.signal)
    }
  }

  /*
   * 故障转移的**总时间预算**与会话连续性语义：
   *
   *   ① 同一（渠道, 账户）先原地重试（网络抖动），见 fetchWithRetries；
   *   ② 不行就换号、换渠道，**把全部候选走一遍**（不再默认只试 2 个）；
   *   ③ 全走完仍失败 → 抖动退避后**整轮再来**，最多 maxFailoverPasses 轮；
   *   ④ 只有预算用完 / 轮次用尽，才把失败交给客户端。
   *
   * 也就是说：只要还有一个可能恢复的上游，就不把会话打断。
   */
  const failoverDeadline = startedAt + env.failoverBudgetMs
  let passNo = 0
  /**
   * 本轮是否出现过**值得重试**的失败（网络抖动 / 5xx / 并发撞线 / 非额度 429）。
   *
   * 只有这类失败才值得整轮重来。额度用尽、400 参数错误、模型不存在这些
   * "再试一次结果也一样"的失败，重试只会白打上游、把额度/限流更快耗光。
   */
  let sawTransientFailure = false

  /*
   * 用 while + 可变顺序而不是 for-of：某个候选渠道并发已满时，
   * 可能等来的是**另一个**候选渠道先空出来，那时把它挪到当前位置继续，
   * 而不是傻等原顺序里那个满的渠道。
   */
  while (true) {
    passNo++
    /** 本轮开始时的尝试计数：用于判断"这一轮到底有没有真的打过上游" */
    const attemptsAtPassStart = attemptNo
    const candidateOrder = pick.targets.slice(0, channelLimit)
    let orderIndex = 0
    while (orderIndex < candidateOrder.length) {
    const target = candidateOrder[orderIndex]
    const targetIndex = orderIndex
    orderIndex++
    channel = target.channel
    upstreamModel = target.upstreamModel

    // 每个渠道的协议/Base URL 都可能不同（混杂模式 + 逐模型覆盖），plan 必须逐渠道算
    let outPayload: Record<string, unknown> | null = payload
    if (payload && upstreamModel && upstreamModel !== model) {
      outPayload = { ...payload, model: upstreamModel }
    }
    /*
     * plan 也可能抛（例如协议不支持该端点、混杂模式没配覆盖）。
     * 这类错误具有**渠道局部性** —— 换一个渠道可能就正常了，
     * 所以不能让它把整个请求打断，只记录并跳过。
     */
    try {
      plan = planUpstreamRequest({
        channel: channel as unknown as Parameters<typeof planUpstreamRequest>[0]['channel'],
        upstreamModel,
        restPath,
        payload: outPayload,
        rawBody: raw,
        injectStreamUsage: opts.scanUsage,
        payloadRewritten: upstreamModel !== model
      })
    } catch (err) {
      lastFailure = `渠道「${channel.name}」请求计划生成失败：${err instanceof Error ? err.message : String(err)}`
      continue
    }
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
      session.hash && affinity?.channelId === channel.id
        ? (affinity?.accountId ?? '')
        : ''
    const picked = await pickAccounts(channel.id, await nextAccountRotation(), {
      preferId: preferAccountId || undefined,
      preferPinnedAt: preferAccountId ? affinity?.pinnedAt : undefined,
      affinityMaxAgeSec: env.affinityMaxAgeSeconds,
      skipExhaustedWindows: routing.skipExhaustedWindows
    })
    const candidates = picked.accounts

    /*
     * 陈旧亲和主动清理：pin 指向的账户已经不可用（不在池中 / 冷却 / 耗尽）时，
     * 不要把它留在 Redis 里让下一轮继续 unshift —— 直接清掉，按正常选路走，
     * 成功后再由下面按新账户重新落 pin。
     *
     * 唯一不清的例外是「整个池子都 usageLimited」：此时 pin 保留但**没有提前**，
     * 按正常顺序参与，免得网关自己造 503。
     */
    if (preferAccountId && picked.affinityDropped) {
      console.warn(
        `[portara] 会话亲和已丢弃（alias=${model}, account=${preferAccountId}, ` +
          `reason=${picked.affinityDropReason ?? 'not_in_pool'}）`
      )
      if (session.hash) await clearAffinity(model, session.hash)
      affinity = null
    }

    if (candidates.length === 0) {
      lastFailure = `渠道「${channel.name}」没有可用的上游账户`
      continue
    }

    /*
     * 整池额度冻结 → 快速失败，不再打上游。
     *
     * 为什么值得单独一条短路：额度用尽不是瞬时故障，上游已经明确说了
     * 「什么时候恢复」（reset_at）。继续按"退化到最差账户"打过去，
     * 只会把同一个 402 再换一次，并把上游错误透传给客户端 —— 用户看到
     * 的就是「请求额度已用尽」反复出现。
     *
     * 触发条件很窄，三条同时成立：
     *   ① 池子里没有任何 ok 账户，全部是 usageLimited / quotaCooling；
     *   ② 能取到最早的重置时间（usageLimited 但不知道何时恢复的不算）；
     *   ③ 已经走到最后一个候选渠道（否则先让别的渠道试试）。
     * 其余情况一律维持既有退化语义，不自己造 503。
     */
    if (picked.quotaPool.allFrozen && picked.quotaPool.retryAtMs !== null) {
      /*
       * 整池冻结：**只记录、不在这里返回**。
       *
       * 旧实现在"最后一个候选渠道"上直接 429 —— 但那时可能还有别的渠道
       * 只是瞬时抖动，下一轮就会恢复。把"最终失败"的判断推迟到
       * 全部重试轮次都走完之后（见循环末尾），才符合"能救就救"的语义。
       */
      const retryAtMs = picked.quotaPool.retryAtMs
      frozenRetryAtMs =
        frozenRetryAtMs === null ? retryAtMs : Math.min(frozenRetryAtMs, retryAtMs)
      lastFailure = `渠道「${channel.name}」所有上游账户额度均已用尽`
      continue
    }

    /*
     * 并发闸门（渠道级）。
     *
     * 位置很关键：必须在**打上游之前**、且每个渠道只申请一次 ——
     * 换号不额外占名额（同一个上游池共享并发额度），换渠道才重新申请。
     * 已满时排队等待：所有候选渠道都满 → 请求挂起而不是立刻失败，
     * 只要任意一个渠道空出来就继续（见 acquireSlotWithQueue）。
     */
    /*
     * 并发闸门（渠道级）：必须在**打上游之前**、且每个渠道只申请一次 ——
     * 换号不额外占名额（同一上游池共享并发额度），换渠道才重新申请。
     * 已满时排队；排队期间如果有别的候选渠道空出来，就先去那个渠道。
     */
    const concLimit = channel.max_concurrency ?? 0
    if (concLimit > 0) {
      const got = await acquireForChannel(channel.id, concLimit)
      if (!got) {
        lastFailure = `渠道「${channel.name}」并发已满（上限 ${concLimit}）`
        if (targetIndex < channelLimit - 1) {
          // 还有别的候选渠道：它的并发可能没满，先去看它
          continue
        }
        baseLog.channelId = channel.id
        baseLog.channelName = channel.name
        baseLog.upstreamModel = upstreamModel
        return rejectEarly({
          status: 429,
          logError: `所有候选渠道并发均已满载（channel_concurrency_full），排队 ${queueTimeoutMs()}ms`,
          message: '所有候选渠道的并发均已满载，请稍后重试',
          type: 'rate_limit_error',
          code: 'channel_concurrency_full',
          extra: { retryAfter: 1 }
        })
      }
    }

    /*
     * 账户上限：0 = 该渠道所有可用账户（默认）。
     * 早期默认 3 会让"第 4 个之后的号"永远轮不到，等于渠道可用性被前 3 个号绑架。
     */
    const attemptLimit =
      MAX_ACCOUNT_ATTEMPTS > 0 ? Math.min(MAX_ACCOUNT_ATTEMPTS, candidates.length) : candidates.length
    for (const candidate of candidates.slice(0, attemptLimit)) {
      /*
       * 总尝试次数闸门：时间是主预算，这个防"所有上游都秒失败时一分钟打出上百次"。
       * 正常故障转移远远用不到 24 次。
       */
      if (attemptNo >= env.maxTotalAttempts) {
        lastFailure = `本请求的上游尝试次数已达上限（${env.maxTotalAttempts}）`
        break
      }
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

      const attemptStartedAt = Date.now()
      try {
        /*
         * 每次真正打上游算一次尝试 —— 跨渠道累计（见 attemptNo 的注释）。
         * 同一账户的网络抖动由 fetchWithRetries 原地重试（每次真实请求都计数，
         * 面板上的 attempt 才是真实的上游请求次数）。
         */
        const attempt = await fetchWithRetries({
          url,
          init: { method: c.req.method, headers: headers.headers, body: plan.bodyText },
          proxy: target.proxy,
          signal,
          attempts: env.attemptsPerCandidate,
          onAttempt: () => {
            attemptNo++
          }
        })
        account = candidate
        upstreamHeaders = headers

        if (attempt.ok) {
          await markAccountSuccess(candidate.id)
          /*
           * 之前失败过、这次换号成功 → 记一条 failover_success。
           * 首击成功时 lastFailedAccount 为 null，不写任何事件（避免热路径写入放大）。
           */
          if (lastFailedAccount) {
            await recordLbEvent({
              requestId,
              alias: model,
              sessionHash,
              channelId: channel.id,
              channelName: channel.name,
              accountId: candidate.id,
              accountName: candidate.name,
              prevAccountId: lastFailedAccount.id,
              prevAccountName: lastFailedAccount.name,
              attempt: attemptNo,
              outcome: 'failover_success',
              statusCode: attempt.status,
              reason: '',
              latencyMs: Date.now() - attemptStartedAt
            })
          }
          res = attempt
          break
        }
        /*
         * 先读原文，再判断「值不值得换号」。
         *
         * 必须这样排序的原因：部分上游把「余额/额度用尽」报成 **400**
         * （CommandCode："You have insufficient credits to make this request"），
         * 而 400 在 isRetriableStatus 里是不可重试的。若先按状态码短路，
         * 这类上游就会：
         *   ① 不换号/不换渠道 —— 把 400 原文透传给客户端，用户看到「额度已用尽」；
         *   ② 不冻结坏账户 —— 下一次请求继续打同一个号，反复复现。
         * 所以额度用尽的判定必须先于「不可重试」的短路。
         */
        const text = await attempt.text()
        /*
         * 「上游瞬时并发限制」必须先于额度判定。
         *
         * 形态（OpenDesign / CommandCode 会员档）：
         *   code=tier_limit_exceeded, "membership concurrency limit exceeded: 11/10"
         * 它不带任何额度关键词，但带了 reset_at 形状的时间（并发窗口滑出时刻）。
         * 若落到通用失败冷却（设置项默认 1 小时）或额度阶梯，一个只是瞬时撞线的号
         * 会被踢很久；而网关并发一旦超过会员上限，**每个号会轮流被踢**，最后全池
         * 冷却 → 全站 400 request。
         * 正确处理：短冷却（默认 20s）+ 换号重试，让并发的另一路请求去打别的号。
         */
        const concurrencyHit = isTransientConcurrencyLimit(attempt.status, text)
        const quotaHit = isQuotaExhaustionResponse(attempt.status, text)
        if (!concurrencyHit && !quotaHit && !isRetriableStatus(attempt.status)) {
          // 换号也没用：把上游原文原样交给后续处理（body 已读走，重建响应）
          res = new Response(text, {
            status: attempt.status,
            headers: {
              'content-type': attempt.headers.get('content-type') ?? 'application/json'
            }
          })
          break
        }

        // 可重试（或额度用尽）：留下原文给后续失败兜底
        const attemptLatencyMs = Date.now() - attemptStartedAt
        lastFailure = `上游 ${attempt.status}：${text.slice(0, 200)}`
        const retryAfter = Number(attempt.headers.get('retry-after'))
        /*
         * 上游已明确给出「何时恢复」（details.reset_at / reset_at 或 Retry-After）
         * 时，额度冷冻不能还按阶梯的 5m 起步 —— 那等于明知要等一天还每小时去撞一次。
         */
        const quotaResetAt = parseQuotaResetAt(text, attempt.headers.get('retry-after'))
        /** 本次是否真的命中额度用尽（决定要不要额外写 quota_cooldown 事件） */
        let quotaEntered: { level: number; secs: number; applied: boolean } | null = null
        /*
         * 冷却时长：**设置项说了算**，只有两处例外比它更长
         *   ① 401/403（凭据坏了）—— 至少要 COOLDOWN.auth
         *   ② 上游明确给了 Retry-After，且比设置值更大 —— 尊重上游
         * 这样"最近一次失败的上游默认 1 小时不路由"就是可预期的默认行为。
         */
        if (concurrencyHit) {
          /*
           * 并发撞线：只做**短冷却**，不进额度阶梯、不写 quota_cooldown 事件。
           * 冷却时长取 env.concurrencyCooldownSec（默认 20s），并尊重上游给的
           * Retry-After —— 但上限压到 5 分钟，避免把瞬时问题当成长时间不可用。
           */
          const fromHeader = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0
          const coolSec = Math.min(300, Math.max(env.concurrencyCooldownSec, fromHeader))
          sawTransientFailure = true
          await markAccountFailure(candidate.id, lastFailure, coolSec)
          console.warn(
            `[portara] 账户「${candidate.name}」触发上游并发上限，短冷却 ${coolSec}s（可换号继续）`
          )
        } else if (quotaHit) {
          /*
           * 上游明确说「额度用尽」→ 阶梯冷冻，而**不是**通用失败冷却。
           *
           * 两套计时必须分开写：markQuotaExhaustedResponse 只动
           * quota_cooldown_*，不碰 cooldown_until；否则一次 5xx 的短冷却
           * 就能把这里 3 天的冷冻冲掉。
           *
           * 幂等：同一冷冻期内重复命中不会递增/延长（SQL 条件更新保证）。
           */
          const quota = await markQuotaExhaustedResponse(
            candidate.id,
            lastFailure,
            quotaResetAt
          )
          if (quota) {
            quotaEntered = quota
            console.warn(
              `[portara] 账户「${candidate.name}」额度用尽，第 ${quota.level} 次冷冻 ` +
                `${formatQuotaCooldown(quota.secs)}${quota.applied ? '' : '（冷冻期内，保持原样）'}`
            )
          }
        } else if (attempt.status === 401 || attempt.status === 403) {
          /*
           * 凭据坏了：这类问题"换号也没用但要尽快别再用它"，
           * 所以保留设置项的下限（默认 1 小时），避免反复用坏 key 打上游。
           */
          await markAccountFailure(
            candidate.id,
            lastFailure,
            Math.max(COOLDOWN.auth, routing.accountFailureCooldownSec)
          )
        } else if (attempt.status === 429) {
          /*
           * 限流：优先尊重上游 Retry-After，但**不超过设置项上限**。
           * 旧逻辑的 Math.max(base, 3600) 会把一次 429 变成一小时禁足，
           * 而 429 往往几秒~几分钟就恢复 —— 那正是"一丁点波动就中断"的来源。
           */
          const base = cooldownFor(attempt.status, Number.isFinite(retryAfter) ? retryAfter : null)
          sawTransientFailure = true
          await markAccountFailure(
            candidate.id,
            lastFailure,
            Math.min(routing.accountFailureCooldownSec, Math.max(COOLDOWN.rateLimit, base))
          )
        } else {
          /*
           * 5xx / 其它可重试错误：按网络失败的短阶梯退避。
           * 上游 500 常常是瞬时过载，退避 30s 比禁足 1 小时合理得多。
           */
          sawTransientFailure = true
          await markAccountFailure(
            candidate.id,
            lastFailure,
            networkFailureCooldownSec(
              candidate.consecutive_failures,
              routing.accountFailureCooldownSec
            )
          )
        }

        /*
         * 失败事件：只有「可重试的非 2xx」才会走到这里 ——
         * 400/404 换号也没用，不产生事件，避免把客户端错误记成故障转移。
         */
        await recordLbEvent({
          requestId,
          alias: model,
          sessionHash,
          channelId: channel.id,
          channelName: channel.name,
          accountId: candidate.id,
          accountName: candidate.name,
          attempt: attemptNo,
          outcome: 'attempt_failed',
          statusCode: attempt.status,
          reason: lastFailure,
          latencyMs: attemptLatencyMs
        })

        // 额度用尽额外一条：页面据此解释「这个账户为什么随后进入了冷冻」
        if (quotaEntered) {
          const untilIso = new Date(Date.now() + quotaEntered.secs * 1000).toISOString()
          await recordLbEvent({
            requestId,
            alias: model,
            sessionHash,
            channelId: channel.id,
            channelName: channel.name,
            accountId: candidate.id,
            accountName: candidate.name,
            attempt: attemptNo,
            outcome: 'quota_cooldown',
            statusCode: attempt.status,
            reason:
              `${lastFailure}（level=${quotaEntered.level}, until=${untilIso}` +
              `${quotaEntered.applied ? '' : '，冷冻期内保持原样'}）`,
            latencyMs: attemptLatencyMs
          })
        }
        lastFailedAccount = { id: candidate.id, name: candidate.name }

        lastUpstreamError = new Response(text, {
          status: attempt.status,
          headers: { 'content-type': attempt.headers.get('content-type') ?? 'application/json' }
        })
      } catch (err) {
        const attemptLatencyMs = Date.now() - attemptStartedAt
        const clientGone = c.req.raw.signal.aborted
        const timedOut = !clientGone && signal.aborted
        lastFailure = clientGone
          ? '客户端已断开'
          : timedOut
            ? `上游响应超时（${channel.timeout_ms}ms）`
            : `上游连接失败：${err instanceof Error ? err.message : String(err)}`
        if (!clientGone) sawTransientFailure = true

        /*
         * 连接失败 / 超时：**不要**用设置项里的通用冷却（默认 1 小时）。
         *
         * 这是实测踩到的坑：OpenDesign/ACP-001 只是抖了一次 `fetch failed`，
         * 就被关进 1 小时冷却；而同一时间别的号正在真·额度用尽，
         * 于是整条链路只剩「额度已用尽」这一种错误 —— 用户连续多次请求全失败。
         *
         * 网络抖动是**瞬时的**，正确做法是短冷却让它尽快回到池子里，
         * 同时用连续失败次数做退避（避免坏链路被高频重试）。
         * 上限仍然受设置项约束，但取的是 **min**：设置项配得再大，
         * 网络错误也不会被放大成一个小时的禁足。
         */
        /*
         * 客户端主动断开**不惩罚账户**：上游可能完全正常，
         * 是用户关页面/切模型导致的取消。以前这种情况也会写冷却，
         * 结果是"用户多点几次取消，好几个健康号就被轮着关进冷却"。
         */
        if (clientGone) {
          // 只记事件，不动冷却
        } else {
          await markAccountFailure(
            candidate.id,
            lastFailure,
            networkFailureCooldownSec(
              candidate.consecutive_failures,
              routing.accountFailureCooldownSec
            )
          )
        }

        // 抛异常同样算一次失败尝试（status_code 为空）
        await recordLbEvent({
          requestId,
          alias: model,
          sessionHash,
          channelId: channel.id,
          channelName: channel.name,
          accountId: candidate.id,
          accountName: candidate.name,
          attempt: attemptNo,
          outcome: 'attempt_failed',
          statusCode: null,
          reason: lastFailure,
          latencyMs: attemptLatencyMs
        })
        lastFailedAccount = { id: candidate.id, name: candidate.name }

        // 客户端没了 / 整体预算耗尽 —— 换号没有意义
        if (clientGone || timedOut) break
      }
    }

    if (res) break
    // 这个渠道整层失败：立刻归还名额，再换下一个候选渠道（若有）
    releaseSlotNow()
    if (targetIndex < channelLimit - 1) affinityDrifted = true
    } // while (orderIndex ...)

    if (res) break

    /*
     * 整轮都失败了。能不能再来一轮？
     *
     * 判断顺序即优先级：
     *   ① 客户端已经走了 → 立刻停（再重试都是白费）；
     *   ② 轮次用完 → 停；
     *   ③ 时间预算不够再撑一轮 → 停；
     *   ④ 否则抖动退避后重来 —— 上游可能只是抖了一下，
     *      也可能某个号的短冷却（网络错误 30s 起）马上就要过期。
     */
    /*
     * 整池额度冻结（**一个上游都没能打**）+ 已知恢复时间 → 这才是真正的
     * "所有上游都不可能继续"。此时给 429 + Retry-After，比让客户端等满
     * 60s 预算再收到一个 504 有用得多。
     */
    if (!res && attemptNo === attemptsAtPassStart && frozenRetryAtMs !== null) {
      const retryAfterSec = Math.max(
        1,
        Math.min(86400, Math.ceil((frozenRetryAtMs - Date.now()) / 1000))
      )
      const resetAtIso = new Date(frozenRetryAtMs).toISOString()
      c.header('retry-after', String(retryAfterSec))
      baseLog.channelId = channel?.id ?? null
      baseLog.channelName = channel?.name ?? ''
      baseLog.upstreamModel = upstreamModel
      releaseSlotNow()
      return rejectEarly({
        status: 429,
        logError: `上游账户额度均已用尽（upstream_quota_exhausted），最早 ${resetAtIso} 恢复`,
        message: `所有候选渠道的上游账户额度均已用尽，预计 ${resetAtIso} 恢复`,
        type: 'rate_limit_error',
        code: 'upstream_quota_exhausted',
        extra: { retryAfter: retryAfterSec, resetAt: resetAtIso }
      })
    }

    if (c.req.raw.signal.aborted) break
    if (attemptNo >= env.maxTotalAttempts) break
    if (passNo >= env.maxFailoverPasses) break
    /*
     * 只有瞬时类失败（网络 / 5xx / 并发撞线 / 非额度 429）才值得重来一轮。
     * 额度用尽、401、400/404 这些"再试一次结果一样"的失败，重试只是
     * 白打上游、把限流与额度耗得更快，所以直接进入最终失败处理。
     */
    if (!sawTransientFailure) break
    const passBackoffMs = 250 + Math.floor(Math.random() * 350) + (passNo - 1) * 750
    if (Date.now() + passBackoffMs >= failoverDeadline) break
    console.warn(
      `[portara] 第 ${passNo} 轮全部候选失败（${lastFailure || '未知原因'}），` +
        `${passBackoffMs}ms 后整轮重试`
    )
    // 退避期间把并发名额放掉，别占着导致别的请求排队
    releaseSlotNow()
    await sleepUnlessAborted(passBackoffMs, c.req.raw.signal)
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
    /*
     * 只在「新落 pin / 目标变更 / 旧数据补时间戳 / 失效后重落」时写。
     * 成功命中同一条亲和不写 —— 否则 pinnedAt 每轮都被刷新，
     * PORTARA_AFFINITY_MAX_AGE_SEC 就成了摆设。
     */
    const next = nextAffinityPin({
      previous: affinity,
      channelId: channel.id,
      accountId: account.id,
      now: Date.now(),
      drifted: affinityDrifted
    })
    if (next.write && next.pin) {
      await setAffinity(model, session.hash, next.pin, env.affinityTtlSeconds)
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

  /*
   * 全部尝试都没拿到 2xx：把**上游最后一次的拒绝**原样交给客户端。
   *
   * 这里刻意不改成自造错误：上游的 402/429 正文带着它自己的 code 与 reset 语义
   * （例如 `insufficient_balance` + `details.reset_at`），透传比网关另编一个
   * 更有信息量；客户端 SDK 也按上游格式解析。这一点有冒烟用例钉住。
   */
  res ??= lastUpstreamError
  if (!res) {
    const clientGone = c.req.raw.signal.aborted
    // 一个可用的上游响应都没拿到：不会结算，归还预留与并发名额
    releaseSlotNow()
    void releaseReservationOnce()
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
          }, billingAfterFor(usage))
        },
        startedAt
      )

      return new Response(wrapStreamWithRelease(stream, releaseSlotNow), {
        status: res.status,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'x-accel-buffering': 'no',
          'x-portara-channel': channel.name,
          'x-portara-protocol': 'anthropic',
          ...concurrencyHeaders(),
          ...sessionEcho
        }
      })
    }

    // 非流式：解析 Anthropic 响应 → 翻成 OpenAI 响应
    const text = await res.text()
    const parsed = parseJsonSafe(text)

    if (!res.ok || !parsed || typeof parsed !== 'object') {
      // 解析失败 / 上游非 2xx：不会结算，归还预留与并发名额
      releaseSlotNow()
      void releaseReservationOnce()
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
          ...concurrencyHeaders(),
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
    }, billingAfterFor(translated.usage))

    releaseSlotNow()
    return new Response(translated.body, {
      status: res.status,
      headers: {
        'content-type': 'application/json',
        'x-portara-channel': channel.name,
        'x-portara-protocol': 'anthropic',
        ...concurrencyHeaders(),
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
    }, billingAfterFor({
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
      totalTokens: usage?.totalTokens ?? 0
    }))

    releaseSlotNow()
    return new Response(text, {
      status: res.status,
      headers: {
        'content-type': contentType,
        'x-portara-channel': channel.name,
        ...concurrencyHeaders(),
        ...sessionEcho
      }
    })
  }

  // ⑨ 流式：tee 出两条支路 —— 一条原样下传，一条旁路扫描 usage
  const upstreamBody = res.body
  if (!upstreamBody) {
    releaseSlotNow()
    void releaseReservationOnce()
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
      }, billingAfterFor(usage))
    }
  })()

  return new Response(wrapStreamWithRelease(clientStream, releaseSlotNow), {
    status: res.status,
    headers: {
      'content-type': contentType,
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
      'x-portara-channel': channel.name,
      ...concurrencyHeaders(),
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
