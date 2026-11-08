/**
 * 网页登录态（Cookie）凭据库。
 *
 * 为什么需要它：有些厂商的余额 / 套餐只有**网页登录态**才读得到 ——
 * OpenDesign 实测用 API Key 打 `/api/v1/me` 直接 401 unauthenticated。
 * Cookie 等同于凭据，因此与上游密钥同规格：AES-256-GCM 加密存储，
 * 任何接口都**只回 Cookie 名，绝不回值**。
 *
 * 一个账户最多一份会话（主键就是 account_id），账户被删时级联删除。
 */
import { decryptSecret, encryptSecret } from '../lib/crypto.js'
import { env } from '../env.js'
import { one, query } from '../db.js'

/** Cookie 文本上限：与接口校验共用同一个常量，避免两处漂移 */
export const MAX_COOKIE_TEXT = 8192

export interface WebSessionStatus {
  exists: boolean
  capturedAt: string | null
  lastOkAt: string | null
  lastError: string
  cookieNames: string[]
}

/**
 * 拆出 Cookie 的**名**（不含值）。
 *
 * 兼容两种粘贴格式：单行 `a=1; b=2` 与多行（浏览器插件常按行给）。
 * 名不合法的条目直接忽略 —— 这里只用于展示，真正的合法性在 validateCookieText。
 */
export function cookieNamesOf(cookieText: string): string[] {
  const names: string[] = []
  for (const part of cookieText.split(/[;\n\r]+/)) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const name = trimmed.slice(0, eq).trim()
    if (!name || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/**
 * 从「DevTools → Copy as cURL」整条命令里抠出 Cookie。
 *
 * 为什么必须支持这个入口：会话 Cookie 大概率是 **HttpOnly**，
 * `document.cookie` 读不到（这是浏览器的安全限制，不是脚本 bug）。
 * 而 DevTools 的「Copy as cURL」**包含 HttpOnly Cookie**，
 * 用户只要在 Network 面板右键那条 `/api/v1/me` 请求就能拿到 ——
 * 这是唯一不依赖浏览器插件、又能拿到完整会话的路径。
 *
 * 只做**一次**提取，不执行任何东西：找 `-H 'cookie: ...'` / `--cookie`，
 * 或者直接把整条命令里形如 name=value 的片段拼起来。
 * 返回 null 表示看起来不是 cURL。
 */
export function cookieFromCurl(input: string): string | null {
  const text = String(input ?? '')
  if (!/^\s*(curl|fetch\()/i.test(text) && !/\s-H\s|--header/.test(text)) return null

  /** 单引号 / 双引号 / 无引号 三种写法都要吃 */
  const headerRe =
    /(?:-H|--header)\s+(?:'([^']*)'|"([^"]*)"|([^\s]+))/gi
  let m: RegExpExecArray | null
  while ((m = headerRe.exec(text))) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim()
    const sep = raw.indexOf(':')
    if (sep <= 0) continue
    if (raw.slice(0, sep).trim().toLowerCase() !== 'cookie') continue
    const value = raw.slice(sep + 1).trim()
    if (value) return value
  }

  // --cookie 'a=1; b=2'
  const cookieFlag = /--cookie\s+(?:'([^']*)'|"([^"]*)"|([^\s]+))/i.exec(text)
  const flagValue = (cookieFlag?.[1] ?? cookieFlag?.[2] ?? cookieFlag?.[3] ?? '').trim()
  if (flagValue) return flagValue

  // 兜底：整条命令里 name=value 形态的片段
  const pairs = text.match(/[!#$%&'*+.^_\`|~0-9A-Za-z-]+=[^;\s'"]+/g)
  if (pairs && pairs.length > 0) return pairs.join('; ')
  return null
}

/**
 * 把用户粘贴的内容归一成 Cookie 串。
 *
 * 三种形态都能吃：裸 Cookie、带 `Cookie: ` 前缀、整条 cURL 命令。
 */
export function normalizeCookieInput(input: string): string {
  const text = String(input ?? '').trim()
  if (!text) return ''
  const fromCurl = cookieFromCurl(text)
  if (fromCurl) return fromCurl
  const prefix = /^cookie\s*:\s*/i.exec(text)
  if (prefix) return text.slice(prefix[0].length).trim()
  return text
}

/**
 * 校验粘贴的 Cookie 文本。
 *
 * 规则（与接口契约一致）：
 *   ① 非空、长度 ≤ MAX_COOKIE_TEXT
 *   ② 每一条（按 ; 或换行分隔）都必须是 `name=value`，且 name 非空、无空白
 *
 * 返回 `null` 表示通过，否则返回给人看的错误原因。
 */
export function validateCookieText(cookieText: string): string | null {
  const text = cookieText.trim()
  if (text === '') return 'Cookie 不能为空'
  if (text.length > MAX_COOKIE_TEXT) {
    return `Cookie 太长（${text.length} 字符，上限 ${MAX_COOKIE_TEXT}）`
  }
  const parts = text.split(/[;\n\r]+/).map((s) => s.trim()).filter(Boolean)
  if (parts.length === 0) return 'Cookie 不能为空'
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq <= 0) return `Cookie 条目不是 name=value 形式：${part.slice(0, 40)}`
    const name = part.slice(0, eq).trim()
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      return `Cookie 名不合法：${name.slice(0, 40)}`
    }
    // 值里允许出现 =（base64 padding），但必须非空
    if (part.slice(eq + 1).trim() === '') return `Cookie 条目「${name}」的值为空`
  }
  return null
}

/** 加密 Cookie（纯函数，便于单测往返） */
export function sealWebSession(cookieText: string, masterKey: Buffer): string {
  return encryptSecret(cookieText, masterKey)
}

/** 解密 Cookie；密文损坏 / 主密钥变更时返回 null（不抛） */
export function openWebSession(cipher: string, masterKey: Buffer): string | null {
  try {
    return decryptSecret(cipher, masterKey)
  } catch {
    return null
  }
}

/** 保存（覆盖）某账户的网页会话；cookie_names 只记名不记值 */
export async function saveWebSession(
  accountId: string,
  cookieText: string
): Promise<WebSessionStatus> {
  const cookieNames = cookieNamesOf(cookieText)
  await query(
    `insert into account_web_sessions (account_id, cipher, cookie_names, captured_at)
     values ($1, $2, $3, now())
     on conflict (account_id) do update
        set cipher = excluded.cipher,
            cookie_names = excluded.cookie_names,
            captured_at = now(),
            last_ok_at = null,
            last_error = '',
            expires_at = null`,
    [accountId, sealWebSession(cookieText, env.masterKey), cookieNames.join(',')]
  )
  return (await getWebSessionStatus(accountId))!
}

/** 读解密后的 Cookie；没有会话或解密失败都返回 null */
export async function loadWebSession(accountId: string): Promise<{ cookie: string } | null> {
  const row = await one<{ cipher: string }>(
    'select cipher from account_web_sessions where account_id = $1',
    [accountId]
  )
  if (!row) return null
  const cookie = openWebSession(row.cipher, env.masterKey)
  if (cookie === null) return null
  return { cookie }
}

export async function clearWebSession(accountId: string): Promise<void> {
  await query('delete from account_web_sessions where account_id = $1', [accountId])
}

/**
 * 记录一次试跑结果。
 *
 * 成功：写 last_ok_at、清空 last_error。
 * 失败：只写 last_error —— 401/403 时由调用方传 'session_expired'，
 * 面板据此提示"重新粘贴 Cookie"。
 */
export async function markSessionResult(
  accountId: string,
  ok: boolean,
  error = ''
): Promise<void> {
  if (ok) {
    await query(
      `update account_web_sessions
          set last_ok_at = now(), last_error = ''
        where account_id = $1`,
      [accountId]
    )
    return
  }
  await query(
    `update account_web_sessions
        set last_error = $2
      where account_id = $1`,
    [accountId, error.slice(0, 500)]
  )
}

/** 面板展示用的会话状态 —— **绝不包含 Cookie 值或密文** */
export async function getWebSessionStatus(accountId: string): Promise<WebSessionStatus> {
  const row = await one<{
    cookie_names: string
    captured_at: Date | null
    last_ok_at: Date | null
    last_error: string
  }>(
    `select cookie_names, captured_at, last_ok_at, last_error
       from account_web_sessions where account_id = $1`,
    [accountId]
  )
  if (!row) {
    return { exists: false, capturedAt: null, lastOkAt: null, lastError: '', cookieNames: [] }
  }
  return {
    exists: true,
    capturedAt: row.captured_at ? new Date(row.captured_at).toISOString() : null,
    lastOkAt: row.last_ok_at ? new Date(row.last_ok_at).toISOString() : null,
    lastError: row.last_error ?? '',
    cookieNames: (row.cookie_names ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  }
}
