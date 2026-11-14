/**
 * 网关错误码与默认中文消息。
 *
 * **纪律（见 AGENTS.md）**：后端返回给调用方的错误必须带 `code`，
 * 文案由前端按 code 查 i18n（`web/src/i18n/*.ts` 的 `errors` 命名空间）。
 * 这里的默认消息只用于：① 服务端日志 ② 前端拿不到对应 i18n key 时的兜底。
 *
 * 新增错误时：在 ERROR_MESSAGES 里加一条，并同步七个语言文件的 errors.<code>。
 */

export const ERROR_MESSAGES = {
  proxy_has_no_password: '该代理没有设置密码',
  invalid_settings: '设置有误',
  cookie_text_empty: 'Cookie 不能为空',
  cookie_text_too_long: 'Cookie 太长（{length} 字符，上限 {max}）',
  cookie_entry_not_pair: 'Cookie 条目不是 name=value 形式：{entry}',
  cookie_name_invalid: 'Cookie 名不合法：{name}',
  cookie_value_empty: 'Cookie 条目「{name}」的值为空',
  session_token_reuse: '检测到会话令牌被重复使用，出于安全已终止该会话，请重新登录',
  bad_request: '请求无效',
  invalid_model_id: '模型 ID 非法：{model}',
  provider_must_be_channel_uuid: 'provider 必须是渠道 id（uuid），收到「{provider}」',
  max_accounts_per_channel: '每个渠道最多 {count} 个账户',
  unsupported_vendor_preset: '不支持的厂商兼容选项：{vendor}',
  model_base_url_must_be_http: '模型「{model}」的 Base URL 必须以 http:// 或 https:// 开头',
  account_no_secret: "该账户没有配置密钥",
  account_not_found: "账户不存在",
  account_not_found_named: '账户不存在：{name}',
  admin_required: "需要管理员权限",
  alias_rate_not_found: "别名费率不存在",
  all_selected_accounts_failed: "所选账户全部失败：{detail}",
  api_key_disabled: "API Key 已被禁用",
  api_key_expired: "API Key 已过期",
  api_key_invalid: "API Key 无效",
  api_key_missing: "缺少 API Key：请在 Authorization 头使用 Bearer sk-portara-…",
  api_key_no_owner: "该 Key 无归属用户，请联系管理员重新签发",
  api_key_owner_deleted: "API Key 的所属用户已被删除",
  api_key_owner_disabled: "API Key 的所属用户已被禁用",
  api_key_required: "需要 API Key",
  builtin_free_plan_missing: "内置 Free 套餐不存在或已停用，请先执行迁移 024",
  builtin_plan_undeletable: "内置套餐不允许删除",
  cannot_delete_self: "不能删除当前登录的账号",
  cannot_disable_self: "不能禁用当前登录的账号",
  channel_name_taken: "渠道名称已存在",
  channel_no_accounts: "该渠道还没有配置任何上游账户",
  channel_no_secret: "该渠道没有配置上游密钥",
  channel_not_found: "渠道不存在",
  channel_referenced_missing: "指定的渠道不存在",
  channel_secret_undecryptable: "该渠道的密钥无法解密，请重新填写",
  cookie_or_curl_required: "请粘贴 Cookie、cURL 命令，或控制台脚本输出的快照 JSON",
  current_password_wrong: "当前密码不正确",
  custom_range_requires_bounds: "自定义范围需要合法的 from 与 to 时间",
  direct_test_disabled: "系统设置中已关闭「允许直连上游测试」，如需使用请在系统设置里打开",
  duplicate_mapping_target: "存在重复的映射目标",
  empty_mapping_json: "JSON 里没有任何映射",
  fallback_account: "备用账户",
  forbidden: "无权限",
  internal_error: "网关内部错误",
  invalid_credentials: "用户名或密码错误",
  invalid_extra_headers: "固定请求头有问题",
  invalid_format: "格式错误",
  invalid_id: "非法 ID",
  invalid_json_body: "请求体不是合法 JSON",
  invalid_mapping_json: "JSON 结构有问题",
  invalid_model_override: "模型覆盖配置有问题",
  invalid_params: "参数校验失败",
  invalid_query_params: "查询参数校验失败",
  invalid_status_filter: "status 只能是 pending / approved / rejected / all",
  invalid_template_ids: "存在无效的模板 id",
  invalid_time_range: "from 必须早于 to",
  key_channel_not_visible: "该密钥不在这个渠道的可见范围内",
  key_no_refresh_permission: "该密钥没有强制刷新余额的权限",
  key_no_usage_permission: "该密钥没有读取余额的权限，请在管理面板的「API 密钥」中开启",
  key_not_found: "密钥不存在",
  key_not_revealable: "该密钥创建于启用「可查看」之前，服务端只保留哈希，无法找回。请使用轮换生成新密钥。",
  key_scope_forbidden: "只能操作自己名下的密钥",
  last_account_undeletable: "这是该渠道唯一的账户，不能删除（可先新建一个再删这个）",
  last_admin_required: "系统必须保留至少一个启用状态的管理员",
  lb_rule_alias_missing: "该别名在负载均衡规则里不存在",
  login_required: "请先登录",
  mapping_channel_missing: "引用了不存在的渠道",
  mapping_not_found: "映射不存在",
  mapping_replace_needs_ack: "替换全部会删除现有 {count} 条映射。请在请求中带上 acknowledgeRemove={count} 确认。",
  model_id_unmapped: "该模型 id 没有任何映射",
  model_not_allowed: "模型 {model} 不在允许列表",
  no_refresh_token: "没有可用的刷新令牌，请重新登录",
  not_found: "资源不存在",
  plan_name_taken: "套餐名已存在",
  plan_not_found: "套餐不存在",
  plan_or_adjust_required: "至少提供 planId 或 adjust",
  plan_referenced_missing: "指定的套餐不存在",
  proxy_missing_or_disabled: "代理不存在或已停用",
  proxy_name_taken: "代理名称「{name}」已存在",
  proxy_not_found: "代理不存在",
  rate_limit_admin_only: "速率限制与 Token 配额只能由管理员设置",
  registration_already_handled: "该申请已被处理",
  registration_not_found: "注册申请不存在",
  registration_pending: "该用户名已有待审批的注册申请",
  registration_rate_limited: "注册申请提交过于频繁，请稍后再试",
  request_failed: "请求失败",
  secret_decrypt_failed: "密钥解密失败：主密钥可能已变更（PORTARA_MASTER_KEY）",
  session_expired: "会话无效或已过期",
  session_invalid: "会话无效",
  template_name_taken: "模板名已存在",
  template_not_found: "模板不存在",
  template_owner_missing: "指定模板归属的用户不存在",
  template_scope_forbidden: "只能套用自己的模板或全局模板",
  unauthorized: "未认证",
  unknown_endpoint: "未知端点：{path}",
  unknown_usage_adapter: "未知的余额适配器「{adapter}」",
  upstream_empty_stream: "上游返回了空的流式响应",
  upstream_unreachable: "上游不可达",
  usage_permission_admin_only: "余额/用量读取权限只能由管理员设置",
  user_disabled: "账号已被禁用",
  user_name_exists: "用户名已存在",
  user_not_found: "用户不存在",
  user_referenced_missing: "指定的用户不存在",
  username_taken: "用户名已被占用",
} as const

export type ErrorCode = keyof typeof ERROR_MESSAGES

/** 取错误码的默认中文消息（可能含 {param} 占位） */
export function defaultMessageOf(code: ErrorCode): string {
  return ERROR_MESSAGES[code]
}

/** 用参数填充默认消息里的 {name} 占位 */
export function fillMessage(
  template: string,
  params?: Record<string, string | number>
): string {
  if (!params) return template
  return template.replace(/[{]([a-zA-Z0-9_]+)[}]/g, (whole: string, key: string) =>
    params[key] === undefined ? whole : String(params[key])
  )
}
