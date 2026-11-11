import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyAccountState,
  orderByDegradation,
  summarizeQuotaFrozenPool,
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
/** 新鲜快照：5 分钟前（TTL 内） */
const FRESH = new Date(NOW - 5 * 60_000)
/** 过期快照：2 小时前（超过 1h TTL） */
const STALE = new Date(NOW - 2 * 60 * 60_000)

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
    // 默认给"刚刚检查过"的时间戳：TTL 逻辑要求标记必须新鲜才被采信
    quota_checked_at: FRESH,
    window_checked_at: FRESH,
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

test('分类：过期用量标记不再算硬限额（本次 429 事故的回归）', () => {
  /*
   * 事故：CommandCode 两个号带着两三天前的 quota_exhausted=true 一直被判定
   * 「全池冻结」，路由直接短路成 429，而它们账上其实有余额。
   * 修法是给用量标记设有效期（USAGE_FLAG_TTL_MS）；过期后交给真实请求裁决。
   */
  const stale = acct('a', { quota_exhausted: true, quota_checked_at: STALE })
  assert.equal(classifyAccountState(stale, NOW, true), 'ok')

  const freshAcct = acct('a', { quota_exhausted: true, quota_checked_at: FRESH })
  assert.equal(classifyAccountState(freshAcct, NOW, true), 'usageLimited')

  // 没有时间戳 = 不知道 → 同样视为过期
  const unknown = acct('a', { quota_exhausted: true, quota_checked_at: null })
  assert.equal(classifyAccountState(unknown, NOW, true), 'ok')
})

test('分类：未到期的额度冷却仍算硬限额（不因标记过期而放行）', () => {
  const cooling = acct('a', {
    quota_exhausted: true,
    quota_checked_at: STALE,
    quota_cooldown_until: FUTURE
  })
  assert.equal(classifyAccountState(cooling, NOW, true), 'usageLimited')
})

test('分类：窗口打满同样受有效期约束', () => {
  const staleWin = acct('a', { window_exhausted: true, window_checked_at: STALE })
  assert.equal(classifyAccountState(staleWin, NOW, true), 'ok')
  const freshWin = acct('a', { window_exhausted: true, window_checked_at: FRESH })
  assert.equal(classifyAccountState(freshWin, NOW, true), 'usageLimited')
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

test('额度冻结摘要：全池 usageLimited/quotaCooling 且能取到最早重置', () => {
  const pool = [
    acct('a', { quota_cooldown_until: new Date(NOW + 900_000) }),
    acct('b', { quota_exhausted: true }),
    acct('c', { quota_cooldown_until: new Date(NOW + 300_000) })
  ]
  const states = new Map<string, AccountState>([
    ['a', 'quotaCooling'],
    ['b', 'usageLimited'],
    ['c', 'quotaCooling']
  ])
  assert.deepEqual(summarizeQuotaFrozenPool(pool, states, NOW), {
    allFrozen: true,
    retryAtMs: NOW + 300_000
  })
})

test('额度冻结摘要：全池 usageLimited 但不知道何时恢复 → retryAtMs 为 null', () => {
  const pool = [acct('a'), acct('b')]
  const states = new Map<string, AccountState>([
    ['a', 'usageLimited'],
    ['b', 'usageLimited']
  ])
  assert.deepEqual(summarizeQuotaFrozenPool(pool, states, NOW), {
    allFrozen: true,
    retryAtMs: null
  })
  // 过期的冷冻不算「可恢复时间」
  const expired = [acct('a', { quota_cooldown_until: PAST })]
  assert.equal(
    summarizeQuotaFrozenPool(
      expired,
      new Map<string, AccountState>([['a', 'quotaCooling']]),
      NOW
    ).retryAtMs,
    null
  )
})

test('额度冻结摘要：只要有 ok / genericCooling 账户就不算全冻结', () => {
  const pool = [
    acct('a', { quota_cooldown_until: new Date(NOW + 60_000) }),
    acct('b')
  ]
  assert.deepEqual(
    summarizeQuotaFrozenPool(
      pool,
      new Map<string, AccountState>([
        ['a', 'quotaCooling'],
        ['b', 'ok']
      ]),
      NOW
    ),
    { allFrozen: false, retryAtMs: null }
  )
  assert.deepEqual(
    summarizeQuotaFrozenPool(
      pool,
      new Map<string, AccountState>([
        ['a', 'quotaCooling'],
        ['b', 'genericCooling']
      ]),
      NOW
    ),
    { allFrozen: false, retryAtMs: null }
  )
})

test('额度冻结摘要：空池不短路', () => {
  assert.deepEqual(summarizeQuotaFrozenPool([], new Map(), NOW), {
    allFrozen: false,
    retryAtMs: null
  })
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
