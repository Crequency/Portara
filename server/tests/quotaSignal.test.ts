import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  QUOTA_COOLDOWN_LADDER_SEC,
  decideQuotaCooldown,
  formatQuotaCooldown,
  isQuotaExhaustionResponse,
  quotaCooldownSecForLevel
} from '../src/services/quotaSignal.js'

/**
 * 「额度用尽」的识别与阶梯冷冻。
 *
 * 这段逻辑决定账户被踢出选路多久，误判代价很高 —— 全部用固定夹具，
 * 不连数据库、不读环境。
 */

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)

test('冷冻阶梯：第 1..7 次分别 5m/15m/45m/2h/12h/24h/3d', () => {
  assert.deepEqual([...QUOTA_COOLDOWN_LADDER_SEC], [
    300, 900, 2700, 7200, 43200, 86400, 259200
  ])
  for (let level = 1; level <= 7; level++) {
    assert.equal(quotaCooldownSecForLevel(level), QUOTA_COOLDOWN_LADDER_SEC[level - 1])
  }
})

test('冷冻阶梯：第 8 次及以后封顶 3d，非法等级按第 1 次算', () => {
  assert.equal(quotaCooldownSecForLevel(8), 259200)
  assert.equal(quotaCooldownSecForLevel(9), 259200)
  assert.equal(quotaCooldownSecForLevel(100), 259200)
  assert.equal(quotaCooldownSecForLevel(0), 300)
  assert.equal(quotaCooldownSecForLevel(-5), 300)
})

test('幂等：从未冷冻 → level 1、5m', () => {
  const d = decideQuotaCooldown(0, null, NOW)
  assert.deepEqual(d, { applies: true, level: 1, secs: 300 })
})

test('幂等：冷冻期内重复命中 → 不递增、不延长', () => {
  const until = new Date(NOW + 600_000)
  const d = decideQuotaCooldown(3, until, NOW)
  assert.equal(d.applies, false)
  assert.equal(d.level, 3)
  assert.equal(d.secs, 600)
})

test('幂等：冷冻过期后再次命中 → level+1 并重新计时', () => {
  const expired = new Date(NOW - 1_000)
  const d = decideQuotaCooldown(3, expired, NOW)
  assert.deepEqual(d, { applies: true, level: 4, secs: 7200 })
})

test('幂等：到期时刻不算冷冻期（边界）', () => {
  const d = decideQuotaCooldown(1, new Date(NOW), NOW)
  assert.equal(d.applies, true)
  assert.equal(d.level, 2)
  assert.equal(d.secs, 900)
})

test('识别：429 + insufficient_quota', () => {
  assert.equal(
    isQuotaExhaustionResponse(
      429,
      JSON.stringify({
        error: { code: 'insufficient_quota', message: 'You exceeded your current quota' }
      })
    ),
    true
  )
})

test('识别：402 + credit balance is too low', () => {
  assert.equal(
    isQuotaExhaustionResponse(402, '{"error":{"message":"Your credit balance is too low"}}'),
    true
  )
})

test('识别：常见英文与中文关键词', () => {
  for (const [status, text] of [
    [429, 'quota_exceeded'],
    [429, 'quota exhausted'],
    [429, 'billing_hard_limit_reached'],
    [402, '余额不足'],
    [429, '额度已用尽'],
    [402, '额度不足'],
    [429, '配额已用完'],
    [429, '当前请求的额度已超限']
  ] as const) {
    assert.equal(isQuotaExhaustionResponse(status, text), true, `${status} ${text}`)
  }
})

test('误判防护：非 402/429 一律不识别（403 也排除）', () => {
  const quotaBody = '{"error":{"code":"insufficient_quota"}}'
  assert.equal(isQuotaExhaustionResponse(400, quotaBody), false)
  assert.equal(isQuotaExhaustionResponse(401, quotaBody), false)
  assert.equal(isQuotaExhaustionResponse(403, quotaBody), false)
  assert.equal(isQuotaExhaustionResponse(500, quotaBody), false)
  assert.equal(isQuotaExhaustionResponse(200, quotaBody), false)
})

test('误判防护：普通限流 / 空响应不识别', () => {
  assert.equal(isQuotaExhaustionResponse(429, 'rate limit exceeded'), false)
  assert.equal(isQuotaExhaustionResponse(429, 'too many requests'), false)
  assert.equal(isQuotaExhaustionResponse(429, ''), false)
  assert.equal(isQuotaExhaustionResponse(402, '{"error":{"message":"payment method declined"}}'), false)
})

test('日志时长格式：5m / 2h / 3d', () => {
  assert.equal(formatQuotaCooldown(300), '5m')
  assert.equal(formatQuotaCooldown(7200), '2h')
  assert.equal(formatQuotaCooldown(259200), '3d')
  assert.equal(formatQuotaCooldown(45), '45s')
})
