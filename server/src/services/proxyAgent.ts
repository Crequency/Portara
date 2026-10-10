/**
 * 通过 HTTP 代理访问上游。
 *
 * 为什么用 undici 而不是自己写 CONNECT 隧道：网关的核心是 **SSE 流式转发**，
 * 自建隧道要在流式、中断、TLS 上都得对，出错面很大。
 * undici 是 Node 自身的 HTTP 栈，`ProxyAgent` 把这些都处理好了。
 *
 * 设计：**没有代理时完全走原来的全局 fetch** —— 常见路径零变化、零风险；
 * 只有配了代理的渠道才切到 undici。
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici'

export interface ProxyTarget {
  id: string
  host: string
  port: number
  username: string
  password: string
}

/** 组装代理 URL（含可选的 basic 认证） */
export function proxyUrlOf(p: {
  host: string
  port: number
  username?: string
  password?: string
}): string {
  const auth = p.username
    ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password ?? '')}@`
    : ''
  return `http://${auth}${p.host}:${p.port}`
}

/**
 * 按代理 URL 缓存 Agent。
 * 每次请求新建 Agent 会不断新建连接池，最终打爆 fd —— 必须复用。
 */
const agents = new Map<string, ProxyAgent>()

function agentFor(target: ProxyTarget): ProxyAgent {
  const url = proxyUrlOf(target)
  let agent = agents.get(url)
  if (!agent) {
    agent = new ProxyAgent({ uri: url })
    agents.set(url, agent)
  }
  return agent
}

/** 关闭全部代理 Agent（进程退出时调用） */
export async function closeProxyAgents(): Promise<void> {
  const all = [...agents.values()]
  agents.clear()
  await Promise.allSettled(all.map((a) => a.close()))
}

/**
 * 统一的「取上游」入口。
 *
 * `proxy` 为空 → 全局 fetch（与改造前完全一致）；
 * 有代理 → undici fetch + ProxyAgent（dispatcher）。
 */
export async function upstreamFetch(
  url: string,
  init: RequestInit,
  proxy?: ProxyTarget | null
): Promise<Response> {
  if (!proxy) return fetch(url, init)
  // undici 的 Response 与全局 Response 在使用面上兼容（status/headers/body/text/json）
  return (await undiciFetch(url, {
    ...init,
    dispatcher: agentFor(proxy)
  } as Parameters<typeof undiciFetch>[1])) as unknown as Response
}
