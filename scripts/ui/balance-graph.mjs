#!/usr/bin/env node
/**
 * 负载均衡节点图的版式检查（#/channels → 负载均衡页签）。
 *
 * 节点图是纯 SVG，模板改坏了不会报错、只是画得不对，所以断言落在结构上：
 * 一个源节点、N 个目标、N 条连线、备用梯队是虚线、权重徽章与权重一致，
 * 画布高度随目标数撑开；顺带验证新建 / 编辑弹窗的行数与回填。
 *
 * **会写开发库**：临时建一个 `ui-probe-balance-<时间戳>` 的多目标映射，
 * 结束时（含断言失败）按 alias 整组 purge 掉。只对开发实例跑，不要指向生产。
 *
 * 用法：PORTARA_ADMIN_PASSWORD=… node scripts/ui/balance-graph.mjs
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

/** 样本别名统一前缀，便于人工排查残留与批量清理 */
const PROBE_PREFIX = 'ui-probe-balance-'
const alias = PROBE_PREFIX + Date.now()

let session
try {
  session = await launchPage({ width: 1680, height: 1100 })
} catch (err) {
  console.error('[balance-graph] 无法启动浏览器：' + (err?.message ?? err))
  process.exit(1)
}
const { browser, page } = session
const errors = watchConsole(page)
const check = createChecker()
let created = false

try {
  console.log('[balance-graph] ' + BASE_URL)
  await login(page)

  const { body } = await apiJson(page, '/api/channels')
  const channels = (body?.channels ?? []).filter((channel) => channel.status === 'active')
  if (channels.length === 0) {
    throw new Error('库里没有 active 渠道，造不出多目标样本')
  }

  // 3 个目标、2 个梯队：前两个同优先级分流（权重 3:1），第三个作备用梯队
  const targets = ['probe-model-a', 'probe-model-b', 'probe-model-c'].map((model, i) => ({
    channelId: channels[i % channels.length].id,
    upstreamModel: model,
    priority: i < 2 ? 100 : 200,
    weight: i === 0 ? 3 : 1
  }))
  const made = await apiJson(page, '/api/model-routes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ alias, targets })
  })
  created = made.status === 200 || made.status === 201
  check.ok(created, `造样本（HTTP ${made.status}）：${alias}`)
  if (!created) throw new Error('建样本失败：' + JSON.stringify(made.body).slice(0, 300))

  // 进入负载均衡页签
  await gotoHash(page, 'channels', 1400)
  // exact: 面板里还有「＋ 新建负载均衡」，模糊匹配会撞上
  await page.getByRole('button', { name: '负载均衡', exact: true }).click()
  await page.waitForTimeout(1600)

  const aliasItem = page.locator('.bal-alias', { hasText: alias })
  const listed = await aliasItem.count()
  check.ok(listed === 1, `多目标别名出现在列表（${listed} 个匹配）`)
  if (listed === 0) throw new Error('样本没有出现在负载均衡列表里，后续版式断言无法进行')

  await aliasItem.first().click()
  await page.waitForTimeout(700)

  const graph = await page.evaluate((probeAlias) => {
    const node = [...document.querySelectorAll('.bal-alias')].find(
      (item) => item.textContent.trim() === probeAlias
    )
    const card = node?.closest('.card')
    if (!card) return null
    const svg = card.querySelector('.bal-graph svg')
    if (!svg) return null
    const texts = (selector) =>
      [...card.querySelectorAll(selector)].map((item) => item.textContent.trim())
    return {
      src: card.querySelectorAll('.bal-node-src').length,
      dst: card.querySelectorAll('.bal-target').length,
      edges: card.querySelectorAll('.bal-edge').length,
      dashed: card.querySelectorAll('.bal-edge.is-tier2').length,
      weights: texts('.bal-weight').sort(),
      models: texts('.bal-dst-model').sort(),
      height: Math.round(svg.getBoundingClientRect().height)
    }
  }, alias)

  if (!graph) {
    check.ok(false, '节点图没有渲染（.bal-graph svg 缺失）')
  } else {
    console.log('   ' + JSON.stringify(graph))
    check.ok(graph.src === 1, `一个网关模型节点（${graph.src}）`)
    check.ok(graph.dst === 3, `3 个目标节点（${graph.dst}）`)
    check.ok(graph.edges === 3, `3 条连线（${graph.edges}）`)
    check.ok(graph.dashed === 1, `备用梯队用虚线（${graph.dashed} 条）`)
    check.ok(
      JSON.stringify(graph.weights) === JSON.stringify(['×1', '×1', '×3']),
      `权重徽章 ${JSON.stringify(graph.weights)}`
    )
    check.ok(
      JSON.stringify(graph.models) ===
        JSON.stringify(['probe-model-a', 'probe-model-b', 'probe-model-c']),
      `目标节点显示上游模型 ${JSON.stringify(graph.models)}`
    )
    check.ok(graph.height > 150, `画布高度随目标数撑开（${graph.height}px）`)
  }

  // 新建弹窗：默认一行、可添加、表头 5 列
  await page.getByRole('button', { name: /新建负载均衡/ }).click()
  await page.waitForTimeout(600)
  const modal = page.locator('.modal')
  check.ok((await modal.count()) === 1, '新建弹窗打开')
  const rows = await page.locator('.bal-row').count()
  check.ok(rows === 1, `默认一行目标（${rows}）`)
  await modal.getByRole('button', { name: /添加目标/ }).click()
  await page.waitForTimeout(300)
  const rows2 = await page.locator('.bal-row').count()
  check.ok(rows2 === 2, `可添加目标行（${rows2}）`)
  const headCols = await page.locator('.bal-row-head span').count()
  check.ok(headCols === 5, `表头 5 列（${headCols}）`)
  await modal.getByRole('button', { name: '取消' }).click()
  await page.waitForTimeout(400)

  // 编辑弹窗：3 行回填、别名只读
  const card = page
    .locator('.card')
    .filter({ has: page.locator('.bal-alias', { hasText: alias }) })
    .first()
  await card.getByRole('button', { name: '编辑' }).click()
  await page.waitForTimeout(700)
  const editRows = await page.locator('.bal-row').count()
  check.ok(editRows === 3, `编辑弹窗回填 3 行（${editRows}）`)
  const aliasInput = page.locator('.modal input').first()
  check.ok((await aliasInput.inputValue()) === alias, '别名回填一致')
  check.ok(await aliasInput.isDisabled(), '编辑时别名不可改（避免映射漂移）')
  await page.locator('.modal').getByRole('button', { name: '取消' }).click()
  await page.waitForTimeout(400)
} catch (err) {
  check.ok(false, '脚本跑到了断言：' + (err?.message ?? err))
} finally {
  if (created) {
    const purged = await apiJson(page, '/api/model-routes/purge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias })
    }).catch(() => null)
    check.skip(`清理样本 ${alias}（HTTP ${purged?.status ?? '失败'}）`)
  }
  process.exitCode = summarize(check, errors)
  await browser.close()
}
