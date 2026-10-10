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
}

export type SettingGroup = 'brand' | 'gateway'

interface SettingDef<K extends keyof GatewaySettings> {
  schema: z.ZodType<GatewaySettings[K]>
  default: GatewaySettings[K]
  group: SettingGroup
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
