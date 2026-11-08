import { Hono } from 'hono'
import { z } from 'zod'
import { query } from '../db.js'
import { parseQuery } from '../lib/http.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import {
  accountLiveState,
  shareOf,
  summarizeAccountStates,
  type LiveAccount
} from '../services/lbLive.js'
import { channelInFlight } from '../services/concurrency.js'
import { getRoutingSettings } from '../services/routingSettings.js'
import type { ChannelAccountRow } from '../types.js'

export const lbRoutes = new Hono()

// 「负载均衡实况」属于管理面：操作员/客户都不该看到上游渠道与账户信息。
lbRoutes.use('*', requireAuth)
lbRoutes.use('*', requireAdmin)

const liveQuery = z.object({
  // 窗口长度（分钟）：默认 15，最大 24 小时 —— 再长就该去看统计页而不是「实况」
  minutes: z.coerce.number().int().min(1).max(1440).default(15),
  alias: z.string().trim().max(200).optional()
})

const eventsQuery = z.object({
  minutes: z.coerce.number().int().min(1).max(1440).default(60),
  alias: z.string().trim().max(200).optional(),
  // 故障转移记录页一次最多 500 条
  limit: z.coerce.number().int().min(1).max(500).default(200)
})

interface AliasTrafficRow {
  alias: string
  channel_id: string | null
  account_id: string | null
  requests: number
  errors: number
  avg_latency: number
}

interface TargetRow {
  alias: string
  channel_id: string
  channel_name: string
  upstream_model: string
  priority: number
  weight: number
  /** 渠道并发上限：0 = 不限制 */
  max_concurrency: number
}

interface AccountRowWithChannel extends ChannelAccountRow {
  channel_name: string
}

interface EventRow {
  ts: Date | string
  alias: string
  channel_name: string
  account_name: string
  prev_account_name: string
  attempt: number
  outcome: string
  status_code: number | null
  reason: string
  latency_ms: number | null
}

function statKey(alias: string, channelId: string, accountId: string): string {
  return alias + '\u0000' + channelId + '\u0000' + accountId
}

function toEventDto(row: EventRow): Record<string, unknown> {
  return {
    ts: new Date(row.ts).toISOString(),
    alias: row.alias,
    channelName: row.channel_name,
    accountName: row.account_name,
    prevAccountName: row.prev_account_name,
    attempt: row.attempt,
    outcome: row.outcome,
    statusCode: row.status_code,
    reason: row.reason,
    latencyMs: row.latency_ms
  }
}

const EVENT_COLUMNS = `
  ts, alias, channel_name, account_name, prev_account_name,
  attempt, outcome, status_code, reason, latency_ms`

lbRoutes.get('/live', async (c) => {
  const q = parseQuery(c, liveQuery)
  const minutes = q.minutes
  const aliasFilter = q.alias?.trim() || null
  const generatedAt = new Date().toISOString()

  /*
   * ① 确定要展示的别名集合。
   *
   * 不传 alias：按窗口内请求数降序取前 20 个**有映射**的别名 —— 直连渠道的
   * 原始模型名不属于负载均衡，混进来会让页面出现没有 targets 的空条目。
   * 传 alias：即使窗口内没有请求也返回该别名（刚建好映射时页面不至于空白）。
   */
  let aliasNames: string[] = []
  if (aliasFilter) {
    aliasNames = [aliasFilter]
  } else {
    const rows = await query<{ alias: string; requests: number }>(
      `select l.model as alias, count(*)::int as requests
         from request_logs l
        where l.ts >= now() - make_interval(mins => $1)
          and l.model <> ''
          and exists (
            select 1 from model_routes r
             where r.alias = l.model and r.status = 'active'
          )
        group by l.model
        order by count(*) desc, l.model asc
        limit 20`,
      [minutes]
    )
    aliasNames = rows.map((row) => row.alias)
  }

  /*
   * ② 请求量按 (alias, channel, account) 聚合。
   *
   * alias 总量包含 channel_id / account_id 为空的早退日志（限流、无渠道等），
   * 而账户明细只取有归属的行 —— share 的分母因此是**该别名窗口内的全部请求**。
   */
  const aliasTotals = new Map<string, number>()
  const aliasErrors = new Map<string, number>()
  const accountStats = new Map<string, AliasTrafficRow>()

  if (aliasNames.length > 0) {
    const rows = await query<AliasTrafficRow>(
      `select model as alias,
              channel_id,
              account_id,
              count(*)::int as requests,
              count(*) filter (where status_code >= 400)::int as errors,
              coalesce(avg(latency_ms), 0)::float as avg_latency
         from request_logs
        where ts >= now() - make_interval(mins => $1)
          and model = any($2::text[])
        group by model, channel_id, account_id`,
      [minutes, aliasNames]
    )
    for (const row of rows) {
      const requests = Number(row.requests)
      const errors = Number(row.errors)
      aliasTotals.set(row.alias, (aliasTotals.get(row.alias) ?? 0) + requests)
      aliasErrors.set(row.alias, (aliasErrors.get(row.alias) ?? 0) + errors)
      if (row.channel_id && row.account_id) {
        accountStats.set(statKey(row.alias, row.channel_id, row.account_id), row)
      }
    }
  }

  // ③ 映射目标（只取启用中的目标与渠道，与真实选路口径一致）
  const targetsByAlias = new Map<string, TargetRow[]>()
  if (aliasNames.length > 0) {
    const rows = await query<TargetRow>(
      `select r.alias,
              r.channel_id,
              c.name as channel_name,
              c.max_concurrency,
              r.upstream_model,
              r.priority,
              r.weight
         from model_routes r
         join channels c on c.id = r.channel_id
        where r.alias = any($1::text[])
          and r.status = 'active'
          and c.status = 'active'
        order by r.alias asc, r.priority asc, c.name asc, r.upstream_model asc`,
      [aliasNames]
    )
    for (const row of rows) {
      const list = targetsByAlias.get(row.alias)
      if (list) list.push(row)
      else targetsByAlias.set(row.alias, [row])
    }
  }

  // ④ 目标渠道下的账户（停用账户不参与选路，也不在实况里占份额）
  const channelIds = [...new Set([...targetsByAlias.values()].flat().map((t) => t.channel_id))]
  const accounts: AccountRowWithChannel[] = []
  if (channelIds.length > 0) {
    accounts.push(
      ...(await query<AccountRowWithChannel>(
        `select a.*, c.name as channel_name
           from channel_accounts a
           join channels c on c.id = a.channel_id
          where a.channel_id = any($1::uuid[])
            and a.status = 'active'
          order by a.channel_id asc, a.priority asc, a.name asc, a.created_at asc`,
        [channelIds]
      ))
    )
  }

  /*
   * ④-b 各渠道的当前在途数（并发闸门的实时占用）。
   *
   * 一次读全部相关渠道，而不是每个 target 读一次：面板会同时展示多个别名/渠道，
   * 逐个读会把一次页面刷新放大成几十次 Redis 往返。
   */
  const inFlightByChannel = new Map<string, number>()
  if (channelIds.length > 0) {
    const values = await Promise.all(channelIds.map((id) => channelInFlight(id)))
    channelIds.forEach((id, i) => inFlightByChannel.set(id, values[i] ?? 0))
  }

  const routing = await getRoutingSettings()
  const now = Date.now()
  const statesForSummary: Array<{ id: string; state: ReturnType<typeof accountLiveState>['state'] }> = []

  const aliasEntries = aliasNames.map((alias) => {
    const targets = targetsByAlias.get(alias) ?? []
    const aliasChannelIds = new Set(targets.map((t) => t.channel_id))
    const aliasTotal = aliasTotals.get(alias) ?? 0
    const seenAccounts = new Set<string>()

    const accountDtos = []
    for (const account of accounts) {
      if (!aliasChannelIds.has(account.channel_id)) continue
      if (seenAccounts.has(account.id)) continue
      seenAccounts.add(account.id)

      const live = accountLiveState(
        account as LiveAccount,
        now,
        routing.skipExhaustedWindows
      )
      statesForSummary.push({ id: account.id, state: live.state })

      const stat = accountStats.get(statKey(alias, account.channel_id, account.id))
      const requests = stat ? Number(stat.requests) : 0
      const errors = stat ? Number(stat.errors) : 0
      accountDtos.push({
        channelId: account.channel_id,
        channelName: account.channel_name,
        accountId: account.id,
        accountName: account.name,
        priority: account.priority,
        weight: account.weight,
        state: live.state,
        coolingUntil: live.coolingUntil,
        quotaCooldownLevel: account.quota_cooldown_level,
        windowExhausted: account.window_exhausted === true,
        quotaExhausted: account.quota_exhausted === true,
        requests,
        errors,
        share: shareOf(requests, aliasTotal),
        avgLatencyMs: Math.round(Number(stat?.avg_latency ?? 0))
      })
    }

    return {
      alias,
      targets: targets.map((t) => ({
        channelId: t.channel_id,
        channelName: t.channel_name,
        upstreamModel: t.upstream_model,
        priority: t.priority,
        weight: t.weight,
        // 并发闸门：面板显示「在途 / 上限」，满载时能一眼看出排队原因
        maxConcurrency: t.max_concurrency ?? 0,
        inFlight: inFlightByChannel.get(t.channel_id) ?? 0
      })),
      accounts: accountDtos
    }
  })

  // ⑤ 事件与计数（窗口内；alias 过滤只在显式传参时生效）
  let failovers = 0
  let quotaCooldowns = 0
  let events: Record<string, unknown>[] = []
  if (aliasNames.length > 0) {
    const counts = await query<{ failovers: number; quota_cooldowns: number }>(
      `select count(*) filter (where outcome = 'failover_success')::int as failovers,
              count(*) filter (where outcome = 'quota_cooldown')::int as quota_cooldowns
         from lb_events
        where ts >= now() - make_interval(mins => $1)
          and alias = any($2::text[])`,
      [minutes, aliasNames]
    )
    failovers = Number(counts[0]?.failovers ?? 0)
    quotaCooldowns = Number(counts[0]?.quota_cooldowns ?? 0)

    const rows = await query<EventRow>(
      `select ${EVENT_COLUMNS}
         from lb_events
        where ts >= now() - make_interval(mins => $1)
          and alias = any($2::text[])
        order by ts desc, id desc
        limit 100`,
      [minutes, aliasNames]
    )
    events = rows.map(toEventDto)
  }

  let requests = 0
  let errors = 0
  for (const alias of aliasNames) {
    requests += aliasTotals.get(alias) ?? 0
    errors += aliasErrors.get(alias) ?? 0
  }

  const { coolingAccounts, activeAccounts } = summarizeAccountStates(statesForSummary)

  return c.json({
    windowMinutes: minutes,
    generatedAt,
    totals: {
      requests,
      errors,
      failovers,
      quotaCooldowns,
      coolingAccounts,
      activeAccounts
    },
    aliases: aliasEntries,
    events
  })
})

lbRoutes.get('/events', async (c) => {
  const q = parseQuery(c, eventsQuery)
  const alias = q.alias?.trim() || null

  const rows = await query<EventRow>(
    `select ${EVENT_COLUMNS}
       from lb_events
      where ts >= now() - make_interval(mins => $1)
        and ($2::text is null or alias = $2)
      order by ts desc, id desc
      limit $3`,
    [q.minutes, alias, q.limit]
  )

  return c.json({ events: rows.map(toEventDto) })
})
