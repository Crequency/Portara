import assert from 'node:assert/strict'
import { test } from 'node:test'

/**
 * 渠道并发闸门的**判定规则**（纯函数）。
 *
 * 只测 concurrencyRules.ts（不引用 Redis），避免测试进程被连接句柄挂住。
 * 这些规则一旦写反就会把整站请求挂死，所以必须单独钉住。
 */
import {
  QUEUE_POLL_MS,
  isSlotAvailable,
  queueBudgetExhausted
} from '../src/services/concurrencyRules.js'

test('limit=0 视为不限：永远有名额（默认行为不能被动到）', () => {
  assert.equal(isSlotAvailable(0, 0), true)
  assert.equal(isSlotAvailable(0, 999), true)
  assert.equal(isSlotAvailable(-1, 5), true)
})

test('limit>0：在途数小于上限才可进入，达到上限即满载', () => {
  assert.equal(isSlotAvailable(1, 0), true)
  assert.equal(isSlotAvailable(1, 1), false)
  assert.equal(isSlotAvailable(5, 4), true)
  assert.equal(isSlotAvailable(5, 5), false)
  assert.equal(isSlotAvailable(5, 6), false)
})

test('排队超时判定：到点即失败，未到点继续等', () => {
  const start = 1000
  assert.equal(queueBudgetExhausted(start, start + 0, 30000), false)
  assert.equal(queueBudgetExhausted(start, start + 29999, 30000), false)
  assert.equal(queueBudgetExhausted(start, start + 30000, 30000), true)
  assert.equal(queueBudgetExhausted(start, start + 30001, 30000), true)
})

test('排队轮询间隔：正数且不超过 200ms', () => {
  assert.ok(QUEUE_POLL_MS > 0)
  assert.ok(QUEUE_POLL_MS <= 200)
})
