<script setup lang="ts">
/**
 * 圆圈问号图标 + 悬浮说明。
 *
 * 为什么不用 title 属性：原生提示样式无法定制、延迟长、且移动端不可用。
 * 这里自绘并 Teleport 到 body —— 表格容器有 overflow，放在里面会被裁切。
 */
import { onBeforeUnmount, ref } from 'vue'

const props = withDefaults(defineProps<{ text: string; width?: number }>(), { width: 300 })

const show = ref(false)
const iconEl = ref<HTMLElement | null>(null)
const pos = ref({ left: 0, top: 0, width: props.width })

function place(): void {
  const el = iconEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const width = Math.min(props.width, window.innerWidth - 16)

  let left = r.left + r.width / 2 - width / 2
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8))

  // 先试下方，空间不足则翻到上方
  const estimated = 96
  let top = r.bottom + 8
  if (top + estimated > window.innerHeight - 8) {
    top = Math.max(8, r.top - estimated - 8)
  }

  pos.value = { left, top, width }
}

function open(): void {
  place()
  show.value = true
  window.addEventListener('scroll', place, true)
  window.addEventListener('resize', place)
}

function close(): void {
  show.value = false
  window.removeEventListener('scroll', place, true)
  window.removeEventListener('resize', place)
}

onBeforeUnmount(close)
</script>

<template>
  <span
    ref="iconEl"
    class="pinfo"
    tabindex="0"
    role="note"
    :aria-label="text"
    @mouseenter="open"
    @mouseleave="close"
    @focus="open"
    @blur="close"
  >
    <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" stroke-width="1.3" />
      <path
        d="M5.4 5.3a1.7 1.7 0 1 1 2.3 1.6c-.4.2-.7.5-.7 1v.3"
        fill="none"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
      />
      <circle cx="7" cy="10.3" r="0.75" fill="currentColor" />
    </svg>

    <Teleport to="body">
      <div
        v-if="show"
        class="pinfo-tip"
        :style="{ left: pos.left + 'px', top: pos.top + 'px', width: pos.width + 'px' }"
      >
        {{ text }}
      </div>
    </Teleport>
  </span>
</template>
