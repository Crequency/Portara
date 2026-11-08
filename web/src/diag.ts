/**
 * 诊断模式（?diag=1）的共享状态。
 *
 * 存在的唯一目的：线上"点了没反应"无法本地复现时，把**用户侧**的关键事实
 * 显示在页面顶部，让用户截图/口述即可定位：
 *   1. 点击命中哪个元素（没到达页面 / 被遮挡 / 命中按钮都能区分）
 *   2. 点击后 350ms 时弹窗到底有没有被创建、尺寸与层级是否正常
 *   3. Vue 事件处理函数里抛出的异常（Vue 会自己吞掉，window.onerror 收不到）
 *
 * 只在 initDiag 置 on=true 后写入；正常访问是零开销的死对象。
 */
import { reactive } from 'vue'

export const diagState = reactive({
  on: false,
  /** 主行：最近一次点击/异常 */
  line: '',
  /** 副行：点击后 350ms 的弹窗状态（没有就是空） */
  detail: ''
})

export function enableDiag(): void {
  diagState.on = true
}

export function setDiagLine(line: string): void {
  if (!diagState.on) return
  diagState.line = line
}

export function setDiagDetail(detail: string): void {
  if (!diagState.on) return
  diagState.detail = detail
}
