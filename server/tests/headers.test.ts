import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildUpstreamHeaders,
  isVendorPreset,
  sanitizeExtraHeaders,
  vendorHeaders
} from '../src/services/proxy.js'

// ------------------------------------------------------------ 固定请求头校验

test('sanitizeExtraHeaders 接受合法请求头', () => {
  const { headers, errors } = sanitizeExtraHeaders({
    'X-Custom-Token': 'abc',
    'x-opencode-session': 'my-session'
  })
  assert.deepEqual(headers, { 'X-Custom-Token': 'abc', 'x-opencode-session': 'my-session' })
  assert.deepEqual(errors, [])
})

test('sanitizeExtraHeaders 拒绝由 Portara 管理的保留头', () => {
  const { headers, errors } = sanitizeExtraHeaders({
    authorization: 'Bearer evil',
    'Content-Type': 'text/plain',
    host: 'evil.example.com',
    'X-Ok': 'fine'
  })
  assert.deepEqual(headers, { 'X-Ok': 'fine' })
  assert.equal(errors.length, 3)
})

test('sanitizeExtraHeaders 拒绝 CRLF 注入与非法名称', () => {
  const { headers, errors } = sanitizeExtraHeaders({
    'X-Inject': 'value\r\nX-Evil: 1',
    'Bad Header': 'x',
    'X-Newline': 'a\nb'
  })
  assert.deepEqual(headers, {})
  assert.equal(errors.length, 3)
})

test('sanitizeExtraHeaders 拒绝过长的值', () => {
  const { headers, errors } = sanitizeExtraHeaders({ 'X-Long': 'a'.repeat(2000) })
  assert.deepEqual(headers, {})
  assert.equal(errors.length, 1)
})

test('sanitizeExtraHeaders 对空输入与非法类型安全返回', () => {
  assert.deepEqual(sanitizeExtraHeaders(undefined), { headers: {}, errors: [] })
  assert.deepEqual(sanitizeExtraHeaders(null), { headers: {}, errors: [] })
  assert.equal(sanitizeExtraHeaders(['a']).errors.length, 1)
})

// ------------------------------------------------------------ 厂商预设

test('isVendorPreset 只认已支持的档位', () => {
  assert.equal(isVendorPreset('generic'), true)
  assert.equal(isVendorPreset('opencode-go'), true)
  assert.equal(isVendorPreset('something-else'), false)
})

test('vendorHeaders 对 generic 不注入任何头', () => {
  assert.deepEqual(vendorHeaders('generic'), {})
})

test('vendorHeaders 为 opencode-go 注入 x-opencode-session', () => {
  const headers = vendorHeaders('opencode-go')
  assert.ok(headers['x-opencode-session'])
  assert.ok(headers['x-opencode-session']!.startsWith('portara-'))
})

test('vendorHeaders 尊重用户已提供的 session（大小写不敏感）', () => {
  assert.deepEqual(vendorHeaders('opencode-go', { 'X-OpenCode-Session': 'mine' }), {})

  const injected = vendorHeaders('opencode-go', { 'x-other': '1' })
  assert.ok(injected['x-opencode-session'])
})

test('vendorHeaders 每次生成不同的 session（占位实现）', () => {
  const a = vendorHeaders('opencode-go')['x-opencode-session']
  const b = vendorHeaders('opencode-go')['x-opencode-session']
  assert.notEqual(a, b)
})

// ------------------------------------------------------------ 请求头组装

test('buildUpstreamHeaders 合并：基础 → 厂商预设 → 用户固定头', () => {
  const headers = buildUpstreamHeaders('sk-upstream', 'application/json', {
    vendor: 'opencode-go',
    extraHeaders: { 'X-Tenant': 'acme' }
  })

  assert.equal(headers['content-type'], 'application/json')
  assert.equal(headers['X-Tenant'], 'acme')
  assert.ok(headers['x-opencode-session'])
  assert.equal(headers.authorization, 'Bearer sk-upstream')
})

test('buildUpstreamHeaders 中上游密钥压过用户误填的同名头', () => {
  const headers = buildUpstreamHeaders('sk-real', 'application/json', {
    extraHeaders: { authorization: 'Bearer evil' } // 已被 sanitize 拦下时不会到这；此处直接构造防御
  })
  assert.equal(headers.authorization, 'Bearer sk-real')
})

test('buildUpstreamHeaders 在无上游密钥时不带 authorization', () => {
  const headers = buildUpstreamHeaders('', 'application/json')
  assert.equal(headers.authorization, undefined)
})
