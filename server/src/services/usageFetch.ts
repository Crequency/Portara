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
import { redis } from '../redis.js'
import {
  listAccounts,
  setAccountQuotaExhausted,
  setAccountWindowExhausted,
  type AccountRow
} from './accounts.js'
import { tryDecryptKey } from './channels.js'
import { upstreamFetch } from './proxyAgent.js'
import { getProxyTarget } from './proxies.js'
import { getSetting } from './settings.js'
import { loadWebSession, loadWebSnapshot, markSessionResult } from './webSession.js'
import {
  aggregateAccountSnapshots,
  endpointUrl,
  getUsageAdapter,
  hasExhaustedWindow,
  isAccountExhausted,
  type UsageAccountSnapshot,
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
    windows: [],
    accounts: []
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

/** 打一个上游端点（成功 / 失败都归一化成同一种结果，供两种形态共用） */
interface EndpointOutcome {
  key: string
  /** 报错时展示给用户的标识（相对路径或完整 URL） */
  label: string
  required: boolean
  /** HTTP 状态码；0 = 连接层失败（超时 / 网络） */
  status: number
  error: string | null
  body: unknown
}

/** 打一个端点：超时、代理、RAW_LIMIT 与错误归一化全部在这里，两种形态共用 */
async function callEndpoint(opts: {
  key: string
  label: string
  url: string
  required: boolean
  headers: Record<string, string>
  timeoutMs: number
  proxy: Awaited<ReturnType<typeof getProxyTarget>>
  raws: Record<string, string>
}): Promise<EndpointOutcome> {
  const base: Pick<EndpointOutcome, 'key' | 'label' | 'required'> = {
    key: opts.key,
    label: opts.label,
    required: opts.required
  }
  try {
    const res = await upstreamFetch(
      opts.url,
      { headers: opts.headers, signal: AbortSignal.timeout(opts.timeoutMs) },
      opts.proxy
    )
    const text = await res.text()
    opts.raws[opts.key] = text.length > RAW_LIMIT ? text.slice(0, RAW_LIMIT) : text
    if (!res.ok) {
      return {
        ...base,
        status: res.status,
        error: `HTTP ${res.status}：${text.slice(0, 200)}`,
        body: null
      }
    }
    try {
      return { ...base, status: res.status, error: null, body: JSON.parse(text) as unknown }
    } catch {
      return { ...base, status: res.status, error: '响应不是合法 JSON', body: null }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ...base,
      status: 0,
      error: /timeout|abort/i.test(msg) ? '请求超时' : msg,
      body: null
    }
  }
}

/** 打一个账户的余额接口并解析（失败只影响这个账户） */
async function fetchAccountSnapshot(
  ch: ChannelRow,
  account: AccountRow,
  proxy: Awaited<ReturnType<typeof getProxyTarget>>
): Promise<UsageAccountSnapshot> {
  const fail = (error: string, raw?: unknown): UsageAccountSnapshot => ({
    accountId: account.id,
    accountName: account.name,
    adapter: account.usage_adapter || ch.usage_adapter,
    ok: false,
    error,
    warnings: [],
    balances: [],
    windows: [],
    raw
  })

  // 账户级适配器可覆盖渠道（国内站/国际站的接口未必相同）
  const adapter = getUsageAdapter(account.usage_adapter || ch.usage_adapter)
  if (!adapter) return fail('未配置或未知的余额适配器')

  const timeoutMs = Math.min(ch.timeout_ms, 30_000)
  const responses: Record<string, unknown> = {}
  const warnings: string[] = []
  const raws: Record<string, string> = {}

  // ---------------------------------------------------------------- 会话型
  /*
   * 会话型（session-http）：凭据不是渠道密钥，而是管理员粘贴的网页 Cookie。
   * 端点用完整 URL（网页接口通常与推理地址不同域），鉴权头是 cookie。
   */
  if (adapter.kind === 'session-http') {
    if (adapter.auth !== 'session-cookie') {
      return fail('会话型适配器必须声明 auth="session-cookie"')
    }
    const endpoints = adapter.sessionEndpoints ?? []
    if (endpoints.length === 0) return fail('适配器没有声明任何会话端点')

    const session = await loadWebSession(account.id)
    const snapshot = await loadWebSnapshot(account.id)

    /**
     * 快照兜底：把浏览器里抓到的 `/api/v1/me` JSON 当成本次数据。
     *
     * 这条路径**必然可用** —— 它不依赖服务端能否重放会话 Cookie。
     * 代价是数据是"采集那一刻"的，所以要在 warnings 里写清时间，
     * 让面板显示"手动快照"而不是伪装成实时数据。
     */
    const parseSnapshot = (reason: string): UsageAccountSnapshot | null => {
      if (!snapshot) return null
      const key = adapter.sessionEndpoints?.[0]?.key ?? 'me'
      try {
        const parsed = adapter.parse({ [key]: snapshot.snapshot })
        const at = snapshot.snapshotAt ?? null
        return {
          accountId: account.id,
          accountName: account.name,
          adapter: adapter.id,
          ok: true,
          warnings: [
            ...(parsed.warnings ?? []),
            `来自手动快照${at ? `（${at}）` : ''}：${reason}`
          ],
          balances: parsed.balances ?? [],
          windows: parsed.windows ?? [],
          period: parsed.period,
          plan: parsed.plan,
          raw: { snapshot: snapshot.snapshot }
        }
      } catch {
        return null
      }
    }

    if (!session) {
      const fromSnapshot = parseSnapshot('没有可用的网页会话')
      if (fromSnapshot) return fromSnapshot
      return fail('该账户还没有网页会话，请在渠道详情页粘贴 Cookie 或控制台脚本输出的快照')
    }

    /*
     * 端点地址的**基址覆盖**：账户/渠道的 usage_url 会替换 origin，
     * 端点自身的 pathname 拼在后面（与纯 HTTP 分支同一套语义）。
     *
     * 这不是为测试开后门：网页接口的域名在部分部署里会被反代改写
     * （办公楼里用代理、自建镜像），而 session 端点的域名又是写死的。
     */
    const override = (account.usage_url || ch.usage_url || '').trim()
    const urlOf = (rawUrl: string): string => {
      if (!override) return rawUrl
      try {
        const u = new URL(rawUrl)
        return override.replace(/\/+$/, '') + u.pathname + u.search
      } catch {
        return rawUrl
      }
    }

    const results = await Promise.all(
      endpoints.map((ep) =>
        callEndpoint({
          key: ep.key,
          label: urlOf(ep.url),
          url: urlOf(ep.url),
          required: ep.required === true,
          headers: { accept: 'application/json', cookie: session.cookie },
          timeoutMs,
          proxy,
          raws
        })
      )
    )

    // 401/403 = 登录态失效。这是**会话层**的事实，先落库再报错
    const expired = results.find((r) => r.status === 401 || r.status === 403)
    if (expired) {
      await markSessionResult(account.id, false, 'session_expired').catch(() => undefined)
      const fromSnapshot = parseSnapshot(`会话已失效（HTTP ${expired.status}）`)
      if (fromSnapshot) return fromSnapshot
      return fail(
        `网页会话已失效，请重新粘贴 Cookie（${expired.label} 返回 HTTP ${expired.status}）`,
        raws
      )
    }

    for (const r of results) {
      if (r.body !== null) {
        responses[r.key] = r.body
        continue
      }
      if (r.required) {
        await markSessionResult(account.id, false, r.error ?? 'failed').catch(() => undefined)
        const fromSnapshot = parseSnapshot(`${r.label} 拉取失败`)
        if (fromSnapshot) return fromSnapshot
        return fail(`${r.label} 拉取失败：${r.error}`, raws)
      }
      warnings.push(`${r.label} 拉取失败：${r.error}`)
    }

    /*
     * 第二轮：有些用量接口要先拿到 id 才能调（OpenDesign 的
     * 「工作区 id → 该工作区的 coding-plan-usage」就是这种）。
     * 依赖不存在就跳过，不影响第一轮已经拿到的数据。
     */
    const followEndpoints = adapter.followUps ? adapter.followUps(responses) : []
    if (followEndpoints.length > 0) {
      const followResults = await Promise.all(
        followEndpoints.map((ep) =>
          callEndpoint({
            key: ep.key,
            label: urlOf(ep.url),
            url: urlOf(ep.url),
            required: ep.required === true,
            headers: {
              accept: 'application/json',
              cookie: session.cookie,
              ...(ep.headers ?? {})
            },
            timeoutMs,
            proxy,
            raws
          })
        )
      )
      for (const r of followResults) {
        if (r.body !== null) {
          responses[r.key] = r.body
          continue
        }
        if (r.required) {
          const fromSnapshot = parseSnapshot(`${r.label} 拉取失败`)
          if (fromSnapshot) return fromSnapshot
          return fail(`${r.label} 拉取失败：${r.error}`, raws)
        }
        warnings.push(`${r.label} 拉取失败：${r.error}`)
      }
    }

    try {
      const parsed = adapter.parse(responses)
      await markSessionResult(account.id, true).catch(() => undefined)
      return {
        accountId: account.id,
        accountName: account.name,
        adapter: adapter.id,
        ok: true,
        warnings: [...(parsed.warnings ?? []), ...warnings],
        balances: parsed.balances ?? [],
        windows: parsed.windows ?? [],
        period: parsed.period,
        plan: parsed.plan,
        raw: raws
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 解析失败不等于会话失效 —— 但这轮确实没读到数据，如实记下
      await markSessionResult(account.id, false, msg).catch(() => undefined)
      return fail(msg, raws)
    }
  }

  // ---------------------------------------------------------------- 纯 HTTP
  const apiKey = tryDecryptKey(account.key_cipher)
  if (apiKey === null) return fail('账户密钥无法解密，请重新填写')

  // 并行拉取：各端点相互独立，串行会白白等好几倍时间
  const results = await Promise.all(
    adapter.endpoints.map(async (ep) => {
      const headers: Record<string, string> = { accept: 'application/json' }
      if (adapter.auth === 'bearer' && apiKey) headers.authorization = `Bearer ${apiKey}`
      if (adapter.auth === 'x-api-key' && apiKey) headers['x-api-key'] = apiKey
      return callEndpoint({
        key: ep.key,
        label: ep.path,
        url: endpointUrl(ch.base_url, ep.path, account.usage_url || ch.usage_url, adapter.baseMode),
        required: ep.required === true,
        headers,
        timeoutMs,
        proxy,
        raws
      })
    })
  )

  for (const r of results) {
    if (r.body !== null) {
      responses[r.key] = r.body
      continue
    }
    if (r.required) return fail(`${r.label} 拉取失败：${r.error}`, raws)
    warnings.push(`${r.label} 拉取失败：${r.error}`)
  }

  try {
    const parsed = adapter.parse(responses)
    return {
      accountId: account.id,
      accountName: account.name,
      adapter: adapter.id,
      ok: true,
      warnings: [...(parsed.warnings ?? []), ...warnings],
      balances: parsed.balances ?? [],
      windows: parsed.windows ?? [],
      period: parsed.period,
      plan: parsed.plan,
      raw: raws
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), raws)
  }
}

/**
 * 打该渠道的**所有账户**并聚合成一份渠道级快照。
 *
 * 单个账户失败不影响其它账户：它只是在明细里标 `ok:false`，
 * 顶层聚合只统计成功的那些。
 */
async function fetchSnapshot(ch: ChannelRow, adapter: UsageAdapter): Promise<UsageSnapshot> {
  const accounts = await listAccounts(ch.id)
  if (accounts.length === 0) return errorSnapshot(ch, '该渠道没有上游账户')

  const proxy = await getProxyTarget(ch.proxy_id)
  const parts = await Promise.all(accounts.map((a) => fetchAccountSnapshot(ch, a, proxy)))

  const okParts = parts.filter((p) => p.ok)
  const agg = aggregateAccountSnapshots(okParts)

  // 额度轮转：把"耗尽"标记写回账户。失败不影响快照返回。
  //
  // 同时写两个标记：
  //   quota_exhausted —— 按渠道口径（balance / quota）判定，驱动「耗尽轮转」
  //   window_exhausted —— **硬事实**：任意窗口打满。与口径无关，
  //                       驱动设置项 `skipExhaustedWindows`（打满就不路由）
  await Promise.all(
    parts
      .filter((p) => p.ok)
      .flatMap((p) => [
        setAccountQuotaExhausted(
          p.accountId,
          isAccountExhausted(p, ch.limit_priority ?? 'balance')
        ).catch(() => undefined),
        setAccountWindowExhausted(p.accountId, hasExhaustedWindow(p)).catch(() => undefined)
      ])
  )

  const raw: Record<string, unknown> = {}
  for (const p of parts) raw[p.accountName] = p.raw ?? null

  // 去重：同一个厂商的多个账户会报同样的提醒（如「limited=true」），
  // 三份一模一样的文字堆在页面上只是噪音
  const warnings = [...new Set(parts.flatMap((p) => (p.ok ? p.warnings : [])))]
  const errors = parts.filter((p) => !p.ok).map((p) => `${p.accountName}：${p.error ?? '未知错误'}`)

  return {
    channelId: ch.id,
    channelName: ch.name,
    adapter: adapter.id,
    ok: okParts.length > 0,
    error: okParts.length === 0 ? errors.join('；') : undefined,
    fetchedAt: new Date().toISOString(),
    cached: false,
    warnings: okParts.length > 0 && errors.length > 0 ? [...warnings, ...errors] : warnings,
    balances: agg.balances,
    windows: agg.windows,
    period: agg.period,
    plan: agg.plan,
    accounts: parts,
    raw
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
        windows: [],
        accounts: []
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

/**
 * 已配置余额适配器的渠道清单（id + 名称 + 适配器）。
 *
 * 给「余额用量」页做**逐项骨架**用：面板要先把卡片壳子画出来（每个渠道一张），
 * 再各自去取数据 —— 这样快的一回来就能显示，不必等最慢的那个。
 * 只查本地表，不碰上游，毫秒级。
 */
export async function listUsageChannels(): Promise<
  Array<{ channelId: string; channelName: string; adapter: string }>
> {
  const rows = await query<{ id: string; name: string; usage_adapter: string }>(
    `select id, name, usage_adapter from channels
      where usage_adapter <> ''
      order by name asc`
  )
  return rows.map((r) => ({
    channelId: r.id,
    channelName: r.name,
    adapter: r.usage_adapter
  }))
}
