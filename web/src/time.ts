/**
 * 时区：面板一律以**浏览器时区**为准。
 *
 * 分工（见 DECISIONS D-038）：
 *   - **存储**：日志一律 UTC（数据库 timestamptz）
 *   - **查询**：前端把浏览器时区带给服务端，让「今日/7天/30天」按用户的当地日界算
 *   - **展示**：前端按浏览器时区格式化
 *   - **网关时区设置**：只作为「没有浏览器上下文」时的默认（API 消费者、定时清理）
 *
 * 为什么要显式传而不是让服务端猜：用户看的是自己的日历，
 * 服务端不可能知道每个调用方的时区。
 */

/** 浏览器时区（IANA 名）；拿不到时回落到 UTC */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** 进程内固定下来：时区在一次会话里不该变 */
export const CLIENT_TZ = browserTimeZone()

/** 是否是合法的 IANA 时区名 */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * 可选的 IANA 时区列表（用于设置页的可搜索下拉）。
 * `Intl.supportedValuesOf` 在旧浏览器里可能不存在 —— 那时退化为只提供当前时区。
 */
export function timeZoneOptions(): string[] {
  const current = CLIENT_TZ
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf?.('timeZone')
    if (list && list.length > 0) {
      const set = new Set(list)
      set.add(current) // 浏览器时区理论上在列表里，保险起见补上
      return [...set].sort()
    }
  } catch {
    /* 落到兜底 */
  }
  return [current, 'UTC']
}

/** 在查询串里安全携带时区 */
export function tzQueryParam(): string {
  return 'tz=' + encodeURIComponent(CLIENT_TZ)
}

/**
 * 按指定时区格式化时间（默认浏览器时区）。
 * 用 Intl 而不是手拼，顺便保证跨浏览器一致。
 */
export function formatInTimeZone(iso: string | null, tz = CLIENT_TZ): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
}
