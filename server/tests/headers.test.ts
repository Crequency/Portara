import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ANTHROPIC_VERSION,
  buildUpstreamHeaders,
  isVendorPreset,
  sanitizeExtraHeaders
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

test('buildUpstreamHeaders 合并：基础 → 厂商预设 → 用户固定头', () => {
  const { headers } = buildUpstreamHeaders('sk-upstream', 'application/json', {
    vendor: 'opencode-go',
    extraHeaders: { 'X-Tenant': 'acme' }
  })

  assert.equal(headers['content-type'], 'application/json')
  assert.equal(headers['X-Tenant'], 'acme')
  assert.ok(headers['x-opencode-session'])
  assert.equal(headers.authorization, 'Bearer sk-upstream')
})

test('buildUpstreamHeaders 中上游密钥压过用户误填的同名头', () => {
  const { headers } = buildUpstreamHeaders('sk-real', 'application/json', {
    extraHeaders: { authorization: 'Bearer evil' } // 已被 sanitize 拦下时不会到这；此处直接构造防御
  })
  assert.equal(headers.authorization, 'Bearer sk-real')
})

test('buildUpstreamHeaders 在无上游密钥时不带 authorization', () => {
  const headers = buildUpstreamHeaders('', 'application/json')
  assert.equal(headers.authorization, undefined)
})

// ------------------------------------------------------------ 认证头按协议选择

test('OpenAI 协议用 Authorization: Bearer', () => {
  const { headers: h } = buildUpstreamHeaders('sk-abc', 'application/json', { protocol: 'openai' })
  assert.equal(h.authorization, 'Bearer sk-abc')
  assert.equal(h['x-api-key'], undefined)
})

test('Anthropic 协议用 x-api-key 而非 Bearer，并带 anthropic-version', () => {
  const { headers: h } = buildUpstreamHeaders('sk-ant', 'application/json', { protocol: 'anthropic' })
  assert.equal(h['x-api-key'], 'sk-ant')
  assert.equal(h['anthropic-version'], ANTHROPIC_VERSION)
  // 用错头会得到一句「Authentication failed」，而上游不会告诉你头用错了
  assert.equal(h.authorization, undefined)
})

test('未指定协议时按 OpenAI 处理（保持既有行为）', () => {
  const { headers: h } = buildUpstreamHeaders('sk-abc', 'application/json')
  assert.equal(h.authorization, 'Bearer sk-abc')
})

test('x-api-key 属于保留头，不允许用户自定义', () => {
  const { headers, errors } = sanitizeExtraHeaders({ 'x-api-key': 'evil', 'X-Ok': '1' })
  assert.deepEqual(headers, { 'X-Ok': '1' })
  assert.equal(errors.length, 1)
})

test('用户可通过固定请求头覆盖 anthropic-version（它不是凭据）', () => {
  const { headers: h } = buildUpstreamHeaders('sk-ant', 'application/json', {
    protocol: 'anthropic',
    extraHeaders: { 'anthropic-version': '2024-01-01' }
  })
  assert.equal(h['anthropic-version'], '2024-01-01')
})

test('无上游密钥时两种协议都不带认证头', () => {
  assert.equal(buildUpstreamHeaders('', 'application/json', { protocol: 'openai' }).headers.authorization, undefined)
  assert.equal(buildUpstreamHeaders('', 'application/json', { protocol: 'anthropic' }).headers['x-api-key'], undefined)
})
