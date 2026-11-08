/**
 * 网页会话采集脚本（粘贴到浏览器控制台执行）。
 *
 * 背景：OpenDesign 的用量只在网页登录态里，API Key 打接口直接 401；
 * 三条手动路径（document.cookie / cURL / Application 面板）都不可靠，
 * 所以脚本**在用户自己的浏览器里直接调接口**，把结果打包粘回 Portara。
 *
 * 需要三个接口：
 *   ① `/api/v1/me`                                        —— 账户与套餐（plan / balanceUsd）
 *   ② 工作区 id（`/workspaces/current`，拿不到就退回 `/workspaces` 列表）
 *   ③ `/workspaces/{id}/billing/coding-plan-usage`        —— **限额窗口**（5h / 7d）
 *
 * 注意：Go 套餐只有 5 小时与 7 天两个窗口，**没有月度窗口**。
 *
 * 工作区相关的接口要带 `x-vela-workspace-id` 头（官方前端就是这么发的），
 * 这是第一版脚本失败的原因 —— 只请求了路径，没带工作区头。
 *
 * 约束（单测钉住）：IIFE、只请求 amr-api 一个 origin、不读本地存储。
 */
export const WEB_SESSION_CONSOLE_SCRIPT = String.raw`(async () => {
  const ORIGIN = 'https://amr-api.open-design.ai'
  const line = (msg, color) => console.log('%c' + msg, 'color:' + color + ';font-weight:bold')

  /** 统一的请求：404/401 不抛，交给调用方判断（诊断需要看到状态码） */
  const call = async (path, workspaceId) => {
    const headers = { accept: 'application/json' }
    if (workspaceId) headers['x-vela-workspace-id'] = workspaceId
    const res = await fetch(ORIGIN + '/api' + path, { credentials: 'include', headers })
    let body = null
    try { body = await res.json() } catch (e) { body = null }
    return { status: res.status, ok: res.ok, body }
  }

  /** 从任意形状里抠出工作区 id：直接对象 / {workspace} / {data} / 数组 */
  const pickWorkspaceId = (body) => {
    if (!body) return ''
    const cands = [body, body.workspace, body.data, body.current]
    if (Array.isArray(body)) cands.push(...body)
    if (body && Array.isArray(body.workspaces)) cands.push(...body.workspaces)
    for (const c of cands) {
      if (c && typeof c === 'object' && typeof c.id === 'string' && c.id) return c.id
    }
    return ''
  }

  const bundle = {
    portara: 'opendesign-session',
    v: 3,
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
  let workspaceId = ''
  const current = await call('/v1/workspaces/current')
  diag.current = { status: current.status, keys: current.body ? Object.keys(current.body) : [] }
  workspaceId = pickWorkspaceId(current.body)

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
