import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  balanceBelow,
  computeMoneyCost,
  decideReservation,
  estimateBilledAmount,
  estimateTokens,
  isNearLimit,
  isZeroRate,
  lowBalanceThreshold,
  mergeRuleThresholds,
  pickBestRate,
  planAllowsBilling,
  planIsUnlimited,
  planSettlement,
  settlementBilledAmount,
  rateSpecificity,
  round6,
  round8,
  toBilledAmount,
  windowExceeded,
  windowResetAt,
  windowStart,
  type RateLike
} from '../src/services/billingPure.js'

function rate(partial: Partial<RateLike> & { upstreamModel: string }): RateLike {
  return {
    id: partial.upstreamModel || 'global',
    channelId: 'ch-1',
    upstreamModel: partial.upstreamModel,
    currency: 'USD',
    inputPerMtok: 0,
    outputPerMtok: 0,
    perRequest: 0,
    ...partial
  }
}

// ------------------------------------------------------------ 费率优先级

test('费率优先级：精确 (渠道+模型) 压过渠道默认与全局默认', () => {
  const rows = [
    rate({ channelId: 'ch-1', upstreamModel: 'gpt-4o', inputPerMtok: 100 }),
    rate({ channelId: 'ch-1', upstreamModel: '', inputPerMtok: 50 }),
    rate({ channelId: null, upstreamModel: '', inputPerMtok: 10 })
  ]
  const picked = pickBestRate(rows, 'ch-1', 'gpt-4o')
  assert.equal(picked?.inputPerMtok, 100)
})

test('费率优先级：没有精确项时取渠道默认，而不是全局默认', () => {
  const rows = [
    rate({ channelId: 'ch-1', upstreamModel: 'other', inputPerMtok: 999 }),
    rate({ channelId: 'ch-1', upstreamModel: '', inputPerMtok: 50 }),
    rate({ channelId: null, upstreamModel: '', inputPerMtok: 10 })
  ]
  const picked = pickBestRate(rows, 'ch-1', 'gpt-4o')
  assert.equal(picked?.inputPerMtok, 50)
})

test('费率优先级：只有全局默认时回落到全局，且不误取别的渠道', () => {
  const rows = [
    rate({ channelId: 'ch-2', upstreamModel: '', inputPerMtok: 77 }),
    rate({ channelId: null, upstreamModel: '', inputPerMtok: 10 })
  ]
  const picked = pickBestRate(rows, 'ch-1', 'gpt-4o')
  assert.equal(picked?.inputPerMtok, 10)
})

test('费率优先级：全无匹配时返回 null（调用方合成全 0 费率）', () => {
  assert.equal(pickBestRate([], 'ch-1', 'gpt-4o'), null)
  assert.equal(
    pickBestRate([rate({ channelId: 'ch-2', upstreamModel: '' })], 'ch-1', 'gpt-4o'),
    null
  )
})

test('rateSpecificity：精确 3 / 渠道默认 2 / 全局 1 / 无关 0', () => {
  assert.equal(rateSpecificity(rate({ upstreamModel: 'm' }), 'ch-1', 'm'), 3)
  assert.equal(rateSpecificity(rate({ upstreamModel: '' }), 'ch-1', 'm'), 2)
  assert.equal(
    rateSpecificity(rate({ channelId: null, upstreamModel: '' }), 'ch-1', 'm'),
    1
  )
  assert.equal(rateSpecificity(rate({ upstreamModel: 'other' }), 'ch-1', 'm'), 0)
})

// ------------------------------------------------------------ 成本与单位换算

test('computeMoneyCost：输入/输出按百万 token 单价 + 每请求固定费', () => {
  const cost = computeMoneyCost(
    { inputTokens: 1_000_000, outputTokens: 500_000, requests: 1 },
    { inputPerMtok: 2, outputPerMtok: 4, perRequest: 0.01 }
  )
  // 1e6/1e6*2 + 0.5e6/1e6*4 + 0.01 = 2 + 2 + 0.01
  assert.equal(cost, 4.01)
})

test('computeMoneyCost：per_request 按请求数乘，0 请求不收固定费', () => {
  const usage = { inputTokens: 0, outputTokens: 0 }
  const r = { inputPerMtok: 0, outputPerMtok: 0, perRequest: 0.02 }
  assert.equal(computeMoneyCost({ ...usage, requests: 3 }, r), 0.06)
  assert.equal(computeMoneyCost({ ...usage, requests: 0 }, r), 0)
})

test('computeMoneyCost：负 token 归零，结果保留 8 位', () => {
  const cost = computeMoneyCost(
    { inputTokens: -5, outputTokens: 1, requests: 1 },
    { inputPerMtok: 1, outputPerMtok: 1, perRequest: 0 }
  )
  assert.equal(cost, 0.000001)
  assert.equal(round8(0.000000001), 0)
})

test('toBilledAmount：money 直接扣金额', () => {
  assert.equal(toBilledAmount(1.2345678, { unit: 'money', creditsPerCurrency: 100 }, 999), 1.234568)
})

test('toBilledAmount：credits 按 credits_per_currency 换算', () => {
  assert.equal(
    toBilledAmount(0.5, { unit: 'credits', creditsPerCurrency: 100 }, 0),
    50
  )
  assert.equal(
    toBilledAmount(0.5, { unit: 'credits', creditsPerCurrency: 10.5 }, 0),
    5.25
  )
})

test('toBilledAmount：tokens 直接扣 total_tokens，与金额无关', () => {
  assert.equal(toBilledAmount(123.45, { unit: 'tokens', creditsPerCurrency: 100 }, 18), 18)
  assert.equal(toBilledAmount(0, { unit: 'tokens', creditsPerCurrency: 100 }, 0), 0)
})

test('round6 保留 6 位，避免浮点尾巴进入余额', () => {
  assert.equal(round6(0.1 + 0.2), 0.3)
  assert.equal(round6(1.2345678), 1.234568)
})

// ------------------------------------------------------------ 窗口

const NOW = new Date(2026, 4, 15, 13, 30, 0) // 2026-05-15（周五）本地 13:30

test('窗口起点：5h / 7d / 30d 是滚动窗口', () => {
  assert.equal(windowStart('5h', NOW).getTime(), NOW.getTime() - 5 * 3600_000)
  assert.equal(windowStart('7d', NOW).getTime(), NOW.getTime() - 7 * 86400_000)
  assert.equal(windowStart('30d', NOW).getTime(), NOW.getTime() - 30 * 86400_000)
})

test('窗口起点：1d 取当地 00:00', () => {
  const start = windowStart('1d', NOW)
  assert.equal(start.getFullYear(), 2026)
  assert.equal(start.getMonth(), 4)
  assert.equal(start.getDate(), 15)
  assert.equal(start.getHours(), 0)
  assert.equal(start.getMinutes(), 0)
})

test('窗口起点：1w 取当地本周一 00:00（周日归一）', () => {
  const start = windowStart('1w', NOW)
  assert.equal(start.getDay(), 1)
  assert.equal(start.getDate(), 11)
  assert.equal(start.getHours(), 0)
  // 周日当天也应回到上一个周一，而不是跳到下一周
  const sunday = new Date(2026, 4, 17, 9, 0, 0)
  assert.equal(windowStart('1w', sunday).getDate(), 11)
})

test('窗口起点：1mo 取当地本月 1 日 00:00', () => {
  const start = windowStart('1mo', NOW)
  assert.equal(start.getFullYear(), 2026)
  assert.equal(start.getMonth(), 4)
  assert.equal(start.getDate(), 1)
  assert.equal(start.getHours(), 0)
})

test('窗口重置：日历窗口取下一周期边界，滚动窗口取起点 + 长度', () => {
  assert.equal(windowResetAt('1d', NOW).getDate(), 16)
  assert.equal(windowResetAt('1d', NOW).getHours(), 0)
  assert.equal(windowResetAt('1w', NOW).getDate(), 18)
  assert.equal(windowResetAt('1mo', NOW).getMonth(), 5)
  assert.equal(windowResetAt('1mo', NOW).getDate(), 1)
  assert.equal(windowResetAt('5h', NOW).getTime(), windowStart('5h', NOW).getTime() + 5 * 3600_000)
})

// ------------------------------------------------------------ 规则合并与幂等

test('多模板规则按窗口取最严（阈值最小）', () => {
  const merged = mergeRuleThresholds([
    { window: '5h', threshold: 10 },
    { window: '5h', threshold: 3 },
    { window: '1d', threshold: 100 }
  ])
  assert.deepEqual(merged.map((m) => [m.window, m.threshold]), [
    ['5h', 3],
    ['1d', 100]
  ])
})

test('阈值 <= 0 视为不限，不参与判定', () => {
  const merged = mergeRuleThresholds([
    { window: '5h', threshold: 0 },
    { window: '1d', threshold: -1 }
  ])
  assert.deepEqual(merged, [])
})

test('windowExceeded：用满即超限', () => {
  assert.equal(windowExceeded(9.999, 10), false)
  assert.equal(windowExceeded(10, 10), true)
  assert.equal(windowExceeded(0.01, 10), false)
  assert.equal(windowExceeded(1, 0), false)
})

test('结算幂等：已标记 billing_charged_at 的日志不再扣第二次', () => {
  const first = planSettlement({ billingChargedAt: null }, 0.25, 10)
  assert.deepEqual(first, { apply: true, duplicate: false, delta: -0.25, balanceAfter: 9.75 })

  const second = planSettlement({ billingChargedAt: '2026-05-15T00:00:00Z' }, 0.25, 9.75)
  assert.deepEqual(second, { apply: false, duplicate: true, delta: 0, balanceAfter: 9.75 })
})

test('结算幂等：余额允许扣成负数（最后一笔语义）', () => {
  const result = planSettlement({ billingChargedAt: null }, 2, 1)
  assert.equal(result.apply, true)
  assert.equal(result.delta, -2)
  assert.equal(result.balanceAfter, -1)
})


// ------------------------------------------------------------ 预检预留（防并发透支）

test('estimateTokens：缺省按 1024 输入 + 1024 输出估算', () => {
  assert.deepEqual(estimateTokens({}), { inputTokens: 1024, outputTokens: 1024 })
  assert.deepEqual(estimateTokens({ maxTokens: 256 }), { inputTokens: 1024, outputTokens: 256 })
})

test('estimateTokens：非法 max_tokens 回退默认值，小数向上取整', () => {
  for (const value of [0, -1, Number.NaN, 'abc', undefined, null]) {
    assert.equal(estimateTokens({ maxTokens: value }).outputTokens, 1024)
  }
  assert.equal(estimateTokens({ maxTokens: 12.2 }).outputTokens, 13)
})

const EST_RATE = { inputPerMtok: 1, outputPerMtok: 2, perRequest: 0.01 }
const EST_PLAN = { unit: 'money' as const, creditsPerCurrency: 100 }

test('estimateBilledAmount：money 套餐按费率算（1024 输入 + max_tokens 输出 + 每请求费）', () => {
  // 1024/1e6*1 + 1024/1e6*2 + 0.01 = 0.013072
  assert.equal(estimateBilledAmount({ rate: EST_RATE, plan: EST_PLAN }), 0.013072)
  // max_tokens = 100：0.001024 + 0.0002 + 0.01 = 0.011224
  assert.equal(
    estimateBilledAmount({ maxTokens: 100, rate: EST_RATE, plan: EST_PLAN }),
    0.011224
  )
})

test('estimateBilledAmount：credits 按兑换率换算，tokens 按预估总 token 数', () => {
  assert.equal(
    estimateBilledAmount({
      rate: EST_RATE,
      plan: { unit: 'credits', creditsPerCurrency: 100 }
    }),
    1.3072
  )
  assert.equal(
    estimateBilledAmount({
      rate: EST_RATE,
      plan: { unit: 'tokens', creditsPerCurrency: 100 }
    }),
    2048
  )
})

test('decideReservation：available = balance - reserved，够才放行', () => {
  const first = decideReservation({ balance: 10, reserved: 0 }, 0.5)
  assert.deepEqual(
    {
      ok: first.ok,
      available: first.available,
      reservedAfter: first.reservedAfter,
      availableAfter: first.availableAfter,
      shortfall: first.shortfall
    },
    { ok: true, available: 10, reservedAfter: 0.5, availableAfter: 9.5, shortfall: 0 }
  )
})

test('decideReservation：并发第二个请求看到第一个的预留后被拒', () => {
  const second = decideReservation({ balance: 10, reserved: 9.8 }, 0.5)
  assert.equal(second.ok, false)
  assert.equal(second.available, 0.2)
  assert.equal(second.shortfall, 0.3)
  assert.equal(second.reservedAfter, 9.8)
  assert.equal(second.availableAfter, 0.2)
})

test('decideReservation：余额 <= 0 一律拒绝（0 成本请求也一样）', () => {
  assert.equal(decideReservation({ balance: 0, reserved: 0 }, 0).ok, false)
  assert.equal(decideReservation({ balance: 0, reserved: 0 }, 0.01).ok, false)
  // 已透支（负数）同样拒绝
  assert.equal(decideReservation({ balance: -1, reserved: 0 }, 0).ok, false)
})

test('planAllowsBilling：未绑 / 停用套餐都视为 no_plan', () => {
  assert.equal(planAllowsBilling(null), false)
  assert.equal(planAllowsBilling(undefined), false)
  assert.equal(planAllowsBilling({ status: 'disabled' }), false)
  assert.equal(planAllowsBilling({ status: 'active' }), true)
})

test('unlimited 套餐：预检短路（不查余额 / 限额）', () => {
  // 预检命中 unlimited 后不再进入余额与窗口判定；纯函数只负责识别标记。
  assert.equal(planIsUnlimited({ unlimited: true }), true)
  assert.equal(planIsUnlimited({ unlimited: false }), false)
  assert.equal(planIsUnlimited({}), false)
  assert.equal(planIsUnlimited(null), false)
  assert.equal(planIsUnlimited(undefined), false)
})

test('unlimited 套餐：结算金额恒为 0（成本 / 售价仍由 request_logs 记录）', () => {
  const unlimitedMoney = {
    unit: 'money' as const,
    creditsPerCurrency: 100,
    unlimited: true
  }
  assert.equal(settlementBilledAmount(unlimitedMoney, 12.345678, 999), 0)
  assert.equal(
    settlementBilledAmount(
      { unit: 'credits', creditsPerCurrency: 100, unlimited: true },
      2,
      0
    ),
    0
  )
  assert.equal(
    settlementBilledAmount(
      { unit: 'tokens', creditsPerCurrency: 100, unlimited: true },
      2,
      2048
    ),
    0
  )
  // 非 unlimited 仍按原单位换算，证明短路只对 Infinity 生效
  assert.equal(settlementBilledAmount({ ...unlimitedMoney, unlimited: false }, 2, 999), 2)
  assert.equal(
    settlementBilledAmount(
      { unit: 'tokens', creditsPerCurrency: 100, unlimited: false },
      2,
      2048
    ),
    2048
  )
})

test('isNearLimit：任一窗口 used/limit >= 0.9', () => {
  assert.equal(isNearLimit([{ used: 9, limit: 10 }]), true)
  assert.equal(isNearLimit([{ used: 8.99, limit: 10 }]), false)
  assert.equal(isNearLimit([{ used: 0.009, limit: 0.01 }]), true)
  assert.equal(isNearLimit([{ used: 100, limit: 0 }]), false)
})

test('isZeroRate：三项全 0 才算全 0 费率', () => {
  assert.equal(isZeroRate({ inputPerMtok: 0, outputPerMtok: 0, perRequest: 0 }), true)
  assert.equal(isZeroRate({ inputPerMtok: 0, outputPerMtok: 0, perRequest: 0.000001 }), false)
  assert.equal(isZeroRate({ inputPerMtok: 1, outputPerMtok: 0, perRequest: 0 }), false)
})

test('lowBalanceThreshold：金额直用，credits 按兑换率换算', () => {
  assert.equal(lowBalanceThreshold(1, { unit: 'money', creditsPerCurrency: 100 }), 1)
  assert.equal(lowBalanceThreshold(1, { unit: 'credits', creditsPerCurrency: 100 }), 100)
  assert.equal(lowBalanceThreshold(1, null), 1)
  assert.equal(balanceBelow(0.5, 1), true)
  assert.equal(balanceBelow(1, 1), false)
})
