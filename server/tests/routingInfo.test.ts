import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  redactRouteInfo,
  routeHeadersOf,
  type RouteHeaderInfo,
  type RouteInfoResponse
} from '../src/services/routingInfo.js'

/**
 * 路由信息的组装与脱敏 —— 纯逻辑测试。
 *
 * 重点钉三件事：
 *   ① header 值必须是「可见 ASCII、无逗号」的简单串（客户端会原样打印）
 *   ② 三档脱敏各回什么、不该回什么
 *   ③ 关闭说明开关时仍给 request-id（排查锚点），但不给拓扑
 */

const base: RouteHeaderInfo = {
  alias: 'balance/deepseek-flash',
  upstreamModel: 'deepseek-v4.1-flash',
  channel: 'OpenDesign',
  account: 'ACP-003',
  attempts: 2,
  switchReason: 'quota'
}

test('routeHeaders：channel 档回别名/渠道/账户/上游模型', () => {
  const h = routeHeadersOf(base, 'channel')
  assert.equal(h['x-portara-route'], 'balance/deepseek-flash/OpenDesign/ACP-003/deepseek-v4.1-flash')
  assert.equal(h['x-portara-route-attempts'], '2')
  assert.equal(h['x-portara-route-switch'], 'quota')
})

test('routeHeaders：alias 档不含渠道与账户', () => {
  const h = routeHeadersOf(base, 'alias')
  assert.equal(h['x-portara-route'], 'balance/deepseek-flash')
  assert.ok(!h['x-portara-route'].includes('OpenDesign'))
  assert.ok(!h['x-portara-route'].includes('ACP-003'))
})

test('routeHeaders：off 档只说明"有没有切换"', () => {
  const switched = routeHeadersOf(base, 'off')
  assert.equal(switched['x-portara-route-switch'], 'yes')
  const clean = routeHeadersOf({ ...base, switchReason: '' }, 'off')
  assert.equal(clean['x-portara-route-switch'], 'no')
})

test('routeHeaders：未切换时不出现 route-switch（channel 档）', () => {
  const h = routeHeadersOf({ ...base, switchReason: '' }, 'channel')
  assert.equal(h['x-portara-route-switch'], undefined)
})

test('routeHeaders：值里的空格/引号/非 ASCII 被清理成 header 安全串', () => {
  const h = routeHeadersOf(
    { ...base, alias: 'a b', channel: '渠道"名', account: 'A,CP' },
    'channel'
  )
  /*
   * 清洗规则：先剥非可打印 ASCII（中文名整段消失）、再去掉 , " ; 与空白折叠的 -。
   *   'a b'    → 'a-b'
   *   '渠道"名' → ''（全被剥掉，空段被过滤）
   *   'A,CP'   → 'ACP'
   */
  assert.equal(h['x-portara-route'], 'a-b/ACP/deepseek-v4.1-flash')
  assert.ok(!/[",;]/.test(h['x-portara-route']))
  assert.ok(!/[^\x20-\x7e]/.test(h['x-portara-route']))
})

const fullInfo: RouteInfoResponse = {
  object: 'route.info',
  sessionKey: 'abcdef12',
  updatedAt: '2026-11-11T12:00:00.000Z',
  route: {
    alias: 'balance/deepseek-flash',
    channel: 'OpenDesign',
    account: 'ACP-003',
    upstreamModel: null
  },
  history: [
    {
      attempt: 1,
      channel: 'CommandCode',
      account: 'ACP-002',
      outcome: 'quota_cooldown',
      statusCode: 429,
      reason: '额度用尽',
      at: '2026-11-11T11:59:58.000Z'
    },
    {
      attempt: 2,
      channel: 'OpenDesign',
      account: 'ACP-003',
      outcome: 'failover_success',
      statusCode: 200,
      reason: '',
      at: '2026-11-11T12:00:00.000Z'
    }
  ]
}

test('redactRouteInfo：channel 档原样返回', () => {
  assert.deepEqual(redactRouteInfo(fullInfo, 'channel'), fullInfo)
})

test('redactRouteInfo：alias 档抹掉渠道与账户，保留结果与原因', () => {
  const r = redactRouteInfo(fullInfo, 'alias')
  assert.equal(r.route.channel, null)
  assert.equal(r.route.account, null)
  assert.equal(r.route.alias, 'balance/deepseek-flash')
  assert.equal(r.history[0]!.outcome, 'quota_cooldown')
  assert.equal(r.history[0]!.reason, '额度用尽')
  assert.equal(r.history[0]!.channel, null)
})

test('redactRouteInfo：off 档连原因也不给', () => {
  const r = redactRouteInfo(fullInfo, 'off')
  assert.equal(r.history[0]!.reason, 'ok')
  assert.equal(r.history[1]!.reason, 'switched')
  assert.equal(r.route.channel, null)
})
