/**
 * 网页会话控制台脚本的约束测试。
 *
 * 这段字符串会被用户**原样粘贴到浏览器控制台**里执行 —— 它一旦悄悄多了个
 * 网络请求或本地存储读取，就不再是「只读 document.cookie」的只读脚本了。
 * 这些约束没法靠 typecheck 保证，只能钉在测试里。
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
  assert.ok(script.trimStart().startsWith('(() => {'), '应以 (() => { 开头')
  assert.ok(script.trimEnd().endsWith('})()'), '应以 })() 结尾')
})

test('只读 document.cookie', () => {
  assert.match(script, /document\.cookie/)
  assert.doesNotMatch(script, /document\.cookie\s*=/)
})

test('给出 HttpOnly 的手动兜底路径（DevTools → Application → Cookies）', () => {
  assert.match(script, /HttpOnly/i)
  assert.match(script, /DevTools/)
  assert.match(script, /Application/)
  assert.match(script, /Cookies/)
  // 手动路径要具体到域名，否则用户不知道该找哪个站点的 cookie
  assert.match(script, /amr-api\.open-design\.ai/)
})

test('打印完整内容，并尝试自动复制', () => {
  assert.match(script, /console\.log\(/)
  assert.match(script, /copy\(/)
  // 自动复制失败要有手动兜底提示，不能静默失败
  assert.match(script, /自动复制失败|手动/)
})

test('不发网络请求、不读本地存储、不引依赖', () => {
  const forbidden = [
    [/\bfetch\s*\(/, 'fetch('],
    [/XMLHttpRequest/, 'XMLHttpRequest'],
    [/\bsendBeacon\b/, 'sendBeacon'],
    [/\bWebSocket\b/, 'WebSocket'],
    [/EventSource/, 'EventSource'],
    [/\blocalStorage\b/, 'localStorage'],
    [/\bsessionStorage\b/, 'sessionStorage'],
    [/\bindexedDB\b/, 'indexedDB'],
    [/\bimport\s*\(/, '动态 import'],
    [/^\s*import\s/m, 'import 语句'],
    [/\brequire\s*\(/, 'require(']
  ]
  for (const [pattern, label] of forbidden) {
    assert.doesNotMatch(script, pattern, `脚本里不该出现 ${label}`)
  }
})
