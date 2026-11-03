/**
 * 使用频率热力图的几何换算。
 *
 * 后端把「一维时间桶」折成矩阵（见 server/src/routes/logs.ts 的
 * foldHeatmapBucket）：**每列里是连续的若干个小桶**，所以
 *   idx = 列 × 行数 + 行    （列优先）
 * 而不是行优先。各档的桶宽与起点由后端 resolveHeatmapPlan 决定：
 *   today 1 分钟 / 7d 10 分钟 / 30d 30 分钟（从当地 04:00 起算）/ 90d 2 小时
 * 365d 是年历：一列一周、自上而下周一→周日。
 *
 * 时间一律用响应里的 timezone 换算，不碰浏览器本地时区。
 */
import type { StatsHeatmap } from './api'

export type HeatmapProfile = 'today' | '7d' | '30d' | '90d' | 'calendar'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

/** 每个格子的时长（毫秒）；calendar 一整天 */
export function cellStepMs(profile: HeatmapProfile): number {
  switch (profile) {
    case 'today':
      return MINUTE
    case '7d':
      return 10 * MINUTE
    case '30d':
      return 30 * MINUTE
    case '90d':
      return 2 * HOUR
    case 'calendar':
      return DAY
  }
}

/** 30d 档的起点在「当天当地 00:00」之后 4 小时（首日 00:00–04:00 归前一天） */
const START_OFFSET_MS: Partial<Record<HeatmapProfile, number>> = { '30d': 4 * HOUR }

/**
 * 矩阵档位。
 *
 * 已知 preset 直接采信；custom 按跨度反推 —— 与后端 resolveHeatmapPlan
 * 的四档阈值一致，否则自定义范围的浮层时间会整体错位。
 */
export function heatmapProfile(h: StatsHeatmap): HeatmapProfile {
  if (h.mode === 'calendar') return 'calendar'
  const preset = h.range.preset
  if (preset === 'today' || preset === '7d' || preset === '30d' || preset === '90d') {
    return preset
  }
  const spanHours = (Date.parse(h.range.to) - Date.parse(h.range.from)) / HOUR
  if (!Number.isFinite(spanHours)) return '90d'
  if (spanHours <= 26) return 'today'
  if (spanHours <= 8 * 24) return '7d'
  if (spanHours <= 31 * 24) return '30d'
  return '90d'
}

export interface LocalDateParts {
  year: number
  month: number
  day: number
}

/** 某个瞬时在目标时区的当地日历日期 */
export function localDateParts(iso: string | number, timeZone: string): LocalDateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(iso))
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0')
  return { year: get('year'), month: get('month'), day: get('day') }
}

/** 当地日历日的整数序号（以 UTC 日期做纯日历运算，不受时区影响） */
export function localDayNumber(iso: string | number, timeZone: string): number {
  const p = localDateParts(iso, timeZone)
  return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / DAY)
}

/** 目标时区在某个瞬时的偏移（当地墙钟 − UTC） */
function tzOffsetMs(instant: number, timeZone: string): number {
  const whole = Math.floor(instant / 1000) * 1000
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(new Date(whole))
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0')
  return (
    Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) -
    whole
  )
}

/** 「当天当地 00:00」对应的 UTC 瞬时（跨夏令时时用两轮修正） */
export function localMidnight(iso: string | number, timeZone: string): number {
  const p = localDateParts(iso, timeZone)
  const wall = Date.UTC(p.year, p.month - 1, p.day)
  const off = tzOffsetMs(wall, timeZone)
  const instant = wall - off
  const off2 = tzOffsetMs(instant, timeZone)
  return off2 === off ? instant : wall - off2
}

/**
 * grid 模式：第 index 个格子（= y × cols + x）的起始瞬时。
 *
 * 起点是范围首日的当地 00:00（30d 再 +4h），之后线性推进 ——
 * 与后端 generate_series 的用法一致。
 */
export function gridCellInstant(
  h: StatsHeatmap,
  profile: HeatmapProfile,
  index: number
): Date {
  const fromMs = Date.parse(h.range.from)
  const start = localMidnight(fromMs, h.timezone) + (START_OFFSET_MS[profile] ?? 0)
  return new Date(start + index * cellStepMs(profile))
}

/** 周一 = 0 … 周日 = 6（ISO 周） */
export function weekdayIndexMonday(day: number): number {
  return (new Date(day * DAY).getUTCDay() + 6) % 7
}

export interface CalendarCell {
  /** 当地日历日序号；不在统计范围内的前后补白为 null */
  day: number | null
}

/**
 * calendar 模式：第 (row, col) 格对应的当地日期。
 *
 * 后端按 pos = dayIdx + 首日星期偏移 折叠，所以反过来
 * dayIdx = col × 7 + row − 偏移；落在范围外的就是首尾补白。
 */
export function calendarCell(h: StatsHeatmap, row: number, col: number): CalendarCell {
  const fromDay = localDayNumber(h.range.from, h.timezone)
  const toDay = localDayNumber(h.range.to, h.timezone)
  const day = fromDay + (col * 7 + row - weekdayIndexMonday(fromDay))
  return { day: day >= fromDay && day <= toDay ? day : null }
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 日序号 → 当地日期（纯日历运算，不经过任何时区） */
export function dayParts(day: number): LocalDateParts {
  const d = new Date(day * DAY)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/** 区域设置的短星期名（en-CA 的星期一就是 1970-01-05 = 4） */
export function weekdayName(day: number, intlLocale: string): string {
  return new Intl.DateTimeFormat(intlLocale, {
    timeZone: 'UTC',
    weekday: 'short'
  }).format(new Date(day * DAY))
}

/** 年历浮层标题：2026-11-03 周二 / 2026-11-03 Tue */
export function formatCalendarDay(day: number, intlLocale: string): string {
  const p = dayParts(day)
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${weekdayName(day, intlLocale)}`
}

/** grid 模式浮层标题：今日 HH:mm，其余 MM-DD HH:mm */
export function formatGridCellTime(
  h: StatsHeatmap,
  profile: HeatmapProfile,
  instant: Date
): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: h.timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(instant)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00'
  const clock = `${get('hour')}:${get('minute')}`
  return profile === 'today' ? clock : `${get('month')}-${get('day')} ${clock}`
}

export type HeatmapUnitKind = 'minute' | 'hour' | 'day'

/** 每格时长的数量与单位，用于「每格 X」提示 */
export function heatmapUnit(profile: HeatmapProfile): { kind: HeatmapUnitKind; n: number } {
  switch (profile) {
    case 'today':
      return { kind: 'minute', n: 1 }
    case '7d':
      return { kind: 'minute', n: 10 }
    case '30d':
      return { kind: 'minute', n: 30 }
    case '90d':
      return { kind: 'hour', n: 2 }
    case 'calendar':
      return { kind: 'day', n: 1 }
  }
}
