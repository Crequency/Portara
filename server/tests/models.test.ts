import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildModelsUrl,
  extractModelInfo,
  parseModelsResponse
} from '../src/services/models.js'

// ------------------------------------------------------------ 地址拼接

test('buildModelsUrl 跟随渠道配置的路径，默认 /models', () => {
  assert.equal(buildModelsUrl('https://api.openai.com/v1', '/models'), 'https://api.openai.com/v1/models')
  assert.equal(buildModelsUrl('https://api.openai.com/v1/', '/models'), 'https://api.openai.com/v1/models')
  assert.equal(buildModelsUrl('https://api.openai.com/v1', ''), 'https://api.openai.com/v1/models')
})

test('buildModelsUrl 支持自定义路径与缺少前导斜杠', () => {
  assert.equal(buildModelsUrl('https://x.example/v1', '/v1/models'), 'https://x.example/v1/v1/models')
  assert.equal(buildModelsUrl('https://x.example/v1', 'models'), 'https://x.example/v1/models')
  assert.equal(buildModelsUrl('https://x.example/api', '/openai/models'), 'https://x.example/api/openai/models')
})

// ------------------------------------------------------------ 单条提取

test('extractModelInfo 支持裸字符串', () => {
  assert.deepEqual(extractModelInfo('gpt-4o'), {
    id: 'gpt-4o',
    contextLength: null,
    maxOutputTokens: null,
    ownedBy: null,
    created: null,
    raw: {}
  })
})

test('extractModelInfo 支持 Ollama 的 name 字段', () => {
  const info = extractModelInfo({ name: 'llama3:8b', size: 123 })
  assert.equal(info?.id, 'llama3:8b')
  assert.equal(info?.raw.size, 123)
})

test('extractModelInfo 识别多种上下文长度字段名', () => {
  assert.equal(extractModelInfo({ id: 'a', context_length: 131072 })?.contextLength, 131072)
  assert.equal(extractModelInfo({ id: 'a', context_window: 200000 })?.contextLength, 200000)
  assert.equal(extractModelInfo({ id: 'a', max_model_len: 32768 })?.contextLength, 32768)
  assert.equal(extractModelInfo({ id: 'a', max_input_tokens: 8192 })?.contextLength, 8192)
  // 字符串数字也能识别
  assert.equal(extractModelInfo({ id: 'a', context_length: '64000' })?.contextLength, 64000)
})

test('extractModelInfo 识别最大输出长度', () => {
  const info = extractModelInfo({ id: 'a', max_output_tokens: 4096, max_completion_tokens: 8192 })
  // 按优先级取第一个命中的字段
  assert.equal(info?.maxOutputTokens, 4096)
})

test('extractModelInfo 对缺失或非法值返回 null 而不是 0', () => {
  const info = extractModelInfo({ id: 'a', context_length: 0, max_output_tokens: 'abc' })
  assert.equal(info?.contextLength, null)
  assert.equal(info?.maxOutputTokens, null)
})

test('extractModelInfo 只保留标量原始字段，丢掉嵌套结构', () => {
  const info = extractModelInfo({
    id: 'a',
    pricing: { prompt: 1 },
    architecture: { modality: 'text' },
    nice: true
  })
  assert.equal(info?.raw.pricing, undefined)
  assert.equal(info?.raw.architecture, undefined)
  assert.equal(info?.raw.nice, true)
})

test('extractModelInfo 对无 id 的条目返回 null', () => {
  assert.equal(extractModelInfo({ object: 'model' }), null)
  assert.equal(extractModelInfo(null), null)
  assert.equal(extractModelInfo(42), null)
  assert.equal(extractModelInfo('   '), null)
})

// ------------------------------------------------------------ 整体解析

test('parseModelsResponse 解析 OpenAI 形状并按 id 排序去重', () => {
  const { models, warnings } = parseModelsResponse({
    object: 'list',
    data: [
      { id: 'b-model', owned_by: 'x', context_length: 1000 },
      { id: 'a-model', owned_by: 'y' },
      { id: 'b-model', owned_by: 'dup' }
    ]
  })
  assert.deepEqual(warnings, [])
  assert.deepEqual(models.map((m) => m.id), ['a-model', 'b-model'])
  assert.equal(models[1]?.contextLength, 1000)
  assert.equal(models[1]?.ownedBy, 'x')
})

test('parseModelsResponse 解析 Ollama 形状', () => {
  const { models } = parseModelsResponse({ models: [{ name: 'llama3' }, { name: 'qwen2' }] })
  assert.deepEqual(models.map((m) => m.id), ['llama3', 'qwen2'])
})

test('parseModelsResponse 解析裸数组（字符串与对象混合）', () => {
  const { models } = parseModelsResponse(['x', { id: 'y', context_length: 5 }])
  assert.deepEqual(models.map((m) => m.id), ['x', 'y'])
})

test('parseModelsResponse 对无法识别的形状给出警告而非抛错', () => {
  const r = parseModelsResponse({ foo: 'bar' })
  assert.deepEqual(r.models, [])
  assert.equal(r.warnings.length, 1)
  assert.equal(parseModelsResponse(null).models.length, 0)
  assert.equal(parseModelsResponse('text').models.length, 0)
})

test('parseModelsResponse 跳过无效条目但保留有效条目', () => {
  const { models, warnings } = parseModelsResponse({
    data: [{ id: 'good' }, { object: 'model' }, null]
  })
  assert.deepEqual(models.map((m) => m.id), ['good'])
  assert.equal(warnings.length, 2)
})
