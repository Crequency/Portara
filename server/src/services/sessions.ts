/**
 * 登录会话 —— refresh token 的**轮换链**。
 *
 * 为什么需要服务端记录：access token 是无状态 JWT，签发后收不回来。
 * 要支持「登出即刻失效 / 改密踢掉其它设备 / 检测令牌重用」，就必须有这份记录。
 *
 * 三条安全设计：
 *
 * ① **只存哈希**。refresh token 是 32 字节高熵随机串，用 SHA-256 足够 ——
 *    不像密码需要慢哈希（没有字典可猜）。库被读走也换不回令牌。
 *
 * ② **每次刷新都轮换**。旧令牌立即作废、同族换发新的。
 *    于是"一个令牌被用两次"这件事本身就可疑 —— 见 ③。
 *
 * ③ **重用检测 + 整族作废**。如果已作废的令牌又被拿来用，说明它泄露了：
 *    此时把**整条链**作废。用户重新登录即可，攻击者手里的旧链全部失效。
 *
 * ④ **宽限窗口（30 秒）**。没有它，多标签页并发刷新会自己把自己踢下线：
 *    两个标签同时拿同一个令牌刷新，后者会命中 ③ 被判成重放。
 *    所以在"刚被轮换掉"的短时间内，改走**同族继任者**而不是判泄露。
 *    真正的重放攻击发生在令牌泄露很久之后，不在这个窗口内。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { one, query } from '../db.js'
import { env } from '../env.js'
import type { UserRow } from '../types.js'

export interface SessionRow {
  id: string
  user_id: string
  family_id: string
  token_hash: string
  created_at: Date
  last_used_at: Date
  expires_at: Date
  revoked_at: Date | null
  revoked_reason: string
  user_agent: string
  ip: string
}

export type RevokeReason =
  | 'rotated'
  | 'logout'
  | 'reuse_detected'
  | 'password_changed'
  | 'user_disabled'

export interface SessionMeta {
  userAgent?: string
  ip?: string
}

/** 宽限窗口：刚被轮换掉的令牌在此时间内重放，视为并发刷新而非泄露 */
function graceMs(): number {
  return Math.max(0, env.refreshGraceSeconds) * 1000
}

export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function ttlInterval(): string {
  // 天数由配置决定，交给 Postgres 做区间运算，避免在 JS 侧算日期
  return `${env.refreshTtlDays} days`
}

/** 建一条新会话（登录时调用），返回明文 refresh token（只此一次可见） */
export async function createSession(
  userId: string,
  meta: SessionMeta
): Promise<{ refreshToken: string; session: SessionRow }> {
  const refreshToken = newRefreshToken()
  const row = await one<SessionRow>(
    `insert into sessions (user_id, family_id, token_hash, expires_at, user_agent, ip)
     values ($1, $2, $3, now() + $4::interval, $5, $6)
     returning *`,
    [userId, randomUUID(), hashRefreshToken(refreshToken), ttlInterval(), meta.userAgent ?? '', meta.ip ?? '']
  )
  return { refreshToken, session: row! }
}

export type RotateResult =
  | { ok: true; userId: string; refreshToken: string; familyId: string }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'reuse' | 'user_inactive' }

/** 同族中仍然有效的那条（轮换链的"继任者"） */
async function liveInFamily(familyId: string): Promise<SessionRow | null> {
  return one<SessionRow>(
    `select * from sessions
      where family_id = $1 and revoked_at is null and expires_at > now()
      order by created_at desc limit 1`,
    [familyId]
  )
}

/**
 * 轮换：用旧 refresh token 换一对新的 access + refresh。
 */
export async function rotateSession(token: string, meta: SessionMeta): Promise<RotateResult> {
  const row = await one<SessionRow>('select * from sessions where token_hash = $1', [
    hashRefreshToken(token)
  ])
  if (!row) return { ok: false, reason: 'unknown' }

  let target = row

  if (row.revoked_at) {
    const revokedAgo = Date.now() - new Date(row.revoked_at).getTime()
    const isFreshRotation = row.revoked_reason === 'rotated' && revokedAgo < graceMs()

    if (isFreshRotation) {
      // 宽限窗口：多半是多标签页并发刷新。改轮换同族的继任者，
      // 而不是把用户自己当成攻击者踢下线。
      const live = await liveInFamily(row.family_id)
      if (!live) return { ok: false, reason: 'revoked' }
      target = live
    } else {
      // 真正的重放：已作废的令牌在宽限窗口之外被再次使用 → 视为泄露
      await revokeFamily(row.family_id, 'reuse_detected')
      console.warn(
        `[portara][auth] 检测到 refresh token 重用，已作废整条会话链（family=${row.family_id}）`
      )
      return { ok: false, reason: 'reuse' }
    }
  }

  if (new Date(target.expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' }
  }

  const user = await one<UserRow>('select * from users where id = $1', [target.user_id])
  if (!user || user.status !== 'active') {
    await revokeFamily(target.family_id, 'user_disabled')
    return { ok: false, reason: 'user_inactive' }
  }

  // 原子作废旧行：并发下只有一个能成功，避免同一条被轮换两次
  const claimed = await one<{ id: string }>(
    `update sessions set revoked_at = now(), revoked_reason = 'rotated', last_used_at = now()
      where id = $1 and revoked_at is null
      returning id`,
    [target.id]
  )
  if (!claimed) {
    // 刚好被别人抢先轮换 —— 重试一次即可读到继任者
    return { ok: false, reason: 'revoked' }
  }

  const next = newRefreshToken()
  await query(
    `insert into sessions (user_id, family_id, token_hash, expires_at, user_agent, ip)
     values ($1, $2, $3, now() + $4::interval, $5, $6)`,
    [
      target.user_id,
      target.family_id,
      hashRefreshToken(next),
      ttlInterval(),
      meta.userAgent || target.user_agent,
      meta.ip || target.ip
    ]
  )

  return { ok: true, userId: target.user_id, refreshToken: next, familyId: target.family_id }
}

/** 作废整条链 */
export async function revokeFamily(familyId: string, reason: RevokeReason): Promise<number> {
  const rows = await query<{ id: string }>(
    `update sessions set revoked_at = now(), revoked_reason = $2
      where family_id = $1 and revoked_at is null
      returning id`,
    [familyId, reason]
  )
  return rows.length
}

/** 登出：作废该令牌所属的整条链 */
export async function revokeByToken(token: string, reason: RevokeReason): Promise<number> {
  const row = await one<SessionRow>('select family_id from sessions where token_hash = $1', [
    hashRefreshToken(token)
  ])
  if (!row) return 0
  return revokeFamily(row.family_id, reason)
}

/** 作废某用户的全部会话（改密、禁用时用） */
export async function revokeAllForUser(userId: string, reason: RevokeReason): Promise<number> {
  const rows = await query<{ id: string }>(
    `update sessions set revoked_at = now(), revoked_reason = $2
      where user_id = $1 and revoked_at is null
      returning id`,
    [userId, reason]
  )
  return rows.length
}

/** 清理已过期/已作废超过 30 天的记录（定时任务调用） */
export async function pruneSessions(): Promise<number> {
  const rows = await query<{ id: string }>(
    `delete from sessions
      where expires_at < now()
         or (revoked_at is not null and revoked_at < now() - interval '30 days')
      returning id`
  )
  return rows.length
}

/** 当前仍有效的会话数（面板用得上，暂未接界面） */
export async function countActiveSessions(userId: string): Promise<number> {
  const row = await one<{ n: string }>(
    `select count(*)::text as n from sessions
      where user_id = $1 and revoked_at is null and expires_at > now()`,
    [userId]
  )
  return Number(row?.n ?? 0)
}
