import { test } from 'node:test'
import assert from 'node:assert/strict'

/*
 * i18n 一致性护栏。
 *
 * 为什么需要它：文案是一个人肉维护的大表，漏一个键不会报错 ——
 * 界面上会静默退回中文（translate 的兜底），只有会说该语言的用户才发现。
 * 这里把「所有语言键集合完全一致、无空值、占位符一致」钉成测试，
 * 新增语言或改键时 CI 直接红，不靠人眼。
 */

const LOCALES = ['zh', 'en', 'ja', 'ko', 'es', 'fr', 'th']

const flatten = (obj, prefix = '', out = {}) => {
  for (const k of Object.keys(obj)) {
    const v = obj[k]
    const path = prefix ? prefix + '.' + k : k
    if (v && typeof v === 'object') flatten(v, path, out)
    else out[path] = v
  }
  return out
}

const placeholders = (s) =>
  [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')

const catalogs = {}
for (const loc of LOCALES) {
  const mod = await import('../src/i18n/' + loc + '.ts')
  catalogs[loc] = flatten(mod[loc])
}

test('每种语言的键集合与中文完全一致', () => {
  const zhKeys = Object.keys(catalogs.zh).sort()
  for (const loc of LOCALES) {
    if (loc === 'zh') continue
    const keys = Object.keys(catalogs[loc]).sort()
    const missing = zhKeys.filter((k) => !(k in catalogs[loc]))
    const extra = keys.filter((k) => !(k in catalogs.zh))
    assert.deepEqual(missing, [], `${loc} 缺少键`)
    assert.deepEqual(extra, [], `${loc} 多出键`)
  }
})

test('所有语言无空值、非字符串值', () => {
  for (const loc of LOCALES) {
    for (const [key, value] of Object.entries(catalogs[loc])) {
      assert.equal(typeof value, 'string', `${loc}.${key} 不是字符串`)
      assert.notEqual(value.trim(), '', `${loc}.${key} 是空字符串`)
    }
  }
})

test('占位符与中文一致', () => {
  for (const loc of LOCALES) {
    if (loc === 'zh') continue
    for (const [key, value] of Object.entries(catalogs[loc])) {
      assert.equal(
        placeholders(value),
        placeholders(catalogs.zh[key] ?? ''),
        `${loc}.${key} 的占位符与中文不一致`
      )
    }
  }
})

test('中文文案里没有残留的裸键名式占位', () => {
  for (const [key, value] of Object.entries(catalogs.zh)) {
    assert.ok(!/^[a-z]+\.[a-zA-Z0-9_.]+$/.test(value), `${key} 的值疑似键名本身`)
  }
})
