/**
 * 公开注册申请 + 管理员审批。
 *
 * 流程：未登录用户在登录页提交申请 → pending → 管理员在「用户管理」的
 * 注册申请页签里通过/拒绝 → 通过时在**同一个事务**内创建正式用户并回写申请。
 *
 * 安全约定：
 *   - 口令在提交时就做 scrypt 哈希，申请记录里没有任何明文凭据；
 *   - 公开端点按 IP 限流（每 IP 每分钟 10 次），复用 Redis 固定窗口计数；
 *   - 列表 / 审批 / 拒绝全部要求管理员，且响应绝不带 password_hash。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { one, pool, query } from '../db.js'
import { hashPassword } from '../lib/crypto.js'
import { ApiError, badRequest, clientIp, notFound, parseJson } from '../lib/http.js'
import { passwordSchema, usernameSchema, uuidSchema } from '../lib/validation.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import { checkRateLimit } from '../services/ratelimit.js'
import {
  toRegistrationDto,
  toUserDto,
  type RegistrationApplicationRow,
  type UserRow
} from '../types.js'

export const registrationRoutes = new Hono()

/**
 * 公开申请限流：每 IP 每分钟 10 次。
 *
 * 与 API Key 的 rpm 限流共用 checkRateLimit（Redis INCR 的固定窗口），
 * 只是 key 前缀不同（register:<ip>），两者互不占用配额。
 * 10 次足以覆盖「填错 → 重提」的正常使用，又能挡住脚本刷库。
 */
const REGISTER_RPM = 10

const registerSchema = z.object({
  username: usernameSchema,
  displayName: z.string().trim().max(64).optional(),
  password: passwordSchema,
  contact: z.string().trim().max(200).optional(),
  note: z.string().trim().max(1000).optional()
})

const rejectSchema = z.object({
  reason: z.string().trim().max(500).optional()
})

const listStatusSchema = z.enum(['pending', 'approved', 'rejected', 'all'])

function parseId(raw: string): string {
  const result = uuidSchema.safeParse(raw)
  if (!result.success) throw badRequest('非法 ID')
  return result.data
}

/** 只把 pending 视为「可审批」；已处理过的申请一律 409，避免重复建号。 */
function conflictAlreadyReviewed(status: string): ApiError {
  return new ApiError(409, 'conflict', '该申请已被处理', { status })
}

// ------------------------------------------------------------ 公开：提交申请

registrationRoutes.post('/register', async (c) => {
  const ip = clientIp(c)
  const limited = await checkRateLimit(`register:${ip}`, REGISTER_RPM)
  if (!limited.ok) {
    throw new ApiError(429, 'rate_limited', '注册申请提交过于频繁，请稍后再试', {
      retryAfterSec: limited.retryAfterSec
    })
  }

  const body = await parseJson(c, registerSchema)
  const username = body.username

  // 已有正式用户 → 409（与用户管理「用户名已存在」同口径）
  const existingUser = await one<{ id: string }>('select id from users where username = $1', [
    username
  ])
  if (existingUser) throw new ApiError(409, 'conflict', '用户名已被占用')

  // 已有待审批申请 → 409（不允许重复排队）
  const pending = await one<{ id: string }>(
    `select id from registration_applications
      where username = $1 and status = 'pending'`,
    [username]
  )
  if (pending) throw new ApiError(409, 'conflict', '该用户名已有待审批的注册申请')

  let row: RegistrationApplicationRow | null
  try {
    row = await one<RegistrationApplicationRow>(
      `insert into registration_applications
         (username, display_name, password_hash, contact, note)
       values ($1,$2,$3,$4,$5)
       returning *`,
      [
        username,
        body.displayName ?? '',
        hashPassword(body.password),
        body.contact ?? '',
        body.note ?? ''
      ]
    )
  } catch (err) {
    // 并发提交撞上部分唯一索引：同样是「已有待审批申请」
    if ((err as { code?: string }).code === '23505') {
      throw new ApiError(409, 'conflict', '该用户名已有待审批的注册申请')
    }
    throw err
  }

  return c.json({ id: row!.id, status: row!.status }, 201)
})

// ------------------------------------------------------------ 管理：列表

registrationRoutes.get('/registrations', requireAuth, requireAdmin, async (c) => {
  const parsed = listStatusSchema.safeParse(c.req.query('status') ?? 'all')
  if (!parsed.success) {
    throw badRequest('status 只能是 pending / approved / rejected / all')
  }
  const status = parsed.data

  const applications =
    status === 'all'
      ? await query<RegistrationApplicationRow>(
          'select * from registration_applications order by created_at desc'
        )
      : await query<RegistrationApplicationRow>(
          'select * from registration_applications where status = $1 order by created_at desc',
          [status]
        )

  const totalRow =
    status === 'all'
      ? await one<{ count: number }>(
          'select count(*)::int as count from registration_applications'
        )
      : await one<{ count: number }>(
          'select count(*)::int as count from registration_applications where status = $1',
          [status]
        )

  // 徽标要的是「全库待审批数」，与当前筛选无关
  const pendingRow = await one<{ count: number }>(
    `select count(*)::int as count from registration_applications where status = 'pending'`
  )

  return c.json({
    applications: applications.map(toRegistrationDto),
    total: totalRow?.count ?? 0,
    pendingCount: pendingRow?.count ?? 0
  })
})

// ------------------------------------------------------------ 管理：通过

registrationRoutes.post(
  '/registrations/:id/approve',
  requireAuth,
  requireAdmin,
  async (c) => {
    const id = parseId(c.req.param('id'))

    const client = await pool.connect()
    try {
      await client.query('begin')

      // 行锁：两个管理员同时点「通过」时，第二个会看到 status 已变 → 409
      const locked = await client.query<RegistrationApplicationRow>(
        'select * from registration_applications where id = $1 for update',
        [id]
      )
      const application = locked.rows[0]
      if (!application) throw notFound('注册申请不存在')
      if (application.status !== 'pending') {
        throw conflictAlreadyReviewed(application.status)
      }

      const dup = await client.query('select id from users where username = $1', [
        application.username
      ])
      if ((dup.rowCount ?? 0) > 0) {
        throw new ApiError(409, 'conflict', '用户名已被占用')
      }

      // 默认角色 operator、状态 active —— 与用户管理建号的默认值一致
      const created = await client.query<UserRow>(
        `insert into users (username, display_name, password_hash, role, status)
         values ($1,$2,$3,'operator','active')
         returning *`,
        [
          application.username,
          application.display_name || application.username,
          application.password_hash
        ]
      )
      const user = created.rows[0]!

      const updated = await client.query<RegistrationApplicationRow>(
        `update registration_applications
            set status = 'approved',
                reviewed_by = $2,
                reviewed_at = now(),
                user_id = $3,
                reject_reason = ''
          where id = $1
          returning *`,
        [id, c.get('user').id, user.id]
      )

      await client.query('commit')
      return c.json({
        user: toUserDto(user),
        application: toRegistrationDto(updated.rows[0]!)
      })
    } catch (err) {
      try {
        await client.query('rollback')
      } catch {
        /* 回滚失败不掩盖原错误 */
      }
      // 并发建号撞上 users.username 唯一约束
      if ((err as { code?: string }).code === '23505') {
        throw new ApiError(409, 'conflict', '用户名已被占用')
      }
      throw err
    } finally {
      client.release()
    }
  }
)

// ------------------------------------------------------------ 管理：拒绝

registrationRoutes.post(
  '/registrations/:id/reject',
  requireAuth,
  requireAdmin,
  async (c) => {
    const id = parseId(c.req.param('id'))

    // body 允许为空对象（reason 是选填）
    let raw: unknown = {}
    try {
      raw = await c.req.json()
    } catch {
      raw = {}
    }
    const body = rejectSchema.safeParse(raw)
    if (!body.success) {
      throw badRequest('参数校验失败', {
        issues: body.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message
        }))
      })
    }

    // 条件更新：只有仍在 pending 的申请能改，天然防重复审批
    const row = await one<RegistrationApplicationRow>(
      `update registration_applications
          set status = 'rejected',
              reject_reason = $2,
              reviewed_by = $3,
              reviewed_at = now()
        where id = $1 and status = 'pending'
        returning *`,
      [id, body.data.reason ?? '', c.get('user').id]
    )

    if (!row) {
      const existing = await one<RegistrationApplicationRow>(
        'select * from registration_applications where id = $1',
        [id]
      )
      if (!existing) throw notFound('注册申请不存在')
      throw conflictAlreadyReviewed(existing.status)
    }

    return c.json({ ok: true, application: toRegistrationDto(row) })
  }
)
