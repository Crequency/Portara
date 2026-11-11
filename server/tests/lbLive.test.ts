import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  accountLiveState,
  shareOf,
  summarizeAccountStates,
  type LiveAccount
} from '../src/services/lbLive.js'

/**
 * 负载均衡实况的纯计算口径：
 *   ① 状态映射与「冷却截止时间」必须一致（不能给 usageLimited 编一个时间）
 *   ② share 的分母是别名总请求数，保留 4 位且总和不会因浮点噪声偏离 1
 *   ③ 汇总按账户 id 去重（同一账户可能出现在多个别名/多个目标里）
 */

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0)
const FUTURE = new Date(NOW + 60_000)
const PAST = new Date(NOW - 60_000)
/** 用量标记同样受 TTL 约束：夹具默认给"刚刚检查过" */
const FRESH = new Date(NOW - 5 * 60_000)

function acct(patch: Partial<LiveAccount> = {}): LiveAccount {
  return {
    id: 'account-1',
    channel_id: 'channel-1',
    name: '账户',
    priority: 100,
    weight: 1,
    quota_cooldown_level: 0,
    quota_cooldown_until: null,
    cooldown_until: null,
    quota_exhausted: false,
    window_exhausted: false,
    quota_checked_at: FRESH,
    window_checked_at: FRESH,
    ...patch
  }
}

test('实况状态：四类映射与冷却时间来源', () => {
  assert.deepEqual(accountLiveState(acct(), NOW, true), {
    state: 'ok',
    coolingUntil: null
  })

  const quota = accountLiveState(
    acct({ quota_cooldown_level: 2, quota_cooldown_until: FUTURE }),
    NOW,
    true
  )
  assert.equal(quota.state, 'quotaCooling')
  assert.equal(quota.coolingUntil, FUTURE.toISOString())

  const generic = accountLiveState(acct({ cooldown_until: FUTURE }), NOW, true)
  assert.equal(generic.state, 'genericCooling')
  assert.equal(generic.coolingUntil, FUTURE.toISOString())

  const limited = accountLiveState(acct({ quota_exhausted: true }), NOW, true)
  assert.equal(limited.state, 'usageLimited')
  assert.equal(limited.coolingUntil, null)
})

test('实况状态：window_exhausted 只在开启跳过窗口时算 usageLimited', () => {
  const win = acct({ window_exhausted: true })
  assert.equal(accountLiveState(win, NOW, true).state, 'usageLimited')
  assert.equal(accountLiveState(win, NOW, false).state, 'ok')
})

test('实况状态：过期的冷冻时间不再产生 coolingUntil', () => {
  const quota = accountLiveState(
    acct({ quota_cooldown_level: 1, quota_cooldown_until: PAST }),
    NOW,
    true
  )
  assert.equal(quota.state, 'ok')
  assert.equal(quota.coolingUntil, null)
})

test('share：按别名总请求数计算并保留 4 位小数', () => {
  assert.equal(shareOf(1, 3), 0.3333)
  assert.equal(shareOf(2, 3), 0.6667)
  assert.equal(shareOf(1, 1), 1)
})

test('share：总和≈1（多账户分配）', () => {
  const requests = [4, 2, 2]
  const total = requests.reduce((sum, n) => sum + n, 0)
  const shares = requests.map((n) => shareOf(n, total))
  assert.deepEqual(shares, [0.5, 0.25, 0.25])
  assert.equal(
    shares.reduce((sum, n) => sum + n, 0),
    1
  )
})

test('share：零/负数/非有限值一律为 0', () => {
  assert.equal(shareOf(0, 10), 0)
  assert.equal(shareOf(5, 0), 0)
  assert.equal(shareOf(-1, 10), 0)
  assert.equal(shareOf(Number.NaN, 10), 0)
})

test('汇总：按账户 id 去重，冷却与活跃分开计数', () => {
  const counts = summarizeAccountStates([
    { id: 'a', state: 'ok' },
    { id: 'a', state: 'ok' }, // 同一账户出现在另一个别名
    { id: 'b', state: 'quotaCooling' },
    { id: 'b', state: 'quotaCooling' },
    { id: 'c', state: 'genericCooling' },
    { id: 'd', state: 'usageLimited' }
  ])
  assert.deepEqual(counts, { coolingAccounts: 2, activeAccounts: 1 })
})
