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
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const API_PORT = Number(process.env.SMOKE_API_PORT ?? 52750)
const MOCK_PORT = API_PORT + 1
const BASE = `http://127.0.0.1:${API_PORT}`
const MOCK = `http://127.0.0.1:${MOCK_PORT}`
const RUN = Date.now().toString(36)

/**
 * 冒烟测试**必须**跑在独立 schema 里。
 *
 * 教训（2026-10-09）：此前冒烟直连开发库，其中一个 replace 模式的 JSON 导入
 * 测试是全局删除操作，把用户真实的 数十条模型映射清空了。
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
// 固定管理凭据：配合「按用户名引导」语义，脚本可无限次重复运行
const ADMIN_USER = 'smoke-admin'
const ADMIN_PASS = 'smoke-admin-password'
const OPERATOR_USER = 'smoke-operator'
const OPERATOR_PASS = 'smoke-operator-password'

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------ 伪上游

const MOCK_MODEL = 'mock-gpt-4o'
const MOCK_USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }

/** 伪上游记录的最近一次 chat 请求头，用于断言厂商兼容头确实发出去了 */
let lastUpstreamHeaders = {}

function startMockUpstream() {
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const url = req.url ?? ''

      // 鉴权校验：网关必须带上渠道密钥
      const auth = req.headers.authorization ?? ''
      if (url.startsWith('/v1') && auth !== `Bearer ${UPSTREAM_KEY}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'bad upstream key' } }))
        return
      }

      if (url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: MOCK_MODEL, object: 'model', owned_by: 'mock' }]
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
      PORTARA_COOKIE_SECURE: 'false'
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
  return { status: res.status, body: json, text, cookie: freshCookie || useCookie }
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
      assert.deepEqual(test.body?.models, [MOCK_MODEL])
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

    const logsAfterDirect = await apiCall('GET', '/api/logs?limit=100')
    const directRows = (logsAfterDirect.body?.logs ?? []).filter((l) =>
      String(l.error).includes('直连')
    )
    check('直连请求未进入 request_logs', () => assert.equal(directRows.length, 0))

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

    const goodAck = await apiCall('POST', '/api/model-routes/import', {
      mode: 'replace',
      acknowledgeRemove: 1,
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

    // ---------------------------------------------------------- 密钥不落日志
    section('㉑ 密钥不泄漏到日志')

    const stdout = output.join('')
    check('上游密钥未出现在服务端日志', () =>
      assert.ok(!stdout.includes(UPSTREAM_KEY))
    )
    check('客户端密钥未出现在服务端日志', () =>
      assert.ok(!stdout.includes(keyFull))
    )
    check('管理面响应不含上游密钥', () => assert.ok(!stdout.includes('api_key_cipher"')))

    // ---------------------------------------------------------- 清理
    section('㉒ 清理测试数据')

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
