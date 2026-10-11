import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  endpointUrl,
  getUsageAdapter,
  originOf,
  toIso,
  toNum,
  USAGE_ADAPTER_IDS
} from '../src/services/usage.js'

// 以下夹具全部来自**真实接口实测**（2026-10-10），不是照文档编的

const FIX = {
  deepseek: {
    is_available: true,
    balance_infos: [
      {
        currency: 'CNY',
        total_balance: '100.00',
        granted_balance: '0.00',
        topped_up_balance: '100.00'
      }
    ]
  },
  moonshot: {
    code: 0,
    data: { available_balance: 10.00000, voucher_balance: 10.00000, cash_balance: 0 },
    scode: '0x0',
    status: true
  },
  commandcodeCredits: {
    credits: {
      belowThreshold: false,
      creditThreshold: 0,
      monthlyCredits: 0,
      purchasedCredits: 5.000000000,
      freeCredits: 0
    },
    windowLimits: {
      limited: true,
      exceeded: null,
      fiveHour: { used: 0, cap: 14, exceeded: false, resetAt: 0 },
      weekly: { used: 3.0000000000, cap: 35, exceeded: false, resetAt: 1791859267795 }
    },
    sandboxAccess: true,
    sandboxMinutes: { usedMinutes: 0, limitMinutes: 0, overageUsd: 0, resetAt: 1793491200000 }
  },
  commandcodeSubs: {
    success: true,
    data: {
      id: 'sub_1',
      status: 'active',
      planId: 'individual-goat',
      currentPeriodStart: '2026-09-14T11:18:10.000Z',
      currentPeriodEnd: '2026-10-14T11:18:10.000Z',
      cancelAtPeriodEnd: false
    }
  },
  commandcodeSummary: {
    totalCount: 1234,
    totalCost: 12.345000000,
    successRate: 99.99604696209036,
    totalTokensIn: 1000000000,
    totalTokensOut: 20000000,
    totalMonthlyCredits: 70,
    totalPurchasedCredits: 10.000000000,
    periodBasis: 'billing-period'
  },
  minimax: {
    model_remains: [
      {
        start_time: 1774587600000,
        end_time: 1774605600000,
        remains_time: 1715317,
        current_interval_total_count: 1500,
        current_interval_usage_count: 1200,
        model_name: 'MiniMax-M*',
        current_weekly_total_count: 15000,
        current_weekly_usage_count: 14000,
        weekly_end_time: 1774828800000
      }
    ],
    base_resp: { status_code: 0, status_msg: 'success' }
  }
}

// ---------------------------------------------------------------- 工具函数

test('toNum 兼容字符串与数字（各厂商写法不一）', () => {
  assert.equal(toNum('100.00'), 100.00)
  assert.equal(toNum(10.00000), 10.00000)
  assert.equal(toNum('0.00'), 0)
  assert.equal(toNum(''), null)
  assert.equal(toNum('abc'), null)
  assert.equal(toNum(null), null)
  assert.equal(toNum(undefined), null)
})

test('toIso 兼容 epoch 毫秒 / 秒 / ISO 字符串', () => {
  assert.equal(toIso(1791859267795), '2026-10-13T02:41:07.795Z')
  assert.equal(toIso(1774605600), new Date(1774605600000).toISOString())
  assert.equal(toIso('2026-09-14T11:18:10.000Z'), '2026-09-14T11:18:10.000Z')
})

test('toIso 把 0 / 空值视为「没有重置点」', () => {
  // CommandCode 的 fiveHour.resetAt 实测就是 0，不能当成 1970 年
  assert.equal(toIso(0), null)
  assert.equal(toIso(null), null)
  assert.equal(toIso(''), null)
})

test('originOf 取 scheme+host（余额端点不能用完整 base 拼）', () => {
  // Kimi base 是 .../v1，而余额端点是 /v1/users/me/balance → 用 base 会拼成 /v1/v1/...
  assert.equal(originOf('https://api.moonshot.cn/v1'), 'https://api.moonshot.cn')
  assert.equal(originOf('https://api.commandcode.ai/provider/v1'), 'https://api.commandcode.ai')
  assert.equal(originOf('https://api.deepseek.com'), 'https://api.deepseek.com')
})

test('endpointUrl 支持 usage_url 覆盖', () => {
  const a = getUsageAdapter('deepseek')!
  assert.equal(endpointUrl(a, 'https://api.deepseek.com', '/user/balance'), 'https://api.deepseek.com/user/balance')
  assert.equal(
    endpointUrl(a, 'https://api.deepseek.com', '/user/balance', 'https://mirror.example.com/'),
    'https://mirror.example.com/user/balance'
  )
})

// ---------------------------------------------------------------- DeepSeek

test('deepseek：解析字符串金额与多币种数组', () => {
  const out = getUsageAdapter('deepseek')!.parse({ balance: FIX.deepseek })
  assert.equal(out.balances!.length, 1)
  assert.deepEqual(out.balances![0], {
    currency: 'CNY',
    unit: 'currency',
    remaining: 100.00,
    granted: 0,
    toppedUp: 100.00
  })
})

test('deepseek：is_available=false 给出提醒而不是报错', () => {
  const out = getUsageAdapter('deepseek')!.parse({
    balance: { ...FIX.deepseek, is_available: false }
  })
  assert.ok(out.warnings!.some((w) => w.includes('不可用')))
  assert.equal(out.balances!.length, 1)
})

test('deepseek：缺 balance_infos 时抛错（不静默给 0）', () => {
  assert.throws(() => getUsageAdapter('deepseek')!.parse({ balance: {} }), /balance_infos/)
  assert.throws(() => getUsageAdapter('deepseek')!.parse({}), /balance_infos/)
})

// ---------------------------------------------------------------- Moonshot

test('moonshot：解析可用/代金券/现金余额', () => {
  const out = getUsageAdapter('moonshot')!.parse({ balance: FIX.moonshot })
  assert.deepEqual(out.balances![0], {
    currency: 'CNY',
    unit: 'currency',
    remaining: 10.00000,
    granted: 10.00000,
    toppedUp: 0
  })
})

test('moonshot：code != 0 时抛错', () => {
  assert.throws(
    () => getUsageAdapter('moonshot')!.parse({ balance: { code: 401, scode: '0x1' } }),
    /code=401/
  )
})

test('moonshot：现金余额为负时提醒欠费', () => {
  const out = getUsageAdapter('moonshot')!.parse({
    balance: { code: 0, data: { available_balance: 5, voucher_balance: 5, cash_balance: -3 } }
  })
  assert.ok(out.warnings!.some((w) => w.includes('欠费')))
})

test('moonshot：可用余额 <= 0 时提醒会被上游拒绝', () => {
  const out = getUsageAdapter('moonshot')!.parse({
    balance: { code: 0, data: { available_balance: 0, voucher_balance: 0, cash_balance: 0 } }
  })
  assert.ok(out.warnings!.some((w) => w.includes('推理 API 会被上游拒绝')))
})

// ---------------------------------------------------------------- CommandCode

test('commandcode：三个端点合并成余额 + 窗口 + 账期 + 套餐', () => {
  const out = getUsageAdapter('commandcode')!.parse({
    credits: FIX.commandcodeCredits,
    subscriptions: FIX.commandcodeSubs,
    summary: FIX.commandcodeSummary
  })

  // 余额：月度剩余 0 + 充值 4.8 + 免费 0
  assert.equal(out.balances![0].unit, 'credits')
  assert.ok(Math.abs(out.balances![0].remaining - 5.000000000) < 1e-9)

  const byKey = Object.fromEntries(out.windows!.map((w) => [w.key, w]))
  // 5h / 周窗口的 used **确实是已用**
  assert.equal(byKey.fiveHour.used, 0)
  assert.equal(byKey.fiveHour.total, 14)
  assert.ok(Math.abs(byKey.weekly.used - 3.0000000000) < 1e-9)
  assert.equal(byKey.weekly.resetAt, '2026-10-13T02:41:07.795Z')
  // 月度窗口是**推算**的：cap 来自套餐映射，used = cap − 月度剩余
  assert.equal(byKey.monthly.total, 70)
  assert.equal(byKey.monthly.used, 70)
  assert.equal(byKey.monthly.remaining, 0)
  assert.equal(byKey.monthly.inferred, true)
  assert.equal(byKey.monthly.resetAt, '2026-10-14T11:18:10.000Z')

  assert.equal(out.plan!.id, 'individual-goat')
  assert.equal(out.plan!.inferred, true)
  assert.equal(out.period!.requests, 1234)
  assert.ok(Math.abs(out.period!.cost! - 12.345000000) < 1e-9)
})

test('commandcode：limited=true 但未超限时提醒（limited 是静态属性）', () => {
  const out = getUsageAdapter('commandcode')!.parse({
    credits: FIX.commandcodeCredits,
    subscriptions: FIX.commandcodeSubs
  })
  assert.ok(out.warnings!.some((w) => w.includes('limited')))
})

test('commandcode：未知套餐不推算月度窗口，并给提醒', () => {
  const out = getUsageAdapter('commandcode')!.parse({
    credits: FIX.commandcodeCredits,
    subscriptions: { data: { planId: 'individual-unknown' } }
  })
  assert.equal(out.windows!.some((w) => w.key === 'monthly'), false)
  assert.ok(out.warnings!.some((w) => w.includes('individual-unknown')))
})

test('commandcode：缺 credits 端点时抛错', () => {
  assert.throws(() => getUsageAdapter('commandcode')!.parse({}), /不是对象/)
})

test('commandcode：可选端点缺失不影响主流程', () => {
  const out = getUsageAdapter('commandcode')!.parse({ credits: FIX.commandcodeCredits })
  assert.equal(out.balances!.length, 1)
  assert.equal(out.period, undefined)
  assert.equal(out.plan, undefined)
})

// ---------------------------------------------------------------- MiniMax

test('minimax：usage_count 实际是「剩余」，必须换算成已用', () => {
  const out = getUsageAdapter('minimax')!.parse({ remains: FIX.minimax })
  const byKey = Object.fromEntries(out.windows!.map((w) => [w.key, w]))
  // total 1500 / usage_count 1200 → 已用 300、剩余 1200
  assert.equal(byKey['MiniMax-M*:interval'].total, 1500)
  assert.equal(byKey['MiniMax-M*:interval'].remaining, 1200)
  assert.equal(byKey['MiniMax-M*:interval'].used, 300)
  assert.equal(byKey['MiniMax-M*:weekly'].used, 1000)
})

test('minimax：2062（无订阅套餐）给出人话而不是原始错误码', () => {
  assert.throws(
    () =>
      getUsageAdapter('minimax')!.parse({
        remains: {
          model_remains: null,
          base_resp: { status_code: 2062, status_msg: 'no active token plan subscription' }
        }
      }),
    /没有生效中的订阅套餐/
  )
})

test('minimax：model_remains 为空时抛错', () => {
  assert.throws(
    () =>
      getUsageAdapter('minimax')!.parse({
        remains: { model_remains: [], base_resp: { status_code: 0 } }
      }),
    /没有返回额度数据/
  )
})

// ---------------------------------------------------------------- 注册表

test('注册表只含已实测可用的四个适配器', () => {
  assert.deepEqual(USAGE_ADAPTER_IDS, ['deepseek', 'moonshot', 'commandcode', 'minimax'])
})

test('未实现的两个（OpenCode / Kimi Coding）不在注册表里', () => {
  // 厂商侧没有 API，不是实现遗漏；将来有了加一条记录即可
  assert.equal(getUsageAdapter('opencode'), null)
  assert.equal(getUsageAdapter('kimi-coding'), null)
})

test('每个适配器都声明了端点与鉴权方式', () => {
  for (const id of USAGE_ADAPTER_IDS) {
    const a = getUsageAdapter(id)!
    assert.ok(a.endpoints.length > 0, `${id} 没有端点`)
    assert.ok(a.endpoints.some((e) => e.required), `${id} 没有必需端点`)
    assert.ok(['bearer', 'x-api-key', 'none'].includes(a.auth), `${id} 鉴权方式非法`)
    for (const e of a.endpoints) assert.ok(e.path.startsWith('/'), `${id} 端点路径要以 / 开头`)
  }
})
