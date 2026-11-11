/**
 * 系统设置：注册表 + 读写。
 *
 * 设计要点：
 *   ① **注册表是唯一事实来源** —— 类型、校验、默认值都在这里。
 *      加一个设置项 = 加一行，不必写迁移（见迁移 010 的键值表）。
 *   ② **不加进程内缓存** —— 写入方与读取方可能不是同一个实例，
 *      缓存会带来「改了没生效」这种最难查的问题。这里每次读库，
 *      调用频率都很低（管理面请求、定时清理），代价可以忽略。
 *   ③ 表里没有记录 = 用代码里的默认值；因此**默认值变了不需要迁移**。
 */
import { z } from 'zod'
import { query } from '../db.js'

export interface GatewaySettings {
  /** 网关名称：显示在页面标题与左上角副标题（留空则用产品默认名） */
  gatewayName: string
  /** 是否允许「对话测试」里的上游渠道直连（关掉即禁用该诊断入口） */
  allowDirectChannelTest: boolean
  /** 请求日志保留天数；0 = 永久保留 */
  logRetentionDays: number
  /** 新建渠道时表单预填的超时（毫秒） */
  defaultChannelTimeoutMs: number
  /** 签发新密钥时预填的每分钟请求上限；0 = 不限 */
  defaultKeyRpmLimit: number
  /**
   * 网关时区（IANA 名，如 Asia/Shanghai）。
   *
   * 用途：**服务端按天聚合的默认边界** —— 统计的「今日/7天/30天」预设、
   * 趋势分桶的日界。
   *
   * 注意：**日志始终以 UTC 存储**（timestamptz），这里只影响「哪一刻算一天的开始」。
   * 面板展示时区由**浏览器**决定（前端会带上自己的时区覆盖此项），
   * 本项是无浏览器上下文的调用方（API 消费者、运维脚本）的默认值。
   */
  timezone: string
  /**
   * 余额/用量快照的缓存时长（秒）。
   *
   * 存在的意义就是**避免限频** —— 各厂商的余额接口多有频率限制，
   * 面板与 API 都不该每次都真打上游。
   */
  usageCacheTtlSec: number
  /** 网页会话型渠道的自动刷新间隔（秒）；0 = 关闭 */
  usageAutoRefreshSec: number
  /** 余额/用量查询的幂等重试次数（首次之外），0 = 关闭 */
  usageMaxRetries: number
  /** 自适应选路开关（默认关闭） */
  adaptiveRouting: boolean
  /** 自适应评分窗口（秒） */
  adaptiveWindowSec: number
  /** 参与排序所需的最小样本数 */
  adaptiveMinSamples: number
  /**
   * 上游请求失败后的冷却时长（秒）。
   *
   * 含义：**最近一次失败的那个 (渠道, 账户) 在这段时间内不再被路由到**。
   * 默认 1 小时 —— 上游的配额/鉴权问题通常不是几秒钟就能恢复的，
   * 而 30 秒冷却会让网关在故障期间反复去撞同一堵墙（每个请求都白跑一次）。
   *
   * 注意：401/403 这类「凭据坏了」仍会用更长的下限（见 COOLDOWN.auth），
   * 本项只决定**普通失败**（超时、5xx、连接失败）的冷却。
   */
  accountFailureCooldownSec: number
  /**
   * 是否「用量限额打满任意窗口」就跳过该账户。
   *
   * 与渠道的 `limit_priority` 不同：那是"哪个口径说了算"，
   * 这是"只要有一个窗口打满就先别用它" —— 打满的窗口就是硬上限，
   * 继续打过去只会拿到 429/402，白费一次请求。
   *
   * 只在**该渠道/账户配了余额适配器**（能查到用量）时才有数据；查不到则不影响路由。
   */
  skipExhaustedWindows: boolean

  /**
   * 上游「瞬时并发限制」撞线后的短冷却秒数。
   *
   * 触发形态如 `membership concurrency limit exceeded: 11/10`：不是余额或凭据问题，
   * 只是同一时刻在跑的请求数超过会员档位。按上游给的 reset_at 冷冻会让一个只是
   * 撞线的账户长时间不可用；正确做法是**短冷却后换号重试**。
   *
   * 调大：撞线的账户更久不回池，并发突增时可用账户变少；
   * 调小：同一个账户会被更频繁地再次撞线，但恢复更快。
   * 范围 1..3600，默认 20 秒。
   */
  concurrencyCooldownSec: number

  /**
   * 所有候选渠道并发都满载时的排队预算（毫秒）。
   *
   * 满载时请求不会立刻失败，而是轮询申请槽位；只在预算内等不到才换路/返回 429。
   * **0 = 不排队** —— 满载立刻换下一个候选渠道，全部满载则直接失败。
   *
   * 调大：高峰期客户端等得更久却更可能成功；
   * 调小：更快失败/换路，代价是放弃「等一个在途请求结束就轮到我」的机会。
   * 范围 0..300000，默认 30000（30 秒）。
   */
  concurrencyQueueTimeoutMs: number

  /**
   * 一次请求最多尝试几个候选渠道（别名映射的多个目标）。
   *
   * **0 = 全部候选渠道都试一遍**（默认）。1 = 不跨渠道，只试亲和/哈希选出的那一个。
   *
   * 调大：可用性更高，但换渠道会丢上游前缀缓存，并让请求在更多上游留下失败记录；
   * 调小：省缓存、控成本，代价是某个渠道抖动时请求更容易失败。
   * 范围 0..50。
   */
  maxChannelAttempts: number

  /**
   * 同一个（渠道, 账户）上最多连续尝试几次。
   *
   * 网络抖动、连接被重置这类瞬时故障，原地重试一次往往就成功，比立刻换号便宜
   * （不丢上游前缀缓存、不给别的账户加负担）。401/403/400/404 这类
   * 「换号也没用」的错误不消耗这个次数。
   *
   * 调大：瞬时故障更稳，但上游真挂时每次失败都要多等一轮；
   * 调小：失败更快暴露给客户端。
   * 范围 1..5，默认 2。
   */
  attemptsPerCandidate: number

  /**
   * 全部候选都失败后，最多再整体重来几轮。
   *
   * 重来前有抖动退避，给上游或账户短冷却恢复的机会。
   *
   * 调大：跨分钟级抖动时更不容易中断，但最坏耗时与上游请求量线性增加；
   * 调小：更快把失败交还客户端。
   * 范围 1..10，默认 3。
   */
  maxFailoverPasses: number

  /**
   * 故障转移的**总时间预算**（毫秒）—— 会话连续性的硬边界。
   *
   * 窗口内网关会持续换号/换渠道/整轮重试，用完才把失败交给客户端。
   * **0 = 不做整轮重试**（仍会在当前候选内换号/换渠道，但不会再来一轮）。
   *
   * 调大：长时间抖动下更容易救回请求，但客户端首字延迟上限随之变长；
   * 调小：更快失败，代价是错过「上游几秒后就恢复」的情况。
   * 范围 0..600000，默认 60000（60 秒）。
   */
  failoverBudgetMs: number

  /**
   * 单请求的总上游尝试次数上限（跨渠道、跨账户、跨轮次累计）。
   *
   * 时间预算是主闸门，这是**防病态**的兜底：所有上游都「秒失败」时，
   * 光靠时间预算一分钟能打出上百次请求，把上游限流器拱手触发。
   *
   * 调大：极端故障下重试更充分，但上游请求量与成本更高；
   * 调小：更快停手，代价是还有可用渠道没试完就放弃。
   * 范围 1..200，默认 24。
   */
  maxTotalAttempts: number

  /**
   * 单个渠道内最多尝试几个账户。
   *
   * **0 = 该渠道所有可用账户都试一遍**（默认）。
   * 早期默认 3 会让「第 4 个之后的账户」永远轮不到，渠道可用性被前几个账户绑架。
   *
   * 调大：渠道内某个账户抖动/额度用尽时更容易绕过；
   * 调小：省上游请求，代价是「前 N 个都不行」时整个渠道被判失败。
   * 范围 0..100。
   */
  maxAccountAttempts: number
}

export type SettingGroup = 'brand' | 'gateway'

interface SettingDef<K extends keyof GatewaySettings> {
  schema: z.ZodType<GatewaySettings[K]>
  default: GatewaySettings[K]
  group: SettingGroup
}

/**
 * 是否是合法的 IANA 时区名。
 *
 * 用 `Intl` 实际构造一次来判定 —— 比维护一份时区列表可靠，
 * 且会自动跟随运行时的 tzdata。
 */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export const SETTING_DEFS: { [K in keyof GatewaySettings]: SettingDef<K> } = {
  gatewayName: {
    schema: z.string().trim().max(64),
    default: '',
    group: 'brand'
  },
  allowDirectChannelTest: {
    schema: z.boolean(),
    default: true,
    group: 'gateway'
  },
  logRetentionDays: {
    schema: z.coerce.number().int().min(0).max(3650),
    default: 0,
    group: 'gateway'
  },
  defaultChannelTimeoutMs: {
    schema: z.coerce.number().int().min(1000).max(600_000),
    default: 120_000,
    group: 'gateway'
  },
  defaultKeyRpmLimit: {
    // 默认 60 与既有签发表单的预填值一致 —— 引入设置不该悄悄改变行为
    schema: z.coerce.number().int().min(0).max(1_000_000),
    default: 60,
    group: 'gateway'
  },
  usageCacheTtlSec: {
    // 5 分钟：足够挡住面板轮询与多人同时查看，又不至于让余额看着像"卡住了"
    schema: z.coerce.number().int().min(30).max(86_400),
    default: 300,
    group: 'gateway'
  },
  /**
   * 网页会话型渠道的**自动刷新间隔**（秒），0 = 关闭。
   *
   * 为什么需要它：会话型上游（如 OpenDesign）的登录态是**滚动过期**的 ——
   * 每次带 Cookie 访问可能回一个新 token，但**必须有人去访问**才会续期。
   * 定时刷新既拿到新用量，又顺手完成续期，会话因此能长期活着；
   * 不刷新的话，隔几天就会 401，只能重新粘贴。
   *
   * 默认 600（10 分钟）：足够续期，又不会频繁打上游。
   */
  usageAutoRefreshSec: {
    schema: z.coerce.number().int().min(0).max(86_400),
    default: 600,
    group: 'gateway'
  },
  /**
   * 余额/用量查询的**幂等重试次数**（首次之外再试几次），0 = 关闭重试。
   *
   * 为什么可以放心重试：这些都是对上游的 GET，天然幂等、不产生计费与副作用。
   * 而它们的失败很有价值 —— 网络抖动、上游 429、502/503 都属"下一次可能就好"，
   * 一次失败就把整张卡标记为失败（要等 5 分钟缓存过期）太浪费。
   *
   * 只对**可重试错误**生效：网络错误 / 超时 / 429 / 5xx。
   * 401/403/404 这类绝不重试 —— 重试只会放大鉴权失败风暴，还可能触发上游风控。
   *
   * 默认 3：覆盖常见的瞬时抖动，又不会把一次慢失败拖成十几秒。
   */
  usageMaxRetries: {
    schema: z.coerce.number().int().min(0).max(10),
    default: 3,
    group: 'gateway'
  },
  /**
   * 自适应选路：按**近期请求结果**动态调整候选渠道顺序。
   *
   * 默认**关闭** —— 它改变的是选路行为，必须先由人确认再打开。
   * 打开后只在同一优先级层内重排（配置里的优先级/权重仍是硬约束）。
   */
  adaptiveRouting: {
    schema: z.boolean(),
    default: false,
    group: 'gateway'
  },
  /** 自适应评分的时间窗口（秒） */
  adaptiveWindowSec: {
    schema: z.coerce.number().int().min(30).max(3600),
    default: 300,
    group: 'gateway'
  },
  /** 参与排序所需的最小样本数；不足的渠道保持原位置 */
  adaptiveMinSamples: {
    schema: z.coerce.number().int().min(1).max(1000),
    default: 10,
    group: 'gateway'
  },
  accountFailureCooldownSec: {
    // 1 小时：容错但不至于让恢复太慢；下限 30s 防止配成 0 变成"禁用冷却"
    schema: z.coerce.number().int().min(30).max(86_400),
    default: 3600,
    group: 'gateway'
  },
  skipExhaustedWindows: {
    // 默认开启：打满的窗口是硬上限，继续打过去只会换回 429/402
    schema: z.boolean(),
    default: true,
    group: 'gateway'
  },
  concurrencyCooldownSec: {
    // 默认 20s：足够让上游并发滑出，又不会把只是撞线的账户踢太久
    schema: z.coerce.number().int().min(1).max(3600),
    default: 20,
    group: 'gateway'
  },
  concurrencyQueueTimeoutMs: {
    // 默认 30s：覆盖一次普通上游请求的排队，又不至于让客户端挂到超时
    schema: z.coerce.number().int().min(0).max(300_000),
    default: 30_000,
    group: 'gateway'
  },
  maxChannelAttempts: {
    // 默认 0 = 全部候选：可用性优先，用总时间预算而不是次数兜底
    schema: z.coerce.number().int().min(0).max(50),
    default: 0,
    group: 'gateway'
  },
  attemptsPerCandidate: {
    // 默认 2：瞬时故障原地重试一次通常就成功，且不丢上游前缀缓存
    schema: z.coerce.number().int().min(1).max(5),
    default: 2,
    group: 'gateway'
  },
  maxFailoverPasses: {
    // 默认 3：覆盖常见的秒级~分钟级抖动；时间预算才是主闸门
    schema: z.coerce.number().int().min(1).max(10),
    default: 3,
    group: 'gateway'
  },
  failoverBudgetMs: {
    // 默认 60s：比多数客户端首字超时短，又不至于一次抖动就直接报错
    schema: z.coerce.number().int().min(0).max(600_000),
    default: 60_000,
    group: 'gateway'
  },
  maxTotalAttempts: {
    // 默认 24：防「所有上游秒失败」时一分钟打出上百次请求；正常故障转移用不到
    schema: z.coerce.number().int().min(1).max(200),
    default: 24,
    group: 'gateway'
  },
  maxAccountAttempts: {
    // 默认 0 = 该渠道所有可用账户：不让前几个账户绑架渠道可用性
    schema: z.coerce.number().int().min(0).max(100),
    default: 0,
    group: 'gateway'
  },
  timezone: {
    // 默认 UTC：不改变既有行为（此前所有按天聚合都是按 UTC 日界）
    schema: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine(isValidTimeZone, '不是合法的 IANA 时区名（形如 Asia/Shanghai）'),
    default: 'UTC',
    group: 'gateway'
  }
}

export const SETTING_KEYS = Object.keys(SETTING_DEFS) as (keyof GatewaySettings)[]

/**
 * 类型安全的逐项赋值。
 *
 * 用它而不是 `as Record<string, unknown>`：后者会把注册表与接口之间的
 * 对应关系交给运行时，键名写错也不报错。
 */
function assign<K extends keyof GatewaySettings>(
  target: Partial<GatewaySettings>,
  key: K,
  value: GatewaySettings[K]
): void {
  target[key] = value
}

/** 默认值合集（表为空时的完整设置） */
export function defaultSettings(): GatewaySettings {
  const out: Partial<GatewaySettings> = {}
  // 遍历全部键，循环结束后 out 必然是完整的 —— 因此这一步收窄是安全的
  for (const key of SETTING_KEYS) assign(out, key, SETTING_DEFS[key].default)
  return out as GatewaySettings
}

/**
 * 读取全部设置：从默认值出发，用库里的记录覆盖。
 *
 * 逐项独立校验 —— 某一项在库里损坏（比如被手工改坏）时只回退该项的默认值，
 * **不因为一条坏数据就让整个设置页面打不开**。
 */
export async function getSettings(): Promise<{
  settings: GatewaySettings
  invalid: string[]
}> {
  const rows = await query<{ key: string; value: unknown }>('select key, value from settings')
  const settings = defaultSettings()
  const invalid: string[] = []

  for (const row of rows) {
    if (!SETTING_KEYS.includes(row.key as keyof GatewaySettings)) continue
    const key = row.key as keyof GatewaySettings
    const parsed = SETTING_DEFS[key].schema.safeParse(row.value)
    if (parsed.success) assign(settings, key, parsed.data)
    else invalid.push(key)
  }

  return { settings, invalid }
}

/** 取单项（带默认值兜底） */
export async function getSetting<K extends keyof GatewaySettings>(
  key: K
): Promise<GatewaySettings[K]> {
  const row = await query<{ value: unknown }>('select value from settings where key = $1', [key])
  if (row.length === 0) return SETTING_DEFS[key].default
  const parsed = SETTING_DEFS[key].schema.safeParse(row[0]!.value)
  return parsed.success ? parsed.data : SETTING_DEFS[key].default
}

export interface SettingInput {
  key: string
  value: unknown
}

/**
 * 校验一批待写入的设置项。
 * 未知键与非法值都**明确报错**（不静默丢弃），并逐项给出原因。
 */
export function validateSettings(
  patch: SettingInput[]
): { ok: true; values: SettingInput[] } | { ok: false; issues: string[] } {
  const values: SettingInput[] = []
  const issues: string[] = []

  if (patch.length === 0) return { ok: false, issues: ['没有需要更新的设置项'] }

  for (const item of patch) {
    const def = SETTING_DEFS[item.key as keyof GatewaySettings]
    if (!def) {
      issues.push(`未知的设置项「${item.key}」`)
      continue
    }
    const parsed = def.schema.safeParse(item.value)
    if (!parsed.success) {
      const reason = parsed.error.issues[0]?.message ?? '格式不正确'
      issues.push(`「${item.key}」${reason}`)
      continue
    }
    values.push({ key: item.key, value: parsed.data })
  }

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, values }
}

/** 写入（upsert），返回写入后的完整设置 */
export async function saveSettings(
  values: SettingInput[],
  updatedBy: string
): Promise<GatewaySettings> {
  for (const item of values) {
    await query(
      `insert into settings (key, value, updated_at, updated_by)
       values ($1, $2::jsonb, now(), $3)
       on conflict (key) do update
         set value = excluded.value,
             updated_at = now(),
             updated_by = excluded.updated_by`,
      [item.key, JSON.stringify(item.value), updatedBy]
    )
  }
  // 注意：这里**不能**顺手清 Redis 缓存 —— 本模块刻意不依赖 redis
  // （否则 timezone 之类的纯配置单测会被 ioredis 的连接卡住）。
  // 失效由 HTTP 层在保存成功后调用 invalidateRoutingSettingCache() 完成。
  return (await getSettings()).settings
}

/**
 * 按保留策略清理请求日志。
 * 返回删除行数；retentionDays <= 0 表示永久保留，不做任何事。
 */
export async function purgeOldLogs(retentionDays: number): Promise<number> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0
  const rows = await query<{ id: string }>(
    `delete from request_logs
      where ts < now() - ($1::int * interval '1 day')
      returning id`,
    [Math.floor(retentionDays)]
  )
  return rows.length
}
