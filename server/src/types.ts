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
  base_url: string
  api_key_cipher: string
  models: string[]
  priority: number
  weight: number
  timeout_ms: number
  status: 'active' | 'disabled'
  note: string
  created_at: string
  updated_at: string
}

export interface ApiKeyRow {
  id: string
  name: string
  key_prefix: string
  key_hash: string
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
}

export interface RequestLogRow {
  id: string
  ts: string
  api_key_id: string | null
  api_key_name: string
  channel_id: string | null
  channel_name: string
  model: string
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
    baseUrl: ch.base_url,
    apiKeyMasked: maskedKey,
    hasApiKey: Boolean(ch.api_key_cipher),
    models: ch.models,
    priority: ch.priority,
    weight: ch.weight,
    timeoutMs: ch.timeout_ms,
    status: ch.status,
    note: ch.note,
    createdAt: ch.created_at
  }
}

/** 密钥对外表示：只有前缀，没有哈希、没有明文 */
export function toApiKeyDto(k: ApiKeyRow) {
  return {
    id: k.id,
    name: k.name,
    keyPrefix: k.key_prefix,
    userId: k.user_id,
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
