import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  QUOTA_COOLDOWN_CAP_SEC,
  QUOTA_EXHAUSTED_KEYWORDS,
  QUOTA_COOLDOWN_LADDER_SEC,
  decideQuotaCooldown,
  formatQuotaCooldown,
  isQuotaExhaustionResponse,
  parseQuotaResetAt,
  quotaCooldownSecForLevel,
  quotaCooldownWithReset
} from '../src/services/quotaSignal.js'

/**
 * 「额度用尽」的识别与阶梯冷冻。
 *
 * 这段逻辑决定账户被踢出选路多久，误判代价很高 —— 全部用固定夹具，
 * 不连数据库、不读环境。
 */

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)

/**
 * 真实上游（OpenDesign）返回的 402 原文 —— 取自线上日志，一字未改。
 *
 * 这份 body 是本次修复的起点：旧关键词表（insufficient_quota / quota exhausted
 * / 余额不足…）**一个都不命中**，于是它走了普通失败冷却，1 小时后又打了同一个
 * 已用尽的上游账户，24 小时内重复出现 29 次。
 */
const REAL_CODING_PLAN_402 = JSON.stringify({
  error: {
    code: 'insufficient_balance',
    details: { coding_plan_exhausted: true, reset_at: '2026-11-08T06:48:58Z' },
    message:
      '[code=insufficient_balance] Coding Plan quota is exhausted and wallet balance is insufficient.'
  }
})

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

test('识别：400 + insufficient credits（CommandCode 的真实形态）', () => {
  const body =
    '{"error":{"message":"You have insufficient credits to make this request. Please purchase more credits."}}'
  assert.equal(isQuotaExhaustionResponse(400, body), true)
})

test('误判防护：400 只有命中额度关键词才算，普通参数错误不算', () => {
  assert.equal(
    isQuotaExhaustionResponse(
      400,
      '{"error":{"message":"invalid request: messages is required","type":"invalid_request_error"}}'
    ),
    false
  )
  assert.equal(isQuotaExhaustionResponse(400, '{"error":{"message":"bad model"}}'), false)
})

test('误判防护：其它状态码一律不识别（401/403/500/200）', () => {
  const quotaBody = '{"error":{"code":"insufficient_quota"}}'
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

test('识别：真实 402 「coding plan 额度用尽」body', () => {
  assert.equal(isQuotaExhaustionResponse(402, REAL_CODING_PLAN_402), true)
  // 429 同样成立（有的上游把 402 报成 429）
  assert.equal(isQuotaExhaustionResponse(429, REAL_CODING_PLAN_402), true)
})

test('识别：本次补的 6 个关键词各自都能单独命中', () => {
  for (const kw of [
    'insufficient_balance',
    'coding_plan',
    'coding plan',
    'quota is exhausted',
    'wallet balance is insufficient',
    'plan quota'
  ]) {
    assert.ok(QUOTA_EXHAUSTED_KEYWORDS.includes(kw), `关键词表缺少 ${kw}`)
    assert.equal(
      isQuotaExhaustionResponse(402, `{"error":{"message":"${kw.toUpperCase()}"}}`),
      true,
      kw
    )
  }
})

test('误判防护：普通 429 rate limit 不因新增关键词而误判', () => {
  assert.equal(
    isQuotaExhaustionResponse(429, '{"error":{"message":"rate limit exceeded"}}'),
    false
  )
  assert.equal(
    isQuotaExhaustionResponse(429, '{"error":{"message":"timeout, please retry"}}'),
    false
  )
})

test('误判防护：真实额度 body 配 500 不算额度用尽', () => {
  assert.equal(isQuotaExhaustionResponse(500, REAL_CODING_PLAN_402), false)
  assert.equal(isQuotaExhaustionResponse(503, REAL_CODING_PLAN_402), false)
})

test('reset_at：从 error.details.reset_at 解析 ISO 8601', () => {
  assert.equal(
    parseQuotaResetAt(REAL_CODING_PLAN_402),
    Date.UTC(2026, 10, 8, 6, 48, 58)
  )
})

test('reset_at：顶层 reset_at / 秒级时间戳也能解析', () => {
  assert.equal(
    parseQuotaResetAt('{"error":{"reset_at":"2026-11-09T00:00:00Z"}}'),
    Date.UTC(2026, 10, 9, 0, 0, 0)
  )
  // 10 位数字 = 秒级时间戳
  assert.equal(
    parseQuotaResetAt('{"details":{"reset_at":1791859267}}'),
    1791859267 * 1000
  )
})

test('reset_at：没有 reset_at 时退回 Retry-After（秒数 / HTTP-date）', () => {
  assert.equal(parseQuotaResetAt('{"error":{"message":"busy"}}', '120', NOW), NOW + 120_000)
  assert.equal(
    parseQuotaResetAt('', String(new Date(NOW + 60_000).toUTCString()), NOW),
    // toUTCString 只精确到秒；它们本来就对齐到整秒
    NOW + 60_000
  )
})

test('reset_at：响应体优先于 Retry-After', () => {
  assert.equal(
    parseQuotaResetAt(REAL_CODING_PLAN_402, '60', NOW),
    Date.UTC(2026, 10, 8, 6, 48, 58)
  )
})

test('reset_at：解析失败 / 空响应返回 null', () => {
  assert.equal(parseQuotaResetAt(''), null)
  assert.equal(parseQuotaResetAt('not json at all'), null)
  assert.equal(parseQuotaResetAt('{"details":{"reset_at":"not-a-date"}}'), null)
  assert.equal(parseQuotaResetAt('{"details":{}}', 'soon'), null)
})

test('冷却：reset_at 比阶梯更远时作为下限（max）', () => {
  // 第 1 档 5m；reset_at 还有 10 分钟 → 取 10 分钟
  assert.equal(quotaCooldownWithReset(1, NOW + 600_000, NOW), 600)
  // 第 1 档 5m；reset_at 只剩 100 秒 → 仍取阶梯的 5m，不被缩短
  assert.equal(quotaCooldownWithReset(1, NOW + 100_000, NOW), 300)
  // 第 4 档 2h；reset_at 10 分钟 → 阶梯更大
  assert.equal(quotaCooldownWithReset(4, NOW + 600_000, NOW), 7200)
  // 第 4 档 2h；reset_at 5 小时 → 取 5 小时
  assert.equal(quotaCooldownWithReset(4, NOW + 5 * 3600_000, NOW), 5 * 3600)
})

test('冷却：reset_at 超过 3d 时被截断到 3d', () => {
  assert.equal(quotaCooldownWithReset(1, NOW + 10 * 24 * 3600_000, NOW), 3 * 24 * 3600)
  assert.equal(QUOTA_COOLDOWN_CAP_SEC, 259_200)
})

test('冷却：reset_at 已过期 / 非法时回落到阶梯值', () => {
  assert.equal(quotaCooldownWithReset(1, NOW - 1_000, NOW), 300)
  assert.equal(quotaCooldownWithReset(1, null, NOW), 300)
  assert.equal(quotaCooldownWithReset(1, undefined, NOW), 300)
  assert.equal(quotaCooldownWithReset(2, 'not-a-date', NOW), 900)
  assert.equal(quotaCooldownWithReset(7, NOW - 1_000, NOW), 259_200)
  assert.equal(quotaCooldownWithReset(99, NOW - 1_000, NOW), 259_200)
})

test('冷却：decideQuotaCooldown 的首次命中同样尊重 reset_at', () => {
  assert.deepEqual(decideQuotaCooldown(0, null, NOW, NOW + 20 * 60_000), {
    applies: true,
    level: 1,
    secs: 1200
  })
})

test('日志时长格式：5m / 2h / 3d', () => {
  assert.equal(formatQuotaCooldown(300), '5m')
  assert.equal(formatQuotaCooldown(7200), '2h')
  assert.equal(formatQuotaCooldown(259200), '3d')
  assert.equal(formatQuotaCooldown(45), '45s')
})
