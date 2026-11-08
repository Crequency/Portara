import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  endpointUrl,
  getUsageAdapter,
  originOf,
  toIso,
  toNum,
  USAGE_ADAPTER_IDS,
  hasExhaustedWindow
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
  assert.equal(
    endpointUrl('https://api.deepseek.com', '/user/balance'),
    'https://api.deepseek.com/user/balance'
  )
  assert.equal(
    endpointUrl('https://api.deepseek.com', '/user/balance', 'https://mirror.example.com/'),
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

  // 余额：月度剩余 0 + 充值 5.0 + 免费 0
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

test('注册表覆盖已实测可用的六个适配器（四个纯 HTTP + 一个 OpenCode + 一个会话型）', () => {
  assert.deepEqual(USAGE_ADAPTER_IDS, [
    'deepseek',
    'moonshot',
    'commandcode',
    'minimax',
    'opencode',
    'opendesign'
  ])
})

test('仍未实现的（Kimi Coding）不在注册表里', () => {
  // 厂商侧没有 API，不是实现遗漏；将来有了加一条记录即可
  assert.equal(getUsageAdapter('kimi-coding'), null)
})

test('每个适配器都声明了端点与鉴权方式', () => {
  for (const id of USAGE_ADAPTER_IDS) {
    const a = getUsageAdapter(id)!
    assert.ok(['bearer', 'x-api-key', 'none', 'session-cookie'].includes(a.auth), `${id} 鉴权方式非法`)
    if (a.kind === 'session-http') {
      // 会话型：完整 URL，不用相对路径
      const eps = a.sessionEndpoints ?? []
      assert.ok(eps.length > 0, `${id} 没有会话端点`)
      assert.ok(eps.some((e) => e.required), `${id} 没有必需端点`)
      for (const e of eps) assert.ok(e.url.startsWith('https://'), `${id} 会话端点要是完整 URL`)
      assert.equal(a.auth, 'session-cookie', `${id} 会话型必须用 session-cookie`)
    } else {
      assert.ok(a.endpoints.length > 0, `${id} 没有端点`)
      assert.ok(a.endpoints.some((e) => e.required), `${id} 没有必需端点`)
      for (const e of a.endpoints) assert.ok(e.path.startsWith('/'), `${id} 端点路径要以 / 开头`)
    }
  }
})

// ---------------------------------------------------------------- 窗口打满判定（D-070）

test('hasExhaustedWindow：任一窗口打满即 true，与 limit_priority 无关', () => {
  const base = {
    accountId: 'a',
    accountName: 'a',
    adapter: 'x',
    ok: true,
    warnings: [],
    balances: [{ currency: 'USD', unit: 'currency' as const, remaining: 100 }],
    windows: []
  }

  // 钱还很多，但 5h 窗口打满 → 仍然算"打满"（这是硬上限）
  const filled = {
    ...base,
    windows: [
      { key: 'fiveHour', used: 0, total: 10, remaining: 10 },
      { key: 'weekly', used: 35, total: 35, remaining: 0, exceeded: true }
    ]
  }
  assert.equal(hasExhaustedWindow(filled), true)

  // 接近打满（>=95%）也算
  const nearFull = {
    ...base,
    windows: [{ key: 'weekly', used: 96, total: 100, remaining: 4 }]
  }
  assert.equal(hasExhaustedWindow(nearFull), true)

  // 都没满 → false
  const healthy = {
    ...base,
    windows: [{ key: 'weekly', used: 10, total: 100, remaining: 90 }]
  }
  assert.equal(hasExhaustedWindow(healthy), false)

  // 没有窗口数据（不支持用量查询）→ false，不能因此把账户判死
  assert.equal(hasExhaustedWindow(base), false)
})

test('hasExhaustedWindow：总上限为 0 的窗口不算打满（无数据 ≠ 打满）', () => {
  const snap = {
    accountId: 'a',
    accountName: 'a',
    adapter: 'x',
    ok: true,
    warnings: [],
    balances: [],
    windows: [{ key: 'monthly', used: 0, total: 0, remaining: 0 }]
  }
  assert.equal(hasExhaustedWindow(snap), false)
})

test('hasExhaustedWindow：推算出来的窗口不算数（避免误杀健康账户）', () => {
  const snap = {
    accountId: 'a',
    accountName: 'a',
    adapter: 'commandcode',
    ok: true,
    warnings: [],
    balances: [{ currency: 'USD', unit: 'currency' as const, remaining: 5 }],
    windows: [
      // 真实窗口：空
      { key: 'fiveHour', used: 0, total: 14, remaining: 14 },
      // 推算窗口：满 —— 但它是"按套餐推算"的，不是上游硬事实
      { key: 'monthly', used: 70, total: 70, remaining: 0, inferred: true }
    ]
  }
  assert.equal(hasExhaustedWindow(snap), false)
})
// ---------------------------------------------------------------- OpenCode（实测形态）

/** 实测响应（2026-11-08）：三个窗口都是百分比制，monthly 已打满 */
const OPENCODE_USAGE = {
  usage: {
    rolling: { status: 'ok', percent: 0, resetsAt: '2026-11-08T19:00:00.000Z' },
    weekly: { status: 'ok', percent: 42.5, resetsAt: '2026-11-14T00:00:00.000Z' },
    monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-12-01T00:00:00.000Z' }
  }
}

test('opencode：三个窗口按百分比映射（used = percent，total = 100）', () => {
  const out = getUsageAdapter('opencode')!.parse({ usage: OPENCODE_USAGE })
  const w = Object.fromEntries(out.windows!.map((x) => [x.key, x]))
  assert.deepEqual(Object.keys(w).sort(), ['monthly', 'rolling', 'weekly'])

  assert.equal(w.rolling!.used, 0)
  assert.equal(w.rolling!.total, 100)
  assert.equal(w.rolling!.remaining, 100)
  assert.equal(w.rolling!.resetAt, '2026-11-08T19:00:00.000Z')

  // 百分比不是 token 数：42.5% 已用 → 剩余 57.5%
  assert.equal(w.weekly!.used, 42.5)
  assert.equal(w.weekly!.total, 100)
  assert.equal(w.weekly!.remaining, 57.5)
  assert.equal(w.weekly!.exceeded, false)
  // 会话窗口没有余额，不该凭空造一个
  assert.equal(out.balances, undefined)
})

test('opencode：status=rate-limited 或 percent>=100 都判 exceeded', () => {
  const out = getUsageAdapter('opencode')!.parse({ usage: OPENCODE_USAGE })
  const w = Object.fromEntries(out.windows!.map((x) => [x.key, x]))
  assert.equal(w.monthly!.exceeded, true)
  assert.equal(w.monthly!.remaining, 0)

  // percent 到 100 但 status 还是 ok：同样算打满（两个信号不总是同步）
  const onlyPercent = getUsageAdapter('opencode')!.parse({
    usage: { usage: { weekly: { status: 'ok', percent: 100, resetsAt: null } } }
  })
  assert.equal(onlyPercent.windows![0]!.exceeded, true)

  // 反过来：status 说限流但 percent 没到 100，也要算
  const onlyStatus = getUsageAdapter('opencode')!.parse({
    usage: { usage: { rolling: { status: 'rate-limited', percent: 80 } } }
  })
  assert.equal(onlyStatus.windows![0]!.exceeded, true)
  assert.equal(onlyStatus.windows![0]!.remaining, 20)
})

test('opencode：只有一个窗口有数据时也正常（缺字段跳过，不报错）', () => {
  const out = getUsageAdapter('opencode')!.parse({
    usage: { usage: { weekly: { status: 'ok', percent: 10, resetsAt: '2026-11-14T00:00:00.000Z' } } }
  })
  assert.equal(out.windows!.length, 1)
  assert.equal(out.windows![0]!.key, 'weekly')
})

test('opencode：一个窗口都解析不出来时抛错（绝不静默给 0）', () => {
  const adapter = getUsageAdapter('opencode')!
  assert.throws(() => adapter.parse({}), /不是对象/)
  assert.throws(() => adapter.parse({ usage: {} }), /没有 usage 字段/)
  assert.throws(() => adapter.parse({ usage: { usage: {} } }), /用量窗口/)
  // 字段在但没有 percent：也算「没有可解析的窗口」
  assert.throws(
    () => adapter.parse({ usage: { usage: { rolling: { status: 'ok' } } } }),
    /用量窗口/
  )
})

test('opencode：baseMode=base —— 用量端点在完整 base 之下', () => {
  const a = getUsageAdapter('opencode')!
  assert.equal(a.baseMode, 'base')
  assert.equal(a.auth, 'bearer')
  assert.equal(
    endpointUrl('https://opencode.ai/zen/go/v1', '/usage', '', a.baseMode),
    'https://opencode.ai/zen/go/v1/usage'
  )
  // 既有适配器仍是 origin 语义（回归）
  assert.equal(
    endpointUrl('https://api.moonshot.cn/v1', '/v1/users/me/balance'),
    'https://api.moonshot.cn/v1/users/me/balance'
  )
})

// ---------------------------------------------------------------- OpenDesign（网页会话）

const OPENDESIGN_ME = {
  wallet: { balanceUsd: 12.34 },
  walletBreakdown: [
    { kind: 'grant', expiresAt: '2026-12-01T00:00:00.000Z', amountUsd: 10 },
    { kind: 'topup', expiresAt: '2027-01-01T00:00:00.000Z', amountUsd: 2.34 }
  ],
  designPlanWindows: [
    {
      kind: 'weekly',
      windowStart: '2026-11-03T00:00:00.000Z',
      resetsAt: '2026-11-10T00:00:00.000Z',
      remainingCredits: 40,
      limitCredits: 100
    },
    {
      kind: 'daily',
      windowStart: '2026-11-08T00:00:00.000Z',
      resetsAt: '2026-11-09T00:00:00.000Z',
      remainingCredits: 0,
      limitCredits: 10
    }
  ],
  plan: { id: 'design-pro', name: 'Design Pro', status: 'active' }
}

test('opendesign：wallet.balanceUsd → USD 余额，designPlanWindows → 窗口', () => {
  const out = getUsageAdapter('opendesign')!.parse({ me: OPENDESIGN_ME })
  assert.deepEqual(out.balances, [{ currency: 'USD', unit: 'currency', remaining: 12.34 }])

  const w = Object.fromEntries(out.windows!.map((x) => [x.key, x]))
  assert.deepEqual(Object.keys(w).sort(), ['daily', 'weekly'])
  assert.equal(w.weekly!.used, 60)
  assert.equal(w.weekly!.total, 100)
  assert.equal(w.weekly!.remaining, 40)
  assert.equal(w.weekly!.resetAt, '2026-11-10T00:00:00.000Z')
  assert.equal(w.weekly!.exceeded, false)
  // 真实窗口不是推算的
  assert.equal(w.weekly!.inferred, undefined)
})

test('opendesign：remainingCredits=0 → exceeded', () => {
  const out = getUsageAdapter('opendesign')!.parse({ me: OPENDESIGN_ME })
  const w = Object.fromEntries(out.windows!.map((x) => [x.key, x]))
  assert.equal(w.daily!.exceeded, true)
  assert.equal(w.daily!.used, 10)
  assert.equal(w.daily!.remaining, 0)
})

test('opendesign：designPlanWindows 为空时才用 walletBreakdown 推算（标 inferred）', () => {
  const out = getUsageAdapter('opendesign')!.parse({
    me: { wallet: { balanceUsd: 5 }, walletBreakdown: OPENDESIGN_ME.walletBreakdown }
  })
  assert.equal(out.windows!.length, 2)
  assert.ok(out.windows!.every((w) => w.inferred === true))
  const w = Object.fromEntries(out.windows!.map((x) => [x.key, x]))
  assert.equal(w['wallet:grant']!.resetAt, '2026-12-01T00:00:00.000Z')
  assert.equal(w['wallet:grant']!.remaining, 10)
  assert.ok(out.warnings!.some((x) => x.includes('推算')))

  // 真实窗口存在时**不**推算：有 designPlanWindows 就只认它
  const withWindows = getUsageAdapter('opendesign')!.parse({ me: OPENDESIGN_ME })
  assert.ok(withWindows.windows!.every((w) => w.inferred !== true))
})

test('opendesign：plan 既接受对象也接受字符串', () => {
  const asObject = getUsageAdapter('opendesign')!.parse({ me: OPENDESIGN_ME })
  assert.deepEqual(asObject.plan, { id: 'design-pro', name: 'Design Pro', status: 'active' })

  const asString = getUsageAdapter('opendesign')!.parse({
    me: { plan: 'Design Pro', wallet: { balanceUsd: 1 } }
  })
  assert.equal(asString.plan!.name, 'Design Pro')
})

test('opendesign：字段缺失容错，但全部取不到时抛错', () => {
  const adapter = getUsageAdapter('opendesign')!
  // 只有余额：可用，只是没有窗口
  const onlyWallet = adapter.parse({ me: { wallet: { balanceUsd: 1 } } })
  assert.equal(onlyWallet.windows!.length, 0)
  assert.equal(onlyWallet.balances!.length, 1)

  // 只有套餐：也算拿到了东西
  assert.equal(adapter.parse({ me: { plan: 'Free' } }).plan!.name, 'Free')

  // 一无所有 → 抛错（绝不静默给 0）
  assert.throws(() => adapter.parse({}), /不是对象/)
  assert.throws(() => adapter.parse({ me: {} }), /既没有/)
  assert.throws(() => adapter.parse({ me: { wallet: {} } }), /既没有/)
})

test('opendesign：响应套在 data / user 里也能解开', () => {
  const out = getUsageAdapter('opendesign')!.parse({
    me: { data: { wallet: { balanceUsd: 7 } } }
  })
  assert.equal(out.balances![0]!.remaining, 7)
})

test('opendesign：声明为会话型（完整 URL + session-cookie）', () => {
  const a = getUsageAdapter('opendesign')!
  assert.equal(a.kind, 'session-http')
  assert.equal(a.auth, 'session-cookie')
  assert.equal(a.sessionEndpoints?.length, 2)
  assert.deepEqual(a.sessionEndpoints?.[0], {
    key: 'me',
    url: 'https://amr-api.open-design.ai/api/v1/me',
    required: true
  })
  assert.equal(a.sessionEndpoints?.[1].key, 'workspaces')
  // 限额窗口要第二轮（拿到工作区 id 之后）才能抓
  assert.equal(typeof a.followUps, 'function')
  // 会话型不该同时声明相对路径端点（否则两条链路会被混淆）
  assert.equal(a.endpoints.length, 0)
})
/*
 * OpenDesign 真实响应形状（2026-11-09 从用户控制台实测）。
 *
 * 关键事实：
 *   - /v1/me 返回 { id, email, name, plan: 'free', balanceUsd: '-0.0002' }，
 *     **没有** wallet / designPlanWindows；
 *   - 限额窗口在 /v1/workspaces/{id}/billing/coding-plan-usage 的 windows 里；
 *   - Go 套餐只有 5h 与 7d 两个窗口，**没有月度窗口**，不要自己补。
 */
test('OpenDesign：真实 /v1/me + coding-plan-usage 形状', () => {
  const adapter = getUsageAdapter('opendesign')
  assert.ok(adapter)
  const parsed = adapter.parse({
    me: {
      me: { id: 'g5vah4', email: '001@example.com', name: 'ACP 001', plan: 'free', balanceUsd: '-0.0002' },
      codingPlanUsage: {
        windows: [
          { kind: 'fiveHour', limitCredits: 100000, remainingCredits: 40000, resetsAt: '2026-11-09T08:00:00Z' },
          { kind: 'sevenDay', limitCredits: 500000, remainingCredits: 0, resetsAt: '2026-11-12T00:00:00Z' }
        ]
      },
      walletBalance: { balanceUsd: '-0.0002' }
    }
  })
  assert.equal(parsed.balances?.length, 1)
  assert.equal(parsed.balances?.[0].remaining, -0.0002)
  assert.equal(parsed.windows?.length, 2, 'Go 套餐应只有 5h / 7d 两个窗口')
  assert.deepEqual(parsed.windows?.map((w) => w.key), ['fiveHour', 'sevenDay'])
  assert.equal(parsed.windows?.[0].used, 60000)
  assert.equal(parsed.windows?.[1].exceeded, true)
  assert.equal(parsed.plan?.name, 'free')
  // 负余额要给出提示，不能静默
  assert.ok((parsed.warnings ?? []).some((w) => w.includes('余额为负')))
})

test('OpenDesign：实时抓取形状（响应平铺 key，不在 me 包裹里）', () => {
  const adapter = getUsageAdapter('opendesign')
  const parsed = adapter!.parse({
    me: { plan: 'go', balanceUsd: '3.5' },
    workspaces: { id: 'ws_1' },
    codingPlanUsage: {
      windows: [{ kind: 'fiveHour', limitCredits: 200000, remainingCredits: 200000 }]
    }
  })
  assert.equal(parsed.balances?.[0].remaining, 3.5)
  assert.equal(parsed.windows?.length, 1)
  assert.equal(parsed.windows?.[0].exceeded, false)
})

test('OpenDesign：没有限额窗口时给出明确 warning，而不是静默为空', () => {
  const adapter = getUsageAdapter('opendesign')
  const parsed = adapter!.parse({ me: { me: { plan: 'free', balanceUsd: '1' } } })
  assert.equal(parsed.windows?.length, 0)
  assert.ok((parsed.warnings ?? []).some((w) => w.includes('没有返回限额窗口')))
})
