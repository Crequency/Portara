import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  __setSleepForTests,
  isRetriableUsageStatus,
  retryDelayMs,
  runWithRetry
} from '../src/services/retry.js'

// 单测里不真的睡：替换掉定时器，只验证"重试了几次、退避是不是在涨"
__setSleepForTests(() => Promise.resolve())

/*
 * 余额/用量查询是 GET（幂等、无副作用），失败后重试是安全的。
 * 这几条测试钉的是**策略**而不是网络：
 *   - 哪些状态码值得再试
 *   - 退避是否真在增长
 *   - 用尽重试后是否停手（不能无限重试）
 *   - 不可重试的错误是否**一次就停**（避免放大 401/404 风暴）
 */

test('可重试状态码：网络失败 / 超时 / 429 / 5xx', () => {
  assert.equal(isRetriableUsageStatus(0), true, '连接层失败要重试')
  assert.equal(isRetriableUsageStatus(408), true)
  assert.equal(isRetriableUsageStatus(425), true)
  assert.equal(isRetriableUsageStatus(429), true)
  assert.equal(isRetriableUsageStatus(500), true)
  assert.equal(isRetriableUsageStatus(502), true)
  assert.equal(isRetriableUsageStatus(503), true)
})

test('不可重试状态码：鉴权与客户端错误', () => {
  for (const s of [400, 401, 403, 404, 405, 409, 422]) {
    assert.equal(isRetriableUsageStatus(s), false, `HTTP ${s} 不该重试`)
  }
})

test('退避递增且封顶 3s', () => {
  assert.ok(retryDelayMs(1) >= 300 && retryDelayMs(1) <= 400)
  assert.ok(retryDelayMs(2) >= 600 && retryDelayMs(2) <= 700)
  assert.ok(retryDelayMs(3) >= 1200 && retryDelayMs(3) <= 1300)
  assert.ok(retryDelayMs(10) <= 3100, '封顶 3s + 抖动')
})

test('前两次失败、第三次成功 → 共 3 次尝试', async () => {
  let calls = 0
  const { result, attempts } = await runWithRetry({
    retries: 3,
    attempt: async () => {
      calls++
      return calls < 3 ? { status: 503, error: 'boom' } : { status: 200, error: null }
    },
    isFailure: (r) => r.error !== null,
    isRetriable: (r) => isRetriableUsageStatus(r.status)
  })
  assert.equal(attempts, 3)
  assert.equal(result.status, 200)
  assert.equal(calls, 3)
})

test('一直 500：用尽重试后停手（1 + 3 次）', async () => {
  let calls = 0
  const { attempts, result } = await runWithRetry({
    retries: 3,
    attempt: async () => {
      calls++
      return { status: 500, error: 'upstream down' }
    },
    isFailure: (r) => r.error !== null,
    isRetriable: (r) => isRetriableUsageStatus(r.status)
  })
  assert.equal(calls, 4, '首次 + 3 次重试')
  assert.equal(attempts, 4)
  assert.equal(result.status, 500)
})

test('不可重试的错误只打一次', async () => {
  let calls = 0
  const { attempts } = await runWithRetry({
    retries: 3,
    attempt: async () => {
      calls++
      return { status: 401, error: 'unauthorized' }
    },
    isFailure: (r) => r.error !== null,
    isRetriable: (r) => isRetriableUsageStatus(r.status)
  })
  assert.equal(calls, 1)
  assert.equal(attempts, 1)
})

test('retries = 0 时完全不重试', async () => {
  let calls = 0
  const { attempts } = await runWithRetry({
    retries: 0,
    attempt: async () => {
      calls++
      return { status: 503, error: 'boom' }
    },
    isFailure: (r) => r.error !== null,
    isRetriable: (r) => isRetriableUsageStatus(r.status)
  })
  assert.equal(calls, 1)
  assert.equal(attempts, 1)
})

test('首次即成功不受影响', async () => {
  let calls = 0
  const { attempts } = await runWithRetry({
    retries: 3,
    attempt: async () => {
      calls++
      return { status: 200, error: null }
    },
    isFailure: (r) => r.error !== null,
    isRetriable: (r) => isRetriableUsageStatus(r.status)
  })
  assert.equal(calls, 1)
  assert.equal(attempts, 1)
})
