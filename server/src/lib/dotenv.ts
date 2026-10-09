import { readFileSync } from 'node:fs'

/**
 * 极简 .env 加载器。
 *
 * 为什么不用 `node --env-file`：需要**确定性**的优先级语义 ——
 * 已存在的环境变量（容器注入、测试显式指定）必须优先于 .env 文件，
 * 否则端到端冒烟脚本注入的端口与数据库会被仓库里的 .env 悄悄覆盖。
 * 自己实现 15 行，行为完全可预测。
 *
 * 规则：已存在的 process.env 键**绝不覆盖**；文件不存在时静默跳过。
 */
export function loadDotEnv(filePath: string): void {
  let content: string
  try {
    content = readFileSync(filePath, 'utf8')
  } catch {
    return // 没有 .env 是正常情况（容器里靠环境变量注入）
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line
    const eq = withoutExport.indexOf('=')
    if (eq <= 0) continue

    const key = withoutExport.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    if (process.env[key] !== undefined) continue

    let value = withoutExport.slice(eq + 1).trim()
    // 去掉成对的引号；未加引号时保留原样（含空格）
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }

    process.env[key] = value
  }
}
