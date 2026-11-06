import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canPromotePin,
  decideAffinityPin,
  isAffinityExpired,
  nextAffinityPin,
  pinAgeMs,
  promotePinned,
  shouldKeepPin,
  type AffinityPin
} from '../src/services/affinityPure.js'

/**
 * 会话亲和 vs 账户健康度 —— 纯决策函数。
 *
 * 这组用例钉住本次线上 bug 的核心：pin 指向的账户若已耗尽/冷却，
 * 绝不能再被 unshift 到候选首位；同时 pin 必须有年龄上限，
 * 否则长会话会无限期粘在同一个账户上。
 */

const MAX_AGE = 3600

test('ok 的 pin 保留，并允许提前到候选首位', () => {
  const decision = decideAffinityPin({ state: 'ok', ageMs: 0, maxAgeSec: MAX_AGE })
  assert.deepEqual(decision, { keep: true, promote: true })
  assert.equal(canPromotePin('ok'), true)
})

test('usageLimited 的 pin 丢弃（绝不提前已耗尽账户）', () => {
  const decision = decideAffinityPin({
    state: 'usageLimited',
    ageMs: 1000,
    maxAgeSec: MAX_AGE
  })
  assert.equal(decision.keep, false)
  assert.equal(decision.promote, false)
  assert.equal(decision.reason, 'usageLimited')
  assert.equal(canPromotePin('usageLimited'), false)
})

test('quotaCooling 的 pin 丢弃（额度冷冻也算冷却）', () => {
  const decision = decideAffinityPin({
    state: 'quotaCooling',
    ageMs: 1000,
    maxAgeSec: MAX_AGE
  })
  assert.equal(decision.keep, false)
  assert.equal(decision.promote, false)
  assert.equal(decision.reason, 'state=cooling')
})

test('genericCooling 的 pin 丢弃（通用失败冷却同样不可提前）', () => {
  const decision = decideAffinityPin({
    state: 'genericCooling',
    ageMs: 1000,
    maxAgeSec: MAX_AGE
  })
  assert.equal(decision.keep, false)
  assert.equal(decision.promote, false)
  assert.equal(decision.reason, 'state=cooling')
})

test('超过最大年龄的 pin 丢弃（即使账户当前仍是 ok）', () => {
  const expired = decideAffinityPin({
    state: 'ok',
    ageMs: MAX_AGE * 1000 + 1,
    maxAgeSec: MAX_AGE
  })
  assert.deepEqual(expired, { keep: false, promote: false, reason: 'expired' })

  // 边界：恰好等于上限仍算有效（超过才算过期）
  const boundary = shouldKeepPin({
    state: 'ok',
    ageMs: MAX_AGE * 1000,
    maxAgeSec: MAX_AGE
  })
  assert.equal(boundary.keep, true)
  assert.equal(isAffinityExpired(MAX_AGE * 1000 + 1, MAX_AGE), true)
  assert.equal(isAffinityExpired(MAX_AGE * 1000, MAX_AGE), false)
})

test('旧数据没有 pinnedAt：视为刚创建，并在下一次落账时补写时间戳', () => {
  const legacy: AffinityPin = { channelId: 'ch-a', accountId: 'acc-a' }
  const now = 1_700_000_000_000

  assert.equal(pinAgeMs(legacy, now), 0, '缺失 pinnedAt 按刚创建处理')
  assert.equal(pinAgeMs({ pinnedAt: now - 5000 }, now), 5000)

  // 兼容不会让上限失效：同目标的旧 pin 仍会写一次（补 pinnedAt）
  const backfill = nextAffinityPin({
    previous: legacy,
    channelId: 'ch-a',
    accountId: 'acc-a',
    now
  })
  assert.equal(backfill.write, true)
  assert.equal(backfill.pin?.pinnedAt, now)

  // 已有时间戳且目标未变 → 不再写（成功命中原样保留）
  const settled = nextAffinityPin({
    previous: { channelId: 'ch-a', accountId: 'acc-a', pinnedAt: now - 5000 },
    channelId: 'ch-a',
    accountId: 'acc-a',
    now
  })
  assert.equal(settled.write, false)
})

test('整个池子退化到 usageLimited：pin 保留但不提前（不制造 503）', () => {
  const fallback = decideAffinityPin({
    state: 'usageLimited',
    ageMs: 1000,
    maxAgeSec: MAX_AGE,
    usageLimitedFallback: true
  })
  assert.equal(fallback.keep, true, '兜底时应保留 pin，避免额外清空')
  assert.equal(fallback.promote, false, '兜底时也不许把已耗尽账户提到首位')
  assert.equal(fallback.reason, undefined)
})

test('pin 指向不在候选池的账户：丢弃并报 not_in_pool', () => {
  const missing = decideAffinityPin({ state: null, ageMs: 0, maxAgeSec: MAX_AGE })
  assert.deepEqual(missing, { keep: false, promote: false, reason: 'not_in_pool' })
})

test('目标变更时重新落 pin，并写入新的 pinnedAt', () => {
  const now = 1_700_000_000_000
  const previous: AffinityPin = {
    channelId: 'ch-a',
    accountId: 'acc-a',
    pinnedAt: now - 10_000
  }

  const changed = nextAffinityPin({
    previous,
    channelId: 'ch-a',
    accountId: 'acc-b',
    now
  })
  assert.equal(changed.write, true)
  assert.deepEqual(changed.pin, {
    channelId: 'ch-a',
    accountId: 'acc-b',
    pinnedAt: now
  })

  // 失效后即使落到同一个账户，也要按新 pin 重新计时
  const reinvalidated = nextAffinityPin({
    previous,
    channelId: 'ch-a',
    accountId: 'acc-a',
    now,
    invalidated: true
  })
  assert.equal(reinvalidated.write, true)
  assert.equal(reinvalidated.pin?.pinnedAt, now)
})

test('promotePinned：只提前已存在的 pin，不修改入参数组', () => {
  const original = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const promoted = promotePinned(original, 'b')
  assert.equal(promoted.promoted, true)
  assert.deepEqual(promoted.accounts.map((x) => x.id), ['b', 'a', 'c'])
  assert.deepEqual(original.map((x) => x.id), ['a', 'b', 'c'], '不能原地修改')

  assert.deepEqual(promotePinned(original, 'a').accounts, original)
  assert.equal(promotePinned(original, 'a').promoted, false)
  assert.deepEqual(promotePinned(original, 'missing').accounts, original)
  assert.deepEqual(promotePinned(original, '').accounts, original)
})
