import assert from 'node:assert/strict'
import { test } from 'node:test'
import { orderByAdaptiveScore, scoreOf, type AdaptiveStat } from '../src/services/adaptive.js'

/**
 * 自适应选路的纯逻辑测试。
 *
 * 钉住四条：
 *   ① 分数随"成功率↑ / 延迟↓ / 压力↓"单调上升
 *   ② 未知数据给中性分（既不奖励也不惩罚）
 *   ③ 样本不足的渠道保持原位置，不被挤到末尾也不被抬高
 *   ④ 排序稳定：同分保持原相对顺序；绝不丢候选
 */

const stat = (patch: Partial<AdaptiveStat> = {}): AdaptiveStat => ({
  total: 100,
  errors: 0,
  p95Ms: 1000,
  ...patch
})

test('分数：成功率越高越高', () => {
  const good = scoreOf(stat({ errors: 0 })).score
  const bad = scoreOf(stat({ errors: 50 })).score
  assert.ok(good > bad, `${good} 应大于 ${bad}`)
})

test('分数：延迟越高越低', () => {
  const fast = scoreOf(stat({ p95Ms: 500 })).score
  const slow = scoreOf(stat({ p95Ms: 30000 })).score
  assert.ok(fast > slow)
})

test('分数：并发压力越大越低', () => {
  const idle = scoreOf(stat({ inflight: 0, limit: 8 })).score
  const full = scoreOf(stat({ inflight: 8, limit: 8 })).score
  assert.ok(idle > full)
})

test('分数：未知数据给中性 0.5，且标记 sampled=false', () => {
  assert.deepEqual(scoreOf(undefined), { score: 0.5, sampled: false })
  assert.deepEqual(scoreOf({ total: 0, errors: 0, p95Ms: 0 }), { score: 0.5, sampled: false })
})

test('排序：健康的排到最后失败的之前', () => {
  const items = [{ id: 'bad' }, { id: 'good' }]
  const stats = new Map<string, AdaptiveStat>([
    ['bad', stat({ errors: 90 })],
    ['good', stat({ errors: 0, p95Ms: 800 })]
  ])
  const out = orderByAdaptiveScore(items, (i) => i.id, stats, 10)
  assert.deepEqual(out.map((i) => i.id), ['good', 'bad'])
})

test('排序：样本不足的保持原位置（不参与重排）', () => {
  const items = [{ id: 'few' }, { id: 'good' }, { id: 'bad' }]
  const stats = new Map<string, AdaptiveStat>([
    ['few', { total: 3, errors: 0, p95Ms: 100 }], // 少于 minSamples=10
    ['good', stat({ errors: 0, p95Ms: 800 })],
    ['bad', stat({ errors: 90 })]
  ])
  const out = orderByAdaptiveScore(items, (i) => i.id, stats, 10)
  // 有样本的两个按分数排在前，样本不足的接在后面保持原顺序
  assert.deepEqual(out.map((i) => i.id), ['good', 'bad', 'few'])
})

test('排序：同分保持原相对顺序（稳定）', () => {
  const items = [{ id: 'a' }, { id: 'b' }]
  const same = new Map<string, AdaptiveStat>([
    ['a', stat()],
    ['b', stat()]
  ])
  assert.deepEqual(orderByAdaptiveScore(items, (i) => i.id, same, 10).map((i) => i.id), ['a', 'b'])
})

test('排序：绝不丢候选', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const out = orderByAdaptiveScore(items, (i) => i.id, new Map(), 10)
  assert.equal(out.length, 3)
  assert.deepEqual(out.map((i) => i.id).sort(), ['a', 'b', 'c'])
})

test('排序：单元素 / 空输入原样返回', () => {
  assert.deepEqual(orderByAdaptiveScore([], () => '', new Map(), 10), [])
  assert.deepEqual(orderByAdaptiveScore([{ id: 'x' }], (i) => i.id, new Map(), 10).map((i) => i.id), ['x'])
})
