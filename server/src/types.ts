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

/**
 * 上游账户行（与 channel_accounts 表一一对应）。
 *
 * 账户只提供**凭据**；模型能力、协议、Base URL、模型映射都仍归渠道管。
 */
export interface ChannelAccountRow {
  id: string
  channel_id: string
  name: string
  key_cipher: string
  status: 'active' | 'disabled'
  priority: number
  weight: number
  note: string
  /** 故障转移维护的通用冷却截止时间；null = 正常 */
  cooldown_until: Date | null
  /** 上游明确返回「额度用尽」的触发次数（0 = 从未） */
  quota_cooldown_level: number
  /** 额度用尽的阶梯冷冻到期时间；与 cooldown_until 分开计时 */
  quota_cooldown_until: Date | null
  last_error: string
  last_used_at: Date | null
  consecutive_failures: number
  /** 余额/额度耗尽（余额适配器刷新时标记）；只能靠余额回升解除 */
  quota_exhausted: boolean
  quota_checked_at: Date | null
  usage_adapter: string
  usage_url: string
  created_at: Date
  updated_at: Date
  /** 任意用量窗口已打满（硬上限，与 limit_priority 无关） */
  window_exhausted: boolean
  window_checked_at: string | null
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
  /** 逐模型的协议 / Base URL 覆盖，键为模型 id */
  model_overrides: Record<string, ModelOverride>
  /** 选用的 HTTP 代理；null = 直连 */
  proxy_id: string | null
  /** 余额/用量适配器 id；'' = 不提供余额 */
  usage_adapter: string
  /** 余额接口的 base 覆盖；'' = 用 adapter 默认 */
  usage_url: string
  /** 耗尽判定的依据：balance（余额优先）| quota（用量限额优先） */
  limit_priority: 'balance' | 'quota'
  /** 只暴露映射模型：为 true 时该渠道未映射的模型既不出现在 /models，也不受理 */
  hide_unmapped_models: boolean
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
  /** 是否允许读取余额/用量 */
  usage_allow: boolean
  /** 可见渠道范围；空数组 = 全部 */
  usage_channels: string[]
  /** 是否允许 ?refresh=1 强制刷新 */
  usage_refresh: boolean
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

/** HTTP 代理配置 */
export interface ProxyRow {
  id: string
  name: string
  host: string
  port: number
  username: string
  /** AES-256-GCM 密文；绝不出现在任何 DTO 里 */
  password_cipher: string
  status: 'active' | 'disabled'
  note: string
  last_latency_ms: number | null
  last_test_at: string | null
  last_test_ok: boolean | null
  created_at: string
  updated_at: string
}

/** 代理的对外表示：只给掩码，不给密文 */
export function toProxyDto(r: ProxyRow): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    host: r.host,
    port: r.port,
    username: r.username,
    hasPassword: Boolean(r.password_cipher),
    passwordMasked: r.password_cipher ? '••••••••' : '',
    status: r.status,
    note: r.note,
    lastLatencyMs: r.last_latency_ms,
    lastTestAt: r.last_test_at,
    lastTestOk: r.last_test_ok,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

/** 逐模型覆盖：协议与 Base URL */
export interface ModelOverride {
  protocol?: 'openai' | 'anthropic'
  baseUrl?: string
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
  /** 批量映射时用的前缀；空 = 未记录（历史数据/手工创建） */
  group_key: string
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
  account_id: string | null
  account_name: string
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
  source: string
  latency_ms: number
  ttft_ms: number | null
  client_ip: string
  error: string
  /** 会话键哈希前 8 位（亲和排查用） */
  session_hash: string
  /** 计费落地（迁移 022） */
  billing_plan_id: string | null
  cost_money: string | number
  cost_currency: string
  billed_amount: string | number
  billing_unit: string
  rate_id: string | null
  /** 结算幂等标记：非空 = 已结过账 */
  billing_charged_at: string | null
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
    groupKey: r.group_key ?? '',
    createdAt: r.created_at
  }
}

/** 注册申请行（迁移 021） */
export interface RegistrationApplicationRow {
  id: string
  username: string
  display_name: string
  password_hash: string
  contact: string
  note: string
  status: 'pending' | 'approved' | 'rejected'
  reject_reason: string
  reviewed_by: string | null
  reviewed_at: string | null
  user_id: string | null
  created_at: string
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

/** 注册申请对外表示：**绝不包含 password_hash** */
export function toRegistrationDto(a: RegistrationApplicationRow) {
  return {
    id: a.id,
    username: a.username,
    displayName: a.display_name ?? '',
    contact: a.contact ?? '',
    note: a.note ?? '',
    status: a.status,
    rejectReason: a.reject_reason ?? '',
    reviewedBy: a.reviewed_by,
    reviewedAt: a.reviewed_at,
    userId: a.user_id,
    createdAt: a.created_at
  }
}

/** 渠道对外表示：绝不包含上游密钥明文，只给掩码 */
/** 账户 DTO：**只给掩码，永远不返回密文或明文** */
export function toAccountDto(a: ChannelAccountRow, maskedKey: string) {
  return {
    id: a.id,
    name: a.name,
    status: a.status,
    priority: a.priority,
    weight: a.weight,
    note: a.note ?? '',
    apiKeyMasked: maskedKey,
    hasKey: Boolean(a.key_cipher),
    usageAdapter: a.usage_adapter ?? '',
    usageUrl: a.usage_url ?? '',
    /** 冷却中：面板显示倒计时；到点后自动恢复可用 */
    cooldownUntil: a.cooldown_until ? new Date(a.cooldown_until).toISOString() : null,
    /** 额度用尽触发的阶梯冷冻：等级 + 到期时间（与 cooldownUntil 分开） */
    quotaCooldownLevel: a.quota_cooldown_level ?? 0,
    quotaCooldownUntil: a.quota_cooldown_until
      ? new Date(a.quota_cooldown_until).toISOString()
      : null,
    lastError: a.last_error ?? '',
    consecutiveFailures: a.consecutive_failures ?? 0,
    quotaExhausted: Boolean(a.quota_exhausted),
    quotaCheckedAt: a.quota_checked_at ? new Date(a.quota_checked_at).toISOString() : null,
    // 任意窗口打满（硬上限）—— 与 quotaExhausted 的口径无关，单独一列
    windowExhausted: Boolean(a.window_exhausted),
    windowCheckedAt: a.window_checked_at ? new Date(a.window_checked_at).toISOString() : null,
    lastUsedAt: a.last_used_at ? new Date(a.last_used_at).toISOString() : null,
    createdAt: new Date(a.created_at).toISOString()
  }
}

export function toChannelDto(
  ch: ChannelRow,
  maskedKey: string,
  accounts: ReturnType<typeof toAccountDto>[] = []
) {
  return {
    id: ch.id,
    name: ch.name,
    provider: ch.provider,
    protocol: ch.protocol,
    vendor: ch.vendor,
    extraHeaders: ch.extra_headers ?? {},
    modelsPath: ch.models_path ?? '/models',
    modelsMeta: ch.models_meta ?? {},
    modelOverrides: ch.model_overrides ?? {},
    proxyId: ch.proxy_id ?? null,
    usageAdapter: ch.usage_adapter ?? '',
    usageUrl: ch.usage_url ?? '',
    limitPriority: ch.limit_priority ?? 'balance',
    hideUnmappedModels: ch.hide_unmapped_models === true,
    baseUrl: ch.base_url,
    apiKeyMasked: maskedKey,
    // 有账户就按账户算（账户才是密钥的载体）；没有则回退到渠道列，兼容旧数据
    hasApiKey: accounts.length > 0 ? accounts.some((a) => a.hasKey) : Boolean(ch.api_key_cipher),
    // 账户明细：面板据此渲染列表，余额页据此分组
    accounts,
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
    usageAllow: k.usage_allow ?? false,
    usageChannels: k.usage_channels ?? [],
    usageRefresh: k.usage_refresh ?? false,
    rpmLimit: k.rpm_limit,
    quotaTokens: Number(k.quota_tokens),
    usedTokens: Number(k.used_tokens),
    status: k.status,
    expiresAt: k.expires_at,
    lastUsedAt: k.last_used_at,
    createdAt: k.created_at
  }
}
