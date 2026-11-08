import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultSettings, SETTING_DEFS } from '../src/services/settings.js'

/**
 * 路由/并发调优从 env 迁到设置项后，默认值必须与旧的 env 默认**逐一相同** ——
 * 否则升级后行为会悄悄变化（例如本来试全部候选渠道，突然只试 2 个）。
 */
test('路由/并发调优项的默认值与迁移前的 env 默认一致', () => {
  const d = defaultSettings()
  assert.equal(d.concurrencyCooldownSec, 20)
  assert.equal(d.concurrencyQueueTimeoutMs, 30_000)
  assert.equal(d.maxChannelAttempts, 0)
  assert.equal(d.attemptsPerCandidate, 2)
  assert.equal(d.maxFailoverPasses, 3)
  assert.equal(d.failoverBudgetMs, 60_000)
  assert.equal(d.maxTotalAttempts, 24)
  assert.equal(d.maxAccountAttempts, 0)
})

test('8 个调优项都归入 gateway 分组（设置面板「网关行为」）', () => {
  const keys = [
    'concurrencyCooldownSec',
    'concurrencyQueueTimeoutMs',
    'maxChannelAttempts',
    'attemptsPerCandidate',
    'maxFailoverPasses',
    'failoverBudgetMs',
    'maxTotalAttempts',
    'maxAccountAttempts'
  ] as const
  for (const key of keys) assert.equal(SETTING_DEFS[key].group, 'gateway', key)
})

test('路由/并发调优项的 schema 边界与 0 语义', () => {
  // 0 = 全部 / 不排队 / 不做整轮重试：这些项必须接受 0
  assert.equal(SETTING_DEFS.concurrencyQueueTimeoutMs.schema.safeParse(0).success, true)
  assert.equal(SETTING_DEFS.maxChannelAttempts.schema.safeParse(0).success, true)
  assert.equal(SETTING_DEFS.maxAccountAttempts.schema.safeParse(0).success, true)
  assert.equal(SETTING_DEFS.failoverBudgetMs.schema.safeParse(0).success, true)

  // 上界与下界（与注册表声明一致）
  assert.equal(SETTING_DEFS.concurrencyCooldownSec.schema.safeParse(0).success, false)
  assert.equal(SETTING_DEFS.concurrencyCooldownSec.schema.safeParse(3601).success, false)
  assert.equal(SETTING_DEFS.concurrencyQueueTimeoutMs.schema.safeParse(300_001).success, false)
  assert.equal(SETTING_DEFS.maxChannelAttempts.schema.safeParse(51).success, false)
  assert.equal(SETTING_DEFS.attemptsPerCandidate.schema.safeParse(0).success, false)
  assert.equal(SETTING_DEFS.attemptsPerCandidate.schema.safeParse(6).success, false)
  assert.equal(SETTING_DEFS.maxFailoverPasses.schema.safeParse(11).success, false)
  assert.equal(SETTING_DEFS.failoverBudgetMs.schema.safeParse(600_001).success, false)
  assert.equal(SETTING_DEFS.maxTotalAttempts.schema.safeParse(0).success, false)
  assert.equal(SETTING_DEFS.maxTotalAttempts.schema.safeParse(201).success, false)
  assert.equal(SETTING_DEFS.maxAccountAttempts.schema.safeParse(101).success, false)
})
