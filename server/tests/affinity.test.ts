import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  pickBySession,
  rankBySession,
  sessionKeyOf,
  shortSessionHash
} from '../src/services/affinityPure.js'
import { orderRoutes } from '../src/services/routeOrder.js'

/**
 * 会话亲和的两个纯函数。
 *
 * 这里只测**不依赖 Redis/DB 的部分** —— 键的提取与加权 rendezvous 的选择，
 * 它们决定了「哪个会话落到哪个渠道」，一旦不确定就会表现为
 * 「同一会话每次换渠道、缓存全灭」，而且这种问题在生产上极难复现。
 */

test('sessionKeyOf 优先使用 prompt_cache_key', () => {
  const key = sessionKeyOf({
    model: 'x',
    prompt_cache_key: 'sess-abc',
    messages: [{ role: 'user', content: 'hi' }]
  })
  assert.equal(key.source, 'prompt_cache_key')
  assert.equal(key.hash.length, 64)
})

test('sessionKeyOf 没有 pck 时退回上下文指纹', () => {
  const a = sessionKeyOf(
    {
      messages: [
        { role: 'system', content: 'you are a helper' },
        { role: 'user', content: 'hello' }
      ]
    },
    { allowContext: true }
  )
  const b = sessionKeyOf(
    {
      messages: [
        { role: 'system', content: 'you are a helper' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'ignored' },
        { role: 'user', content: 'ignored too' }
      ]
    },
    { allowContext: true }
  )
  assert.equal(a.source, 'context')
  // 只取 system + 首条 user：后续轮次变化不该改变会话身份
  assert.equal(a.hash, b.hash)
})

test('sessionKeyOf 不同首条消息 → 不同会话', () => {
  const a = sessionKeyOf({ messages: [{ role: 'user', content: 'A' }] }, { allowContext: true })
  const b = sessionKeyOf({ messages: [{ role: 'user', content: 'B' }] }, { allowContext: true })
  assert.notEqual(a.hash, b.hash)
})

test('sessionKeyOf 拿不到任何信号时不做亲和', () => {
  assert.equal(sessionKeyOf(null).source, 'none')
  assert.equal(sessionKeyOf({}).source, 'none')
  assert.equal(sessionKeyOf({ messages: [] }, { allowContext: true }).source, 'none')
  // 空串 / 超长 pck 视为无效
  assert.equal(sessionKeyOf({ prompt_cache_key: '   ' }).source, 'none')
  assert.equal(sessionKeyOf({ prompt_cache_key: 'x'.repeat(300) }).source, 'none')
})

test('多模态消息只取文字片段做指纹', () => {
  const key = sessionKeyOf(
    {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe this' },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }
          ]
        }
      ]
    },
    { allowContext: true }
  )
  assert.equal(key.source, 'context')
  const sameText = sessionKeyOf(
    { messages: [{ role: 'user', content: [{ type: 'text', text: 'describe this' }] }] },
    { allowContext: true }
  )
  assert.equal(key.hash, sameText.hash, '图片变化不该改变会话身份')
})

test('shortSessionHash 只留 8 位', () => {
  assert.equal(shortSessionHash('0123456789abcdef').length, 8)
  assert.equal(shortSessionHash(''), '')
})

const targets = [
  { id: 'ch-a', weight: 1 },
  { id: 'ch-b', weight: 1 },
  { id: 'ch-c', weight: 1 }
]

test('pickBySession 对同一会话是确定的', () => {
  const first = pickBySession('session-1', targets)
  for (let i = 0; i < 20; i++) {
    assert.equal(pickBySession('session-1', targets)?.id, first?.id)
  }
})

test('不同的会话会分散到不同目标上', () => {
  const counts = new Map<string, number>()
  for (let i = 0; i < 300; i++) {
    const picked = pickBySession(`session-${i}`, targets)
    counts.set(picked!.id, (counts.get(picked!.id) ?? 0) + 1)
  }
  assert.equal(counts.size, 3, `三个目标都该被用到：${JSON.stringify([...counts])}`)
  for (const n of counts.values()) {
    // 300 个会话分 3 个目标，允许 ±50% 的波动（哈希不是精确均分）
    assert.ok(n > 50 && n < 150, `分布过于集中：${JSON.stringify([...counts])}`)
  }
})

test('增删目标时只迁移原本落在那的目标（rendezvous 而非取模）', () => {
  const before = new Map<number, string>()
  for (let i = 0; i < 200; i++) before.set(i, pickBySession(`s${i}`, targets)!.id)

  const shrunk = targets.filter((t) => t.id !== 'ch-c')
  let moved = 0
  for (let i = 0; i < 200; i++) {
    const now = pickBySession(`s${i}`, shrunk)!
    if (now.id !== before.get(i)) moved++
  }
  // 取模会让几乎全部迁移；rendezvous 只迁移原本落在 ch-c 上的那部分
  assert.ok(moved > 40 && moved < 100, `迁移比例异常：${moved}/200`)
})

test('权重更高的目标拿到更多会话', () => {
  const weighted = [
    { id: 'small', weight: 1 },
    { id: 'big', weight: 9 }
  ]
  let big = 0
  for (let i = 0; i < 400; i++) {
    if (pickBySession(`w${i}`, weighted)!.id === 'big') big++
  }
  assert.ok(big > 260, `权重 9:1 时 big 只拿到 ${big}/400`)
})

test('rankBySession 是 pickBySession 的全序', () => {
  const ranked = rankBySession('session-x', targets)
  assert.equal(ranked.length, 3)
  assert.equal(new Set(ranked.map((r) => r.id)).size, 3)
  assert.equal(ranked[0]!.id, pickBySession('session-x', targets)!.id)
})

test('orderRoutes：有亲和时把亲和目标提到首位，无亲和时按哈希', () => {
  const rows = ['a', 'b', 'c'].map((id, i) => ({
    id: `route-${id}`,
    channel_id: `ch-${id}`,
    alias: 'alias',
    upstream_model: `m-${id}`,
    priority: 100,
    weight: 1,
    status: 'active',
    note: '',
    group_key: '',
    created_at: '',
    updated_at: '',
    c_name: id,
    c_status: 'active',
    c_base_url: '',
    c_api_key_cipher: '',
    c_vendor: 'generic',
    c_extra_headers: {},
    c_timeout_ms: 1000,
    c_protocol: 'openai',
    c_model_overrides: {},
    c_proxy_id: null,
    c_hide_unmapped_models: false,
    _i: i
  }))

  const hash = sessionKeyOf({ prompt_cache_key: 'pinned' }).hash

  // 无亲和：按哈希排，同一会话稳定
  const a = orderRoutes(rows, 1, { sessionHash: hash, affinity: null }).map((r) => r.channel_id)
  const b = orderRoutes(rows, 99, { sessionHash: hash, affinity: null }).map((r) => r.channel_id)
  assert.deepEqual(a, b, '同一会话不受 rotation 影响')

  // 有亲和：目标必须排第一
  const pinnedChannel = a[2]! // 故意挑一个原本不是首位的
  const c = orderRoutes(rows, 1, {
    sessionHash: hash,
    affinity: { channelId: pinnedChannel, accountId: 'acc-1' }
  }).map((r) => r.channel_id)
  assert.equal(c[0], pinnedChannel)
  assert.equal(c.length, 3)
})

test('orderRoutes：亲和指向已失效渠道时退回哈希排序', () => {
  const rows = ['a', 'b'].map((id) => ({
    id: `route-${id}`,
    channel_id: `ch-${id}`,
    alias: 'alias',
    upstream_model: `m-${id}`,
    priority: 100,
    weight: 1,
    status: 'active',
    note: '',
    group_key: '',
    created_at: '',
    updated_at: '',
    c_name: id,
    c_status: 'active',
    c_base_url: '',
    c_api_key_cipher: '',
    c_vendor: 'generic',
    c_extra_headers: {},
    c_timeout_ms: 1000,
    c_protocol: 'openai',
    c_model_overrides: {},
    c_proxy_id: null,
    c_hide_unmapped_models: false
  }))
  const hash = sessionKeyOf({ prompt_cache_key: 'x' }).hash
  const out = orderRoutes(rows, 1, {
    sessionHash: hash,
    affinity: { channelId: 'ch-gone', accountId: '' }
  })
  assert.equal(out.length, 2)
})

test('orderRoutes：没有会话键时保持原有优先级 + 轮转语义', () => {
  const mk = (channel: string, priority: number, weight = 1) => ({
    id: `route-${channel}`,
    channel_id: channel,
    alias: 'alias',
    upstream_model: 'm',
    priority,
    weight,
    status: 'active',
    note: '',
    group_key: '',
    created_at: '',
    updated_at: '',
    c_name: channel,
    c_status: 'active',
    c_base_url: '',
    c_api_key_cipher: '',
    c_vendor: 'generic',
    c_extra_headers: {},
    c_timeout_ms: 1000,
    c_protocol: 'openai',
    c_model_overrides: {},
    c_proxy_id: null,
    c_hide_unmapped_models: false
  })
  const rows = [mk('high', 10), mk('low', 20)]
  const out = orderRoutes(rows, 1, {}).map((r) => r.channel_id)
  assert.equal(out[0], 'high', '优先级更高的渠道必须排第一')
  assert.equal(out[1], 'low')
})

test('默认不用上下文指纹（避免模板化调用被误合并）', () => {
  const key = sessionKeyOf({ messages: [{ role: 'user', content: 'same prompt' }] })
  assert.equal(key.source, 'none')
})
