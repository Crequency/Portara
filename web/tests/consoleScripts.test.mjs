/**
 * 网页会话采集脚本的约束测试。
 *
 * 这段字符串会被用户**原样粘贴到浏览器控制台**执行 —— 它的能力边界必须被钉死：
 * 只允许请求 OpenDesign 自己的 API、不许读本地存储、不许碰别的域名。
 *
 * 跑法：`pnpm --filter @portara/web test`（= node --test tests/*.test.mjs）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WEB_SESSION_CONSOLE_SCRIPT } from '../src/consoleScripts.ts'

const script = WEB_SESSION_CONSOLE_SCRIPT

test('导出的是非空字符串', () => {
  assert.equal(typeof script, 'string')
  assert.ok(script.trim().length > 100, '脚本不该短到只剩一行')
})

test('是 IIFE：不往页面全局塞变量', () => {
  assert.ok(script.trimStart().startsWith('(async () => {'), '应以 (async () => { 开头')
  assert.ok(script.trimEnd().endsWith('})()'), '应以 })() 结尾')
})

test('只请求 OpenDesign 自己的 API（唯一允许的网络目标）', () => {
  assert.match(script, /https:\/\/amr-api\.open-design\.ai\/api/)
  const urls = [...script.matchAll(/https?:\/\/[^'"\s)]+/g)].map((m) => m[0])
  assert.ok(urls.length > 0, '脚本里至少要有一个 API 基址')
  for (const u of urls) {
    assert.equal(u, 'https://amr-api.open-design.ai/api', `出现了不该请求的地址：${u}`)
  }
})

test('调用三个必需接口：me / workspaces-current / coding-plan-usage', () => {
  assert.match(script, /'\/v1\/me'/)
  assert.match(script, /'\/v1\/workspaces\/current'/)
  assert.match(script, /billing\/coding-plan-usage/)
})

test('带 credentials: include，才能用上 HttpOnly 会话', () => {
  assert.match(script, /credentials:\s*'include'/)
})

test('输出带可识别的包标记，后端据此解析', () => {
  assert.match(script, /portara:\s*'opendesign-session'/)
  assert.match(script, /capturedAt/)
})

test('打印完整内容并尝试自动复制', () => {
  assert.match(script, /console\.log\(/)
  assert.match(script, /copy\(/)
  assert.match(script, /自动复制失败|手动/)
})

test('不读本地存储、不引入依赖、不开其它通道', () => {
  const forbidden = [
    [/\blocalStorage\b/, 'localStorage'],
    [/\bsessionStorage\b/, 'sessionStorage'],
    [/\bindexedDB\b/, 'indexedDB'],
    [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
    [/\bsendBeacon\b/, 'sendBeacon'],
    [/\bWebSocket\b/, 'WebSocket'],
    [/\bEventSource\b/, 'EventSource'],
    [/\bimport\s*\(/, '动态 import'],
    [/^\s*import\s/m, 'import 语句'],
    [/\brequire\s*\(/, 'require(']
  ]
  for (const [pattern, label] of forbidden) {
    assert.doesNotMatch(script, pattern, `脚本里不该出现 ${label}`)
  }
})
