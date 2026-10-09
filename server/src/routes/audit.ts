import { Hono } from 'hono'
import { z } from 'zod'
import { parseQuery } from '../lib/http.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import { listAuditEvents } from '../services/audit.js'
import type { AuditEventRow } from '../types.js'

export const auditRoutes = new Hono()

auditRoutes.use('*', requireAuth)

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  action: z.string().optional()
})

/** 审计日志查询（仅管理员）—— 例如谁在什么时候查看了哪把密钥 */
auditRoutes.get('/', requireAdmin, async (c) => {
  const q = parseQuery(c, listQuery)
  const rows = await listAuditEvents(q.limit, q.action)

  return c.json({
    events: rows.map((r: AuditEventRow) => ({
      id: r.id,
      ts: r.ts,
      actor: r.actor_username,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      detail: r.detail,
      clientIp: r.client_ip
    }))
  })
})
