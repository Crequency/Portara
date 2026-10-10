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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
    const errObj = (data as { error?: { message?: string; code?: string } } | null)?.error
    throw new ApiError(
      res.status,
      errObj?.message ?? `请求失败（HTTP ${res.status}）`,
      errObj?.code
    )
  }

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

/** 系统设置（与后端 services/settings.ts 的注册表一一对应） */
export interface GatewaySettings {
  gatewayName: string
  allowDirectChannelTest: boolean
  logRetentionDays: number
  defaultChannelTimeoutMs: number
  defaultKeyRpmLimit: number
  /** 网关时区（IANA）；无浏览器上下文时的默认口径 */
  timezone: string
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
  rpmLimit: number
  quotaTokens: number
  usedTokens: number
  status: 'active' | 'disabled'
  expiresAt: string | null
  lastUsedAt: string | null
  createdAt: string
}

export interface RequestLog {
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
  error: string
}

export type RangePreset = 'today' | '7d' | '30d' | 'custom'

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
  granularity: 'hour' | 'day'
  range: StatsRange
  series: SeriesPoint[]
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
