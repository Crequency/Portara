/**
 * 厂商专属的请求头注入规则。
 *
 * 为什么需要：某些上游对请求头有**硬性要求**，而客户端未必能自己带上。
 * 典型是 OpenCode Zen 的 Go 端点 —— 它强制要求每会话的 `x-opencode-session`，
 * 缺失或空值一律 400 `MissingSessionID`。
 *
 * 设计要点（见 DECISIONS D-033）：
 *   ① 规则是**数据**不是分支 —— 新厂商加一条记录即可
 *   ② 会话值来自请求体，**必须消毒**（字符集 + 长度）—— 它是客户端可控的
 *   ③ 兜底值**稳定**（由渠道 id 派生），不是每次随机
 *   ④ 不看 User-Agent：`prompt_cache_key` 是 OpenAI 标准字段，且 UA 可随意伪造
 */
import { createHash } from 'node:crypto'

export interface VendorHeaderRule {
  /** 注入的头名 */
  header: string
  /** 从请求体的哪个字段取会话 id */
  fromBodyField: string
  /** 允许的字符集；不匹配视为「取不到」，走兜底 */
  allowedPattern: RegExp
  /** 长度上限，防止超长值塞进请求头 */
  maxLength: number
}

export const VENDOR_HEADER_RULES: Record<string, VendorHeaderRule> = {
  'opencode-go': {
    header: 'x-opencode-session',
    // dsh（DeepSeek Harness）在 cacheRetention: long 时把会话 id 写进这个字段
    fromBodyField: 'prompt_cache_key',
    allowedPattern: /^[A-Za-z0-9._:-]+$/,
    maxLength: 128
  }
}

export type SessionSource = 'body' | 'configured' | 'fallback'

export interface InjectedSession {
  header: string
  value: string
  /** 这个值是怎么来的 —— 排查与验收都需要 */
  source: SessionSource
}

/**
 * 稳定兜底值：由**渠道 id** 派生。
 *
 * 不用渠道密钥的哈希，理由有二：
 *   - 轮换密钥不该等于换会话（值会变，缓存亲和被打断）
 *   - 没必要把任何密钥材料带进请求头，哪怕只是哈希
 */
export function stableSession(channelId: string): string {
  const basis = channelId.trim() || 'portara'
  return `portara-${createHash('sha256').update(basis).digest('hex').slice(0, 24)}`
}

/**
 * 消毒会话值。
 *
 * 这个值**来自请求体**，任何客户端都能塞任意内容：
 *   - 带 `\r\n` 会污染请求头（undici 会抛错 → 500，等于一个廉价打崩入口）
 *   - 超长值可以撑爆请求头
 * 不合规一律视为「取不到」，退回兜底 —— 宁可用兜底，也不要放一个可疑值过去。
 */
export function sanitizeSessionValue(value: unknown, rule: VendorHeaderRule): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > rule.maxLength) return null
  if (!rule.allowedPattern.test(trimmed)) return null
  return trimmed
}

export interface VendorSessionPlan {
  /** 需要注入的头（已配的不在此列，由调用方合并 extraHeaders 时自然生效） */
  headers: Record<string, string>
  /** 本次实际生效的会话头；该厂商无规则时为 null */
  session: InjectedSession | null
}

/**
 * 决定该厂商本次请求要带什么会话头。
 *
 * 优先级：**请求体派生 > 渠道固定请求头 > 稳定兜底**
 *   - 请求体里带的是「本会话」的 id，永远优于静态值
 *   - 用户在渠道里显式配了同名头，尊重它（不覆盖）
 *   - 都没有则给一个稳定值，绝不让请求裸奔（Zen 会 400）
 */
export function resolveVendorSession(opts: {
  vendor?: string
  channelId?: string
  extraHeaders?: Record<string, string>
  /** 已解析的请求体；压缩体无法安全解析时应为 null */
  payload?: Record<string, unknown> | null
  /** 请求体的 content-encoding */
  contentEncoding?: string
}): VendorSessionPlan {
  const rule = opts.vendor ? VENDOR_HEADER_RULES[opts.vendor] : undefined
  if (!rule) return { headers: {}, session: null }

  const target = rule.header.toLowerCase()
  const configured = Object.entries(opts.extraHeaders ?? {}).find(
    ([k]) => k.toLowerCase() === target
  )?.[1]

  // ① 请求体派生
  //    压缩体拿到的不是 JSON（调用方解析会失败），这里显式跳过，避免依赖解析失败这一副作用
  const encoding = (opts.contentEncoding ?? '').trim().toLowerCase()
  const bodyReadable = encoding === '' || encoding === 'identity'
  if (bodyReadable) {
    const fromBody = sanitizeSessionValue(opts.payload?.[rule.fromBodyField], rule)
    if (fromBody) {
      return {
        headers: { [rule.header]: fromBody },
        session: { header: rule.header, value: fromBody, source: 'body' }
      }
    }
  }

  // ② 渠道固定请求头里已配 → 不注入，由合并 extraHeaders 时生效
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return {
      headers: {},
      session: { header: rule.header, value: configured.trim(), source: 'configured' }
    }
  }

  // ③ 稳定兜底
  const value = stableSession(opts.channelId ?? '')
  return {
    headers: { [rule.header]: value },
    session: { header: rule.header, value, source: 'fallback' }
  }
}
