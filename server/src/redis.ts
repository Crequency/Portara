// ioredis 是 CJS 包，NodeNext 下用具名导入才能在 ESM 中正确取到构造函数
import { Redis } from 'ioredis'
import { env } from './env.js'

export const redis = new Redis(env.redisUrl, {
  maxRetriesPerRequest: 3,
  enableOfflineQueue: true,
  lazyConnect: false
})

redis.on('error', (err: Error) => {
  console.error('[portara][redis] 错误：', err.message)
})

export async function closeRedis(): Promise<void> {
  try {
    await redis.quit()
  } catch {
    redis.disconnect()
  }
}
