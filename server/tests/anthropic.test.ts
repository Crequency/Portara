import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AnthropicToOpenAiStream,
  anthropicToOpenai,
  openaiToAnthropic
} from '../src/services/anthropic.js'

// ------------------------------------------------------------ 请求翻译

test('openaiToAnthropic 基本转换：messages + model + max_tokens', () => {
  const { body, warnings } = openaiToAnthropic(
    { model: 'x', messages: [{ role: 'user', content: '你好' }], max_tokens: 100 },
    'claude-x'
  )
  assert.equal(body.model, 'claude-x')
  assert.equal(body.max_tokens, 100)
  assert.deepEqual(body.messages, [{ role: 'user', content: '你好' }])
  assert.deepEqual(warnings, [])
})

test('openaiToAnthropic 把 system 抽成顶层 system 字段', () => {
  const { body } = openaiToAnthropic(
    {
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'system', content: '回答要简短' },
        { role: 'user', content: 'hi' }
      ]
    },
    'm'
  )
  assert.equal(body.system, '你是助手\n\n回答要简短')
  assert.equal((body.messages as unknown[]).length, 1)
})

test('openaiToAnthropic 缺 max_tokens 时补默认值并给出警告', () => {
  const { body, warnings } = openaiToAnthropic({ messages: [{ role: 'user', content: 'x' }] }, 'm')
  assert.equal(body.max_tokens, 4096)
  assert.ok(warnings.some((w) => w.includes('max_tokens')))
})

test('openaiToAnthropic 转换 stop 为 stop_sequences', () => {
  assert.deepEqual(openaiToAnthropic({ messages: [], stop: 'END' }, 'm').body.stop_sequences, ['END'])
  assert.deepEqual(openaiToAnthropic({ messages: [], stop: ['a', 'b'] }, 'm').body.stop_sequences, [
    'a',
    'b'
  ])
})

test('openaiToAnthropic 转换 tools 与 tool_choice', () => {
  const { body } = openaiToAnthropic(
    {
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: '查天气', parameters: { type: 'object' } }
        }
      ],
      tool_choice: 'required'
    },
    'm'
  )
  assert.deepEqual(body.tools, [
    { name: 'get_weather', description: '查天气', input_schema: { type: 'object' } }
  ])
  assert.deepEqual(body.tool_choice, { type: 'any' })
})

test('openaiToAnthropic 转换 data URL 图片为 base64 source', () => {
  const { body } = openaiToAnthropic(
    {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
          ]
        }
      ]
    },
    'm'
  )
  const content = (body.messages as { content: unknown[] }[])[0]!.content
  assert.deepEqual(content, [
    { type: 'text', text: '看图' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
  ])
})

test('openaiToAnthropic 把 assistant 的 tool_calls 转成 tool_use block', () => {
  const { body } = openaiToAnthropic(
    {
      messages: [
        { role: 'user', content: 'x' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }
          ]
        },
        { role: 'tool', tool_call_id: 'call_1', content: '结果' }
      ]
    },
    'm'
  )
  const msgs = body.messages as { role: string; content: unknown[] }[]
  assert.equal(msgs[1]!.role, 'assistant')
  assert.deepEqual(msgs[1]!.content[0], {
    type: 'tool_use',
    id: 'call_1',
    name: 'f',
    input: { a: 1 }
  })
  // tool 角色 → user + tool_result
  assert.equal(msgs[2]!.role, 'user')
  assert.deepEqual(msgs[2]!.content[0], {
    type: 'tool_result',
    tool_use_id: 'call_1',
    content: '结果'
  })
})

test('openaiToAnthropic 合并相邻同角色消息（Anthropic 要求交替）', () => {
  const { body } = openaiToAnthropic(
    {
      messages: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
        { role: 'assistant', content: 'c' }
      ]
    },
    'm'
  )
  const msgs = body.messages as { role: string }[]
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0]!.role, 'user')
  assert.equal(msgs[1]!.role, 'assistant')
})

test('openaiToAnthropic 在首条不是 user 时补一条空 user', () => {
  const { body, warnings } = openaiToAnthropic(
    { messages: [{ role: 'assistant', content: 'hi' }] },
    'm'
  )
  const msgs = body.messages as { role: string }[]
  assert.equal(msgs[0]!.role, 'user')
  assert.ok(warnings.some((w) => w.includes('首条消息')))
})

test('openaiToAnthropic 对空 messages 兜底', () => {
  const { body, warnings } = openaiToAnthropic({ messages: [] }, 'm')
  assert.equal((body.messages as unknown[]).length, 1)
  assert.ok(warnings.some((w) => w.includes('消息为空')))
})

test('openaiToAnthropic 对无对应语义的字段给出警告', () => {
  const { warnings } = openaiToAnthropic(
    { messages: [{ role: 'user', content: 'x' }], presence_penalty: 1, seed: 42, n: 2 },
    'm'
  )
  for (const f of ['presence_penalty', 'seed', 'n']) {
    assert.ok(warnings.some((w) => w.includes(f)), `缺少 ${f} 的警告`)
  }
})

// ------------------------------------------------------------ 非流式响应翻译

test('anthropicToOpenai 拼接文本块并映射 stop_reason', () => {
  const out = anthropicToOpenai(
    {
      id: 'msg_1',
      content: [
        { type: 'text', text: '你好' },
        { type: 'text', text: '世界' }
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 }
    },
    'my-alias'
  )
  const choice = (out.choices as Record<string, unknown>[])[0]!
  assert.equal((choice.message as Record<string, unknown>).content, '你好世界')
  assert.equal(choice.finish_reason, 'stop')
  assert.equal(out.model, 'my-alias') // 回给调用方的应是它请求的名字
  assert.deepEqual(out.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
})

test('anthropicToOpenai 把 tool_use 转成 tool_calls', () => {
  const out = anthropicToOpenai(
    {
      content: [{ type: 'tool_use', id: 'tu_1', name: 'f', input: { a: 1 } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 2 }
    },
    'm'
  )
  const choice = (out.choices as Record<string, unknown>[])[0]!
  assert.equal(choice.finish_reason, 'tool_calls')
  assert.deepEqual((choice.message as Record<string, unknown>).tool_calls, [
    { id: 'tu_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }
  ])
})

test('anthropicToOpenai 映射 max_tokens → length', () => {
  const out = anthropicToOpenai(
    { content: [{ type: 'text', text: 'x' }], stop_reason: 'max_tokens', usage: {} },
    'm'
  )
  assert.equal((out.choices as Record<string, unknown>[])[0]!.finish_reason, 'length')
})

// ------------------------------------------------------------ 流式翻译

/** 把 Anthropic 的 SSE 文本拆成任意大小的字节块喂进去 */
function feed(stream: AnthropicToOpenAiStream, text: string, size = 7): string {
  const bytes = new TextEncoder().encode(text)
  let out = ''
  for (let i = 0; i < bytes.length; i += size) {
    out += stream.push(bytes.slice(i, i + size))
  }
  return out + stream.finish()
}

const SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","model":"claude","usage":{"input_tokens":12,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"世界"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  ''
].join('\n')

function openaiChunks(out: string): Record<string, unknown>[] {
  return out
    .split('\n\n')
    .filter((b) => b.startsWith('data: ') && !b.includes('[DONE]'))
    .map((b) => JSON.parse(b.slice(6)) as Record<string, unknown>)
}

test('AnthropicToOpenAiStream 输出 OpenAI 风格的 chunk 序列', () => {
  const stream = new AnthropicToOpenAiStream('my-alias')
  const out = feed(stream, SSE)
  const chunks = openaiChunks(out)

  // 第一条带 role
  assert.deepEqual(
    (chunks[0]!.choices as Record<string, unknown>[])[0]!.delta,
    { role: 'assistant', content: '' }
  )
  // 文本增量
  const texts = chunks
    .map((c) => ((c.choices as Record<string, unknown>[])[0]?.delta as Record<string, unknown>)?.content)
    .filter((t) => typeof t === 'string' && t.length > 0)
  assert.deepEqual(texts, ['你好', '世界'])
  // 收尾：finish_reason + usage + [DONE]
  const finish = chunks.find(
    (c) => (c.choices as Record<string, unknown>[])[0]?.finish_reason === 'stop'
  )
  assert.ok(finish, '缺少 finish_reason=stop 的收尾 chunk')
  const usageChunk = chunks.find((c) => c.usage)
  assert.deepEqual(usageChunk?.usage, {
    prompt_tokens: 12,
    completion_tokens: 7,
    total_tokens: 19
  })
  assert.ok(out.trimEnd().endsWith('data: [DONE]'))
})

test('AnthropicToOpenAiStream 跨字节边界也能正确解析（每次 1 字节）', () => {
  const stream = new AnthropicToOpenAiStream('m')
  const out = feed(stream, SSE, 1)
  assert.ok(out.includes('你好'))
  assert.ok(out.includes('世界'))
  assert.ok(out.includes('[DONE]'))
})

test('AnthropicToOpenAiStream 回给调用方的是请求时的模型名', () => {
  const stream = new AnthropicToOpenAiStream('opencode-go/claude-x')
  const chunks = openaiChunks(feed(stream, SSE))
  assert.equal(chunks[0]!.model, 'opencode-go/claude-x')
})

test('AnthropicToOpenAiStream 在上游没发 message_stop 时也补收尾', () => {
  const partial = SSE.replace(/event: message_stop\n[\s\S]*$/, '')
  const stream = new AnthropicToOpenAiStream('m')
  const out = feed(stream, partial)
  assert.ok(out.includes('"finish_reason":"stop"'), '缺少收尾 chunk')
  assert.ok(out.includes('[DONE]'))
})

test('AnthropicToOpenAiStream 转换 tool_use 增量', () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"f"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":"}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    ''
  ].join('\n')
  const stream = new AnthropicToOpenAiStream('m')
  const chunks = openaiChunks(feed(stream, sse))
  const toolChunk = chunks.find(
    (c) => ((c.choices as Record<string, unknown>[])[0]?.delta as Record<string, unknown>)?.tool_calls
  )
  assert.ok(toolChunk, '缺少 tool_calls chunk')
  const tc = ((toolChunk.choices as Record<string, unknown>[])[0]!.delta as Record<string, unknown>)
    .tool_calls as Record<string, unknown>[]
  assert.equal(tc[0]!.id, 'tu_1')
  assert.equal((tc[0]!.function as Record<string, unknown>).name, 'f')
})

test('AnthropicToOpenAiStream 把 error 事件转成错误 chunk', () => {
  const sse =
    'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"过载"}}\n\n'
  const stream = new AnthropicToOpenAiStream('m')
  const out = feed(stream, sse)
  assert.ok(out.includes('过载'))
  assert.ok(out.includes('[DONE]'))
})

test('AnthropicToOpenAiStream 忽略无法解析的行', () => {
  const stream = new AnthropicToOpenAiStream('m')
  const out = feed(stream, ': keep-alive\n\nevent: ping\ndata: not-json\n\n')
  assert.equal(openaiChunks(out).length, 0)
})
