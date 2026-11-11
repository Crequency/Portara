/**
 * 数据面（转发热路径）用的路由设置读取。
 *
 * 为什么单独成模块：`settings.ts` 是**纯配置模块**，被 `timezone.test.ts`
 * 这样的单测直接 import。一旦它顶部 import 了 `redis.js`，
 * ioredis 会建连接并自动重连，测试进程就退不出去（本仓库踩过两次）。
 * 需要 Redis 的东西一律放这里。
 */
import { redis } from '../redis.js'
import { getSettings } from './settings.js'

/**
 * 5 秒缓存的理由：
 *   - 管理面「不加进程内缓存」是为了多实例下"改了立刻生效"，这里用**共享的 Redis**
 *   - 数据面每个请求都要读这些项，每请求一次 SELECT 是实打实的开销
 *   - 5 秒只是兜底（绕过 API 直接改库的情况），正常路径靠写入时主动失效
 */
const ROUTING_CACHE_KEY = 'portara:settings:routing'
const ROUTING_CACHE_TTL_SEC = 5

export interface RoutingSettings {
  /** 失败后的冷却时长（秒） */
  accountFailureCooldownSec: number
  /** 是否跳过「任意窗口已打满」的账户 */
  skipExhaustedWindows: boolean
  /** 上游并发撞线后的短冷却时长（秒） */
  concurrencyCooldownSec: number
  /** 所有候选渠道并发满载时的排队预算（毫秒）；0 = 不排队 */
  concurrencyQueueTimeoutMs: number
  /** 一次请求最多尝试几个候选渠道；0 = 全部 */
  maxChannelAttempts: number
  /** 同一（渠道, 账户）原地重试次数 */
  attemptsPerCandidate: number
  /** 全部候选失败后整轮重来的次数 */
  maxFailoverPasses: number
  /** 故障转移总时间预算（毫秒）；0 = 不做整轮重试 */
  failoverBudgetMs: number
  /** 单请求总上游尝试上限 */
  maxTotalAttempts: number
  /** 单个渠道内最多尝试几个账户；0 = 该渠道全部可用账户 */
  maxAccountAttempts: number
  /** 按近期请求结果动态重排候选渠道（默认关闭） */
  adaptiveRouting: boolean
  /** 自适应评分窗口（秒） */
  adaptiveWindowSec: number
  /** 参与排序所需的最小样本数 */
  adaptiveMinSamples: number
}

/** 缓存里可能是旧版本写入的形状，逐项校验后再用，避免把 undefined 带进热路径 */
function isRoutingSettings(value: unknown): value is RoutingSettings {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.skipExhaustedWindows !== 'boolean') return false
  // 自适应相关字段是新加的：旧缓存里没有这些键时整体判为不合法，回落到 re-read
  if (typeof v.adaptiveRouting !== 'boolean') return false
  const numericKeys = [
    'accountFailureCooldownSec',
    'concurrencyCooldownSec',
    'concurrencyQueueTimeoutMs',
    'maxChannelAttempts',
    'attemptsPerCandidate',
    'maxFailoverPasses',
    'failoverBudgetMs',
    'maxTotalAttempts',
    'maxAccountAttempts',
    'adaptiveWindowSec',
    'adaptiveMinSamples'
  ] as const
  return numericKeys.every(
    (key) => typeof v[key] === 'number' && Number.isFinite(v[key] as number)
  )
}

/** 数据面读取（带短缓存）；Redis 不可用时直接查库 */
export async function getRoutingSettings(): Promise<RoutingSettings> {
  try {
    const cached = await redis.get(ROUTING_CACHE_KEY)
    if (cached) {
      const parsed: unknown = JSON.parse(cached)
      if (isRoutingSettings(parsed)) return parsed
    }
  } catch {
    /* Redis 挂了就退化为直读 */
  }

  // 一次 getSettings()（单条 SELECT）就够了 —— 不要在热路径上逐项查库
  const { settings } = await getSettings()
  const value: RoutingSettings = {
    accountFailureCooldownSec: settings.accountFailureCooldownSec,
    skipExhaustedWindows: settings.skipExhaustedWindows,
    concurrencyCooldownSec: settings.concurrencyCooldownSec,
    concurrencyQueueTimeoutMs: settings.concurrencyQueueTimeoutMs,
    maxChannelAttempts: settings.maxChannelAttempts,
    attemptsPerCandidate: settings.attemptsPerCandidate,
    maxFailoverPasses: settings.maxFailoverPasses,
    failoverBudgetMs: settings.failoverBudgetMs,
    maxTotalAttempts: settings.maxTotalAttempts,
    maxAccountAttempts: settings.maxAccountAttempts,
    adaptiveRouting: settings.adaptiveRouting,
    adaptiveWindowSec: settings.adaptiveWindowSec,
    adaptiveMinSamples: settings.adaptiveMinSamples
  }
  try {
    await redis.set(ROUTING_CACHE_KEY, JSON.stringify(value), 'EX', ROUTING_CACHE_TTL_SEC)
  } catch {
    /* 写缓存失败不影响本次结果 */
  }
  return value
}

/** 设置变更后立刻失效（否则最长 5 秒内仍是旧策略） */
export async function invalidateRoutingSettingCache(): Promise<void> {
  try {
    await redis.del(ROUTING_CACHE_KEY)
  } catch {
    /* 忽略 */
  }
}
