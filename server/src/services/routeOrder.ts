/**
 * 别名目标的尝试顺序 —— 纯逻辑，不碰数据库/Redis。
 *
 * 单独成模块的理由与 `routing.ts` 相同：这段逻辑一旦有 bug，表现是
 * 「同一会话每次换渠道、缓存全灭」，在生产上极难复现；只有能脱离
 * 数据库直接单测，才谈得上把它钉住。
 *
 * 规则：
 *   ① 只考虑 active 目标
 *   ② 第一梯队 = priority 最小的一组；其余按 (priority, id) 排在后面当备用
 *   ③ 无会话键：与旧行为一致 —— 组内按权重轮转选一个放首位
 *   ④ 有会话键：亲和命中则提到首位；否则组内按会话哈希做加权 rendezvous
 */
import { rankBySession, type AffinityPin } from './affinityPure.js'
import { pickRoute, type RouteTarget } from './routing.js'

/** 排序只需要这些字段；避免把整行 DB 记录的形状绑死在这里 */
export interface OrderableRoute {
  id: string
  channel_id: string
  priority: number
  weight: number
  status: string
}

export interface OrderOptions {
  sessionHash?: string
  affinity?: AffinityPin | null
}

export function orderRoutes<T extends OrderableRoute>(
  routes: T[],
  rotation: number,
  opts: OrderOptions = {}
): T[] {
  const active = routes.filter((r) => r.status === 'active')
  if (active.length === 0) return []

  const minPriority = Math.min(...active.map((r) => r.priority))
  const firstTier = active
    .filter((r) => r.priority === minPriority)
    .sort((a, b) => a.id.localeCompare(b.id))
  const rest = active
    .filter((r) => r.priority !== minPriority)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))

  const head = [...firstTier]
  const hash = opts.sessionHash ?? ''

  if (hash) {
    const pinnedId = opts.affinity?.channelId
    const pinnedIndex = pinnedId ? head.findIndex((r) => r.channel_id === pinnedId) : -1
    if (pinnedIndex > 0) {
      // 亲和在，但不在首选位 → 提到最前（其余顺序不动）
      const [pinned] = head.splice(pinnedIndex, 1)
      if (pinned) head.unshift(pinned)
    } else if (pinnedIndex < 0) {
      // 没有亲和（或亲和已失效）→ 会话哈希决定顺序，保持确定性
      const ranked = rankBySession(
        hash,
        head.map((r) => ({ id: r.id, weight: r.weight, row: r }))
      )
      head.length = 0
      for (const item of ranked) head.push(item.row)
    }
    return [...head, ...rest]
  }

  const picked = pickRoute(firstTier as unknown as RouteTarget[], rotation)
  if (picked) {
    const idx = head.findIndex((r) => r.id === picked.id)
    if (idx > 0) {
      const [first] = head.splice(idx, 1)
      if (first) head.unshift(first)
    }
  }
  return [...head, ...rest]
}
