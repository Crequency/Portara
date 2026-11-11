/**
 * 路由信息（对外展示用的「这次请求落到哪」）。
 *
 * 用途：客户端（例如 DSH 的插件）想知道某个会话当前被负载均衡路由到了
 * 哪个渠道 / 哪个上游账户、有没有在重试过程中切换过。这些信息本来就在
 * `lb_events` 与转发上下文里，这里把它整理成**可脱敏、可序列化**的形状。
 *
 * 两条纪律：
 *   ① **默认脱敏**：渠道名与账户名暴露的是上游拓扑，只有显式开启才回；
 *   ② **纯函数优先**：组装与脱敏不碰 I/O，便于单测钉住「哪一档回什么」。
 */

/** 脱敏档位 */
export type RoutingDetail = 'off' | 'alias' | 'channel'

/** 单次路由结果（响应头用，短小、可放进 header） */
export interface RouteHeaderInfo {
  /** 网关受理的模型别名 */
  alias: string
  /** 实际使用的上游模型 */
  upstreamModel: string
  /** 命中的渠道名（档位不足时为空） */
  channel: string
  /** 命中的账户名（档位不足时为空） */
  account: string
  /** 第几次尝试才成功（1 = 首击成功） */
  attempts: number
  /** 最近一次切换原因；未切换时为空 */
  switchReason: string
}

/**
 * 按档位生成响应头。
 *
 * header 值必须是「可见 ASCII + 不含逗号」的简单串 —— 很多客户端会原样打印，
 * 所以这里统一用 `/` 分段、用 `-` 代替空格，避免有人被编码问题卡住。
 */
export function routeHeadersOf(
  info: RouteHeaderInfo,
  detail: RoutingDetail
): Record<string, string> {
  const safe = (v: string): string =>
    v.replace(/[^\x20-\x7e]/g, '').replace(/[\s]+/g, '-').replace(/[",;]/g, '')

  const parts: string[] = [safe(info.alias)]
  if (detail === 'channel') {
    if (info.channel) parts.push(safe(info.channel))
    if (info.account) parts.push(safe(info.account))
    parts.push(safe(info.upstreamModel))
  }
  const headers: Record<string, string> = {
    'x-portara-route': parts.filter(Boolean).join('/'),
    'x-portara-route-attempts': String(Math.max(1, info.attempts))
  }
  if (detail === 'off') {
    // 关闭时只告诉调用方「有没有发生过切换」，不告诉它切到哪
    headers['x-portara-route-switch'] = info.switchReason ? 'yes' : 'no'
  } else if (info.switchReason) {
    headers['x-portara-route-switch'] = safe(info.switchReason)
  }
  return headers
}

/** 历史中的一次尝试（/v1/route-info 用） */
export interface RouteAttempt {
  attempt: number
  channel: string | null
  account: string | null
  outcome: string
  statusCode: number | null
  reason: string
  at: string
}

/** /v1/route-info 的响应体 */
export interface RouteInfoResponse {
  object: 'route.info'
  sessionKey: string
  updatedAt: string | null
  route: {
    alias: string | null
    channel: string | null
    account: string | null
    upstreamModel: string | null
  }
  history: RouteAttempt[]
}

/**
 * 按档位裁剪历史与路由主体。
 *
 * `off` 只保留"发生了切换"这一事实（channel/account 全部置空），
 * `alias` 保留别名与结果，`channel` 才给渠道与账户。
 */
export function redactRouteInfo(
  full: RouteInfoResponse,
  detail: RoutingDetail
): RouteInfoResponse {
  if (detail === 'channel') return full
  return {
    ...full,
    route: {
      ...full.route,
      channel: null,
      account: null
    },
    history: full.history.map((h) => ({
      ...h,
      channel: null,
      account: null,
      // off 档连原因也不给，只给"有没有失败/切换"
      reason: detail === 'off' ? (h.outcome === 'failover_success' ? 'switched' : 'ok') : h.reason
    }))
  }
}
