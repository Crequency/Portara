import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decryptSecret,
  encryptSecret,
  generateApiKey,
  hashApiKey,
  hashPassword,
  maskSecret,
  safeEqualHex,
  verifyPassword
} from '../src/lib/crypto.js'

test('生成的 API Key 带前缀，哈希稳定且不可逆推', () => {
  const { key, prefix, hash } = generateApiKey()

  assert.ok(key.startsWith('sk-portara-'))
  assert.equal(prefix, key.slice(0, 'sk-portara-'.length + 8))
  assert.equal(hash, hashApiKey(key))
  assert.equal(hash.length, 64)
  // 明文不能出现在哈希里
  assert.ok(!hash.includes(key))
})

test('两次生成的 Key 不相同', () => {
  const a = generateApiKey()
  const b = generateApiKey()
  assert.notEqual(a.key, b.key)
  assert.notEqual(a.hash, b.hash)
})

test('safeEqualHex 对不等长与非法输入返回 false 而不是抛错', () => {
  const h = hashApiKey('abc')
  assert.equal(safeEqualHex(h, h), true)
  assert.equal(safeEqualHex(h, h.slice(0, -2)), false)
  assert.equal(safeEqualHex('zz', 'zz'), false)
})

test('AES-256-GCM 往返，且密文不含明文', () => {
  const master = Buffer.alloc(32, 7)
  const plain = 'sk-upstream-secret-value'

  const cipher = encryptSecret(plain, master)
  assert.ok(cipher.startsWith('v1:'))
  assert.ok(!cipher.includes(plain))
  assert.equal(decryptSecret(cipher, master), plain)
})

test('用错误的主密钥解密必须失败（GCM 认证）', () => {
  const cipher = encryptSecret('secret', Buffer.alloc(32, 1))
  assert.throws(() => decryptSecret(cipher, Buffer.alloc(32, 2)))
})

test('密文格式非法时抛错', () => {
  assert.throws(() => decryptSecret('garbage', Buffer.alloc(32, 1)))
})

test('口令哈希可验证，且同一口令两次哈希不同（随机盐）', () => {
  const h1 = hashPassword('correct horse battery staple')
  const h2 = hashPassword('correct horse battery staple')

  assert.notEqual(h1, h2)
  assert.equal(verifyPassword('correct horse battery staple', h1), true)
  assert.equal(verifyPassword('wrong password', h1), false)
})

test('verifyPassword 对损坏的存储值返回 false', () => {
  assert.equal(verifyPassword('x', 'not-a-hash'), false)
  assert.equal(verifyPassword('x', 'scrypt$bad'), false)
})

test('maskSecret 不泄漏中段', () => {
  const masked = maskSecret('sk-1234567890abcdef')
  assert.ok(masked.includes('••••'))
  assert.ok(!masked.includes('67890abc'))
})
