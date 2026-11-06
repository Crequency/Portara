import { formatInTimeZone } from './time'

/**
 * 格式化时间 —— 按**浏览器时区**展示。
 * 实现放在 time.ts 里，与查询口径共用同一套时区逻辑，避免两处各写一份。
 */
export function formatTime(iso: string | null): string {
  return formatInTimeZone(iso)
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString('en-US')
}

/**
 * 金额展示：千分位 + 合理小数位。
 *
 * 费率单价常是小数值（如每百万 token $0.15），所以最多保留 4 位；
 * 余额这类大数会自动按货币格式收成两位。负数（欠费 / 调减）保留符号。
 */
export function formatMoney(
  n: number | null | undefined,
  currency = 'USD'
): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency === 'CNY' ? 'CNY' : 'USD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 0,
    maximumFractionDigits: 4
  }).format(n)
}

/**
 * 紧凑计数：1.2k / 375M / 1.1B。
 *
 * 整数不补 `.0` —— 刻度线上出现 `375.0M` 只是噪音；
 * 超过十亿要进位到 B，否则会是 `1125.0M` 这种读不出量级的写法。
 */
export function formatCompact(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  const abs = Math.abs(n)
  const [div, suffix]: [number, string] =
    abs >= 1e9 ? [1e9, 'B'] : abs >= 1e6 ? [1e6, 'M'] : abs >= 1e3 ? [1e3, 'k'] : [1, '']
  if (div === 1) return String(Math.round(n))
  const v = n / div
  // 四舍五入后可能正好是整数（697.98 → 698.0），此时也别留 `.0`
  const text = v.toFixed(1).replace(/\.0$/, '')
  return `${text}${suffix}`
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${ms}ms`
}

/** 把逗号/换行分隔的模型名解析为数组 */
export function parseList(input: string): string[] {
  return input
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 解析「名称: 值」形式的固定请求头（每行一条，# 开头为注释）。
 * 只做前端友好提示，真正的合法性由服务端判定。
 */
export function parseHeaderLines(text: string): {
  headers: Record<string, string>
  errors: string[]
} {
  const headers: Record<string, string> = {}
  const errors: string[] = []

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue

    const idx = line.indexOf(':')
    if (idx <= 0) {
      errors.push(`缺少冒号：${line}`)
      continue
    }
    const name = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (!name) {
      errors.push(`请求头名称为空：${line}`)
      continue
    }
    headers[name] = value
  }

  return { headers, errors }
}

/** 反向：把请求头对象渲染成多行文本供编辑 */
export function headerLines(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}

/** 百分比展示 */
export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return '—'
  return `${(ratio * 100).toFixed(ratio >= 0.1 ? 0 : 1)}%`
}

// ---------------------------------------------------------------- 额度进度条

/** 额度告警阈值（已用百分比） */
export const QUOTA_WARN_PERCENT = 70
export const QUOTA_DANGER_PERCENT = 90

/** 已用百分比（total 为 0 时按 0 处理，避免除零） */
export function quotaPercent(used: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.min(100, Math.round((used / total) * 100))
}

/**
 * 额度进度条的颜色：**按已用百分比分级**，而不是只看上游的 exceeded 标记。
 *
 * 为什么不能只看 exceeded：CommandCode 的月度窗口上限是**推算**出来的，
 * 上游根本没有这个对象、自然也不会给 exceeded ——
 * 结果就是"月度 70/70 已用满，进度条还是蓝色"，看不出问题。
 */
export function quotaColor(usedPercent: number, exceeded = false): string {
  if (exceeded || usedPercent >= QUOTA_DANGER_PERCENT) return 'var(--danger)'
  if (usedPercent >= QUOTA_WARN_PERCENT) return 'var(--warn)'
  return 'var(--accent)'
}
