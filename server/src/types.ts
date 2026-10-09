/** 数据库行类型与对外 DTO */

export interface UserRow {
  id: string
  username: string
  display_name: string
  password_hash: string
  role: 'admin' | 'operator'
  status: 'active' | 'disabled'
  created_at: string
  updated_at: string
  last_login_at: string | null
}

export interface ChannelRow {
  id: string
  name: string
  provider: string
  /** 协议：首批仅 'openai' */
  protocol: string
  /** 厂商兼容档位：'generic' | 'opencode-go' */
  vendor: string
  base_url: string
  api_key_cipher: string
  /** 用户自定义固定请求头（明文保存，见 D-016） */
  extra_headers: Record<string, string>
  /** 模型列表 API 的路径，默认 /models（OpenAI 协议约定） */
  models_path: string
  /** 模型元信息（上下文长度等），键为模型 id */
  models_meta: Record<string, unknown>
  models: string[]
  priority: number
  weight: number
  timeout_ms: number
  status: 'active' | 'disabled'
  note: string
  last_latency_ms: number | null
  last_test_at: string | null
  last_test_ok: boolean | null
  created_at: string
  updated_at: string
}

export interface ApiKeyRow {
  id: string
  name: string
  key_prefix: string
  key_hash: string
  /** 可解密副本；空字符串表示该 Key 不可查看（创建于旧版本） */
  key_cipher: string
  user_id: string | null
  channel_id: string | null
  model_allow: string[]
  rpm_limit: number
  quota_tokens: string | number
  used_tokens: string | number
  status: 'active' | 'disabled'
  expires_at: string | null
  last_used_at: string | null
  created_at: string
  /** 仅 list 查询带出（join users） */
  owner_name?: string | null
}

export interface ModelRouteRow {
  id: string
  alias: string
  channel_id: string
  upstream_model: string
  priority: number
  weight: number
  status: 'active' | 'disabled'
  note: string
  created_at: string
  updated_at: string
  /** 仅 join 查询带出 */
  channel_name?: string | null
  channel_status?: string | null
}

export interface AuditEventRow {
  id: string
  ts: string
  actor_user_id: string | null
  actor_username: string
  action: string
  target_type: string
  target_id: string
  detail: Record<string, unknown>
  client_ip: string
}

export interface RequestLogRow {
  id: string
  ts: string
  api_key_id: string | null
  api_key_name: string
  channel_id: string | null
  channel_name: string
  model: string
  upstream_model: string
  path: string
  status_code: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  estimated: boolean
  latency_ms: number
  ttft_ms: number | null
  client_ip: string
  error: string
}

/** 模型映射对外表示 */
export function toModelRouteDto(r: ModelRouteRow) {
  return {
    id: r.id,
    alias: r.alias,
    channelId: r.channel_id,
    channelName: r.channel_name ?? null,
    channelStatus: r.channel_status ?? null,
    upstreamModel: r.upstream_model,
    priority: r.priority,
    weight: r.weight,
    status: r.status,
    note: r.note,
    createdAt: r.created_at
  }
}

/** 用户对外表示：绝不包含 password_hash */
export function toUserDto(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    status: u.status,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at
  }
}

/** 渠道对外表示：绝不包含上游密钥明文，只给掩码 */
export function toChannelDto(ch: ChannelRow, maskedKey: string) {
  return {
    id: ch.id,
    name: ch.name,
    provider: ch.provider,
    protocol: ch.protocol,
    vendor: ch.vendor,
    extraHeaders: ch.extra_headers ?? {},
    modelsPath: ch.models_path ?? '/models',
    modelsMeta: ch.models_meta ?? {},
    baseUrl: ch.base_url,
    apiKeyMasked: maskedKey,
    hasApiKey: Boolean(ch.api_key_cipher),
    models: ch.models,
    priority: ch.priority,
    weight: ch.weight,
    timeoutMs: ch.timeout_ms,
    status: ch.status,
    note: ch.note,
    lastLatencyMs: ch.last_latency_ms,
    lastTestAt: ch.last_test_at,
    lastTestOk: ch.last_test_ok,
    createdAt: ch.created_at
  }
}

/**
 * 密钥对外表示：只有前缀，**绝不包含 key_hash 与 key_cipher**。
 * revealable 只表示「是否存有可解密副本」，不泄漏任何密钥内容。
 */
export function toApiKeyDto(k: ApiKeyRow) {
  return {
    id: k.id,
    name: k.name,
    keyPrefix: k.key_prefix,
    revealable: Boolean(k.key_cipher),
    userId: k.user_id,
    ownerName: k.owner_name ?? null,
    channelId: k.channel_id,
    modelAllow: k.model_allow,
    rpmLimit: k.rpm_limit,
    quotaTokens: Number(k.quota_tokens),
    usedTokens: Number(k.used_tokens),
    status: k.status,
    expiresAt: k.expires_at,
    lastUsedAt: k.last_used_at,
    createdAt: k.created_at
  }
}
