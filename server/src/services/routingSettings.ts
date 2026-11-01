/**
 * 数据面（转发热路径）用的路由设置读取。
 *
 * 为什么单独成模块：`settings.ts` 是**纯配置模块**，被 `timezone.test.ts`
 * 这样的单测直接 import。一旦它顶部 import 了 `redis.js`，
 * ioredis 会建连接并自动重连，测试进程就退不出去（本仓库踩过两次）。
 * 需要 Redis 的东西一律放这里。
 */
import { redis } from '../redis.js'
import { getSetting } from './settings.js'

/**
 * 5 秒缓存的理由：
 *   - 管理面「不加进程内缓存」是为了多实例下"改了立刻生效"，这里用**共享的 Redis**
 *   - 数据面每个请求都要读这两项，每请求一次 SELECT 是实打实的开销
 *   - 5 秒只是兜底（绕过 API 直接改库的情况），正常路径靠写入时主动失效
 */
const ROUTING_CACHE_KEY = 'portara:settings:routing'
const ROUTING_CACHE_TTL_SEC = 5

export interface RoutingSettings {
  /** 失败后的冷却时长（秒） */
  accountFailureCooldownSec: number
  /** 是否跳过「任意窗口已打满」的账户 */
  skipExhaustedWindows: boolean
}

/** 数据面读取（带短缓存）；Redis 不可用时直接查库 */
export async function getRoutingSettings(): Promise<RoutingSettings> {
  try {
    const cached = await redis.get(ROUTING_CACHE_KEY)
    if (cached) {
      const parsed = JSON.parse(cached) as RoutingSettings
      if (
        Number.isFinite(parsed.accountFailureCooldownSec) &&
        typeof parsed.skipExhaustedWindows === 'boolean'
      ) {
        return parsed
      }
    }
  } catch {
    /* Redis 挂了就退化为直读 */
  }

  const value: RoutingSettings = {
    accountFailureCooldownSec: await getSetting('accountFailureCooldownSec'),
    skipExhaustedWindows: await getSetting('skipExhaustedWindows')
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
