import assert from 'node:assert/strict'
import { test } from 'node:test'

/**
 * 账户失败冷却的两套计时。
 *
 * 事故背景（2026-11-09）：OpenDesign 的一个健康账号因为一次 `fetch failed`
 * 被打进设置项里的 1 小时通用冷却；同一时间其它账号是**真·额度用尽**，
 * 于是整条链路只剩"额度已用尽"这一种错误，用户连续多次请求全失败。
 *
 * 这里钉住的规则：
 *   - 网络错误用**阶梯退避**（30s 起），并且永远不超过设置项上限；
 *   - 设置项配得再大，网络错误也不会被放大成"一小时禁足"；
 *   - 客户端主动断开**不写冷却**（由调用点保证，见 v1.ts）。
 */
import { COOLDOWN, networkFailureCooldownSec } from '../src/services/accounts.js'

test('网络退避：连续失败 0–4 次依次 30s / 60s / 120s / 240s / 480s', () => {
  const cap = 3600
  assert.equal(networkFailureCooldownSec(0, cap), 30)
  assert.equal(networkFailureCooldownSec(1, cap), 60)
  assert.equal(networkFailureCooldownSec(2, cap), 120)
  assert.equal(networkFailureCooldownSec(3, cap), 240)
  assert.equal(networkFailureCooldownSec(4, cap), 480)
})

test('网络退避：超过 4 次后封顶在 480s，不再翻倍', () => {
  const cap = 3600
  assert.equal(networkFailureCooldownSec(5, cap), 480)
  assert.equal(networkFailureCooldownSec(99, cap), 480)
})

test('网络退避：受设置项上限约束（设置得更小时取设置值）', () => {
  assert.equal(networkFailureCooldownSec(4, 100), 100)
  assert.equal(networkFailureCooldownSec(0, 10), COOLDOWN.upstream)
})

test('网络退避：绝不小于 COOLDOWN.upstream（下限 30s，防抖）', () => {
  for (const n of [0, 1, 2, 3, 4, 10]) {
    assert.ok(networkFailureCooldownSec(n, 3600) >= COOLDOWN.upstream)
  }
})

test('网络退避：默认设置下远小于通用冷却（回归保护）', () => {
  // 事故的核心断言：一次抖动的冷却必须显著小于设置项的 3600s
  assert.ok(networkFailureCooldownSec(0, 3600) <= 60)
})

test('网络退避：负数 / 小数不会算出非法值', () => {
  assert.ok(networkFailureCooldownSec(-3, 3600) >= COOLDOWN.upstream)
  assert.ok(Number.isFinite(networkFailureCooldownSec(1.7, 3600)))
})
