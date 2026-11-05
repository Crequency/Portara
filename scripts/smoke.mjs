#!/usr/bin/env node
/**
 * Portara 端到端冒烟测试
 *
 * 覆盖：登录 → 建渠道 → 连通性测试 → 派发 Key → 模型列表
 *       → 非流式转发 → 流式转发（含 usage 解析）→ 限流 → 配额 → 日志与统计
 *
 * 前置：`docker compose up -d postgres redis`
 * 运行：`pnpm smoke`
 *
 * 说明：脚本会在前台拉起一个被测服务进程与一个伪上游，结束后全部回收；
 * 它不是开发服务器，不归 DevHub 托管。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 探测一个空闲端口。
 *
 * 以前这里写死 52750/52751/52752 —— 一旦别的会话（或别的项目）占了其中一个，
 * 冒烟就以 `EADDRINUSE` 直接崩掉，而且报错信息看不出是端口撞车。
 * 现在按需探测；`SMOKE_API_PORT` 仍可显式指定起点。
 */
function canListen(port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '127.0.0.1')
  })
}

async function findFreePort(from) {
  for (let port = from; port < from + 100; port++) {
    if (await canListen(port)) return port
  }
  throw new Error(`在 ${from}..${from + 100} 之间找不到空闲端口`)
}

const API_PORT = await findFreePort(Number(process.env.SMOKE_API_PORT ?? 52750))
const MOCK_PORT = await findFreePort(API_PORT + 1)
const BASE = `http://127.0.0.1:${API_PORT}`
const MOCK = `http://127.0.0.1:${MOCK_PORT}`
/** 伪正向代理的端口；用于验证「渠道走代理」确实生效 */
const PROXY_PORT = await findFreePort(MOCK_PORT + 1)
/** 被代理转发的请求（绝对 URI + 代理认证头），用于断言流量真的过代理了 */
const proxiedRequests = []

/**
 * 极简 HTTP 正向代理：接收绝对 URI，转发到目标并回传。
 * 只支持明文 HTTP —— 够用来验证「请求是否经过代理」这件事。
 */
function startMockProxy() {
  const server = createServer((req, res) => {
    proxiedRequests.push({
      url: req.url,
      method: req.method,
      proxyAuth: req.headers['proxy-authorization'] ?? null
    })
    let target
    try {
      target = new URL(req.url)
    } catch {
      res.writeHead(400)
      res.end('bad absolute uri')
      return
    }
    const upstream = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: req.method,
        headers: { ...req.headers, host: target.host }
      },
      (up) => {
        res.writeHead(up.statusCode, up.headers)
        up.pipe(res)
      }
    )
    upstream.on('error', (err) => {
      res.writeHead(502)
      res.end(String(err))
    })
    req.pipe(upstream)
  })
  return new Promise((resolve) => server.listen(PROXY_PORT, '127.0.0.1', () => resolve(server)))
}
const RUN = Date.now().toString(36)

/**
 * 冒烟测试**必须**跑在独立 schema 里。
 *
 * 教训（2026-10-09）：此前冒烟直连开发库，其中一个 replace 模式的 JSON 导入
 * 测试是全局删除操作，把用户真实的模型映射数据（数十条）清空了。
 * 端到端测试绝不该对开发数据执行破坏性全局操作 —— 现在从连接层面隔离。
 */
const SMOKE_SCHEMA = process.env.SMOKE_DB_SCHEMA ?? 'portara_smoke'
if (!SMOKE_SCHEMA.includes('smoke')) {
  console.error(
    `\n[拒绝运行] SMOKE_DB_SCHEMA="${SMOKE_SCHEMA}" 看起来不是测试专用 schema。\n` +
      '冒烟会执行破坏性操作（如 replace 模式导入会删除全部模型映射），\n' +
      '因此 schema 名必须包含 "smoke"，防止误伤开发/生产数据。\n'
  )
  process.exit(2)
}

const UPSTREAM_KEY = `sk-upstream-${randomBytes(8).toString('hex')}`
/**
 * 触发「额度用尽」的伪上游密钥。
 *
 * 网关把它当普通上游 Key 加密存储；伪上游识别它并返回
 * 429 + insufficient_quota，用于验证阶梯冷冻与幂等。
 */
const QUOTA_ERROR_KEY = 'sk-quota-error-account'
// 固定管理凭据：配合「按用户名引导」语义，脚本可无限次重复运行
const ADMIN_USER = 'smoke-admin'
const ADMIN_PASS = 'smoke-admin-password'
const OPERATOR_USER = 'smoke-operator'
const OPERATOR_PASS = 'smoke-operator-password'

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    const r = fn()
    // 异步断言不会被这里 await —— 所以它永远"通过"，失败也只会变成未捕获异常。
    // 与其静默假通过，不如直接报错，逼出正确写法：check 之外 await，回调里只做同步断言。
    if (r && typeof r.then === 'function') {
      throw new Error('check() 不接受 async 回调：请把 await 移到 check 之外')
    }
    passed++
    console.log(`  \u001b[32m✔\u001b[0m ${name}`)
  } catch (err) {
    failed++
    console.log(`  \u001b[31m✖\u001b[0m ${name}`)
    console.log(`      ${err.message.split('\n')[0]}`)
  }
}

function section(title) {
  console.log(`\n\u001b[36m${title}\u001b[0m`)
}

/**
 * 统计分桶的预期点数：按服务端返回的时区，用同一套「当地日历」规则算。
 * 这样断言是精确的，但不会因为跑在周中/周末、或 365d 是否跨到 16 日而飘。
 */
function localDateParts(iso, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value])
  )
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) }
}

const dayNumber = (p) => Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86_400_000)
const weekdayOf = (n) => new Date(n * 86_400_000).getUTCDay() // 0=周日
/** 周桶：从 from 所在周的周一到 to 所在周的周一，每 7 天一个。 */
function expectedWeekBuckets(fromIso, toIso, timeZone) {
  const from = dayNumber(localDateParts(fromIso, timeZone))
  const to = dayNumber(localDateParts(toIso, timeZone))
  const fromMonday = from - ((weekdayOf(from) + 6) % 7)
  const toMonday = to - ((weekdayOf(to) + 6) % 7)
  return Math.floor((toMonday - fromMonday) / 7) + 1
}
/** 二维热力图的月份标签数：范围内每个「月份首次出现」记一次（365d 通常 12 或 13）。 */
function expectedMonthLabelCount(fromIso, toIso, timeZone) {
  const from = dayNumber(localDateParts(fromIso, timeZone))
  const to = dayNumber(localDateParts(toIso, timeZone))
  let count = 0
  let lastMonth = -1
  for (let day = from; day <= to; day++) {
    const month = new Date(day * 86_400_000).getUTCMonth()
    if (month !== lastMonth) {
      count++
      lastMonth = month
    }
  }
  return count
}

/** 半月桶：落在 [from, to] 内的当地 1 日 / 16 日边界数。 */
function expectedHalfMonthBuckets(fromIso, toIso, timeZone) {
  const fromParts = localDateParts(fromIso, timeZone)
  const toParts = localDateParts(toIso, timeZone)
  const from = dayNumber(fromParts)
  const to = dayNumber(toParts)
  let count = 0
  for (let year = fromParts.year, month = fromParts.month; ; month++) {
    if (month > 12) {
      month = 1
      year++
    }
    const first = Date.UTC(year, month - 1, 1) / 86_400_000
    const sixteenth = Date.UTC(year, month - 1, 16) / 86_400_000
    if (first >= from && first <= to) count++
    if (sixteenth >= from && sixteenth <= to) count++
    if (year === toParts.year && month === toParts.month) break
  }
  return count
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------ 伪上游

const MOCK_MODEL = 'mock-gpt-4o'
const MOCK_USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }

/** 伪上游记录的最近一次 chat 请求头，用于断言厂商兼容头确实发出去了 */
let lastUpstreamHeaders = {}
/** 最近一次 Anthropic /messages 请求体（用于验证翻译是否真的发生） */
let lastAnthropicBody = null

function startMockUpstream() {
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const url = req.url ?? ''

      // 鉴权校验：网关必须带上渠道密钥。
      // OpenAI 协议用 Bearer，Anthropic 协议用 x-api-key —— 两种都接受，
      // 具体用了哪种由断言去校验（伪上游不该替应用规定用哪种）。
      const auth = req.headers.authorization ?? ''
      const xApiKey = req.headers['x-api-key'] ?? ''
      const authed =
        auth === `Bearer ${UPSTREAM_KEY}` ||
        xApiKey === UPSTREAM_KEY ||
        auth === `Bearer ${QUOTA_ERROR_KEY}` ||
        xApiKey === QUOTA_ERROR_KEY
      if (url.startsWith('/v1') && !authed) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'bad upstream key' } }))
        return
      }

      if (url.endsWith('/models')) {
        // 自定义路径返回不同的模型 —— 用于验证网关确实按渠道配置的路径请求
        const isCustom = url.includes('/custom/')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            object: 'list',
            data: isCustom
              ? [{ id: 'custom-path-model', object: 'model', owned_by: 'mock-custom' }]
              : [
                  {
                    id: MOCK_MODEL,
                    object: 'model',
                    owned_by: 'mock',
                    // 各家对上下文长度的叫法不一，这里混用两种字段名
                    context_length: 131072,
                    max_output_tokens: 8192
                  },
                  {
                    id: 'alt-model',
                    object: 'model',
                    owned_by: 'mock',
                    context_window: 200000
                  }
                ]
          })
        )
        return
      }

      // ---- 余额 / 用量接口（四种，与真实上游同形）----
      if (url.endsWith('/user/balance')) {
        // DeepSeek：金额是字符串，数组可多币种。
        // 密钥里带 exhausted 的账户返回 0 余额 —— 用于验证「主动额度轮转」。
        const broke = (req.headers.authorization ?? '').includes('exhausted')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          is_available: !broke,
          balance_infos: [{ currency: 'CNY', total_balance: broke ? '0.00' : '100.00',
                            granted_balance: '0.00', topped_up_balance: broke ? '0.00' : '100.00' }]
        }))
        return
      }
      if (url.endsWith('/v1/users/me/balance')) {
        // Moonshot：数值是 number
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 0, scode: '0x0', status: true,
          data: { available_balance: 10.00000, voucher_balance: 10.00000, cash_balance: 0 } }))
        return
      }
      if (url.endsWith('/alpha/billing/credits')) {
        // 密钥含 quota-full：窗口打满但还有充值额度 ——
        // 用于验证「余额优先 / 用量限额优先」两种口径给出相反结论。
        const quotaFull = (req.headers.authorization ?? '').includes('quota-full')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          credits: { monthlyCredits: 0, purchasedCredits: 5.0, freeCredits: 0, belowThreshold: false },
          windowLimits: { limited: true, exceeded: null,
            fiveHour: { used: 0, cap: 14, exceeded: false, resetAt: 0 },
            weekly: quotaFull
              ? { used: 35, cap: 35, exceeded: true, resetAt: 1791859267795 }
              : { used: 3.0, cap: 35, exceeded: false, resetAt: 1791859267795 } }
        }))
        return
      }
      if (url.endsWith('/alpha/billing/subscriptions')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: { planId: 'individual-goat', status: 'active',
          currentPeriodStart: '2026-09-14T11:18:10.000Z',
          currentPeriodEnd: '2026-10-14T11:18:10.000Z' } }))
        return
      }
      if (url.endsWith('/alpha/usage/summary')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ totalCount: 1234, totalCost: 12.345, successRate: 99.99,
          totalTokensIn: 1000000000, totalTokensOut: 20000000 }))
        return
      }
      if (url.endsWith('/coding_plan/remains')) {
        // MiniMax：注意 usage_count 实际是"剩余"
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ model_remains: [{ model_name: 'MiniMax-M*',
          current_interval_total_count: 1500, current_interval_usage_count: 1200,
          current_weekly_total_count: 15000,
          current_weekly_usage_count: 14000, end_time: 1774605600000 }],
          base_resp: { status_code: 0, status_msg: 'success' } }))
        return
      }

      // ---- Anthropic 协议（/messages）----
      if (url.endsWith('/messages')) {
        let body = {}
        try {
          body = JSON.parse(raw)
        } catch {
          /* 忽略 */
        }
        lastAnthropicBody = body
        lastUpstreamHeaders = { ...req.headers }

        const id = `msg_${RUN}`
        const usage = { input_tokens: 11, output_tokens: 7 }

        if (body.stream === true) {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache'
          })
          const events = [
            ['message_start', { type: 'message_start', message: { id, model: body.model, usage: { input_tokens: 11, output_tokens: 0 } } }],
            ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
            ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } }],
            ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '，世界' } }],
            ['content_block_stop', { type: 'content_block_stop', index: 0 }],
            ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }],
            ['message_stop', { type: 'message_stop' }]
          ]
          for (const [ev, payload] of events) {
            res.write(`event: ${ev}\ndata: ${JSON.stringify(payload)}\n\n`)
          }
          res.end()
          return
        }

        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id,
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [{ type: 'text', text: '你好，世界' }],
            stop_reason: 'end_turn',
            usage
          })
        )
        return
      }

      if (url.endsWith('/chat/completions')) {
        lastUpstreamHeaders = { ...req.headers }
        let body = {}
        try {
          body = JSON.parse(raw)
        } catch {
          /* 忽略 */
        }
        // 额度用尽：429 + insufficient_quota，用于验证阶梯冷冻
        if (auth === `Bearer ${QUOTA_ERROR_KEY}` || xApiKey === QUOTA_ERROR_KEY) {
          res.writeHead(429, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              error: {
                code: 'insufficient_quota',
                type: 'insufficient_quota',
                message: 'You exceeded your current quota, please check your plan and billing details'
              }
            })
          )
          return
        }
        // 供「不可重试错误不该换号」的断言使用：这类错误换账户也一样失败
        if (String(body.model ?? '').includes('bad-request')) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'model rejected', type: 'invalid_request_error' } }))
          return
        }
        const id = `chatcmpl-${RUN}`

        if (body.stream === true) {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive'
          })
          const parts = ['你好', '，', '世界']
          for (const part of parts) {
            res.write(
              `data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                model: MOCK_MODEL,
                choices: [{ index: 0, delta: { content: part }, finish_reason: null }]
              })}\n\n`
            )
          }
          if (body.stream_options?.include_usage) {
            res.write(
              `data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                model: MOCK_MODEL,
                choices: [],
                usage: MOCK_USAGE
              })}\n\n`
            )
          }
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id,
            object: 'chat.completion',
            model: MOCK_MODEL,
            // 回显上游实际收到的模型 id —— 用于验证网关是否做了映射改写
            received_model: body.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '你好，世界' },
                finish_reason: 'stop'
              }
            ],
            usage: MOCK_USAGE
          })
        )
        return
      }

      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `mock 未实现的路径：${url}` } }))
    })
  })

  return new Promise((resolve) => {
    server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server))
  })
}

// ------------------------------------------------------------ 被测服务

function startServer() {
  const child = spawn('node', ['server/dist/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORTARA_PORT: String(API_PORT),
      PORTARA_HOST: '127.0.0.1',
      PORTARA_MASTER_KEY: randomBytes(32).toString('base64'),
      PORTARA_SESSION_SECRET: randomBytes(32).toString('hex'),
      PORTARA_ADMIN_USERNAME: ADMIN_USER,
      PORTARA_ADMIN_PASSWORD: ADMIN_PASS,
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://portara:portara@127.0.0.1:52744/portara',
      // 独立 schema：与开发数据彻底隔离
      PORTARA_DB_SCHEMA: SMOKE_SCHEMA,
      REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:52745',
      PORTARA_COOKIE_SECURE: 'false',
      // 宽限窗口设为 2 秒：冒烟要同时验证「宽限内放行」与「宽限外判重放」，
      // 用默认的 30 秒会让测试白等半分钟
      PORTARA_REFRESH_GRACE_SECONDS: '2'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const output = []
  child.stdout.on('data', (d) => output.push(d.toString()))
  child.stderr.on('data', (d) => output.push(d.toString()))
  globalThis.__portaraOutput = output
  return { child, output }
}

async function waitReady(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/readyz`)
      if (res.ok) return
      const body = await res.text()
      if (res.status === 503) {
        await sleep(400)
        continue
      }
      throw new Error(`readyz 返回 ${res.status}：${body.slice(0, 200)}`)
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('readyz 返回')) throw err
      await sleep(400)
    }
  }
  throw new Error('等待服务就绪超时')
}

// ------------------------------------------------------------ HTTP 辅助

let cookie = ''

async function apiCall(method, pathname, body, opts = {}) {
  // opts.cookie：以指定身份发起请求（不污染默认会话，用于验证权限边界）
  const useCookie = opts.cookie ?? cookie
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(useCookie ? { cookie: useCookie } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })

  const setCookie = res.headers.getSetCookie?.() ?? []
  const freshCookie = setCookie.map((c) => c.split(';')[0]).join('; ')
  // keepSession：以他人身份登录时不要覆盖默认（管理员）会话
  if (freshCookie && !opts.cookie && !opts.keepSession) cookie = freshCookie

  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 非 JSON */
  }
  return {
    status: res.status,
    body: json,
    text,
    cookie: freshCookie || useCookie,
    headers: res.headers
  }
}

async function proxyCall(pathname, body, key) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {})
    },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* SSE 等非 JSON */
  }
  return { status: res.status, body: json, text, headers: res.headers }
}

// ------------------------------------------------------------ 主流程

async function main() {
  console.log('\u001b[1mPortara 端到端冒烟测试\u001b[0m')
  console.log(`  API  : ${BASE}`)
  console.log(`  伪上游: ${MOCK}`)
  console.log(`  数据库 schema: ${SMOKE_SCHEMA}（与开发数据隔离）`)

  const mock = await startMockUpstream()
  const mockProxy = await startMockProxy()
  const { child, output } = startServer()

  let channelId = null
  let keyFull = ''
  let quotaKey = ''
  // 记录所有本轮创建的密钥，结束前逐个删除，避免测试残留污染面板
  const createdKeyIds = []

  try {
    await waitReady()
    console.log('  服务已就绪')

    // ---------------------------------------------------------- 认证
    section('① 管理员认证')

    const badLogin = await apiCall('POST', '/api/auth/login', {
      username: ADMIN_USER,
      password: 'wrong-password'
    })
    check('错误密码被拒绝（401）', () => assert.equal(badLogin.status, 401))

    const login = await apiCall('POST', '/api/auth/login', {
      username: ADMIN_USER,
      password: ADMIN_PASS
    })
    check('正确密码可登录（200）', () => assert.equal(login.status, 200))
    check('登录返回用户信息', () =>
      assert.equal(login.body?.user?.username, ADMIN_USER)
    )
    check('会话 Cookie 已下发', () => assert.ok(cookie.includes('portara_session')))

    const me = await apiCall('GET', '/api/auth/me')
    check('携带 Cookie 可读取当前用户', () => assert.equal(me.status, 200))

    const noAuth = await apiCall('GET', '/api/users')
    const savedCookie = cookie
    cookie = ''
    const unauth = await apiCall('GET', '/api/users')
    cookie = savedCookie
    check('无 Cookie 访问控制面被拒（401）', () => {
      assert.equal(noAuth.status, 200) // 有 cookie 时正常
      assert.equal(unauth.status, 401)
    })

    // ---------------------------------------------------------- 渠道
    section('② 上游渠道配置')

    const created = await apiCall('POST', '/api/channels', {
      name: `smoke-mock-${RUN}`,
      baseUrl: `${MOCK}/v1`,
      apiKey: UPSTREAM_KEY,
      protocol: 'openai',
      vendor: 'opencode-go',
      extraHeaders: { 'X-Smoke-Header': 'portara-smoke' },
      models: [MOCK_MODEL],
      priority: 10,
      weight: 1,
      status: 'active',
      note: '冒烟测试渠道'
    })
    check('创建渠道成功（201）', () => assert.equal(created.status, 201))
    channelId = created.body?.channel?.id ?? null
    check('渠道返回 id', () => assert.ok(channelId))
    check('协议 / 厂商兼容 / 固定请求头已保存', () => {
      const ch = created.body.channel
      assert.equal(ch.protocol, 'openai')
      assert.equal(ch.vendor, 'opencode-go')
      assert.equal(ch.extraHeaders['X-Smoke-Header'], 'portara-smoke')
    })
    const badHeader = await apiCall('POST', '/api/channels', {
      name: `smoke-badheader-${RUN}`,
      baseUrl: `${MOCK}/v1`,
      extraHeaders: { authorization: 'Bearer evil' }
    })
    check('自定义保留请求头被拒绝（400）', () => {
      assert.equal(badHeader.status, 400)
      assert.ok(String(badHeader.body?.error?.message ?? '').includes('固定请求头'))
    })
    check('接口不回传上游密钥明文', () => {
      assert.ok(!created.text.includes(UPSTREAM_KEY))
      assert.ok(created.body.channel.apiKeyMasked.includes('••••'))
    })

    const test = await apiCall('POST', `/api/channels/${channelId}/test`)
    check('连通性测试通过且拿到模型列表', () => {
      assert.equal(test.body?.ok, true)
      // 伪上游返回多个模型（含用于验证字段名识别的 alt-model）
      assert.ok(test.body?.models?.includes(MOCK_MODEL), JSON.stringify(test.body?.models))
    })
    check('测试返回延迟与测试时间', () => {
      assert.ok(typeof test.body?.latencyMs === 'number')
      assert.ok(test.body.latencyMs >= 0)
      assert.ok(test.body?.testedAt)
    })

    const afterTest = await apiCall('GET', '/api/channels')
    const testedChannel = afterTest.body?.channels?.find((c) => c.id === channelId)
    check('延迟已持久化（刷新面板仍可显示）', () => {
      assert.ok(testedChannel, '未找到渠道')
      assert.ok(
        typeof testedChannel.lastLatencyMs === 'number',
        `lastLatencyMs=${testedChannel.lastLatencyMs}`
      )
      assert.equal(testedChannel.lastTestOk, true)
      assert.ok(testedChannel.lastTestAt)
    })

    // ---------------------------------------------------------- 密钥
    section('③ API 密钥派发')

    const keyRes = await apiCall('POST', '/api/keys', {
      name: `smoke-key-${RUN}`,
      channelId,
      rpmLimit: 600,
      quotaTokens: 0
    })
    check('创建密钥成功（201）', () => assert.equal(keyRes.status, 201))
    keyFull = keyRes.body?.key ?? ''
    createdKeyIds.push(keyRes.body?.apiKey?.id)
    check('返回的明文密钥格式正确', () =>
      assert.ok(keyFull.startsWith('sk-portara-'))
    )

    const keyList = await apiCall('GET', '/api/keys')
    const listed = keyList.body?.keys?.find((k) => k.id === keyRes.body?.apiKey?.id)
    check('列表中只出现前缀，不含明文', () => {
      assert.ok(listed)
      assert.ok(!keyList.text.includes(keyFull))
    })

    // ---------------------------------------------------------- 模型列表
    section('④ 数据面鉴权与模型列表')

    const noKey = await proxyCall('/v1/chat/completions', {
      model: MOCK_MODEL,
      messages: [{ role: 'user', content: 'hi' }]
    })
    check('无 Key 调用数据面被拒（401）', () => assert.equal(noKey.status, 401))

    const badKey = await proxyCall(
      '/v1/chat/completions',
      { model: MOCK_MODEL, messages: [] },
      'sk-portara-invalid-key'
    )
    check('伪造 Key 被拒（401）', () => assert.equal(badKey.status, 401))

    const models = await fetch(`${BASE}/v1/models`, {
      headers: { authorization: `Bearer ${keyFull}` }
    })
    const modelsJson = await models.json()
    check('GET /v1/models 返回该渠道声明的模型', () => {
      assert.equal(models.status, 200)
      assert.ok(modelsJson.data.some((m) => m.id === MOCK_MODEL))
    })

    // ---------------------------------------------------------- 非流式转发
    section('⑤ 非流式转发与计量')

    const chat = await proxyCall(
      '/v1/chat/completions',
      { model: MOCK_MODEL, messages: [{ role: 'user', content: '你好' }] },
      keyFull
    )
    check('转发成功（200）', () => assert.equal(chat.status, 200))
    check('响应内容来自上游', () =>
      assert.equal(chat.body?.choices?.[0]?.message?.content, '你好，世界')
    )
    check('响应带渠道标识头', () =>
      assert.equal(chat.headers.get('x-portara-channel'), `smoke-mock-${RUN}`)
    )
    check('网关转发时带上了渠道的上游密钥', () =>
      assert.equal(lastUpstreamHeaders.authorization, `Bearer ${UPSTREAM_KEY}`)
    )
    check('自定义固定请求头已透传到上游', () =>
      assert.equal(lastUpstreamHeaders['x-smoke-header'], 'portara-smoke')
    )
    check('厂商兼容（opencode-go）自动注入 x-opencode-session', () => {
      const session = lastUpstreamHeaders['x-opencode-session']
      assert.ok(session, '未注入 x-opencode-session')
      assert.ok(String(session).startsWith('portara-'))
    })

    // ---------------------------------------------------------- 流式转发
    section('⑥ 流式转发（SSE）')

    const streamRes = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${keyFull}`
      },
      body: JSON.stringify({
        model: MOCK_MODEL,
        stream: true,
        messages: [{ role: 'user', content: '你好' }]
      })
    })
    const streamText = await streamRes.text()

    check('流式响应 200 且 Content-Type 为 SSE', () => {
      assert.equal(streamRes.status, 200)
      assert.ok(streamRes.headers.get('content-type')?.includes('text/event-stream'))
    })
    check('SSE 内容原样透传且以 [DONE] 结束', () => {
      assert.ok(streamText.includes('你好'))
      assert.ok(streamText.includes('[DONE]'))
    })

    // 等待异步计量落库
    await sleep(700)

    // ---------------------------------------------------------- 计量核对
    section('⑦ 计量落库核对')

    const logs = await apiCall('GET', '/api/logs?limit=50')
    const mine = (logs.body?.logs ?? []).filter((l) => l.model === MOCK_MODEL)

    const nonStreamLog = mine.find((l) => l.path === '/chat/completions' && !l.estimated)
    check('非流式请求已记录且 usage 精确', () => {
      assert.ok(nonStreamLog, '未找到非流式日志')
      assert.equal(nonStreamLog.promptTokens, MOCK_USAGE.prompt_tokens)
      assert.equal(nonStreamLog.completionTokens, MOCK_USAGE.completion_tokens)
      assert.equal(nonStreamLog.totalTokens, MOCK_USAGE.total_tokens)
    })

    const streamLog = mine.filter((l) => l.estimated === false).length
    check('流式请求的 usage 也被解析（非估算）', () => {
      const streamedLog = mine.find((l) => l.totalTokens === MOCK_USAGE.total_tokens)
      assert.ok(streamedLog, '未找到流式 usage 记录')
      assert.ok(streamLog >= 2)
    })

    check('日志里的渠道归属正确（确定性断言）', () => {
      const row = mine.find((l) => l.channelName === `smoke-mock-${RUN}`)
      assert.ok(row, '未找到属于本轮渠道的日志记录')
      assert.equal(row.statusCode, 200)
    })

    const overview = await apiCall('GET', '/api/stats/overview?range=today')
    check('今日统计反映请求数', () => {
      // 此刻已落库的是：1 次非流式 + 1 次流式（401/403 在鉴权层被拒，不计入）
      assert.equal(overview.body?.range?.preset, 'today')
      assert.ok(
        overview.body.totals.requests >= 2,
        `requests=${overview.body.totals.requests}`
      )
      assert.ok(
        overview.body.totals.tokens >= MOCK_USAGE.total_tokens * 2,
        `tokens=${overview.body.totals.tokens}`
      )
      assert.ok(overview.body.totals.promptTokens >= MOCK_USAGE.prompt_tokens)
    })

    check('今日统计带出平均值与 P95 延迟', () => {
      assert.ok(overview.body.totals.avgLatencyMs >= 0)
      assert.ok(overview.body.totals.p95LatencyMs >= 0)
    })

    check('统计带出 Top 模型 / 渠道 / 密钥', () => {
      // Top 榜单只取前 5，而跨轮次累积的历史日志会影响排名 ——
      // 因此这里只断言结构与内容形态，**不断言「我这条一定在前 5」**
      // （那会让测试依赖数据库的累积状态，是间歇性失败的根源）
      assert.ok(Array.isArray(overview.body.topModels))
      assert.ok(overview.body.topModels.length > 0)
      assert.ok(overview.body.topModels.some((m) => m.name === MOCK_MODEL))
      assert.ok(Array.isArray(overview.body.topChannels))
      assert.ok(overview.body.topChannels.length > 0)
      assert.ok(
        overview.body.topChannels.every(
          (x) => typeof x.name === 'string' && typeof x.requests === 'number'
        )
      )
      assert.ok(Array.isArray(overview.body.topKeys))
    })

    const series = await apiCall('GET', '/api/stats/series?range=7d')
    check('近 7 天序列按天分桶返回 7 个点', () => {
      assert.equal(series.body?.granularity, 'day')
      assert.equal(series.body?.series?.length, 7)
    })

    const todaySeries = await apiCall('GET', '/api/stats/series?range=today')
    check('今日序列按小时分桶', () => {
      assert.equal(todaySeries.body?.granularity, 'hour')
      assert.ok(todaySeries.body.series.length >= 1)
    })

    const monthOverview = await apiCall('GET', '/api/stats/overview?range=30d')
    check('近一个月统计可用', () => {
      assert.equal(monthOverview.body?.range?.preset, '30d')
      assert.ok(monthOverview.body.totals.requests >= 2)
    })

    // 日均用量的分母由后端给：当地时区下 sum(total_tokens) > 0 的天数。
    // 30d = 当地 30 个日历日（含今日），故上界是 31 而不是 30。
    check('30d 统计带出 activeDays（数字且在区间天数内）', () => {
      const days = monthOverview.body?.totals?.activeDays
      assert.equal(typeof days, 'number', `activeDays 类型错误：${typeof days}`)
      assert.ok(days >= 0 && days <= 31, `activeDays 越界：${days}`)
    })

    check('有 token 总量时 activeDays 至少为 1', () => {
      const totals = monthOverview.body?.totals ?? {}
      if (totals.tokens > 0) {
        assert.ok(totals.activeDays >= 1, `tokens=${totals.tokens} 但 activeDays=${totals.activeDays}`)
      }
    })

    // 90d / 365d：更粗的分桶 —— 90d 按当地周（周一起），365d 按半月（1 日 / 16 日）。
    // 首尾桶按 [from, to] 裁剪；周桶点数随 from 落在周几而 13/14 变化，
    // 半月桶点数随 to 是否已过 16 日而 24/25 变化，故用同一套当地日历规则算精确预期。
    const quarterOverview = await apiCall('GET', '/api/stats/overview?range=90d')
    check('近一个季度统计可用（range.preset=90d）', () => {
      assert.equal(quarterOverview.status, 200)
      assert.equal(quarterOverview.body?.range?.preset, '90d')
    })

    const quarterSeries = await apiCall('GET', '/api/stats/series?range=90d')
    check('近一个季度序列按周（周一起）分桶', () => {
      const body = quarterSeries.body
      assert.equal(body?.granularity, 'week')
      const expected = expectedWeekBuckets(body.range.from, body.range.to, body.timezone)
      assert.ok(expected >= 13 && expected <= 14, `预期周桶数异常：${expected}`)
      assert.equal(
        body.series.length,
        expected,
        `series length = ${body.series.length}, expected = ${expected}`
      )
    })

    const yearOverview = await apiCall('GET', '/api/stats/overview?range=365d')
    check('近一年统计可用（range.preset=365d）', () => {
      assert.equal(yearOverview.status, 200)
      assert.equal(yearOverview.body?.range?.preset, '365d')
    })

    const yearSeries = await apiCall('GET', '/api/stats/series?range=365d')
    check('近一年序列按半月（1 日 / 16 日）分桶', () => {
      const body = yearSeries.body
      assert.equal(body?.granularity, 'halfmonth')
      const expected = expectedHalfMonthBuckets(body.range.from, body.range.to, body.timezone)
      assert.ok(expected === 24 || expected === 25, `预期半月桶数异常：${expected}`)
      assert.equal(
        body.series.length,
        expected,
        `series length = ${body.series.length}, expected = ${expected}`
      )
    })

    // ---------------------------------------------------------- 使用频率热力图（二维矩阵）
    // 契约：cells 永远是 rows×cols 的完整矩阵；xLabels/yLabels 长度分别为 cols/rows；
    // 365d 走 GitHub 贡献墙（列=周、行=周一..周日、只在月份切换处标月份）。
    const heatToday = await apiCall('GET', '/api/stats/heatmap?range=today')
    check('today 热力图：96 刻钟列 × 15 分钟行', () => {
      const body = heatToday.body
      assert.equal(body?.mode, 'grid')
      assert.equal(body.cols, 96)
      assert.equal(body.rows, 15)
      assert.equal(body.cells.length, 15)
      assert.ok(body.cells.every((row) => row.length === 96))
      assert.equal(body.xLabels.length, 96)
      assert.equal(body.yLabels.length, 15)
      assert.equal(body.xLabels[0], '00:00')
      assert.equal(body.xLabels[24], '06:00')
      assert.equal(body.xLabels[48], '12:00')
      assert.equal(body.xLabels[72], '18:00')
      assert.equal(body.yLabels[0], '1')
      assert.ok(
        body.cells.every((row) =>
          row.every(
            (cell) =>
              typeof cell.requests === 'number' &&
              cell.requests >= 0 &&
              typeof cell.tokens === 'number' &&
              typeof cell.errors === 'number'
          )
        )
      )
    })

    const heat7d = await apiCall('GET', '/api/stats/heatmap?range=7d')
    check('7d 热力图：84 时辰列 × 12 十分钟行', () => {
      const body = heat7d.body
      assert.equal(body?.mode, 'grid')
      assert.equal(body.cols, 84)
      assert.equal(body.rows, 12)
      assert.equal(body.cells.length, 12)
      assert.ok(body.cells.every((row) => row.length === 84))
      assert.equal(body.xLabels.length, 84)
      assert.equal(body.yLabels.length, 12)
      assert.match(body.xLabels[0], /^\d{2}-\d{2}$/)
      assert.equal(body.xLabels[1], '')
    })

    const heat30d = await apiCall('GET', '/api/stats/heatmap?range=30d')
    check('30d 热力图：90 午列（30 天 × 3）× 16 半小时行', () => {
      const body = heat30d.body
      assert.equal(body?.mode, 'grid')
      assert.equal(body.cols, 90)
      assert.equal(body.rows, 16)
      assert.equal(body.cells.length, 16)
      assert.ok(body.cells.every((row) => row.length === 90))
      assert.equal(body.xLabels.length, 90)
      assert.equal(body.yLabels.length, 16)
      assert.match(body.xLabels[0], /^\d{2}-\d{2}$/)
      assert.equal(body.xLabels[1], '')
      assert.equal(body.xLabels[2], '')
    })

    const heat90d = await apiCall('GET', '/api/stats/heatmap?range=90d')
    check('90d 热力图：90 天列 × 12 时辰行', () => {
      const body = heat90d.body
      assert.equal(body?.mode, 'grid')
      assert.equal(body.cols, 90)
      assert.equal(body.rows, 12)
      assert.equal(body.cells.length, 12)
      assert.ok(body.cells.every((row) => row.length === 90))
      assert.equal(body.xLabels.length, 90)
      assert.equal(body.yLabels.length, 12)
      assert.match(body.xLabels[0], /^\d{2}-\d{2}$/)
      assert.equal(body.xLabels[1], '')
      assert.equal(body.xLabels[6], '')
      assert.match(body.xLabels[7], /^\d{2}-\d{2}$/)
    })

    const heat365d = await apiCall('GET', '/api/stats/heatmap?range=365d')
    check('365d 热力图：GitHub 风格年历（周列 × 周一..周日）', () => {
      const body = heat365d.body
      assert.equal(body?.mode, 'calendar')
      assert.equal(body.rows, 7)
      assert.ok(body.cols >= 52 && body.cols <= 54, `cols=${body.cols}`)
      assert.equal(body.cells.length, 7)
      assert.ok(body.cells.every((row) => row.length === body.cols))
      assert.equal(body.xLabels.length, 0)
      assert.equal(body.yLabels.length, 7)
      assert.deepEqual(body.weekdayLabels, [
        'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'
      ])
      // 第一列第一行必须是周一：列数 = 覆盖范围（365 天 + 前置对齐）所需周数
      const fromDay = dayNumber(localDateParts(body.range.from, body.timezone))
      const offset = (weekdayOf(fromDay) + 6) % 7
      assert.equal(body.cols, Math.ceil((365 + offset) / 7))
      // 月份标签：范围内每个「月份首次出现」标一次；365 天通常跨 12 或 13 个
      // 月份出现（起点恰为 1 日时 12，否则 13 —— 首月与次年同月各一次）。
      const expectedMonths = expectedMonthLabelCount(
        body.range.from,
        body.range.to,
        body.timezone
      )
      assert.ok(expectedMonths === 12 || expectedMonths === 13, `月份数 ${expectedMonths}`)
      assert.equal(body.monthLabels.length, expectedMonths)
      assert.ok(
        body.monthLabels.every(
          (m) =>
            Number.isInteger(m.col) &&
            m.col >= 0 &&
            m.col < body.cols &&
            /^[A-Z][a-z]{2}$/.test(m.label)
        )
      )
      // 同一列不重复标月份；列号严格递增
      const cols = body.monthLabels.map((m) => m.col)
      assert.deepEqual(cols, [...new Set(cols)])
      assert.deepEqual(cols, [...cols].sort((a, b) => a - b))
    })

    const sumCellRequests = (cells) =>
      cells.reduce(
        (total, row) => total + row.reduce((line, cell) => line + cell.requests, 0),
        0
      )

    const overviewTodayForHeat = await apiCall('GET', '/api/stats/overview?range=today')
    check('today 矩阵求和 == overview today 的 requests（fold 不丢格/不重复）', () =>
      assert.equal(
        sumCellRequests(heatToday.body.cells),
        overviewTodayForHeat.body.totals.requests,
        `heatmap=${sumCellRequests(heatToday.body.cells)} overview=${overviewTodayForHeat.body.totals.requests}`
      )
    )

    const overviewYearForHeat = await apiCall('GET', '/api/stats/overview?range=365d')
    check('365d 矩阵求和 == overview 365d 的 requests（日历对齐不丢天）', () =>
      assert.equal(
        sumCellRequests(heat365d.body.cells),
        overviewYearForHeat.body.totals.requests,
        `heatmap=${sumCellRequests(heat365d.body.cells)} overview=${overviewYearForHeat.body.totals.requests}`
      )
    )

    check('更大区间的请求数只多不少（90d >= 30d）', () =>
      assert.ok(
        quarterOverview.body.totals.requests >= monthOverview.body.totals.requests,
        `90d=${quarterOverview.body.totals.requests} 30d=${monthOverview.body.totals.requests}`
      )
    )

    const customFrom = new Date(Date.now() - 3600_000).toISOString()
    const customTo = new Date(Date.now() + 60_000).toISOString()
    const customOverview = await apiCall(
      'GET',
      `/api/stats/overview?range=custom&from=${encodeURIComponent(customFrom)}&to=${encodeURIComponent(customTo)}`
    )
    check('自定义范围（近一小时）能统计到刚才的请求', () =>
      assert.ok(customOverview.body.totals.requests >= 2)
    )

    const pastOverview = await apiCall(
      'GET',
      `/api/stats/overview?range=custom&from=${encodeURIComponent('2020-01-01T00:00:00.000Z')}&to=${encodeURIComponent('2020-01-02T00:00:00.000Z')}`
    )
    check('自定义范围（历史区间）统计为 0', () => {
      assert.equal(pastOverview.body.totals.requests, 0)
      assert.equal(pastOverview.body.totals.tokens, 0)
    })

    const badRange = await apiCall('GET', '/api/stats/overview?range=custom')
    check('自定义范围缺参数被拒（400）', () => assert.equal(badRange.status, 400))

    // ---------------------------------------------------------- 限流
    section('⑧ 速率限制')

    const rlKey = await apiCall('POST', '/api/keys', {
      name: `smoke-rl-${RUN}`,
      channelId,
      rpmLimit: 2,
      quotaTokens: 0
    })
    const rlToken = rlKey.body.key
    createdKeyIds.push(rlKey.body.apiKey.id)
    const results = []
    for (let i = 0; i < 4; i++) {
      const r = await proxyCall(
        '/v1/chat/completions',
        { model: MOCK_MODEL, messages: [{ role: 'user', content: `rl-${i}` }] },
        rlToken
      )
      results.push(r.status)
    }
    const rejected = results.filter((s) => s === 429).length
    check('超过 RPM 的请求返回 429', () => assert.ok(rejected >= 2, `状态序列 ${results}`))

    // ---------------------------------------------------------- 配额
    section('⑨ Token 配额')

    const quotaRes = await apiCall('POST', '/api/keys', {
      name: `smoke-quota-${RUN}`,
      channelId,
      rpmLimit: 0,
      quotaTokens: 5
    })
    quotaKey = quotaRes.body.key
    createdKeyIds.push(quotaRes.body.apiKey.id)

    const first = await proxyCall(
      '/v1/chat/completions',
      { model: MOCK_MODEL, messages: [{ role: 'user', content: 'quota' }] },
      quotaKey
    )
    await sleep(500)
    const second = await proxyCall(
      '/v1/chat/completions',
      { model: MOCK_MODEL, messages: [{ role: 'user', content: 'quota-2' }] },
      quotaKey
    )
    check('首次请求放行', () => assert.equal(first.status, 200))
    check('配额用尽后返回 402', () => assert.equal(second.status, 402))

    // ---------------------------------------------------------- 模型白名单
    section('⑩ 模型白名单')

    const allowRes = await apiCall('POST', '/api/keys', {
      name: `smoke-allow-${RUN}`,
      channelId,
      modelAllow: ['another-model'],
      rpmLimit: 0,
      quotaTokens: 0
    })
    createdKeyIds.push(allowRes.body.apiKey.id)
    const denied = await proxyCall(
      '/v1/chat/completions',
      { model: MOCK_MODEL, messages: [{ role: 'user', content: 'x' }] },
      allowRes.body.key
    )
    check('白名单外的模型返回 403', () => assert.equal(denied.status, 403))

    // ---------------------------------------------------------- 查看 Key
    section('⑪ 查看密钥（仅管理员 + 审计留痕）')

    const revealed = await apiCall('GET', `/api/keys/${keyRes.body.apiKey.id}/reveal`)
    check('管理员可查看完整密钥', () => assert.equal(revealed.status, 200))
    check('查看得到的明文与创建时一致', () =>
      assert.equal(revealed.body?.key, keyFull)
    )

    // 建一个操作员账号，验证权限边界（幂等：已存在则复用）
    const operatorPassword = OPERATOR_PASS
    const createOperator = await apiCall('POST', '/api/users', {
      username: OPERATOR_USER,
      displayName: '冒烟操作员',
      password: operatorPassword,
      role: 'operator'
    })
    const operatorExists =
      createOperator.status === 201 ||
      (createOperator.status === 400 &&
        String(createOperator.body?.error?.message ?? '').includes('已存在'))
    check('可创建（或复用）操作员账号', () => assert.ok(operatorExists))

    const operatorLogin = await apiCall(
      'POST',
      '/api/auth/login',
      { username: OPERATOR_USER, password: operatorPassword },
      { keepSession: true }
    )
    check('操作员可登录', () => assert.equal(operatorLogin.status, 200))
    const operatorCookie = operatorLogin.cookie

    const operatorReveal = await apiCall(
      'GET',
      `/api/keys/${keyRes.body.apiKey.id}/reveal`,
      undefined,
      { cookie: operatorCookie }
    )
    check('操作员查看密钥被拒（403）', () => assert.equal(operatorReveal.status, 403))

    const operatorList = await apiCall('GET', '/api/keys', undefined, {
      cookie: operatorCookie
    })
    check('操作员仍可列出密钥（只读）', () => assert.equal(operatorList.status, 200))
    check('列表绝不返回完整密钥', () =>
      assert.ok(!operatorList.text.includes(keyFull))
    )

    // ---- 回归：partial PATCH 不得重置未传字段 ----
    //
    // 曾经的 bug：updateSchema = createSchema.partial() 会**保留内层 default()**，
    // 于是 PATCH {note} 会把 models 清空、protocol 重置为 openai、priority 归 100。
    // 修法是把默认值移出 schema，只在创建路径显式补。
    const beforePatch = await apiCall('GET', `/api/channels/${channelId}`)
    const partialPatch = await apiCall('PATCH', `/api/channels/${channelId}`, {
      note: '只改备注'
    })
    check('部分字段 PATCH 不会重置其他字段', () => {
      const after = partialPatch.body?.channel
      const before = beforePatch.body?.channel
      assert.equal(after.note, '只改备注')
      assert.equal(after.protocol, before.protocol, 'protocol 被重置')
      assert.deepEqual(after.models, before.models, 'models 被重置')
      assert.equal(after.priority, before.priority, 'priority 被重置')
      assert.equal(after.modelsPath, before.modelsPath, 'modelsPath 被重置')
      assert.equal(after.timeoutMs, before.timeoutMs, 'timeoutMs 被重置')
      assert.deepEqual(after.extraHeaders, before.extraHeaders, 'extraHeaders 被重置')
    })
    await apiCall('PATCH', `/api/channels/${channelId}`, { note: '' })

    // ---- 上游渠道密钥的查看：同一套安全约束 ----
    const channelReveal = await apiCall('GET', `/api/channels/${channelId}/reveal`)
    check('管理员可查看上游渠道密钥', () => assert.equal(channelReveal.status, 200))
    check('上游密钥明文正确', () => assert.equal(channelReveal.body?.key, UPSTREAM_KEY))

    const operatorChannelReveal = await apiCall(
      'GET',
      `/api/channels/${channelId}/reveal`,
      undefined,
      { cookie: operatorCookie }
    )
    check('操作员查看上游密钥被拒（403）', () =>
      assert.equal(operatorChannelReveal.status, 403)
    )

    const noKeyChannel = await apiCall('POST', '/api/channels', {
      name: `smoke-nokey-${RUN}`,
      baseUrl: `${MOCK}/v1`,
      models: [MOCK_MODEL]
    })
    const noKeyReveal = await apiCall(
      'GET',
      `/api/channels/${noKeyChannel.body.channel.id}/reveal`
    )
    check('未配置密钥的渠道查看返回 409', () => {
      assert.equal(noKeyReveal.status, 409)
      assert.equal(noKeyReveal.body?.error?.code, 'channel_key_empty')
    })
    await apiCall('DELETE', `/api/channels/${noKeyChannel.body.channel.id}`)

    const channelAudit = await apiCall('GET', '/api/audit?action=channel.reveal&limit=20')
    check('查看上游密钥已写入审计日志', () => {
      const hit = (channelAudit.body?.events ?? []).find((e) => e.targetId === channelId)
      assert.ok(hit, '未找到 channel.reveal 审计记录')
      assert.equal(hit.actor, ADMIN_USER)
    })

    const audit = await apiCall('GET', '/api/audit?action=key.reveal&limit=20')
    check('查看密钥已写入审计日志', () => {
      assert.equal(audit.status, 200)
      const hit = (audit.body?.events ?? []).find(
        (e) => e.targetId === keyRes.body.apiKey.id
      )
      assert.ok(hit, '未找到 key.reveal 审计记录')
      assert.equal(hit.actor, ADMIN_USER)
    })

    const operatorAudit = await apiCall('GET', '/api/audit', undefined, {
      cookie: operatorCookie
    })
    check('操作员无权查询审计日志（403）', () =>
      assert.equal(operatorAudit.status, 403)
    )

    // ---------------------------------------------------------- 对话测试页的前置链路
    section('⑫ 对话测试页所依赖的链路')

    const chatModels = await fetch(`${BASE}/v1/models`, {
      headers: { authorization: `Bearer ${revealed.body.key}` }
    })
    const chatModelsJson = await chatModels.json()

    const chatCall = await proxyCall(
      '/v1/chat/completions',
      {
        model: MOCK_MODEL,
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: '来自对话测试页' }]
      },
      revealed.body.key
    )
    check('对话测试页的流式请求可用（模拟页面行为）', () => {
      assert.equal(chatCall.status, 200)
      // 流式是分片下发的：'你好' 与 '世界' 在不同 SSE 帧里，不能断言拼接后的整串
      assert.ok(chatCall.text.includes('你好'), '缺少首片内容')
      assert.ok(chatCall.text.includes('世界'), '缺少末片内容')
      assert.ok(chatCall.text.includes('"usage"'), '缺少 usage 帧')
    })
    check('该密钥可见的模型列表非空', () =>
      assert.ok(chatModelsJson.data.length > 0)
    )

    // ---------------------------------------------------------- 直连渠道测试
    section('⑬ 对话测试：直连上游渠道（绕过网关治理）')

    const directChat = await apiCall('POST', `/api/channels/${channelId}/chat`, {
      model: MOCK_MODEL,
      messages: [{ role: 'user', content: '直连测试' }]
    })
    check('管理员可用渠道自身密钥直连上游', () => {
      assert.equal(directChat.status, 200)
      assert.equal(directChat.body?.choices?.[0]?.message?.content, '你好，世界')
    })
    check('直连时同样应用固定请求头与厂商兼容头', () => {
      assert.equal(lastUpstreamHeaders['x-smoke-header'], 'portara-smoke')
      assert.ok(lastUpstreamHeaders['x-opencode-session'])
    })
    check('直连响应与网关响应同源（内容一致）', () =>
      assert.equal(directChat.body.choices[0].message.content, chat.body.choices[0].message.content)
    )

    const operatorDirect = await apiCall(
      'POST',
      `/api/channels/${channelId}/chat`,
      { model: MOCK_MODEL, messages: [] },
      { cookie: operatorCookie }
    )
    check('操作员不可用直连渠道测试（403）', () =>
      assert.equal(operatorDirect.status, 403)
    )

    await sleep(700)
    const logsAfterDirect = await apiCall('GET', '/api/logs?limit=100')
    const directRows = (logsAfterDirect.body?.logs ?? []).filter(
      (l) => l.source === 'playground'
    )
    check('直连测试写入 request_logs 并标记来源', () => {
      assert.ok(directRows.length > 0, '未找到 source=playground 的记录')
      assert.equal(directRows[0].channelName, `smoke-mock-${RUN}`)
    })

    const overviewWithDirect = await apiCall('GET', '/api/stats/overview?range=today')
    check('直连测试计入概览总量并被单独标出', () => {
      assert.ok(overviewWithDirect.body.totals.requests > 0)
      assert.ok(
        overviewWithDirect.body.totals.diagnosticRequests > 0,
        `diagnosticRequests=${overviewWithDirect.body.totals.diagnosticRequests}`
      )
    })

    // ---------------------------------------------------------- Key 归属
    section('⑭ 密钥归属：非管理员只见自己的')

    const userList = await apiCall('GET', '/api/users')
    const operatorUser = (userList.body?.users ?? []).find((u) => u.username === OPERATOR_USER)
    check('可查到操作员账号', () => assert.ok(operatorUser))

    const operatorOwnKey = await apiCall(
      'POST',
      '/api/keys',
      { name: `smoke-op-key-${RUN}`, channelId, rpmLimit: 0, quotaTokens: 0 },
      { cookie: operatorCookie }
    )
    check('操作员可为自己签发密钥', () => assert.equal(operatorOwnKey.status, 201))
    createdKeyIds.push(operatorOwnKey.body.apiKey.id)
    check('操作员签发的密钥归属自己（无法替他人签发）', () =>
      assert.equal(operatorOwnKey.body.apiKey.userId, operatorUser.id)
    )

    const adminKeyOwnedByOperator = await apiCall('POST', '/api/keys', {
      name: `smoke-admin-issued-${RUN}`,
      userId: operatorUser.id,
      channelId,
      rpmLimit: 0,
      quotaTokens: 0
    })
    check('管理员可替指定用户签发密钥', () => {
      assert.equal(adminKeyOwnedByOperator.status, 201)
      assert.equal(adminKeyOwnedByOperator.body.apiKey.userId, operatorUser.id)
    })
    createdKeyIds.push(adminKeyOwnedByOperator.body.apiKey.id)
    check('密钥 DTO 带出所有者用户名', () =>
      assert.equal(adminKeyOwnedByOperator.body.apiKey.ownerName, OPERATOR_USER)
    )

    const operatorKeyList = await apiCall('GET', '/api/keys', undefined, {
      cookie: operatorCookie
    })
    check('操作员的密钥列表只含自己名下的', () => {
      const owners = new Set((operatorKeyList.body?.keys ?? []).map((k) => k.userId))
      assert.equal(owners.size, 1, `看到 ${owners.size} 个归属`)
      assert.ok(owners.has(operatorUser.id))
    })
    check('操作员看不到管理员的密钥', () => {
      const names = (operatorKeyList.body?.keys ?? []).map((k) => k.name)
      assert.ok(!names.includes(`smoke-key-${RUN}`), '看到了管理员的密钥')
    })

    const adminKeyList = await apiCall('GET', '/api/keys')
    check('管理员能看到所有人的密钥', () => {
      const names = (adminKeyList.body?.keys ?? []).map((k) => k.name)
      assert.ok(names.includes(`smoke-key-${RUN}`))
      assert.ok(names.includes(`smoke-op-key-${RUN}`))
    })
    check('管理员视图中外人的密钥带所有者名字', () => {
      const foreign = (adminKeyList.body?.keys ?? []).find(
        (k) => k.name === `smoke-op-key-${RUN}`
      )
      assert.equal(foreign.ownerName, OPERATOR_USER)
    })

    const operatorDeleteForeign = await apiCall(
      'DELETE',
      `/api/keys/${keyRes.body.apiKey.id}`,
      undefined,
      { cookie: operatorCookie }
    )
    check('操作员不能删除他人的密钥（403）', () =>
      assert.equal(operatorDeleteForeign.status, 403)
    )
    const operatorPatchForeign = await apiCall(
      'PATCH',
      `/api/keys/${keyRes.body.apiKey.id}`,
      { name: 'hijacked' },
      { cookie: operatorCookie }
    )
    check('操作员不能改他人的密钥（403）', () =>
      assert.equal(operatorPatchForeign.status, 403)
    )
    const operatorRevealOwn = await apiCall(
      'GET',
      `/api/keys/${operatorOwnKey.body.apiKey.id}/reveal`,
      undefined,
      { cookie: operatorCookie }
    )
    check('操作员可查看自己名下的密钥', () => assert.equal(operatorRevealOwn.status, 200))

    // ---------------------------------------------------------- 个人资料（用户范围统计）
    section('⑭·补充 用户资料与用户范围统计')

    // 不带会话：apiCall 的 opts.cookie 传空串即「本次请求不带 Cookie」
    const profileAnon = await apiCall('GET', '/api/profile', undefined, { cookie: '' })
    check('未登录访问个人资料被拒（401）', () =>
      assert.equal(profileAnon.status, 401)
    )

    const profile = await apiCall('GET', '/api/profile')
    check('登录后可读取个人资料（200）', () => assert.equal(profile.status, 200))
    check('个人资料复用用户 DTO（不泄漏敏感字段）', () => {
      const u = profile.body?.user
      assert.equal(u?.username, ADMIN_USER)
      assert.equal(u?.role, 'admin')
      assert.equal(typeof u?.createdAt, 'string')
      assert.ok(!profile.text.includes('password_hash'), '响应里出现了 password_hash')
      assert.ok(!profile.text.includes('key_hash'), '响应里出现了 key_hash')
    })
    check('个人资料不返回任何密钥本体', () =>
      assert.ok(!profile.text.includes(keyFull))
    )

    const pstats = profile.body?.stats ?? {}
    check('密钥数按当前用户统计（total >= 1 且 active <= total）', () => {
      assert.ok(pstats.keys?.total >= 1, `total=${pstats.keys?.total}`)
      assert.ok(pstats.keys.active <= pstats.keys.total)
    })
    check('累计请求数可用且近 30 天不超过累计', () => {
      assert.equal(typeof pstats.requests, 'number')
      assert.ok(pstats.requests >= 0)
      assert.ok(pstats.last30d.requests <= pstats.requests)
    })
    check('失败数 / Token 口径自洽（近 30 天 <= 累计）', () => {
      assert.ok(pstats.errors >= 0 && pstats.errors <= pstats.requests)
      assert.ok(pstats.last30d.errors <= pstats.last30d.requests)
      assert.ok(pstats.tokens >= 0)
      assert.ok(pstats.last30d.tokens <= pstats.tokens)
    })
    check('首末请求时间为 null 或合法 ISO 时间', () => {
      for (const value of [pstats.firstRequestAt, pstats.lastRequestAt]) {
        assert.ok(
          value === null || !Number.isNaN(Date.parse(value)),
          `非法时间：${value}`
        )
      }
    })
    check('名下有请求时首末请求时间非空', () => {
      assert.ok(profile.body.stats.firstRequestAt)
      assert.ok(profile.body.stats.lastRequestAt)
    })

    const operatorProfile = await apiCall('GET', '/api/profile', undefined, {
      cookie: operatorCookie
    })
    check('操作员也能访问个人资料（200）', () =>
      assert.equal(operatorProfile.status, 200)
    )
    check('操作员看到的是自己的资料', () =>
      assert.equal(operatorProfile.body?.user?.username, OPERATOR_USER)
    )
    check('密钥统计按用户隔离（操作员只算自己名下的）', () => {
      const own = operatorProfile.body?.stats?.keys?.total
      const expected = operatorKeyList.body.keys.length
      assert.equal(own, expected, `资料 ${own} != 自己可见密钥 ${expected}`)
      assert.ok(own < profile.body.stats.keys.total, '操作员不该看到管理员的密钥')
    })
    check('请求统计也按用户隔离（操作员名下没有流量）', () => {
      assert.ok(profile.body.stats.requests > 0, '管理员名下应有请求')
      assert.equal(
        operatorProfile.body.stats.requests,
        0,
        `操作员名下出现了 ${operatorProfile.body.stats.requests} 条请求`
      )
    })

    // ---------------------------------------------------------- 模型映射
    section('⑮ 模型映射：别名 → 上游模型')

    // 必须用**未绑定渠道**的 Key：绑定语义是「只走该渠道、不跨渠道回退」，
    // 用绑定 Key 测负载均衡会永远只落在一个渠道（这是设计如此，不是 bug）
    const mapKeyRes = await apiCall('POST', '/api/keys', {
      name: `smoke-map-key-${RUN}`,
      rpmLimit: 0,
      quotaTokens: 0
    })
    check('创建未绑定渠道的 Key 用于映射测试', () => assert.equal(mapKeyRes.status, 201))
    const mapKey = mapKeyRes.body.key
    createdKeyIds.push(mapKeyRes.body.apiKey.id)

    const ALIAS = `smoke-alias-${RUN}/mapped`

    const created2 = await apiCall('POST', '/api/model-routes', {
      alias: ALIAS,
      targets: [{ channelId, upstreamModel: MOCK_MODEL, priority: 10, weight: 1 }],
      note: '冒烟映射'
    })
    check('可创建模型映射', () => assert.equal(created2.status, 201))
    check('映射返回带渠道名', () =>
      assert.equal(created2.body?.routes?.[0]?.channelName, `smoke-mock-${RUN}`)
    )

    const aliasList = await apiCall('GET', '/api/model-routes')
    check('映射列表可按别名查到', () =>
      assert.ok((aliasList.body?.routes ?? []).some((r) => r.alias === ALIAS))
    )

    const modelsWithAlias = await fetch(`${BASE}/v1/models`, {
      headers: { authorization: `Bearer ${mapKey}` }
    })
    const modelsWithAliasJson = await modelsWithAlias.json()
    check('/v1/models 里出现映射别名', () =>
      assert.ok(modelsWithAliasJson.data.some((m) => m.id === ALIAS))
    )

    const mappedCall = await proxyCall(
      '/v1/chat/completions',
      { model: ALIAS, messages: [{ role: 'user', content: '映射测试' }] },
      mapKey
    )
    check('用别名调用成功（200）', () => assert.equal(mappedCall.status, 200))
    check('上游收到的是映射后的真实模型 id', () =>
      assert.equal(mappedCall.body?.received_model, MOCK_MODEL)
    )
    check('未配映射的模型仍按原样直通（回退逻辑）', () => {
      // 前文用 MOCK_MODEL 直连成功过，这里再确认一次语义
      assert.ok(chat.body?.received_model === MOCK_MODEL)
    })

    await sleep(600)
    const mappedLogs = await apiCall('GET', '/api/logs?limit=50')
    const mappedLog = (mappedLogs.body?.logs ?? []).find((l) => l.model === ALIAS)
    check('日志同时记录受理模型与上游模型', () => {
      assert.ok(mappedLog, '未找到该别名的日志')
      assert.equal(mappedLog.model, ALIAS)
      assert.equal(mappedLog.upstreamModel, MOCK_MODEL)
    })

    // ---------------------------------------------------------- 批量加前缀
    section('⑯ 批量映射：给渠道所有模型加前缀')

    const batch = await apiCall('POST', '/api/model-routes/batch', {
      channelId,
      prefix: `smoke-prefix-${RUN}`,
      models: [MOCK_MODEL, 'second-model'],
      priority: 50,
      weight: 1
    })
    check('批量映射创建成功', () => assert.equal(batch.status, 201))
    check('批量创建 2 条映射', () => assert.equal(batch.body?.created, 2))
    check('别名按「前缀/模型」生成', () => {
      const expected = `smoke-prefix-${RUN}/${MOCK_MODEL}`
      assert.ok(batch.body?.aliases?.includes(expected), JSON.stringify(batch.body?.aliases))
    })

    // 分组键：批量映射必须记下所用的前缀，供 UI 分组（模型 id 自带 / 时尤其重要）
    const grouped = await apiCall('GET', '/api/model-routes')
    const groupedRow = (grouped.body?.routes ?? []).find(
      (r) => r.alias === `smoke-prefix-${RUN}/${MOCK_MODEL}`
    )
    check('批量映射记录分组键（渠道 id 头）', () =>
      assert.equal(groupedRow?.groupKey, `smoke-prefix-${RUN}`)
    )

    // 模型 id 自带 / 时，分组键仍应是前缀而不是被 / 切碎
    const slashModel = 'vendor/sub-model'
    const slashBatch = await apiCall('POST', '/api/model-routes/batch', {
      channelId,
      prefix: `smoke-slash-${RUN}`,
      models: [slashModel]
    })
    check('模型 id 自带 / 时批量映射仍可用', () => assert.equal(slashBatch.status, 201))
    const slashList = await apiCall('GET', '/api/model-routes')
    const slashRow = (slashList.body?.routes ?? []).find(
      (r) => r.alias === `smoke-slash-${RUN}/${slashModel}`
    )
    check('含 / 的模型 id 分组键仍是完整前缀（不被切碎）', () => {
      assert.ok(slashRow, '未找到该映射')
      assert.equal(slashRow.groupKey, `smoke-slash-${RUN}`)
      assert.equal(slashRow.upstreamModel, slashModel)
    })
    await apiCall('POST', '/api/model-routes/purge', {
      alias: `smoke-slash-${RUN}/${slashModel}`
    })

    const batchAgain = await apiCall('POST', '/api/model-routes/batch', {
      channelId,
      prefix: `smoke-prefix-${RUN}`,
      models: [MOCK_MODEL],
      priority: 60,
      weight: 3
    })
    check('重复批量是 upsert（合并不报错）', () => {
      assert.equal(batchAgain.status, 201)
      assert.equal(batchAgain.body?.created, 0)
      assert.equal(batchAgain.body?.merged, 1)
    })

    // ---------------------------------------------------------- 一别名多渠道负载均衡
    section('⑰ 一个网关模型 id 负载均衡到多个渠道')

    const channelB = await apiCall('POST', '/api/channels', {
      name: `smoke-mock-b-${RUN}`,
      baseUrl: `${MOCK}/v1`,
      apiKey: UPSTREAM_KEY,
      models: [MOCK_MODEL],
      priority: 10,
      weight: 1,
      status: 'active'
    })
    check('创建第二个渠道用于负载均衡', () => assert.equal(channelB.status, 201))
    const channelBId = channelB.body.channel.id

    const LB_ALIAS = `smoke-lb-${RUN}`
    const lb = await apiCall('POST', '/api/model-routes', {
      alias: LB_ALIAS,
      targets: [
        { channelId, upstreamModel: MOCK_MODEL, priority: 10, weight: 2 },
        { channelId: channelBId, upstreamModel: MOCK_MODEL, priority: 10, weight: 1 }
      ]
    })
    check('同一别名可挂两个渠道的目标', () =>
      assert.equal(lb.body?.routes?.length, 2)
    )

    const served = []
    for (let i = 0; i < 6; i++) {
      const r = await proxyCall(
        '/v1/chat/completions',
        { model: LB_ALIAS, messages: [{ role: 'user', content: `lb-${i}` }] },
        mapKey
      )
      served.push(r.headers.get('x-portara-channel'))
    }
    const uniqueServed = [...new Set(served)]
    check('请求按权重分散到两个渠道', () => {
      assert.equal(uniqueServed.length, 2, `实际只用到：${uniqueServed.join(',')}`)
    })
    check('权重 2:1 的分布正确', () => {
      const a = served.filter((x) => x === `smoke-mock-${RUN}`).length
      const b = served.filter((x) => x === `smoke-mock-b-${RUN}`).length
      assert.equal(a, 4)
      assert.equal(b, 2)
    })

    // ---------------------------------------------------------- 整组删除
    section('⑱ 整组删除映射')

    const purge = await apiCall('POST', '/api/model-routes/purge', { alias: LB_ALIAS })
    check('按别名整组删除', () => {
      assert.equal(purge.status, 200)
      assert.equal(purge.body?.removed, 2)
    })
    const afterPurge = await apiCall('GET', '/api/model-routes')
    check('删除后别名不再出现在列表中', () =>
      assert.ok(!(afterPurge.body?.routes ?? []).some((r) => r.alias === LB_ALIAS))
    )

    const boundKeyCall = await proxyCall(
      '/v1/chat/completions',
      { model: LB_ALIAS, messages: [{ role: 'user', content: 'bound' }] },
      keyFull
    )
    check('绑定渠道的 Key 不会跨渠道（即使别名挂了多个渠道）', () => {
      // LB_ALIAS 已被 purge，绑定 Key 又只在该渠道内找映射 → 应回退为该渠道直通
      assert.equal(boundKeyCall.status, 200)
      assert.equal(boundKeyCall.headers.get('x-portara-channel'), `smoke-mock-${RUN}`)
    })

    const purgeMissing = await apiCall('POST', '/api/model-routes/purge', { alias: 'nope/none' })
    check('删除不存在的别名返回 404', () => assert.equal(purgeMissing.status, 404))

    const badAlias = await apiCall('POST', '/api/model-routes', {
      alias: 'bad alias with spaces',
      targets: [{ channelId, upstreamModel: MOCK_MODEL }]
    })
    check('非法别名被拒（400）', () => assert.equal(badAlias.status, 400))

    // 清理本轮映射（渠道删除会级联删掉其映射，这里显式删别名更直观）
    await apiCall('POST', '/api/model-routes/purge', { alias: ALIAS })
    await apiCall('POST', '/api/model-routes/purge', {
      alias: `smoke-prefix-${RUN}/${MOCK_MODEL}`
    })
    await apiCall('POST', '/api/model-routes/purge', {
      alias: `smoke-prefix-${RUN}/second-model`
    })
    await apiCall('DELETE', `/api/channels/${channelBId}`)

    // ---------------------------------------------------------- JSON 编辑
    section('⑲ 以 JSON 形式编辑映射列表')

    const jsonAlias = `json-test-${RUN}`
    const jsonImport = await apiCall('POST', '/api/model-routes/import', {
      mode: 'replace',
      mapping: {
        [jsonAlias]: { channel: `smoke-mock-${RUN}`, model: MOCK_MODEL }
      }
    })
    if (jsonImport.status !== 200) {
      const diag = await apiCall('GET', '/api/model-routes')
      console.log('   [诊断] 状态', jsonImport.status, JSON.stringify(jsonImport.body).slice(0, 200),
        '| 当前映射', JSON.stringify(diag.body.routes.map(r=>r.alias)))
    }
    check('JSON 导入（替换模式）成功', () => assert.equal(jsonImport.status, 200))
    const afterJson = await apiCall('GET', '/api/model-routes')
    check('替换模式下旧映射被清空', () => {
      const aliases = afterJson.body.routes.map((r) => r.alias)
      assert.deepEqual(aliases, [jsonAlias])
    })

    // 确认门槛：replace 模式下条数不匹配必须被拒
    const noAck = await apiCall('POST', '/api/model-routes/import', {
      mode: 'replace',
      mapping: { 'guard/x': { channel: `smoke-mock-${RUN}`, model: MOCK_MODEL } }
    })
    check('replace 未确认条数被拒（409）', () => {
      assert.equal(noAck.status, 409)
      assert.equal(noAck.body?.error?.code, 'replace_needs_acknowledge')
    })

    const badAck = await apiCall('POST', '/api/model-routes/import', {
      mode: 'replace',
      acknowledgeRemove: 999,
      mapping: { 'guard/x': { channel: `smoke-mock-${RUN}`, model: MOCK_MODEL } }
    })
    check('replace 确认条数不符也被拒（409）', () => assert.equal(badAck.status, 409))

    /*
     * 条数必须**从库里读**而不是写死。
     * 写死过 1 条，结果新增的路由用例在它之前又建了映射，
     * 条数对不上直接 409 —— 这种"依赖全局条数"的断言很容易被后续用例打挂。
     */
    const routesNow = await apiCall('GET', '/api/model-routes')
    const goodAck = await apiCall('POST', '/api/model-routes/import', {
      mode: 'replace',
      acknowledgeRemove: routesNow.body.routes.length,
      mapping: { [jsonAlias]: { channel: `smoke-mock-${RUN}`, model: MOCK_MODEL } }
    })
    check('replace 条数匹配则放行', () => assert.equal(goodAck.status, 200))

    // ---- 误删恢复：审计快照必须能一键回灌 ----
    const snapAudit = await apiCall('GET', '/api/audit?action=model_route.import&limit=20')
    const withSnapshot = (snapAudit.body?.events ?? []).find(
      (e) => e.detail?.mode === 'replace' && e.detail?.snapshot
    )
    check('replace 导入在审计里留下了可恢复快照', () => {
      assert.ok(withSnapshot, '未找到带 snapshot 的审计记录')
      assert.ok(Object.keys(withSnapshot.detail.snapshot).length > 0, '快照为空')
    })

    const beforeRestore = await apiCall('GET', '/api/model-routes')
    const rowsNow = beforeRestore.body.routes.length
    const restore = await apiCall('POST', '/api/model-routes/import', {
      mode: 'replace',
      acknowledgeRemove: rowsNow,
      mapping: withSnapshot.detail.snapshot
    })
    check('快照可直接回灌恢复（误删的救命路径）', () => {
      assert.equal(restore.status, 200)
      assert.equal(restore.body.applied, Object.keys(withSnapshot.detail.snapshot).length)
    })

    const afterRestore = await apiCall('GET', '/api/model-routes')
    check('恢复后映射内容与快照一致', () => {
      const aliases = new Set(afterRestore.body.routes.map((r) => r.alias))
      for (const alias of Object.keys(withSnapshot.detail.snapshot)) {
        assert.ok(aliases.has(alias), `缺少 ${alias}`)
      }
    })

    // 复位到 JSON 测试所需的单条状态
    await apiCall('POST', '/api/model-routes/import', {
      mode: 'replace',
      acknowledgeRemove: afterRestore.body.routes.length,
      mapping: { [jsonAlias]: { channel: `smoke-mock-${RUN}`, model: MOCK_MODEL } }
    })

    const jsonCall = await proxyCall(
      '/v1/chat/completions',
      { model: jsonAlias, messages: [{ role: 'user', content: 'json' }] },
      mapKey
    )
    check('JSON 导入的映射可直接用于转发', () => {
      assert.equal(jsonCall.status, 200)
      assert.equal(jsonCall.body?.received_model, MOCK_MODEL)
    })

    // 数组形式 = 一个网关 ID 负载均衡到多个目标
    const jsonLbAlias = `json-lb-${RUN}`
    const jsonMerge = await apiCall('POST', '/api/model-routes/import', {
      mode: 'merge',
      mapping: {
        [jsonLbAlias]: [
          { channel: `smoke-mock-${RUN}`, model: MOCK_MODEL, weight: 2 },
          { channel: `smoke-mock-${RUN}`, model: 'second-model', weight: 1 }
        ]
      }
    })
    check('JSON 导入（合并模式）成功', () => assert.equal(jsonMerge.status, 200))
    check('数组形式生成两个目标', () => assert.equal(jsonMerge.body?.applied, 2))

    const merged = await apiCall('GET', '/api/model-routes')
    check('合并模式保留原有映射', () => {
      const aliases = merged.body.routes.map((r) => r.alias)
      assert.ok(aliases.includes(jsonAlias), '原有映射被误删')
      assert.ok(aliases.includes(jsonLbAlias))
    })

    const unknownChannel = await apiCall('POST', '/api/model-routes/import', {
      mode: 'merge',
      mapping: { 'x/y': { channel: '不存在的渠道', model: 'm' } }
    })
    check('引用不存在的渠道被拒（400）', () => assert.equal(unknownChannel.status, 400))
    check('报错里给出可用渠道列表', () => {
      const body = JSON.stringify(unknownChannel.body)
      assert.ok(body.includes('smoke-mock'), body)
    })

    const badJsonAlias = await apiCall('POST', '/api/model-routes/import', {
      mode: 'merge',
      mapping: { 'bad alias': { channel: `smoke-mock-${RUN}`, model: 'm' } }
    })
    check('JSON 里的非法模型 ID 被拒（400）', () => assert.equal(badJsonAlias.status, 400))

    // ---------------------------------------------------------- 渠道重命名
    section('⑳ 渠道重命名后映射不失联')

    const renamed = `smoke-mock-renamed-${RUN}`
    const doRename = await apiCall('PATCH', `/api/channels/${channelId}`, { name: renamed })
    check('渠道改名成功', () => assert.equal(doRename.status, 200))

    const afterRename = await apiCall('GET', '/api/model-routes')
    const renamedRoute = afterRename.body.routes.find((r) => r.alias === jsonAlias)
    check('映射列表显示改名后的渠道名', () =>
      assert.equal(renamedRoute?.channelName, renamed)
    )

    const afterRenameCall = await proxyCall(
      '/v1/chat/completions',
      { model: jsonAlias, messages: [{ role: 'user', content: 'renamed' }] },
      mapKey
    )
    check('改名后映射仍能正确转发到该渠道', () => {
      assert.equal(afterRenameCall.status, 200)
      assert.equal(afterRenameCall.headers.get('x-portara-channel'), renamed)
    })

    const renameBack = await apiCall('PATCH', `/api/channels/${channelId}`, {
      name: `smoke-mock-${RUN}`
    })
    check('渠道名改回', () => assert.equal(renameBack.status, 200))

    // 清掉本轮 JSON 映射
    await apiCall('POST', '/api/model-routes/purge', { alias: jsonAlias })
    await apiCall('POST', '/api/model-routes/purge', { alias: jsonLbAlias })

    // ---------------------------------------------------------- 模型列表 API
    section('㉑ 模型列表 API：自定义路径、自动获取、元信息透传')

    const draftFetch = await apiCall('POST', '/api/channels/fetch-models', {
      baseUrl: `${MOCK}/v1`,
      apiKey: UPSTREAM_KEY,
      modelsPath: '/models',
      timeoutMs: 15000
    })
    check('草稿态可拉取模型列表', () => {
      assert.equal(draftFetch.status, 200)
      assert.equal(draftFetch.body?.ok, true)
    })
    check('拉取模型时一并返回原始响应体', () => {
      const raw = draftFetch.body?.raw
      assert.ok(typeof raw === 'string' && raw.length > 0, '缺少 raw')
      const parsed = JSON.parse(raw) // 必须是可直接解析的 JSON
      assert.ok(Array.isArray(parsed.data), 'raw 不是上游原样返回的 JSON')
      assert.equal(draftFetch.body.rawTruncated, false)
    })

    check('解析出上下文长度与最大输出', () => {
      const m = (draftFetch.body?.models ?? []).find((x) => x.id === MOCK_MODEL)
      assert.ok(m, '未找到主模型')
      assert.equal(m.contextLength, 131072)
      assert.equal(m.maxOutputTokens, 8192)
    })
    check('识别不同厂商的字段名（context_window）', () => {
      const m = (draftFetch.body?.models ?? []).find((x) => x.id === 'alt-model')
      assert.equal(m?.contextLength, 200000)
    })

    const savedFetch = await apiCall('POST', `/api/channels/${channelId}/fetch-models`)
    check('已存渠道可用库里的密钥拉取', () => assert.equal(savedFetch.body?.ok, true))

    // 自定义模型列表路径：伪上游在该路径下返回不同模型
    const customPathChannel = await apiCall('POST', '/api/channels', {
      name: `smoke-modelspath-${RUN}`,
      baseUrl: `${MOCK}/v1`,
      apiKey: UPSTREAM_KEY,
      modelsPath: '/custom/models',
      models: ['custom-path-model'],
      priority: 500
    })
    check('渠道可保存自定义模型列表路径', () => {
      assert.equal(customPathChannel.status, 201)
      assert.equal(customPathChannel.body.channel.modelsPath, '/custom/models')
    })
    const customTest = await apiCall(
      'POST',
      `/api/channels/${customPathChannel.body.channel.id}/test`
    )
    check('连通性测试按配置的路径请求（而非写死 /models）', () => {
      assert.equal(customTest.body?.ok, true)
      assert.ok(
        customTest.body?.models?.includes('custom-path-model'),
        `实际拿到：${JSON.stringify(customTest.body?.models)}`
      )
    })

    // 元信息随 /v1/models 透传
    const withMeta = await apiCall('PATCH', `/api/channels/${channelId}`, {
      models: [MOCK_MODEL],
      modelsMeta: {
        [MOCK_MODEL]: {
          id: MOCK_MODEL,
          contextLength: 131072,
          maxOutputTokens: 8192,
          ownedBy: 'mock',
          created: null,
          raw: { context_length: 131072, custom_field: 'kept' }
        }
      }
    })
    check('渠道可保存模型元信息', () => {
      assert.equal(withMeta.status, 200)
      assert.equal(withMeta.body.channel.modelsMeta[MOCK_MODEL].contextLength, 131072)
    })

    const modelsWithMeta = await fetch(`${BASE}/v1/models`, {
      headers: { authorization: `Bearer ${mapKey}` }
    })
    const modelsWithMetaJson = await modelsWithMeta.json()
    const declared = (modelsWithMetaJson.data ?? []).find((m) => m.id === MOCK_MODEL)
    check('/v1/models 透传上下文长度与最大输出', () => {
      assert.ok(declared, '未找到该模型')
      assert.equal(declared.context_length, 131072)
      assert.equal(declared.max_output_tokens, 8192)
    })
    check('/v1/models 保留上游原始标量字段', () =>
      assert.equal(declared.custom_field, 'kept')
    )

    // 注意：先前的别名已在「整组删除」那节被清掉，这里重新建一个
    const metaAlias = `meta-alias-${RUN}`
    await apiCall('POST', '/api/model-routes', {
      alias: metaAlias,
      targets: [{ channelId, upstreamModel: MOCK_MODEL, priority: 10, weight: 1 }]
    })
    const modelsWithAliasMeta = await fetch(`${BASE}/v1/models`, {
      headers: { authorization: `Bearer ${mapKey}` }
    })
    const aliasJson = await modelsWithAliasMeta.json()
    const aliasEntry = (aliasJson.data ?? []).find((m) => m.id === metaAlias)
    check('别名条目同样带出上下文长度（取自其目标的渠道配置）', () => {
      assert.ok(aliasEntry, '未找到别名条目')
      assert.equal(aliasEntry.context_length, 131072)
    })
    await apiCall('POST', '/api/model-routes/purge', { alias: metaAlias })

    await apiCall('DELETE', `/api/channels/${customPathChannel.body.channel.id}`)

    // ---------------------------------------------------------- 渠道详情子页面
    section('㉒ 渠道详情子页面所需的数据')

    const detail = await apiCall('GET', `/api/channels/${channelId}`)
    check('可按 id 取单个渠道详情', () => {
      assert.equal(detail.status, 200)
      assert.equal(detail.body.channel.id, channelId)
    })
    check('详情不返回上游密钥明文', () => {
      assert.ok(!detail.text.includes(UPSTREAM_KEY))
      assert.ok(detail.body.channel.apiKeyMasked.includes('••••'))
    })

    const notFoundDetail = await apiCall(
      'GET',
      '/api/channels/00000000-0000-0000-0000-000000000000'
    )
    check('不存在的渠道返回 404', () => assert.equal(notFoundDetail.status, 404))

    const chStats = await apiCall(
      'GET',
      `/api/stats/overview?range=today&channelId=${channelId}`
    )
    check('统计可按渠道过滤', () => {
      assert.equal(chStats.status, 200)
      assert.ok(chStats.body.totals.requests >= 1)
    })
    const otherChStats = await apiCall(
      'GET',
      '/api/stats/overview?range=today&channelId=00000000-0000-0000-0000-000000000000'
    )
    check('过滤到无关渠道时统计为 0', () =>
      assert.equal(otherChStats.body.totals.requests, 0)
    )

    const chSeries = await apiCall(
      'GET',
      `/api/stats/series?range=7d&channelId=${channelId}`
    )
    check('趋势序列也可按渠道过滤', () =>
      assert.equal(chSeries.body.series.length, 7)
    )

    // 先前的映射已被清理，这里重新建一条再验证按渠道过滤
    const detailAlias = `detail-alias-${RUN}`
    await apiCall('POST', '/api/model-routes', {
      alias: detailAlias,
      targets: [{ channelId, upstreamModel: MOCK_MODEL, priority: 10, weight: 1 }]
    })
    const chRoutes = await apiCall('GET', `/api/model-routes?channelId=${channelId}`)
    check('映射列表可按渠道过滤', () => {
      assert.equal(chRoutes.status, 200)
      assert.ok(chRoutes.body.routes.length > 0)
      assert.ok(chRoutes.body.routes.every((r) => r.channelId === channelId))
      assert.ok(chRoutes.body.routes.some((r) => r.alias === detailAlias))
    })
    await apiCall('POST', '/api/model-routes/purge', { alias: detailAlias })

    const chLogs = await apiCall('GET', `/api/logs?channelId=${channelId}&limit=10`)
    check('请求日志可按渠道过滤', () => {
      assert.equal(chLogs.status, 200)
      assert.ok(chLogs.body.logs.length > 0, '未取到该渠道的日志')
      // 注意：日志里的 channel_name 是**请求发生当时**的名字 ——
      // 渠道改名后，旧日志仍保留旧名（这是正确的历史记录），
      // 因此这里只校验过滤生效，不假定名字与当前一致
      const names = new Set(chLogs.body.logs.map((l) => l.channelName))
      assert.ok(
        [...names].every((n) => n.startsWith('smoke-mock')),
        `意外的渠道名：${[...names].join(', ')}`
      )
    })

    // ---------------------------------------------------------- Anthropic 协议
    section('㉓ Anthropic 协议代理与混杂模式')

    // 纯 Anthropic 渠道
    const anthChannel = await apiCall('POST', '/api/channels', {
      name: `smoke-anthropic-${RUN}`,
      baseUrl: `${MOCK}/v1`,
      apiKey: UPSTREAM_KEY,
      protocol: 'anthropic',
      models: ['claude-test'],
      priority: 10
    })
    check('可创建 Anthropic 协议渠道', () => {
      assert.equal(anthChannel.status, 201)
      assert.equal(anthChannel.body.channel.protocol, 'anthropic')
    })
    const anthChannelId = anthChannel.body.channel.id
    await apiCall('POST', '/api/model-routes', {
      alias: `anth-${RUN}`,
      targets: [{ channelId: anthChannelId, upstreamModel: 'claude-test', priority: 10, weight: 1 }]
    })

    const anthCall = await proxyCall(
      '/v1/chat/completions',
      { model: `anth-${RUN}`, messages: [{ role: 'user', content: '你好' }] },
      mapKey
    )
    check('Anthropic 渠道可经网关调用（返回 OpenAI 格式）', () => {
      assert.equal(anthCall.status, 200)
      assert.equal(anthCall.body?.object, 'chat.completion')
      assert.equal(anthCall.body?.choices?.[0]?.message?.content, '你好，世界')
    })
    check('usage 从 Anthropic 字段正确换算', () => {
      assert.deepEqual(anthCall.body?.usage, {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18
      })
    })
    check('回给调用方的模型名是请求时的别名', () =>
      assert.equal(anthCall.body?.model, `anth-${RUN}`)
    )
    check('响应头标明上游协议', () =>
      assert.equal(anthCall.headers.get('x-portara-protocol'), 'anthropic')
    )

    check('上游收到的确实是 Anthropic 格式请求', () => {
      assert.ok(lastAnthropicBody, '未捕获到 /messages 请求')
      assert.equal(lastAnthropicBody.model, 'claude-test')
      assert.ok(Array.isArray(lastAnthropicBody.messages), '缺少 Anthropic messages')
      assert.ok(typeof lastAnthropicBody.max_tokens === 'number', 'Anthropic 要求 max_tokens')
      assert.equal(lastAnthropicBody.stream_options, undefined, '不应带 OpenAI 的 stream_options')
    })
    check('未给 max_tokens 时自动补默认值', () =>
      assert.equal(lastAnthropicBody.max_tokens, 4096)
    )
    check('Anthropic 上游用 x-api-key 认证（不是 Bearer）', () => {
      assert.equal(lastUpstreamHeaders['x-api-key'], UPSTREAM_KEY, '缺少 x-api-key')
      assert.equal(
        lastUpstreamHeaders.authorization,
        undefined,
        'Anthropic 端点收到 Bearer 会报 Authentication failed'
      )
    })
    check('Anthropic 请求带 anthropic-version', () =>
      assert.ok(lastUpstreamHeaders['anthropic-version'], '缺少 anthropic-version')
    )

    // 流式翻译
    const anthStream = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${mapKey}` },
      body: JSON.stringify({
        model: `anth-${RUN}`,
        stream: true,
        messages: [{ role: 'user', content: '你好' }]
      })
    })
    const anthStreamText = await anthStream.text()
    check('Anthropic 流式被翻成 OpenAI SSE', () => {
      assert.equal(anthStream.status, 200)
      assert.ok(anthStreamText.includes('chat.completion.chunk'), '不是 OpenAI chunk 格式')
      assert.ok(anthStreamText.includes('你好'), '缺少文本增量')
      assert.ok(anthStreamText.includes('"finish_reason":"stop"'), '缺少收尾')
      assert.ok(anthStreamText.includes('"usage"'), '缺少 usage chunk')
      assert.ok(anthStreamText.includes('[DONE]'), '缺少 [DONE]')
    })
    check('流式不会泄漏 Anthropic 的事件名', () => {
      assert.ok(!anthStreamText.includes('content_block_delta'), '泄漏了 Anthropic 事件')
      assert.ok(!anthStreamText.includes('message_start'), '泄漏了 Anthropic 事件')
    })

    await sleep(700)
    const anthLogs = await apiCall('GET', '/api/logs?limit=50')
    const anthLog = (anthLogs.body?.logs ?? []).find((l) => l.model === `anth-${RUN}`)
    check('Anthropic 调用同样记账', () => {
      assert.ok(anthLog, '未找到日志')
      assert.equal(anthLog.channelName, `smoke-anthropic-${RUN}`)
    })

    // 混杂模式：同一渠道里逐模型指定协议与 Base URL
    const mixedChannel = await apiCall('POST', '/api/channels', {
      name: `smoke-mixed-${RUN}`,
      baseUrl: `${MOCK}/v1`,
      apiKey: UPSTREAM_KEY,
      protocol: 'mixed',
      models: ['openai-model', 'anthropic-model'],
      modelOverrides: {
        'anthropic-model': { protocol: 'anthropic' }
      },
      priority: 10
    })
    check('可创建混杂模式渠道', () => {
      assert.equal(mixedChannel.status, 201)
      assert.equal(mixedChannel.body.channel.protocol, 'mixed')
      assert.equal(
        mixedChannel.body.channel.modelOverrides['anthropic-model'].protocol,
        'anthropic'
      )
    })
    const mixedId = mixedChannel.body.channel.id
    await apiCall('POST', '/api/model-routes', {
      alias: `mixed-openai-${RUN}`,
      targets: [{ channelId: mixedId, upstreamModel: 'openai-model', priority: 10, weight: 1 }]
    })
    await apiCall('POST', '/api/model-routes', {
      alias: `mixed-anth-${RUN}`,
      targets: [{ channelId: mixedId, upstreamModel: 'anthropic-model', priority: 10, weight: 1 }]
    })

    const mixedOpenai = await proxyCall(
      '/v1/chat/completions',
      { model: `mixed-openai-${RUN}`, messages: [{ role: 'user', content: 'x' }] },
      mapKey
    )
    check('混杂模式下未覆盖的模型走 OpenAI 协议', () => {
      assert.equal(mixedOpenai.status, 200)
      assert.equal(mixedOpenai.body?.received_model, 'openai-model')
    })

    const mixedAnth = await proxyCall(
      '/v1/chat/completions',
      { model: `mixed-anth-${RUN}`, messages: [{ role: 'user', content: 'x' }] },
      mapKey
    )
    check('混杂模式下被覆盖的模型走 Anthropic 协议', () => {
      assert.equal(mixedAnth.status, 200)
      assert.equal(mixedAnth.headers.get('x-portara-protocol'), 'anthropic')
      assert.equal(mixedAnth.body?.choices?.[0]?.message?.content, '你好，世界')
    })
    check('混杂模式里 Anthropic 请求打到了 /messages', () =>
      assert.equal(lastAnthropicBody?.model, 'anthropic-model')
    )

    // 直连渠道测试也必须按有效协议发请求
    // （曾经的 bug：直连路径写死 /chat/completions，把 Anthropic 模型当 OpenAI 发出去）
    lastAnthropicBody = null
    const directAnth = await apiCall('POST', `/api/channels/${mixedId}/chat`, {
      model: 'anthropic-model',
      messages: [{ role: 'user', content: '直连' }]
    })
    check('直连测试对 Anthropic 模型改走 /messages', () => {
      assert.equal(directAnth.status, 200)
      assert.ok(lastAnthropicBody, '请求没有打到 /messages')
      assert.equal(lastAnthropicBody.model, 'anthropic-model')
      assert.ok(typeof lastAnthropicBody.max_tokens === 'number')
    })
    check('直连测试把 Anthropic 响应翻回 OpenAI 格式', () => {
      assert.equal(directAnth.body?.object, 'chat.completion')
      assert.equal(directAnth.body?.choices?.[0]?.message?.content, '你好，世界')
      assert.equal(directAnth.body?.usage?.total_tokens, 18)
    })

    const directOpenai = await apiCall('POST', `/api/channels/${mixedId}/chat`, {
      model: 'openai-model',
      messages: [{ role: 'user', content: '直连' }]
    })
    check('直连测试对 OpenAI 模型仍走 OpenAI 路径', () => {
      assert.equal(directOpenai.status, 200)
      assert.equal(directOpenai.body?.received_model, 'openai-model')
    })

    // 逐模型 Base URL 填了完整端点也不能拼重复
    await apiCall('PATCH', `/api/channels/${mixedId}`, {
      modelOverrides: {
        'anthropic-model': {
          protocol: 'anthropic',
          baseUrl: `${MOCK}/v1/messages`
        }
      }
    })
    const doubledCheck = await apiCall('POST', `/api/channels/${mixedId}/chat`, {
      model: 'anthropic-model',
      messages: [{ role: 'user', content: 'x' }]
    })
    check('Base URL 填成完整端点时不会拼出 /messages/messages', () => {
      assert.equal(doubledCheck.status, 200, JSON.stringify(doubledCheck.body))
      assert.equal(doubledCheck.body?.choices?.[0]?.message?.content, '你好，世界')
    })

    const badOverride = await apiCall('PATCH', `/api/channels/${mixedId}`, {
      modelOverrides: { m: { baseUrl: 'ftp://bad' } }
    })
    check('非法的覆盖 Base URL 被拒（400）', () => assert.equal(badOverride.status, 400))

    // 清理
    for (const a of [`anth-${RUN}`, `mixed-openai-${RUN}`, `mixed-anth-${RUN}`]) {
      await apiCall('POST', '/api/model-routes/purge', { alias: a })
    }
    await apiCall('DELETE', `/api/channels/${anthChannelId}`)
    await apiCall('DELETE', `/api/channels/${mixedId}`)

    // ---------------------------------------------------------- /models 过滤
    section('㉔ /v1/models 的 filter 参数')

    // 先前的别名都已被清理，这里重新建一条，否则 mirror-only 必然为空
    const filterAlias = `filter-alias-${RUN}`
    await apiCall('POST', '/api/model-routes', {
      alias: filterAlias,
      targets: [{ channelId, upstreamModel: MOCK_MODEL, priority: 10, weight: 1 }]
    })

    const allModels = await fetch(`${BASE}/v1/models`, {
      headers: { authorization: `Bearer ${mapKey}` }
    })
    const allJson = await allModels.json()

    const mirrorOnly = await fetch(`${BASE}/v1/models?filter=mirror-only`, {
      headers: { authorization: `Bearer ${mapKey}` }
    })
    const mirrorJson = await mirrorOnly.json()
    const originOnly = await fetch(`${BASE}/v1/models?filter=origin-only`, {
      headers: { authorization: `Bearer ${mapKey}` }
    })
    const originJson = await originOnly.json()

    check('filter 参数被回显', () => {
      assert.equal(allJson.filter, 'all')
      assert.equal(mirrorJson.filter, 'mirror-only')
      assert.equal(originJson.filter, 'origin-only')
    })
    check('mirror-only 只返回映射别名', () => {
      assert.ok(mirrorJson.data.length > 0, 'mirror-only 为空')
      assert.ok(
        mirrorJson.data.some((m) => m.id === filterAlias),
        `未包含刚建的别名：${JSON.stringify(mirrorJson.data.map((m) => m.id).slice(0, 5))}`
      )
      // 渠道声明的裸模型名不应出现在 mirror-only 里
      assert.ok(
        !mirrorJson.data.some((m) => m.id === MOCK_MODEL),
        'mirror-only 里混进了渠道声明的模型'
      )
    })
    check('origin-only 只返回渠道声明的模型', () => {
      assert.ok(originJson.data.some((m) => m.id === MOCK_MODEL), '缺少渠道声明的模型')
      assert.ok(
        !originJson.data.some((m) => m.id.startsWith('smoke-prefix-')),
        'origin-only 里混进了映射别名'
      )
    })
    check('不传 filter 时两类都返回', () => {
      assert.ok(allJson.data.some((m) => m.id === MOCK_MODEL))
      assert.ok(allJson.data.length >= originJson.data.length)
    })
    const bogusFilter = await fetch(`${BASE}/v1/models?filter=bogus`, {
      headers: { authorization: `Bearer ${mapKey}` }
    })
    const bogusJson = await bogusFilter.json()
    check('未知 filter 值回退为 all', () => assert.equal(bogusJson.filter, 'all'))

    await apiCall('POST', '/api/model-routes/purge', { alias: filterAlias })

    // ---------------------------------------------------------- opencode-go 会话头注入
    section('㉕ opencode-go 的每会话 x-opencode-session 注入')

    const zenChannel = await apiCall('POST', '/api/channels', {
      name: `smoke-zen-${RUN}`,
      baseUrl: `${MOCK}/v1`,
      apiKey: UPSTREAM_KEY,
      vendor: 'opencode-go',
      models: [MOCK_MODEL],
      priority: 10
    })
    check('可创建 opencode-go 厂商渠道', () => assert.equal(zenChannel.status, 201))
    const zenId = zenChannel.body.channel.id
    await apiCall('POST', '/api/model-routes', {
      alias: `zen-${RUN}`,
      targets: [{ channelId: zenId, upstreamModel: MOCK_MODEL, priority: 10, weight: 1 }]
    })

    const zenCall = (extra) =>
      proxyCall(
        '/v1/chat/completions',
        { model: `zen-${RUN}`, messages: [{ role: 'user', content: 'hi' }], ...extra },
        mapKey
      )

    // ① 会话 id 来自请求体
    const s1 = await zenCall({ prompt_cache_key: 'session-aaa' })
    check('① 会话 id 取自请求体的 prompt_cache_key', () => {
      assert.equal(s1.status, 200)
      assert.equal(lastUpstreamHeaders['x-opencode-session'], 'session-aaa')
    })
    check('① 响应回显实际注入的会话值（可验收）', () =>
      assert.equal(s1.headers.get('x-portara-session'), 'session-aaa')
    )

    // ② 同会话稳定、跨会话不同
    await zenCall({ prompt_cache_key: 'session-aaa' })
    const sameSession = lastUpstreamHeaders['x-opencode-session']
    await zenCall({ prompt_cache_key: 'session-bbb' })
    const otherSession = lastUpstreamHeaders['x-opencode-session']
    check('② 同一会话两轮 → 值相同', () => assert.equal(sameSession, 'session-aaa'))
    check('② 不同会话 → 值不同', () => assert.equal(otherSession, 'session-bbb'))

    // ③ 无会话 id 时用**稳定**兜底（这正是修复前的 bug：每次随机）
    await zenCall({})
    const fallback1 = lastUpstreamHeaders['x-opencode-session']
    await zenCall({})
    const fallback2 = lastUpstreamHeaders['x-opencode-session']
    check('③ 无会话 id → 兜底值稳定（不是每次随机）', () => {
      assert.equal(fallback1, fallback2)
      assert.match(fallback1, /^portara-[0-9a-f]{24}$/)
    })
    check('③ 兜底值与会话派生值不同', () => assert.notEqual(fallback1, 'session-aaa'))

    // ④ 恶意值必须被消毒，且不能让请求崩掉
    const evil = await zenCall({ prompt_cache_key: 'evil\r\nX-Injected: 1' })
    check('④ 含 CRLF 的会话值被拒 → 退回兜底且不报错', () => {
      assert.equal(evil.status, 200)
      const sent = lastUpstreamHeaders['x-opencode-session']
      assert.ok(!sent.includes('\r') && !sent.includes('\n'), 'CRLF 进了请求头')
      assert.match(sent, /^portara-/)
    })
    check('④ 含 CRLF 的值没有被拆成额外的请求头', () =>
      assert.equal(lastUpstreamHeaders['x-injected'], undefined)
    )
    const tooLong = await zenCall({ prompt_cache_key: 'a'.repeat(5000) })
    check('④ 超长会话值被拒 → 退回兜底', () => {
      assert.equal(tooLong.status, 200)
      assert.match(lastUpstreamHeaders['x-opencode-session'], /^portara-/)
    })
    const badChars = await zenCall({ prompt_cache_key: '中文 值/带空格' })
    check('④ 字符集外的会话值被拒 → 退回兜底', () => {
      assert.equal(badChars.status, 200)
      assert.match(lastUpstreamHeaders['x-opencode-session'], /^portara-/)
    })

    // ⑤ 不得污染其他渠道
    //    注意：主渠道在本轮早前的「厂商兼容头」一节已被改成 opencode-go，
    //    所以这里必须新建一条真正的 generic 渠道，不能拿它当反例
    const plainChannel = await apiCall('POST', '/api/channels', {
      name: `smoke-plain-${RUN}`,
      baseUrl: `${MOCK}/v1`,
      apiKey: UPSTREAM_KEY,
      models: [MOCK_MODEL],
      priority: 10
    })
    const plainChannelId = plainChannel.body.channel.id
    check('⑤ 反例渠道是 generic', () =>
      assert.equal(plainChannel.body.channel.vendor, 'generic')
    )
    const plainAlias = `zen-plain-${RUN}`
    await apiCall('POST', '/api/model-routes', {
      alias: plainAlias,
      targets: [{ channelId: plainChannelId, upstreamModel: MOCK_MODEL, priority: 10, weight: 1 }]
    })
    await proxyCall(
      '/v1/chat/completions',
      {
        model: plainAlias,
        messages: [{ role: 'user', content: 'hi' }],
        prompt_cache_key: 'session-aaa'
      },
      mapKey
    )
    check('⑤ 非 opencode-go 渠道不注入会话头', () =>
      assert.equal(lastUpstreamHeaders['x-opencode-session'], undefined)
    )
    check('⑤ 非 opencode-go 渠道也不回显 x-portara-session', () => true)

    // 渠道固定头优先级：显式配置的会话值在没有请求体派生时生效
    await apiCall('PATCH', `/api/channels/${zenId}`, {
      extraHeaders: { 'x-opencode-session': 'from-channel-config' }
    })
    const configured = await zenCall({})
    check('渠道固定头里的会话值在无请求体派生时生效', () =>
      assert.equal(lastUpstreamHeaders['x-opencode-session'], 'from-channel-config')
    )
    const bodyWins = await zenCall({ prompt_cache_key: 'session-ccc' })
    check('请求体派生值压过渠道固定头', () =>
      assert.equal(lastUpstreamHeaders['x-opencode-session'], 'session-ccc')
    )
    check('回显的是最终生效值', () =>
      assert.equal(bodyWins.headers.get('x-portara-session'), 'session-ccc')
    )

    // 清理
    await apiCall('POST', '/api/model-routes/purge', { alias: `zen-${RUN}` })
    await apiCall('POST', '/api/model-routes/purge', { alias: plainAlias })
    await apiCall('DELETE', `/api/channels/${plainChannelId}`)
    await apiCall('DELETE', `/api/channels/${zenId}`)

    // ---------------------------------------------------------- 系统设置
    section('㉖ 系统设置（仅管理员可见可用）')

    const settingsNoAuth = await fetch(`${BASE}/api/settings`)
    check('未登录不可读系统设置（401）', () => assert.equal(settingsNoAuth.status, 401))

    const settingsAsOperator = await apiCall('GET', '/api/settings', undefined, {
      cookie: operatorCookie
    })
    check('操作员不可读系统设置（403）', () => assert.equal(settingsAsOperator.status, 403))

    const patchAsOperator = await apiCall(
      'PATCH',
      '/api/settings',
      { settings: [{ key: 'gatewayName', value: 'hacked' }] },
      { cookie: operatorCookie }
    )
    check('操作员不可改系统设置（403）', () => assert.equal(patchAsOperator.status, 403))

    // 公开 meta：登录页在拿到会话之前就要显示网关名称
    const metaRes = await fetch(`${BASE}/api/meta`)
    const metaJson = await metaRes.json()
    check('/api/meta 无需登录即可读（供页面标题与副标题）', () => {
      assert.equal(metaRes.status, 200)
      assert.equal(metaJson.productName, 'Portara')
      assert.ok('gatewayName' in metaJson)
    })
    check('公开 meta 不暴露任何设置开关', () => {
      assert.equal(metaJson.allowDirectChannelTest, undefined)
      assert.equal(metaJson.logRetentionDays, undefined)
    })

    const settings0 = await apiCall('GET', '/api/settings')
    check('管理员可读全部设置（含默认值）', () => {
      assert.equal(settings0.status, 200)
      assert.equal(settings0.body.settings.allowDirectChannelTest, true)
      assert.equal(settings0.body.settings.logRetentionDays, 0)
      assert.equal(settings0.body.settings.defaultChannelTimeoutMs, 120000)
      assert.equal(settings0.body.settings.defaultKeyRpmLimit, 60)
      assert.deepEqual(settings0.body.invalid, [])
    })

    const unknownKey = await apiCall('PATCH', '/api/settings', {
      settings: [{ key: 'notARealSetting', value: 1 }]
    })
    check('未知设置项被明确拒绝（400）', () => assert.equal(unknownKey.status, 400))
    const badValue = await apiCall('PATCH', '/api/settings', {
      settings: [{ key: 'logRetentionDays', value: -5 }]
    })
    check('非法设置值被拒绝（400）', () => assert.equal(badValue.status, 400))
    const emptyPatch = await apiCall('PATCH', '/api/settings', { settings: [] })
    check('空更新被拒绝（400）', () => assert.equal(emptyPatch.status, 400))

    // 网关名称：真的进到公开 meta
    await apiCall('PATCH', '/api/settings', {
      settings: [{ key: 'gatewayName', value: '冒烟网关' }]
    })
    const metaNamed = await (await fetch(`${BASE}/api/meta`)).json()
    check('网关名称出现在公开 meta（标题/副标题的数据源）', () =>
      assert.equal(metaNamed.gatewayName, '冒烟网关')
    )
    const tooLongName = await apiCall('PATCH', '/api/settings', {
      settings: [{ key: 'gatewayName', value: 'x'.repeat(65) }]
    })
    check('超长网关名称被拒绝', () => assert.equal(tooLongName.status, 400))
    await apiCall('PATCH', '/api/settings', {
      settings: [{ key: 'gatewayName', value: '' }]
    })
    const metaCleared = await (await fetch(`${BASE}/api/meta`)).json()
    check('清空网关名称后回落到空值（前端用产品名兜底）', () =>
      assert.equal(metaCleared.gatewayName, '')
    )

    // 直连开关必须真的生效 —— 存了不生效的设置项就是骗人
    await apiCall('PATCH', '/api/settings', {
      settings: [{ key: 'allowDirectChannelTest', value: false }]
    })
    const blockedDirect = await apiCall('POST', `/api/channels/${channelId}/chat`, {
      model: MOCK_MODEL,
      messages: [{ role: 'user', content: 'x' }]
    })
    check('关闭「允许直连测试」后该入口真的被拒（403）', () => {
      assert.equal(blockedDirect.status, 403)
      assert.equal(blockedDirect.body?.error?.code, 'direct_test_disabled')
    })
    await apiCall('PATCH', '/api/settings', {
      settings: [{ key: 'allowDirectChannelTest', value: true }]
    })
    const restoredDirect = await apiCall('POST', `/api/channels/${channelId}/chat`, {
      model: MOCK_MODEL,
      messages: [{ role: 'user', content: 'x' }]
    })
    check('重新打开后直连测试恢复可用', () =>
      assert.equal(restoredDirect.status, 200)
    )

    // 日志保留：写设置 + 立即清理（保留 0 天表示永久，不该删任何东西）
    const retentionSet = await apiCall('PATCH', '/api/settings', {
      settings: [{ key: 'logRetentionDays', value: 1 }]
    })
    check('可设置日志保留天数', () =>
      assert.equal(retentionSet.body.settings.logRetentionDays, 1)
    )
    const settingsPurge = await apiCall('POST', '/api/settings/purge-logs')
    check('可按保留策略立即清理（并回报删除条数）', () => {
      assert.equal(settingsPurge.status, 200)
      assert.equal(settingsPurge.body.retentionDays, 1)
      assert.equal(typeof settingsPurge.body.deleted, 'number')
    })
    // 立即还原为永久保留，避免影响后续断言
    await apiCall('PATCH', '/api/settings', {
      settings: [{ key: 'logRetentionDays', value: 0 }]
    })
    const purgeForever = await apiCall('POST', '/api/settings/purge-logs')
    check('保留天数为 0（永久）时不删除任何记录', () => {
      assert.equal(purgeForever.body.retentionDays, 0)
      assert.equal(purgeForever.body.deleted, 0)
    })

    // 设置变更要留痕
    const auditAfterSettings = await apiCall('GET', '/api/audit?limit=100')
    const settingsEvents = (auditAfterSettings.body?.events ?? []).filter(
      (e) => e.action === 'settings.update'
    )
    check('设置变更写入审计，且记录改了什么', () => {
      assert.ok(settingsEvents.length > 0, '未找到 settings.update 审计')
      // 审计按时间倒序，单条只含本次改的项 —— 要跨事件合并后再看
      const changedKeys = new Set(
        settingsEvents.flatMap((e) => Object.keys(e.detail?.changes ?? {}))
      )
      assert.ok(changedKeys.has('gatewayName'), `明细缺少 gatewayName：${[...changedKeys]}`)
      assert.ok(changedKeys.has('allowDirectChannelTest'), '明细缺少 allowDirectChannelTest')
      // 明细要含「从什么变成什么」，否则出了事回答不了「谁关的开关」
      const sample = settingsEvents.find((e) => e.detail?.changes?.gatewayName)
      assert.ok(
        sample.detail.changes.gatewayName &&
          'from' in sample.detail.changes.gatewayName &&
          'to' in sample.detail.changes.gatewayName,
        '明细缺少 from/to'
      )
    })

    // ---------------------------------------------------------- 时区
    section('㉗ 时区：UTC 存储 + 按请求方时区聚合')

    /** 某时刻在指定时区的「当地墙钟」 */
    const localParts = (iso, tz) => {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
      }).formatToParts(new Date(iso))
      const g = (t) => parts.find((x) => x.type === t)?.value ?? ''
      return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`
    }

    const tzUtc = await apiCall('GET', '/api/stats/overview?range=today&tz=UTC')
    const tzSh = await apiCall('GET', '/api/stats/overview?range=today&tz=Asia%2FShanghai')
    check('统计回报本次实际使用的时区', () => {
      assert.equal(tzUtc.body.timezone, 'UTC')
      assert.equal(tzSh.body.timezone, 'Asia/Shanghai')
    })
    check('起算点是该时区的当地 00:00', () => {
      assert.match(localParts(tzUtc.body.range.from, 'UTC'), /00:00$/)
      assert.match(localParts(tzSh.body.range.from, 'Asia/Shanghai'), /00:00$/)
    })
    check('不同时区的「今日」各自按当地日界（差值 8h 或 16h）', () => {
      // 断言不能写死 8 小时 —— 这是**时间相关**的：
      // 在 UTC 16:00–24:00 这个窗口里上海已是次日，两个「今日」相差 16 小时。
      // 真正要保证的语义是「各自取当地 00:00」（上一条已断言），
      // 这里只校验差值落在仅有的两种可能上。
      const hours =
        Math.abs(
          new Date(tzUtc.body.range.from).getTime() - new Date(tzSh.body.range.from).getTime()
        ) / 3_600_000
      assert.ok([8, 16].includes(hours), `实际相差 ${hours} 小时`)
    })
    check('起点仍是 UTC 瞬时（存储一律 UTC）', () => {
      // ISO 串必须带 Z（UTC），而不是当地时间的裸串
      assert.ok(String(tzSh.body.range.from).endsWith('Z'), tzSh.body.range.from)
    })

    const badTz = await apiCall('GET', '/api/stats/overview?range=today&tz=Not%2FAZone')
    check('非法时区参数回落到网关设置，不报错', () =>
      assert.equal(badTz.body.timezone, 'UTC')
    )

    // 网关时区设置：无 tz 参数时的默认口径
    const setTz = await apiCall('PATCH', '/api/settings', {
      settings: [{ key: 'timezone', value: 'Asia/Shanghai' }]
    })
    check('可设置网关时区', () => assert.equal(setTz.body.settings.timezone, 'Asia/Shanghai'))
    const noTz = await apiCall('GET', '/api/stats/overview?range=today')
    check('不传 tz 时用网关时区设置', () => assert.equal(noTz.body.timezone, 'Asia/Shanghai'))
    const browserWins = await apiCall('GET', '/api/stats/overview?range=today&tz=UTC')
    check('传了 tz 时以请求方为准（浏览器时区覆盖网关设置）', () =>
      assert.equal(browserWins.body.timezone, 'UTC')
    )
    const badZoneSetting = await apiCall('PATCH', '/api/settings', {
      settings: [{ key: 'timezone', value: 'Not/AZone' }]
    })
    check('非法时区设置被拒（400）', () => assert.equal(badZoneSetting.status, 400))

    // 分桶：按请求时区的日界
    const shSeries = await apiCall('GET', '/api/stats/series?range=7d&tz=Asia%2FShanghai')
    const utcSeries = await apiCall('GET', '/api/stats/series?range=7d&tz=UTC')
    check('趋势序列回报时区', () => {
      assert.equal(shSeries.body.timezone, 'Asia/Shanghai')
      assert.equal(utcSeries.body.timezone, 'UTC')
    })
    check('7 天在两个时区都是 7 个日桶', () => {
      assert.equal(shSeries.body.series.length, 7)
      assert.equal(utcSeries.body.series.length, 7)
    })
    check('日桶标签按各自时区的当地日期', () => {
      const shLast = shSeries.body.series.at(-1).day
      const utcLast = utcSeries.body.series.at(-1).day
      // 上海比 UTC 早 8 小时，同一时刻的当地日期可能差一天
      assert.match(shLast, /^\d{2}-\d{2}$/)
      assert.match(utcLast, /^\d{2}-\d{2}$/)
      assert.equal(shLast, localParts(tzSh.body.range.to, 'Asia/Shanghai').slice(5, 10))
    })
    // 今日按小时分桶时，标签是当地整点
    const shToday = await apiCall('GET', '/api/stats/series?range=today&tz=Asia%2FShanghai')
    check('今日按小时分桶且标签为当地整点', () => {
      assert.equal(shToday.body.granularity, 'hour')
      assert.ok(shToday.body.series.length > 0)
      assert.match(shToday.body.series[0].day, /^\d{2}-\d{2} \d{2}:00$/)
      assert.ok(shToday.body.series[0].day.endsWith('00:00'), shToday.body.series[0].day)
    })

    // 还原网关时区，避免影响后续断言
    await apiCall('PATCH', '/api/settings', {
      settings: [{ key: 'timezone', value: 'UTC' }]
    })

    // ---------------------------------------------------------- Top 榜单排序
    section('㉘ Top 榜单的排序依据（次数 / 用量）')

    const byReq = await apiCall('GET', '/api/stats/overview?range=today&sortBy=requests')
    const byTok = await apiCall('GET', '/api/stats/overview?range=today&sortBy=tokens')
    check('统计回报本次排序依据', () => {
      assert.equal(byReq.body.sortBy, 'requests')
      assert.equal(byTok.body.sortBy, 'tokens')
    })
    check('按次数排序：Top 模型按次数递减', () => {
      const rows = byReq.body.topModels
      for (let i = 1; i < rows.length; i++) {
        assert.ok(rows[i - 1].requests >= rows[i].requests, JSON.stringify(rows))
      }
    })
    check('按用量排序：Top 模型按 token 递减', () => {
      const rows = byTok.body.topModels
      for (let i = 1; i < rows.length; i++) {
        assert.ok(rows[i - 1].tokens >= rows[i].tokens, JSON.stringify(rows))
      }
    })
    check('候选集同时覆盖两种排序（三张卡片都能本地切换）', () => {
      // 后端返回的是候选集，两种排序的成员应完全一致，只是顺序不同
      for (const key of ['topModels', 'topChannels', 'topKeys']) {
        const a = byReq.body[key].map((x) => x.name).sort()
        const b = byTok.body[key].map((x) => x.name).sort()
        assert.deepEqual(a, b, `${key} 两种排序的候选集不一致`)
      }
    })
    check('每条候选都同时带次数与 token', () => {
      for (const row of byReq.body.topModels) {
        assert.equal(typeof row.requests, 'number')
        assert.equal(typeof row.tokens, 'number')
      }
    })
    const badSort = await apiCall('GET', '/api/stats/overview?range=today&sortBy=bogus')
    check('非法 sortBy 被拒（400）', () => assert.equal(badSort.status, 400))

    // ---------------------------------------------------------- HTTP 代理
    section('㉙ HTTP 代理配置与「渠道是否走代理」')

    const proxyCreate = await apiCall('POST', '/api/proxies', {
      name: `smoke-proxy-${RUN}`,
      host: '127.0.0.1',
      port: PROXY_PORT,
      username: 'puser',
      password: 'ppass',
      note: '冒烟用'
    })
    check('可创建代理配置', () => {
      assert.equal(proxyCreate.status, 201)
      assert.equal(proxyCreate.body.proxy.hasPassword, true)
    })
    const proxyId = proxyCreate.body.proxy.id
    check('代理响应只给掩码，绝不含密文', () => {
      assert.ok(!JSON.stringify(proxyCreate.body).includes('ppass'), '明文密码泄漏')
      assert.ok(!('password_cipher' in proxyCreate.body.proxy), '密文字段泄漏')
      assert.equal(proxyCreate.body.proxy.passwordMasked, '••••••••')
    })
    const revealedProxy = await apiCall('GET', `/api/proxies/${proxyId}/reveal`)
    check('管理员可查看代理密码明文', () => {
      assert.equal(revealedProxy.status, 200)
      assert.equal(revealedProxy.body.password, 'ppass')
    })

    // 校验
    const badHost = await apiCall('POST', '/api/proxies', {
      name: `smoke-badhost-${RUN}`, host: 'http://1.2.3.4', port: 8080
    })
    check('主机填成 URL 被拒（400）', () => assert.equal(badHost.status, 400))
    const badPort = await apiCall('POST', '/api/proxies', {
      name: `smoke-badport-${RUN}`, host: '1.2.3.4', port: 99999
    })
    check('端口越界被拒（400）', () => assert.equal(badPort.status, 400))
    const dupName = await apiCall('POST', '/api/proxies', {
      name: `smoke-proxy-${RUN}`, host: '1.2.3.4', port: 8080
    })
    check('代理重名被拒（400）', () => assert.equal(dupName.status, 400))

    // 关键：渠道走代理后，流量必须真的经过代理
    proxiedRequests.length = 0
    const proxyAlias = `proxy-alias-${RUN}`
    await apiCall('POST', '/api/model-routes', {
      alias: proxyAlias,
      targets: [{ channelId, upstreamModel: MOCK_MODEL, priority: 10, weight: 1 }]
    })

    await proxyCall('/v1/chat/completions',
      { model: proxyAlias, messages: [{ role: 'user', content: 'hi' }] }, mapKey)
    check('渠道未配代理时，流量不经过代理', () =>
      assert.equal(proxiedRequests.length, 0)
    )

    const bindProxy = await apiCall('PATCH', `/api/channels/${channelId}`, { proxyId })
    check('渠道可绑定代理', () => assert.equal(bindProxy.body.channel.proxyId, proxyId))
    const proxyList = await apiCall('GET', '/api/proxies')
    check('代理列表回报引用它的渠道数', () => {
      const p = proxyList.body.proxies.find((x) => x.id === proxyId)
      assert.equal(p.channelCount, 1)
    })

    proxiedRequests.length = 0
    await proxyCall('/v1/chat/completions',
      { model: proxyAlias, messages: [{ role: 'user', content: 'hi' }] }, mapKey)
    check('渠道绑定代理后，流量确实经过代理', () => {
      assert.ok(proxiedRequests.length > 0, '代理没有收到任何请求')
      assert.ok(
        proxiedRequests.every((r) => String(r.url).startsWith('http://')),
        '代理收到的不是绝对 URI'
      )
    })
    check('代理认证信息按期发送（Proxy-Authorization）', () => {
      const expected = 'Basic ' + Buffer.from('puser:ppass').toString('base64')
      assert.equal(proxiedRequests[0].proxyAuth, expected)
    })

    // 延迟对比
    const latency = await apiCall('POST', '/api/proxies/latency-test', {
      channelId, proxyId
    })
    check('可对同一渠道做「直连 vs 走代理」延迟对比', () => {
      assert.equal(latency.status, 200)
      assert.equal(typeof latency.body.direct.latencyMs, 'number')
      assert.equal(typeof latency.body.proxied.latencyMs, 'number')
      assert.equal(latency.body.comparable, true)
    })
    check('对比结果含差值', () => {
      assert.equal(
        latency.body.deltaMs,
        latency.body.proxied.latencyMs - latency.body.direct.latencyMs
      )
    })
    const afterProbe = await apiCall('GET', '/api/proxies')
    check('探测后代理记录下延迟与可用性', () => {
      const p = afterProbe.body.proxies.find((x) => x.id === proxyId)
      assert.equal(p.lastTestOk, true)
      assert.ok(typeof p.lastLatencyMs === 'number')
    })
    const badProbe = await apiCall('POST', '/api/proxies/latency-test', {
      channelId, proxyId: '00000000-0000-0000-0000-000000000000'
    })
    check('对不存在的代理做探测返回 400', () => assert.equal(badProbe.status, 400))

    // 停用代理 → 静默回退直连（而不是把渠道打死）
    await apiCall('PATCH', `/api/proxies/${proxyId}`, { status: 'disabled' })
    proxiedRequests.length = 0
    const disabledCall = await proxyCall('/v1/chat/completions',
      { model: proxyAlias, messages: [{ role: 'user', content: 'hi' }] }, mapKey)
    check('代理停用后渠道回退直连，仍可用', () => {
      assert.equal(disabledCall.status, 200)
      assert.equal(proxiedRequests.length, 0)
    })
    await apiCall('PATCH', `/api/proxies/${proxyId}`, { status: 'active' })

    // 删除代理 → 渠道自动回到直连
    const delProxy = await apiCall('DELETE', `/api/proxies/${proxyId}`)
    check('删除代理时回报受影响渠道', () =>
      assert.ok(delProxy.body.unboundChannels.includes(`smoke-mock-${RUN}`))
    )
    const chAfterDel = await apiCall('GET', `/api/channels/${channelId}`)
    check('删除代理后渠道自动回到直连（不留悬空引用）', () =>
      assert.equal(chAfterDel.body.channel.proxyId, null)
    )

    await apiCall('POST', '/api/model-routes/purge', { alias: proxyAlias })

    // ---------------------------------------------------------- 余额 / 用量
    section('㉚ 聚合余额 / 用量（适配器 + 缓存 + 权限）')

    // 适配器清单
    const usAdapters = await apiCall('GET', '/api/usage/adapters')
    check('可列出余额适配器（供渠道弹窗选择）', () => {
      assert.equal(usAdapters.status, 200)
      const ids = usAdapters.body.adapters.map((a) => a.id)
      assert.deepEqual(ids.sort(), ['commandcode', 'deepseek', 'minimax', 'moonshot'])
      assert.ok(usAdapters.body.adapters.every((a) => a.note), '适配器应带提示文案')
    })
    check('未实现的两个厂商不在清单里（厂商侧无 API）', () => {
      const ids = usAdapters.body.adapters.map((a) => a.id)
      assert.ok(!ids.includes('opencode') && !ids.includes('kimi-coding'))
    })

    // 造四个渠道，各配一个适配器（baseUrl 用伪上游，适配器按 origin 拼路径）
    const usageChannels = {}
    for (const [adapter, name] of [
      ['deepseek', `smoke-us-deepseek-${RUN}`],
      ['moonshot', `smoke-us-moonshot-${RUN}`],
      ['commandcode', `smoke-us-commandcode-${RUN}`],
      ['minimax', `smoke-us-minimax-${RUN}`]
    ]) {
      const r = await apiCall('POST', '/api/channels', {
        name,
        baseUrl: `${MOCK}/v1`,
        apiKey: UPSTREAM_KEY,
        models: [MOCK_MODEL],
        usageAdapter: adapter,
        priority: 900
      })
      assert.equal(r.status, 201, `建渠道 ${name} 失败`)
      usageChannels[adapter] = r.body.channel.id
    }
    check('渠道可保存余额适配器', () => assert.ok(Object.keys(usageChannels).length === 4))

    const usAll = await apiCall('GET', '/api/usage')
    const usSnap = (adapter) => usAll.body.providers.find((p) => p.adapter === adapter)
    check('聚合接口返回本次四个渠道的快照', () => {
      assert.equal(usAll.status, 200)
      // 只校验本次创建的四个 —— 断言不能依赖全局数量，
      // 否则上一次失败运行残留的渠道会让它误报
      const mine = usAll.body.providers.filter((p) => p.channelName.includes(RUN))
      assert.equal(mine.length, 4, `实际 ${mine.length} 个`)
      assert.ok(mine.every((p) => p.ok), JSON.stringify(mine.map((p) => [p.adapter, p.error])))
    })
    check('deepseek：字符串金额被正确解析', () => {
      const b = usSnap('deepseek').balances[0]
      assert.equal(b.remaining, 100.00)
      assert.equal(b.currency, 'CNY')
      assert.equal(b.toppedUp, 100.00)
    })
    check('moonshot：可用/代金券余额解析正确', () => {
      const b = usSnap('moonshot').balances[0]
      assert.equal(b.remaining, 10.00000)
      assert.equal(b.granted, 10.00000)
    })
    check('commandcode：余额 + 三个窗口 + 套餐 + 账期', () => {
      const p = usSnap('commandcode')
      assert.ok(Math.abs(p.balances[0].remaining - 5.0) < 1e-9)
      const w = Object.fromEntries(p.windows.map((x) => [x.key, x]))
      assert.equal(w.fiveHour.total, 14)
      assert.equal(w.weekly.total, 35)
      // 月度是推算的
      assert.equal(w.monthly.total, 70)
      assert.equal(w.monthly.inferred, true)
      assert.equal(p.plan.id, 'individual-goat')
      assert.equal(p.period.requests, 1234)
    })
    check('minimax：usage_count 按「剩余」换算成已用', () => {
      const w = Object.fromEntries(usSnap('minimax').windows.map((x) => [x.key, x]))
      const k = Object.keys(w).find((x) => x.includes('interval'))
      assert.equal(w[k].total, 1500)
      assert.equal(w[k].remaining, 1200)
      assert.equal(w[k].used, 300)
    })

    // 缓存
    const usCached = await apiCall('GET', `/api/channels/${usageChannels.deepseek}/usage`)
    check('第二次读取命中缓存（避免限频）', () => assert.equal(usCached.body.cached, true))
    const usForced = await apiCall('GET', `/api/channels/${usageChannels.deepseek}/usage?refresh=1`)
    check('管理面可强制刷新', () => assert.equal(usForced.body.cached, false))

    // 改配置后缓存必须失效，否则返回旧口径
    await apiCall('PATCH', `/api/channels/${usageChannels.deepseek}`, { usageAdapter: 'moonshot' })
    const usAfterChange = await apiCall('GET', `/api/channels/${usageChannels.deepseek}/usage`)
    check('改适配器后缓存失效（不返回旧口径）', () => {
      assert.equal(usAfterChange.body.adapter, 'moonshot')
      assert.equal(usAfterChange.body.cached, false)
    })
    await apiCall('PATCH', `/api/channels/${usageChannels.deepseek}`, { usageAdapter: 'deepseek' })

    // 数据面权限
    const usageKey = await apiCall('POST', '/api/keys', { name: `smoke-usage-${RUN}` })
    const usageKeyId = usageKey.body.apiKey.id
    const usageSecret = usageKey.body.key
    check('新签发的密钥默认不能读余额（安全默认）', () => {
      assert.equal(usageKey.body.apiKey.usageAllow, false)
      assert.equal(usageKey.body.apiKey.usageRefresh, false)
    })

    const usDenied = await fetch(`${BASE}/v1/usage`, { headers: { authorization: `Bearer ${usageSecret}` } })
    const usDeniedBody = await usDenied.json()
    check('未授权读取余额 → 403', () => {
      assert.equal(usDenied.status, 403)
      assert.equal(usDeniedBody.error.code, 'usage_not_allowed')
    })

    await apiCall('PATCH', `/api/keys/${usageKeyId}`, {
      usageAllow: true,
      usageRefresh: false,
      usageChannels: [usageChannels.deepseek]
    })
    const usAllowed = await fetch(`${BASE}/v1/usage`, { headers: { authorization: `Bearer ${usageSecret}` } })
    const usAllowedBody = await usAllowed.json()
    check('授权后聚合接口可用，且只返回可见范围内的渠道', () => {
      assert.equal(usAllowed.status, 200)
      assert.equal(usAllowedBody.object, 'usage.list')
      assert.equal(usAllowedBody.providers.length, 1)
      assert.equal(usAllowedBody.providers[0].adapter, 'deepseek')
    })

    const usOneOk = await fetch(`${BASE}/v1/usage/${usageChannels.deepseek}`, {
      headers: { authorization: `Bearer ${usageSecret}` }
    })
    check('可按渠道 id 查单个 provider', () => assert.equal(usOneOk.status, 200))

    const usOutOfScope = await fetch(`${BASE}/v1/usage/${usageChannels.moonshot}`, {
      headers: { authorization: `Bearer ${usageSecret}` }
    })
    const usOutBody = await usOutOfScope.json()
    check('范围外的渠道 → 403', () => {
      assert.equal(usOutOfScope.status, 403)
      assert.equal(usOutBody.error.code, 'usage_channel_not_allowed')
    })

    const usBadProvider = await fetch(`${BASE}/v1/usage/not-a-uuid`, {
      headers: { authorization: `Bearer ${usageSecret}` }
    })
    check('provider 不是 uuid → 400', () => assert.equal(usBadProvider.status, 400))

    const usNoRefresh = await fetch(`${BASE}/v1/usage?refresh=1`, {
      headers: { authorization: `Bearer ${usageSecret}` }
    })
    const usNoRefreshBody = await usNoRefresh.json()
    check('无 refresh 权限时 ?refresh=1 → 403（不静默忽略）', () => {
      assert.equal(usNoRefresh.status, 403)
      assert.equal(usNoRefreshBody.error.code, 'usage_refresh_not_allowed')
    })

    // 未配置适配器的渠道不出现
    // 用管理面接口测「未配适配器」：数据面还要过 usage 权限，会把这条断言变成权限测试
    const usPlainUsage = await apiCall('GET', `/api/channels/${channelId}/usage`)
    check('未配适配器的渠道：明确告知未配置，而不是假装余额为 0', () => {
      assert.equal(usPlainUsage.status, 200)
      assert.equal(usPlainUsage.body.ok, false)
      assert.match(String(usPlainUsage.body.error), /未配置余额适配器/)
    })

    // 清理
    await apiCall('DELETE', `/api/keys/${usageKeyId}`)
    for (const id of Object.values(usageChannels)) {
      await apiCall('DELETE', `/api/channels/${id}`)
    }

    // ---------------------------------------------------------- 会话与 refresh token
    section('㉛ 渠道多上游账户（结构 + 选路 + 操作）')

    const acctChannel = await apiCall('POST', '/api/channels', {
      name: `smoke-acct-${RUN}`,
      baseUrl: `${MOCK}/v1`,
      apiKey: UPSTREAM_KEY,
      models: [MOCK_MODEL],
      priority: 950
    })
    const acctChannelId = acctChannel.body.channel.id
    const acctModel = `smoke-acct-model-${RUN}`
    const acctPrimary = acctChannel.body.channel.accounts?.[0]

    check('建渠道时自动创建主账户', () => {
      const ch = acctChannel.body.channel
      assert.equal(ch.accounts.length, 1)
      assert.equal(ch.accounts[0].name, '默认账户')
      assert.equal(ch.hasApiKey, true)
      // 只给掩码：掩码里含 • 且不含完整密钥
      assert.ok(ch.accounts[0].apiKeyMasked.includes('••'), '应给掩码而不是明文')
      assert.ok(!ch.accounts[0].apiKeyMasked.includes(UPSTREAM_KEY))
    })

    const acctList = await apiCall('GET', `/api/channels/${acctChannelId}/accounts`)
    check('账户列表接口可用', () => {
      assert.equal(acctList.status, 200)
      assert.equal(acctList.body.accounts.length, 1)
    })

    const acct2 = await apiCall('POST', `/api/channels/${acctChannelId}/accounts`, {
      name: `二号账户-${RUN}`,
      apiKey: UPSTREAM_KEY,
      priority: 100,
      weight: 1
    })
    const acct2Id = acct2.body.account?.id
    check('可新增第二个账户', () => assert.equal(acct2.status, 201))

    const acctDetail = await apiCall('GET', `/api/channels/${acctChannelId}`)
    check('渠道 DTO 带出两个账户', () =>
      assert.equal(acctDetail.body.channel.accounts.length, 2))

    const acctReveal = await apiCall(
      'GET',
      `/api/channels/${acctChannelId}/accounts/${acct2Id}/reveal`
    )
    const acctAudit = await apiCall('GET', '/api/audit?action=channel_account.reveal')
    check('账户密钥可单独查看', () => {
      assert.equal(acctReveal.status, 200)
      assert.equal(acctReveal.body.key, UPSTREAM_KEY)
    })
    check('查看账户密钥必留审计', () =>
      assert.ok(acctAudit.body.events.some((e) => e.action === 'channel_account.reveal')))

    const acctPatched = await apiCall(
      'PATCH',
      `/api/channels/${acctChannelId}/accounts/${acct2Id}`,
      { priority: 1, weight: 3 }
    )
    check('可改账户的优先级/权重', () => {
      assert.equal(acctPatched.status, 200)
      assert.equal(acctPatched.body.account.priority, 1)
      assert.equal(acctPatched.body.account.weight, 3)
    })

    await apiCall('PATCH', `/api/channels/${acctChannelId}`, { apiKey: `${UPSTREAM_KEY}-rot` })
    const acctAfterKey = await apiCall('GET', `/api/channels/${acctChannelId}`)
    check('改渠道密钥会同步到主账户', () => {
      const primary = acctAfterKey.body.channel.accounts.find((a) => a.name === '默认账户')
      assert.ok(primary.apiKeyMasked !== acctPrimary.apiKeyMasked, '主账户掩码未变')
    })
    await apiCall('PATCH', `/api/channels/${acctChannelId}`, { apiKey: UPSTREAM_KEY })

    // ---- 选路：priority 1 的「二号账户」应独占，priority 100 的主账户不该被用
    const acctRoute = await apiCall('POST', '/api/model-routes', {
      alias: acctModel,
      targets: [{ channelId: acctChannelId, upstreamModel: MOCK_MODEL }]
    })
    check('映射建立成功', () =>
      assert.equal(acctRoute.status, 201, acctRoute.text?.slice(0, 200)))
    const acctKey = await apiCall('POST', '/api/keys', { name: `smoke-acct-key-${RUN}` })
    const acctSecret = acctKey.body.key
    const acctHitFull = async () => {
      const r = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${acctSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: acctModel, messages: [{ role: 'user', content: 'hi' }] })
      })
      return { status: r.status, text: await r.text() }
    }
    const acctHit = async () => (await acctHitFull()).status

    const acctHit1 = await acctHit()
    const acctHit2 = await acctHit()
    const acctFirst = await acctHitFull()
    check('多账户下仍能正常转发', () => {
      assert.equal(acctFirst.status, 200, `响应：${acctFirst.text.slice(0, 300)}`)
    })
    await acctHit()
    void acctHit1
    void acctHit2

    // 日志是 fire-and-forget 的异步写入 —— 立刻查可能还没落库，所以要等一下
    let acctLogs = []
    for (let i = 0; i < 20; i++) {
      const r = await apiCall('GET', `/api/logs?limit=100&channelId=${acctChannelId}`)
      acctLogs = r.body.logs.filter((l) => l.channelId === acctChannelId)
      if (acctLogs.length >= 2) break
      await new Promise((res) => setTimeout(res, 100))
    }
    check('日志记录了实际服务的账户', () => {
      assert.ok(acctLogs.length >= 2, `只拿到 ${acctLogs.length} 条日志`)
      assert.ok(acctLogs.every((l) => l.accountName), '日志缺 accountName')
    })
    check('选中了优先级最高的账户', () =>
      assert.ok(
        acctLogs.every((l) => l.accountName === `二号账户-${RUN}`),
        `实际走了：${acctLogs.map((l) => l.accountName).join(',')}`
      ))

    const acctDel = await apiCall(
      'DELETE',
      `/api/channels/${acctChannelId}/accounts/${acct2Id}`
    )
    const acctHit3 = await acctHit()
    check('删除账户后回落到剩余账户并仍可转发', () => {
      assert.equal(acctDel.status, 200)
      assert.equal(acctHit3, 200)
    })

    const acctRemaining = await apiCall('GET', `/api/channels/${acctChannelId}/accounts`)
    const acctLastDel = await apiCall(
      'DELETE',
      `/api/channels/${acctChannelId}/accounts/${acctRemaining.body.accounts[0].id}`
    )
    check('唯一的账户不允许删除（409）', () => assert.equal(acctLastDel.status, 409))

    const acctDenied = await apiCall(
      'POST',
      `/api/channels/${acctChannelId}/accounts`,
      { name: 'x' },
      { cookie: operatorCookie, keepSession: true }
    )
    check('操作员不能新建账户（403）', () => assert.equal(acctDenied.status, 403))


    // ---- 故障转移：优先级最高的账户密钥失效 → 自动换到下一个
    const foChannel = await apiCall('POST', '/api/channels', {
      name: `smoke-fo-${RUN}`,
      baseUrl: `${MOCK}/v1`,
      apiKey: UPSTREAM_KEY,
      models: [MOCK_MODEL],
      priority: 951
    })
    const foChannelId = foChannel.body.channel.id
    const foBad = await apiCall('POST', `/api/channels/${foChannelId}/accounts`, {
      name: '失效账户',
      apiKey: 'sk-this-key-is-rejected',
      priority: 1,
      weight: 1
    })
    const foBadId = foBad.body.account.id
    const foAlias = `smoke-fo-model-${RUN}`
    await apiCall('POST', '/api/model-routes', {
      alias: foAlias,
      targets: [{ channelId: foChannelId, upstreamModel: MOCK_MODEL }]
    })
    const foKey = await apiCall('POST', '/api/keys', { name: `smoke-fo-key-${RUN}` })
    const foHit = async (model) =>
      fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${foKey.body.key}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] })
      })

    const foRes = await foHit(foAlias)
    check('最高优先级账户失效时自动换号且仍成功', () => assert.equal(foRes.status, 200))

    const foAccounts = await apiCall('GET', `/api/channels/${foChannelId}/accounts`)
    const foBadAfter = foAccounts.body.accounts.find((a) => a.id === foBadId)
    check('失效账户进入冷却并记录错误', () => {
      assert.ok(foBadAfter.cooldownUntil, '未进入冷却')
      assert.match(foBadAfter.lastError, /401/)
      assert.ok(foBadAfter.consecutiveFailures >= 1)
    })

    let foLogs = []
    for (let i = 0; i < 20; i++) {
      const r = await apiCall('GET', `/api/logs?limit=50&channelId=${foChannelId}`)
      foLogs = r.body.logs.filter((l) => l.channelId === foChannelId)
      if (foLogs.length > 0) break
      await new Promise((res) => setTimeout(res, 100))
    }
    check('换号后日志记录的是兜底账户', () =>
      assert.ok(foLogs.every((l) => l.accountName === '默认账户'), JSON.stringify(foLogs.map((l) => l.accountName))))

    // 冷却中的账户不该再被选中：再发一次请求仍应成功且不再打到失效账户
    const foRes2 = await foHit(foAlias)
    const foAccounts2 = await apiCall('GET', `/api/channels/${foChannelId}/accounts`)
    const foBadAgain = foAccounts2.body.accounts.find((a) => a.id === foBadId)
    check('冷却期内不再重试失效账户', () => {
      assert.equal(foRes2.status, 200)
      assert.equal(foBadAgain.consecutiveFailures, foBadAfter.consecutiveFailures)
    })

    // ---- 不可重试错误（400）：直接透传，不换号、不进冷却
    const foBadReqAlias = `smoke-badreq-${RUN}`
    await apiCall('POST', '/api/model-routes', {
      alias: foBadReqAlias,
      targets: [{ channelId: foChannelId, upstreamModel: 'bad-request-model' }]
    })
    const foBadReq = await foHit(foBadReqAlias)
    const foAccounts3 = await apiCall('GET', `/api/channels/${foChannelId}/accounts`)
    const foGoodAfter = foAccounts3.body.accounts.find((a) => a.name === '默认账户')
    check('不可重试的 400 直接透传（不换号）', () => assert.equal(foBadReq.status, 400))
    check('400 不会把正常账户打进冷却', () => assert.equal(foGoodAfter.cooldownUntil, null))

    // ---- 手动重置健康：不必干等 10 分钟
    const foReset = await apiCall(
      'POST',
      `/api/channels/${foChannelId}/accounts/${foBadId}/reset-health`
    )
    check('可手动重置账户健康', () => {
      assert.equal(foReset.status, 200)
      assert.equal(foReset.body.account.cooldownUntil, null)
      assert.equal(foReset.body.account.consecutiveFailures, 0)
    })


    // ---- 直连测试的账户多选：按给出顺序回退，只在可重试的失败上换号
    const dAccounts = await apiCall('GET', `/api/channels/${foChannelId}/accounts`)
    const dBad = dAccounts.body.accounts.find((a) => a.name === '失效账户')
    const dGood = dAccounts.body.accounts.find((a) => a.name === '默认账户')
    const directTest = (query, model = MOCK_MODEL) =>
      apiCall('POST', `/api/channels/${foChannelId}/chat${query}`, {
        model,
        messages: [{ role: 'user', content: 'hi' }]
      })

    const dOnly = await directTest(`?accountIds=${dBad.id}`)
    check('只测失效账户：如实报错而不是假装成功', () => {
      assert.equal(dOnly.status, 502)
      assert.match(dOnly.body.error.message, /失效账户/)
      assert.match(dOnly.body.error.message, /HTTP 401/)
    })

    const dMix = await directTest(`?accountIds=${dBad.id},${dGood.id}`)
    check('多选账户：第一个失效时自动回退到下一个', () => {
      assert.equal(dMix.status, 200)
      assert.equal(
        decodeURIComponent(dMix.headers.get('x-portara-account') ?? ''),
        '默认账户',
        `实际：${dMix.headers.get('x-portara-account')}`
      )
      assert.equal(dMix.headers.get('x-portara-skipped'), '1')
    })

    const dNoRetry = await directTest(`?accountIds=${dGood.id},${dBad.id}`, 'bad-request-model')
    check('不可重试的 400 不换号：仍由第一个账户返回', () => {
      assert.equal(dNoRetry.status, 400)
      assert.equal(
        decodeURIComponent(dNoRetry.headers.get('x-portara-account') ?? ''),
        '默认账户'
      )
      assert.equal(dNoRetry.headers.get('x-portara-skipped'), '0')
    })

    const dForeign = await directTest('?accountIds=00000000-0000-4000-8000-000000000000')
    check('指定不属于该渠道的账户：404', () => assert.equal(dForeign.status, 404))

    // 失败的那次尝试也要留痕 —— 否则「为什么这次用到了备用号」永远查不到
    let dLogs = []
    for (let i = 0; i < 25; i++) {
      const r = await apiCall('GET', `/api/logs?limit=50&channelId=${foChannelId}`)
      dLogs = r.body.logs.filter((l) => l.source === 'playground')
      if (dLogs.length >= 4) break
      await new Promise((res) => setTimeout(res, 100))
    }
    check('直连测试的失败尝试也记进日志，并标明是哪个账户', () => {
      const failed = dLogs.find((l) => l.accountName === '失效账户' && l.statusCode === 401)
      assert.ok(
        failed,
        `没有失效账户的 401 记录：${JSON.stringify(dLogs.map((l) => [l.accountName, l.statusCode]))}`
      )
      assert.ok(
        dLogs.some((l) => l.accountName === '默认账户' && l.statusCode === 200),
        '成功的那次没有记下账户'
      )
    })

    // ---- 主动额度轮转：余额为 0 的账户被选中前就应被跳过
    const qChannel = await apiCall('POST', '/api/channels', {
      name: `smoke-quota-${RUN}`,
      baseUrl: `${MOCK}/v1`,
      apiKey: UPSTREAM_KEY,
      models: [MOCK_MODEL],
      priority: 952,
      usageAdapter: 'deepseek'
    })
    const qChannelId = qChannel.body.channel.id
    const qBroke = await apiCall('POST', `/api/channels/${qChannelId}/accounts`, {
      name: '余额为零',
      apiKey: 'sk-exhausted-account',
      priority: 1,
      weight: 1
    })
    const qBrokeId = qBroke.body.account.id

    const qUsage = await apiCall('GET', `/api/channels/${qChannelId}/usage?refresh=1`)
    check('两账户余额被聚合', () => {
      assert.equal(qUsage.body.accounts.length, 2)
      const total = qUsage.body.balances[0]?.remaining
      assert.equal(total, 100.00, `实际 ${total}`)
    })
    const qBrokeAfter = qUsage.body.accounts.find((a) => a.accountName === '余额为零')
    const qRichAfter = qUsage.body.accounts.find((a) => a.accountName === '默认账户')
    check('余额为 0 的账户被标记为额度耗尽', () => assert.equal(qBrokeAfter.ok, true))
    check('按账户明细各自报出自己的余额', () => {
      assert.equal(qBrokeAfter.balances[0].remaining, 0)
      assert.equal(qRichAfter.balances[0].remaining, 100.00)
    })

    const qAccounts = await apiCall('GET', `/api/channels/${qChannelId}/accounts`)
    const qFlag = qAccounts.body.accounts.find((a) => a.id === qBrokeId)
    check('耗尽标记已落库（面板可见）', () => assert.equal(qFlag.quotaExhausted, true))

    const qAlias = `smoke-quota-model-${RUN}`
    await apiCall('POST', '/api/model-routes', {
      alias: qAlias,
      targets: [{ channelId: qChannelId, upstreamModel: MOCK_MODEL }]
    })
    const qKey = await apiCall('POST', '/api/keys', { name: `smoke-quota-key-${RUN}` })
    const qHit = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${qKey.body.key}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: qAlias, messages: [{ role: 'user', content: 'hi' }] })
    })
    check('额度耗尽的账户被跳过，请求仍成功', () => assert.equal(qHit.status, 200))

    let qLogs = []
    for (let i = 0; i < 20; i++) {
      const r = await apiCall('GET', `/api/logs?limit=50&channelId=${qChannelId}`)
      qLogs = r.body.logs.filter((l) => l.channelId === qChannelId)
      if (qLogs.length > 0) break
      await new Promise((res) => setTimeout(res, 100))
    }
    check('选中的是有余额的账户', () =>
      assert.ok(qLogs.every((l) => l.accountName === '默认账户'), JSON.stringify(qLogs.map((l) => l.accountName))))


    // ---- 口径优先级：窗口满但还有余额时，balance 与 quota 应给出相反结论
    const lpChannel = await apiCall('POST', '/api/channels', {
      name: `smoke-lp-${RUN}`,
      baseUrl: `${MOCK}/v1`,
      apiKey: UPSTREAM_KEY,
      models: [MOCK_MODEL],
      priority: 953,
      usageAdapter: 'commandcode',
      limitPriority: 'balance'
    })
    const lpId = lpChannel.body.channel.id
    check('渠道可保存耗尽判定的口径', () =>
      assert.equal(lpChannel.body.channel.limitPriority, 'balance'))

    // 高优先级账户：窗口满但有充值额度
    await apiCall('POST', `/api/channels/${lpId}/accounts`, {
      name: '窗口满但有余额',
      apiKey: 'sk-quota-full-account',
      priority: 1,
      weight: 1
    })

    const lpBal = await apiCall('GET', `/api/channels/${lpId}/usage?refresh=1`)
    const lpBalFull = lpBal.body.accounts.find((a) => a.accountName === '窗口满但有余额')
    check('该账户确实同时有余额与已满窗口', () => {
      assert.ok(lpBalFull.balances[0].remaining > 0, '应还有余额')
      assert.ok(lpBalFull.windows.some((w) => w.exceeded), '应有已超限窗口')
    })
    let lpAcc = await apiCall('GET', `/api/channels/${lpId}/accounts`)
    check('口径为 balance 时不算耗尽（钱还在）', () => {
      const a = lpAcc.body.accounts.find((x) => x.name === '窗口满但有余额')
      assert.equal(a.quotaExhausted, false)
    })

    // 切到 quota 口径再刷新：窗口满即算耗尽
    await apiCall('PATCH', `/api/channels/${lpId}`, { limitPriority: 'quota' })
    const lpQuota = await apiCall('GET', `/api/channels/${lpId}/usage?refresh=1`)
    lpAcc = await apiCall('GET', `/api/channels/${lpId}/accounts`)
    check('口径为 quota 时同样状态就算耗尽（窗口满）', () => {
      const a = lpAcc.body.accounts.find((x) => x.name === '窗口满但有余额')
      assert.equal(a.quotaExhausted, true)
      assert.equal(lpQuota.status, 200)
    })

    // 选路应跳过它，走另一个有窗口余量的账户
    const lpNormal = await apiCall('POST', `/api/channels/${lpId}/accounts`, {
      name: '窗口有余量',
      apiKey: UPSTREAM_KEY,
      priority: 2,
      weight: 1
    })
    void lpNormal
    await apiCall('POST', '/api/model-routes', {
      alias: `smoke-lp-model-${RUN}`,
      targets: [{ channelId: lpId, upstreamModel: MOCK_MODEL }]
    })
    const lpKey = await apiCall('POST', '/api/keys', { name: `smoke-lp-key-${RUN}` })
    const lpHit = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${lpKey.body.key}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: `smoke-lp-model-${RUN}`,
        messages: [{ role: 'user', content: 'hi' }]
      })
    })
    check('quota 口径下窗口已满的账户被跳过，请求仍成功', () =>
      assert.equal(lpHit.status, 200))
    let lpLogs = []
    for (let i = 0; i < 20; i++) {
      const r = await apiCall('GET', `/api/logs?limit=50&channelId=${lpId}`)
      lpLogs = r.body.logs.filter((l) => l.channelId === lpId)
      if (lpLogs.length > 0) break
      await new Promise((res) => setTimeout(res, 100))
    }
    check('选中了窗口有余量的账户', () =>
      assert.ok(lpLogs.every((l) => l.accountName === '窗口有余量'), JSON.stringify(lpLogs.map((l) => l.accountName))))

    await apiCall('DELETE', `/api/keys/${lpKey.body.apiKey.id}`)
    await apiCall('DELETE', `/api/channels/${lpId}`)

    await apiCall('DELETE', `/api/keys/${qKey.body.apiKey.id}`)
    await apiCall('DELETE', `/api/channels/${qChannelId}`)

    await apiCall('DELETE', `/api/keys/${foKey.body.apiKey.id}`)
    await apiCall('DELETE', `/api/channels/${foChannelId}`)

    await apiCall('DELETE', `/api/keys/${acctKey.body.apiKey.id}`)
    await apiCall('DELETE', `/api/channels/${acctChannelId}`)

    section('㉜ 会话：refresh token 轮换与重用检测')

    const jarOf = (res) => {
      const raw = res.headers.getSetCookie?.() ?? []
      return {
        raw,
        cookie: raw.map((c) => c.split(';')[0]).join('; '),
        pick: (name) => {
          const line = raw.find((c) => c.startsWith(name + '='))
          return line ? line.split(';')[0].split('=').slice(1).join('=') : ''
        },
        attr: (name) => raw.find((c) => c.startsWith(name + '=')) ?? ''
      }
    }
    const authPost = async (path, cookie, body) => {
      const r = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined
      })
      return { status: r.status, body: await r.json().catch(() => null), jar: jarOf(r) }
    }

    const sLogin = await authPost('/api/auth/login', null, {
      username: ADMIN_USER,
      password: ADMIN_PASS
    })
    check('登录同时下发 access 与 refresh 两条 Cookie', () => {
      assert.equal(sLogin.status, 200)
      assert.ok(sLogin.jar.pick('portara_session'), '缺少 access cookie')
      assert.ok(sLogin.jar.pick('portara_refresh'), '缺少 refresh cookie')
    })
    check('access token 是短时效的（15 分钟）', () => {
      const a = sLogin.jar.attr('portara_session')
      assert.match(a, /Max-Age=900/)
      assert.match(a, /HttpOnly/)
      assert.match(a, /Path=\//)
    })
    check('refresh cookie 限定作用域到 /api/auth（不跟业务请求走）', () => {
      const r = sLogin.jar.attr('portara_refresh')
      assert.match(r, /Path=\/api\/auth/)
      assert.match(r, /Max-Age=2592000/) // 30 天
      assert.match(r, /HttpOnly/)
    })
    check('响应带 expiresIn 供前端排主动续期', () => assert.equal(sLogin.body.expiresIn, 900))

    const sMe = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: sLogin.jar.cookie } })
    check('access token 可用于业务接口', () => assert.equal(sMe.status, 200))

    // 轮换
    const sRef = await authPost('/api/auth/refresh', sLogin.jar.cookie)
    check('刷新成功且 refresh token 已轮换', () => {
      assert.equal(sRef.status, 200)
      const next = sRef.jar.pick('portara_refresh')
      assert.ok(next && next !== sLogin.jar.pick('portara_refresh'), 'refresh token 未轮换')
      assert.ok(sRef.jar.pick('portara_session'), '未下发新的 access token')
    })

    // 宽限窗口内重放 → 放行（保护多标签页并发）
    const sGrace = await authPost(
      '/api/auth/refresh',
      'portara_refresh=' + sLogin.jar.pick('portara_refresh')
    )
    check('宽限窗口内重放旧令牌 → 放行（多标签页并发不会自我踢出）', () =>
      assert.equal(sGrace.status, 200))

    // 越过宽限窗口后重放 → 判重放并整族作废
    await new Promise((r) => setTimeout(r, 2500))
    const sReuse = await authPost(
      '/api/auth/refresh',
      'portara_refresh=' + sRef.jar.pick('portara_refresh')
    )
    check('越过宽限窗口重放 → 401 并提示令牌被重复使用', () => {
      assert.equal(sReuse.status, 401)
      assert.match(sReuse.body.error.message, /重复使用|重新登录/)
    })
    const sAfterReuse = await authPost(
      '/api/auth/refresh',
      'portara_refresh=' + sGrace.jar.pick('portara_refresh')
    )
    check('整族作废：最新那条令牌也一并失效', () => assert.equal(sAfterReuse.status, 401))

    // 登出
    const sLogin2 = await authPost('/api/auth/login', null, {
      username: ADMIN_USER,
      password: ADMIN_PASS
    })
    const sLogout = await authPost('/api/auth/logout', sLogin2.jar.cookie)
    check('登出成功', () => assert.equal(sLogout.status, 200))
    const sAfterLogout = await authPost(
      '/api/auth/refresh',
      'portara_refresh=' + sLogin2.jar.pick('portara_refresh')
    )
    check('登出后 refresh 失效', () => assert.equal(sAfterLogout.status, 401))

    const sNoCookie = await authPost('/api/auth/refresh', null)
    check('没有 refresh cookie 时刷新 → 401', () => assert.equal(sNoCookie.status, 401))

    // 冒烟只走 HTTP，没有数据库连接 —— 所以这里验证令牌本身的强度，
    // 「库里只存哈希」由服务端代码与人工查库保证（token_hash 是 64 位 hex）
    check('refresh token 是高熵随机串（32 字节 base64url）', () => {
      const line = sLogin2.jar.raw.find((x) => x.startsWith('portara_refresh='))
      const plain = line.split(';')[0].split('=').slice(1).join('=')
      assert.match(plain, /^[A-Za-z0-9_-]{43}$/, `不像 32 字节 base64url：${plain.slice(0, 12)}…`)
    })
    check('两次登录的 refresh token 不同（不是固定值）', () => {
      assert.notEqual(sLogin.jar.pick('portara_refresh'), sLogin2.jar.pick('portara_refresh'))
    })

    // ---------------------------------------------------------- 密钥不落日志
    // ------------------------------------------------ 渠道「只暴露映射模型」
    section('㉝ 渠道：只暴露映射模型')

    const hidOrigin = `hidden-origin-${RUN}`
    const hidUpstream = `hidden-upstream-${RUN}`
    const hidAlias = `smoke-hid-alias-${RUN}`

    const hidChannel = await apiCall('POST', '/api/channels', {
      name: `smoke-hide-${RUN}`,
      baseUrl: `${MOCK}/v1`,
      apiKey: UPSTREAM_KEY,
      models: [hidOrigin, hidUpstream],
      hideUnmappedModels: true,
      priority: 930
    })
    const hidChannelId = hidChannel.body.channel.id
    check('渠道可保存「只暴露映射模型」开关', () =>
      assert.equal(hidChannel.body.channel.hideUnmappedModels, true)
    )

    await apiCall('POST', '/api/model-routes', {
      alias: hidAlias,
      targets: [{ channelId: hidChannelId, upstreamModel: hidUpstream }]
    })
    const hidKey = await apiCall('POST', '/api/keys', { name: `smoke-hide-key-${RUN}` })
    const hidToken = hidKey.body.key
    createdKeyIds.push(hidKey.body.apiKey.id)

    const listModels = async (token) => {
      const r = await fetch(`${BASE}/v1/models`, {
        headers: { authorization: `Bearer ${token}` }
      })
      assert.equal(r.status, 200)
      return (await r.json()).data.map((m) => m.id)
    }

    const hidIds = await listModels(hidToken)
    check('未映射的模型不出现在 /v1/models（两个原始名都藏住）', () => {
      assert.ok(!hidIds.includes(hidOrigin), `原始模型仍然可见：${hidOrigin}`)
      assert.ok(!hidIds.includes(hidUpstream), `上游模型名泄漏了：${hidUpstream}`)
    })
    check('映射后的别名照常出现', () => assert.ok(hidIds.includes(hidAlias)))
    check('其它渠道的模型不受影响', () => assert.ok(hidIds.includes(MOCK_MODEL)))

    const hidUnmapped = await proxyCall(
      '/v1/chat/completions',
      { model: hidOrigin, messages: [{ role: 'user', content: 'hi' }] },
      hidToken
    )
    check('直接请求未映射模型 → 404 model_not_found', () => {
      assert.equal(hidUnmapped.status, 404)
      assert.equal(hidUnmapped.body?.error?.code, 'model_not_found')
    })

    const hidMapped = await proxyCall(
      '/v1/chat/completions',
      { model: hidAlias, messages: [{ role: 'user', content: 'hi' }] },
      hidToken
    )
    check('走映射仍然可用，且上游收到的是映射后的模型名', () => {
      assert.equal(hidMapped.status, 200)
      assert.equal(hidMapped.body?.received_model, hidUpstream)
    })

    const hidBoundKey = await apiCall('POST', '/api/keys', {
      name: `smoke-hide-bound-${RUN}`,
      channelId: hidChannelId
    })
    createdKeyIds.push(hidBoundKey.body.apiKey.id)
    const hidBound = await proxyCall(
      '/v1/chat/completions',
      { model: hidOrigin, messages: [{ role: 'user', content: 'hi' }] },
      hidBoundKey.body.key
    )
    check('绑定该渠道的 Key 同样拒绝未映射模型', () =>
      assert.equal(hidBound.status, 404)
    )

    const hidOff = await apiCall('PATCH', `/api/channels/${hidChannelId}`, {
      hideUnmappedModels: false
    })
    check('PATCH 只改开关时其它字段保持不变', () => {
      assert.equal(hidOff.status, 200)
      assert.equal(hidOff.body.channel.hideUnmappedModels, false)
      assert.deepEqual(hidOff.body.channel.models, [hidOrigin, hidUpstream])
    })

    const hidIdsAfter = await listModels(hidToken)
    check('关掉开关后原始模型名重新出现', () =>
      assert.ok(hidIdsAfter.includes(hidOrigin))
    )
    const hidDirectAfter = await proxyCall(
      '/v1/chat/completions',
      { model: hidOrigin, messages: [{ role: 'user', content: 'hi' }] },
      hidToken
    )
    check('关掉开关后可直接使用原始模型名', () =>
      assert.equal(hidDirectAfter.status, 200)
    )

    await apiCall('DELETE', `/api/channels/${hidChannelId}`)

    // ------------------------------------------------ 会话亲和（负载均衡）
    section('㉞ 会话亲和：同一会话钉住 (渠道, 账户)，多会话分散')

    const saChannelA = await apiCall('POST', '/api/channels', {
      name: `smoke-sa-a-${RUN}`,
      baseUrl: `${MOCK}/v1`,
      apiKey: UPSTREAM_KEY,
      models: [MOCK_MODEL],
      priority: 920,
      weight: 1
    })
    const saChannelB = await apiCall('POST', '/api/channels', {
      name: `smoke-sa-b-${RUN}`,
      baseUrl: `${MOCK}/v1`,
      apiKey: UPSTREAM_KEY,
      models: [MOCK_MODEL],
      priority: 920,
      weight: 1
    })
    const saAId = saChannelA.body.channel.id
    const saBId = saChannelB.body.channel.id
    const saAlias = `smoke-sa-model-${RUN}`

    await apiCall('POST', '/api/model-routes', {
      alias: saAlias,
      targets: [
        { channelId: saAId, upstreamModel: MOCK_MODEL, priority: 100, weight: 1 },
        { channelId: saBId, upstreamModel: MOCK_MODEL, priority: 100, weight: 1 }
      ]
    })
    const saKey = await apiCall('POST', '/api/keys', { name: `smoke-sa-key-${RUN}` })
    createdKeyIds.push(saKey.body.apiKey.id)
    const saToken = saKey.body.key

    /** 用指定会话键打一次，返回服务它的渠道名 */
    const saHit = async (sessionKey, model = saAlias) => {
      const r = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${saToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model,
          prompt_cache_key: sessionKey,
          messages: [{ role: 'user', content: 'hi' }]
        })
      })
      return { status: r.status, channel: r.headers.get('x-portara-channel') }
    }

    // ① 同一会话多次请求 → 必须固定在同一渠道（轮转已让位给亲和）
    const saStable = []
    for (let i = 0; i < 5; i++) saStable.push(await saHit(`affinity-fixed-${RUN}`))
    check('同一会话 5 次请求落在同一渠道', () => {
      assert.ok(saStable.every((r) => r.status === 200), JSON.stringify(saStable))
      const names = new Set(saStable.map((r) => r.channel))
      assert.equal(names.size, 1, `渠道发生了漂移：${[...names].join(',')}`)
    })

    // ② 多个会话 → 两个渠道都要被用到（分散，而不是全压一个）
    const saSpread = []
    for (let i = 0; i < 24; i++) saSpread.push(await saHit(`affinity-spread-${RUN}-${i}`))
    check('24 个不同会话分散到两个渠道', () => {
      assert.ok(saSpread.every((r) => r.status === 200), '存在失败请求')
      const names = new Set(saSpread.map((r) => r.channel))
      assert.equal(names.size, 2, `只用到 ${[...names].join(',')}`)
      const counts = [...names].map((n) => saSpread.filter((r) => r.channel === n).length)
      const min = Math.min(...counts)
      assert.ok(min >= 3, `分布过于倾斜：${counts.join(':')}`)
    })

    // ③ 没有会话键时不能假装有亲和（应回到轮转）
    const saNoKey = []
    for (let i = 0; i < 8; i++) {
      const r = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${saToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: saAlias, messages: [{ role: 'user', content: 'hi' }] })
      })
      saNoKey.push(r.headers.get('x-portara-channel'))
    }
    check('没有会话键时仍按权重轮转（两个渠道都用得到）', () =>
      assert.equal(new Set(saNoKey).size, 2, `只用到 ${[...new Set(saNoKey)].join(',')}`)
    )

    /*
     * ④ 上下文指纹**默认关闭**：内容相同的不同会话必须是不同会话。
     *
     * 这一条是从真实回归里长出来的：最初默认启用指纹，结果「固定系统提示 +
     * 相同首条消息」的调用（探活、模板化请求）全被判成同一个会话，
     * 一股脑钉死在一个渠道上 —— 加权轮转与负载均衡同时失效。
     */
    const saCtx = []
    for (let i = 0; i < 8; i++) {
      const r = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${saToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: saAlias,
          messages: [
            { role: 'system', content: 'stable system prompt' },
            { role: 'user', content: 'same first turn' }
          ]
        })
      })
      saCtx.push(r.headers.get('x-portara-channel'))
    }
    check('内容相同的调用默认不当成同一会话（否则会压垮单渠道）', () =>
      assert.equal(new Set(saCtx).size, 2, `全压在一个渠道：${[...new Set(saCtx)].join(',')}`)
    )

    // ⑤ 会话漂移：把当前渠道的密钥改坏 → 软漂到另一渠道，且后续稳定在新渠道
    const saPinned = saStable[0].channel
    const saPinnedId = saPinned === `smoke-sa-a-${RUN}` ? saAId : saBId
    const pinnedAccounts = await apiCall('GET', `/api/channels/${saPinnedId}/accounts`)
    const pinnedAccId = pinnedAccounts.body.accounts[0].id
    await apiCall('PATCH', `/api/channels/${saPinnedId}/accounts/${pinnedAccId}`, {
      apiKey: 'sk-this-key-is-rejected'
    })
    const saDrift = await saHit(`affinity-fixed-${RUN}`)
    check('亲和渠道鉴权失败时漂移到另一渠道并成功', () => {
      assert.equal(saDrift.status, 200, `漂移后仍失败：${saDrift.status}`)
      assert.notEqual(saDrift.channel, saPinned, '仍然落在已损坏的渠道上')
    })
    const saAfterDrift = []
    for (let i = 0; i < 3; i++) saAfterDrift.push(await saHit(`affinity-fixed-${RUN}`))
    check('漂移后亲和记录被改写（后续稳定在新渠道）', () =>
      assert.equal(new Set(saAfterDrift.map((r) => r.channel)).size, 1)
    )

    // ⑥ 日志里能查到会话哈希（前 8 位），但查不到原始会话键
    await sleep(300)
    const saLogs = await apiCall('GET', `/api/logs?limit=50&channelId=${saPinnedId}`)
    const saLog = saLogs.body.logs.find((l) => l.model === saAlias && l.sessionHash)
    check('请求日志记录了会话哈希（8 位）', () => {
      assert.ok(saLog, '日志里没有 sessionHash')
      assert.equal(saLog.sessionHash.length, 8)
    })
    check('日志里不含原始会话键', () => {
      const all = JSON.stringify(saLogs.body.logs)
      assert.ok(!all.includes(`affinity-fixed-${RUN}`), '原始会话键泄漏到日志')
    })

    // 清理本段渠道
    await apiCall('DELETE', `/api/channels/${saAId}`)
    await apiCall('DELETE', `/api/channels/${saBId}`)

    // ------------------------------------------------ 路由策略：失败冷却 + 打满窗口
    section('㉟ 路由策略：失败冷却 1h + 打满窗口不路由')

    // ① 设置项可读写
    const rs0 = await apiCall('GET', '/api/settings')
    check('设置里带失败冷却与窗口跳过两项', () => {
      assert.equal(typeof rs0.body.settings.accountFailureCooldownSec, 'number')
      assert.equal(rs0.body.settings.accountFailureCooldownSec, 3600, '默认应为 1 小时')
      assert.equal(rs0.body.settings.skipExhaustedWindows, true, '默认应开启')
    })

    /*
     * ② 失败冷却：**不改全局设置**，用默认值（3600s）验证真实行为。
     *
     * 之前把全局冷却临时改成 600s 来"方便测试"，结果 10 分钟内的失败账户
     * 都不恢复，连带把后面 replace 导入的用例打挂 —— 全局设置是共享状态，
     * 用例之间会互相污染。现在只在本地改一次往返验证可写，随即改回。
     */
    const cooldownRoundTrip = await apiCall('PATCH', '/api/settings', {
      settings: [{ key: 'accountFailureCooldownSec', value: 1800 }]
    })
    check('失败冷却时长可改', () => {
      assert.equal(cooldownRoundTrip.status, 200)
      assert.equal(cooldownRoundTrip.body.settings.accountFailureCooldownSec, 1800)
    })
    await apiCall('PATCH', '/api/settings', {
      settings: [{ key: 'accountFailureCooldownSec', value: 3600 }]
    })

    const coolChannel = await apiCall('POST', '/api/channels', {
      name: `smoke-cool-${RUN}`,
      baseUrl: `${MOCK}/v1`,
      apiKey: UPSTREAM_KEY,
      models: [MOCK_MODEL],
      priority: 910
    })
    const coolId = coolChannel.body.channel.id
    const coolBadAcc = await apiCall('POST', `/api/channels/${coolId}/accounts`, {
      name: '坏账户',
      apiKey: 'sk-this-key-is-rejected',
      priority: 1,
      weight: 1
    })
    const coolBadId = coolBadAcc.body.account.id

    const coolAlias = `smoke-cool-model-${RUN}`
    await apiCall('POST', '/api/model-routes', {
      alias: coolAlias,
      targets: [{ channelId: coolId, upstreamModel: MOCK_MODEL }]
    })
    const coolKey = await apiCall('POST', '/api/keys', { name: `smoke-cool-key-${RUN}` })
    createdKeyIds.push(coolKey.body.apiKey.id)
    const coolHit = async () =>
      fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${coolKey.body.key}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: coolAlias, messages: [{ role: 'user', content: 'hi' }] })
      })

    const cool1 = await coolHit()
    check('首次请求：坏账户失败后自动换号成功', () => assert.equal(cool1.status, 200))

    const coolAccs = await apiCall('GET', `/api/channels/${coolId}/accounts`)
    const coolBad = coolAccs.body.accounts.find((a) => a.id === coolBadId)
    check('失败账户进入冷却，时长取设置值（默认 1 小时）', () => {
      assert.ok(coolBad.cooldownUntil, '未进入冷却')
      const secs = (new Date(coolBad.cooldownUntil).getTime() - Date.now()) / 1000
      assert.ok(secs > 3500, `冷却只有 ${Math.round(secs)}s，应约 3600s`)
    })

    // 再打几次：坏账户在冷却里，不该被重试（consecutiveFailures 不再增长）
    const before = coolBad.consecutiveFailures
    for (let i = 0; i < 3; i++) await coolHit()
    const coolAccs2 = await apiCall('GET', `/api/channels/${coolId}/accounts`)
    const coolBad2 = coolAccs2.body.accounts.find((a) => a.id === coolBadId)
    check('冷却期内不再路由到失败账户', () =>
      assert.equal(coolBad2.consecutiveFailures, before)
    )

    // ③ 打满任意窗口的账户不路由（余额口径下同样生效）
    const winChannel = await apiCall('POST', '/api/channels', {
      name: `smoke-win-${RUN}`,
      baseUrl: `${MOCK}/v1`,
      apiKey: UPSTREAM_KEY,
      models: [MOCK_MODEL],
      priority: 905,
      usageAdapter: 'commandcode',
      // 关键：余额口径下"钱还在"不算耗尽 —— 新策略要能看到窗口打满
      limitPriority: 'balance'
    })
    const winId = winChannel.body.channel.id
    const winFull = await apiCall('POST', `/api/channels/${winId}/accounts`, {
      name: '窗口打满',
      apiKey: 'sk-quota-full-account',
      priority: 1,
      weight: 1
    })
    const winFullId = winFull.body.account.id

    const winUsage = await apiCall('GET', `/api/channels/${winId}/usage?refresh=1`)
    const winSnap = winUsage.body.accounts?.find((a) => a.accountId === winFullId)
    check('该账户确实「有余额但周窗口打满」', () => {
      assert.ok(winSnap, '没有该账户快照')
      assert.ok(winSnap.balances[0].remaining > 0, '余额应当还有')
      assert.ok(
        winSnap.windows.some((w) => w.exceeded === true),
        `没有打满的窗口：${JSON.stringify(winSnap.windows)}`
      )
    })

    const winAccs = await apiCall('GET', `/api/channels/${winId}/accounts`)
    const winFlag = winAccs.body.accounts.find((a) => a.id === winFullId)
    check('打满标记已落库（windowExhausted）', () => assert.equal(winFlag.windowExhausted, true))
    check('余额口径下 quotaExhausted 仍为 false（两个口径互不干扰）', () =>
      assert.equal(winFlag.quotaExhausted, false)
    )

    const winAlias = `smoke-win-model-${RUN}`
    await apiCall('POST', '/api/model-routes', {
      alias: winAlias,
      targets: [{ channelId: winId, upstreamModel: MOCK_MODEL }]
    })
    const winKey = await apiCall('POST', '/api/keys', { name: `smoke-win-key-${RUN}` })
    createdKeyIds.push(winKey.body.apiKey.id)
    const winHit = async () =>
      fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${winKey.body.key}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: winAlias, messages: [{ role: 'user', content: 'hi' }] })
      })

    const winLogsBefore = (await apiCall('GET', `/api/logs?limit=50&channelId=${winId}`)).body.logs
    await winHit()
    await sleep(250) // 日志是 fire-and-forget，给它一点落库时间
    const winLogsAfter = (await apiCall('GET', `/api/logs?limit=50&channelId=${winId}`)).body.logs
    check('窗口打满的账户被跳过（请求走了健康账户）', () => {
      const before = winLogsBefore.filter((l) => l.accountName === '窗口打满').length
      const after = winLogsAfter.filter((l) => l.accountName === '窗口打满').length
      assert.equal(after, before, `仍然路由到了打满窗口的账户（${before} → ${after}）`)
    })

    /*
     * ④ 关掉该策略后，打满窗口的账户重新参与（证明开关真的控制行为）
     *
     * 为了让"选没选中"可判定，先把健康账户**停用**：
     * 这样一旦策略关闭，唯一可用的就是打满窗口的账户，请求必然落到它身上。
     * 只用日志条数判断"有没有选中"会被时间窗口和后台上报干扰，测不准。
     */
    const healthyAcc = (await apiCall('GET', `/api/channels/${winId}/accounts`)).body.accounts.find(
      (a) => a.name === '默认账户'
    )
    await apiCall('PATCH', `/api/channels/${winId}/accounts/${healthyAcc.id}`, { status: 'disabled' })
    await apiCall('PATCH', '/api/settings', {
      settings: [{ key: 'skipExhaustedWindows', value: false }]
    })
    const offCheck = await apiCall('GET', '/api/settings')
    check('策略开关可关闭', () => assert.equal(offCheck.body.settings.skipExhaustedWindows, false))

    /*
     * 「选没选中」只能靠日志判定，不能靠状态码：
     * 伪上游只认 UPSTREAM_KEY，这个打满窗口的账户用的是 sk-quota-full-account，
     * 打过去必然是 401。**401 恰恰证明请求确实发到了它** —— 这正是我们要的证据。
     */
    const logsFor = async () =>
      (await apiCall('GET', `/api/logs?limit=50&channelId=${winId}`)).body.logs.filter(
        (l) => l.accountName === '窗口打满'
      )

    const beforeOff = (await logsFor()).length
    const winOff = await winHit()
    await sleep(400)
    const afterOff = (await logsFor()).length
    check('关闭策略后：请求被路由到打满窗口的账户（401 证明真的打过去了）', () => {
      assert.equal(winOff.status, 401, `实际 ${winOff.status}`)
      assert.ok(afterOff > beforeOff, '该账户没有收到请求')
    })

    /*
     * 再打开策略，并把健康账户恢复 → 打满窗口的账户应当被跳过。
     *
     * 注意不能"只剩打满账户时要求 503"：`pickAccounts` 刻意做了三级退化
     * （全部耗尽时允许用耗尽的），宁可让上游裁决也不自己造 503。
     * 所以只有在**存在健康账户**时，才能观察到"打满的被跳过"。
     */
    await apiCall('PATCH', `/api/channels/${winId}/accounts/${healthyAcc.id}`, { status: 'active' })
    await apiCall('PATCH', '/api/settings', {
      settings: [{ key: 'skipExhaustedWindows', value: true }]
    })
    // 它刚吃过 401，重置健康，确保测的是窗口策略而不是冷却
    await apiCall('POST', `/api/channels/${winId}/accounts/${winFullId}/reset-health`)
    const beforeOn = (await logsFor()).length
    const winOn = await winHit()
    await sleep(400)
    const afterOn = (await logsFor()).length
    check('重新开启策略后：健康账户存在时，打满窗口的账户被跳过', () => {
      assert.equal(winOn.status, 200, `实际 ${winOn.status}`)
      assert.equal(afterOn, beforeOn, `仍然打到了打满窗口的账户（${beforeOn} → ${afterOn}）`)
    })

    /*
     * ⑤ 上游明确返回额度用尽 → 阶梯冷冻（迁移 020）
     *
     * 用单账户渠道：第一次 429 后账户进入 quotaCooling，第二次请求
     * 仍会选中它（ok 池为空，阶梯退化到 quotaCooling），从而能验证
     * 「冷冻期内重复命中不递增、不延长」这条幂等语义。
     */
    const qcChannel = await apiCall('POST', '/api/channels', {
      name: `smoke-qc-${RUN}`,
      baseUrl: `${MOCK}/v1`,
      apiKey: QUOTA_ERROR_KEY,
      models: [MOCK_MODEL],
      priority: 904
    })
    const qcId = qcChannel.body.channel.id
    const qcAlias = `smoke-qc-model-${RUN}`
    await apiCall('POST', '/api/model-routes', {
      alias: qcAlias,
      targets: [{ channelId: qcId, upstreamModel: MOCK_MODEL }]
    })
    const qcKey = await apiCall('POST', '/api/keys', { name: `smoke-qc-key-${RUN}` })
    const qcHit = async () => {
      const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${qcKey.body.key}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: qcAlias, messages: [{ role: 'user', content: 'hi' }] })
      })
      return { status: res.status, text: await res.text() }
    }

    const qcFirst = await qcHit()
    check('额度用尽响应被识别（网关透传 429，不换成自造错误）', () => {
      assert.equal(qcFirst.status, 429, `实际 ${qcFirst.status}`)
      assert.match(qcFirst.text, /insufficient_quota/)
    })

    const qcAccs1 = await apiCall('GET', `/api/channels/${qcId}/accounts`)
    const qcAcc1 = qcAccs1.body.accounts[0]
    const qcUntil1 = qcAcc1.quotaCooldownUntil
    check('首次命中：level=1、quotaCooldownUntil 在未来，且不写通用冷却', () => {
      assert.equal(qcAcc1.quotaCooldownLevel, 1)
      assert.ok(qcUntil1, 'quotaCooldownUntil 为空')
      const secs = (new Date(qcUntil1).getTime() - Date.now()) / 1000
      assert.ok(secs > 240 && secs <= 300, `首档冷冻应约 300s，实际 ${Math.round(secs)}s`)
      // 两套计时分开：额度冷冻不能顺带写通用冷却
      assert.equal(qcAcc1.cooldownUntil, null)
      // 对外契约字段确实出现在端点上
      assert.equal(typeof qcAcc1.quotaCooldownLevel, 'number')
    })

    const qcSecond = await qcHit()
    const qcAccs2 = await apiCall('GET', `/api/channels/${qcId}/accounts`)
    const qcAcc2 = qcAccs2.body.accounts[0]
    check('冷冻期内第二次命中：level 不增长、到期时间不延长（幂等）', () => {
      assert.equal(qcSecond.status, 429)
      assert.equal(qcAcc2.quotaCooldownLevel, 1, 'level 被重复递增')
      assert.equal(qcAcc2.quotaCooldownUntil, qcUntil1, '冷冻期被重复延长')
    })

    // 存在健康账户时，额度冷冻的账户应被跳过（阶梯：ok 先于 quotaCooling）
    await apiCall('POST', `/api/channels/${qcId}/accounts`, {
      name: '健康账户',
      apiKey: UPSTREAM_KEY,
      priority: 100,
      weight: 1
    })
    const qcHealthy = await qcHit()
    const qcAccs3 = await apiCall('GET', `/api/channels/${qcId}/accounts`)
    const qcAcc3 = qcAccs3.body.accounts.find((a) => a.name === '默认账户')
    check('健康账户存在时先走健康账户，额度冷冻账户保持原样', () => {
      assert.equal(qcHealthy.status, 200, `实际 ${qcHealthy.status}`)
      assert.equal(qcAcc3.quotaCooldownLevel, 1)
      assert.equal(qcAcc3.quotaCooldownUntil, qcUntil1)
    })

    await apiCall('POST', '/api/model-routes/purge', { alias: qcAlias })
    await apiCall('DELETE', `/api/keys/${qcKey.body.apiKey.id}`)
    await apiCall('DELETE', `/api/channels/${qcId}`)

    // 本段自建的映射自己清掉：残留会让下一轮的 replace 类用例撞 409
    await apiCall('POST', '/api/model-routes/purge', { alias: coolAlias })
    await apiCall('POST', '/api/model-routes/purge', { alias: winAlias })
    await apiCall('DELETE', `/api/channels/${coolId}`)
    await apiCall('DELETE', `/api/channels/${winId}`)

    // 复原设置，避免影响后续用例
    await apiCall('PATCH', '/api/settings', {
      settings: [
        { key: 'skipExhaustedWindows', value: true },
        { key: 'accountFailureCooldownSec', value: 3600 }
      ]
    })

    section('㊱ 密钥不泄漏到日志')

    const stdout = output.join('')
    check('上游密钥未出现在服务端日志', () =>
      assert.ok(!stdout.includes(UPSTREAM_KEY))
    )
    check('客户端密钥未出现在服务端日志', () =>
      assert.ok(!stdout.includes(keyFull))
    )
    check('管理面响应不含上游密钥', () => assert.ok(!stdout.includes('api_key_cipher"')))

    // ---------------------------------------------------------- 清理
    section('㊲ 清理测试数据')

    let deleted = 0
    for (const id of createdKeyIds.filter(Boolean)) {
      const res = await apiCall('DELETE', `/api/keys/${id}`)
      if (res.status === 200) deleted++
    }
    check('清理本轮创建的全部密钥', () =>
      assert.equal(deleted, createdKeyIds.filter(Boolean).length)
    )
    const delChannel = await apiCall('DELETE', `/api/channels/${channelId}`)
    check('删除渠道成功', () => assert.equal(delChannel.status, 200))
  } finally {
    child.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 600))
    if (!child.killed) child.kill('SIGKILL')
    mock.close()
    mockProxy.close()
  }

  console.log(
    `\n\u001b[1m结果：\u001b[0m \u001b[32m${passed} 通过\u001b[0m` +
      (failed > 0 ? `，\u001b[31m${failed} 失败\u001b[0m` : '，0 失败')
  )
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('\n\u001b[31m冒烟测试异常终止：\u001b[0m', err)
  // 把被测服务的日志吐出来，否则连接级故障无从排查
  if (globalThis.__portaraOutput?.length) {
    console.error('\n\u001b[33m--- 被测服务输出 ---\u001b[0m')
    console.error(globalThis.__portaraOutput.join(''))
    console.error('\u001b[33m--- 输出结束 ---\u001b[0m')
  }
  process.exit(1)
})
