import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  flattenJsonMapping,
  resolveChannelRefs,
  type ChannelRef,
  type IncomingRoute
} from '../src/services/mapping.js'

const CHANNELS: ChannelRef[] = [
  { id: 'id-deepseek', name: 'Deepseek' },
  { id: 'id-opencode', name: 'OpenCode' }
]

function inc(partial: Partial<IncomingRoute> & { alias: string }): IncomingRoute {
  return {
    channel: 'Deepseek',
    model: 'deepseek-flash',
    priority: 100,
    weight: 1,
    ...partial
  }
}

// ------------------------------------------------------------ 渠道名解析

test('resolveChannelRefs 按渠道名解析为 id', () => {
  const r = resolveChannelRefs([inc({ alias: 'deepseek/flash' })], CHANNELS)
  assert.equal(r.unknown.length, 0)
  assert.deepEqual(r.resolved[0], {
    alias: 'deepseek/flash',
    channelId: 'id-deepseek',
    channelName: 'Deepseek',
    upstreamModel: 'deepseek-flash',
    priority: 100,
    weight: 1
  })
})

test('resolveChannelRefs 对大小写与首尾空格宽松匹配', () => {
  const r = resolveChannelRefs(
    [inc({ alias: 'a', channel: '  deepseek official  ' })],
    CHANNELS
  )
  assert.equal(r.unknown.length, 0)
  assert.equal(r.resolved[0]?.channelId, 'id-deepseek')
})

test('resolveChannelRefs 收集不存在的渠道名并给出可用列表', () => {
  const r = resolveChannelRefs(
    [inc({ alias: 'a', channel: 'Typo Channel' }), inc({ alias: 'b', channel: 'Nope' })],
    CHANNELS
  )
  assert.deepEqual(r.unknown.sort(), ['Nope', 'Typo Channel'])
  assert.equal(r.resolved.length, 0)
  assert.deepEqual(r.available, ['Deepseek', 'OpenCode'])
})

test('resolveChannelRefs 检出同一 alias 下的重复目标', () => {
  const r = resolveChannelRefs(
    [inc({ alias: 'dup' }), inc({ alias: 'dup' })],
    CHANNELS
  )
  assert.equal(r.resolved.length, 1)
  assert.equal(r.duplicates.length, 1)
  assert.ok(r.duplicates[0]!.includes('dup'))
})

test('resolveChannelRefs 允许同一 alias 指向不同渠道（负载均衡）', () => {
  const r = resolveChannelRefs(
    [
      inc({ alias: 'lb', channel: 'Deepseek', weight: 2 }),
      inc({ alias: 'lb', channel: 'OpenCode', weight: 1 })
    ],
    CHANNELS
  )
  assert.equal(r.duplicates.length, 0)
  assert.equal(r.resolved.length, 2)
})

// ------------------------------------------------------------ JSON 结构

test('flattenJsonMapping 支持单目标对象写法（用户给的示例格式）', () => {
  const { routes, errors } = flattenJsonMapping({
    'deepseek/deepseek-flash': { channel: 'Deepseek', model: 'deepseek-flash' }
  })
  assert.deepEqual(errors, [])
  assert.deepEqual(routes, [
    {
      alias: 'deepseek/deepseek-flash',
      channel: 'Deepseek',
      model: 'deepseek-flash',
      priority: 100,
      weight: 1
    }
  ])
})

test('flattenJsonMapping 支持数组写法（一个 ID 负载均衡到多个目标）', () => {
  const { routes, errors } = flattenJsonMapping({
    lb: [
      { channel: 'A', model: 'm1', weight: 2 },
      { channel: 'B', model: 'm2', priority: 10 }
    ]
  })
  assert.deepEqual(errors, [])
  assert.equal(routes.length, 2)
  assert.equal(routes[0]!.weight, 2)
  assert.equal(routes[1]!.priority, 10)
  assert.equal(routes[1]!.weight, 1)
})

test('flattenJsonMapping 报告缺字段与空目标', () => {
  const { routes, errors } = flattenJsonMapping({
    a: { channel: 'C' } as never,
    b: { model: 'm' } as never,
    c: [] as never
  })
  assert.equal(routes.length, 0)
  assert.equal(errors.length, 3)
  assert.ok(errors.some((e) => e.includes('缺少 model')))
  assert.ok(errors.some((e) => e.includes('缺少 channel')))
  assert.ok(errors.some((e) => e.includes('目标为空')))
})

test('flattenJsonMapping 对空对象返回空结果且不报错', () => {
  const { routes, errors } = flattenJsonMapping({})
  assert.deepEqual(routes, [])
  assert.deepEqual(errors, [])
})

test('flattenJsonMapping 的优先级/权重缺省为 100 / 1', () => {
  const { routes } = flattenJsonMapping({ a: { channel: 'C', model: 'm' } })
  assert.equal(routes[0]!.priority, 100)
  assert.equal(routes[0]!.weight, 1)
})
