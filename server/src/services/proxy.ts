/**
 * 转发相关纯工具：URL 拼接、usage 提取、SSE 旁路扫描。
 *
 * 关键纪律：**转发路径上不反序列化整个流**。扫描器只对疑似含 usage 的
 * data 行做 JSON.parse，原字节由 tee 的另一分支原样下传。
 */

export interface Usage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export function buildUpstreamUrl(baseUrl: string, restPath: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const rest = restPath.startsWith('/') ? restPath : `/${restPath}`
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
 * 组装转发到上游的请求头。
 * 只白名单透传必要字段，避免把客户端 IP/UA/Cookie 泄漏给上游。
 */
export function buildUpstreamHeaders(
  upstreamApiKey: string,
  contentType: string
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': contentType || 'application/json',
    accept: 'application/json, text/event-stream',
    'user-agent': 'Portara/0.1 (+https://github.com/Crequency/Portara)'
  }
  if (upstreamApiKey) {
    headers.authorization = `Bearer ${upstreamApiKey}`
  }
  return headers
}
