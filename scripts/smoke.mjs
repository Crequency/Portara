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
      models: [MOCK_MODEL],
      priority: 10,
      weight: 1,
      status: 'active',
      note: '冒烟测试渠道'
    })
    check('创建渠道成功（201）', () => assert.equal(created.status, 201))
    channelId = created.body?.channel?.id ?? null
    check('渠道返回 id', () => assert.ok(channelId))
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

    const overview = await apiCall('GET', '/api/stats/overview')
    check('统计接口反映请求数', () => {
      // 此刻已落库的是：1 次非流式 + 1 次流式（401/403 在鉴权层被拒，不计入）
      assert.ok(overview.body.todayRequests >= 2, `todayRequests=${overview.body.todayRequests}`)
      assert.ok(
        overview.body.todayTokens >= MOCK_USAGE.total_tokens * 2,
        `todayTokens=${overview.body.todayTokens}`
      )
    })

    const series = await apiCall('GET', '/api/stats/series?days=7')
    check('近 7 天序列返回 7 个点', () =>
      assert.equal(series.body?.series?.length, 7)
    )

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

    // ---------------------------------------------------------- 密钥不落日志
    section('⑬ 密钥不泄漏到日志')

    const stdout = output.join('')
    check('上游密钥未出现在服务端日志', () =>
      assert.ok(!stdout.includes(UPSTREAM_KEY))
    )
    check('客户端密钥未出现在服务端日志', () =>
      assert.ok(!stdout.includes(keyFull))
    )
    check('管理面响应不含上游密钥', () => assert.ok(!stdout.includes('api_key_cipher"')))

    // ---------------------------------------------------------- 清理
    section('⑭ 清理测试数据')

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
