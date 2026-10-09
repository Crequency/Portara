/**
 * 选路纯逻辑 —— 不依赖数据库，便于单测。
 *
 * 规则（按顺序）：
 *   1. 只考虑 status = active
 *   2. 模型过滤：models 为空 = 通吃；否则必须包含请求模型
 *   3. priority 升序取最小的一组
 *   4. 组内按 weight 加权轮转（rotation 由 Redis 自增提供）
 */

export interface ChannelCandidate {
  id: string
  name: string
  base_url: string
  api_key_cipher: string
  models: string[]
  priority: number
  weight: number
  timeout_ms: number
  status: string
  /** 厂商兼容档位；缺省按 generic 处理 */
  vendor?: string
  /** 渠道自定义固定请求头 */
  extra_headers?: Record<string, string>
}

export function normalizeWeight(w: number): number {
  return Number.isFinite(w) && w >= 1 ? Math.floor(w) : 1
}

export function pickChannel(
  channels: ChannelCandidate[],
  model: string,
  rotation = 0
): ChannelCandidate | null {
  const active = channels.filter((c) => c.status === 'active')
  if (active.length === 0) return null

  const matching = model
    ? active.filter((c) => c.models.length === 0 || c.models.includes(model))
    : active
  if (matching.length === 0) return null

  const minPriority = Math.min(...matching.map((c) => c.priority))
  // 排序保证同一 rotation 下结果确定（不依赖 DB 返回顺序）
  const group = matching
    .filter((c) => c.priority === minPriority)
    .sort((a, b) => a.name.localeCompare(b.name))

  const totalWeight = group.reduce((sum, c) => sum + normalizeWeight(c.weight), 0)
  let point = ((Math.trunc(rotation) % totalWeight) + totalWeight) % totalWeight
  for (const ch of group) {
    point -= normalizeWeight(ch.weight)
    if (point < 0) return ch
  }
  return group[group.length - 1] ?? null
}

// ---------------------------------------------------------------- 模型映射

export interface RouteTarget {
  id: string
  channel_id: string
  upstream_model: string
  priority: number
  weight: number
  status: string
}

/**
 * 在一个 alias 的多个目标间做选择。
 * 与 pickChannel 同一套规则：只取 active、priority 最小的一组、组内按权重轮转。
 * 排序键用 id 而非 name（映射目标没有 name），保证同一 rotation 下结果确定。
 */
export function pickRoute(targets: RouteTarget[], rotation = 0): RouteTarget | null {
  const active = targets.filter((t) => t.status === 'active')
  if (active.length === 0) return null

  const minPriority = Math.min(...active.map((t) => t.priority))
  const group = active
    .filter((t) => t.priority === minPriority)
    .sort((a, b) => a.id.localeCompare(b.id))

  const totalWeight = group.reduce((sum, t) => sum + normalizeWeight(t.weight), 0)
  let point = ((Math.trunc(rotation) % totalWeight) + totalWeight) % totalWeight
  for (const t of group) {
    point -= normalizeWeight(t.weight)
    if (point < 0) return t
  }
  return group[group.length - 1] ?? null
}
