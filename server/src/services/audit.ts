import type { Context } from 'hono'
import { query } from '../db.js'
import { clientIp } from '../lib/http.js'
import type { AuditEventRow } from '../types.js'

/**
 * 敏感操作审计。
 *
 * **失败即失败**：审计写不进去就让整个操作报错（fail-closed），
 * 不静默放过 —— 否则「留痕」就是一句空话。
 */
export async function recordAudit(
  c: Context,
  action: string,
  target: { type: string; id: string },
  detail: Record<string, unknown> = {}
): Promise<void> {
  const user = c.get('user')

  await query(
    `insert into audit_events
       (actor_user_id, actor_username, action, target_type, target_id, detail, client_ip)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      user?.id ?? null,
      user?.username ?? '',
      action,
      target.type,
      target.id,
      JSON.stringify(detail),
      clientIp(c)
    ]
  )
}

export async function listAuditEvents(limit: number, action?: string): Promise<AuditEventRow[]> {
  if (action) {
    return query<AuditEventRow>(
      'select * from audit_events where action = $1 order by ts desc limit $2',
      [action, limit]
    )
  }
  return query<AuditEventRow>('select * from audit_events order by ts desc limit $1', [limit])
}
