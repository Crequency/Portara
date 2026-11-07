/**
 * 故障转移事件（lb_events）的写入路径。
 *
 * 设计约束：
 *   ① **只有失败/转移才写** —— 首击成功不产生事件，避免转发热路径写入放大；
 *   ② **写库失败只 warn** —— 事件是观测数据，绝不能让它的故障影响转发；
 *   ③ 保留期清理**顺手做**（约 1/200 次写入），不单独加定时任务。
 */
import { query } from '../db.js'

export type LbOutcome = 'attempt_failed' | 'failover_success' | 'quota_cooldown'

export interface LbEventInput {
  /** 请求级关联 id（uuid），由 /v1 在请求开始时生成 */
  requestId: string
  /** 网关受理的模型 id（别名） */
  alias: string
  /** 会话哈希前 8 位（无会话键时为空串） */
  sessionHash: string
  channelId: string | null
  channelName: string
  accountId: string | null
  accountName: string
  prevAccountId?: string | null
  prevAccountName?: string
  /** 从 1 开始的尝试序号（跨渠道累计） */
  attempt: number
  outcome: LbOutcome
  statusCode?: number | null
  reason?: string
  latencyMs?: number | null
}

/** 保留期：7 天。清理放在写入路径里，概率约 1/200。 */
const RETENTION_DAYS = 7
const PURGE_PROBABILITY = 1 / 200

async function purgeOldLbEvents(): Promise<void> {
  try {
    await query(
      `delete from lb_events where ts < now() - make_interval(days => $1)`,
      [RETENTION_DAYS]
    )
  } catch (err) {
    console.warn(
      '[portara] 故障转移事件清理失败：',
      err instanceof Error ? err.message : String(err)
    )
  }
}

/**
 * 写一条故障转移事件。
 *
 * 调用方 **await** 它以便事件顺序与请求一致（冒烟/排查都依赖这一点），
 * 但内部把所有异常吞掉：失败只 warn，返回的 Promise 永远 resolve。
 */
export async function recordLbEvent(input: LbEventInput): Promise<void> {
  try {
    await query(
      `insert into lb_events
         (request_id, alias, session_hash, channel_id, channel_name,
          account_id, account_name, prev_account_id, prev_account_name,
          attempt, outcome, status_code, reason, latency_ms)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        input.requestId,
        input.alias,
        input.sessionHash,
        input.channelId,
        input.channelName,
        input.accountId,
        input.accountName,
        input.prevAccountId ?? null,
        input.prevAccountName ?? '',
        input.attempt,
        input.outcome,
        input.statusCode ?? null,
        (input.reason ?? '').slice(0, 1000),
        input.latencyMs ?? null
      ]
    )
  } catch (err) {
    console.warn(
      '[portara] 故障转移事件写入失败：',
      err instanceof Error ? err.message : String(err)
    )
    return
  }

  // 低概率顺手清理：不为保留期单独起定时器
  if (Math.random() < PURGE_PROBABILITY) {
    await purgeOldLbEvents()
  }
}
