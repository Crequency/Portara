import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildUpstreamUrl } from '../src/services/proxy.js'
import { planUpstreamRequest } from '../src/services/relay.js'

// ------------------------------------------------------------ 地址拼接容错

test('buildUpstreamUrl 正常拼接前缀与路径', () => {
  assert.equal(
    buildUpstreamUrl('https://api.openai.com/v1', '/chat/completions'),
    'https://api.openai.com/v1/chat/completions'
  )
  assert.equal(
    buildUpstreamUrl('https://api.anthropic.com/v1/', '/messages'),
    'https://api.anthropic.com/v1/messages'
  )
})

test('buildUpstreamUrl 在 base 已含该路径时不再重复拼接', () => {
  // 真实误配：用户把完整端点填进了 Base URL
  assert.equal(
    buildUpstreamUrl('https://api.commandcode.ai/provider/v1/messages', '/messages'),
    'https://api.commandcode.ai/provider/v1/messages'
  )
  assert.equal(
    buildUpstreamUrl('https://x.example/v1/chat/completions', '/chat/completions'),
    'https://x.example/v1/chat/completions'
  )
})

test('buildUpstreamUrl 不会误判「以该串结尾但并非该路径」', () => {
  // /foo-messages 不以 /messages 结尾（缺少分隔斜杠）
  assert.equal(
    buildUpstreamUrl('https://x.example/v1/foo-messages', '/messages'),
    'https://x.example/v1/foo-messages/messages'
  )
})

// ------------------------------------------------------------ 请求规划

const openaiChannel = { base_url: 'https://api.openai.com/v1', protocol: 'openai' }
const anthChannel = { base_url: 'https://api.anthropic.com/v1', protocol: 'anthropic' }
const mixedChannel = {
  base_url: 'https://api.commandcode.ai/provider/v1',
  protocol: 'mixed',
  model_overrides: {
    'claude-opus-5': { protocol: 'anthropic' },
    'claude-opus-5-full': {
      protocol: 'anthropic',
      baseUrl: 'https://api.commandcode.ai/provider/v1/messages'
    }
  }
}

test('planUpstreamRequest：OpenAI 渠道走 /chat/completions 且请求体不动', () => {
  const raw = JSON.stringify({ model: 'gpt-4o', messages: [] })
  const plan = planUpstreamRequest({
    channel: openaiChannel,
    upstreamModel: 'gpt-4o',
    restPath: '/chat/completions',
    payload: { model: 'gpt-4o', messages: [] },
    rawBody: raw,
    injectStreamUsage: false
  })
  assert.equal(plan.protocol, 'openai')
  assert.equal(plan.url, 'https://api.openai.com/v1/chat/completions')
  assert.equal(plan.bodyText, raw) // 未改写则原字节直通
})

test('planUpstreamRequest：Anthropic 渠道改走 /messages 并翻译请求体', () => {
  const plan = planUpstreamRequest({
    channel: anthChannel,
    upstreamModel: 'claude-x',
    restPath: '/chat/completions',
    payload: { model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] },
    rawBody: '{}',
    injectStreamUsage: true
  })
  assert.equal(plan.protocol, 'anthropic')
  assert.equal(plan.url, 'https://api.anthropic.com/v1/messages')
  const body = JSON.parse(plan.bodyText!)
  assert.equal(body.model, 'claude-x')
  assert.equal(body.max_tokens, 4096) // 自动补齐
  assert.equal(body.stream_options, undefined) // 不该带 OpenAI 的字段
})

test('planUpstreamRequest：混杂模式下逐模型覆盖决定协议与地址', () => {
  const a = planUpstreamRequest({
    channel: mixedChannel,
    upstreamModel: 'claude-opus-5',
    restPath: '/chat/completions',
    payload: { model: 'claude-opus-5', messages: [] },
    rawBody: '{}',
    injectStreamUsage: false
  })
  assert.equal(a.protocol, 'anthropic')
  assert.equal(a.url, 'https://api.commandcode.ai/provider/v1/messages')

  // 未覆盖的模型回退到渠道默认（mixed → openai）
  const b = planUpstreamRequest({
    channel: mixedChannel,
    upstreamModel: 'gpt-5.4',
    restPath: '/chat/completions',
    payload: { model: 'gpt-5.4', messages: [] },
    rawBody: '{}',
    injectStreamUsage: false
  })
  assert.equal(b.protocol, 'openai')
  assert.equal(b.url, 'https://api.commandcode.ai/provider/v1/chat/completions')
})

test('planUpstreamRequest：逐模型 Base URL 填了完整端点也不会拼重复', () => {
  const plan = planUpstreamRequest({
    channel: mixedChannel,
    upstreamModel: 'claude-opus-5-full',
    restPath: '/chat/completions',
    payload: { model: 'claude-opus-5-full', messages: [] },
    rawBody: '{}',
    injectStreamUsage: false
  })
  assert.equal(plan.url, 'https://api.commandcode.ai/provider/v1/messages')
  assert.ok(!plan.url.includes('/messages/messages'), '路径重复了')
})

test('planUpstreamRequest：只在 OpenAI 协议且被要求时注入 stream_options', () => {
  const streamPayload = { model: 'm', stream: true, messages: [] }
  const injected = planUpstreamRequest({
    channel: openaiChannel,
    upstreamModel: 'm',
    restPath: '/chat/completions',
    payload: streamPayload,
    rawBody: '{}',
    injectStreamUsage: true
  })
  assert.equal(JSON.parse(injected.bodyText!).stream_options.include_usage, true)

  const notInjected = planUpstreamRequest({
    channel: openaiChannel,
    upstreamModel: 'm',
    restPath: '/chat/completions',
    payload: streamPayload,
    rawBody: '{}',
    injectStreamUsage: false
  })
  assert.equal(notInjected.bodyText, '{}')
})

test('planUpstreamRequest：payloadRewritten 时必须重新序列化', () => {
  const raw = JSON.stringify({ model: 'alias', messages: [] })
  const plan = planUpstreamRequest({
    channel: openaiChannel,
    upstreamModel: 'real-model',
    restPath: '/chat/completions',
    payload: { model: 'real-model', messages: [] },
    rawBody: raw,
    injectStreamUsage: false,
    payloadRewritten: true
  })
  // 若忽略这个信号，发出去的会是原始字节（模型名还是 alias）—— 曾经的回归
  assert.equal(JSON.parse(plan.bodyText!).model, 'real-model')
})

test('planUpstreamRequest：未改写且无需注入时保持原字节直通', () => {
  const raw = JSON.stringify({ model: 'same', messages: [{ role: 'user', content: 'x' }] })
  const plan = planUpstreamRequest({
    channel: openaiChannel,
    upstreamModel: 'same',
    restPath: '/chat/completions',
    payload: { model: 'same', messages: [{ role: 'user', content: 'x' }] },
    rawBody: raw,
    injectStreamUsage: false
  })
  assert.equal(plan.bodyText, raw)
})
