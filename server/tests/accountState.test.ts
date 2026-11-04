import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyAccountState,
  orderByDegradation,
  type AccountState,
  type ClassifiableAccount
} from '../src/services/accountState.js'

/**
 * 账户四分类与退化阶梯 —— 纯函数测试。
 *
 * 重点钉住两条容易写反的规则：
 *   ① 同时命中「硬限额」与「额度冷冻」时归 usageLimited（硬事实优先）
 *   ② 退化阶梯：ok → quotaCooling → genericCooling → usageLimited
 */

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)
const FUTURE = new Date(NOW + 60_000)
const PAST = new Date(NOW - 60_000)

interface Item extends ClassifiableAccount {
  id: string
}

function acct(id: string, patch: Partial<ClassifiableAccount> = {}): Item {
  return {
    id,
    quota_exhausted: false,
    window_exhausted: false,
    quota_cooldown_until: null,
    cooldown_until: null,
    ...patch
  }
}

test('分类：四类各归其位', () => {
  assert.equal(classifyAccountState(acct('a'), NOW, true), 'ok')
  assert.equal(
    classifyAccountState(acct('a', { quota_exhausted: true }), NOW, true),
    'usageLimited'
  )
  assert.equal(
    classifyAccountState(acct('a', { quota_cooldown_until: FUTURE }), NOW, true),
    'quotaCooling'
  )
  assert.equal(
    classifyAccountState(acct('a', { cooldown_until: FUTURE }), NOW, true),
    'genericCooling'
  )
})

test('分类：window_exhausted 受 skipWindows 开关控制', () => {
  const win = acct('a', { window_exhausted: true })
  assert.equal(classifyAccountState(win, NOW, true), 'usageLimited')
  assert.equal(classifyAccountState(win, NOW, false), 'ok')
})

test('分类：过期的冷冻不再算冷却', () => {
  assert.equal(
    classifyAccountState(acct('a', { quota_cooldown_until: PAST }), NOW, true),
    'ok'
  )
  assert.equal(classifyAccountState(acct('a', { cooldown_until: PAST }), NOW, true), 'ok')
})

test('双命中：usageLimited 与 quotaCooling 同时成立 → 归 usageLimited', () => {
  assert.equal(
    classifyAccountState(
      acct('a', { quota_exhausted: true, quota_cooldown_until: FUTURE }),
      NOW,
      true
    ),
    'usageLimited'
  )
  assert.equal(
    classifyAccountState(
      acct('a', { window_exhausted: true, quota_cooldown_until: FUTURE }),
      NOW,
      true
    ),
    'usageLimited'
  )
})

test('双命中：quotaCooling 优先于 genericCooling', () => {
  assert.equal(
    classifyAccountState(
      acct('a', { quota_cooldown_until: FUTURE, cooldown_until: FUTURE }),
      NOW,
      true
    ),
    'quotaCooling'
  )
})

/** 用给定状态覆盖分类结果，验证阶梯本身（不依赖分类实现的正确性） */
function ladder(pool: Item[], states: AccountState[]): string[] {
  const map = new Map<string, AccountState>()
  pool.forEach((a, i) => map.set(a.id, states[i]!))
  return orderByDegradation(pool, map, (a) => a.id).map((a) => a.id)
}

test('退化阶梯：ok → quotaCooling → genericCooling → usageLimited', () => {
  const pool = [
    acct('usage'),
    acct('generic'),
    acct('quota'),
    acct('ok')
  ]
  const all: AccountState[] = ['usageLimited', 'genericCooling', 'quotaCooling', 'ok']
  // 每一级都在场时，只取最高优先的一级
  assert.deepEqual(ladder(pool, all), ['ok'])
  // 去掉 ok 后先取 quotaCooling
  assert.deepEqual(ladder(pool.slice(0, 3), all.slice(0, 3)), ['quota'])
  // 再去掉 quotaCooling → genericCooling
  assert.deepEqual(ladder(pool.slice(0, 2), all.slice(0, 2)), ['generic'])
  // 只剩硬限额 → 仍返回它（最后兜底，不造空选）
  assert.deepEqual(ladder(pool.slice(0, 1), all.slice(0, 1)), ['usage'])
})

test('退化阶梯：空池返回空数组', () => {
  assert.deepEqual(orderByDegradation([], new Map(), () => ''), [])
})

test('退化阶梯：同一级内保持原顺序', () => {
  const pool = [acct('a'), acct('b'), acct('c')]
  const states = new Map<string, AccountState>([
    ['a', 'genericCooling'],
    ['b', 'ok'],
    ['c', 'ok']
  ])
  assert.deepEqual(ladder(pool, ['genericCooling', 'ok', 'ok']), ['b', 'c'])
  // 同时确认 states 参数被真正使用
  assert.deepEqual(
    orderByDegradation(pool, states, (a) => a.id).map((a) => a.id),
    ['b', 'c']
  )
})
