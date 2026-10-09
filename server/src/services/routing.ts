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
