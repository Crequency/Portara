/**
 * scripts/ui 的公共工具：启动 chromium、登录、收集控制台错误。
 *
 * 这些检查脚本原来散落在 /tmp/uicheck/，每个都把「启动浏览器 + 填登录表单 +
 * 数 `✖`」抄了一遍，连等待时长与噪声过滤都各写各的。这里只留一份，
 * 脚本自己只写断言。依赖与用法见同目录 README.md。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 被测站点。默认端口与服务端 `PORTARA_PORT` 缺省一致；换环境用 BASE_URL 覆盖 */
export const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:52740').replace(/\/+$/, '')

/**
 * 管理员账号。**口令只从环境变量读**，仓库里不留明文。
 * 用户名缺省 admin，与 server/src/env.ts 的默认值一致。
 */
export const ADMIN_USERNAME = process.env.PORTARA_ADMIN_USERNAME ?? 'admin'
export const ADMIN_PASSWORD = process.env.PORTARA_ADMIN_PASSWORD ?? ''

/**
 * 未登录时前端会探测 /api/auth/me 与 /api/auth/refresh，
 * 两个 401 都是正常流程，不该算成控制台错误。
 */
function isNoise(msg) {
  const url = msg.location()?.url ?? ''
  return /\/api\/auth\/(me|refresh)(?:[?#]|$)/.test(url)
}

/** 把环境变量给的路径（可能是目录）变成可 import 的说明符 */
function toSpecifier(spec) {
  if (!existsSync(spec)) return spec
  const entry = statSync(spec).isDirectory() ? join(spec, 'index.js') : spec
  return pathToFileURL(entry).href
}

/** 加载 playwright-core：优先本仓库依赖，其次 PLAYWRIGHT_CORE_PATH 指向的已有安装 */
async function loadChromium() {
  const tried = []
  for (const spec of ['playwright-core', process.env.PLAYWRIGHT_CORE_PATH].filter(Boolean)) {
    try {
      const mod = await import(toSpecifier(spec))
      // playwright-core 是 CJS：有时只能用 default 取到 chromium
      const chromium = mod.chromium ?? mod.default?.chromium
      if (chromium) return chromium
      tried.push(`${spec}（没有导出 chromium）`)
    } catch (err) {
      tried.push(`${spec}（${err?.code ?? err?.message ?? err}）`)
    }
  }
  throw new Error(
    '未找到 playwright-core：先 pnpm add -D playwright-core，' +
      '或用 PLAYWRIGHT_CORE_PATH 指向已有的安装。已尝试：' + (tried.join('；') || '无')
  )
}

/**
 * 找 chrome-headless-shell。
 *
 * 目录名带 playwright 的构建号（chromium_headless_shell-1234），
 * 所以按目录名倒序取，升级浏览器不用改代码。
 */
let chromiumPath = ''
function findChromium() {
  if (chromiumPath) return chromiumPath
  const candidates = [process.env.CHROME_HEADLESS_SHELL]
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), '.cache', 'ms-playwright')
  if (existsSync(cache)) {
    const dirs = readdirSync(cache)
      .filter((dir) => dir.startsWith('chromium_headless_shell'))
      .sort()
      .reverse()
    for (const dir of dirs) {
      const root = join(cache, dir)
      for (const platform of readdirSync(root)) {
        for (const bin of ['chrome-headless-shell', 'chrome-headless-shell.exe']) {
          candidates.push(join(root, platform, bin))
        }
      }
    }
  }
  chromiumPath = candidates.filter(Boolean).find((path) => existsSync(path)) ?? ''
  return chromiumPath
}

/**
 * 起一个页面。
 *
 * @returns {Promise<{ browser: import('playwright-core').Browser, page: import('playwright-core').Page }>}
 */
export async function launchPage({ width = 1600, height = 1000 } = {}) {
  const chromium = await loadChromium()
  const executablePath = findChromium()
  if (!executablePath) {
    throw new Error(
      '未找到 chrome-headless-shell：npx playwright-core install chromium-headless-shell，' +
        '或用 CHROME_HEADLESS_SHELL 指定可执行文件'
    )
  }
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  page.setDefaultTimeout(15000)
  page.setDefaultNavigationTimeout(30000)
  return { browser, page }
}

/**
 * 收集控制台 / 页面错误。
 *
 * 返回的数组是活的：脚本结束时交给 summarize() 一起计入退出码。
 */
export function watchConsole(page) {
  const errors = []
  page.on('pageerror', (err) => errors.push('pageerror: ' + err.message))
  page.on('console', (msg) => {
    if (msg.type() !== 'error' || isNoise(msg)) return
    errors.push('console: ' + msg.text())
  })
  return errors
}

/**
 * 登录并等首屏拉完。
 *
 * 口令缺失时直接报清楚，而不是让表单填进空串然后卡在「登录失败」。
 */
export async function login(page, { locale = 'zh' } = {}) {
  if (!ADMIN_PASSWORD) {
    throw new Error('缺少环境变量 PORTARA_ADMIN_PASSWORD（管理员口令不写进仓库）')
  }
  await page.goto(BASE_URL + '/', { waitUntil: 'domcontentloaded' })
  await page.evaluate((value) => localStorage.setItem('portara.locale', value), locale)
  // 不用 networkidle：控制台有定时刷新，等「500ms 没请求」可能永远等不到
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.fill('input#u', ADMIN_USERNAME)
  await page.fill('input#p', ADMIN_PASSWORD)
  await page.click('button[type=submit]')
  try {
    await page.waitForSelector('.sidebar', { timeout: 15000 })
  } catch {
    const alert = await page
      .locator('.alert')
      .first()
      .innerText()
      .catch(() => '')
    const reason = alert.trim() ? '：' + alert.trim() : ''
    throw new Error(`登录失败（${BASE_URL}，用户 ${ADMIN_USERNAME}）${reason}`)
  }
  await page.waitForTimeout(800)
}

/** 切语言：写 localStorage 后整页重载（i18n 只在启动时读一次） */
export async function setLocale(page, locale) {
  await page.evaluate((value) => localStorage.setItem('portara.locale', value), locale)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.sidebar', { timeout: 15000 })
  await page.waitForTimeout(500)
}

/** 按 `#/<hash>` 走一遍；等界面自己把数据拉回来 */
export async function gotoHash(page, hash, settleMs = 1500) {
  await page.evaluate((value) => {
    location.hash = '#/' + value
  }, hash)
  await page.waitForTimeout(settleMs)
}

/**
 * 在页面上下文里调一次接口（复用登录 Cookie）。
 *
 * @returns {Promise<{ status: number, body: any }>}
 */
export async function apiJson(page, path, init) {
  return page.evaluate(
    async ({ path: url, init: requestInit }) => {
      const res = await fetch(url, requestInit ?? {})
      const text = await res.text()
      let body = text
      try {
        body = JSON.parse(text)
      } catch {
        /* 非 JSON 就原样返回，断言失败时能看见内容 */
      }
      return { status: res.status, body }
    },
    { path, init }
  )
}

/** 极简断言器：逐条打印 ✔ / ✖，并累计失败数 */
export function createChecker() {
  let failures = 0
  return {
    ok(cond, label) {
      const good = Boolean(cond)
      console.log(`  ${good ? '✔' : '✖'} ${label}`)
      if (!good) failures++
      return good
    },
    /** 环境不满足、无法断言时用：只提示，不计失败 */
    skip(label) {
      console.log(`  ⚠ ${label}`)
    },
    get failures() {
      return failures
    }
  }
}

/**
 * 打印汇总并给出退出码：0 通过 / 1 失败。
 * 控制台错误与断言失败一样算失败 —— 只是「页面没崩」不够。
 */
export function summarize(check, errors = []) {
  if (errors.length > 0) {
    console.log(`\n控制台 / 页面错误（${errors.length}）：`)
    for (const error of errors) console.log('  • ' + error)
  } else {
    console.log('\n无控制台错误')
  }
  const failed = check.failures + errors.length
  if (failed === 0) {
    console.log('\n结果：通过')
    return 0
  }
  console.log(`\n结果：失败（断言 ${check.failures} 项，控制台错误 ${errors.length} 条）`)
  return 1
}
