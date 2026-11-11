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
import type { AccountState } from './accountState.js'

/** 会话键来源 —— 排查"为什么这个会话被判定成另一个"时需要 */
export type SessionKeySource = 'prompt_cache_key' | 'client' | 'context' | 'none'

/** 一次亲和记录：这个会话上一次落在哪个渠道的哪个账户上 */
export interface AffinityPin {
  channelId: string
  accountId: string
  /**
   * 落 pin 的时间（epoch ms）。
   *
   * 只在新会话首次落 pin、pin 变更、或旧数据补写时记录；
   * **成功命中亲和不刷新它** —— 否则「最大年龄」永远追不上当前时间，
   * 长会话就会无限期粘在同一个账户上（正是这次要修的漂移）。
   */
  pinnedAt?: number
}

/**
 * 亲和被丢弃的原因 —— 日志与测试都靠它区分「为什么不再提前这个 pin」。
 *
 * - expired        超过 PORTARA_AFFINITY_MAX_AGE_SEC
 * - state=cooling  账户在冷却（quotaCooling / genericCooling）
 * - usageLimited   账户余额/额度已耗尽
 * - not_in_pool    账户已删除/停用/被本轮排除
 */
export type AffinityDropReason = 'expired' | 'state=cooling' | 'usageLimited' | 'not_in_pool'

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

// ---------------------------------------------------------------- 亲和健康度

/**
 * pin 的年龄（毫秒）。
 *
 * 旧数据没有 `pinnedAt`：视为「刚创建」（age=0）。
 * 理由：直接判失效会在升级瞬间清掉所有在线会话的亲和，缓存集体重建；
 * 而兼容处理不会让上限失效 —— `nextAffinityPin` 会把缺失的时间戳补写回去，
 * 下一个成功请求就开始计时。
 */
export function pinAgeMs(
  pin: Pick<AffinityPin, 'pinnedAt'> | null | undefined,
  now = Date.now()
): number {
  const at = pin?.pinnedAt
  if (typeof at !== 'number' || !Number.isFinite(at)) return 0
  return Math.max(0, now - at)
}

/** 是否超过亲和最大年龄（纯函数，便于单测边界） */
export function isAffinityExpired(ageMs: number, maxAgeSec: number): boolean {
  const maxAgeMs = Math.max(0, maxAgeSec) * 1000
  return !Number.isFinite(ageMs) || ageMs > maxAgeMs
}

export interface KeepPinInput {
  /** 账户当前状态；null/undefined = 不在本轮候选池 */
  state: AccountState | null | undefined
  /** 距今多久落的 pin（毫秒） */
  ageMs: number
  /** 时效上限（秒，来自 PORTARA_AFFINITY_MAX_AGE_SEC） */
  maxAgeSec: number
  /**
   * 整个池子都已退化到 usageLimited 兜底。
   *
   * 这时 pin 允许「按原顺序参与」—— 保留记录但**绝不提前**：
   * 提前就回到「每个请求先打已耗尽账户」的老问题。
   */
  usageLimitedFallback?: boolean
}

export interface KeepPinResult {
  /** 是否保留这条亲和（false = 调用方应 clearAffinity） */
  keep: boolean
  /** 丢弃原因；keep=true 时不存在 */
  reason?: AffinityDropReason
}

/**
 * 这条 pin 还值得保留吗？
 *
 * 顺序很重要：**先看年龄，再看健康度**。
 * 一个超龄的 pin 即使账户当下是 ok 的也该丢 —— 长会话的配额窗口
 * 早就滚过一轮，「上次用得好」不再说明任何问题。
 */
export function shouldKeepPin(input: KeepPinInput): KeepPinResult {
  if (isAffinityExpired(input.ageMs, input.maxAgeSec)) {
    return { keep: false, reason: 'expired' }
  }
  if (input.state === null || input.state === undefined) {
    return { keep: false, reason: 'not_in_pool' }
  }
  if (input.state === 'ok') return { keep: true }
  if (input.state === 'usageLimited') {
    if (input.usageLimitedFallback === true) return { keep: true }
    return { keep: false, reason: 'usageLimited' }
  }
  // quotaCooling / genericCooling —— 两种冷却都不许提前
  return { keep: false, reason: 'state=cooling' }
}

/**
 * pin 是否可以提前到候选首位。
 *
 * **只有 state=ok 才行**。冷却中或已耗尽的账户即使有 pin 也不许插队，
 * 否则「会话亲和」会重新变成「优先打坏上游」—— 这就是本次修复的核心。
 */
export function canPromotePin(state: AccountState | null | undefined): boolean {
  return state === 'ok'
}

export interface AffinityDecision extends KeepPinResult {
  /** 是否把 pin 提到首位；keep=false 时必然为 false */
  promote: boolean
}

/** 把「是否保留」与「是否提前」合成一次决策（accounts.ts 的唯一入口） */
export function decideAffinityPin(input: KeepPinInput): AffinityDecision {
  const verdict = shouldKeepPin(input)
  return {
    ...verdict,
    promote: verdict.keep && canPromotePin(input.state)
  }
}

/**
 * 把 pin 提到首位（纯函数，不修改入参）。
 *
 * 调用方必须先用 decideAffinityPin 判定 promote；这里只负责排序，
 * 把「何时允许提前」与「怎么提前」分开，避免健康度判断被排序细节淹没。
 */
export function promotePinned<T extends { id: string }>(
  ordered: T[],
  pinId: string | null | undefined
): { accounts: T[]; promoted: boolean } {
  if (!pinId) return { accounts: ordered, promoted: false }
  const index = ordered.findIndex((item) => item.id === pinId)
  if (index <= 0) return { accounts: ordered, promoted: false }
  const pinned = ordered[index]!
  return {
    accounts: [pinned, ...ordered.filter((_, i) => i !== index)],
    promoted: true
  }
}

export interface NextPinInput {
  /** 读到的旧 pin（可能来自 Redis，也可能是 null） */
  previous: AffinityPin | null | undefined
  channelId: string
  accountId: string
  /** 当前时间（epoch ms），测试注入用 */
  now: number
  /** 调用方已判定旧 pin 失效并 clear（成功后再重新落） */
  invalidated?: boolean
  /** 本轮发生了渠道漂移 */
  drifted?: boolean
}

export interface NextPinResult {
  /** 是否应写 Redis */
  write: boolean
  /** write=true 时要写的 pin */
  pin?: AffinityPin
}

/**
 * 这次成功请求之后要不要重写 pin。
 *
 * 纪律：**成功命中不算变更，不刷新 pinnedAt**。
 * 只有三种情况写：
 *   ① 之前没有 pin（新会话首次落）；
 *   ② 目标（渠道/账户）变了；
 *   ③ 旧数据缺 pinnedAt（补写时间戳，开始计时）或调用方明确标记失效/漂移。
 */
export function nextAffinityPin(input: NextPinInput): NextPinResult {
  const { previous, channelId, accountId, now } = input
  if (!channelId || !accountId) return { write: false }

  const sameTarget =
    previous !== null &&
    previous !== undefined &&
    previous.channelId === channelId &&
    previous.accountId === accountId
  const missingPinnedAt =
    sameTarget &&
    !(typeof previous!.pinnedAt === 'number' && Number.isFinite(previous!.pinnedAt))
  const forced = input.invalidated === true || input.drifted === true

  if (sameTarget && !missingPinnedAt && !forced) return { write: false }

  return {
    write: true,
    pin: { channelId, accountId, pinnedAt: now }
  }
}
