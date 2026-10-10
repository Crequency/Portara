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
