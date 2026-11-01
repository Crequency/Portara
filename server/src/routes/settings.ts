/**
 * 系统设置接口（仅管理员）。
 *
 * 同时提供**公开**的 `/api/meta`（见 app.ts）——登录页也要显示网关名称，
 * 那时还没有会话。公开端点只暴露非敏感的品牌信息。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { parseJson } from '../lib/http.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import { recordAudit } from '../services/audit.js'
import {
  getSettings,
  purgeOldLogs,
  saveSettings,
  validateSettings,
  SETTING_KEYS
} from '../services/settings.js'
import { invalidateRoutingSettingCache } from '../services/routingSettings.js'

export const settingsRoutes = new Hono()

settingsRoutes.use('*', requireAuth)
settingsRoutes.use('*', requireAdmin)

const patchSchema = z.object({
  /** 逐项更新；只传要改的项 */
  settings: z
    .array(z.object({ key: z.string().min(1), value: z.unknown() }))
    .min(1, '没有需要更新的设置项')
})

settingsRoutes.get('/', async (c) => {
  const { settings, invalid } = await getSettings()
  return c.json({ settings, invalid, keys: SETTING_KEYS })
})

settingsRoutes.patch('/', async (c) => {
  const body = await parseJson(c, patchSchema)
  const checked = validateSettings(body.settings)
  if (!checked.ok) {
    return c.json({ error: { message: '设置有误', issues: checked.issues } }, 400)
  }

  const before = (await getSettings()).settings
  const updatedBy = c.get('user')?.username ?? 'unknown'
  const settings = await saveSettings(checked.values, updatedBy)
  // 数据面的路由设置走 Redis 短缓存，保存后立刻失效（否则最长 5 秒内仍是旧策略）
  await invalidateRoutingSettingCache()

  // 审计：记录「哪一项从什么变成什么」——
  // 出事时要能回答「谁在什么时候把这个开关关了」
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const item of checked.values) {
    const key = item.key as keyof typeof settings
    changes[item.key] = { from: before[key], to: settings[key] }
  }

  await recordAudit(c, 'settings.update', { type: 'settings', id: 'global' }, { changes })

  return c.json({ settings, invalid: [] })
})

/** 立即按保留策略清理请求日志（用于验证保留设置是否真的生效） */
settingsRoutes.post('/purge-logs', async (c) => {
  const { settings } = await getSettings()
  const deleted = await purgeOldLogs(settings.logRetentionDays)

  await recordAudit(c, 'settings.purge_logs', { type: 'settings', id: 'request_logs' }, {
    retentionDays: settings.logRetentionDays,
    deleted
  })

  return c.json({
    deleted,
    retentionDays: settings.logRetentionDays,
    message:
      settings.logRetentionDays > 0
        ? `已按「保留 ${settings.logRetentionDays} 天」清理，删除 ${deleted} 条`
        : '当前设置为永久保留，未删除任何记录'
  })
})
