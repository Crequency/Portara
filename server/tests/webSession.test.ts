import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_COOKIE_TEXT,
  cookieNamesOf,
  openWebSession,
  sealWebSession,
  validateCookieText
} from '../src/services/webSession.js'

/*
 * 这一组只测**纯函数**（加密往返 / 名称提取 / 格式校验）——
 * 数据库读写属于集成路径，由冒烟脚本覆盖。
 */

const MASTER = Buffer.alloc(32, 9)

test('webSession：加解密往返，密文不含明文', () => {
  const cookie = 'session_token=abc123; cf_clearance=xyz.789'
  const cipher = sealWebSession(cookie, MASTER)

  assert.ok(cipher.startsWith('v1:'), '应复用 lib/crypto 的 v1 密文格式')
  assert.ok(!cipher.includes('abc123'), '密文里不能出现 Cookie 值')
  assert.ok(!cipher.includes('session_token'), '密文里不能出现 Cookie 名')
  assert.equal(openWebSession(cipher, MASTER), cookie)
})

test('webSession：主密钥不对 / 密文损坏时解密返回 null（不抛）', () => {
  const cipher = sealWebSession('a=1', MASTER)
  assert.equal(openWebSession(cipher, Buffer.alloc(32, 1)), null)
  assert.equal(openWebSession('garbage', MASTER), null)
  assert.equal(openWebSession('', MASTER), null)
})

test('webSession：Cookie 名提取支持分号与多行两种粘贴格式', () => {
  assert.deepEqual(cookieNamesOf('a=1; b=2'), ['a', 'b'])
  assert.deepEqual(cookieNamesOf('a=1\nb=2\r\nc=3'), ['a', 'b', 'c'])
  // 值里带 = / 空格的没问题（base64 padding、JWT）
  assert.deepEqual(cookieNamesOf('token=abc==; other=x y'), ['token', 'other'])
  // 重复名去重（浏览器可能给同名多域）
  assert.deepEqual(cookieNamesOf('a=1; a=2'), ['a'])
  // 非法条目忽略，不炸
  assert.deepEqual(cookieNamesOf('garbage; =1; ok=1'), ['ok'])
  assert.deepEqual(cookieNamesOf(''), [])
})

test('webSession：Cookie 名列表里绝不出现值', () => {
  const names = cookieNamesOf('session=super-secret-value')
  assert.ok(!names.some((n) => n.includes('super-secret-value')))
})

test('webSession：格式校验通过正常输入', () => {
  assert.equal(validateCookieText('session=abc'), null)
  assert.equal(validateCookieText('a=1; b=2'), null)
  assert.equal(validateCookieText('a=1\nb=2\n'), null)
})

test('webSession：格式校验拒绝空 / 超长 / 非 name=value', () => {
  assert.match(String(validateCookieText('')), /不能为空/)
  assert.match(String(validateCookieText('   ')), /不能为空/)
  assert.match(String(validateCookieText('no-equals-sign')), /name=value/)
  assert.match(String(validateCookieText('=value-only')), /name=value/)
  assert.match(String(validateCookieText('ok=1; bad')), /name=value/)
  assert.match(String(validateCookieText('bad name=1')), /不合法/)
  // 值为空也算不合法（粘贴时最常见的漏值）
  assert.match(String(validateCookieText('a=')), /值为空/)
})

test('webSession：长度上限是 8192（与接口契约一致）', () => {
  assert.equal(MAX_COOKIE_TEXT, 8192)
  const big = 'a=' + 'x'.repeat(8192)
  assert.match(String(validateCookieText(big)), /太长/)
  const ok = 'a=' + 'x'.repeat(8189)
  assert.equal(ok.length, 8191)
  assert.equal(validateCookieText(ok), null)
})
