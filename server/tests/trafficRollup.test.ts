import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  GLOBAL_SCOPE,
  rollupIntervalMs,
  userScope
} from '../src/services/trafficRollup.js'

/*
 * 汇总表的**纯逻辑**部分：周期解析与 scope 拼装。
 *
 * 数据库路径（重建 / 读取 / 回退）属于集成行为，由冒烟脚本覆盖 ——
 * 这里只钉住「配置解析不会悄悄变成 0 导致每个 tick 全表扫」与
 * 「两种作用域的 key 不会撞」。
 */

test('rollupIntervalMs：未配置时默认 1 小时', () => {
  assert.equal(rollupIntervalMs(undefined), 60 * 60 * 1000)
})

test('rollupIntervalMs：空串 / 非法值 / 0 / 负数都回落到 1 小时', () => {
  assert.equal(rollupIntervalMs(''), 60 * 60 * 1000)
  assert.equal(rollupIntervalMs('abc'), 60 * 60 * 1000)
  assert.equal(rollupIntervalMs('0'), 60 * 60 * 1000)
  assert.equal(rollupIntervalMs('-30'), 60 * 60 * 1000)
})

test('rollupIntervalMs：正常秒数按毫秒返回', () => {
  assert.equal(rollupIntervalMs('1800'), 1_800_000)
  assert.equal(rollupIntervalMs('3600'), 3_600_000)
})

test('rollupIntervalMs：小于 60 秒被抬到 60 秒（防止几乎每 tick 全表扫）', () => {
  assert.equal(rollupIntervalMs('1'), 60_000)
  assert.equal(rollupIntervalMs('59'), 60_000)
})

test('scope：global 与 user:<uuid> 不冲突，且带前缀', () => {
  assert.equal(GLOBAL_SCOPE, 'global')
  const id = '11111111-2222-4333-8444-555555555555'
  assert.equal(userScope(id), 'user:' + id)
  assert.notEqual(userScope(id), GLOBAL_SCOPE)
  // 两个不同用户不会落到同一个 key
  assert.notEqual(userScope(id), userScope('99999999-8888-4777-8666-555555555555'))
})
