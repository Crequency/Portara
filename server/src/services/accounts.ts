/**
 * 渠道的上游账户（每账户一把 Key）。
 *
 * 账户**不是**渠道：模型能力、协议、Base URL、模型映射都仍归渠道；
 * 账户只提供凭据，外加自己的选路权重与健康状态。
 *
 * 两条不变式（后面的选路、故障转移都依赖它们）：
 *
 * ① **任何渠道至少有一个账户** —— 迁移时给每个渠道回填了「默认账户」，
 *    空密钥的渠道也建了一条，所以请求路径不必到处判断"有没有账户"。
 * ② **永远有兜底账户** —— 全部账户都在冷却时，选路退化为忽略冷却，
 *    让上游去裁决。网关自己造 503 比上游 401 更糟：后者至少说明链路是通的。
 */
import { query } from '../db.js'
import { pickWeighted } from './routing.js'
import type { ChannelAccountRow } from '../types.js'

export type AccountRow = ChannelAccountRow

/** 按创建时间排序的"主账户" —— 渠道级的兼容视图（掩码、reveal、连通性测试）用它 */
export async function primaryAccount(channelId: string): Promise<AccountRow | null> {
  return (await query<AccountRow>(
    `select * from channel_accounts
      where channel_id = $1
      order by created_at asc, id asc
      limit 1`,
    [channelId]
  ))[0] ?? null
}

/** 全部账户（含停用的），按 priority 与名称排序 —— 面板展示用 */
export async function listAccounts(channelId: string): Promise<AccountRow[]> {
  return query<AccountRow>(
    `select * from channel_accounts
      where channel_id = $1
      order by priority asc, name asc, created_at asc`,
    [channelId]
  )
}

export async function getAccount(
  channelId: string,
  accountId: string
): Promise<AccountRow | null> {
  return (await query<AccountRow>(
    `select * from channel_accounts where id = $1 and channel_id = $2`,
    [accountId, channelId]
  ))[0] ?? null
}

export async function countAccounts(channelId: string): Promise<number> {
  const rows = await query<{ n: string }>(
    `select count(*)::text as n from channel_accounts where channel_id = $1`,
    [channelId]
  )
  return Number(rows[0]?.n ?? 0)
}

function isCooling(a: AccountRow, now: number): boolean {
  return Boolean(a.cooldown_until) && new Date(a.cooldown_until!).getTime() > now
}

/**
 * 选出可用的账户，**按优先级排成候选序列**。
 *
 * 返回数组而不是单个账户，是为了让故障转移可以直接往后取：
 * 第 0 个是本次该用的，后面是"这个不行就试那个"的顺序。
 *
 * 排序规则（与渠道选路同构）：
 *   ① 只留 active、不在冷却、未被 excludeIds 排除
 *   ② priority 最小的一层优先
 *   ③ 层内按 weight 加权轮转决定**谁排第一**，其余按名称序跟在后面
 *   ④ 低优先级层次依次接在后面（故障转移的备用梯队）
 */
export async function pickAccounts(
  channelId: string,
  rotation: number,
  opts: { limit?: number; excludeIds?: Set<string> } = {}
): Promise<AccountRow[]> {
  const rows = await listAccounts(channelId)
  const now = Date.now()

  let pool = rows.filter((a) => a.status === 'active')
  if (opts.excludeIds?.size) pool = pool.filter((a) => !opts.excludeIds!.has(a.id))

  /*
   * 三级退化（不动点：永远有账户可用，宁可让上游裁决也不自己造 503）：
   *   ① 既没冷却、额度也没耗尽
   *   ② 全耗尽了 → 允许用耗尽的（余额可能刚回升、缓存还没刷新）
   *   ③ 全冷却了 → 连冷却也忽略
   */
  const healthy = pool.filter((a) => !isCooling(a, now) && !a.quota_exhausted)
  const quotaFree = pool.filter((a) => !isCooling(a, now))
  const usable = healthy.length > 0 ? healthy : quotaFree.length > 0 ? quotaFree : pool
  if (usable.length === 0) return []

  const tiers = [...new Set(usable.map((a) => a.priority))].sort((a, b) => a - b)
  const ordered: AccountRow[] = []

  tiers.forEach((priority, index) => {
    const tier = usable
      .filter((a) => a.priority === priority)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))

    if (index === 0) {
      // 只有最优先的一层参与轮转；其余层次只是"备用梯队"，顺序固定
      const first = pickWeighted(tier, (a) => a.weight, rotation)
      if (first) ordered.push(first, ...tier.filter((a) => a.id !== first.id))
    } else {
      ordered.push(...tier)
    }
  })

  const limit = Math.max(1, opts.limit ?? ordered.length)
  return ordered.slice(0, limit)
}

/**
 * 标记一次成功：清掉冷却与失败计数（自动恢复）。
 *
 * 这是**转发热路径**上的调用，所以用条件更新把它压成"多数情况不写"：
 * 只有当账户处于异常态、或 `last_used_at` 已经陈旧时才真的 UPDATE。
 * 否则每个请求都要多一次行更新 —— 那是实打实的开销。
 */
export async function markAccountSuccess(accountId: string): Promise<void> {
  await query(
    `update channel_accounts
        set cooldown_until = null,
            last_error = '',
            consecutive_failures = 0,
            last_used_at = now(),
            updated_at = now()
      where id = $1
        and (
          cooldown_until is not null
          or consecutive_failures > 0
          or last_used_at is null
          or last_used_at < now() - interval '1 minute'
        )`,
    [accountId]
  )
}

/** 一次请求最多尝试几个账户（故障转移上限） */
export const MAX_ACCOUNT_ATTEMPTS = Math.max(1, Number(process.env.PORTARA_MAX_ACCOUNT_ATTEMPTS ?? 3))

/** 标记一次失败：进冷却并累计失败次数 */
export async function markAccountFailure(
  accountId: string,
  error: string,
  cooldownSec: number
): Promise<void> {
  await query(
    `update channel_accounts
        set cooldown_until = now() + make_interval(secs => $2),
            last_error = $3,
            consecutive_failures = consecutive_failures + 1,
            last_used_at = now(),
            updated_at = now()
      where id = $1`,
    [accountId, Math.max(0, Math.round(cooldownSec)), error.slice(0, 500)]
  )
}

export interface CreateAccountInput {
  name?: string
  keyCipher?: string
  status?: 'active' | 'disabled'
  priority?: number
  weight?: number
  note?: string
  usageAdapter?: string
  usageUrl?: string
}

export async function createAccount(
  channelId: string,
  input: CreateAccountInput
): Promise<AccountRow> {
  const rows = await query<AccountRow>(
    `insert into channel_accounts
       (channel_id, name, key_cipher, status, priority, weight, note, usage_adapter, usage_url)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning *`,
    [
      channelId,
      input.name ?? '',
      input.keyCipher ?? '',
      input.status ?? 'active',
      input.priority ?? 100,
      input.weight ?? 1,
      input.note ?? '',
      input.usageAdapter ?? '',
      input.usageUrl ?? ''
    ]
  )
  return rows[0]!
}

export async function updateAccount(
  channelId: string,
  accountId: string,
  input: CreateAccountInput
): Promise<AccountRow | null> {
  const rows = await query<AccountRow>(
    `update channel_accounts set
       name          = coalesce($3, name),
       key_cipher    = coalesce($4, key_cipher),
       status        = coalesce($5, status),
       priority      = coalesce($6, priority),
       weight        = coalesce($7, weight),
       note          = coalesce($8, note),
       usage_adapter = coalesce($9, usage_adapter),
       usage_url     = coalesce($10, usage_url),
       updated_at    = now()
     where id = $1 and channel_id = $2
     returning *`,
    [
      accountId,
      channelId,
      input.name ?? null,
      input.keyCipher ?? null,
      input.status ?? null,
      input.priority ?? null,
      input.weight ?? null,
      input.note ?? null,
      input.usageAdapter ?? null,
      input.usageUrl ?? null
    ]
  )
  return rows[0] ?? null
}

export async function deleteAccount(channelId: string, accountId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `delete from channel_accounts where id = $1 and channel_id = $2 returning id`,
    [accountId, channelId]
  )
  return rows.length > 0
}

/**
 * 把主账户的密钥镜像回 `channels.api_key_cipher`。
 *
 * 结构上那个列已经**不再是数据源**，但保持同值有两个用处：
 * ① 回滚到旧版本时仍能工作；
 * ② 旧的面板/接口若还在读它，看到的是同一个密钥而不是空值。
 */
export async function mirrorChannelKey(channelId: string): Promise<void> {
  const primary = await primaryAccount(channelId)
  await query(`update channels set api_key_cipher = $2, updated_at = now() where id = $1`, [
    channelId,
    primary?.key_cipher ?? ''
  ])
}

// ---------------------------------------------------------------- 故障转移策略

/**
 * 冷却时长（秒），按错误类别区分。
 *
 * 401/403 多半是 Key 失效或权限问题，短时间不会自愈，所以冷却得久；
 * 429 上游明说等多久就等多久（由调用方传入 Retry-After）；
 * 5xx 与网络错误通常是瞬时的，快速重试即可。
 */
export const COOLDOWN = {
  auth: 10 * 60,
  rateLimit: 60,
  upstream: 30
} as const

/** 该状态码是否值得换一个账户再试 */
export function isRetriableStatus(status: number): boolean {
  return (
    status === 401 ||
    status === 402 ||
    status === 403 ||
    status === 429 ||
    status >= 500
  )
}

/** 按状态码给出冷却时长 */
export function cooldownFor(status: number, retryAfterSec?: number | null): number {
  if (status === 401 || status === 403) return COOLDOWN.auth
  if (status === 429) return retryAfterSec && retryAfterSec > 0 ? retryAfterSec : COOLDOWN.rateLimit
  return COOLDOWN.upstream
}

/**
 * 更新账户的"额度耗尽"标记（由余额适配器在刷新后调用）。
 *
 * 判据交给调用方（金额 ≤ 0 / 窗口打满），这里只负责落库 ——
 * 因为不同厂商的"耗尽"信号不一样，不该在账户层猜。
 */
export async function setAccountQuotaExhausted(
  accountId: string,
  exhausted: boolean
): Promise<void> {
  await query(
    `update channel_accounts
        set quota_exhausted = $2, quota_checked_at = now(), updated_at = now()
      where id = $1 and quota_exhausted <> $2`,
    [accountId, exhausted]
  )
}
