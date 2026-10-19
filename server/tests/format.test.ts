import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatCompact, quotaColor, quotaPercent } from '../../web/src/format.js'

/**
 * 前端纯函数的测试。
 *
 * 放在 `server/tests/` 是因为 web 包没有测试设施（只有 vite/vue-tsc），
 * 而这些都是无 Vue、无 DOM 依赖的纯函数 —— 为它们单独引入一套前端测试栈
 * 不划算，借服务端的 `node:test` 跑即可。
 *
 * 这些函数看着简单，但都是**边界密集**的：量级分档、整数补零、
 * 进度条阈值。图表的坐标轴刻度直接吃它们的输出。
 */

test('formatCompact 按量级分档', () => {
  assert.equal(formatCompact(0), '0')
  assert.equal(formatCompact(999), '999')
  assert.equal(formatCompact(1000), '1k')
  assert.equal(formatCompact(1_500), '1.5k')
  assert.equal(formatCompact(1_000_000), '1M')
  assert.equal(formatCompact(1_234_567), '1.2M')
  assert.equal(formatCompact(1_000_000_000), '1B')
  assert.equal(formatCompact(6_747_248_763), '6.7B')
})

test('formatCompact 整数不补 .0（刻度线上的 375.0M 只是噪音）', () => {
  assert.equal(formatCompact(375_000_000), '375M')
  assert.equal(formatCompact(1_600_000_000), '1.6B')
  assert.equal(formatCompact(2_000), '2k')
})

test('formatCompact 超过十亿进位到 B（否则会成为 1125.0M）', () => {
  assert.equal(formatCompact(1_125_000_000), '1.1B')
  assert.equal(formatCompact(1_500_000_000), '1.5B')
})

test('formatCompact 对空值给出占位符而不是 NaN', () => {
  assert.equal(formatCompact(null), '—')
  assert.equal(formatCompact(undefined), '—')
})

test('quotaPercent 处理除零与越界', () => {
  assert.equal(quotaPercent(0, 0), 0)
  assert.equal(quotaPercent(5, 0), 0)
  assert.equal(quotaPercent(1, 4), 25)
  assert.equal(quotaPercent(4, 4), 100)
  // 上游偶尔会给出 used > total（口径不一致），进度条不能超过 100%
  assert.equal(quotaPercent(9, 4), 100)
})

test('quotaColor 按已用百分比分档，exceeded 优先', () => {
  const ACCENT = 'var(--accent)'
  const WARN = 'var(--warn)'
  const DANGER = 'var(--danger)'

  assert.equal(quotaColor(0), ACCENT)
  assert.equal(quotaColor(69), ACCENT)
  assert.equal(quotaColor(70), WARN)
  assert.equal(quotaColor(89), WARN)
  assert.equal(quotaColor(90), DANGER)
  assert.equal(quotaColor(100), DANGER)
  // 上游明确说超限 → 直接判红，不看百分比
  assert.equal(quotaColor(50, true), DANGER)
  assert.equal(quotaColor(0, true), DANGER)
})
