import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultSettings, isValidTimeZone, SETTING_DEFS } from '../src/services/settings.js'

test('isValidTimeZone 接受常见 IANA 名', () => {
  for (const tz of ['UTC', 'Asia/Shanghai', 'America/New_York', 'Europe/London', 'Etc/GMT-8']) {
    assert.equal(isValidTimeZone(tz), true, `应接受 ${tz}`)
  }
})

test('isValidTimeZone 拒绝非法名与空值', () => {
  for (const tz of ['', 'Not/AZone', 'Asia/Nowhere', 'GMT+8', '中文时区', 'x'.repeat(65)]) {
    assert.equal(isValidTimeZone(tz), false, `应拒绝 ${tz}`)
  }
})

test('时区设置的默认值是 UTC（不改变既有行为）', () => {
  assert.equal(SETTING_DEFS.timezone.default, 'UTC')
  assert.equal(defaultSettings().timezone, 'UTC')
})

test('时区设置会校验格式：非法名不通过 schema', () => {
  assert.equal(SETTING_DEFS.timezone.schema.safeParse('Asia/Shanghai').success, true)
  assert.equal(SETTING_DEFS.timezone.schema.safeParse('Not/AZone').success, false)
  // 前后空白应被 trim 后通过
  assert.equal(SETTING_DEFS.timezone.schema.safeParse('  UTC  ').success, true)
})

test('默认设置的每一项都符合各自的 schema', () => {
  const d = defaultSettings()
  for (const key of Object.keys(SETTING_DEFS) as (keyof typeof SETTING_DEFS)[]) {
    const parsed = SETTING_DEFS[key].schema.safeParse(d[key])
    assert.equal(parsed.success, true, `${key} 的默认值不合法`)
  }
})

/**
 * settings.ts 必须保持「纯」：不 import redis。
 *
 * 这不是洁癖 —— ioredis 在模块加载时就会建连接并无限重连，
 * 一旦 settings.ts 依赖它，所有 import 设置模块的单测都会挂死
 * （本仓库已经踩过两次：D-065 的 version.test、D-069 的 router 抽取）。
 * 用源码扫描把它钉住，比等测试超时 3 分钟再排查划算得多。
 */
test('settings.ts 不直接依赖 redis（否则单测会被连接挂死）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/services/settings.ts', import.meta.url), 'utf8')
  assert.ok(
    !/from ['"]\.\.\/redis\.js['"]/.test(src),
    'settings.ts 不应 import redis —— 需要 Redis 的逻辑请放 services/routingSettings.ts'
  )
})
