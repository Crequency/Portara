import { Hono } from 'hono'
import { z } from 'zod'
import { one, query } from '../db.js'
import { hashPassword } from '../lib/crypto.js'
import { badRequest, notFound, parseJson } from '../lib/http.js'
import { passwordSchema, usernameSchema, uuidSchema } from '../lib/validation.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import { toUserDto, type UserRow } from '../types.js'

export const userRoutes = new Hono()

const createSchema = z.object({
  username: usernameSchema,
  displayName: z.string().max(64).optional(),
  password: passwordSchema,
  role: z.enum(['admin', 'operator']).default('operator')
})

const updateSchema = z.object({
  displayName: z.string().max(64).optional(),
  role: z.enum(['admin', 'operator']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  password: passwordSchema.optional()
})

userRoutes.use('*', requireAuth)

userRoutes.get('/', async (c) => {
  const rows = await query<UserRow>('select * from users order by created_at asc')
  return c.json({ users: rows.map(toUserDto) })
})

userRoutes.post('/', requireAdmin, async (c) => {
  const body = await parseJson(c, createSchema)

  const exists = await one('select id from users where username = $1', [body.username])
  if (exists) throw badRequest('用户名已存在')

  const row = await one<UserRow>(
    `insert into users (username, display_name, password_hash, role)
     values ($1,$2,$3,$4) returning *`,
    [body.username, body.displayName ?? body.username, hashPassword(body.password), body.role]
  )
  return c.json({ user: toUserDto(row!) }, 201)
})

userRoutes.patch('/:id', requireAdmin, async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))
  const body = await parseJson(c, updateSchema)

  const target = await one<UserRow>('select * from users where id = $1', [id])
  if (!target) throw notFound('用户不存在')

  // 不允许把最后一个可用管理员降级或禁用
  if (
    target.role === 'admin' &&
    ((body.role && body.role !== 'admin') || body.status === 'disabled')
  ) {
    const others = await one<{ count: string }>(
      `select count(*)::text as count from users
        where role = 'admin' and status = 'active' and id <> $1`,
      [id]
    )
    if (Number(others?.count ?? '0') === 0) {
      throw badRequest('系统必须保留至少一个启用状态的管理员')
    }
  }

  if (body.status === 'disabled' && c.get('user').id === id) {
    throw badRequest('不能禁用当前登录的账号')
  }

  const row = await one<UserRow>(
    `update users set
       display_name = coalesce($2, display_name),
       role         = coalesce($3, role),
       status       = coalesce($4, status),
       password_hash= coalesce($5, password_hash),
       updated_at   = now()
     where id = $1
     returning *`,
    [
      id,
      body.displayName ?? null,
      body.role ?? null,
      body.status ?? null,
      body.password ? hashPassword(body.password) : null
    ]
  )
  return c.json({ user: toUserDto(row!) })
})

userRoutes.delete('/:id', requireAdmin, async (c) => {
  const id = uuidSchema.parse(c.req.param('id'))

  if (c.get('user').id === id) throw badRequest('不能删除当前登录的账号')

  const target = await one<UserRow>('select * from users where id = $1', [id])
  if (!target) throw notFound('用户不存在')

  if (target.role === 'admin') {
    const others = await one<{ count: string }>(
      `select count(*)::text as count from users
        where role = 'admin' and status = 'active' and id <> $1`,
      [id]
    )
    if (Number(others?.count ?? '0') === 0) {
      throw badRequest('系统必须保留至少一个启用状态的管理员')
    }
  }

  await query('delete from users where id = $1', [id])
  return c.json({ ok: true })
})
