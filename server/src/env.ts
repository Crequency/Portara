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

/** access TTL；顺带对已废弃的 PORTARA_SESSION_TTL_HOURS 给出提示 */
function loadAccessTtlMinutes(): number {
  if (
    process.env.PORTARA_ACCESS_TTL_MINUTES === undefined &&
    process.env.PORTARA_SESSION_TTL_HOURS !== undefined
  ) {
    warnings.push(
      'PORTARA_SESSION_TTL_HOURS 已被 PORTARA_ACCESS_TTL_MINUTES 取代（access token 现在' +
        '应当是短时效的，长效交给 refresh token），该值将被忽略'
    )
  }
  return num(process.env.PORTARA_ACCESS_TTL_MINUTES, 15)
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

/**
 * 会话亲和的 TTL（秒）。
 *
 * 取值对齐上游前缀缓存的存活窗口：太短等于没记住，太长会让「渠道恢复后
 * 也回不去」以及 Redis 里堆积无用键。默认 30 分钟。
 */
const affinityTtlSeconds = num(process.env.PORTARA_AFFINITY_TTL_SECONDS, 1800)

/**
 * 会话亲和的**最大年龄**（秒）。
 *
 * 与 TTL 不同：TTL 是"多久没访问就忘"，这是"一条 pin 最多能活多久"。
 * 长会话会持续命中同一条 pin，TTL 永远续得上；没有年龄上限的话，
 * 即使配额窗口早已滚动、账户恢复，会话也会一直粘在旧账户上。
 * 成功命中**不刷新** pinnedAt，所以这个上限才对长会话真正生效。
 */
const affinityMaxAgeSeconds = num(process.env.PORTARA_AFFINITY_MAX_AGE_SEC, 3600)

/**
 * 一次请求最多尝试几个**渠道**（别名映射的多个目标）。
 *
 * 与账户上限分开：账户上限管「同一个渠道换号」，这个管「换到下一个渠道」。
 * 会话粘性一旦失败，换渠道会丢缓存，所以默认只多试一个（2 个渠道封顶）。
 */
const maxChannelAttempts = Math.max(1, Number(process.env.PORTARA_MAX_CHANNEL_ATTEMPTS ?? 2))

/**
 * 是否允许用「上下文指纹」做会话亲和。
 *
 * **默认关闭**，只认客户端显式给的 `prompt_cache_key`。
 *
 * 原因（本分支实测踩到）：指纹取自「system + 首条 user」，
 * 于是「固定系统提示 + 相同首条消息」的所有调用（探活、模板化调用）
 * 会被判成同一个会话 → 全部钉死在一个渠道上，加权轮转与负载均衡同时失效。
 * 显式键没有这个问题，因为它天然带会话身份。
 */
const affinityContext = process.env.PORTARA_AFFINITY_CONTEXT === 'true'

/**
 * 余额告警阈值（美元，默认 1）。
 *
 * 低于它时 /api/billing/me 的 lowBalance 为 true，个人资料页显示预警徽章 ——
 * 让用户在被动 402 之前就能看到「快没钱了」。credits 套餐按兑换率换算，
 * tokens 套餐没有金额→token 的统一口径，直接按原始数值比较。
 */
const billingLowBalanceUsd = (() => {
  const raw = Number(process.env.PORTARA_BILLING_LOW_BALANCE_USD)
  return Number.isFinite(raw) && raw >= 0 ? raw : 1
})()

/**
 * 上游「瞬时并发限制」（如 membership concurrency limit exceeded）的短冷却秒数。
 *
 * 这类错误不是"号没钱了"，而是同一时刻在跑的请求数超过会员档位上限。
 * 上游给的重置时间通常是"并发窗口滑出"的时刻（几分钟到一小时），按它冷冻会让
 * 一个只是撞线的号长时间不可用；正确做法是**短冷却后重试**。
 * 默认 20s：足以让并发滑出，又不会把可用号踢太久。
 */
const concurrencyCooldownSec = Math.max(
  1,
  Number(process.env.PORTARA_CONCURRENCY_COOLDOWN_SEC ?? 20)
)

export const env = {
  port: num(process.env.PORTARA_PORT, 52740),
  concurrencyCooldownSec,
  affinityTtlSeconds,
  affinityMaxAgeSeconds,
  maxChannelAttempts,
  affinityContext,
  billingLowBalanceUsd,
  host: process.env.PORTARA_HOST ?? '0.0.0.0',

  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://portara:portara@127.0.0.1:52744/portara',
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:52745',

  /**
   * 可选的独立 schema。设置后所有表都建在该 schema 内，
   * 用于「同一套库跑多套实例」——尤其是**让端到端测试与开发数据彻底隔离**。
   * 只允许字母数字下划线，避免注入。
   */
  dbSchema: (process.env.PORTARA_DB_SCHEMA ?? '').trim(),

  masterKey: loadMasterKey(),
  sessionSecret: loadSessionSecret(),
  cookieSecure: process.env.PORTARA_COOKIE_SECURE === 'true',
  /**
   * access token 有效期（分钟）。
   *
   * **故意很短**：access token 是无状态 JWT、签发后收不回来，
   * 所以它的暴露窗口必须小；长效靠 refresh token（可撤销、会轮换）。
   */
  accessTtlMinutes: loadAccessTtlMinutes(),
  /**
   * 轮换宽限窗口（秒）。
   *
   * 多标签页并发刷新时，后者会拿到"刚被轮换掉"的令牌 ——
   * 若严格判为重放，用户会被自己踢下线。窗口内改走同族继任者。
   * 真正的重放攻击发生在令牌泄露很久之后，不在这个窗口内。
   */
  refreshGraceSeconds: num(process.env.PORTARA_REFRESH_GRACE_SECONDS, 30),
  /** refresh token 有效期（天）。这才是"记住我"的时长。 */
  refreshTtlDays: num(process.env.PORTARA_REFRESH_TTL_DAYS, 30),

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
