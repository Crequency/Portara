/**
 * 余额 / 用量的取数与缓存。
 *
 * 缓存存在的唯一理由是**避免限频** —— 各厂商的余额接口多有频率限制，
 * 而面板会轮询、也可能多人同时查看，不该每次都真打上游。
 *
 * 失败处理的原则：**宁可给旧数据，也不给空白**。
 * 刷新失败时保留上一次成功的快照并标 `stale`，
 * 比"上游抖了一下，面板就整片报错"有用得多。
 */
import { one, query } from '../db.js'
import { env } from '../env.js'
import { decryptSecret } from '../lib/crypto.js'
import { redis } from '../redis.js'
import { upstreamFetch } from './proxyAgent.js'
import { getProxyTarget } from './proxies.js'
import { getSetting } from './settings.js'
import {
  endpointUrl,
  getUsageAdapter,
  type UsageAdapter,
  type UsageSnapshot
} from './usage.js'
import type { ChannelRow } from '../types.js'

const CACHE_PREFIX = 'portara:usage:'
/** 刷新锁：防止同一渠道被并发打上游 */
const LOCK_PREFIX = 'portara:usage:lock:'
/** 上游原始响应最多留这么多字符 */
const RAW_LIMIT = 256 * 1024

function cacheKey(channelId: string): string {
  return CACHE_PREFIX + channelId
}

async function readCache(channelId: string): Promise<UsageSnapshot | null> {
  try {
    const raw = await redis.get(cacheKey(channelId))
    if (!raw) return null
    return JSON.parse(raw) as UsageSnapshot
  } catch {
    return null
  }
}

async function writeCache(channelId: string, snapshot: UsageSnapshot, ttlSec: number): Promise<void> {
  try {
    await redis.set(cacheKey(channelId), JSON.stringify(snapshot), 'EX', ttlSec)
  } catch (err) {
    console.warn('[portara] 写余额缓存失败：', err instanceof Error ? err.message : String(err))
  }
}

/** 清掉某渠道的缓存（渠道改了适配器/密钥后必须清，否则会返回旧口径的数据） */
export async function invalidateUsageCache(channelId: string): Promise<void> {
  try {
    await redis.del(cacheKey(channelId))
  } catch {
    /* 缓存清不掉不该让写操作失败 */
  }
}

function errorSnapshot(
  channel: { id: string; name: string; usage_adapter: string },
  error: string
): UsageSnapshot {
  return {
    channelId: channel.id,
    channelName: channel.name,
    adapter: channel.usage_adapter,
    ok: false,
    error,
    fetchedAt: new Date().toISOString(),
    cached: false,
    warnings: [],
    balances: [],
    windows: []
  }
}

/**
 * 取某个渠道的余额快照。
 *
 * `force` 表示绕过缓存（调用方负责做权限与限频判断）。
 */
export async function getUsageSnapshot(
  channelId: string,
  opts: { force?: boolean } = {}
): Promise<UsageSnapshot> {
  const ch = await one<ChannelRow>('select * from channels where id = $1', [channelId])
  if (!ch) throw new Error('渠道不存在')

  const adapter = getUsageAdapter(ch.usage_adapter)
  if (!adapter) {
    return errorSnapshot(ch, ch.usage_adapter ? `未知的余额适配器「${ch.usage_adapter}」` : '该渠道未配置余额适配器')
  }

  const ttl = await getSetting('usageCacheTtlSec')

  // 非强制刷新：命中缓存直接返回
  if (!opts.force) {
    const hit = await readCache(ch.id)
    if (hit) return { ...hit, cached: true }
  }

  // 防击穿：同一渠道同时只允许一个刷新去打上游，其余等一会儿读缓存
  const lockKey = LOCK_PREFIX + ch.id
  let gotLock = true
  try {
    const ok = await redis.set(lockKey, '1', 'EX', 30, 'NX')
    gotLock = ok === 'OK'
  } catch {
    gotLock = true // Redis 异常时不阻塞功能
  }
  if (!gotLock) {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250))
      const hit = await readCache(ch.id)
      if (hit) return { ...hit, cached: true }
    }
    // 等不到就自己来（宁可多打一次，也不要一直空着）
  }

  const snapshot = await fetchSnapshot(ch, adapter)

  try {
    if (snapshot.ok) {
      await writeCache(ch.id, snapshot, ttl)
    } else {
      // 失败：保留旧快照并把本次错误附上，让调用方既能看到旧数据也知道它不新鲜
      const prev = await readCache(ch.id)
      if (prev && prev.ok) {
        const stale: UsageSnapshot = { ...prev, cached: true, stale: true, error: snapshot.error }
        await writeCache(ch.id, stale, ttl)
        return stale
      }
    }
  } finally {
    try {
      await redis.del(lockKey)
    } catch {
      /* 锁会自己过期 */
    }
  }

  return snapshot
}

/** 真正去打上游并解析 */
async function fetchSnapshot(ch: ChannelRow, adapter: UsageAdapter): Promise<UsageSnapshot> {
  let apiKey = ''
  if (ch.api_key_cipher) {
    try {
      apiKey = decryptSecret(ch.api_key_cipher, env.masterKey)
    } catch {
      return errorSnapshot(ch, '渠道密钥无法解密，请重新填写')
    }
  }

  const proxy = await getProxyTarget(ch.proxy_id)
  const timeoutMs = Math.min(ch.timeout_ms, 30_000)

  const responses: Record<string, unknown> = {}
  const warnings: string[] = []
  const raws: Record<string, string> = {}

  // 并行拉取：各端点相互独立，串行会白白等好几倍时间
  const results = await Promise.all(
    adapter.endpoints.map(async (ep) => {
      const url = endpointUrl(adapter, ch.base_url, ep.path, ch.usage_url)
      const headers: Record<string, string> = { accept: 'application/json' }
      if (adapter.auth === 'bearer' && apiKey) headers.authorization = `Bearer ${apiKey}`
      if (adapter.auth === 'x-api-key' && apiKey) headers['x-api-key'] = apiKey

      try {
        const res = await upstreamFetch(
          url,
          { headers, signal: AbortSignal.timeout(timeoutMs) },
          proxy
        )
        const text = await res.text()
        raws[ep.key] = text.length > RAW_LIMIT ? text.slice(0, RAW_LIMIT) : text
        if (!res.ok) {
          return { ep, error: `HTTP ${res.status}：${text.slice(0, 200)}`, body: null }
        }
        try {
          return { ep, error: null, body: JSON.parse(text) as unknown }
        } catch {
          return { ep, error: '响应不是合法 JSON', body: null }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ep, error: /timeout|abort/i.test(msg) ? '请求超时' : msg, body: null }
      }
    })
  )

  for (const r of results) {
    if (r.body !== null) {
      responses[r.ep.key] = r.body
      continue
    }
    if (r.ep.required) {
      // 必需端点失败 → 整个快照失败
      return {
        ...errorSnapshot(ch, `${r.ep.path} 拉取失败：${r.error}`),
        raw: raws
      }
    }
    warnings.push(`${r.ep.path} 拉取失败：${r.error}`)
  }

  let parsed: Partial<UsageSnapshot>
  try {
    parsed = adapter.parse(responses)
  } catch (err) {
    return {
      ...errorSnapshot(ch, err instanceof Error ? err.message : String(err)),
      raw: raws
    }
  }

  return {
    channelId: ch.id,
    channelName: ch.name,
    adapter: adapter.id,
    ok: true,
    fetchedAt: new Date().toISOString(),
    cached: false,
    warnings: [...(parsed.warnings ?? []), ...warnings],
    balances: parsed.balances ?? [],
    windows: parsed.windows ?? [],
    period: parsed.period,
    plan: parsed.plan,
    raw: raws
  }
}

/**
 * 批量取（聚合接口与余额页用）。
 * 单个渠道失败不影响其它渠道 —— 一个厂商挂了不该让整页空白。
 */
export async function getUsageSnapshots(
  channelIds: string[],
  opts: { force?: boolean } = {}
): Promise<UsageSnapshot[]> {
  const out: UsageSnapshot[] = []
  // 顺序执行：这是"查看余额"，不是性能敏感路径；顺序也能自然分散上游压力
  for (const id of channelIds) {
    try {
      out.push(await getUsageSnapshot(id, opts))
    } catch (err) {
      out.push({
        channelId: id,
        channelName: id,
        adapter: '',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        fetchedAt: new Date().toISOString(),
        cached: false,
        warnings: [],
        balances: [],
        windows: []
      })
    }
  }
  return out
}

/** 列出所有配置了余额适配器的渠道 id（保持列表顺序稳定） */
export async function listUsageChannelIds(): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `select id from channels where usage_adapter <> '' order by name asc`
  )
  return rows.map((r) => r.id)
}
