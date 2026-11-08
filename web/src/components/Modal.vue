<script setup lang="ts">
/**
 * 通用弹窗。
 *
 * 两个刻意的细节（都是从"按钮点了没反应"的实际反馈里来的）：
 *
 *  1. **遮罩点击有 400ms 宽限**：双击/连点触发按钮时，第二次 mousedown 的落点
 *     已经是刚出现的遮罩，会立刻把弹窗关掉 —— 用户眼里就是"点了没反应"。
 *     宽限期内的遮罩点击一律忽略。
 *  2. **Esc 关闭**：之前只能点 ✕ / 取消 / 遮罩，键盘用户没有路径。
 */
import { onBeforeUnmount, onMounted } from 'vue'

defineProps<{
  title: string
  wide?: boolean
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

/** 打开时刻；遮罩点击会忽略这个窗口内的点击，避免"双击开→立刻被第二击关" */
const openedAt = Date.now()
const OVERLAY_GUARD_MS = 400

function onOverlayClick(event: MouseEvent): void {
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
  <div class="overlay" @click="onOverlayClick">
    <div class="modal" :class="{ 'modal-wide': wide }">
      <div class="modal-head">
        <div class="modal-title">{{ title }}</div>
        <button class="btn btn-ghost btn-sm" type="button" @click="emit('close')">✕</button>
      </div>
      <slot />
    </div>
  </div>
</template>
