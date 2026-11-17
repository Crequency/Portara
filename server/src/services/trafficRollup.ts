/**
 * 全时段累计 token 的**定时汇总**。
 *
 * 背景：概览页的「总计」原先每次请求都 `sum(total_tokens)` 全表扫一遍。
 * 表小的时候无所谓，但请求日志只增不减（受保留期约束），概览页又会自动刷新 ——
 * 把固定成本从「每次请求」挪到「每小时一次」是显而易见的正收益。
 *
 * 设计取舍：
 *   ① **全量重建而非增量累加**：增量要维护水位线（记录已汇总到哪一条），
 *      而 `request_logs` 的时间戳会因事务提交顺序局部乱序、保留期清理还会删旧行 ——
 *      水位线一旦对不上就是静默错账。全量重建一小时一次，简单且永远自洽。
 *   ② **按 scope 分行**：'global' + 'user:<uuid>'。管理员看全网关，
 *      非管理员只看自己名下，一次算完、查询取一行。
 *   ③ **失败不致命**：汇总只是加速手段，出错只 warn；查询侧会回退实时统计。
 */
import { pool, query } from '../db.js'

/** 汇总周期（毫秒）：默认 1 小时，可用环境变量覆盖 */
export function rollupIntervalMs(raw: string | undefined): number {
  const n = Number(raw)
  // 下限 60s：避免误配成 0 导致每个 tick 都在全表扫
  if (!Number.isFinite(n) || n <= 0) return 60 * 60 * 1000
  return Math.max(60_000, Math.round(n) * 1000)
}

/** 管理员：全网关累计 */
export const GLOBAL_SCOPE = 'global'

/** 非管理员：某个用户名下的累计 */
export function userScope(userId: string): string {
  return 'user:' + userId
}

export interface RollupRow {
  scope: string
  total_tokens: number
  updated_at: string
}

/**
 * 全量重建汇总表（事务内 delete + insert）。
 *
 * 事务很重要：读侧在事务提交前看不到中间态，不会出现「删完还没插完」的空窗。
 * delete 只删本表维护的 scope，不碰别的数据。
 */
export async function refreshTrafficRollups(): Promise<{ scopes: number; totalTokens: number }> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query('delete from traffic_rollups')

    const inserted = await client.query<{ scope: string; total: string }>(
      `insert into traffic_rollups (scope, total_tokens, updated_at)
       select 'global', coalesce(sum(total_tokens), 0), now()
         from request_logs
       union all
       select 'user:' || k.user_id, coalesce(sum(r.total_tokens), 0), now()
         from request_logs r
         join api_keys k on k.id = r.api_key_id
        where k.user_id is not null
        group by k.user_id
       returning scope, total_tokens::text as total`
    )
    await client.query('commit')
    const totalTokens = inserted.rows
      .filter((r) => r.scope === GLOBAL_SCOPE)
      .reduce((sum, r) => sum + Number(r.total), 0)
    return { scopes: inserted.rowCount ?? inserted.rows.length, totalTokens }
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * 读汇总值；未命中返回 null（调用方据此回退实时统计）。
 *
 * 不回退写库 —— 写库交给定时任务，避免请求路径上做重活，
 * 也避免并发请求同时重建汇总表。
 */
export async function readRollupTokens(scope: string): Promise<number | null> {
  const rows = await query<{ total_tokens: string }>(
    'select total_tokens::text as total_tokens from traffic_rollups where scope = $1',
    [scope]
  )
  const raw = rows[0]?.total_tokens
  if (raw === undefined) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** 实时统计（回退路径）：与汇总口径一致，都取 total_tokens */
export async function sumTokensLive(userId: string | null): Promise<number> {
  const rows = await query<{ tokens: string }>(
    `select coalesce(sum(total_tokens), 0)::text as tokens
       from request_logs
      where ($1::uuid is null or api_key_id in (
              select id from api_keys where user_id = $1
            ))`,
    [userId]
  )
  const n = Number(rows[0]?.tokens ?? 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * 取「全时段累计 token」。
 *
 * @param userId 非空 = 只看该用户（非管理员）；null = 全网关（管理员）
 */
export async function getAllTimeTokens(userId: string | null): Promise<number> {
  const scope = userId === null ? GLOBAL_SCOPE : userScope(userId)
  try {
    const rolled = await readRollupTokens(scope)
    if (rolled !== null) return rolled
  } catch {
    /* 汇总表不可用（如迁移未跑）：走下面的实时回退 */
  }
  return sumTokensLive(userId)
}
