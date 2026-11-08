/**
 * 网页会话采集脚本（粘贴到浏览器控制台执行）。
 *
 * 背景：OpenDesign 的用量只在网页登录态里，API Key 打 `/api/v1/me` 直接 401。
 * 实测三条手动路径都不可靠：
 *   ① `document.cookie` —— 会话 Cookie 基本是 HttpOnly，JS 读不到；
 *   ② Copy as cURL —— 拿到了也可能因为 Cloudflare / 设备指纹被判无效；
 *   ③ Application 面板手抄 —— 同上，且容易抄漏。
 *
 * 所以脚本改成**在用户自己的浏览器里直接调用接口**：
 * 请求由浏览器发出，HttpOnly、cf_clearance、设备指纹全部天然带上，
 * 结果一定是最新的真实数据。脚本把结果打成一个 JSON 包（含可选的 cookie），
 * 用户粘回 Portara 即可 —— 有 cookie 就能自动刷新，只有快照也能看到用量。
 *
 * 约束（单测钉住，改动前先看）：
 *   - IIFE，不污染页面全局；
 *   - 只允许请求 `https://amr-api.open-design.ai` 这一个地址；
 *   - 不读 localStorage / sessionStorage / indexedDB；
 *   - 输出必须是 `{portara:'opendesign-session', ...}` 形态，后端按此解析。
 */
export const WEB_SESSION_CONSOLE_SCRIPT = String.raw`(async () => {
  const line = (msg, color) => console.log('%c' + msg, 'color:' + color + ';font-weight:bold')
  const bundle = {
    portara: 'opendesign-session',
    v: 1,
    capturedAt: new Date().toISOString(),
    cookie: document.cookie || ''
  }

  line('[Portara] 正在读取用量数据…', '#4ade80')
  try {
    const res = await fetch('https://amr-api.open-design.ai/api/v1/me', {
      credentials: 'include',
      headers: { accept: 'application/json' }
    })
    if (res.ok) {
      bundle.me = await res.json()
      line('[Portara] 读取成功', '#4ade80')
    } else {
      line('[Portara] 接口返回 HTTP ' + res.status + '，请确认已登录控制台后重试', '#fbbf24')
    }
  } catch (err) {
    line('[Portara] 请求失败：' + err, '#f87171')
  }

  const text = JSON.stringify(bundle)
  console.log(text)
  try {
    copy(text)
    line('[Portara] 已复制到剪贴板 —— 回到 Portara 的「网页会话」粘贴即可', '#4ade80')
  } catch (err) {
    line('自动复制失败，请手动选中上面整行文本复制', '#fbbf24')
  }
  line('[Portara] 只有快照也能看到用量；若包里带上了 cookie 则还能自动刷新。', '#94a3b8')
})()`
