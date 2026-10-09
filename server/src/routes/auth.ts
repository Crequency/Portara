import { Hono } from 'hono'
import { deleteCookie, setCookie } from 'hono/cookie'
import { sign } from 'hono/jwt'
import { z } from 'zod'
import { one, query } from '../db.js'
import { env } from '../env.js'
import { hashPassword, verifyPassword } from '../lib/crypto.js'
import { forbidden, parseJson, unauthorized } from '../lib/http.js'
import { SESSION_COOKIE, requireAuth } from '../middleware/auth.js'
import { toUserDto, type UserRow } from '../types.js'

export const authRoutes = new Hono()

const loginSchema = z.object({
  username: z.string().min(1, '用户名不能为空'),
  password: z.string().min(1, '密码不能为空')
})

authRoutes.post('/login', async (c) => {
  const { username, password } = await parseJson(c, loginSchema)

  const user = await one<UserRow>('select * from users where username = $1', [username])
  // 用户不存在与密码错误返回同一提示，避免账号枚举
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw unauthorized('用户名或密码错误')
  }
  if (user.status !== 'active') throw forbidden('账号已被禁用')

  const exp = Math.floor(Date.now() / 1000) + env.sessionTtlHours * 3600
  const token = await sign(
    { sub: user.id, role: user.role, exp },
    env.sessionSecret,
    'HS256'
  )

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: env.cookieSecure,
    maxAge: env.sessionTtlHours * 3600
  })

  await query('update users set last_login_at = now() where id = $1', [user.id])
  console.log(`[portara][auth] 登录成功：${user.username}`)

  return c.json({ user: toUserDto({ ...user, last_login_at: new Date().toISOString() }) })
})

authRoutes.post('/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
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
  return c.json({ ok: true })
})
