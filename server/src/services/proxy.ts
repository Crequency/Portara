/**
 * 转发相关纯工具：URL 拼接、usage 提取、SSE 旁路扫描、上游请求头组装。
 *
 * 关键纪律：**转发路径上不反序列化整个流**。扫描器只对疑似含 usage 的
 * data 行做 JSON.parse，原字节由 tee 的另一分支原样下传。
 */

import { resolveVendorSession, type InjectedSession } from './vendorRules.js'

export interface Usage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/**
 * 拼接上游地址。
 *
 * 容错：若 baseUrl 已经以该路径结尾，则不再重复拼接。
 * 起因是真实误配 —— 用户在「逐模型 Base URL」里填了完整端点
 * （https://api.commandcode.ai/provider/v1/messages），再拼一次 /messages
 * 就变成 /messages/messages，而上游只会回一句令人困惑的报错。
 *
 * 语义上 Base URL 仍是**前缀**（推荐填到 /v1），这里只是不让误配变成天书。
 */
export function buildUpstreamUrl(baseUrl: string, restPath: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const rest = restPath.startsWith('/') ? restPath : `/${restPath}`
  if (base.endsWith(rest)) return base
  return `${base}${rest}`
}

/** 从 OpenAI 风格的响应体中提取 usage */
export function extractUsage(body: unknown): Usage | null {
  if (!body || typeof body !== 'object') return null
  const u = (body as Record<string, unknown>).usage
  if (!u || typeof u !== 'object') return null
  const rec = u as Record<string, unknown>
  const prompt = toInt(rec.prompt_tokens)
  const completion = toInt(rec.completion_tokens)
  const total = toInt(rec.total_tokens) || prompt + completion
  if (prompt === 0 && completion === 0 && total === 0) return null
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total }
}

function toInt(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

export function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 流式请求时自动补 stream_options.include_usage —— 否则多数上游不在流里
 * 返回 usage，计量只能靠估算。仅当客户端显式设过 stream_options 时不干预。
 */
export function withStreamUsage(payload: Record<string, unknown>): {
  payload: Record<string, unknown>
  injected: boolean
} {
  if (payload.stream !== true) return { payload, injected: false }
  if (payload.stream_options !== undefined) return { payload, injected: false }
  return {
    payload: { ...payload, stream_options: { include_usage: true } },
    injected: true
  }
}

/**
 * SSE 旁路扫描器：喂给它原始字节，它只做两件事 ——
 *   ① 找出 usage（仅在行内含 "usage" 时才 JSON.parse）
 *   ② 统计 data 负载字节数，供「上游未返回 usage」时的粗估
 */
export class SseUsageScanner {
  private buf = ''
  private readonly decoder = new TextDecoder()
  usage: Usage | null = null
  dataBytes = 0
  sawDone = false

  push(chunk: Uint8Array): void {
    this.buf += this.decoder.decode(chunk, { stream: true })
    let idx: number
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 1)
      this.handleLine(line)
    }
    // 防御：单行异常长时避免无限累积
    if (this.buf.length > 1_000_000) this.buf = ''
  }

  private handleLine(rawLine: string): void {
    const line = rawLine.trim()
    if (line.length === 0 || !line.startsWith('data:')) return

    const payload = line.slice(5).trim()
    if (payload === '[DONE]') {
      this.sawDone = true
      return
    }
    this.dataBytes += payload.length

    // 只有疑似含 usage 的行才解析，避免为每个 chunk 付 JSON.parse 的代价
    if (!payload.includes('"usage"')) return
    const obj = parseJsonSafe(payload)
    const u = extractUsage(obj)
    if (u) this.usage = u
  }

  /** 结束扫描，冲刷缓冲区里最后一行（无换行结尾的情况） */
  finish(): void {
    if (this.buf.length > 0) {
      const rest = this.buf
      this.buf = ''
      this.handleLine(rest)
    }
  }

  /**
   * 粗估补位：上游确实不给 usage 时，用 data 负载字节数按 4 字节/token 估。
   * 结果一定带 estimated=true 标记 —— 宁可标注，不可假装精确。
   */
  estimateFromBytes(): Usage {
    const completion = Math.max(1, Math.round(this.dataBytes / 4))
    return { promptTokens: 0, completionTokens: completion, totalTokens: completion }
  }
}

/**
 * 这些头不允许用户自定义：要么由 Portara 决定（鉴权/内容类型），
 * 要么属于传输层（长度/连接），改它们只会把请求弄坏或造成请求走私风险。
 */
export const RESERVED_HEADERS = new Set([
  'authorization',
  // Anthropic 协议用 x-api-key 传凭据，同样必须由「上游 API Key」字段提供
  'x-api-key',
  'content-type',
  'content-length',
  'host',
  'connection',
  'transfer-encoding',
  'expect',
  'upgrade'
])

const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/

export interface HeaderValidation {
  headers: Record<string, string>
  errors: string[]
}

/** 校验并归一化用户填写的固定请求头（非法项被剔除并给出原因） */
export function sanitizeExtraHeaders(input: unknown): HeaderValidation {
  const headers: Record<string, string> = {}
  const errors: string[] = []

  if (input === null || input === undefined) return { headers, errors }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { headers, errors: ['请求头必须是「名称: 值」的键值对'] }
  }

  const seen = new Set<string>()
  for (const [rawName, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const name = String(rawName).trim()
    const value = String(rawValue ?? '').trim()

    if (!HEADER_NAME_RE.test(name)) {
      errors.push(`请求头名称非法：${name || '(空)'}`)
      continue
    }
    const lower = name.toLowerCase()
    if (RESERVED_HEADERS.has(lower)) {
      errors.push(`请求头 ${name} 由 Portara 管理，不允许自定义`)
      continue
    }
    if (/[\r\n]/.test(value)) {
      errors.push(`请求头 ${name} 的值不能包含换行`)
      continue
    }
    if (value.length > 1024) {
      errors.push(`请求头 ${name} 的值过长（上限 1024 字符）`)
      continue
    }
    if (seen.has(lower)) {
      errors.push(`请求头 ${name} 重复`)
      continue
    }

    seen.add(lower)
    headers[name] = value
  }

  return { headers, errors }
}

/** 首批支持的厂商兼容档位 */
export const VENDOR_PRESETS = ['generic', 'opencode-go'] as const
export type VendorPreset = (typeof VENDOR_PRESETS)[number]

export function isVendorPreset(v: string): v is VendorPreset {
  return (VENDOR_PRESETS as readonly string[]).includes(v)
}

/**
 * 厂商兼容所需的请求头。
 *
 * OpenCode 要求请求头带 `x-opencode-session`（值任意字符串）。
 * 若用户已在固定请求头里给了该头，则尊重用户值、不覆盖。
 *
 * 注意：目前每次请求生成一个随机 session 值 —— 这只是占位实现，
 * 真正的「自动请求头识别」规则待用户给出后再补（见 DECISIONS D-016）。
 */

export interface UpstreamHeaderOptions {
  extraHeaders?: Record<string, string>
  vendor?: string
  /** 上游协议决定用哪种认证头（见下） */
  protocol?: 'openai' | 'anthropic'
  /** 渠道 id：厂商会话头的稳定兜底值由它派生 */
  channelId?: string
  /** 已解析的请求体：厂商会话头优先从这里取 */
  payload?: Record<string, unknown> | null
  /** 请求体的 content-encoding；非 identity 时无法安全解析 payload */
  contentEncoding?: string
}

export interface UpstreamHeaders {
  headers: Record<string, string>
  /** 本次实际生效的厂商会话头（供回显与验收）；该厂商无规则时为 null */
  session: InjectedSession | null
}

/** Anthropic 要求显式声明 API 版本 */
export const ANTHROPIC_VERSION = '2023-06-01'

/**
 * 组装转发到上游的请求头。
 *
 * 优先级（后者覆盖前者）：基础头 → 厂商预设 → 用户固定头 → 上游密钥。
 * 只白名单透传必要字段，避免把客户端 IP/UA/Cookie 泄漏给上游。
 */
export function buildUpstreamHeaders(
  upstreamApiKey: string,
  contentType: string,
  options: UpstreamHeaderOptions = {}
): UpstreamHeaders {
  const headers: Record<string, string> = {
    'content-type': contentType || 'application/json',
    accept: 'application/json, text/event-stream',
    'user-agent': 'Portara/0.1 (+https://github.com/Crequency/Portara)'
  }

  const extra = options.extraHeaders ?? {}
  // 厂商会话头（如 opencode-go 的 x-opencode-session）——
  // 请求体派生 > 渠道固定头 > 稳定兜底，详见 services/vendorRules.ts
  const vendor = resolveVendorSession({
    vendor: options.vendor ?? 'generic',
    channelId: options.channelId,
    extraHeaders: extra,
    payload: options.payload,
    contentEncoding: options.contentEncoding
  })
  Object.assign(headers, vendor.headers)
  Object.assign(headers, extra)
  // 请求体派生的是「本会话」的 id，必须压过渠道里配的静态值 ——
  // 否则合并顺序（extra 在后）会把它盖掉，优先级形同虚设
  if (vendor.session?.source === 'body') {
    headers[vendor.session.header] = vendor.session.value
  }

  // 上游密钥永远压过一切，包括用户误填的同名头。
  //
  // 认证方式按协议不同：
  //   OpenAI    → Authorization: Bearer <key>
  //   Anthropic → x-api-key: <key>（且要求 anthropic-version）
  // 用错头会得到一句「Authentication failed」，而上游不会告诉你头用错了。
  if (upstreamApiKey) {
    if (options.protocol === 'anthropic') {
      headers['x-api-key'] = upstreamApiKey
      // 用户可通过固定请求头覆盖版本号（anthropic-version 不在保留列表里）
      if (!('anthropic-version' in headers)) {
        headers['anthropic-version'] = ANTHROPIC_VERSION
      }
    } else {
      headers.authorization = `Bearer ${upstreamApiKey}`
    }
  }

  return { headers, session: vendor.session }
}
