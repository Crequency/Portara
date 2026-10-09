import { serve } from '@hono/node-server'
import { createApp, VERSION } from './app.js'
import { ensureAdmin } from './bootstrap.js'
import { closeDb, runMigrations } from './db.js'
import { env, printStartupWarnings } from './env.js'
import { closeRedis, redis } from './redis.js'

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
      void Promise.allSettled([closeRedis(), closeDb()]).then(() => {
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
