/**
 * 登录 / 会话（refresh token 方案）。
 *
 * 两条令牌分工明确：
 *
 *   access  token —— HS256 JWT，**15 分钟**，HttpOnly Cookie `portara_session`（path=/）
 *                   无状态、收不回来，所以暴露窗口必须小。
 *   refresh token —— 32 字节随机串，**30 天**，HttpOnly Cookie `portara_refresh`
 *                   （path=/api/auth，只在刷新时才发送），存库、可撤销、**每次刷新都轮换**。
 *
 * 这样既"记住"了登录状态（活跃用户不会莫名掉线），
 * 又保住了短时效 access token 的安全性（泄露的 access 最多活 15 分钟）。
 *
 * 轮换与重用检测的细节见 services/sessions.ts。
 */
import type { Context } from 'hono'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { sign } from 'hono/jwt'
import { z } from 'zod'
import { one, query } from '../db.js'
import { env } from '../env.js'
import { hashPassword, verifyPassword } from '../lib/crypto.js'
import { clientIp, forbidden, parseJson, unauthorized } from '../lib/http.js'
import { REFRESH_COOKIE, SESSION_COOKIE, requireAuth } from '../middleware/auth.js'
import {
  createSession,
  revokeAllForUser,
  revokeByToken,
  rotateSession,
  type SessionMeta
} from '../services/sessions.js'
import { toUserDto, type UserRow } from '../types.js'

export const authRoutes = new Hono()

const loginSchema = z.object({
  username: z.string().min(1, '用户名不能为空'),
  password: z.string().min(1, '密码不能为空')
})

/** 记录会话来源（面板将来可用于"我的登录设备"列表） */
function metaOf(c: Context): SessionMeta {
  return {
    userAgent: (c.req.header('user-agent') ?? '').slice(0, 300),
    ip: clientIp(c)
  }
}

/** 同时下发两条令牌 */
async function issueTokens(
  c: Context,
  user: Pick<UserRow, 'id' | 'role'>,
  refreshToken: string
): Promise<number> {
  const accessTtlSec = env.accessTtlMinutes * 60
  const exp = Math.floor(Date.now() / 1000) + accessTtlSec
  const access = await sign({ sub: user.id, role: user.role, exp }, env.sessionSecret, 'HS256')

  setCookie(c, SESSION_COOKIE, access, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: env.cookieSecure,
    maxAge: accessTtlSec
  })

  setCookie(c, REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    sameSite: 'Lax',
    // 限定作用域：refresh token 只在刷新时才需要发送，
    // 不该跟着每一个业务请求一起走
    path: '/api/auth',
    secure: env.cookieSecure,
    maxAge: env.refreshTtlDays * 86_400
  })

  return accessTtlSec
}

function clearAuthCookies(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  deleteCookie(c, REFRESH_COOKIE, { path: '/api/auth' })
}

authRoutes.post('/login', async (c) => {
  const { username, password } = await parseJson(c, loginSchema)

  const user = await one<UserRow>('select * from users where username = $1', [username])
  // 用户不存在与密码错误返回同一提示，避免账号枚举
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw unauthorized('用户名或密码错误')
  }
  if (user.status !== 'active') throw forbidden('账号已被禁用')

  const { refreshToken } = await createSession(user.id, metaOf(c))
  const expiresIn = await issueTokens(c, user, refreshToken)

  await query('update users set last_login_at = now() where id = $1', [user.id])
  console.log(`[portara][auth] 登录成功：${user.username}`)

  return c.json({
    user: toUserDto({ ...user, last_login_at: new Date().toISOString() }),
    expiresIn
  })
})

/**
 * 用 refresh token 换一对新令牌（轮换）。
 *
 * 前端在 access 过期前会主动调用；万一漏了，任何 401 也会兜底触发一次。
 */
authRoutes.post('/refresh', async (c) => {
  const token = getCookie(c, REFRESH_COOKIE)
  if (!token) throw unauthorized('没有可用的刷新令牌，请重新登录')

  const result = await rotateSession(token, metaOf(c))

  if (!result.ok) {
    clearAuthCookies(c)
    const message =
      result.reason === 'reuse'
        ? '检测到会话令牌被重复使用，出于安全已终止该会话，请重新登录'
        : result.reason === 'user_inactive'
          ? '账号已被禁用'
          : '登录状态已失效，请重新登录'
    throw unauthorized(message)
  }

  const user = await one<UserRow>('select * from users where id = $1', [result.userId])
  if (!user || user.status !== 'active') {
    clearAuthCookies(c)
    throw forbidden('账号已被禁用')
  }

  const expiresIn = await issueTokens(c, user, result.refreshToken)
  return c.json({ user: toUserDto(user), expiresIn })
})

authRoutes.post('/logout', async (c) => {
  const token = getCookie(c, REFRESH_COOKIE)
  // 作废整条轮换链，而不只是当前这条 —— 否则登出后旧令牌还能刷新
  if (token) await revokeByToken(token, 'logout')
  clearAuthCookies(c)
  return c.json({ ok: true })
})

authRoutes.get('/me', requireAuth, (c) => {
  return c.json({ user: toUserDto(c.get('user')) })
})

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, '新密码至少 8 位')
})

/** 自助修改密码 */
authRoutes.post('/password', requireAuth, async (c) => {
  const { currentPassword, newPassword } = await parseJson(c, passwordSchema)
  const user = c.get('user')

  if (!verifyPassword(currentPassword, user.password_hash)) {
    throw unauthorized('当前密码不正确')
  }

  await query('update users set password_hash = $1, updated_at = now() where id = $2', [
    hashPassword(newPassword),
    user.id
  ])

  // 改密后其它设备必须失效；但当前这台重新发一条，避免把自己也踢出去
  const revoked = await revokeAllForUser(user.id, 'password_changed')
  const { refreshToken } = await createSession(user.id, metaOf(c))
  const expiresIn = await issueTokens(c, user, refreshToken)

  console.log(`[portara][auth] 修改密码：${user.username}，已作废 ${revoked} 条其它会话`)
  return c.json({ ok: true, expiresIn, revokedOthers: revoked })
})
