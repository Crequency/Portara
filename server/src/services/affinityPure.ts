/**
 * 会话亲和 —— 纯逻辑部分（无 Redis / 无数据库依赖，便于单测）。
 *
 * 会话亲和（session affinity）—— 让同一个下游会话始终落在同一个
 * 「渠道 + 上游账户」上，从而复用上游的前缀缓存（DeepSeek / Kimi / OpenAI 的
 * prompt caching、Anthropic 的 ephemeral 缓存都**不跨账号**共享）。
 *
 * 三条纪律：
 *   ① **只存哈希**：会话键可能来自客户端（`prompt_cache_key`）或消息内容，
 *      落库/落 Redis 的永远是 sha256 前缀，绝不存原文。
 *   ② **没有键就不装**：拿不到会话键时退回原有的加权轮转，
 *      不能靠"猜"制造亲和 —— 猜错就是把并发堆到一个渠道上。
 *   ③ **确定性优先**：同一 (alias, 会话) 在任何实例上都算出同一个目标，
 *      不依赖本地状态；Redis 只是加速与"漂移记忆"，不是唯一真相。
 */
import { createHash } from 'node:crypto'

/** 会话键来源 —— 排查"为什么这个会话被判定成另一个"时需要 */
export type SessionKeySource = 'prompt_cache_key' | 'context' | 'none'

/** 一次亲和记录：这个会话上一次落在哪个渠道的哪个账户上 */
export interface AffinityPin {
  channelId: string
  accountId: string
}

export interface SessionKey {
  /** 16 进制摘要（32 字符）；source 为 none 时为空串 */
  hash: string
  source: SessionKeySource
}

const NONE: SessionKey = { hash: '', source: 'none' }

export function hashSessionKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/** 日志里只记前 8 位：够用来核对"是不是同一个会话"，又不至于被反查 */
export function shortSessionHash(hash: string): string {
  return hash ? hash.slice(0, 8) : ''
}

function firstUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return ''
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    const rec = m as Record<string, unknown>
    if (rec.role !== 'user') continue
    const c = rec.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      // 多模态：只取文字片段，图片/文件不参与指纹（它们体积大且各厂商形态不一）
      const parts: string[] = []
      for (const p of c) {
        if (p && typeof p === 'object' && (p as Record<string, unknown>).type === 'text') {
          const text = (p as Record<string, unknown>).text
          if (typeof text === 'string') parts.push(text)
        }
      }
      if (parts.length > 0) return parts.join('\n')
    }
  }
  return ''
}

function systemText(payload: Record<string, unknown>): string {
  // 两种写法都见得到：messages[0].role=system，或顶层的 instructions（Responses API）
  const instructions = payload.instructions
  if (typeof instructions === 'string') return instructions
  const messages = payload.messages
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (m && typeof m === 'object' && (m as Record<string, unknown>).role === 'system') {
        const c = (m as Record<string, unknown>).content
        if (typeof c === 'string') return c
      }
    }
  }
  return ''
}

/**
 * 从请求体里取会话键。
 *
 * 优先级：
 *   ① `prompt_cache_key` —— OpenAI 官方字段，语义就是"缓存亲和键"，客户端（dsh）会发
 *   ② 上下文指纹（system + 首条 user）—— 客户端不给时的兜底；模板相同的会话会合并，
 *      这是**已知代价**，所以 source 会记成 context 便于事后判断
 *   ③ 都没有 → 不做亲和
 */
export function sessionKeyOf(
  payload: Record<string, unknown> | null | undefined,
  opts: { allowContext?: boolean } = {}
): SessionKey {
  if (!payload) return NONE

  const pck = payload.prompt_cache_key
  if (typeof pck === 'string') {
    const trimmed = pck.trim()
    // 上限只是防止有人拿超长字符串打爆哈希路径，不是安全边界
    if (trimmed.length > 0 && trimmed.length <= 256) {
      return { hash: hashSessionKey('pck:' + trimmed), source: 'prompt_cache_key' }
    }
  }

  // 上下文指纹默认不参与：见 env.affinityContext 的说明
  if (!opts.allowContext) return NONE
  const system = systemText(payload)
  const first = firstUserText(payload.messages)
  if (!system && !first) return NONE
  return { hash: hashSessionKey('ctx:' + system + '\u0000' + first), source: 'context' }
}

// ---------------------------------------------------------------- 加权 rendezvous

function normalizeWeight(w: number): number {
  return Number.isFinite(w) && w >= 1 ? Math.floor(w) : 1
}

/** (seed, id) → (0,1) 的均匀值；同一输入永远同一输出 */
function unitHash(seed: string, id: string): number {
  const digest = createHash('sha256').update(seed + '\u0001' + id).digest()
  const n = digest.readUIntBE(0, 6) / 2 ** 48
  return n > 0 ? n : Number.MIN_VALUE
}

/**
 * 加权 rendezvous 选择。
 *
 * 为什么不用「hash % N」：映射目标增删时，取模会让**几乎所有**会话换目标，
 * 缓存全灭；rendezvous 只让落到被增删节点上的那部分会话移动。
 * 权重用 `-w/ln(u)` 折进打分，权重越大越容易被选中，且保持确定性。
 */
export function rankBySession<T extends { id: string; weight: number }>(
  seed: string,
  items: T[]
): T[] {
  return [...items]
    .map((it) => ({
      it,
      score: -normalizeWeight(it.weight) / Math.log(unitHash(seed, it.id))
    }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.it)
}

export function pickBySession<T extends { id: string; weight: number }>(
  seed: string,
  items: T[]
): T | null {
  return rankBySession(seed, items)[0] ?? null
}
