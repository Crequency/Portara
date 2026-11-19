<script setup lang="ts">
/**
 * 通用弹窗。
 *
 * 三个刻意的细节（都是从实际反馈里来的）：
 *
 *  1. **遮罩关闭要求完整的按下 + 松开周期**：起点与终点都必须在遮罩上。
 *     只判 `click` 是不够的 —— 在弹窗里**拖选文本**、松手落在遮罩上时，
 *     浏览器把 click 派发到 mousedown/mouseup 的最近公共祖先（正是遮罩），
 *     `target === currentTarget` 成立，弹窗就被误关了。
 *     （历史问题：API 密钥等页面的弹窗「一拖就消失」。）
 *  2. **400ms 打开宽限**：双击/连点触发按钮时，第二击落在刚出现的遮罩上
 *     会立刻把弹窗关掉 —— 用户眼里就是"点了没反应"。
 *  3. **Esc 关闭**：之前只能点 ✕ / 取消 / 遮罩，键盘用户没有路径。
 */
import { onBeforeUnmount, onMounted } from 'vue'

defineProps<{
  title: string
  wide?: boolean
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

/** 打开时刻；遮罩关闭会忽略这个窗口内的操作，避免"双击开→立刻被第二击关" */
const openedAt = Date.now()
const OVERLAY_GUARD_MS = 400

/**
 * 按下是否发生在遮罩上（而不是弹窗内容区）。
 *
 * 用它把"点击遮罩"与"从弹窗里拖选文本、松手落在遮罩"区分开：
 * 后者起点在弹窗内，不该算作关闭意图。
 */
let downOnOverlay = false

function onOverlayPointerDown(event: PointerEvent): void {
  // 只认主键（左键 / 触摸 / 笔）；右键、中键的按下不该触发关闭
  if (event.button !== 0) {
    downOnOverlay = false
    return
  }
  downOnOverlay = event.target === event.currentTarget
}

function onOverlayPointerUp(event: PointerEvent): void {
  const startedOnOverlay = downOnOverlay
  downOnOverlay = false
  if (!startedOnOverlay) return
  // 终点也必须在遮罩上：遮罩上按下、拖到弹窗里松开，不算点击遮罩
  if (event.target !== event.currentTarget) return
  if (Date.now() - openedAt < OVERLAY_GUARD_MS) return
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div
    class="overlay"
    @pointerdown="onOverlayPointerDown"
    @pointerup="onOverlayPointerUp"
  >
    <div class="modal" :class="{ 'modal-wide': wide }">
      <div class="modal-head">
        <div class="modal-title">{{ title }}</div>
        <button class="btn btn-ghost btn-sm" type="button" @click="emit('close')">✕</button>
      </div>
      <slot />
    </div>
  </div>
</template>
