import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AnthropicToOpenAiStream,
  anthropicToOpenai,
  anthropicUsageToOpenai
} from '../src/services/anthropic.js'

/*
 * Anthropic 的 usage 里 input_tokens **不含**缓存部分：命中缓存的读取量在
 * cache_read_input_tokens，写入缓存的量在 cache_creation_input_tokens。
 * 只取 input_tokens 会让回给客户端的 prompt_tokens、request_logs 的 token
 * 累计与 Key 配额扣减系统性偏低 —— 下面用合成的数字把映射钉住。
 */

// ------------------------------------------------------------ usage 归一

test('anthropicUsageToOpenai 老形状：仅 input/output 时总数不变', () => {
  assert.deepEqual(anthropicUsageToOpenai({ input_tokens: 10, output_tokens: 5 }), {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15
  })
})

test('anthropicUsageToOpenai 把 cache_creation 与 cache_read 一并计入 prompt_tokens', () => {
  const usage = anthropicUsageToOpenai({
    input_tokens: 10,
    cache_creation_input_tokens: 20,
    cache_read_input_tokens: 30,
    output_tokens: 5
  })
  assert.deepEqual(usage, {
    prompt_tokens: 60, // 10 + 20 + 30
    completion_tokens: 5,
    total_tokens: 65,
    // OpenAI 官方形状：缓存命中量单列，且 prompt_tokens 已经包含它
    prompt_tokens_details: { cached_tokens: 30 }
  })
})

test('anthropicUsageToOpenai 只带 cache_read 时也计入 prompt_tokens', () => {
  const usage = anthropicUsageToOpenai({ input_tokens: 4, cache_read_input_tokens: 96 })
  assert.equal(usage.prompt_tokens, 100)
  assert.equal(usage.total_tokens, 100)
  assert.deepEqual(usage.prompt_tokens_details, { cached_tokens: 96 })
})

test('anthropicUsageToOpenai 对缺失、undefined、非数字字段按 0 处理', () => {
  const zeros = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  assert.deepEqual(anthropicUsageToOpenai({}), zeros)
  assert.deepEqual(
    anthropicUsageToOpenai({
      input_tokens: undefined,
      cache_creation_input_tokens: undefined,
      cache_read_input_tokens: undefined,
      output_tokens: undefined
    }),
    zeros
  )
  assert.deepEqual(
    anthropicUsageToOpenai({
      input_tokens: null,
      cache_creation_input_tokens: 'abc',
      cache_read_input_tokens: Number.NaN,
      output_tokens: Infinity
    }),
    zeros
  )
})

test('anthropicUsageToOpenai 对负数按 0 处理，不污染总数', () => {
  const usage = anthropicUsageToOpenai({
    input_tokens: -5,
    cache_creation_input_tokens: -1,
    cache_read_input_tokens: -100,
    output_tokens: -3
  })
  assert.deepEqual(usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
  assert.ok(Number.isFinite(usage.total_tokens))
})

test('anthropicUsageToOpenai 对非对象 usage 安全返回全 0', () => {
  const zeros = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  assert.deepEqual(anthropicUsageToOpenai(null), zeros)
  assert.deepEqual(anthropicUsageToOpenai(undefined), zeros)
  assert.deepEqual(anthropicUsageToOpenai([]), zeros)
  assert.deepEqual(anthropicUsageToOpenai('usage'), zeros)
})

test('anthropicUsageToOpenai 接受字符串形式的数字（部分网关这么返回）', () => {
  assert.equal(anthropicUsageToOpenai({ input_tokens: '12', output_tokens: '3' }).total_tokens, 15)
})

// ------------------------------------------------------------ 非流式响应

test('anthropicToOpenai 的 usage 把缓存 token 计入 prompt_tokens', () => {
  const out = anthropicToOpenai(
    {
      content: [{ type: 'text', text: 'x' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
        output_tokens: 5
      }
    },
    'm'
  )
  assert.deepEqual(out.usage, {
    prompt_tokens: 60,
    completion_tokens: 5,
    total_tokens: 65,
    prompt_tokens_details: { cached_tokens: 30 }
  })
})

test('anthropicToOpenai 无缓存时 usage 形状与老版本一致', () => {
  const out = anthropicToOpenai(
    { content: [], stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 2 } },
    'm'
  )
  assert.deepEqual(out.usage, { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 })
})

// ------------------------------------------------------------ 流式响应

/** 把 Anthropic 的 SSE 文本拆成任意大小的字节块喂进去 */
function feed(stream: AnthropicToOpenAiStream, text: string, size = 7): string {
  const bytes = new TextEncoder().encode(text)
  let out = ''
  for (let i = 0; i < bytes.length; i += size) {
    out += stream.push(bytes.slice(i, i + size))
  }
  return out + stream.finish()
}

function openaiChunks(out: string): Record<string, unknown>[] {
  return out
    .split('\n\n')
    .filter((b) => b.startsWith('data: ') && !b.includes('[DONE]'))
    .map((b) => JSON.parse(b.slice(6)) as Record<string, unknown>)
}

/** 拼一段带指定 usage 的 Anthropic SSE（message_start 与可选的 message_delta） */
function sseUsage(startUsage: string, deltaUsage?: string): string {
  const lines = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_u","usage":' + startUsage + '}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
    ''
  ]
  if (deltaUsage !== undefined) {
    lines.push(
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":' + deltaUsage + '}',
      ''
    )
  }
  lines.push('event: message_stop', 'data: {"type":"message_stop"}', '', '')
  return lines.join('\n')
}

test('AnthropicToOpenAiStream 把 message_start 的缓存 token 计入 prompt_tokens', () => {
  const stream = new AnthropicToOpenAiStream('m')
  const chunks = openaiChunks(
    feed(
      stream,
      sseUsage(
        '{"input_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":30,"output_tokens":0}',
        '{"output_tokens":5}'
      )
    )
  )
  assert.deepEqual(chunks.find((c) => c.usage)?.usage, {
    prompt_tokens: 60,
    completion_tokens: 5,
    total_tokens: 65,
    prompt_tokens_details: { cached_tokens: 30 }
  })
})

test('AnthropicToOpenAiStream 的 usage getter 与 usage chunk 同源', () => {
  const stream = new AnthropicToOpenAiStream('m')
  const chunks = openaiChunks(
    feed(
      stream,
      sseUsage(
        '{"input_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":30,"output_tokens":0}',
        '{"output_tokens":5}'
      )
    )
  )
  const chunkUsage = chunks.find((c) => c.usage)?.usage as Record<string, number>
  // 记账侧（relay.translateAnthropicStream）读的就是 getter，两边必须一致
  assert.equal(stream.usage.promptTokens, chunkUsage.prompt_tokens)
  assert.equal(stream.usage.completionTokens, chunkUsage.completion_tokens)
  assert.equal(stream.usage.promptTokens, 60)
})

test('AnthropicToOpenAiStream 在 message_delta 重复给缓存字段时按累计覆盖', () => {
  const stream = new AnthropicToOpenAiStream('m')
  const chunks = openaiChunks(
    feed(
      stream,
      sseUsage(
        '{"input_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":3,"output_tokens":0}',
        '{"input_tokens":100,"cache_creation_input_tokens":5,"cache_read_input_tokens":90,"output_tokens":7}'
      )
    )
  )
  // 覆盖而非相加：100 + 5 + 90；若相加会得到 213（重复计账）
  assert.deepEqual(chunks.find((c) => c.usage)?.usage, {
    prompt_tokens: 195,
    completion_tokens: 7,
    total_tokens: 202,
    prompt_tokens_details: { cached_tokens: 90 }
  })
})

test('AnthropicToOpenAiStream 老形状（无缓存）不带 prompt_tokens_details', () => {
  const stream = new AnthropicToOpenAiStream('m')
  const chunks = openaiChunks(
    feed(stream, sseUsage('{"input_tokens":12,"output_tokens":0}', '{"output_tokens":7}'))
  )
  assert.deepEqual(chunks.find((c) => c.usage)?.usage, {
    prompt_tokens: 12,
    completion_tokens: 7,
    total_tokens: 19
  })
})

test('AnthropicToOpenAiStream 对负数与非法 usage 字段容错为 0', () => {
  const stream = new AnthropicToOpenAiStream('m')
  const chunks = openaiChunks(
    feed(
      stream,
      sseUsage(
        '{"input_tokens":-5,"cache_creation_input_tokens":"abc","cache_read_input_tokens":null,"output_tokens":0}',
        '{"output_tokens":-3}'
      )
    )
  )
  const usage = chunks.find((c) => c.usage)?.usage as Record<string, number>
  assert.deepEqual(usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
  assert.ok(Number.isFinite(usage.total_tokens))
})
