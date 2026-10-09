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
