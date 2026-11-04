export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * 单飞：并发的 401 只触发**一次**刷新。
 * 不加这个，一个页面同时发五个请求就会打五次刷新接口 ——
 * 而刷新是**轮换**的，五次里有四次会拿到已作废的令牌。
 */
let refreshInFlight: Promise<boolean> | null = null

/** 主动续期的定时器 */
let refreshTimer: ReturnType<typeof setTimeout> | null = null

/** 会话彻底失效时的回调（由 App.vue 注册 → 回到登录页） */
let sessionExpiredHandler: (() => void) | null = null

export function setSessionExpiredHandler(fn: (() => void) | null): void {
  sessionExpiredHandler = fn
}

/** 这些路径本身不参与"401 就续期"的兜底，否则会递归 */
const AUTH_PATHS = ['/api/auth/login', '/api/auth/refresh', '/api/auth/logout']

/**
 * 在 access token 过期**之前**主动续期。
 *
 * 没有它也能工作（401 时兜底续期），但那样每隔 15 分钟就会有
 * 一个请求先失败再重试 —— 用户偶尔会看到一闪而过的错误。
 */
export function scheduleRefresh(expiresInSec: number): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  // 提前 20% 续期，但不早于 30 秒、不晚于 2 分钟
  const lead = Math.max(30, Math.min(120, expiresInSec * 0.2))
  const delayMs = Math.max(5, expiresInSec - lead) * 1000
  refreshTimer = setTimeout(() => void ensureRefreshed(), delayMs)
}

export function cancelScheduledRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = null
}

async function doRefresh(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
    if (!res.ok) return false
    const data = (await res.json().catch(() => null)) as { expiresIn?: number } | null
    if (typeof data?.expiresIn === 'number') scheduleRefresh(data.expiresIn)
    return true
  } catch {
    return false
  }
}

/** 刷新会话；并发调用共享同一次请求 */
export function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null
    })
  }
  return refreshInFlight
}

function ensureRefreshed(): Promise<boolean> {
  return refreshSession()
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  retried = false
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })

  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }

  if (!res.ok) {
    // access token 过期（15 分钟）是**常态**，不是错误：
    // 静默续期后重试一次，调用方完全无感。
    if (res.status === 401 && !retried && !AUTH_PATHS.includes(path)) {
      if (await ensureRefreshed()) {
        return request<T>(method, path, body, true)
      }
      // 续期也失败 → 会话真的没了，交给上层回登录页
      sessionExpiredHandler?.()
    }

    const errObj = (data as { error?: { message?: string; code?: string } } | null)?.error
    throw new ApiError(
      res.status,
      errObj?.message ?? `请求失败（HTTP ${res.status}）`,
      errObj?.code
    )
  }

  // 登录 / 刷新 / 改密的响应带 expiresIn —— 顺手排下一次主动续期，
  // 调用方不用关心这件事
  const expiresIn = (data as { expiresIn?: number } | null)?.expiresIn
  if (typeof expiresIn === 'number') scheduleRefresh(expiresIn)

  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path)
}

// ------------------------------------------------------------------ 类型

/** HTTP 代理配置（密码只以掩码形式返回） */
export interface ProxyConfig {
  id: string
  name: string
  host: string
  port: number
  username: string
  hasPassword: boolean
  passwordMasked: string
  status: 'active' | 'disabled'
  note: string
  lastLatencyMs: number | null
  lastTestAt: string | null
  lastTestOk: boolean | null
  createdAt: string
  updatedAt: string
  /** 有多少渠道正在使用它 */
  channelCount: number
}

/** 余额快照（与后端 services/usage.ts 的 UsageSnapshot 对应） */
export interface UsageBalance {
  currency: string
  unit: 'currency' | 'credits'
  remaining: number
  total?: number
  granted?: number
  toppedUp?: number
}

export interface UsageWindow {
  key: string
  used: number
  total: number
  remaining: number
  resetAt?: string
  exceeded?: boolean
  /** 上限是推算出来的（上游没有这个窗口对象） */
  inferred?: boolean
}

export interface UsagePeriod {
  start?: string
  end?: string
  requests?: number
  successRate?: number
  tokensIn?: number
  tokensOut?: number
  cost?: number
  costCurrency?: string
}

export interface UsagePlan {
  id?: string
  name?: string
  status?: string
  renewAt?: string
  inferred?: boolean
}

/** 单个上游账户的余额/用量快照 */
export interface UsageAccountSnapshot {
  accountId: string
  accountName: string
  adapter: string
  ok: boolean
  error?: string
  warnings: string[]
  balances: UsageBalance[]
  windows: UsageWindow[]
  period?: UsagePeriod
  plan?: UsagePlan
  raw?: unknown
}

export interface UsageSnapshot {
  channelId: string
  channelName: string
  adapter: string
  ok: boolean
  error?: string
  fetchedAt: string
  cached: boolean
  stale?: boolean
  warnings: string[]
  balances: UsageBalance[]
  windows: UsageWindow[]
  period?: UsagePeriod
  plan?: UsagePlan
  /** 逐账户明细；顶层 balances/windows 是聚合值 */
  accounts: UsageAccountSnapshot[]
  raw?: unknown
}

export interface UsageAdapterInfo {
  id: string
  label: string
  note: string
  endpoints: string[]
}

/** 系统设置（与后端 services/settings.ts 的注册表一一对应） */
export interface GatewaySettings {
  gatewayName: string
  allowDirectChannelTest: boolean
  logRetentionDays: number
  defaultChannelTimeoutMs: number
  defaultKeyRpmLimit: number
  /** 网关时区（IANA）；无浏览器上下文时的默认口径 */
  timezone: string
  /** 余额快照缓存时长（秒）；用于避免上游限频 */
  usageCacheTtlSec: number
  /** 上游失败后的冷却时长（秒）：这段时间内不再路由到该 (渠道, 账户) */
  accountFailureCooldownSec: number
  /** 是否跳过「任意用量窗口已打满」的账户 */
  skipExhaustedWindows: boolean
}

export interface User {
  id: string
  username: string
  displayName: string
  role: 'admin' | 'operator'
  status: 'active' | 'disabled'
  createdAt: string
  lastLoginAt: string | null
}

/** 渠道下的一个上游账户（只给掩码，明文要靠 reveal 单独请求） */
export interface ChannelAccount {
  id: string
  name: string
  status: 'active' | 'disabled'
  priority: number
  weight: number
  note: string
  apiKeyMasked: string
  hasKey: boolean
  usageAdapter: string
  usageUrl: string
  /** 通用失败冷却截止时间；非空表示当前不可用 */
  cooldownUntil: string | null
  /** 上游明确返回「额度用尽」的触发次数（0 = 从未，迁移 020） */
  quotaCooldownLevel: number
  /** 额度用尽阶梯冷冻的到期时间；与 cooldownUntil 分开计时 */
  quotaCooldownUntil: string | null
  /** 用量/余额已耗尽（迁移 019 的硬事实列） */
  quotaExhausted: boolean
  quotaCheckedAt: string | null
  /** 任意用量窗口已打满；只有上游/适配器检查过才可能为 true */
  windowExhausted: boolean
  windowCheckedAt: string | null
  lastError: string
  consecutiveFailures: number
  lastUsedAt: string | null
  createdAt: string
}

export interface Channel {
  id: string
  name: string
  provider: string
  protocol: string
  vendor: string
  extraHeaders: Record<string, string>
  modelsPath: string
  modelsMeta: Record<string, ModelMeta>
  modelOverrides: Record<string, ModelOverride>
  /** 选用的 HTTP 代理；null = 直连 */
  proxyId: string | null
  /** 余额/用量适配器 id；'' = 不提供余额 */
  usageAdapter: string
  /** 余额接口 base 覆盖 */
  usageUrl: string
  /** 耗尽判定依据：balance（余额优先）| quota（用量限额优先） */
  limitPriority: 'balance' | 'quota'
  /** 只暴露映射模型：未映射的模型不出现也不受理 */
  hideUnmappedModels: boolean
  /** 该渠道的上游账户（至少一个） */
  accounts: ChannelAccount[]
  baseUrl: string
  apiKeyMasked: string
  hasApiKey: boolean
  models: string[]
  priority: number
  weight: number
  timeoutMs: number
  status: 'active' | 'disabled'
  note: string
  lastLatencyMs: number | null
  lastTestAt: string | null
  lastTestOk: boolean | null
  createdAt: string
}

/** 逐模型覆盖：协议与 Base URL */
export interface ModelOverride {
  protocol?: 'openai' | 'anthropic'
  baseUrl?: string
}

/** /models 抓取到的模型信息 */
export interface ModelInfo {
  id: string
  contextLength: number | null
  maxOutputTokens: number | null
  ownedBy: string | null
  created: number | null
  raw: Record<string, unknown>
}

/** 渠道上保存的模型元信息（与 ModelInfo 同形） */
export type ModelMeta = ModelInfo

export interface FetchModelsResult {
  ok: boolean
  status: number
  latencyMs: number
  models: ModelInfo[]
  warnings: string[]
  message: string
  /** 上游 /models 的原始响应体 */
  raw: string
  rawTruncated: boolean
}

export interface ModelRoute {
  id: string
  alias: string
  channelId: string
  channelName: string | null
  channelStatus: string | null
  upstreamModel: string
  priority: number
  weight: number
  status: 'active' | 'disabled'
  note: string
  groupKey: string
  createdAt: string
}

export interface ApiKey {
  id: string
  name: string
  keyPrefix: string
  revealable: boolean
  userId: string | null
  ownerName: string | null
  channelId: string | null
  modelAllow: string[]
  /** 能否读取余额/用量 */
  usageAllow: boolean
  /** 可见渠道范围；空 = 全部 */
  usageChannels: string[]
  /** 能否 ?refresh=1 强制刷新 */
  usageRefresh: boolean
  rpmLimit: number
  quotaTokens: number
  usedTokens: number
  status: 'active' | 'disabled'
  expiresAt: string | null
  lastUsedAt: string | null
  createdAt: string
}

export interface RequestLog {
  channelId: string | null
  accountId: string | null
  accountName: string
  id: string
  ts: string
  apiKeyName: string
  channelName: string
  model: string
  upstreamModel: string
  path: string
  statusCode: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  estimated: boolean
  source: string
  latencyMs: number
  ttftMs: number | null
  clientIp: string
  /** 会话键哈希前 8 位（会话亲和排查用）；空串 = 本次没有会话键 */
  sessionHash: string
  error: string
}

export type RangePreset = 'today' | '7d' | '30d' | '90d' | '365d' | 'custom'

export interface StatsRange {
  preset: RangePreset
  from: string
  to: string
}

export interface StatsTotals {
  requests: number
  errors: number
  errorRate: number
  tokens: number
  promptTokens: number
  completionTokens: number
  estimated: number
  diagnosticRequests: number
  avgLatencyMs: number
  p95LatencyMs: number
}

export interface StatsResources {
  users: number
  channels: number
  activeChannels: number
  keys: number
}

export interface TopEntry {
  name: string
  requests: number
  tokens: number
}

export interface StatsOverview {
  /** 本次查询实际使用的时区 */
  timezone?: string
  range: StatsRange
  totals: StatsTotals
  resources: StatsResources
  topModels: TopEntry[]
  topChannels: TopEntry[]
  topKeys: TopEntry[]
}

export interface SeriesPoint {
  day: string
  requests: number
  tokens: number
  errors: number
}

export interface StatsSeries {
  /** 本次查询实际使用的时区 */
  timezone?: string
  /**
   * 分桶粒度：按小时 / 按天 / 按周 / 按半月。
   * 90d → week，365d → halfmonth（后端按范围自动选择）。
   */
  granularity: 'hour' | 'day' | 'week' | 'halfmonth'
  range: StatsRange
  series: SeriesPoint[]
}

/** 热力图的单个格子：cells[row][col] */
export interface HeatmapCell {
  requests: number
  tokens: number
  errors: number
}

/** 年历模式顶部的月份标签：第 col 列（从 0 起）出现该月 */
export interface HeatmapMonthLabel {
  col: number
  label: string
}

/**
 * 使用频率热力图（二维矩阵）。
 *
 * 后端把一维时间桶折成「按天分列」的矩阵：同一列里是连续的若干个小桶，
 * 列数 / 行数随档位不同（today 96×15、7d 84×12、30d 90×16、90d 90×12）；
 * 365d 是 GitHub 年历（53 列 × 7 行，第一行周一）。
 * 颜色与时间换算都由前端按 cells 的行列位置推算。
 */
export interface StatsHeatmap {
  /** 本次查询实际使用的时区 */
  timezone: string
  range: StatsRange
  mode: 'grid' | 'calendar'
  cols: number
  rows: number
  /** 长度 = cols，空串表示该列不标 */
  xLabels: string[]
  /** 长度 = rows，空串表示该行不标 */
  yLabels: string[]
  /** cells[row][col]，完整 rows × cols */
  cells: HeatmapCell[][]
  /** 仅 calendar 模式 */
  monthLabels?: HeatmapMonthLabel[]
  /** 仅 calendar 模式 */
  weekdayLabels?: string[]
}

export interface ChannelTestResult {
  ok: boolean
  status: number
  latencyMs: number
  testedAt?: string
  models: string[]
  modelInfo?: ModelInfo[]
  message: string
}

export interface AuditEvent {
  id: string
  ts: string
  actor: string
  action: string
  targetType: string
  targetId: string
  detail: Record<string, unknown>
  clientIp: string
}
