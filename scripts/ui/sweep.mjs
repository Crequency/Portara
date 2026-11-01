#!/usr/bin/env node
/**
 * 全页渲染 + 控制台错误扫描。
 *
 * 走遍导航里的每个页面（含渠道详情、渠道表单子页、负载均衡页签），
 * 三步一验：内容区渲染出来了、没有错误提示、控制台没有报错。
 * 只读：不保存任何表单、不改任何配置。
 *
 * 用法：PORTARA_ADMIN_PASSWORD=… pnpm ui:check
 *       BASE_URL=http://127.0.0.1:52741 node scripts/ui/sweep.mjs   # 前端 dev 端口
 */
import {
  BASE_URL,
  apiJson,
  createChecker,
  gotoHash,
  launchPage,
  login,
  summarize,
  watchConsole
} from './lib.mjs'

/** 导航里的全部页面；#hash 与 App.vue 的 parseRoute 对应 */
const PAGES = [
  ['overview', '概览'],
  ['channels', '上游渠道'],
  ['keys', 'API 密钥'],
  ['chat', '对话测试'],
  ['users', '用户'],
  ['logs', '请求日志'],
  ['usage', '余额用量'],
  ['proxies', 'HTTP 代理'],
  ['settings', '系统设置']
]

let session
try {
  session = await launchPage()
} catch (err) {
  console.error('[sweep] 无法启动浏览器：' + (err?.message ?? err))
  process.exit(1)
}
const { browser, page } = session
const errors = watchConsole(page)
const check = createChecker()

try {
  console.log('[sweep] ' + BASE_URL)
  await login(page)
  check.ok(true, '登录成功，进入控制台')

  for (const [hash, name] of PAGES) {
    await gotoHash(page, hash, 1600)
    const cards = await page.locator('.card').count()
    const text = (await page
      .locator('.content')
      .innerText()
      .catch(() => '')).trim()
    const toasts = await page
      .locator('.toast-error')
      .allInnerTexts()
      .catch(() => [])
    check.ok(cards > 0, `${name}：渲染 ${cards} 张卡`)
    check.ok(text.length > 0, `${name}：内容区非空`)
    check.ok(
      toasts.length === 0,
      `${name}：无错误提示${toasts.length > 0 ? ' ' + JSON.stringify(toasts.slice(0, 2)) : ''}`
    )
  }

  // 渠道详情 / 编辑页：这两个页面历史上的渲染问题最多（子路由 + 表单页）
  const { body } = await apiJson(page, '/api/channels')
  const channel = body?.channels?.[0]
  if (!channel) {
    check.skip('库里没有渠道，跳过渠道详情与编辑页')
  } else {
    await gotoHash(page, 'channels/' + channel.id, 2200)
    const detailCards = await page.locator('.card').count()
    check.ok(detailCards >= 2, `渠道详情：渲染 ${detailCards} 张卡`)
    check.ok(
      (await page.locator('.toast-error').count()) === 0,
      '渠道详情：无错误提示'
    )

    await gotoHash(page, 'channels/' + channel.id + '/edit', 2000)
    check.ok(
      (await page.locator('.form-page').count()) === 1,
      '渠道编辑：表单页渲染（不是弹窗）'
    )
  }

  await gotoHash(page, 'channels/new', 2000)
  check.ok(
    (await page.locator('.form-page').count()) === 1,
    '新建渠道：表单页渲染（不是弹窗）'
  )

  // 负载均衡页签：节点图在渠道页的第三个 tab 里
  await gotoHash(page, 'channels', 1400)
  // exact: 面板里还有「＋ 新建负载均衡」，模糊匹配会撞上
  await page.getByRole('button', { name: '负载均衡', exact: true }).click()
  await page.waitForTimeout(1500)
  const activeTab = await page
    .locator('.segmented button.on')
    .innerText()
    .catch(() => '')
  check.ok(activeTab.trim() === '负载均衡', `负载均衡页签已选中（${activeTab.trim() || '无'}）`)
  const toggle = await page
    .getByRole('button', { name: /显示全部|只看多目标/ })
    .count()
  check.ok(toggle === 1, `负载均衡面板已渲染（切换按钮 ${toggle} 个）`)
  check.ok(
    (await page.locator('.toast-error').count()) === 0,
    '负载均衡页签：无错误提示'
  )
} catch (err) {
  check.ok(false, '脚本跑到了断言：' + (err?.message ?? err))
} finally {
  process.exitCode = summarize(check, errors)
  await browser.close()
}
