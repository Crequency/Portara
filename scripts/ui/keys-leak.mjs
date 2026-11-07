#!/usr/bin/env node
/**
 * 文案键泄漏扫描：页面上不该原样出现 `usage.adapterField` 这类 i18n 键。
 *
 * i18n 的 lookup 找不到键时会回退中文、再回退键名本身 —— 键名出现在页面上，
 * 说明字典缺项或模板拼错了。中英各扫一遍：英文那一遍还能顺带暴露
 * 只在英文目录里缺的键（回退到中文不算泄漏，仍是键名才算）。
 *
 * 只读：打开表单只为了渲染条件字段，不保存。
 *
 * 用法：PORTARA_ADMIN_PASSWORD=… pnpm ui:keys
 */
import {
  BASE_URL,
  apiJson,
  createChecker,
  gotoHash,
  launchPage,
  login,
  setLocale,
  summarize,
  watchConsole
} from './lib.mjs'

/**
 * 命名空间白名单，与 web/src/i18n/zh.ts 的顶层键同步。
 * 新增命名空间时要补进来，否则新页面的键泄漏扫不到。
 */
const LEAK = /\b(common|nav|theme|login|overview|channels|keys|chat|users|logs|channelDetail|settings|proxies|usage|billing|toast|balance|mapping|lbLive)\.[A-Za-z][\w.]*/g

const PAGES = {
  zh: [
    ['overview', '概览'],
    ['channels', '上游渠道'],
    ['keys', 'API 密钥'],
    ['chat', '对话测试'],
    ['users', '用户'],
    ['logs', '请求日志'],
    ['usage', '余额用量'],
    ['billing', '计费'],
    ['proxies', 'HTTP 代理'],
    ['settings', '系统设置']
  ],
  en: [
    ['overview', 'overview'],
    ['channels', 'channels'],
    ['keys', 'keys'],
    ['chat', 'chat'],
    ['users', 'users'],
    ['logs', 'logs'],
    ['usage', 'usage'],
    ['billing', 'billing'],
    ['proxies', 'proxies'],
    ['settings', 'settings']
  ]
}

/** 渠道页内页签的按钮文案 */
const TABS = {
  zh: { mapping: /^模型映射$/, balance: /^负载均衡$/ },
  en: { mapping: /^Model mapping$/, balance: /^Load balancing$/ }
}

/** 计费页四个页签的按钮文案（计费页是 v0.5.0 新增，四个面板都要扫） */
const BILLING_TABS = {
  zh: [/^套餐$/, /^费率$/, /^限额模板$/, /^用户余额$/],
  en: [/^Plans$/, /^Rates$/, /^Limit templates$/, /^User balances$/]
}

async function scanBillingTabs(locale, label) {
  await gotoHash(page, 'billing', 1600)
  for (const name of BILLING_TABS[locale]) {
    await page.getByRole('button', { name }).click()
    await page.waitForTimeout(1000)
    await scan(label + ' · ' + name.source)
  }
}

/** 「余额适配器」字段的标签；选中它才会渲染条件字段（耗尽判定 / 用量地址） */
const ADAPTER_LABEL = { zh: /^余额适配器$/, en: /^Balance adapter$/ }
const ADAPTER_OPTION = /CommandCode/

let session
try {
  session = await launchPage({ width: 1680, height: 1300 })
} catch (err) {
  console.error('[keys-leak] 无法启动浏览器：' + (err?.message ?? err))
  process.exit(1)
}
const { browser, page } = session
const errors = watchConsole(page)
const check = createChecker()

/** 扫当前页面内容区里的键名 */
async function scan(label) {
  const text = await page
    .locator('.content')
    .innerText()
    .catch(() => '')
  if (!text.trim()) {
    check.ok(false, `${label}：内容区为空（.content 选择器变了？）`)
    return
  }
  const hits = [...new Set(text.match(LEAK) ?? [])]
  check.ok(
    hits.length === 0,
    hits.length > 0 ? `${label}：泄漏 ${JSON.stringify(hits.slice(0, 6))}` : label
  )
}

/** 点页内页签（按文案匹配，不按下标 —— 下标会随版式调整而错位） */
async function openTab(locale, tab) {
  await gotoHash(page, 'channels', 1400)
  await page.getByRole('button', { name: TABS[locale][tab] }).click()
  await page.waitForTimeout(1300)
}

/**
 * 负载均衡实况页依赖 /api/lb/live。
 *
 * 后端未就绪时不能硬闯这个 hash：页面会因 404 打出一条 console error，
 * 把「文案键泄漏」的检查误判成失败。先探接口，200 才扫，否则只 skip。
 */
async function scanLbLive(locale, label) {
  // 用 playwright 的 APIRequestContext 探活：它不经过页面 JS，
  // 因此后端 404 不会在页面控制台里留下一条 "Failed to load resource"。
  const response = await page.request.get(BASE_URL + '/api/lb/live?minutes=15')
  const status = response.status()
  if (status !== 200) {
    check.skip(`${label}：/api/lb/live 未就绪（HTTP ${status}），跳过`)
    return
  }
  await gotoHash(page, 'lb-live', 1500)
  await scan(label)
}

/** 新建页：选中余额适配器，让条件字段也渲染出来 */
async function scanFormWithAdapter(locale, label) {
  await gotoHash(page, 'channels/new', 1800)
  const field = page
    .locator('.field')
    .filter({ has: page.locator('label', { hasText: ADAPTER_LABEL[locale] }) })
    .first()
  if ((await field.count()) === 0) {
    check.skip(`${label}：找不到「余额适配器」字段，条件字段未覆盖（文案或结构变了吗？）`)
    return
  }
  await field.locator('.psel-trigger').click()
  await page.waitForTimeout(400)
  const option = page.locator('.psel-popup .psel-option', { hasText: ADAPTER_OPTION }).first()
  if ((await option.count()) === 0) {
    check.skip(`${label}：适配器下拉里没有 CommandCode，条件字段未覆盖`)
    return
  }
  await option.click()
  await page.waitForTimeout(600)
  await scan(label)
}

try {
  console.log('[keys-leak] ' + BASE_URL)
  await login(page)

  const { body } = await apiJson(page, '/api/channels')
  const channel = body?.channels?.[0]

  for (const locale of ['zh', 'en']) {
    console.log(`\n[${locale}]`)
    await setLocale(page, locale)

    for (const [hash, name] of PAGES[locale]) {
      await gotoHash(page, hash, 1700)
      await scan(name)
    }

    await openTab(locale, 'mapping')
    await scan(`${locale} · 映射页签`)

    await openTab(locale, 'balance')
    await scan(`${locale} · 负载均衡页签`)

    await scanLbLive(locale, `${locale} · 负载均衡实况页`)

    await scanBillingTabs(locale, `${locale} · 计费页签`)

    if (channel) {
      await gotoHash(page, 'channels/' + channel.id, 2200)
      await scan(`${locale} · 渠道详情`)
      await gotoHash(page, 'channels/' + channel.id + '/edit', 2000)
      await scan(`${locale} · 渠道编辑`)
    } else {
      check.skip(`${locale}：库里没有渠道，跳过详情 / 编辑页`)
    }

    await scanFormWithAdapter(locale, `${locale} · 新建渠道`)
  }
} catch (err) {
  check.ok(false, '脚本跑到了断言：' + (err?.message ?? err))
} finally {
  process.exitCode = summarize(check, errors)
  await browser.close()
}
