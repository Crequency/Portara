/**
 * 网页会话采集脚本（粘贴到浏览器控制台执行）。
 *
 * 背景：有些厂商的余额 / 套餐只有**网页登录态**才读得到。OpenDesign 实测用
 * API Key 打 `https://amr-api.open-design.ai/api/v1/me` 直接 401，
 * 能用的只有浏览器里那份已登录的 Cookie。
 *
 * 三条硬约束（改动前先看）：
 *
 *  1. **纯浏览器控制台可用**：IIFE 包起来、无依赖、无 import，不污染页面全局。
 *  2. **只读 document.cookie**：不发任何网络请求、不碰 localStorage 里的 token。
 *     Portara 只该拿到用户亲手交出来的这份 Cookie。
 *  3. **必须给出 HttpOnly 的兜底路径**：会话 Cookie 很可能是 HttpOnly，
 *     JS 读不到 —— 这是浏览器的安全限制，不是脚本的 bug。
 *     DevTools 的「Copy as cURL」**包含 HttpOnly Cookie**，是唯一可靠的手动路径；
 *     Portara 的接口已经能直接从整条 cURL 里提取 Cookie。
 *
 * 字符串本身被单测断言（web/tests/consoleScripts.test.mjs）：
 * 必须含 `document.cookie` 与 cURL 提示，且不含 fetch / XHR / localStorage。
 */
export const WEB_SESSION_CONSOLE_SCRIPT = String.raw`(() => {
  const line = (msg, color) => console.log('%c' + msg, 'color:' + color + ';font-weight:bold')
  const cookie = (document.cookie || '').trim()

  line('[Portara] 采集网页会话 Cookie', '#4ade80')
  console.log('本脚本只读取 document.cookie，不发送任何网络请求，也不读取浏览器的本地存储。')

  if (cookie) {
    console.log('')
    line('[Portara] 方式一（推荐先试）：复制下面整行，粘贴到 Portara 的「网页会话」输入框', '#4ade80')
    console.log(cookie)
    try {
      copy(cookie)
      line('已自动复制到剪贴板', '#4ade80')
    } catch (e) {
      console.log('自动复制失败，请手动选中上面那行复制。')
    }
  } else {
    line('当前页面读不到 cookie（很可能都是 HttpOnly），请用下面的方式二。', '#fbbf24')
  }

  console.log('')
  line('[Portara] 方式二（HttpOnly 也能拿到，最可靠）：Copy as cURL', '#fbbf24')
  console.log([
    '1. 按 F12 打开 DevTools，切到 Network（网络）面板',
    '2. 在页面里点一下「订阅 / 用量 / 账单」这类页面，让浏览器发出请求',
    '3. 在请求列表里找到发往 amr-api.open-design.ai 的那条（通常是 /api/v1/me）',
    '4. 右键该请求 → Copy（复制）→ Copy as cURL（复制为 cURL）',
    '5. 把复制到的整条命令原样粘贴到 Portara 的输入框并保存 —— 它会自动从中提取 Cookie'
  ].join('\n'))

  console.log('')
  line('[Portara] 方式三（手动抄）：DevTools → Application → Cookies', '#94a3b8')
  console.log('选中 open-design.ai 与 amr-api.open-design.ai 下的条目，把 name=value 用 "; " 拼起来粘贴。')
  console.log('HttpOnly 的条目在 Application 面板里能看到值，但 JS 读不到 —— 这就是为什么需要方式二。')
})()`
