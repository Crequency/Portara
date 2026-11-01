import { one, query } from '../db.js'
import type { ChannelRow, ModelRouteRow } from '../types.js'
import {
  pickChannel,
  pickRoute,
  resolveBaseUrl,
  resolveProtocol,
  type ChannelCandidate,
  type EffectiveProtocol,
  type RouteTarget
} from './routing.js'

export { pickChannel, pickRoute, normalizeWeight } from './routing.js'
export type { ChannelCandidate, RouteTarget } from './routing.js'

/**
 * 选路结果。
 * `upstreamModel` 是**真正发往上游**的模型 id —— 经过映射时与调用方请求的
 * 模型 id 不同，这个区别必须一路带到转发与日志里。
 */
import { getProxyTarget } from './proxies.js'
import type { ProxyTarget } from './proxyAgent.js'

export interface ResolvedTarget {
  channel: ChannelCandidate
  upstreamModel: string
  viaMapping: boolean
  /** 实际使用的协议（由渠道默认与逐模型覆盖解析得出） */
  protocol: EffectiveProtocol
  /** 实际请求的 Base URL（逐模型覆盖优先） */
  baseUrl: string
  /**
   * 上游访问要走哪个代理；null = 直连。
   *
   * 放在解析结果里而不是各调用点自己查 —— 否则「某条路径忘了带代理」
   * 这种漏洞迟早会出现（relay.ts 那次教训）。
   */
  proxy: ProxyTarget | null
}

interface RouteJoin extends ModelRouteRow {
  c_name: string
  c_status: string
  c_base_url: string
  c_api_key_cipher: string
  c_vendor: string
  c_extra_headers: Record<string, string> | null
  c_timeout_ms: number
  c_protocol: string
  c_model_overrides: Record<string, { protocol?: string; baseUrl?: string }> | null
  c_proxy_id: string | null
  c_hide_unmapped_models: boolean
}

/** 别名映射查询：只取「映射启用 且 渠道启用」的目标 */
const ROUTE_SQL = `
  select r.*,
         c.name            as c_name,
         c.status          as c_status,
         c.base_url        as c_base_url,
         c.api_key_cipher  as c_api_key_cipher,
         c.vendor          as c_vendor,
         c.extra_headers   as c_extra_headers,
         c.timeout_ms      as c_timeout_ms,
         c.protocol        as c_protocol,
         c.model_overrides as c_model_overrides,
         c.proxy_id        as c_proxy_id,
         c.hide_unmapped_models as c_hide_unmapped_models
    from model_routes r
    join channels c on c.id = r.channel_id
   where r.alias = $1
     and r.status = 'active'
     and c.status = 'active'
`

function toCandidate(row: RouteJoin): ChannelCandidate {
  return {
    id: row.channel_id,
    name: row.c_name,
    base_url: row.c_base_url,
    api_key_cipher: row.c_api_key_cipher,
    models: [],
    priority: row.priority,
    weight: row.weight,
    timeout_ms: row.c_timeout_ms,
    status: row.c_status,
    vendor: row.c_vendor,
    extra_headers: row.c_extra_headers ?? {},
    protocol: row.c_protocol,
    model_overrides: row.c_model_overrides ?? {},
    proxy_id: row.c_proxy_id,
    hide_unmapped_models: row.c_hide_unmapped_models === true
  }
}

/** 由渠道 + 上游模型解析出协议与地址 */
async function targetOf(
  channel: ChannelCandidate,
  upstreamModel: string,
  viaMapping: boolean
): Promise<ResolvedTarget> {
  return {
    channel,
    upstreamModel,
    viaMapping,
    protocol: resolveProtocol(channel, upstreamModel),
    baseUrl: resolveBaseUrl(channel, upstreamModel),
    proxy: await getProxyTarget(channel.proxy_id)
  }
}

/**
 * 解析调用方请求的模型 id：
 *   ① 先查别名映射 —— 命中则在其多个目标间按优先级/权重选一个；
 *   ② 未命中则回退到旧行为：按渠道声明的 models 直通。
 *
 * 保留回退是刻意的：不配映射的渠道（如 DeepSeek）应当照旧可用，
 * 映射是增强而不是前置条件。
 */
export async function resolveTarget(
  model: string,
  rotation: () => Promise<number>
): Promise<ResolvedTarget | null> {
  // 只取一次轮转计数，两条路径共用，避免同一请求消耗两个计数
  const round = await rotation()

  if (model) {
    const routes = await query<RouteJoin>(ROUTE_SQL, [model])
    if (routes.length > 0) {
      const picked = pickRoute(routes as unknown as RouteTarget[], round)
      if (picked) {
        const row = routes.find((r) => r.id === picked.id)!
        return await targetOf(toCandidate(row), row.upstream_model, true)
      }
    }
  }

  const channels = await query<ChannelRow>(
    `select * from channels where status = 'active' order by priority asc, name asc`
  )
  const picked = pickChannel(channels as unknown as ChannelCandidate[], model, round)
  if (!picked) return null
  return await targetOf(picked, model, false)
}

/**
 * Key 绑定了渠道时使用：只在**该渠道内**找映射，不做跨渠道回退。
 * 绑定的语义是「只走这个渠道」，不能被映射绕过。
 */
export async function resolveBoundTarget(
  channel: ChannelRow,
  model: string
): Promise<ResolvedTarget> {
  if (model) {
    const route = await one<ModelRouteRow>(
      `select * from model_routes
        where alias = $1 and channel_id = $2 and status = 'active'`,
      [model, channel.id]
    )
    if (route) {
      return targetOf(channel as unknown as ChannelCandidate, route.upstream_model, true)
    }
  }
  return await targetOf(channel as unknown as ChannelCandidate, model, false)
}

export async function getChannelById(id: string): Promise<ChannelRow | null> {
  return one<ChannelRow>('select * from channels where id = $1', [id])
}
