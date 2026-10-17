/**
 * 聚合余额 / 用量接口（数据面）。
 *
 *   GET /v1/usage             全部（受该 key 的可见范围约束）
 *   GET /v1/usage/{provider}  单个（provider = **渠道 id**）
 *
 * 权限模型（迁移 012）：
 *   - `usage_allow`    能否读取余额，**默认拒绝**
 *   - `usage_channels` 可见渠道范围，空 = 全部已配置适配器的渠道
 *   - `usage_refresh`  能否用 `?refresh=1` 强制刷新，**默认拒绝**
 *
 * 为什么 refresh 要单独授权：缓存的存在就是为了避免限频，
 * 如果任何 key 都能强制刷新，等于给调用方开了一个反复打上游的开关。
 */
import { Hono } from 'hono'
import { openaiError } from '../lib/http.js'
import { apiKeyAuth } from '../middleware/auth.js'
import { getUsageSnapshot, getUsageSnapshots, listUsageChannelIds } from '../services/usageFetch.js'
import { getSetting } from '../services/settings.js'
import type { ApiKeyRow } from '../types.js'

export const usageRoutes = new Hono()

usageRoutes.use('*', apiKeyAuth)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 该 key 是否可见某渠道 */
function keyCanSeeChannel(key: ApiKeyRow, channelId: string): boolean {
  return key.usage_channels.length === 0 || key.usage_channels.includes(channelId)
}

/**
 * 解析 `?refresh=1`。
 * 无权限时**明确 403**（而不是静默忽略）—— 静默忽略会让调用方
 * 以为自己拿到了实时数据，那比报错更糟。
 */
function wantsRefresh(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true'
}

usageRoutes.get('/', async (c) => {
  const key = c.get('apiKey') as ApiKeyRow

  if (!key.usage_allow) {
    return openaiError(
      c,
      403,
      '该密钥没有读取余额的权限，请在管理面板的「API 密钥」中开启',
      'permission_error',
      'usage_not_allowed'
    )
  }

  const refresh = wantsRefresh(c.req.query('refresh'))
  if (refresh && !key.usage_refresh) {
    return openaiError(
      c,
      403,
      '该密钥没有强制刷新余额的权限',
      'permission_error',
      'usage_refresh_not_allowed'
    )
  }

  const all = await listUsageChannelIds()
  const visible = all.filter((id) => keyCanSeeChannel(key, id))

  // 强制刷新加最小间隔，避免把缓存机制绕成"每次都打上游"
  const force = refresh ? await allowForce() : false
  const providers = await getUsageSnapshots(visible, { force })

  return c.json({
    object: 'usage.list',
    generatedAt: new Date().toISOString(),
    providers
  })
})

usageRoutes.get('/:provider', async (c) => {
  const key = c.get('apiKey') as ApiKeyRow
  const provider = c.req.param('provider')

  if (!key.usage_allow) {
    return openaiError(
      c,
      403,
      '该密钥没有读取余额的权限，请在管理面板的「API 密钥」中开启',
      'permission_error',
      'usage_not_allowed'
    )
  }

  // provider 就是渠道 id
  if (!UUID_RE.test(provider)) {
    return openaiError(
      c,
      400,
      `provider 必须是渠道 id（uuid），收到「${provider}」`,
      'invalid_request_error',
      'invalid_provider'
    )
  }

  if (!keyCanSeeChannel(key, provider)) {
    return openaiError(
      c,
      403,
      '该密钥不在这个渠道的可见范围内',
      'permission_error',
      'usage_channel_not_allowed'
    )
  }

  const refresh = wantsRefresh(c.req.query('refresh'))
  if (refresh && !key.usage_refresh) {
    return openaiError(
      c,
      403,
      '该密钥没有强制刷新余额的权限',
      'permission_error',
      'usage_refresh_not_allowed'
    )
  }

  const force = refresh ? await allowForce() : false

  try {
    const snapshot = await getUsageSnapshot(provider, { force })
    return c.json(snapshot)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('渠道不存在')) {
      return openaiError(c, 404, '渠道不存在', 'invalid_request_error', 'channel_not_found')
    }
    throw err
  }
})

/**
 * 强制刷新的节流。
 *
 * 用 Redis 的 NX 做"最近 N 秒内已刷过"的标记：拿不到标记就退化为
 * 普通读取（走缓存）。这样即便 key 有权限，也打不爆上游。
 */
async function allowForce(): Promise<boolean> {
  const { redis } = await import('../redis.js')
  const ttl = await getSetting('usageCacheTtlSec')
  // 间隔不超过缓存时长（缓存很短时没必要卡更久）
  const windowSec = Math.max(1, Math.min(10, Math.floor(ttl / 2)))
  try {
    const ok = await redis.set('portara:usage:force', '1', 'EX', windowSec, 'NX')
    return ok === 'OK'
  } catch {
    return true
  }
}
