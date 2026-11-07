/**
 * 令牌桶纯函数单测。
 *
 * 真正与 Redis 交互的 checkRateLimit 不在单测范围（需要 Redis）；
 * 这里把「补充 / 取走 / 拒绝 / 并发原子性」的算法钉死，Lua 脚本与它同口径。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  bucketFullAt,
  bucketKey,
  fullTokenBucket,
  refillTokenBucket,
  takeToken,
  type TokenBucketState
} from '../src/services/limits.js'

const T0 = 1_700_000_000_000

test('令牌桶：初始为满桶（capacity = rpm）', () => {
  const bucket = fullTokenBucket(3, T0)
  assert.equal(bucket.tokens, 3)
  assert.equal(bucket.updatedAt, T0)
  assert.equal(bucketKey('key-1'), 'portara:rl:key-1')
})

test('令牌桶：取第一个令牌后 remaining 递减', () => {
  let state = fullTokenBucket(3, T0)
  const first = takeToken(state, 3, T0)
  assert.equal(first.ok, true)
  assert.equal(first.remaining, 2)
  assert.equal(first.retryAfterSec, 0)
  state = first.state
  assert.equal(state.tokens, 2)
})

test('令牌桶：rpm=3 连续取 3 个后，第 4 个被拒绝并给出 20 秒重试', () => {
  let state = fullTokenBucket(3, T0)
  for (let i = 0; i < 3; i++) {
    const take = takeToken(state, 3, T0)
    assert.equal(take.ok, true, '第 ' + (i + 1) + ' 个应放行')
    state = take.state
  }
  const rejected = takeToken(state, 3, T0)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.remaining, 0)
  // 3 个/分钟 = 每 20 秒补 1 个
  assert.equal(rejected.retryAfterSec, 20)
  // 被拒时也要把已补充的令牌写回，否则每次拒绝都从旧状态重算
  assert.equal(rejected.state.tokens, 0)
})

test('令牌桶：补充一部分后仍拒绝，但重试秒数变小', () => {
  let state = fullTokenBucket(3, T0)
  for (let i = 0; i < 3; i++) state = takeToken(state, 3, T0).state

  const after10s = takeToken(state, 3, T0 + 10_000)
  assert.equal(after10s.ok, false)
  assert.equal(after10s.retryAfterSec, 10) // 还差 0.5 个令牌
  assert.equal(after10s.state.tokens, 0.5)

  const after20s = takeToken(state, 3, T0 + 20_000)
  assert.equal(after20s.ok, true, '20 秒后应恢复 1 个令牌')
  assert.equal(after20s.remaining, 0)
})

test('令牌桶：惰性补充不会超过容量', () => {
  const state = fullTokenBucket(3, T0)
  const after = refillTokenBucket({ tokens: 0, updatedAt: T0 }, 3, T0 + 10 * 60_000)
  assert.equal(after.tokens, 3)
  // 满桶时再补充仍是满桶
  assert.equal(refillTokenBucket(state, 3, T0 + 60_000).tokens, 3)
})

test('令牌桶：时钟回拨不倒扣令牌', () => {
  const state: TokenBucketState = { tokens: 1.25, updatedAt: T0 }
  const after = refillTokenBucket(state, 3, T0 - 5_000)
  assert.equal(after.tokens, 1.25)
  assert.equal(after.updatedAt, T0 - 5_000)
})

test('令牌桶：同一时刻的并发消费只放行 capacity 个（原子性）', () => {
  // 纯函数按「读-算-写」串行模拟 Redis Lua 的原子执行：
  // 无论并发多少，同一时刻最多只能取走 capacity 个令牌。
  let shared = fullTokenBucket(3, T0)
  let passed = 0
  for (let i = 0; i < 50; i++) {
    const take = takeToken(shared, 3, T0)
    shared = take.state
    if (take.ok) passed++
  }
  assert.equal(passed, 3)
  assert.equal(shared.tokens, 0)
})

test('令牌桶：rpm=0 表示不限流（不消费也不报错）', () => {
  const take = takeToken(fullTokenBucket(0, T0), 0, T0)
  assert.equal(take.ok, true)
  assert.equal(take.remaining, -1)
  assert.equal(take.retryAfterSec, 0)
})

test('bucketFullAt 返回桶重新装满的时间', () => {
  assert.equal(bucketFullAt({ tokens: 3, updatedAt: T0 }, 3, T0), T0)
  // 空桶需要 60 秒补满
  assert.equal(bucketFullAt({ tokens: 0, updatedAt: T0 }, 3, T0), T0 + 60_000)
  // 只剩 1 个（缺 2 个）需要 40 秒
  assert.equal(bucketFullAt({ tokens: 1, updatedAt: T0 }, 3, T0), T0 + 40_000)
})
