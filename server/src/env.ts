import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadDotEnv } from './lib/dotenv.js'

/**
 * 运行时配置。
 *
 * 设计原则：**生产必须显式提供密钥**；缺失时开发模式回退到内置弱值，
 * 并在启动日志中高声告警 —— 绝不静默使用弱密钥。
 */

// 本地开发读取仓库根目录的 .env；已存在的环境变量优先（容器/测试注入）
loadDotEnv(fileURLToPath(new URL('../../.env', import.meta.url)))
loadDotEnv(fileURLToPath(new URL('../../server/.env', import.meta.url)))

const DEV_MASTER_KEY_SEED = 'portara-dev-insecure-master-key'
const DEV_SESSION_SECRET = 'portara-dev-insecure-session-secret'

function num(v: string | undefined, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const warnings: string[] = []

function loadMasterKey(): Buffer {
  const raw = process.env.PORTARA_MASTER_KEY?.trim()
  if (!raw) {
    warnings.push(
      '未设置 PORTARA_MASTER_KEY —— 上游渠道密钥将以「开发用内置弱密钥」加密。' +
        '生产环境必须设置：openssl rand -base64 32'
    )
    // 用固定种子派生 32 字节，保证同一开发环境重启后仍能解密
    return createHash('sha256').update(DEV_MASTER_KEY_SEED).digest()
  }
  const buf = Buffer.from(raw, 'base64')
  if (buf.length !== 32) {
    throw new Error(
      `PORTARA_MASTER_KEY 必须是 32 字节的 base64（当前解出 ${buf.length} 字节）。生成：openssl rand -base64 32`
    )
  }
  return buf
}

function loadSessionSecret(): string {
  const raw = process.env.PORTARA_SESSION_SECRET?.trim()
  if (!raw) {
    warnings.push(
      '未设置 PORTARA_SESSION_SECRET —— 管理会话将使用内置弱密钥签名。' +
        '生产环境必须设置：openssl rand -hex 32'
    )
    return DEV_SESSION_SECRET
  }
  return raw
}

export const env = {
  port: num(process.env.PORTARA_PORT, 52740),
  host: process.env.PORTARA_HOST ?? '0.0.0.0',

  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://portara:portara@127.0.0.1:52744/portara',
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:52745',

  masterKey: loadMasterKey(),
  sessionSecret: loadSessionSecret(),
  cookieSecure: process.env.PORTARA_COOKIE_SECURE === 'true',
  sessionTtlHours: num(process.env.PORTARA_SESSION_TTL_HOURS, 12),

  adminUsername: process.env.PORTARA_ADMIN_USERNAME ?? 'admin',
  adminPassword: process.env.PORTARA_ADMIN_PASSWORD ?? '',

  webDist:
    process.env.PORTARA_WEB_DIST ??
    fileURLToPath(new URL('../../web/dist', import.meta.url)),

  skipMigrate: process.env.PORTARA_SKIP_MIGRATE === '1',
  warnings
} as const

export function printStartupWarnings(): void {
  for (const w of env.warnings) {
    console.warn(`\n\u001b[33m[portara][安全告警] ${w}\u001b[0m`)
  }
  if (env.warnings.length > 0) {
    console.warn('')
  }
}
