/**
 * 网页会话采集脚本（粘贴到浏览器控制台执行）。
 *
 * 背景：OpenDesign 的用量只在网页登录态里，API Key 打接口直接 401；
 * 三条手动路径（document.cookie / cURL / Application 面板）都不可靠，
 * 所以脚本**在用户自己的浏览器里直接调接口**，把结果打包粘回 Portara。
 *
 * 需要三个接口：
 *   ① /api/v1/me                                        —— 账户与套餐（plan / balanceUsd）
 *   ② /api/v1/workspaces/current                        —— 工作区 id 在 activeWorkspaceId 里
 *   ③ /api/v1/workspaces/{id}/billing/coding-plan-usage —— 限额窗口（5h / 7d）
 *
 * 实测结论（2026-11-09，从用户控制台输出里读出来的）：
 *   - current 的响应字段是 activeWorkspaceId / workspaceId，**不是 id**；
 *   - /v1/workspaces 列表包在 {items: [...]} 里，不是裸数组；
 *   - 工作区级接口要带 x-vela-workspace-id 头。
 * 前两版脚本就栽在「只认 id / 只认裸数组」上。
 *
 * 注意：Go 套餐只有 5 小时与 7 天两个窗口，**没有月度窗口**。
 *
 * 约束（单测钉住）：IIFE、只请求 amr-api 一个 origin、不读本地存储。
 *
 * 实现注意：模板字符串里**不能出现反引号**（会截断 String.raw），
 * 注释里需要强调字段名时用引号或中文书名号。
 */
export const WEB_SESSION_CONSOLE_SCRIPT = String.raw`(async () => {
  const ORIGIN = 'https://amr-api.open-design.ai'
  const line = (msg, color) => console.log('%c' + msg, 'color:' + color + ';font-weight:bold')

  const call = async (path, workspaceId) => {
    const headers = { accept: 'application/json' }
    if (workspaceId) headers['x-vela-workspace-id'] = workspaceId
    const res = await fetch(ORIGIN + '/api' + path, { credentials: 'include', headers })
    let body = null
    try { body = await res.json() } catch (e) { body = null }
    return { status: res.status, ok: res.ok, body }
  }

  /**
   * 从响应里抠工作区 id。
   *
   * 实测 current 返回的是 activeWorkspaceId；list 返回 {items:[...]}；
   * 其它站内接口可能给 workspaceId / workspace.id / data.id，一并兼容。
   */
  const pickWorkspaceId = (body) => {
    if (!body) return ''
    const direct = ['activeWorkspaceId', 'workspaceId', 'id']
    for (const k of direct) {
      if (typeof body[k] === 'string' && body[k]) return body[k]
    }
    const nested = [body.workspace, body.data, body.current, body.activeWorkspace]
    for (const c of nested) {
      if (c && typeof c === 'object') {
        for (const k of direct) {
          if (typeof c[k] === 'string' && c[k]) return c[k]
        }
      }
    }
    const lists = [body.items, body.workspaces, body.data, body]
    for (const l of lists) {
      if (!Array.isArray(l)) continue
      for (const item of l) {
        if (!item || typeof item !== 'object') continue
        for (const k of direct) {
          if (typeof item[k] === 'string' && item[k]) return item[k]
        }
      }
    }
    return ''
  }

  const bundle = {
    portara: 'opendesign-session',
    v: 4,
    capturedAt: new Date().toISOString(),
    cookie: document.cookie || ''
  }
  const diag = {}

  line('[Portara] ① 读取账户信息…', '#4ade80')
  const meRes = await call('/v1/me')
  diag.me = { status: meRes.status, keys: meRes.body ? Object.keys(meRes.body) : [] }
  if (meRes.ok) bundle.me = meRes.body
  else line('[Portara] /v1/me 返回 HTTP ' + meRes.status + '（确认已登录控制台）', '#f87171')

  line('[Portara] ② 读取工作区…', '#4ade80')
  const current = await call('/v1/workspaces/current')
  diag.current = { status: current.status, keys: current.body ? Object.keys(current.body) : [] }
  let workspaceId = pickWorkspaceId(current.body)

  if (!workspaceId) {
    const list = await call('/v1/workspaces')
    diag.list = {
      status: list.status,
      isArray: Array.isArray(list.body),
      keys: list.body && !Array.isArray(list.body) ? Object.keys(list.body) : []
    }
    workspaceId = pickWorkspaceId(list.body)
  }
  if (workspaceId) {
    bundle.workspaceId = workspaceId
    line('[Portara] 工作区 id = ' + workspaceId, '#4ade80')
  } else {
    line('[Portara] 没取到工作区 id，限额会缺失（诊断信息已附在输出里）', '#fbbf24')
  }

  if (workspaceId) {
    line('[Portara] ③ 读取限额窗口…', '#4ade80')
    const usage = await call(
      '/v1/workspaces/' + encodeURIComponent(workspaceId) + '/billing/coding-plan-usage',
      workspaceId
    )
    diag.codingPlanUsage = {
      status: usage.status,
      keys: usage.body ? Object.keys(usage.body) : []
    }
    if (usage.ok) bundle.codingPlanUsage = usage.body
    else line('[Portara] 限额接口返回 HTTP ' + usage.status, '#fbbf24')

    const wallet = await call(
      '/v1/workspaces/' + encodeURIComponent(workspaceId) + '/wallet/balance',
      workspaceId
    )
    diag.wallet = { status: wallet.status }
    if (wallet.ok) bundle.walletBalance = wallet.body
  }

  bundle.diag = diag
  const text = JSON.stringify(bundle)
  console.log(text)
  try {
    copy(text)
    line('[Portara] 已复制到剪贴板 —— 回到 Portara 的「网页会话」粘贴即可', '#4ade80')
  } catch (e) {
    line('自动复制失败，请手动选中上面整行文本复制', '#fbbf24')
  }
  line('[Portara] Go 套餐只有 5 小时 / 7 天两个窗口，没有月度窗口。', '#94a3b8')
})()`
