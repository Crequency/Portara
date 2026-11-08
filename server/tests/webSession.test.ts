import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_COOKIE_TEXT,
  cookieFromCurl,
  cookieNamesOf,
  mergeSetCookies,
  normalizeCookieInput,
  sanitizeCookieHeader,
  parseWebSessionInput,
  openWebSession,
  sealWebSession,
  validateCookieText
} from '../src/services/webSession.js'

/*
 * 这一组只测**纯函数**（加密往返 / 名称提取 / 格式校验）——
 * 数据库读写属于集成路径，由冒烟脚本覆盖。
 */

const MASTER = Buffer.alloc(32, 9)

test('webSession：加解密往返，密文不含明文', () => {
  const cookie = 'session_token=abc123; cf_clearance=xyz.789'
  const cipher = sealWebSession(cookie, MASTER)

  assert.ok(cipher.startsWith('v1:'), '应复用 lib/crypto 的 v1 密文格式')
  assert.ok(!cipher.includes('abc123'), '密文里不能出现 Cookie 值')
  assert.ok(!cipher.includes('session_token'), '密文里不能出现 Cookie 名')
  assert.equal(openWebSession(cipher, MASTER), cookie)
})

test('webSession：主密钥不对 / 密文损坏时解密返回 null（不抛）', () => {
  const cipher = sealWebSession('a=1', MASTER)
  assert.equal(openWebSession(cipher, Buffer.alloc(32, 1)), null)
  assert.equal(openWebSession('garbage', MASTER), null)
  assert.equal(openWebSession('', MASTER), null)
})

test('webSession：Cookie 名提取支持分号与多行两种粘贴格式', () => {
  assert.deepEqual(cookieNamesOf('a=1; b=2'), ['a', 'b'])
  assert.deepEqual(cookieNamesOf('a=1\nb=2\r\nc=3'), ['a', 'b', 'c'])
  // 值里带 = / 空格的没问题（base64 padding、JWT）
  assert.deepEqual(cookieNamesOf('token=abc==; other=x y'), ['token', 'other'])
  // 重复名去重（浏览器可能给同名多域）
  assert.deepEqual(cookieNamesOf('a=1; a=2'), ['a'])
  // 非法条目忽略，不炸
  assert.deepEqual(cookieNamesOf('garbage; =1; ok=1'), ['ok'])
  assert.deepEqual(cookieNamesOf(''), [])
})

test('webSession：Cookie 名列表里绝不出现值', () => {
  const names = cookieNamesOf('session=super-secret-value')
  assert.ok(!names.some((n) => n.includes('super-secret-value')))
})

test('webSession：格式校验通过正常输入', () => {
  assert.equal(validateCookieText('session=abc'), null)
  assert.equal(validateCookieText('a=1; b=2'), null)
  assert.equal(validateCookieText('a=1\nb=2\n'), null)
})

test('webSession：格式校验拒绝空 / 超长 / 非 name=value', () => {
  assert.match(String(validateCookieText('')), /不能为空/)
  assert.match(String(validateCookieText('   ')), /不能为空/)
  assert.match(String(validateCookieText('no-equals-sign')), /name=value/)
  assert.match(String(validateCookieText('=value-only')), /name=value/)
  assert.match(String(validateCookieText('ok=1; bad')), /name=value/)
  assert.match(String(validateCookieText('bad name=1')), /不合法/)
  // 值为空也算不合法（粘贴时最常见的漏值）
  assert.match(String(validateCookieText('a=')), /值为空/)
})

test('webSession：长度上限是 8192（与接口契约一致）', () => {
  assert.equal(MAX_COOKIE_TEXT, 8192)
  const big = 'a=' + 'x'.repeat(8192)
  assert.match(String(validateCookieText(big)), /太长/)
  const ok = 'a=' + 'x'.repeat(8189)
  assert.equal(ok.length, 8191)
  assert.equal(validateCookieText(ok), null)
})
/*
 * cURL 提取。
 *
 * 为什么要专门测：会话 Cookie 大概率是 HttpOnly，document.cookie 读不到，
 * 「DevTools → Copy as cURL」是唯一能拿到完整会话的手动路径。
 * 这里把三种引号写法、--cookie 形式、非 cURL 输入都钉住。
 */
test('cookieFromCurl：单引号 -H cookie 提取', () => {
  const curl = "curl 'https://amr-api.open-design.ai/api/v1/me' \\n  -H 'accept: application/json' \\n  -H 'cookie: session_token=abc; cf_clearance=xyz' \\n  --compressed"
  assert.equal(cookieFromCurl(curl), 'session_token=abc; cf_clearance=xyz')
})

test('cookieFromCurl：双引号与大小写不敏感', () => {
  const curl = 'curl "https://x/api/v1/me" -H "Cookie: a=1; b=2"'
  assert.equal(cookieFromCurl(curl), 'a=1; b=2')
})

test('cookieFromCurl：--cookie 形式', () => {
  assert.equal(cookieFromCurl("curl https://x --cookie 'sid=9; t=1'"), 'sid=9; t=1')
})

test('cookieFromCurl：不是 cURL 的输入返回 null（不误吞裸 Cookie）', () => {
  assert.equal(cookieFromCurl('session_token=abc'), null)
  assert.equal(cookieFromCurl(''), null)
})

test('normalizeCookieInput：三种粘贴形态都能归一', () => {
  assert.equal(normalizeCookieInput('  a=1; b=2  '), 'a=1; b=2')
  assert.equal(normalizeCookieInput('Cookie: a=1; b=2'), 'a=1; b=2')
  assert.equal(
    normalizeCookieInput("curl 'https://x' -H 'cookie: a=1; b=2'"),
    'a=1; b=2'
  )
})

test('normalizeCookieInput：cURL 提取结果能过格式校验', () => {
  const curl = "curl 'https://amr-api.open-design.ai/api/v1/me' -H 'cookie: session_token=abc; cf_clearance=xyz'"
  const cookie = normalizeCookieInput(curl)
  assert.equal(validateCookieText(cookie), null)
  assert.deepEqual(cookieNamesOf(cookie), ['session_token', 'cf_clearance'])
})
/*
 * 快照包的解析。
 *
 * 这是"三条手动路径都失败"之后的兜底设计：让用户在浏览器里直接调接口，
 * 把结果打成 JSON 包粘回来。这里钉住四种输入形态与优先级。
 */
test('parseWebSessionInput：控制台快照包 → cookie + me', () => {
  const bundle = {
    portara: 'opendesign-session',
    v: 1,
    capturedAt: '2026-11-09T03:20:00.000Z',
    cookie: 'a=1; b=2',
    me: { wallet: { balanceUsd: 12.5 }, designPlanWindows: [] }
  }
  const out = parseWebSessionInput(JSON.stringify(bundle))
  assert.equal(out.cookie, 'a=1; b=2')
  // v2 起快照是「三接口合并」的包裹对象，不再只是 me
  assert.deepEqual(out.snapshot, {
    me: bundle.me,
    codingPlanUsage: null,
    walletBalance: null,
    workspaceId: null,
    diag: null
  })
  assert.equal(out.snapshotAt, '2026-11-09T03:20:00.000Z')
})

test('parseWebSessionInput：HttpOnly 场景没有 cookie，只剩快照', () => {
  const bundle = {
    portara: 'opendesign-session',
    capturedAt: '2026-11-09T03:20:00.000Z',
    cookie: '',
    me: { walletBreakdown: [] }
  }
  const out = parseWebSessionInput(JSON.stringify(bundle))
  assert.equal(out.cookie, '')
  assert.deepEqual((out.snapshot as { me: unknown }).me, bundle.me)
})

test('parseWebSessionInput：直接粘 /api/v1/me 响应 → 只有快照', () => {
  const me = { wallet: { balanceUsd: 3 }, designPlanWindows: [{ kind: 'fiveHour' }] }
  const out = parseWebSessionInput(JSON.stringify(me))
  assert.equal(out.cookie, '')
  assert.deepEqual(out.snapshot, me)
})

test('parseWebSessionInput：cURL → 提取 Cookie，无快照', () => {
  const curl = "curl 'https://amr-api.open-design.ai/api/v1/me' -H 'cookie: a=1; b=2'"
  const out = parseWebSessionInput(curl)
  assert.equal(out.cookie, 'a=1; b=2')
  assert.equal(out.snapshot, null)
})

test('parseWebSessionInput：裸 Cookie 原样归一', () => {
  const out = parseWebSessionInput('Cookie:  a=1; b=2 ')
  assert.equal(out.cookie, 'a=1; b=2')
  assert.equal(out.snapshot, null)
})

test('parseWebSessionInput：非法 JSON 回落成 Cookie 处理，不抛', () => {
  const out = parseWebSessionInput('{not json} a=1')
  assert.equal(out.snapshot, null)
})
/*
 * Cookie 清洗与滚动续期。
 *
 * 事故背景（2026-11-09）：用户用「Copy as cURL」把 Cookie 粘进来，
 * 界面显示"已设置"、包含 session_token，但服务端一直 401 ——
 * 原因是 cURL 里层单引号跟着名字一起被抠出来，变成
 * `'__Secure-better-auth.session_token=...`，服务端直接忽略整条。
 * 去掉名字两端的引号后同一份 Cookie 立刻 200。
 */
test('sanitizeCookieHeader：去掉 cURL 内层引号（事故复现）', () => {
  const dirty = "q=0.8; '__Secure-better-auth.session_token=abc.def%3D; __Secure-better-auth.session_token_multi-x=u; u=1"
  const clean = sanitizeCookieHeader(dirty)
  assert.equal(
    clean,
    'q=0.8; __Secure-better-auth.session_token=abc.def%3D; __Secure-better-auth.session_token_multi-x=u; u=1'
  )
  assert.ok(!clean.includes("'"), '清洗后不该再有引号')
})

test('sanitizeCookieHeader：整条被引号包住也能处理', () => {
  assert.equal(sanitizeCookieHeader("'a=1; b=2'"), 'a=1; b=2')
  assert.equal(sanitizeCookieHeader('a="1"; b=2'), 'a=1; b=2')
})

test('sanitizeCookieHeader：丢掉非法条目，保留合法的', () => {
  assert.equal(sanitizeCookieHeader('a=1; garbage; =noname; b=2'), 'a=1; b=2')
  assert.equal(sanitizeCookieHeader(''), '')
})

test('mergeSetCookies：新值覆盖同名、其它保留', () => {
  const merged = mergeSetCookies('a=1; b=2', ['a=9; Path=/; HttpOnly'])
  assert.equal(merged, 'a=9; b=2')
})

test('mergeSetCookies：Max-Age=0 视为删除', () => {
  const merged = mergeSetCookies('a=1; b=2', ['a=; Max-Age=0'])
  assert.equal(merged, 'b=2')
})

test('mergeSetCookies：没有 Set-Cookie 时原样返回', () => {
  assert.equal(mergeSetCookies('a=1', []), 'a=1')
})
