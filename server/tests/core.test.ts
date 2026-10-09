import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  extractUsage,
  SseUsageScanner,
  withStreamUsage
} from '../src/services/proxy.js'
import { currentWindow, quotaExceeded, rateLimitKey } from '../src/services/limits.js'
import { pickChannel, type ChannelCandidate } from '../src/services/routing.js'

function ch(partial: Partial<ChannelCandidate> & { name: string }): ChannelCandidate {
  return {
    id: partial.name,
    name: partial.name,
    base_url: 'https://example.com/v1',
    api_key_cipher: '',
    models: [],
    priority: 100,
    weight: 1,
    timeout_ms: 1000,
    status: 'active',
    ...partial
  }
}

// ------------------------------------------------------------------ 选路

test('pickChannel 忽略停用渠道', () => {
  const picked = pickChannel(
    [ch({ name: 'off', status: 'disabled' }), ch({ name: 'on' })],
    'gpt-4o'
  )
  assert.equal(picked?.name, 'on')
})

test('pickChannel 优先取 priority 最小的一组', () => {
  const picked = pickChannel(
    [ch({ name: 'p200', priority: 200 }), ch({ name: 'p10', priority: 10 })],
    'gpt-4o'
  )
  assert.equal(picked?.name, 'p10')
})

test('pickChannel 按模型过滤，空 models 视为通吃', () => {
  const channels = [
    ch({ name: 'only-mini', models: ['gpt-4o-mini'], priority: 10 }),
    ch({ name: 'catch-all', models: [], priority: 20 })
  ]
  assert.equal(pickChannel(channels, 'gpt-4o-mini')?.name, 'only-mini')
  assert.equal(pickChannel(channels, 'gpt-4o')?.name, 'catch-all')
  assert.equal(pickChannel(channels, 'unknown-model')?.name, 'catch-all')
})

test('pickChannel 在无匹配模型时返回 null', () => {
  const channels = [ch({ name: 'only-mini', models: ['gpt-4o-mini'] })]
  assert.equal(pickChannel(channels, 'gpt-4o'), null)
})

test('pickChannel 按权重轮转，且分布符合权重比', () => {
  const channels = [
    ch({ name: 'a', weight: 2 }),
    ch({ name: 'b', weight: 1 })
  ]
  const picks = [0, 1, 2, 3, 4, 5].map((r) => pickChannel(channels, 'm', r)?.name)
  assert.deepEqual(picks, ['a', 'a', 'b', 'a', 'a', 'b'])
})

test('pickChannel 对 weight < 1 容错为 1，rotation 为负也能收敛', () => {
  const channels = [ch({ name: 'a', weight: 0 }), ch({ name: 'b', weight: -5 })]
  assert.equal(pickChannel(channels, 'm', -1)?.name, 'b')
  assert.ok(pickChannel(channels, 'm', 7))
})

test('pickChannel 空列表返回 null', () => {
  assert.equal(pickChannel([], 'm'), null)
})

// ------------------------------------------------------------------ usage

test('extractUsage 解析 OpenAI 风格 usage', () => {
  assert.deepEqual(
    extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
  )
})

test('extractUsage 在 total 缺失时用和补齐', () => {
  assert.deepEqual(
    extractUsage({ usage: { prompt_tokens: 3, completion_tokens: 4 } }),
    { promptTokens: 3, completionTokens: 4, totalTokens: 7 }
  )
})

test('extractUsage 对无 usage 的响应返回 null', () => {
  assert.equal(extractUsage({ choices: [] }), null)
  assert.equal(extractUsage(null), null)
  assert.equal(extractUsage('text'), null)
  assert.equal(extractUsage({ usage: {} }), null)
})

test('withStreamUsage 只在流式且未指定时注入 include_usage', () => {
  const injected = withStreamUsage({ model: 'gpt-4o', stream: true })
  assert.equal(injected.injected, true)
  assert.deepEqual(injected.payload.stream_options, { include_usage: true })

  const notStream = withStreamUsage({ model: 'gpt-4o' })
  assert.equal(notStream.injected, false)

  const explicit = withStreamUsage({ stream: true, stream_options: { include_usage: false } })
  assert.equal(explicit.injected, false)
})

// ------------------------------------------------------------------ SSE 扫描

test('SseUsageScanner 能跨 chunk 边界解析 usage', () => {
  const scanner = new SseUsageScanner()

  scanner.push(Buffer.from('data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"cho'))
  scanner.push(
    Buffer.from(
      'ices":[],"usage":{"prompt_tokens":11,"completion_tokens":22,"total_tokens":33}}\n\n'
    )
  )
  scanner.push(Buffer.from('data: [DONE]\n\n'))
  scanner.finish()

  assert.deepEqual(scanner.usage, {
    promptTokens: 11,
    completionTokens: 22,
    totalTokens: 33
  })
  assert.equal(scanner.sawDone, true)
  assert.ok(scanner.dataBytes > 0)
})

test('SseUsageScanner 在无 usage 时给出带标记的估算', () => {
  const scanner = new SseUsageScanner()
  scanner.push(Buffer.from('data: {"choices":[{"delta":{"content":"hello world"}}]}\n\n'))
  scanner.finish()

  assert.equal(scanner.usage, null)
  const estimate = scanner.estimateFromBytes()
  assert.ok(estimate.totalTokens > 0)
})

test('SseUsageScanner 忽略非 data 行与心跳', () => {
  const scanner = new SseUsageScanner()
  scanner.push(Buffer.from(': keep-alive\n\nevent: ping\n\n'))
  scanner.finish()
  assert.equal(scanner.usage, null)
  assert.equal(scanner.dataBytes, 0)
})

// ------------------------------------------------------------------ 限流与配额

test('quotaExceeded 在配额为 0 时永不超限', () => {
  assert.equal(quotaExceeded(10_000_000, 0), false)
})

test('quotaExceeded 达到或超过配额即判超限', () => {
  assert.equal(quotaExceeded(99, 100), false)
  assert.equal(quotaExceeded(100, 100), true)
  assert.equal(quotaExceeded(101, 100), true)
  assert.equal(quotaExceeded(90, 100, 20), true)
})

test('限流窗口按分钟切分，key 稳定', () => {
  // 取一个正好落在分钟边界上的时间戳，避免边界假设错误
  const t = 1_700_000_000_000 - (1_700_000_000_000 % 60_000)
  assert.equal(currentWindow(t), currentWindow(t + 59_999))
  assert.notEqual(currentWindow(t), currentWindow(t + 60_000))
  assert.equal(rateLimitKey('abc', 42), 'portara:rl:abc:42')
})
