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
  /** 渠道默认协议：openai | anthropic | mixed */
  protocol?: string
  /** 逐模型覆盖：协议与 Base URL */
  model_overrides?: Record<string, { protocol?: string; baseUrl?: string }>
  /** 选用的 HTTP 代理；null/缺省 = 直连 */
  proxy_id?: string | null
}

export type EffectiveProtocol = 'openai' | 'anthropic'

/**
 * 解析某个模型实际使用的协议。
 *
 * 优先级：逐模型覆盖 > 渠道默认协议。
 * 渠道协议为 'mixed' 时，未覆盖的模型按 openai 处理（明确且可预期）。
 */
export function resolveProtocol(
  channel: { protocol?: string; model_overrides?: Record<string, { protocol?: string }> },
  upstreamModel: string
): EffectiveProtocol {
  const override = channel.model_overrides?.[upstreamModel]?.protocol
  if (override === 'anthropic') return 'anthropic'
  if (override === 'openai') return 'openai'
  if (channel.protocol === 'anthropic') return 'anthropic'
  return 'openai'
}

/** 解析某个模型实际请求的 Base URL（逐模型覆盖优先） */
export function resolveBaseUrl(
  channel: { base_url?: string; baseUrl?: string; model_overrides?: Record<string, { baseUrl?: string }> },
  upstreamModel: string
): string {
  const override = channel.model_overrides?.[upstreamModel]?.baseUrl
  if (typeof override === 'string' && override.trim().length > 0) return override.trim()
  return channel.base_url ?? channel.baseUrl ?? ''
}

export function normalizeWeight(w: number): number {
  return Number.isFinite(w) && w >= 1 ? Math.floor(w) : 1
}

/**
 * 加权轮转：在**同一 priority 层级**的一组候选里按 weight 取一个。
 *
 * 渠道选路、模型映射选路、账户选路共用一个实现 —— 三处各写一遍必然漂移，
 * 而"轮转是否公平"恰恰是很难靠读代码看出问题的那类逻辑。
 *
 * `items` 必须已按稳定的次键排好序（调用方负责），这样同一 rotation 下结果确定。
 */
export function pickWeighted<T>(
  items: T[],
  weightOf: (item: T) => number,
  rotation: number
): T | null {
  if (items.length === 0) return null
  const total = items.reduce((sum, it) => sum + normalizeWeight(weightOf(it)), 0)
  let point = ((Math.trunc(rotation) % total) + total) % total
  for (const it of items) {
    point -= normalizeWeight(weightOf(it))
    if (point < 0) return it
  }
  return items[items.length - 1] ?? null
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

  return pickWeighted(group, (c) => c.weight, rotation)
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

  return pickWeighted(group, (t) => t.weight, rotation)
}
