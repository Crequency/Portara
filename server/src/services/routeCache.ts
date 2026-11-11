/**
 * 会话当前路由的**短期缓存**（Redis）。
 *
 * 为什么需要它：`lb_events` 只在失败/切换时写（转发热路径不写库），
 * 所以"首击成功"的请求在库里没有任何痕迹 —— 而客户端插件最想知道的恰恰是
 * 「这个会话现在落在哪」。于是成功路由单独放 Redis，带 TTL 自然过期。
 *
 * 键：`portara:route:<sessionHash>`，值为 JSON（渠道/账户/上游模型/时间）。
 * TTL 15 分钟：比一次人工排查窗口长，又不会让过期路由一直被读到。
 */
import { redis } from '../redis.js'

const KEY_PREFIX = 'portara:route:'
const TTL_SEC = 900

export interface CachedRoute {
  alias: string
  channel: string
  account: string
  upstreamModel: string
  /** 第几次尝试成功（1 = 首击） */
  attempts: number
  /** 切换原因；未切换为空 */
  switchReason: string
  at: string
}

function keyOf(sessionHash: string): string {
  return KEY_PREFIX + sessionHash
}

/** 写/覆盖一个会话的当前路由；失败只 warn（不能让观测数据影响转发） */
export async function setSessionRoute(
  sessionHash: string,
  route: Omit<CachedRoute, 'at'>
): Promise<void> {
  if (!sessionHash) return
  try {
    await redis.set(
      keyOf(sessionHash),
      JSON.stringify({ ...route, at: new Date().toISOString() }),
      'EX',
      TTL_SEC
    )
  } catch {
    /* Redis 不可用：只是查不到"当前路由"，不影响请求本身 */
  }
}

/** 读会话当前路由；没有/过期/解析失败都返回 null */
export async function getSessionRoute(sessionHash: string): Promise<CachedRoute | null> {
  if (!sessionHash) return null
  try {
    const raw = await redis.get(keyOf(sessionHash))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as CachedRoute
  } catch {
    return null
  }
}
