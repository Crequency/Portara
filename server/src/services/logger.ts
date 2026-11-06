import { one, query } from '../db.js'

export interface LogInput {
  apiKeyId: string | null
  apiKeyName: string
  channelId: string | null
  channelName: string
  /** 实际服务的上游账户；渠道只有一个账户时也能用（便于排查是哪个号出的问题） */
  accountId?: string | null
  accountName?: string
  model: string
  /** 实际发往上游的模型 id（经映射时与 model 不同） */
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
  /** 请求来源：gateway（经网关）/ playground（对话测试页直连） */
  source: string
  /** 会话键哈希前 8 位（亲和排查用）；空串 = 无会话键 */
  sessionHash?: string
}

/**
 * 写请求日志并累加该 Key 的已用 token。
 * 返回 request_logs.id —— 计费结算要用它做幂等键（billing_charged_at）。
 * **不阻塞响应**：调用方用 fireAndForgetLog，失败只打日志。
 */
export async function writeLog(input: LogInput): Promise<string> {
  const inserted = await one<{ id: string }>(
    `insert into request_logs
       (api_key_id, api_key_name, channel_id, channel_name, account_id, account_name,
        model, upstream_model, path,
        status_code, prompt_tokens, completion_tokens, total_tokens, estimated,
        latency_ms, ttft_ms, client_ip, error, source, session_hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     returning id::text as id`,
    [
      input.apiKeyId,
      input.apiKeyName,
      input.channelId,
      input.channelName,
      input.accountId ?? null,
      input.accountName ?? '',
      input.model,
      input.upstreamModel,
      input.path,
      input.statusCode,
      input.promptTokens,
      input.completionTokens,
      input.totalTokens,
      input.estimated,
      input.latencyMs,
      input.ttftMs,
      input.clientIp,
      input.error.slice(0, 500),
      input.source,
      input.sessionHash ?? ''
    ]
  )

  if (input.apiKeyId && input.totalTokens > 0) {
    await query(
      `update api_keys
          set used_tokens = used_tokens + $1, last_used_at = now()
        where id = $2`,
      [input.totalTokens, input.apiKeyId]
    )
  } else if (input.apiKeyId) {
    await query('update api_keys set last_used_at = now() where id = $1', [input.apiKeyId])
  }

  return inserted!.id
}

/**
 * 异步写日志，可选在日志落库后执行「结算」回调（拿到 log id）。
 *
 * 结算失败只打日志、不影响已返回给客户端的响应 —— 请求已经服务完了，
 * 不能因为记账失败把它变成 500。失败痕迹留在服务端日志里，便于补账。
 */
export function fireAndForgetLog(
  input: LogInput,
  after?: (logId: string) => Promise<void>
): void {
  void (async () => {
    let logId: string
    try {
      logId = await writeLog(input)
    } catch (err: unknown) {
      console.error(
        '[portara][log] 写请求日志失败：',
        err instanceof Error ? err.message : String(err)
      )
      return
    }
    if (!after) return
    try {
      await after(logId)
    } catch (err: unknown) {
      console.error(
        '[portara][billing] 结算失败（request_log=' + logId + '）：',
        err instanceof Error ? err.message : String(err)
      )
    }
  })()
}

/** 已用 token 与配额，供配额预检使用（读库，非缓存） */
export async function loadKeyUsage(
  keyId: string
): Promise<{ usedTokens: number; quotaTokens: number } | null> {
  const row = await one<{ used_tokens: string | number; quota_tokens: string | number }>(
    'select used_tokens, quota_tokens from api_keys where id = $1',
    [keyId]
  )
  if (!row) return null
  return { usedTokens: Number(row.used_tokens), quotaTokens: Number(row.quota_tokens) }
}
