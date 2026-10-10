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

export function formatCompact(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
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
