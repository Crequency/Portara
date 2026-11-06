/**
 * 会话亲和的存储层（Redis）。
 *
 * 判别与排序是纯逻辑，放在 `affinityPure.ts`；这里只管"记住上次落在哪"。
 */
import { redis } from '../redis.js'
import { env } from '../env.js'
import {
  isAffinityExpired,
  pinAgeMs,
  type AffinityPin
} from './affinityPure.js'

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

    const pin: AffinityPin = {
      channelId: parsed.channelId,
      accountId: typeof parsed.accountId === 'string' ? parsed.accountId : '',
      ...(typeof parsed.pinnedAt === 'number' && Number.isFinite(parsed.pinnedAt)
        ? { pinnedAt: parsed.pinnedAt }
        : {})
    }

    /*
     * 时效上限：超过 PORTARA_AFFINITY_MAX_AGE_SEC 的 pin 一律视为失效并清掉。
     *
     * 这是「长会话无限粘住同一个账户」的第二道闸 —— 仅靠健康度不够：
     * 配额窗口可能早就滚动恢复，而 pin 仍记得几小时前的选择。
     * 旧数据没有 pinnedAt 时 pinAgeMs 返回 0（按刚创建处理），
     * 下一个成功请求会把时间戳补写回去，不会让上限永久失效。
     */
    const ageMs = pinAgeMs(pin, Date.now())
    if (isAffinityExpired(ageMs, env.affinityMaxAgeSeconds)) {
      console.warn(
        `[portara] 会话亲和已过期丢弃（alias=${alias}, account=${pin.accountId || '-'}, reason=expired）`
      )
      await clearAffinity(alias, sessionHash)
      return null
    }

    return pin
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
    // 时间戳只在这里缺失时补 —— 写入门控（是否该写）由 nextAffinityPin 决定，
    // 成功命中不会调用本函数，因此不会出现「每次成功都刷新」。
    const stored: AffinityPin = {
      channelId: pin.channelId,
      accountId: pin.accountId,
      pinnedAt:
        typeof pin.pinnedAt === 'number' && Number.isFinite(pin.pinnedAt)
          ? pin.pinnedAt
          : Date.now()
    }
    await redis.set(affinityKey(alias, sessionHash), JSON.stringify(stored), 'EX', ttl)
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
