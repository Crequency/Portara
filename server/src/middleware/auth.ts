import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { verify } from 'hono/jwt'
import { one } from '../db.js'
import { env } from '../env.js'
import { hashApiKey } from '../lib/crypto.js'
import { forbidden, unauthorized } from '../lib/http.js'
import type { ApiKeyRow, UserRow } from '../types.js'

export const SESSION_COOKIE = 'portara_session'

declare module 'hono' {
  interface ContextVariableMap {
    user: UserRow
    apiKey: ApiKeyRow
  }
}

// ------------------------------------------------------------ 管理面（JWT Cookie）

export const requireAuth: MiddlewareHandler = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE)
  if (!token) throw unauthorized('请先登录')

  let payload: Record<string, unknown>
  try {
    payload = (await verify(token, env.sessionSecret, 'HS256')) as Record<string, unknown>
  } catch {
    throw unauthorized('会话无效或已过期')
  }

  const userId = typeof payload.sub === 'string' ? payload.sub : ''
  if (!userId) throw unauthorized('会话无效')

  const user = await one<UserRow>('select * from users where id = $1', [userId])
  if (!user) throw unauthorized('用户不存在')
  if (user.status !== 'active') throw forbidden('账号已被禁用')

  c.set('user', user)
  await next()
}

export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const user = c.get('user')
  if (!user || user.role !== 'admin') throw forbidden('需要管理员权限')
  await next()
}

// ------------------------------------------------------------ 数据面（Bearer sk-portara-*）

function extractToken(authorization: string | undefined, xApiKey: string | undefined): string {
  if (authorization) {
    const m = /^Bearer\s+(.+)$/i.exec(authorization.trim())
    if (m?.[1]) return m[1].trim()
  }
  return (xApiKey ?? '').trim()
}

export const apiKeyAuth: MiddlewareHandler = async (c, next) => {
  const token = extractToken(
    c.req.header('authorization'),
    c.req.header('x-api-key')
  )

  if (!token) {
    throw unauthorized('缺少 API Key：请在 Authorization 头使用 Bearer sk-portara-…')
  }

  // 只存哈希 → 用哈希直查（唯一索引）
  const hash = hashApiKey(token)
  const key = await one<ApiKeyRow>('select * from api_keys where key_hash = $1', [hash])
  if (!key) throw unauthorized('API Key 无效')

  if (key.status !== 'active') throw forbidden('API Key 已被禁用')
  if (key.expires_at && new Date(key.expires_at).getTime() < Date.now()) {
    throw forbidden('API Key 已过期')
  }

  c.set('apiKey', key)
  await next()
}
