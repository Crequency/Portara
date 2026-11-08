/**
 * 网页会话采集脚本（粘贴到浏览器控制台执行）。
 *
 * 背景：OpenDesign 的用量只在网页登录态里，API Key 打接口直接 401。
 * 而且三条手动路径都不可靠（HttpOnly 读不到 / Cloudflare 判重放无效），
 * 所以脚本**在用户自己的浏览器里直接调接口**，把结果打包粘回 Portara。
 *
 * 要调三个接口（缺一不可，实测结论）：
 *   ① `/api/v1/me`                                     —— 账户与套餐（plan / balanceUsd）
 *   ② `/api/v1/workspaces/current`                     —— 当前工作区 id（用量接口要它）
 *   ③ `/api/v1/workspaces/{id}/billing/coding-plan-usage` —— **限额窗口**（5h / 7d）
 *
 * 注意：Go 套餐只有 5 小时与 7 天两个窗口，**没有月度窗口** ——
 * 面板按接口返回什么就显示什么，不要自己编一个月窗口。
 *
 * 约束（单测钉住）：
 *   - IIFE，不污染页面全局；
 *   - 只允许请求 `https://amr-api.open-design.ai`；
 *   - 不读 localStorage / sessionStorage / indexedDB；
 *   - 输出 `{portara:'opendesign-session', ...}` 形态，后端按此解析。
 */
export const WEB_SESSION_CONSOLE_SCRIPT = String.raw`(async () => {
  const API = 'https://amr-api.open-design.ai/api'
  const line = (msg, color) => console.log('%c' + msg, 'color:' + color + ';font-weight:bold')
  const get = async (path) => {
    const res = await fetch(API + path, {
      credentials: 'include',
      headers: { accept: 'application/json' }
    })
    if (!res.ok) throw new Error(path + ' → HTTP ' + res.status)
    return res.json()
  }

  const bundle = {
    portara: 'opendesign-session',
    v: 2,
    capturedAt: new Date().toISOString(),
    cookie: document.cookie || ''
  }

  line('[Portara] 正在读取账户信息与限额…', '#4ade80')
  try {
    bundle.me = await get('/v1/me')
  } catch (err) {
    line('[Portara] 读取账户失败：' + err + '（请确认已登录控制台）', '#f87171')
  }

  try {
    const ws = await get('/v1/workspaces/current')
    const workspace = ws && ws.workspace ? ws.workspace : ws
    if (workspace && workspace.id) {
      bundle.workspaceId = workspace.id
      bundle.workspace = { id: workspace.id, name: workspace.name || '', type: workspace.type || '' }
      try {
        bundle.codingPlanUsage = await get(
          '/v1/workspaces/' + encodeURIComponent(workspace.id) + '/billing/coding-plan-usage'
        )
      } catch (err) {
        line('[Portara] 读取限额失败：' + err, '#fbbf24')
      }
      try {
        bundle.walletBalance = await get(
          '/v1/workspaces/' + encodeURIComponent(workspace.id) + '/wallet/balance'
        )
      } catch (err) {
        // 钱包接口不是每个套餐都有，失败不阻断
      }
    } else {
      line('[Portara] 没有取到工作区 id，限额可能显示不全', '#fbbf24')
    }
  } catch (err) {
    line('[Portara] 读取工作区失败：' + err, '#fbbf24')
  }

  const text = JSON.stringify(bundle)
  console.log(text)
  try {
    copy(text)
    line('[Portara] 已复制到剪贴板 —— 回到 Portara 的「网页会话」粘贴即可', '#4ade80')
  } catch (err) {
    line('自动复制失败，请手动选中上面整行文本复制', '#fbbf24')
  }
  line('[Portara] Go 套餐只有 5 小时 / 7 天两个窗口，没有月度窗口。', '#94a3b8')
})()`
