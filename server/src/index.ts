import { serve } from '@hono/node-server'
import { createApp, VERSION } from './app.js'
import { ensureAdmin } from './bootstrap.js'
import { closeDb, runMigrations } from './db.js'
import { env, printStartupWarnings } from './env.js'
import { closeProxyAgents } from './services/proxyAgent.js'
import { closeRedis, redis } from './redis.js'
import { getSettings, purgeOldLogs } from './services/settings.js'
import { refreshSessionUsageChannels } from './services/usageFetch.js'
import { pruneSessions } from './services/sessions.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 依赖可能比应用晚就绪（compose 启动顺序），迁移失败时重试 */
async function migrateWithRetry(attempts = 15): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      const applied = await runMigrations()
      console.log(
        applied.length > 0
          ? `[portara] 已执行迁移：${applied.join(', ')}`
          : '[portara] 数据库结构已是最新'
      )
      return
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (i === attempts) throw err
      console.warn(`[portara] 迁移失败（第 ${i}/${attempts} 次），2s 后重试：${msg}`)
      await sleep(2000)
    }
  }
}

async function main(): Promise<void> {
  console.log(`[portara] 启动中 v${VERSION}（Node ${process.version}）`)
  printStartupWarnings()

  if (env.skipMigrate) {
    console.log('[portara] PORTARA_SKIP_MIGRATE=1，跳过迁移')
  } else {
    await migrateWithRetry()
  }

  try {
    await redis.ping()
    console.log('[portara] Redis 连接正常')
  } catch (err) {
    console.error(
      '[portara] Redis 不可用：',
      err instanceof Error ? err.message : String(err)
    )
    process.exit(1)
  }

  await ensureAdmin()

  /**
   * 按「日志保留天数」定时清理。
   *
   * 用 setInterval 而不是 cron：单实例部署下够用，且不引入依赖。
   * 启动时先不跑（避免刚起来就干重活），首次清理在一个周期后。
   * unref() 让它不阻止进程退出。
   */
  const LOG_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000
  const sweepLogs = async (): Promise<void> => {
    try {
      const retentionDays = await getSettings().then((r) => r.settings.logRetentionDays)
      if (retentionDays <= 0) return
      const deleted = await purgeOldLogs(retentionDays)
      if (deleted > 0) {
        console.log(`[portara] 已按「保留 ${retentionDays} 天」清理 ${deleted} 条请求日志`)
      }
    } catch (err) {
      // 清理失败不能影响服务本身
      console.warn('[portara] 清理请求日志失败：', err instanceof Error ? err.message : String(err))
    }
  }
  setInterval(() => void sweepLogs(), LOG_SWEEP_INTERVAL_MS).unref()

  /**
   * 清理过期 / 早已作废的会话记录。
   * 与日志清理同一个周期 —— 表本身很小，不值得单独起一个定时器。
   */
  const sweepSessions = async (): Promise<void> => {
    try {
      const deleted = await pruneSessions()
      if (deleted > 0) console.log(`[portara] 已清理 ${deleted} 条过期会话`)
    } catch (err) {
      console.warn('[portara] 清理过期会话失败：', err instanceof Error ? err.message : String(err))
    }
  }
  setInterval(() => void sweepSessions(), LOG_SWEEP_INTERVAL_MS).unref()

  /**
   * 网页会话型渠道的用量自动刷新（顺带续期会话）。
   *
   * 为什么要做：会话型上游（OpenDesign）的登录态是**滚动过期**的，
   * 必须有人定期带着 Cookie 去访问，服务端才会回新的 token。
   * 定时刷新同时解决两件事：面板显示的是实时用量、会话不会被放过期。
   *
   * 调度方式：每 60 秒 tick 一次，读设置项 `usageAutoRefreshSec` 决定是否到点。
   * 不直接把 interval 设成设置值 —— 那样改了设置要重启才生效。
   */
  let lastUsageAutoRefresh = 0
  const USAGE_TICK_MS = 60 * 1000
  const autoRefreshUsage = async (): Promise<void> => {
    try {
      const settings = await getSettings()
      const intervalSec = settings.settings.usageAutoRefreshSec
      if (intervalSec <= 0) return
      const now = Date.now()
      if (now - lastUsageAutoRefresh < intervalSec * 1000) return
      lastUsageAutoRefresh = now
      const r = await refreshSessionUsageChannels()
      if (r.refreshed > 0 || r.failed > 0) {
        console.log(
          `[portara] 网页会话用量自动刷新：成功 ${r.refreshed}、失败 ${r.failed}`
        )
      }
    } catch (err) {
      console.warn(
        '[portara] 网页会话用量自动刷新失败：',
        err instanceof Error ? err.message : String(err)
      )
    }
  }
  setInterval(() => void autoRefreshUsage(), USAGE_TICK_MS).unref()

  const app = createApp()
  const server = serve(
    { fetch: app.fetch, port: env.port, hostname: env.host },
    (info) => {
      const base = `http://${env.host === '0.0.0.0' ? '127.0.0.1' : env.host}:${info.port}`
      console.log(`[portara] 服务已就绪 ${base}`)
      console.log(`[portara] 管理面板   ${base}/`)
      console.log(`[portara] OpenAI 入口 ${base}/v1`)
    }
  )

  const shutdown = (signal: string) => {
    console.log(`\n[portara] 收到 ${signal}，正在关闭…`)
    server.close(() => {
      // 代理连接池也要关：undici 的 Agent 会保持长连接，
      // 不关的话进程退出前会多挂一会儿
      void Promise.allSettled([closeRedis(), closeDb(), closeProxyAgents()]).then(() => {
        console.log('[portara] 已关闭')
        process.exit(0)
      })
    })
    // 兜底：10s 后强退，避免连接迟迟不释放
    setTimeout(() => process.exit(0), 10_000).unref()
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err: unknown) => {
  console.error('[portara] 启动失败：', err)
  process.exit(1)
})
