/**
 * 模型映射的纯逻辑：JSON 导入时的引用解析与校验。
 * 与数据库解耦，便于单测。
 */

export interface ChannelRef {
  id: string
  name: string
}

export interface IncomingRoute {
  alias: string
  /** 渠道**名称**（JSON 编辑格式用名字，不用 uuid，便于人读写） */
  channel: string
  model: string
  priority: number
  weight: number
}

export interface ResolvedRoute {
  alias: string
  channelId: string
  channelName: string
  upstreamModel: string
  priority: number
  weight: number
}

export interface ResolveResult {
  resolved: ResolvedRoute[]
  /** 找不到的渠道名（去重） */
  unknown: string[]
  /** 同一 (alias, 渠道, 上游模型) 在入参里重复 */
  duplicates: string[]
  /** 可用的渠道名，供报错时提示 */
  available: string[]
}

/**
 * 把「渠道名 + 上游模型」解析为「渠道 id + 上游模型」。
 *
 * 渠道名大小写与首尾空格做宽松匹配（人写 JSON 时很容易差一个空格），
 * 但**重名渠道不允许存在**（数据库层面 name 已唯一）。
 */
export function resolveChannelRefs(
  routes: IncomingRoute[],
  channels: ChannelRef[]
): ResolveResult {
  const byName = new Map<string, ChannelRef>()
  for (const ch of channels) {
    byName.set(ch.name, ch)
    byName.set(ch.name.trim().toLowerCase(), ch)
  }

  const resolved: ResolvedRoute[] = []
  const unknown = new Set<string>()
  const duplicates = new Set<string>()
  const seen = new Set<string>()

  for (const r of routes) {
    const key = r.channel.trim().toLowerCase()
    const channel = byName.get(r.channel) ?? byName.get(key)

    if (!channel) {
      unknown.add(r.channel)
      continue
    }

    const dedupeKey = `${r.alias}\u0000${channel.id}\u0000${r.model}`
    if (seen.has(dedupeKey)) {
      duplicates.add(`${r.alias} → ${channel.name} / ${r.model}`)
      continue
    }
    seen.add(dedupeKey)

    resolved.push({
      alias: r.alias,
      channelId: channel.id,
      channelName: channel.name,
      upstreamModel: r.model,
      priority: r.priority,
      weight: r.weight
    })
  }

  return {
    resolved,
    unknown: [...unknown],
    duplicates: [...duplicates],
    available: channels.map((c) => c.name).sort((a, b) => a.localeCompare(b))
  }
}

// ---------------------------------------------------------------- JSON 结构

export interface JsonTarget {
  channel: string
  model: string
  priority?: number
  weight?: number
}

export type JsonMappingValue = JsonTarget | JsonTarget[]

export type JsonMapping = Record<string, JsonMappingValue>

/**
 * 把「alias → 目标 | 目标数组」的 JSON 结构拍平为入参列表。
 *
 * 支持两种写法：
 *   单目标（与用户给的示例一致）：{ "a/b": { "channel": "C", "model": "m" } }
 *   多目标（负载均衡）：        { "a/b": [ {...}, {...} ] }
 */
export function flattenJsonMapping(json: JsonMapping): {
  routes: IncomingRoute[]
  errors: string[]
} {
  const routes: IncomingRoute[] = []
  const errors: string[] = []

  for (const [alias, value] of Object.entries(json)) {
    const targets = Array.isArray(value) ? value : [value]

    if (targets.length === 0) {
      errors.push(`「${alias}」的目标为空`)
      continue
    }

    for (const [i, t] of targets.entries()) {
      if (!t || typeof t !== 'object') {
        errors.push(`「${alias}」第 ${i + 1} 个目标不是对象`)
        continue
      }
      if (!t.channel || typeof t.channel !== 'string') {
        errors.push(`「${alias}」第 ${i + 1} 个目标缺少 channel`)
        continue
      }
      if (!t.model || typeof t.model !== 'string') {
        errors.push(`「${alias}」第 ${i + 1} 个目标缺少 model`)
        continue
      }
      routes.push({
        alias,
        channel: t.channel,
        model: t.model,
        priority: Number.isFinite(t.priority) ? Number(t.priority) : 100,
        weight: Number.isFinite(t.weight) ? Number(t.weight) : 1
      })
    }
  }

  return { routes, errors }
}
