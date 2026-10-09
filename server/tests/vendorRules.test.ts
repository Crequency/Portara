import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildUpstreamHeaders } from '../src/services/proxy.js'
import {
  resolveVendorSession,
  sanitizeSessionValue,
  stableSession,
  VENDOR_HEADER_RULES
} from '../src/services/vendorRules.js'

const RULE = VENDOR_HEADER_RULES['opencode-go']!

// ------------------------------------------------------------ 兜底值

test('stableSession 稳定：同一渠道永远同一值', () => {
  assert.equal(stableSession('ch-1'), stableSession('ch-1'))
})

test('stableSession 每渠道不同', () => {
  assert.notEqual(stableSession('ch-1'), stableSession('ch-2'))
})

test('stableSession 不含任何密钥材料，且带可识别前缀', () => {
  const v = stableSession('ch-1')
  assert.ok(v.startsWith('portara-'))
  assert.match(v, /^portara-[0-9a-f]{24}$/)
})

test('stableSession 在渠道 id 缺失时也能给出稳定值', () => {
  assert.equal(stableSession(''), stableSession('   '))
})

// ------------------------------------------------------------ 消毒

test('sanitizeSessionValue 接受正常会话 id', () => {
  assert.equal(
    sanitizeSessionValue('session-110c3d94-19f4-441b-bedb-64b330175726', RULE),
    'session-110c3d94-19f4-441b-bedb-64b330175726'
  )
})

test('sanitizeSessionValue 去掉首尾空白', () => {
  assert.equal(sanitizeSessionValue('  abc-1  ', RULE), 'abc-1')
})

test('sanitizeSessionValue 拒绝 CRLF（请求头注入）', () => {
  assert.equal(sanitizeSessionValue('abc\r\nX-Evil: 1', RULE), null)
  assert.equal(sanitizeSessionValue('abc\ndef', RULE), null)
})

test('sanitizeSessionValue 拒绝超长值', () => {
  assert.equal(sanitizeSessionValue('a'.repeat(129), RULE), null)
  assert.equal(sanitizeSessionValue('a'.repeat(128), RULE), 'a'.repeat(128))
})

test('sanitizeSessionValue 拒绝空值与非字符串', () => {
  assert.equal(sanitizeSessionValue('', RULE), null)
  assert.equal(sanitizeSessionValue('   ', RULE), null)
  assert.equal(sanitizeSessionValue(123, RULE), null)
  assert.equal(sanitizeSessionValue(null, RULE), null)
  assert.equal(sanitizeSessionValue({ a: 1 }, RULE), null)
})

test('sanitizeSessionValue 拒绝字符集外的内容（含中文/斜杠/空格）', () => {
  for (const bad of ['有中文', 'a/b', 'a b', 'a;b', 'a=b', 'a"b']) {
    assert.equal(sanitizeSessionValue(bad, RULE), null, `应拒绝：${bad}`)
  }
})

// ------------------------------------------------------------ 优先级

test('无规则的厂商不注入任何东西', () => {
  const plan = resolveVendorSession({ vendor: 'generic', channelId: 'ch-1' })
  assert.deepEqual(plan.headers, {})
  assert.equal(plan.session, null)
})

test('优先级①：请求体里的会话 id 胜出', () => {
  const plan = resolveVendorSession({
    vendor: 'opencode-go',
    channelId: 'ch-1',
    payload: { prompt_cache_key: 'session-abc' }
  })
  assert.equal(plan.headers['x-opencode-session'], 'session-abc')
  assert.equal(plan.session?.source, 'body')
})

test('优先级①：请求体派生值压过渠道固定头', () => {
  const plan = resolveVendorSession({
    vendor: 'opencode-go',
    channelId: 'ch-1',
    extraHeaders: { 'x-opencode-session': 'static-from-user' },
    payload: { prompt_cache_key: 'session-abc' }
  })
  assert.equal(plan.headers['x-opencode-session'], 'session-abc')
  assert.equal(plan.session?.source, 'body')
})

test('优先级②：请求体没有时用渠道固定头（不覆盖）', () => {
  const plan = resolveVendorSession({
    vendor: 'opencode-go',
    channelId: 'ch-1',
    extraHeaders: { 'X-OpenCode-Session': 'static-from-user' }
  })
  assert.deepEqual(plan.headers, {}) // 交给 extraHeaders 合并时生效
  assert.equal(plan.session?.value, 'static-from-user')
  assert.equal(plan.session?.source, 'configured')
})

test('优先级③：都没有则用稳定兜底（不是随机）', () => {
  const a = resolveVendorSession({ vendor: 'opencode-go', channelId: 'ch-1' })
  const b = resolveVendorSession({ vendor: 'opencode-go', channelId: 'ch-1' })
  assert.equal(a.headers['x-opencode-session'], b.headers['x-opencode-session'])
  assert.equal(a.session?.source, 'fallback')
})

test('请求体里的非法值不会被采用，而是退回兜底', () => {
  const plan = resolveVendorSession({
    vendor: 'opencode-go',
    channelId: 'ch-1',
    payload: { prompt_cache_key: 'bad\r\nvalue' }
  })
  assert.equal(plan.session?.source, 'fallback')
  assert.ok(!plan.headers['x-opencode-session'].includes('\r'))
})

test('压缩请求体不做解析（避免拿到乱码当会话 id）', () => {
  const plan = resolveVendorSession({
    vendor: 'opencode-go',
    channelId: 'ch-1',
    payload: { prompt_cache_key: 'session-abc' },
    contentEncoding: 'gzip'
  })
  assert.equal(plan.session?.source, 'fallback')
})

test('content-encoding 为 identity 时正常解析', () => {
  const plan = resolveVendorSession({
    vendor: 'opencode-go',
    channelId: 'ch-1',
    payload: { prompt_cache_key: 'session-abc' },
    contentEncoding: 'identity'
  })
  assert.equal(plan.session?.source, 'body')
})

// ------------------------------------------------------------ 与 buildUpstreamHeaders 的整合

test('buildUpstreamHeaders 会注入厂商会话头并回报来源', () => {
  const { headers, session } = buildUpstreamHeaders('sk-x', 'application/json', {
    vendor: 'opencode-go',
    channelId: 'ch-1',
    payload: { prompt_cache_key: 'session-abc' }
  })
  assert.equal(headers['x-opencode-session'], 'session-abc')
  assert.equal(session?.value, 'session-abc')
  assert.equal(session?.header, 'x-opencode-session')
})

test('buildUpstreamHeaders 对无规则厂商不回报 session', () => {
  const { session } = buildUpstreamHeaders('sk-x', 'application/json', {
    vendor: 'generic',
    channelId: 'ch-1'
  })
  assert.equal(session, null)
})

test('用户固定头里的会话值最终生效并被正确回报', () => {
  const { headers, session } = buildUpstreamHeaders('sk-x', 'application/json', {
    vendor: 'opencode-go',
    channelId: 'ch-1',
    extraHeaders: { 'x-opencode-session': 'from-config' }
  })
  assert.equal(headers['x-opencode-session'], 'from-config')
  assert.equal(session?.source, 'configured')
})

test('buildUpstreamHeaders：请求体派生值压过用户固定头（合并顺序不能把它盖掉）', () => {
  const { headers, session } = buildUpstreamHeaders('sk-x', 'application/json', {
    vendor: 'opencode-go',
    channelId: 'ch-1',
    extraHeaders: { 'x-opencode-session': 'from-config' },
    payload: { prompt_cache_key: 'session-from-body' }
  })
  // 曾经的 bug：先合并厂商头、后合并 extra，导致固定头把请求体派生值盖掉
  assert.equal(headers['x-opencode-session'], 'session-from-body')
  assert.equal(session?.source, 'body')
})

test('buildUpstreamHeaders：兜底值不会盖掉用户固定头', () => {
  const { headers } = buildUpstreamHeaders('sk-x', 'application/json', {
    vendor: 'opencode-go',
    channelId: 'ch-1',
    extraHeaders: { 'x-opencode-session': 'from-config' }
  })
  assert.equal(headers['x-opencode-session'], 'from-config')
})

test('buildUpstreamHeaders：上游密钥仍然压过一切（含厂商头）', () => {
  const { headers } = buildUpstreamHeaders('sk-real', 'application/json', {
    vendor: 'opencode-go',
    channelId: 'ch-1',
    extraHeaders: { authorization: 'Bearer wrong' }
  })
  assert.equal(headers.authorization, 'Bearer sk-real')
})
