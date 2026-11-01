#!/usr/bin/env node
/**
 * 系统设置页的路由行为检查（#/settings）。
 *
 * 覆盖两件事：
 *   ① 两个路由策略项（失败冷却 / 打满窗口跳过）确实渲染出来，且回填的是服务端值；
 *   ② 改冷却时长 → 保存 → 服务端落库 → 复原 → 重新打开回读到原值。
 *
 * **会写开发库**：临时改一次 accountFailureCooldownSec，结束时（含断言失败）
 * 一律复原成进入时的值。断言用的期望值取自 /api/settings，不写死默认 3600。
 *
 * 依赖中文文案（「失败后的冷却时长」「额度窗口打满即跳过」「保存设置」）——
 * 改文案要同步改这里，见 README 的「需要人工确认」一节。
 *
 * 用法：PORTARA_ADMIN_PASSWORD=… node scripts/ui/settings-routing.mjs
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

const COOLDOWN_FIELD = /失败后的冷却时长/
const SKIP_LABEL = /跳过任意窗口已打满/

let session
try {
  session = await launchPage({ width: 1680, height: 1100 })
} catch (err) {
  console.error('[settings-routing] 无法启动浏览器：' + (err?.message ?? err))
  process.exit(1)
}
const { browser, page } = session
const errors = watchConsole(page)
const check = createChecker()

/** 进入设置页后按标签取「失败后的冷却时长」这个字段里的 input */
function cooldownInput() {
  return page
    .locator('.field')
    .filter({ hasText: COOLDOWN_FIELD })
    .locator('input')
    .first()
}

/**
 * 等设置页把服务端值加载进来。
 *
 * 表单先用默认值渲染、再被 /api/settings 的结果覆盖，所以「打开页面就读」
 * 可能读到默认值。轮询到期望值（或超时由断言报实际值）。
 */
async function waitCooldown(expected, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  let value = ''
  while (Date.now() < deadline) {
    value = await cooldownInput()
      .inputValue()
      .catch(() => '')
    if (value === String(expected)) return value
    await page.waitForTimeout(200)
  }
  return value
}

/** 调 PATCH 写回某个设置项（复原用） */
async function patchSetting(key, value) {
  return apiJson(page, '/api/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: [{ key, value }] })
  })
}

let original = null

try {
  console.log('[settings-routing] ' + BASE_URL)
  await login(page)

  const read = await apiJson(page, '/api/settings')
  original = read.body?.settings
  if (!original) throw new Error('读不到 /api/settings：' + JSON.stringify(read.body).slice(0, 200))

  const originalCooldown = Number(original.accountFailureCooldownSec)
  const originalSkip = Boolean(original.skipExhaustedWindows)
  check.ok(Number.isFinite(originalCooldown), `读到当前冷却时长（${originalCooldown}）`)

  await gotoHash(page, 'settings', 2000)

  // ① 两个路由策略项都在，且回填服务端值
  const text = await page
    .locator('.content')
    .innerText()
    .catch(() => '')
  check.ok(COOLDOWN_FIELD.test(text), '有「失败后的冷却时长」')
  check.ok(SKIP_LABEL.test(text), '有「额度窗口打满即跳过」')

  const shown = await waitCooldown(originalCooldown)
  check.ok(shown === String(originalCooldown), `冷却回填服务端值（${shown} = ${originalCooldown}）`)

  const skip = page.getByRole('checkbox', { name: SKIP_LABEL })
  const skipCount = await skip.count()
  check.ok(skipCount === 1, `找到「跳过任意窗口已打满」开关（${skipCount}）`)
  if (skipCount === 1) {
    check.ok(
      (await skip.getAttribute('aria-checked')) === String(originalSkip),
      `开关回填服务端值（${originalSkip}）`
    )
  }

  // ② 改 → 存 → 服务端回读 → 复原 → 页面回读
  const nextCooldown = originalCooldown === 1800 ? 3600 : 1800
  await cooldownInput().fill(String(nextCooldown))
  await page.waitForTimeout(300)

  const save = page.getByRole('button', { name: '保存设置' })
  check.ok(await save.isEnabled(), '改动后保存按钮可用')
  await save.click()
  await page.waitForTimeout(1600)

  const saved = await apiJson(page, '/api/settings')
  const savedCooldown = Number(saved.body?.settings?.accountFailureCooldownSec)
  check.ok(savedCooldown === nextCooldown, `服务端已保存 ${nextCooldown}（${savedCooldown}）`)
  check.ok(
    (await page.locator('.toast-error').count()) === 0,
    '保存后没有错误提示'
  )

  const restored = await patchSetting('accountFailureCooldownSec', originalCooldown)
  check.ok(restored.status === 200, `复原接口返回 HTTP ${restored.status}`)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.sidebar', { timeout: 15000 })

  const back = await waitCooldown(originalCooldown)
  check.ok(back === String(originalCooldown), `复原后回读 ${originalCooldown}（${back}）`)
} catch (err) {
  check.ok(false, '脚本跑到了断言：' + (err?.message ?? err))
} finally {
  // 断言中途失败也要把设置还原，避免给人留下一个改过的冷却时长
  if (original) {
    const cooldown = Number(original.accountFailureCooldownSec)
    if (Number.isFinite(cooldown)) {
      await patchSetting('accountFailureCooldownSec', cooldown).catch(() => null)
    }
  }
  process.exitCode = summarize(check, errors)
  await browser.close()
}
