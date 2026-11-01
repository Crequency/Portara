/**
 * 会话亲和的存储层（Redis）。
 *
 * 判别与排序是纯逻辑，放在 `affinityPure.ts`；这里只管"记住上次落在哪"。
 */
import { redis } from '../redis.js'
import type { AffinityPin } from './affinityPure.js'

export type { AffinityPin } from './affinityPure.js'

// ---------------------------------------------------------------- 亲和表（Redis）

function affinityKey(alias: string, sessionHash: string): string {
  return `portara:affinity:${alias}:${sessionHash}`
}

export async function getAffinity(
  alias: string,
  sessionHash: string
): Promise<AffinityPin | null> {
  if (!sessionHash) return null
  try {
    const raw = await redis.get(affinityKey(alias, sessionHash))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<AffinityPin>
    if (typeof parsed.channelId !== 'string' || !parsed.channelId) return null
    return { channelId: parsed.channelId, accountId: typeof parsed.accountId === 'string' ? parsed.accountId : '' }
  } catch {
    // Redis 挂了不该让转发失败 —— 退化成"无记忆的确定性选择"
    return null
  }
}

export async function setAffinity(
  alias: string,
  sessionHash: string,
  pin: AffinityPin,
  ttlSec: number
): Promise<void> {
  if (!sessionHash) return
  try {
    const ttl = Math.max(60, Math.min(86_400, Math.floor(ttlSec) || 1800))
    await redis.set(affinityKey(alias, sessionHash), JSON.stringify(pin), 'EX', ttl)
  } catch {
    /* 记录亲和失败不影响本次请求 */
  }
}

/** 清除亲和（例如目标已失效）—— 下一次请求重新按哈希挑选 */
export async function clearAffinity(alias: string, sessionHash: string): Promise<void> {
  if (!sessionHash) return
  try {
    await redis.del(affinityKey(alias, sessionHash))
  } catch {
    /* 同上 */
  }
}
